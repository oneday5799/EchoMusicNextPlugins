// Behavioral tests for the local-music/legacy-parity improvements: settings
// patch guard, host namespace prefix tolerance, queue cover cap, host queue
// mode semantics, persisted enrichment, persisted online lyrics, sidecar
// lyrics, scan truncation and the cache-clear command.
// Run through the repo test script, which registers the echo:plugin-sdk hook.
import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

// Register the echo:plugin-sdk resolution hook directly: under full-suite
// parallelism the runner's --import propagation can race this file's dynamic
// import, so the hook must be in place before entry.ts is imported.
register('./helpers/echo-sdk-hooks.mjs', import.meta.url);

import {
  collectSongsUnder,
  readFlatCache,
  writeFlatCache,
} from '../plugins/webdav-music/src/scan.ts';
import {
  compactSong,
  expandCompactSong,
  parentFolderName,
  parseSourceId,
  songFromEntry,
} from '../plugins/webdav-music/src/library.ts';
import {
  isRangeUnsupported,
  isResponseTooLarge,
  markRangeUnsupported,
  resetRangeSupportMemo,
} from '../plugins/webdav-music/src/webdav.ts';

class FakeOperation {
  constructor() {
    this.state = 0;
    this.result = undefined;
    this.errorCode = '';
    this.errorMessage = '';
    this.listeners = [];
    this.cancelRequested = false;
  }

  get completed() {
    const op = this;
    return {
      connect(callback) {
        op.listeners.push(callback);
      },
      disconnect(callback) {
        const index = op.listeners.indexOf(callback);
        if (index >= 0) op.listeners.splice(index, 1);
      },
    };
  }

  settle(state, result, message) {
    if (this.state >= 2) return;
    this.state = state;
    if (state === 2) this.result = result;
    if (message) this.errorMessage = message;
    for (const listener of [...this.listeners]) listener();
    this.listeners.length = 0;
  }

  resolve(result) {
    this.settle(2, result);
  }

  reject(message) {
    this.settle(3, undefined, message);
  }

  cancel() {
    if (this.state >= 2) return;
    this.cancelRequested = true;
    this.settle(4, undefined, 'Operation canceled');
  }
}

function waitFor(predicate, timeoutMs = 2000, stepMs = 5) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      let ok = false;
      try {
        ok = predicate();
      } catch (error) {
        reject(error);
        return;
      }
      if (ok) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('waitFor timeout'));
        return;
      }
      setTimeout(check, stepMs);
    };
    check();
  });
}

function tick(ms = 30) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ID3v2.3 tag with a TIT2 (UTF-16) and an APIC frame of the given size.
function id3WithCover(title, coverBytes) {
  const textPayload = new Uint8Array(3 + title.length * 2);
  textPayload[0] = 1;
  textPayload[1] = 0xff;
  textPayload[2] = 0xfe;
  for (let i = 0; i < title.length; i++) {
    textPayload[3 + i * 2] = title.charCodeAt(i) & 0xff;
    textPayload[4 + i * 2] = title.charCodeAt(i) >> 8;
  }
  const mime = [...'image/jpeg'].map((ch) => ch.charCodeAt(0));
  const apicPayload = new Uint8Array(1 + mime.length + 1 + 1 + 1 + coverBytes.length);
  let at = 0;
  apicPayload[at++] = 0; // latin-1
  for (const byte of mime) apicPayload[at++] = byte;
  apicPayload[at++] = 0; // mime terminator
  apicPayload[at++] = 3; // front cover
  apicPayload[at++] = 0; // empty description terminator
  apicPayload.set(coverBytes, at);

  const frame = (id, payload) => {
    const bytes = new Uint8Array(10 + payload.length);
    for (let i = 0; i < 4; i++) bytes[i] = id.charCodeAt(i);
    bytes[4] = (payload.length >>> 24) & 0xff;
    bytes[5] = (payload.length >>> 16) & 0xff;
    bytes[6] = (payload.length >>> 8) & 0xff;
    bytes[7] = payload.length & 0xff;
    bytes.set(payload, 10);
    return bytes;
  };
  const tit2 = frame('TIT2', textPayload);
  const apic = frame('APIC', apicPayload);
  const total = tit2.length + apic.length;
  const tag = new Uint8Array(10 + total);
  tag.set([0x49, 0x44, 0x33, 0x03, 0x00, 0x00], 0);
  // Syncsafe size.
  tag[6] = (total >>> 21) & 0x7f;
  tag[7] = (total >>> 14) & 0x7f;
  tag[8] = (total >>> 7) & 0x7f;
  tag[9] = total & 0x7f;
  tag.set(tit2, 10);
  tag.set(apic, 10 + tit2.length);
  return tag;
}

// APIC frame payload (latin-1 mime, front cover, empty description).
function apicPayload(coverBytes) {
  const mime = [...'image/jpeg'].map((ch) => ch.charCodeAt(0));
  const payload = new Uint8Array(1 + mime.length + 1 + 1 + 1 + coverBytes.length);
  let at = 0;
  payload[at++] = 0; // latin-1
  for (const byte of mime) payload[at++] = byte;
  payload[at++] = 0; // mime terminator
  payload[at++] = 3; // front cover
  payload[at++] = 0; // empty description terminator
  payload.set(coverBytes, at);
  return payload;
}

// Generic text frame payload: encoding byte + the text.
function id3Text(encoding, text) {
  if (encoding === 1) {
    const payload = new Uint8Array(3 + text.length * 2);
    payload[0] = 1;
    payload[1] = 0xff;
    payload[2] = 0xfe;
    for (let i = 0; i < text.length; i++) {
      payload[3 + i * 2] = text.charCodeAt(i) & 0xff;
      payload[4 + i * 2] = text.charCodeAt(i) >> 8;
    }
    return payload;
  }
  const payload = new Uint8Array(1 + text.length);
  payload[0] = encoding;
  for (let i = 0; i < text.length; i++) payload[1 + i] = text.charCodeAt(i);
  return payload;
}

// ID3v2.3 tag built from [frameId, payload] pairs.
function id3Tag(frames) {
  const frame = (id, payload) => {
    const bytes = new Uint8Array(10 + payload.length);
    for (let i = 0; i < 4; i++) bytes[i] = id.charCodeAt(i);
    bytes[4] = (payload.length >>> 24) & 0xff;
    bytes[5] = (payload.length >>> 16) & 0xff;
    bytes[6] = (payload.length >>> 8) & 0xff;
    bytes[7] = payload.length & 0xff;
    bytes.set(payload, 10);
    return bytes;
  };
  const built = frames.map(([id, payload]) => frame(id, payload));
  const total = built.reduce((sum, f) => sum + f.length, 0);
  const tag = new Uint8Array(10 + total);
  tag.set([0x49, 0x44, 0x33, 0x03, 0x00, 0x00], 0);
  tag[6] = (total >>> 21) & 0x7f;
  tag[7] = (total >>> 14) & 0x7f;
  tag[8] = (total >>> 7) & 0x7f;
  tag[9] = total & 0x7f;
  let at = 10;
  for (const builtFrame of built) {
    tag.set(builtFrame, at);
    at += builtFrame.length;
  }
  return tag;
}

// Simulates a fresh session for the enrichment store: the persisted records
// are gone but the in-memory enricher caches stay as they are.
function dropEnrichRecords(store) {
  for (const key of [...store.keys()]) {
    if (key.startsWith('enrich:') || key === 'enrichIndex') store.delete(key);
  }
}

const LIB_XML = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
 <d:response><d:href>/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
 <d:response><d:href>/a.mp3</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>1024</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
 <d:response><d:href>/b.mp3</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>2048</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;

const ALBUM_XML = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
 <d:response><d:href>/%E4%B8%93%E8%BE%91/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
 <d:response><d:href>/%E4%B8%93%E8%BE%91/song.mp3</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>4096</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;

async function setup(options = {}) {
  const {
    coverLyricSource,
    settingsValue = {
      libraries: [
        {
          id: 'lib1',
          name: '测试库',
          serverUrl: 'http://webdav.local',
          username: 'user',
          password: 'pass',
          rootPath: '/',
          flatView: false,
        },
      ],
      activeLibraryId: 'lib1',
      coverLyricSource: coverLyricSource ?? 'embedded',
    },
    queueMode = 'context',
    propfind = (path) => (path === '/' ? LIB_XML : ALBUM_XML),
    get = null,
    kugou = null,
    propfindLimit = Infinity,
  } = options;

  const { activate, deactivate } = await import('../plugins/webdav-music/src/entry.ts');

  const commands = new Map();
  const store = new Map();
  const published = [];
  const netCalls = [];
  let propfindCount = 0;
  const kugouCalls = [];
  const replaces = [];
  const appends = [];
  const toasts = [];
  const resolvers = { audio: null, lyrics: null };
  let stuckOperation = null;

  const ctx = {
    io: {
      readValue(key) {
        const op = new FakeOperation();
        op.resolve(store.has(key) ? store.get(key) : undefined);
        return op;
      },
      writeValue(key, value) {
        const op = new FakeOperation();
        store.set(key, value);
        op.resolve(undefined);
        return op;
      },
      removeValue(key) {
        const op = new FakeOperation();
        store.delete(key);
        op.resolve(undefined);
        return op;
      },
    },
    net: {
      request(request) {
        const op = new FakeOperation();
        netCalls.push(request);
        if (request.method === 'PROPFIND') {
          // Thrown synchronously so a directory-cycle regression fails the
          // test instead of hanging it.
          propfindCount += 1;
          if (propfindCount > propfindLimit) {
            throw new Error('PROPFIND budget exceeded');
          }
          const value = propfind
            ? propfind(decodeURIComponent(request.url.replace(/^https?:\/\/[^/]+/, '')))
            : LIB_XML;
          if (value === null) return op; // stay in flight
          if (value && typeof value === 'object' && typeof value.status === 'number') {
            op.resolve({ status: value.status, data: value.data ?? '' });
            return op;
          }
          op.resolve({ status: 207, data: value });
          return op;
        }
        if (request.method === 'GET') {
          if (get) {
            const response = get(
              decodeURIComponent(request.url.replace(/^https?:\/\/[^/]+/, '')),
              request,
            );
            if (response === null) {
              stuckOperation = op;
              return op;
            }
            if (response && typeof response === 'object' && response.rejectCode) {
              // Mirrors the host: the operation fails with an error code the
              // sdk's awaitOperation re-throws as error.code.
              op.errorCode = response.rejectCode;
              op.reject(response.rejectMessage || response.rejectCode);
              return op;
            }
            op.resolve(response);
            return op;
          }
          op.resolve({ status: 404, data: new ArrayBuffer(0) });
          return op;
        }
        op.reject(`Unexpected request ${request.method} ${request.url}`);
        return op;
      },
    },
    setTimer(id, intervalMs, repeat, callback) {
      const handle = setTimeout(callback, Math.max(0, intervalMs));
      return {
        dispose() {
          clearTimeout(handle);
        },
      };
    },
    ui: {
      setState(values) {
        published.push(values);
      },
      registerPage() {
        return { dispose() {} };
      },
      registerSettings() {
        return { dispose() {} };
      },
      registerSidebarItem() {
        return { dispose() {} };
      },
      showDialog() {
        return null;
      },
    },
    player: {
      audioSource: {
        registerResolver(id, definition) {
          resolvers.audio = definition;
          return { dispose() {} };
        },
      },
      toggle() {},
    },
    lyrics: {
      registerResolver(id, definition) {
        resolvers.lyrics = definition;
        return { dispose() {} };
      },
    },
    tasks: {
      registerTask(id, definition) {
        const task = {
          definition,
          updates: [],
          finished: null,
          start() {
            this.started = true;
          },
          update(values) {
            this.updates.push(values);
          },
          finish(status, values) {
            this.finished = { status, values };
          },
        };
        return task;
      },
    },
    playlist: {
      snapshot: [],
      replace(key, title, tracks, index) {
        const op = new FakeOperation();
        replaces.push({ key, title, tracks, index });
        op.resolve(undefined);
        return op;
      },
      append(key, tracks, placement) {
        const op = new FakeOperation();
        appends.push({ key, tracks, placement });
        op.resolve(undefined);
        return op;
      },
    },
    settings: {
      read(domain) {
        const op = new FakeOperation();
        op.resolve(domain === 'playback' ? { queueMode } : {});
        return op;
      },
    },
    toast: {
      success(message) {
        toasts.push(['success', message]);
      },
      info(message) {
        toasts.push(['info', message]);
      },
      warning(message) {
        toasts.push(['warning', message]);
      },
      danger(message) {
        toasts.push(['danger', message]);
      },
    },
    kugou: {
      request(kind, args) {
        const op = new FakeOperation();
        kugouCalls.push({ kind, args });
        if (kugou) {
          const value = kugou(kind, args);
          if (value === null) return op;
          op.resolve(value);
        } else {
          op.resolve(null);
        }
        return op;
      },
    },
    registerCommand(id, handler) {
      commands.set(id, handler);
    },
  };

  store.set('settings', settingsValue);
  await activate(ctx);
  return {
    ctx,
    commands,
    store,
    published,
    netCalls,
    netPropfindCount: () => propfindCount,
    kugouCalls,
    replaces,
    appends,
    toasts,
    resolvers,
    deactivate,
    stuckRef: () => stuckOperation,
  };
}

function storedSettings(store) {
  return store.get('settings');
}

test('parseSourceId 兼容宿主命名空间前缀并拒绝非 webdav 形态', () => {
  const plain = parseSourceId('webdav:lib1:webdav-abc');
  assert.deepEqual(plain, { libraryId: 'lib1', songId: 'webdav-abc' });
  const prefixed = parseSourceId('webdav-music/webdav:lib1:webdav-abc');
  assert.deepEqual(prefixed, { libraryId: 'lib1', songId: 'webdav-abc' });
  assert.equal(parseSourceId('local:lib1:song'), null);
  assert.equal(parseSourceId(undefined), null);
});

test('settings.patch 不带 libraries 数组时保留已存库，不写空列表', async () => {
  const env = await setup();
  try {
    // A failed settings.get left the page with no draft: this patch must
    // never wipe the stored library list.
    const result = await env.commands.get('settings.patch')({});
    assert.equal(result.ok, true);
    assert.equal(storedSettings(env.store).libraries.length, 1);

    // Lone coverLyricSource patch merges with the stored libraries.
    await env.commands.get('settings.patch')({ coverLyricSource: 'kugou' });
    assert.equal(storedSettings(env.store).libraries.length, 1);
    assert.equal(storedSettings(env.store).coverLyricSource, 'kugou');

    // A real libraries array still applies.
    await env.commands.get('settings.patch')({
      libraries: [
        { id: 'lib1', name: '测试库', serverUrl: 'http://webdav.local', rootPath: '/' },
        { id: 'lib2', name: '第二个', serverUrl: 'http://other.local', rootPath: '/' },
      ],
      activeLibraryId: 'lib2',
    });
    assert.equal(storedSettings(env.store).libraries.length, 2);
    assert.equal(storedSettings(env.store).activeLibraryId, 'lib2');

    // Non-array junk keeps the stored list.
    await env.commands.get('settings.patch')({ libraries: 'nope' });
    assert.equal(storedSettings(env.store).libraries.length, 2);
  } finally {
    await env.deactivate();
  }
});

test('单曲播放：宿主 queueMode=single 只播该曲，all 标记与 context 模式播全列表', async () => {
  const env = await setup({ queueMode: 'single' });
  try {
    await env.commands.get('flat.load')({ libraryId: 'lib1', force: true });
    await waitFor(() => env.published.some((entry) => entry.flatScan && entry.flatScan.done));

    await env.commands.get('play')({ libraryId: 'lib1', flat: true, index: 1, mode: 'now' });
    assert.equal(env.replaces.length, 1);
    assert.equal(env.replaces[0].tracks.length, 1, '单曲模式只替换为该曲');
    assert.equal(env.replaces[0].index, 0);

    await env.commands.get('play')({
      libraryId: 'lib1',
      flat: true,
      index: 1,
      mode: 'now',
      all: true,
    });
    assert.equal(env.replaces[1].tracks.length, 2, '播放全部始终播全列表');
    assert.equal(env.replaces[1].index, 1);
  } finally {
    await env.deactivate();
  }
});

test('context 模式双击播全列表并定位到该曲', async () => {
  const env = await setup({ queueMode: 'context' });
  try {
    await env.commands.get('flat.load')({ libraryId: 'lib1', force: true });
    await waitFor(() => env.published.some((entry) => entry.flatScan && entry.flatScan.done));
    await env.commands.get('play')({ libraryId: 'lib1', flat: true, index: 1, mode: 'now' });
    assert.equal(env.replaces[0].tracks.length, 2);
    assert.equal(env.replaces[0].index, 1);
  } finally {
    await env.deactivate();
  }
});

test('目录播放以文件夹名作为专辑，且封面上限内的封面保留', async () => {
  const smallCover = new Uint8Array(3000).fill(7);
  const env = await setup({
    get: (path) => {
      if (path.endsWith('/专辑/song.mp3')) {
        return { status: 206, data: id3WithCover('专辑歌', smallCover) };
      }
      return { status: 404, data: new ArrayBuffer(0) };
    },
  });
  try {
    await env.commands.get('play')({ libraryId: 'lib1', dir: '/专辑', mode: 'now' });
    assert.equal(env.replaces.length, 1);
    assert.equal(env.replaces[0].title, '测试库 · 专辑');
    for (const track of env.replaces[0].tracks) {
      assert.equal(track.album, '专辑', '目录名写入专辑');
    }
    assert.equal(env.replaces[0].tracks[0].cover.length > 0, true, '小封面保留在队列载荷中');
    assert.equal(env.replaces[0].tracks[0].cover.length <= 16000, true);
  } finally {
    await env.deactivate();
  }
});

test('超过宿主 16K 上限的内嵌封面被扣留，replace 不被静默丢弃', async () => {
  const bigCover = new Uint8Array(13000).fill(9);
  const env = await setup({
    get: () => ({ status: 206, data: id3WithCover('大封面歌', bigCover) }),
  });
  try {
    await env.commands.get('play')({ libraryId: 'lib1', paths: ['/a.mp3'], mode: 'now' });
    assert.equal(env.replaces.length, 1);
    const track = env.replaces[0].tracks[0];
    assert.equal(track.cover === undefined || track.cover === '', true, '超大封面被扣留');
    assert.equal(track.title, '大封面歌', '标题仍写入队列');
  } finally {
    await env.deactivate();
  }
});

test('播放过的歌曲持久化 enrichment，第二次播放零网络请求', async () => {
  const smallCover = new Uint8Array(2000).fill(5);
  const env = await setup({
    get: () => ({ status: 206, data: id3WithCover('持久歌', smallCover) }),
    kugou: (kind) => {
      if (kind === 'search') {
        return { kind: 'songs', page: { items: [] } };
      }
      return null;
    },
  });
  try {
    await env.commands.get('play')({ libraryId: 'lib1', paths: ['/a.mp3'], mode: 'now' });
    assert.equal(env.replaces.length, 1);
    await tick();
    const enrichKeys = [...env.store.keys()].filter((key) => key.startsWith('enrich:'));
    assert.equal(enrichKeys.length, 1, 'enrichment 记录已写入 KV');
    assert.ok(env.store.get('enrichIndex'), 'enrichIndex 已维护');
    const record = env.store.get(enrichKeys[0]);
    assert.equal(record.title, '持久歌');

    const netBefore = env.netCalls.length;
    const kugouBefore = env.kugouCalls.length;
    await env.commands.get('play')({ libraryId: 'lib1', paths: ['/a.mp3'], mode: 'now' });
    assert.equal(env.replaces.length, 2);
    assert.equal(env.netCalls.length, netBefore, '第二次播放没有新的网络请求');
    assert.equal(env.kugouCalls.length, kugouBefore, '第二次播放没有新的酷狗请求');
    assert.equal(env.replaces[1].tracks[0].title, '持久歌', '持久记录直接回放');
  } finally {
    await env.deactivate();
  }
});

test('flat.locate 返回歌曲索引，flat.clear 清空扫描列表与持久缓存', async () => {
  const env = await setup();
  try {
    await env.commands.get('flat.load')({ libraryId: 'lib1', force: true });
    await waitFor(() => env.published.some((entry) => entry.flatScan && entry.flatScan.done));
    const page = await env.commands.get('flat.page')({ libraryId: 'lib1', offset: 0, limit: 100 });
    assert.equal(page.ready, true);
    const id = page.songs[1].id;

    const located = await env.commands.get('flat.locate')({ libraryId: 'lib1', id });
    assert.equal(located.index, 1);
    assert.equal(located.total, 2);

    await env.commands.get('play')({ libraryId: 'lib1', paths: ['/a.mp3'], mode: 'now' });
    await tick();
    assert.equal(
      [...env.store.keys()].some((key) => key.startsWith('enrich:')),
      true,
    );

    const cleared = await env.commands.get('flat.clear')({});
    assert.equal(cleared.ok, true);
    assert.equal(
      [...env.store.keys()].some((key) => key.startsWith('flat:')),
      false,
      '扫描缓存已清除',
    );
    assert.equal(
      [...env.store.keys()].some((key) => key.startsWith('enrich:')),
      false,
      'enrichment 缓存已清除',
    );
    assert.equal(
      [...env.store.keys()].some((key) => key.startsWith('lyr')),
      false,
      '歌词缓存已清除',
    );
  } finally {
    await env.deactivate();
  }
});

test('伴生 .lrc 文件优先，酷狗歌词持久化后第二次解析不再请求', async () => {
  const lyricDoc = { lines: [{ text: '第一句', start_ms: 1000, words: [] }] };
  let resolved = 0;
  const env = await setup({
    get: (path) => {
      if (path.endsWith('/a.lrc')) {
        return { status: 200, data: new TextEncoder().encode('[00:01.00]伴生歌词行\n') };
      }
      return { status: 404, data: new ArrayBuffer(0) };
    },
    kugou: (kind) => {
      resolved += 1;
      if (kind === 'search') {
        return { kind: 'songs', page: { items: [{ duration_ms: 3000 }] } };
      }
      if (kind === 'lyricCandidatesByKeywords') {
        return [
          { source_id: 'k1', access_key: 'ak', word_timed: false, scrollable: true, score: 5 },
        ];
      }
      if (kind === 'lyric') {
        return lyricDoc;
      }
      return null;
    },
  });
  try {
    const resolver = env.resolvers.lyrics;
    assert.ok(resolver, '歌词解析器已注册');
    const track = {
      id: makeStableSongId('lib1', '/b.mp3'),
      sourceId: `webdav:lib1:${makeStableSongId('lib1', '/b.mp3')}`,
      data: { p: '/b.mp3' },
      title: 'b',
      artist: '歌手',
      durationMs: 3000,
    };
    const first = await resolver.resolve({ track, durationMs: 3000 });
    assert.equal(first.source, '酷狗歌词');
    assert.equal(first.content.includes('第一句'), true);
    await tick();
    const lyricKey = [...env.store.keys()].find((key) => key.startsWith('lyr:'));
    assert.ok(lyricKey, '在线歌词已持久化');
    const kugouAfterFirst = resolved;

    const second = await resolver.resolve({ track, durationMs: 3000 });
    assert.equal(second.source, '酷狗歌词');
    assert.equal(second.content.includes('第一句'), true);
    assert.equal(resolved, kugouAfterFirst, '第二次解析直接命中持久记录');

    // The sidecar file wins for the song that has one.
    const sidecarTrack = {
      id: makeStableSongId('lib1', '/a.mp3'),
      sourceId: `webdav:lib1:${makeStableSongId('lib1', '/a.mp3')}`,
      data: { p: '/a.mp3' },
      title: 'a',
      artist: '',
      durationMs: 0,
    };
    const sidecar = await resolver.resolve({ track: sidecarTrack, durationMs: 0 });
    assert.equal(sidecar.source, '伴生歌词');
    assert.equal(sidecar.content.includes('伴生歌词行'), true);
  } finally {
    await env.deactivate();
  }
});

test('扫描上限触发 truncated 并写入 meta v2，读取往返一致', async () => {
  const env = await setup();
  const ctx = env.ctx;
  try {
    const truncatedTargets = [];
    const songs = await collectSongsUnder(
      ctx,
      {
        serverUrl: 'http://webdav.local',
        username: 'user',
        password: 'pass',
        rootPath: '/',
      },
      'lib1',
      '/',
      {
        cap: 1,
        onTruncated: () => truncatedTargets.push(true),
      },
    );
    assert.equal(songs.length, 1);
    assert.equal(truncatedTargets.length, 1, 'cap 命中触发一次 onTruncated');

    const library = {
      id: 'lib1',
      name: '测试库',
      serverUrl: 'http://webdav.local',
      username: 'user',
      password: 'pass',
      rootPath: '/',
      flatView: false,
    };
    await writeFlatCache(ctx, library, songs, true);
    const meta = env.store.get('flat:lib1');
    assert.equal(meta.version, 2);
    assert.equal(meta.truncated, true);
    const readBack = await readFlatCache(ctx, library);
    assert.equal(readBack.truncated, true);
    assert.equal(readBack.songs.length, 1);
  } finally {
    await env.deactivate();
  }
});

test('deactivate 取消在途请求', async () => {
  const { activate, deactivate } = await import('../plugins/webdav-music/src/entry.ts');
  const commands = new Map();
  const store = new Map();
  const published = [];
  let stuck = null;
  const ctx = {
    io: {
      readValue(key) {
        const op = new FakeOperation();
        op.resolve(store.has(key) ? store.get(key) : undefined);
        return op;
      },
      writeValue(key, value) {
        const op = new FakeOperation();
        store.set(key, value);
        op.resolve(undefined);
        return op;
      },
      removeValue(key) {
        const op = new FakeOperation();
        store.delete(key);
        op.resolve(undefined);
        return op;
      },
    },
    net: {
      request(request) {
        const op = new FakeOperation();
        if (request.method === 'PROPFIND') {
          stuck = op;
          return op;
        }
        op.reject(`Unexpected ${request.method}`);
        return op;
      },
    },
    setTimer(id, intervalMs, repeat, callback) {
      const handle = setTimeout(callback, Math.max(0, intervalMs));
      return {
        dispose() {
          clearTimeout(handle);
        },
      };
    },
    ui: {
      setState(values) {
        published.push(values);
      },
      registerPage() {
        return null;
      },
      registerSettings() {
        return null;
      },
      registerSidebarItem() {
        return null;
      },
    },
    player: {
      audioSource: {
        registerResolver() {
          return null;
        },
      },
    },
    lyrics: {
      registerResolver() {
        return null;
      },
    },
    tasks: {
      registerTask() {
        return null;
      },
    },
    registerCommand(id, handler) {
      commands.set(id, handler);
    },
  };
  store.set('settings', {
    libraries: [
      {
        id: 'lib1',
        name: '测试库',
        serverUrl: 'http://webdav.local',
        username: '',
        password: '',
        rootPath: '/',
        flatView: true,
      },
    ],
    activeLibraryId: 'lib1',
    coverLyricSource: 'embedded',
  });
  await activate(ctx);
  try {
    await commands.get('flat.load')({ libraryId: 'lib1', force: true });
    await waitFor(() => stuck !== null);
    await deactivate();
    assert.equal(stuck.cancelRequested, true, '停用应取消在途 PROPFIND');
  } finally {
    // deactivate already ran; nothing to clean up.
  }
});

function makeStableSongId(libraryId, path) {
  // Mirrors library.ts makeSongId so lyric-store keys line up with tracks.
  let hash = 0;
  const text = `${libraryId}|${path}`;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return `webdav-${(hash >>> 0).toString(36)}`;
}

// ── Round 2 parity fixes ───────────────────────────────────────────────────

test('子目录读取失败被跳过继续扫描，根目录失败才整体失败', async () => {
  // Skip-on-error: a 500 on the sub-directory does not fail the walk.
  const env2 = await setup({
    propfind: (path) => {
      if (path === '/') {
        return `${LIB_XML}
 <d:response><d:href>/x/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
      }
      return { status: 500, data: '' };
    },
  });
  try {
    let skipped = 0;
    const songs = await collectSongsUnder(
      env2.ctx,
      { serverUrl: 'http://webdav.local', username: 'user', password: 'pass', rootPath: '/' },
      'lib1',
      '/',
      {
        onDirectorySkipped: () => {
          skipped += 1;
        },
      },
    );
    assert.equal(songs.length, 2, '根目录歌曲照常收集');
    assert.equal(skipped, 1, '失败子目录被跳过一次');

    // Root failure still fails the scan with the real error.
    await assert.rejects(
      () =>
        collectSongsUnder(
          env2.ctx,
          {
            serverUrl: 'http://webdav.local',
            username: 'user',
            password: 'pass',
            rootPath: '/nope',
          },
          'lib1',
          '/nope',
          {},
        ),
      /HTTP 500/,
    );
  } finally {
    await env2.deactivate();
  }
});

test('目录环被 visited 记忆阻断，扫描在有限请求内完成', async () => {
  const env = await setup({
    propfind: (path) => {
      if (path === '/') {
        return `${LIB_XML}
 <d:response><d:href>/x/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
      }
      if (path === '/x') {
        return `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
 <d:response><d:href>/y/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
 <d:response><d:href>/x/song-x.mp3</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>10</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;
      }
      return `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
 <d:response><d:href>/x/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
 <d:response><d:href>/y/song-y.mp3</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>20</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;
    },
    propfindLimit: 12,
  });
  try {
    const songs = await collectSongsUnder(
      env.ctx,
      { serverUrl: 'http://webdav.local', username: 'user', password: 'pass', rootPath: '/' },
      'lib1',
      '/',
      {},
    );
    assert.equal(songs.length, 4, '根目录两首加环内两首都被收集');
    assert.equal(env.netPropfindCount(), 3, '根目录与两个子目录各请求一次');
  } finally {
    await env.deactivate();
  }
});

test('歌曲携带父文件夹作为默认专辑，compact 行兼容 6 字段旧格式', () => {
  assert.equal(parentFolderName('/music/专辑/song.mp3'), '专辑');
  assert.equal(parentFolderName('/song.mp3'), '');
  const song = songFromEntry({
    libraryId: 'lib1',
    path: '/专辑/song.mp3',
    name: 'song.mp3',
    size: 10,
  });
  assert.equal(song.album, '专辑');
  const row = compactSong(song);
  assert.equal(row.length, 7, 'compact 行含专辑字段');
  const expanded = expandCompactSong(row);
  assert.equal(expanded.album, '专辑');
  const legacy = expandCompactSong(row.slice(0, 6));
  assert.ok(legacy, '6 字段旧行仍可展开');
  assert.equal(legacy.album, '', '旧行专辑为空');
  assert.equal(legacy.title, song.title);
  assert.equal(legacy.size, song.size);
});

test('播放队列的专辑默认取歌曲父文件夹名', async () => {
  const env = await setup();
  try {
    await env.commands.get('play')({ libraryId: 'lib1', paths: ['/专辑/song.mp3'], mode: 'now' });
    assert.equal(env.replaces.length, 1);
    assert.equal(env.replaces[0].tracks[0].album, '专辑', '父文件夹名写入队列专辑');
  } finally {
    await env.deactivate();
  }
});

test('标签读取失败不缓存 null，下一次播放重试', async () => {
  const env = await setup({
    get: () => ({ status: 500, data: '' }),
  });
  try {
    await env.commands.get('play')({ libraryId: 'lib1', paths: ['/a.mp3'], mode: 'now' });
    const getAfterFirst = env.netCalls.filter((call) => call.method === 'GET').length;
    assert.equal(getAfterFirst, 1, '第一次播放读取了标签');

    dropEnrichRecords(env.store);
    await env.commands.get('play')({ libraryId: 'lib1', paths: ['/a.mp3'], mode: 'now' });
    const getAfterSecond = env.netCalls.filter((call) => call.method === 'GET').length;
    assert.equal(getAfterSecond, getAfterFirst + 1, '失败读取未被缓存，第二次播放重试');
  } finally {
    await env.deactivate();
  }
});

test('内嵌标签完整时跳过酷狗搜索', async () => {
  const cover = new Uint8Array(2000).fill(3);
  const env = await setup({
    get: () => ({
      status: 206,
      data: id3Tag([
        ['TIT2', id3Text(1, '标签歌')],
        ['TPE1', id3Text(1, '标签歌手')],
        ['TALB', id3Text(1, '标签专辑')],
        ['TLEN', id3Text(0, '123000')],
        ['APIC', apicPayload(cover)],
      ]),
    }),
  });
  try {
    await env.commands.get('play')({ libraryId: 'lib1', paths: ['/a.mp3'], mode: 'now' });
    assert.equal(env.replaces.length, 1);
    assert.equal(env.kugouCalls.length, 0, '完整标签下没有酷狗搜索');
    const track = env.replaces[0].tracks[0];
    assert.equal(track.title, '标签歌');
    assert.equal(track.album, '标签专辑');
    assert.equal(track.artist, '标签歌手');
    assert.equal(track.durationMs, 123000);
    assert.equal((track.cover || '').startsWith('data:image/jpeg;base64,'), true);
  } finally {
    await env.deactivate();
  }
});

test('酷狗优先模式：在线资料覆盖内嵌标签', async () => {
  const cover = new Uint8Array(2000).fill(3);
  const env = await setup({
    coverLyricSource: 'kugou',
    get: () => ({
      status: 206,
      data: id3Tag([
        ['TIT2', id3Text(1, '标签歌')],
        ['TPE1', id3Text(1, '标签歌手')],
        ['TALB', id3Text(1, '标签专辑')],
        ['TLEN', id3Text(0, '123000')],
        ['APIC', apicPayload(cover)],
      ]),
    }),
    kugou: (kind) => {
      if (kind === 'search') {
        return {
          kind: 'songs',
          page: {
            items: [
              {
                album_title: '酷狗专辑',
                artists: [{ name: '酷狗歌手' }],
                duration_ms: 99999,
                cover_url: 'https://img.kugou.com/cover.jpg',
              },
            ],
          },
        };
      }
      return null;
    },
  });
  try {
    await env.commands.get('play')({ libraryId: 'lib1', paths: ['/a.mp3'], mode: 'now' });
    assert.equal(env.kugouCalls.length > 0, true, '酷狗优先模式下仍执行在线搜索');
    const track = env.replaces[0].tracks[0];
    assert.equal(track.album, '酷狗专辑', '专辑被在线资料覆盖');
    assert.equal(track.artist, '酷狗歌手', '歌手被在线资料覆盖');
    assert.equal(track.durationMs, 99999, '时长被在线资料覆盖');
    assert.equal(track.cover, 'https://img.kugou.com/cover.jpg', '封面被在线资料覆盖');
  } finally {
    await env.deactivate();
  }
});

test('忽略 Range 的服务器被记忆：响应超限后跳过后续标签读取', async () => {
  const env = await setup({
    get: () => ({
      rejectCode: 'ResponseTooLarge',
      rejectMessage: 'HTTP response exceeds maxResponseBytes',
    }),
  });
  try {
    await env.commands.get('play')({ libraryId: 'lib1', paths: ['/a.mp3'], mode: 'now' });
    const getAfterFirst = env.netCalls.filter((call) => call.method === 'GET').length;
    assert.equal(getAfterFirst, 1, '第一次播放尝试读取标签并收到响应超限');
    assert.equal(isRangeUnsupported('http://webdav.local'), true, '服务器被标记为不支持 Range');

    dropEnrichRecords(env.store);
    await env.commands.get('play')({ libraryId: 'lib1', paths: ['/a.mp3'], mode: 'now' });
    const getAfterSecond = env.netCalls.filter((call) => call.method === 'GET').length;
    assert.equal(getAfterSecond, getAfterFirst, '后续播放不再向该服务器发起 range 读取');
  } finally {
    await env.deactivate();
  }
});

test('isResponseTooLarge 识别宿主响应超限错误', () => {
  resetRangeSupportMemo();
  const coded = new Error('HTTP response exceeds maxResponseBytes');
  coded.code = 'ResponseTooLarge';
  assert.equal(isResponseTooLarge(coded), true);
  assert.equal(isResponseTooLarge(new Error('boom')), false);
  assert.equal(isResponseTooLarge(null), false);

  try {
    markRangeUnsupported('http://webdav.local/');
    assert.equal(isRangeUnsupported('http://webdav.local'), true, '归一化后命中同一服务器');
  } finally {
    resetRangeSupportMemo();
    assert.equal(isRangeUnsupported('http://webdav.local'), false, 'memo 可重置');
  }
});

test('deactivate 打断在途 enrichment 不复活持久缓存', async () => {
  const cover = new Uint8Array(500).fill(4);
  const env = await setup({
    get: () => null,
  });
  try {
    const playPromise = env.commands.get('play')({
      libraryId: 'lib1',
      paths: ['/a.mp3'],
      mode: 'now',
    });
    playPromise.catch(() => {});
    await waitFor(() => env.stuckRef() !== null);
    await env.deactivate();
    env.stuckRef().resolve({
      status: 206,
      data: id3Tag([
        ['TIT2', id3Text(0, '迟到标签')],
        ['APIC', apicPayload(cover)],
      ]),
    });
    await tick();
    assert.equal(
      [...env.store.keys()].some((key) => key.startsWith('enrich:')),
      false,
      'deactivate 后在飞回调不写入 enrichment 缓存',
    );
  } finally {
    // deactivate already ran inside the test body.
  }
});

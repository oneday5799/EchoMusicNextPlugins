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
import { parseSourceId } from '../plugins/webdav-music/src/library.ts';

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
      coverLyricSource: 'embedded',
    },
    queueMode = 'context',
    propfind = (path) => (path === '/' ? LIB_XML : ALBUM_XML),
    get = null,
    kugou = null,
  } = options;

  const { activate, deactivate } = await import('../plugins/webdav-music/src/entry.ts');

  const commands = new Map();
  const store = new Map();
  const published = [];
  const netCalls = [];
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
          const xml = propfind
            ? propfind(decodeURIComponent(request.url.replace(/^https?:\/\/[^/]+/, '')))
            : LIB_XML;
          if (xml === null) return op; // stay in flight
          op.resolve({ status: 207, data: xml });
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

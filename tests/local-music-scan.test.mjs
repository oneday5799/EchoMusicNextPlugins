// Scan, cache and playback-chain tests against the real scan.ts and
// entry.ts with a fake ctx.files tree. The echo:plugin-sdk hook is
// registered directly: under full-suite parallelism the runner's --import
// propagation can race dynamic imports, so the hook must be in place before
// the plugin modules load.
import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

register('./helpers/echo-sdk-hooks.mjs', import.meta.url);

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

function waitFor(predicate, timeoutMs = 3000, stepMs = 5) {
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

const GRANT = {
  id: 'g1',
  revision: 'r1',
  file: { grantId: 'g1', revision: 'r1', path: '' },
  name: 'Music',
  kind: 'directory',
  access: 'read',
  persistent: true,
  revoked: false,
  available: true,
  displayPath: 'C:/Music',
  installationId: 'inst',
  pluginId: 'local-music',
  pluginName: '本地音乐',
};

/** File tree: path → {size, directory}. */
function makeFilesContext(tree, options = {}) {
  // grantId is parameterized so tests can simulate the host ledger re-issuing
  // the same directory under a new id after reinstall.
  const grantId = options.grantId || 'g1';
  const revision = options.grantRevision || 'r1';
  const grant = {
    ...GRANT,
    id: grantId,
    revision,
    file: { grantId, revision, path: '' },
  };
  const entries = Object.entries(tree).map(([path, info]) => ({
    file: { grantId, revision, path },
    name: path.split('/').pop(),
    size: info.size ?? 10,
    modifiedAt: 0,
    directory: info.directory === true,
    mimeType: info.directory ? '' : 'application/octet-stream',
  }));
  return {
    listGrants() {
      const op = new FakeOperation();
      op.resolve([grant]);
      return op;
    },
    revoke() {
      const op = new FakeOperation();
      op.resolve(undefined);
      return op;
    },
    listFiles(ref, listOptions) {
      const op = new FakeOperation();
      const depth = listOptions && listOptions.depth ? listOptions.depth : 0;
      if (options.truncateWholeTree && depth > 1) {
        // Whole-tree attempt reports truncation so the walk falls back to
        // per-directory listings.
        op.resolve({ entries: entries.slice(0, 1), truncated: true });
        return op;
      }
      if (options.hangDir !== undefined && ref.path === options.hangDir && depth <= 1) {
        // This directory hangs until cancelled, like an unresponsive drive.
        options.hungOperations.push(op);
        return op;
      }
      const prefix = ref.path && ref.path.length > 0 ? `${ref.path}/` : '';
      const visible =
        depth > 1
          ? entries.filter((entry) => entry.file.path !== '')
          : entries.filter(
              (entry) =>
                entry.file.path.startsWith(prefix) &&
                !entry.file.path.slice(prefix.length).includes('/'),
            );
      op.resolve({ entries: visible, truncated: false });
      return op;
    },
    readBytes() {
      const op = new FakeOperation();
      op.resolve({ bytes: new ArrayBuffer(8), bytesRead: 8, truncated: false });
      return op;
    },
    readText() {
      const op = new FakeOperation();
      op.reject('not found');
      return op;
    },
    metadata(ref) {
      const op = new FakeOperation();
      const media = options.metadata && options.metadata[ref.path];
      if (media) {
        op.resolve({
          file: ref,
          name: '',
          size: 0,
          modifiedAt: 0,
          directory: false,
          mimeType: '',
          media,
        });
      } else {
        op.reject('no metadata');
      }
      return op;
    },
    openMedia() {
      const op = new FakeOperation();
      op.resolve({
        id: 'lease-1',
        url: { toString: () => 'http://127.0.0.1:9/media' },
        active: true,
        changed: {},
        dispose() {},
      });
      return op;
    },
    requestDirectory() {
      const op = new FakeOperation();
      op.resolve({ canceled: false, directory: grant });
      return op;
    },
  };
}

function makeStoreIo(store) {
  return {
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
  };
}

function makeBaseCtx(files, store) {
  const commands = new Map();
  const published = [];
  const resolvers = { audio: [], lyrics: [] };
  const playlistCalls = [];
  const ctx = {
    id: 'local-music',
    files,
    io: makeStoreIo(store),
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
    toast: {
      info() {},
      success() {},
      warning() {},
      danger() {},
    },
    player: {
      snapshot: null,
      audioSource: {
        registerResolver(id, definition) {
          resolvers.audio.push(definition);
          return { key: id, dispose() {} };
        },
      },
    },
    lyrics: {
      registerResolver(id, definition) {
        resolvers.lyrics.push(definition);
        return { key: id, dispose() {} };
      },
    },
    tasks: {
      registerTask() {
        return null;
      },
    },
    playlist: {
      snapshot: [],
      replace(id, title, tracks, index) {
        const op = new FakeOperation();
        playlistCalls.push({ kind: 'replace', id, title, tracks, index });
        op.resolve(undefined);
        return op;
      },
      append(key, tracks, placement) {
        const op = new FakeOperation();
        playlistCalls.push({ kind: 'append', key, tracks, placement });
        op.resolve(undefined);
        return op;
      },
    },
    registerCommand(id, handler) {
      commands.set(id, handler);
    },
  };
  return { ctx, commands, published, resolvers, playlistCalls };
}

const TREE = {
  'a.mp3': { size: 100 },
  sub: { directory: true, size: 0 },
  'sub/歌手 - 歌.flac': { size: 200 },
  'sub/歌手 - 歌.lrc': { size: 30 },
  'sub/cover.jpg': { size: 40 },
};

test('collectLibrary：整树列表、歌词配对与封面目录', async () => {
  const { collectLibrary } = await import('../plugins/local-music/src/scan.ts');
  const ctx = { files: makeFilesContext(TREE) };
  const collected = await collectLibrary(ctx, [
    { folderId: 'g1', root: { grantId: 'g1', revision: 'r1', path: '' } },
  ]);
  assert.equal(collected.songs.length, 2);
  const flac = collected.songs.find((song) => song.path.includes('flac'));
  assert.equal(flac.title, '歌');
  assert.equal(flac.artist, '歌手');
  assert.equal(flac.lyricPath, 'sub/歌手 - 歌.lrc');
  const mp3 = collected.songs.find((song) => song.path === 'a.mp3');
  assert.equal(mp3.lyricPath, '');
  assert.equal(collected.dirCovers.get('g1|sub'), 'sub/cover.jpg');
  assert.equal(collected.errors.length, 0);
});

test('collectLibrary：截断回退 BFS 完成扫描', async () => {
  const { collectLibrary } = await import('../plugins/local-music/src/scan.ts');
  const files = makeFilesContext(TREE, { truncateWholeTree: true });
  let operations = 0;
  const collected = await collectLibrary(
    { files },
    [{ folderId: 'g1', root: { grantId: 'g1', revision: 'r1', path: '' } }],
    {
      onOperation: () => {
        operations += 1;
      },
    },
  );
  assert.equal(collected.songs.length, 2, 'BFS 回退应找齐全部歌曲');
  const flac = collected.songs.find((song) => song.path.includes('flac'));
  assert.equal(flac.lyricPath, 'sub/歌手 - 歌.lrc', 'BFS 模式下歌词同样配对');
  assert.ok(operations >= 3, '整树尝试加两级目录列表');
});

test('collectLibrary：中止取消在途列表并保留部分结果', async () => {
  const { collectLibrary, LibraryScanAborted } = await import('../plugins/local-music/src/scan.ts');
  const options = { truncateWholeTree: true, hangDir: 'sub', hungOperations: [] };
  const files = makeFilesContext(TREE, options);
  let thrown = null;
  const walk = collectLibrary(
    { files },
    [{ folderId: 'g1', root: { grantId: 'g1', revision: 'r1', path: '' } }],
    {
      shouldAbort: () => options.hungOperations.length > 0,
    },
  );
  walk.catch((error) => {
    thrown = error;
  });
  await waitFor(() => options.hungOperations.length > 0);
  options.hungOperations[0].cancel();
  await waitFor(() => thrown !== null);
  assert.ok(thrown instanceof LibraryScanAborted, '应抛出中止异常');
  assert.ok(thrown.partial.songs.length >= 1, '中止前应已收集根目录歌曲');
  assert.equal(options.hungOperations[0].cancelRequested, true, '在途列表应被取消');
});

test('曲库缓存分块读写与失效', async () => {
  const { writeLibraryCache, readLibraryCache, clearLibraryCache } =
    await import('../plugins/local-music/src/scan.ts');
  const { songFromEntry } = await import('../plugins/local-music/src/library.ts');
  const store = new Map();
  const ctx = { io: makeStoreIo(store) };
  const songs = [];
  for (let i = 0; i < 450; i += 1) {
    songs.push(songFromEntry({ folderId: 'g1', path: `/${i}.mp3`, name: `${i}.mp3`, size: i }));
  }
  await writeLibraryCache(ctx, ['g1'], songs, false);
  const cached = await readLibraryCache(ctx, ['g1']);
  assert.ok(cached);
  assert.equal(cached.songs.length, 450);
  assert.equal(cached.truncated, false);
  assert.deepEqual(cached.songs[449], songs[449]);
  // A different folder set invalidates the cache.
  assert.equal(await readLibraryCache(ctx, ['g2']), null);
  await clearLibraryCache(ctx);
  assert.equal(await readLibraryCache(ctx, ['g1']), null);
});

function entryTree() {
  return {
    'a.mp3': { size: 100 },
    // The explicit directory entry lets the BFS fallback (used when the
    // whole-tree listing reports truncation) descend into `sub`.
    sub: { directory: true, size: 0 },
    'sub/歌手 - 歌.flac': { size: 200 },
    'sub/歌手 - 歌.lrc': { size: 30 },
    'sub/cover.jpg': { size: 40 },
  };
}

async function activateWith(tree, options = {}, store = new Map()) {
  const { activate, deactivate } = await import('../plugins/local-music/src/entry.ts');
  const files = makeFilesContext(tree, options);
  const harness = makeBaseCtx(files, store);
  await activate(harness.ctx);
  return { ...harness, files, store, deactivate };
}

async function pollInfo(commands, predicate) {
  let info = null;
  for (let i = 0; i < 200; i += 1) {
    info = await commands.get('library.info')({});
    if (predicate(info)) return info;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return info;
}

test('端到端：添加文件夹 → 扫描 → 页命令 → 播放与音源解析', async () => {
  const options = {
    metadata: {
      'a.mp3': {
        title: '标签标题',
        artist: null,
        album: '专辑A',
        durationMs: 180000,
        year: null,
        track: null,
        disk: null,
        genre: null,
      },
    },
  };
  const harness = await activateWith(entryTree(), options);
  const { commands, published, resolvers, playlistCalls } = harness;
  try {
    // No folders yet: the scan job reports the configuration error.
    await commands.get('library.scan')({});
    await waitFor(() =>
      published.some((entry) => entry.scan && typeof entry.scan.error === 'string'),
    );

    const added = await commands.get('folders.add')({});
    assert.equal(added.ok, true);
    assert.equal(added.id, 'g1');

    assert.deepEqual(await commands.get('library.scan')({}), { started: true });
    await waitFor(() => published.some((entry) => entry.scan && entry.scan.done === true));

    const info = await pollInfo(commands, (value) => value && value.ready);
    assert.equal(info.ready, true);
    assert.equal(info.count, 2);

    const page = await commands.get('library.page')({ offset: 0, limit: 10, sort: 'name' });
    assert.equal(page.ready, true);
    assert.equal(page.total, 2);
    const mp3Row = page.songs.find((row) => row.ext === 'mp3');
    assert.equal(mp3Row.title, '标签标题', '标签应覆盖文件名解析');
    assert.equal(mp3Row.artist, '', '空标签保留文件名解析结果');
    assert.equal(mp3Row.album, '专辑A');
    assert.equal(mp3Row.durationMs, 180000);
    assert.equal(mp3Row.quality, 'higher');
    const flacRow = page.songs.find((row) => row.ext === 'flac');
    assert.equal(flacRow.title, '歌');
    assert.equal(flacRow.artist, '歌手');
    assert.ok(flacRow.sourceId.startsWith('local:'));

    // Albums: one from tags, one unknown bucket; the unknown bucket falls
    // back to the folder cover image found during the scan.
    const albums = await commands.get('library.albums')({ offset: 0, limit: 10 });
    assert.equal(albums.ready, true);
    assert.equal(albums.total, 2);
    const unknown = albums.albums.find((album) => album.name === '未知专辑');
    assert.ok(unknown);
    assert.ok(unknown.cover.startsWith('data:image/jpeg'), '文件夹封面应作为专辑封面回退');

    // Row cover lookup mirrors what the page sends after each page load.
    const covers = await commands.get('library.covers')({ ids: [flacRow.id, mp3Row.id] });
    assert.equal(covers.covers[flacRow.id], unknown.cover);
    assert.equal(covers.covers[mp3Row.id], undefined, '无封面的曲目不应有条目');

    // Keyword filtering mirrors what the page sends.
    const filtered = await commands.get('library.page')({ offset: 0, limit: 10, keyword: '标签' });
    assert.equal(filtered.total, 1);
    const folderFiltered = await commands.get('library.page')({
      offset: 0,
      limit: 10,
      folderId: 'g1',
    });
    assert.equal(folderFiltered.total, 2);

    playlistCalls.length = 0;
    const play = await commands.get('play')({
      mode: 'now',
      keyword: '',
      folderId: '',
      album: '',
      sort: 'name',
      index: 0,
    });
    assert.equal(play.ok, true);
    assert.equal(playlistCalls.length, 1);
    const replace = playlistCalls[0];
    assert.equal(replace.id, 'library');
    assert.equal(replace.title, '本地音乐');
    assert.equal(replace.index, 0);
    assert.equal(replace.tracks.length, 2);
    assert.equal(replace.tracks[0].title, '标签标题');
    assert.equal(replace.tracks[0].data.f, 'g1');

    // The audio resolver turns a queue track into a loopback media URL.
    assert.equal(resolvers.audio.length, 1);
    const resolved = await resolvers.audio[0].resolve({
      track: replace.tracks[0],
      request: { track: () => true },
      quality: 'standard',
      effect: 'none',
      forceReload: false,
      preloading: false,
    });
    assert.equal(resolved.url, 'http://127.0.0.1:9/media');
    assert.equal(resolved.sourceKind, 'plugin');
    assert.equal(resolved.quality, 'higher');
    assert.equal(resolved.durationMs, 180000);

    // Appending goes to the active queue once one exists.
    playlistCalls.length = 0;
    harness.ctx.playlist.snapshot = [
      { key: 'plugin/local-music/library', title: '本地音乐', active: true },
    ];
    const appendResult = await commands.get('play')({
      mode: 'append',
      ids: [replace.tracks[1].id],
    });
    assert.equal(appendResult.ok, true);
    assert.equal(playlistCalls[0].kind, 'append');
    assert.equal(playlistCalls[0].placement, 'last');
  } finally {
    await harness.deactivate();
  }
});

test('扫描中止：部分结果保留且页面立即可读', async () => {
  // The BFS walk hangs on the second directory; library.abort cancels the
  // in-flight listing and the songs collected so far must stay browsable.
  const options = { truncateWholeTree: true, hangDir: 'sub', hungOperations: [] };
  const harness = await activateWith(entryTree(), options);
  const { commands, published } = harness;
  try {
    await commands.get('folders.add')({});
    assert.deepEqual(await commands.get('library.scan')({}), { started: true });
    await waitFor(() => options.hungOperations.length > 0);
    assert.deepEqual(await commands.get('library.abort')({}), { ok: true });
    await waitFor(() => published.some((entry) => entry.scan && entry.scan.aborted === true));
    assert.equal(options.hungOperations[0].cancelRequested, true, '在途列表应被取消');

    const info = await pollInfo(commands, (value) => value && value.ready);
    assert.equal(info.ready, true, '中止后部分结果应使曲库就绪');
    assert.ok(info.count >= 1, '应保留中止前扫描到的歌曲');
    const page = await commands.get('library.page')({ offset: 0, limit: 10 });
    assert.equal(page.ready, true);
    assert.ok(page.total >= 1);
  } finally {
    await harness.deactivate();
  }
});

test('设置命令：重命名、开关与移除文件夹', async () => {
  const harness = await activateWith(entryTree());
  const { commands, store } = harness;
  try {
    await commands.get('folders.add')({});
    const renamed = await commands.get('folders.rename')({ id: 'g1', name: '我的音乐' });
    assert.equal(renamed.ok, true);
    let snapshot = await commands.get('library.settings.get')({});
    assert.equal(snapshot.folders[0].name, '我的音乐');
    assert.equal(snapshot.folders[0].path, 'C:/Music');

    await commands.get('library.settings.patch')({ onlineFetch: true, readEmbedded: false });
    snapshot = await commands.get('library.settings.get')({});
    assert.equal(snapshot.onlineFetch, true);
    assert.equal(snapshot.readEmbedded, false);

    const removed = await commands.get('folders.remove')({ id: 'g1' });
    assert.equal(removed.ok, true);
    snapshot = await commands.get('library.settings.get')({});
    assert.equal(snapshot.folders.length, 0);
    assert.equal(store.get('settings').folders.length, 0);
  } finally {
    await harness.deactivate();
  }
});

test('缓存预热：第二次激活直接就绪', async () => {
  // Both activations share one KV store, like repeated app sessions.
  const store = new Map();
  const first = await activateWith(entryTree(), {}, store);
  try {
    await first.commands.get('folders.add')({});
    assert.deepEqual(await first.commands.get('library.scan')({}), { started: true });
    await waitFor(() => first.published.some((entry) => entry.scan && entry.scan.done === true));
  } finally {
    await first.deactivate();
  }

  // Second activation with the same folder set loads the cache silently.
  const second = await activateWith(entryTree(), {}, store);
  try {
    const info = await pollInfo(second.commands, (value) => value && value.ready);
    assert.equal(info.ready, true, '缓存应使曲库直接就绪');
    assert.equal(info.count, 2);
    const page = await second.commands.get('library.page')({ offset: 0, limit: 10 });
    assert.equal(page.total, 2);
  } finally {
    await second.deactivate();
  }
});

test('授权重发：重装后按路径自动认领文件夹', async () => {
  // Session 1: grant g1, folder added normally.
  const store = new Map();
  const first = await activateWith(entryTree(), {}, store);
  try {
    const added = await first.commands.get('folders.add')({});
    assert.equal(added.ok, true);
    assert.equal(added.id, 'g1');
    const snapshot = await first.commands.get('library.settings.get')({});
    assert.equal(snapshot.folders[0].path, 'C:/Music', '路径应随文件夹持久化');
  } finally {
    await first.deactivate();
  }

  // Session 2: the ledger re-issued the same directory as grant g2 (e.g.
  // after uninstall/reinstall). Activation must re-claim it by path instead
  // of showing a dead "unavailable" folder, and scanning must work again.
  const second = await activateWith(entryTree(), { grantId: 'g2', grantRevision: 'r2' }, store);
  try {
    const snapshot = await second.commands.get('library.settings.get')({});
    assert.equal(snapshot.folders.length, 1, '不应出现重复或残留的死条目');
    assert.equal(snapshot.folders[0].id, 'g2', '应自动认领重发的授权');
    assert.equal(snapshot.folders[0].name, 'Music', '保留用户改过的名称');
    assert.equal(snapshot.folders[0].available, true);

    // The persisted settings store carries the adopted id too.
    assert.equal(store.get('settings').folders[0].id, 'g2');
    assert.equal(store.get('settings').folders[0].path, 'C:/Music');

    // The old cache referenced the dead grant id, so one rescan rebuilds it
    // under the adopted id — the folder itself survived, which is the point.
    const staleInfo = await second.commands.get('library.info')({});
    assert.equal(staleInfo.available, 1, '认领后的文件夹应可用');
    assert.equal(staleInfo.stale, true, '旧缓存应标记为过期');
    assert.deepEqual(await second.commands.get('library.scan')({}), { started: true });
    await waitFor(() => second.published.some((entry) => entry.scan && entry.scan.done === true));
    const info = await pollInfo(second.commands, (value) => value && value.ready);
    assert.equal(info.ready, true);
    assert.equal(info.count, 2);

    // Re-adding the already re-claimed directory reports a duplicate instead
    // of duplicating the row.
    const added = await second.commands.get('folders.add')({});
    assert.equal(added.ok, false);
    assert.equal(added.duplicate, true);
    const after = await second.commands.get('library.settings.get')({});
    assert.equal(after.folders.length, 1);
  } finally {
    await second.deactivate();
  }
});

// ── Cover / lyric cache tests ──────────────────────────────────────────────
//
// The persisted cover store needs real ID3 bytes with APIC frames; the
// default harness readBytes returns 8 zero bytes, which parseAudioTags
// rejects, so these tests patch files.readBytes with per-path payloads.

function asciiBytes(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** Deterministic pseudo-PNG payload; the exact bytes matter for hashing. */
function artBytes(seed, length) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (seed + i * 7) & 0xff;
  out[0] = 0x89;
  out[1] = 0x50;
  out[2] = 0x4e;
  out[3] = 0x47;
  return out;
}

function id3Frame(id, payload) {
  const head = new Uint8Array(10);
  for (let i = 0; i < 4; i++) head[i] = id.charCodeAt(i);
  head[4] = (payload.length >>> 24) & 0xff;
  head[5] = (payload.length >>> 16) & 0xff;
  head[6] = (payload.length >>> 8) & 0xff;
  head[7] = payload.length & 0xff;
  const out = new Uint8Array(10 + payload.length);
  out.set(head, 0);
  out.set(payload, 10);
  return out;
}

function id3Header(bodyLength) {
  const header = new Uint8Array(10);
  header[0] = 0x49;
  header[1] = 0x44;
  header[2] = 0x33;
  header[3] = 3;
  header[6] = (bodyLength >>> 21) & 0x7f;
  header[7] = (bodyLength >>> 14) & 0x7f;
  header[8] = (bodyLength >>> 7) & 0x7f;
  header[9] = bodyLength & 0x7f;
  return header;
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** ID3v2.3 APIC: encoding 0 (latin1), "image/png", type 3, empty description. */
function mp3WithCover(art) {
  const payload = concatBytes([
    Uint8Array.of(0),
    asciiBytes('image/png'),
    Uint8Array.of(0),
    Uint8Array.of(3),
    Uint8Array.of(0),
    art,
  ]);
  const frame = id3Frame('APIC', payload);
  return concatBytes([id3Header(frame.length), frame]);
}

function artUrl(art) {
  return `data:image/png;base64,${Buffer.from(art).toString('base64')}`;
}

/** Serves per-path audio bytes instead of the 8-byte stub. */
function patchReadBytes(harness, bytesForPath) {
  harness.files.readBytes = (ref) => {
    const op = new FakeOperation();
    const path = ref && typeof ref.path === 'string' ? ref.path : '';
    const bytes = bytesForPath[path];
    if (bytes) {
      const copy = bytes.slice();
      op.resolve({ bytes: copy.buffer, bytesRead: copy.byteLength, truncated: false });
      return op;
    }
    op.resolve({ bytes: new ArrayBuffer(8), bytesRead: 8, truncated: false });
    return op;
  };
}

async function scanAndWait(harness) {
  assert.deepEqual(await harness.commands.get('library.scan')({}), { started: true });
  await waitFor(() => harness.published.some((entry) => entry.scan && entry.scan.done === true));
}

function splitEntry(entry) {
  const parts = String(entry).split('|');
  return { hash: parts[0] || '', size: Number(parts[1]) };
}

test('封面命令：单次响应有数量上限并标记截断', async () => {
  const art = artBytes(9, 64);
  const tree = {};
  for (let i = 0; i < 40; i += 1) tree[`${i}.mp3`] = { size: 100 + i };
  const harness = await activateWith(tree, {});
  const { commands, store } = harness;
  const bytes = {};
  for (let i = 0; i < 40; i += 1) bytes[`${i}.mp3`] = mp3WithCover(art);
  patchReadBytes(harness, bytes);
  try {
    await commands.get('folders.add')({});
    await scanAndWait(harness);
    const page = await commands.get('library.page')({ offset: 0, limit: 100 });
    assert.equal(page.total, 40);
    const covers = await commands.get('library.covers')({ ids: page.songs.map((row) => row.id) });
    assert.equal(Object.keys(covers.covers).length, 32, '单次响应最多 32 张');
    assert.equal(covers.truncated, true, '截断应标记给调用方');
    // A small batch fits comfortably and is not truncated.
    const small = await commands.get('library.covers')({
      ids: page.songs.slice(0, 8).map((row) => row.id),
    });
    assert.equal(Object.keys(small.covers).length, 8);
    assert.equal(small.truncated, false);
    assert.ok(store.get('coverMap'), '扫描仍按内容哈希去重');
    assert.equal(Object.keys(store.get('coverMap')).length, 40);
    assert.equal(store.get('coverHashes').length, 1);
  } finally {
    await harness.deactivate();
  }
});

test('封面持久化：扫描写入逐曲条目并按内容去重', async () => {
  const artA = artBytes(1, 64);
  const artB = artBytes(2, 80);
  const harness = await activateWith(
    { 'a.mp3': { size: 100 }, 'b.mp3': { size: 100 }, 'c.mp3': { size: 120 } },
    {},
  );
  const { commands, store } = harness;
  patchReadBytes(harness, {
    'a.mp3': mp3WithCover(artA),
    'b.mp3': mp3WithCover(artA),
    'c.mp3': mp3WithCover(artB),
  });
  try {
    await commands.get('folders.add')({});
    await scanAndWait(harness);
    await pollInfo(commands, (value) => value && value.ready);

    const page = await commands.get('library.page')({ offset: 0, limit: 10, sort: 'name' });
    assert.equal(page.total, 3);
    const [rowA, rowB, rowC] = page.songs;

    const map = store.get('coverMap');
    const a = splitEntry(map[rowA.id]);
    const b = splitEntry(map[rowB.id]);
    const c = splitEntry(map[rowC.id]);
    assert.equal(a.size, 100);
    assert.equal(c.size, 120);
    assert.equal(a.hash, b.hash, '相同内嵌图共享同一内容哈希');
    assert.notEqual(a.hash, c.hash);

    const hashes = store.get('coverHashes');
    assert.deepEqual([...hashes].sort(), [a.hash, c.hash].sort());
    assert.equal(store.get(`coverimg:${a.hash}`), artUrl(artA));
    assert.equal(store.get(`coverimg:${c.hash}`), artUrl(artB));

    // Row covers serve straight from the persisted store.
    const covers = await commands.get('library.covers')({ ids: [rowA.id, rowB.id, rowC.id] });
    assert.equal(covers.covers[rowA.id], artUrl(artA));
    assert.equal(covers.covers[rowB.id], artUrl(artA));
    assert.equal(covers.covers[rowC.id], artUrl(artB));
  } finally {
    await harness.deactivate();
  }
});

test('重扫对账：不变保留、变更更新、删除清理孤儿与遗留数据', async () => {
  const artA = artBytes(1, 64);
  const artB = artBytes(2, 80);
  const artB2 = artBytes(3, 96);
  const store = new Map();
  const first = await activateWith(
    { 'a.mp3': { size: 100 }, 'b.mp3': { size: 100 }, 'c.mp3': { size: 120 } },
    {},
    store,
  );
  patchReadBytes(first, {
    'a.mp3': mp3WithCover(artA),
    'b.mp3': mp3WithCover(artA),
    'c.mp3': mp3WithCover(artB),
  });
  let rowA;
  let rowB;
  let rowC;
  let before;
  try {
    await first.commands.get('folders.add')({});
    await scanAndWait(first);
    const page = await first.commands.get('library.page')({ offset: 0, limit: 10, sort: 'name' });
    [rowA, rowB, rowC] = page.songs;
    before = store.get('coverMap');
    assert.ok(before[rowA.id] && before[rowB.id] && before[rowC.id]);

    // Leftovers an old plugin version may have written, plus a lyric that is
    // about to lose its song.
    store.set(`cover:${rowA.id}`, 'data:image/jpeg;base64,bGVnYWN5');
    store.set('coverIndex', [rowA.id]);
    store.set(`lyric:${rowA.id}`, {
      t: 'a',
      a: '',
      format: 'lrc',
      content: '[00:01.00]旧的歌词',
      translation: '',
      romanization: '',
      source: '酷狗歌词',
    });
    store.set(`lyric:${rowC.id}`, {
      t: 'c',
      a: '',
      format: 'lrc',
      content: '[00:01.00]保留的歌词',
      translation: '',
      romanization: '',
      source: '酷狗歌词',
    });
    store.set('lyricIndex', [rowA.id, rowC.id]);
  } finally {
    await first.deactivate();
  }

  // Session 2: a.mp3 removed, c.mp3 rewritten (size and art both change).
  const second = await activateWith({ 'b.mp3': { size: 100 }, 'c.mp3': { size: 960 } }, {}, store);
  patchReadBytes(second, { 'c.mp3': mp3WithCover(artB2) });
  try {
    await scanAndWait(second);

    const map = store.get('coverMap');
    assert.deepEqual(Object.keys(map).sort(), [rowB.id, rowC.id].sort(), '被删除歌曲的条目应移除');
    assert.equal(map[rowB.id], before[rowB.id], '尺寸未变的曲目保留原条目');
    const hashA = splitEntry(before[rowA.id]).hash;
    const hashB = splitEntry(before[rowC.id]).hash;
    const c = splitEntry(map[rowC.id]);
    assert.equal(c.size, 960, '尺寸变更后条目跟随新大小');
    assert.notEqual(c.hash, hashB, '封面变更后换用新内容哈希');

    const hashes = store.get('coverHashes');
    assert.deepEqual([...hashes].sort(), [hashA, c.hash].sort());
    assert.equal(store.has(`coverimg:${hashB}`), false, '无引用的旧图应被回收');
    assert.equal(store.get(`coverimg:${hashA}`), artUrl(artA), '仍被 b 引用的图保留');
    assert.equal(store.get(`coverimg:${c.hash}`), artUrl(artB2));

    assert.equal(store.has(`cover:${rowA.id}`), false, '遗留逐曲封面应清理');
    assert.equal(store.has('coverIndex'), false, '遗留封面索引应清理');

    assert.equal(store.has(`lyric:${rowA.id}`), false, '已删除歌曲的歌词应清理');
    assert.equal(store.has(`lyric:${rowC.id}`), true, '仍存在歌曲的歌词保留');
    assert.deepEqual(store.get('lyricIndex'), [rowC.id]);
  } finally {
    await second.deactivate();
  }
});

test('播放补全：内嵌封面在播放时持久化', async () => {
  const art = artBytes(5, 72);
  const store = new Map();
  const harness = await activateWith({ 'a.mp3': { size: 100 } }, {}, store);
  const { commands, playlistCalls } = harness;
  patchReadBytes(harness, { 'a.mp3': mp3WithCover(art) });
  try {
    await commands.get('folders.add')({});
    // 读取内嵌关闭时扫描：曲库与封面缓存都不应出现封面。
    await commands.get('library.settings.patch')({ readEmbedded: false });
    await scanAndWait(harness);
    assert.deepEqual(store.get('coverMap'), {});
    assert.deepEqual(store.get('coverHashes'), []);

    const page = await commands.get('library.page')({ offset: 0, limit: 10, sort: 'name' });
    const row = page.songs[0];

    // 重新开启内嵌读取后播放：封面即时补全并持久化。
    await commands.get('library.settings.patch')({ readEmbedded: true });
    playlistCalls.length = 0;
    const play = await commands.get('play')({
      mode: 'now',
      keyword: '',
      folderId: '',
      album: '',
      sort: 'name',
      index: 0,
    });
    assert.equal(play.ok, true);
    assert.equal(playlistCalls[0].tracks[0].cover, artUrl(art), '播放载荷应带补全的封面');

    await waitFor(() => {
      const map = store.get('coverMap');
      return map && Object.keys(map).length === 1;
    });
    const entry = splitEntry(store.get('coverMap')[row.id]);
    assert.equal(entry.size, 100);
    assert.equal(store.get(`coverimg:${entry.hash}`), artUrl(art));
    assert.ok(store.get('coverHashes').includes(entry.hash));
  } finally {
    await harness.deactivate();
  }
});

test('播放补全：在线封面持久化后不再重复请求', async () => {
  const remote = 'https://cdn.example.com/cover.jpg';
  const store = new Map();
  const harness = await activateWith({ 'a.mp3': { size: 100 } }, {}, store);
  const { commands, playlistCalls } = harness;
  let searches = 0;
  harness.ctx.kugou = {
    request(kind, params) {
      const op = new FakeOperation();
      if (kind === 'search') {
        searches += 1;
        op.resolve({ kind: 'songs', page: { items: [{ id: 'k1', cover_url: remote }] } });
      } else {
        op.reject(`unexpected kugou kind: ${kind}`);
      }
      return op;
    },
  };
  try {
    await commands.get('folders.add')({});
    // 在线补全未开启：扫描与播放都不应请求 kugou。
    await scanAndWait(harness);
    assert.equal(searches, 0);
    assert.deepEqual(store.get('coverMap'), {});

    const page = await commands.get('library.page')({ offset: 0, limit: 10, sort: 'name' });
    const row = page.songs[0];

    const playArgs = { mode: 'now', keyword: '', folderId: '', album: '', sort: 'name', index: 0 };
    playlistCalls.length = 0;
    await commands.get('play')(playArgs);
    assert.equal(searches, 0, '在线补全未开启时播放不请求 kugou');
    assert.equal(playlistCalls[0].tracks[0].cover, undefined);

    await commands.get('library.settings.patch')({ onlineFetch: true });
    playlistCalls.length = 0;
    await commands.get('play')(playArgs);
    assert.equal(searches, 1, '开启后第一次播放请求一次 kugou');
    assert.equal(playlistCalls[0].tracks[0].cover, remote);

    await waitFor(() => {
      const map = store.get('coverMap');
      return map && Object.keys(map).length === 1;
    });
    const hash = splitEntry(store.get('coverMap')[row.id]).hash;
    assert.equal(store.get(`coverimg:${hash}`), remote);

    playlistCalls.length = 0;
    await commands.get('play')(playArgs);
    assert.equal(searches, 1, '持久化后第二次播放不再请求 kugou');
    assert.equal(playlistCalls[0].tracks[0].cover, remote);
  } finally {
    await harness.deactivate();
  }
});

test('暖启动封面补全：缓存就绪后无需重扫', async () => {
  const artA = artBytes(1, 64);
  const store = new Map();
  const first = await activateWith({ 'a.mp3': { size: 100 } }, {}, store);
  patchReadBytes(first, { 'a.mp3': mp3WithCover(artA) });
  try {
    await first.commands.get('folders.add')({});
    await scanAndWait(first);
    // Simulate a library cached by an older build: songs present, the new
    // cover store never populated.
    store.delete('coverMap');
    store.delete('coverHashes');
  } finally {
    await first.deactivate();
  }

  const second = await activateWith({ 'a.mp3': { size: 100 } }, {}, store);
  patchReadBytes(second, { 'a.mp3': mp3WithCover(artA) });
  try {
    const info = await pollInfo(second.commands, (value) => value && value.ready);
    assert.equal(info.ready, true, '缓存应使曲库直接就绪');
    // The background backfill persists covers without any rescan.
    await waitFor(() => {
      const map = second.store.get('coverMap');
      return map && Object.keys(map).length === 1;
    }, 5000);
    const page = await second.commands.get('library.page')({ offset: 0, limit: 10 });
    const covers = await second.commands.get('library.covers')({ ids: [page.songs[0].id] });
    assert.equal(covers.covers[page.songs[0].id], artUrl(artA));
    assert.equal(second.store.get('__diag').stage, 'warm');
  } finally {
    await second.deactivate();
  }
});

test('歌词持久化与清除命令', async () => {
  const remote = 'https://cdn.example.com/a.jpg';
  const store = new Map();
  const harness = await activateWith({ 'a.mp3': { size: 100 } }, {}, store);
  const { commands, resolvers } = harness;
  const calls = { search: 0, candidates: 0, lyric: 0 };
  harness.ctx.kugou = {
    request(kind, params) {
      const op = new FakeOperation();
      if (kind === 'search') {
        calls.search += 1;
        op.resolve({
          kind: 'songs',
          page: { items: [{ id: 'k1', cover_url: remote, duration_ms: 180000 }] },
        });
      } else if (kind === 'lyricCandidatesByKeywords') {
        calls.candidates += 1;
        op.resolve([
          { source_id: 's1', access_key: 'k1', word_timed: true, scrollable: true, score: 9 },
        ]);
      } else if (kind === 'lyric') {
        calls.lyric += 1;
        op.resolve({ lines: [{ text: '你好', start_ms: 1000, translation: 'hello' }] });
      } else {
        op.reject(`unexpected kugou kind: ${kind}`);
      }
      return op;
    },
  };
  try {
    await commands.get('folders.add')({});
    await commands.get('library.settings.patch')({ onlineFetch: true });
    await scanAndWait(harness);
    // 扫描阶段的专辑代表回退把在线封面持久化了。
    const page = await commands.get('library.page')({ offset: 0, limit: 10, sort: 'name' });
    const row = page.songs[0];
    const coverHash = splitEntry(store.get('coverMap')[row.id]).hash;
    assert.equal(store.get(`coverimg:${coverHash}`), remote);

    const resolver = resolvers.lyrics[0];
    const track = {
      id: row.id,
      sourceId: row.sourceId,
      title: 'a',
      artist: '',
      data: { p: 'a.mp3', f: 'g1', s: 100 },
    };
    const doc = await resolver.resolve({ track, durationMs: 180000 });
    assert.equal(doc.format, 'lrc');
    assert.equal(doc.content, '[00:01.00]你好');
    assert.equal(doc.translation, '[00:01.00]hello');
    assert.equal(doc.source, '酷狗歌词');

    const record = store.get(`lyric:${row.id}`);
    assert.equal(record.t, 'a');
    assert.equal(record.a, '');
    assert.equal(record.content, doc.content);
    assert.deepEqual(store.get('lyricIndex'), [row.id]);

    // 复用：第二次解析命中持久化缓存，不重复请求在线。
    const again = await resolver.resolve({ track, durationMs: 180000 });
    assert.equal(again.content, doc.content);
    assert.equal(calls.candidates, 1);
    assert.equal(calls.lyric, 1);

    // 标题/歌手身份不符：重新在线匹配并覆盖记录。
    const retagged = await resolver.resolve({
      track: { ...track, title: '别的歌' },
      durationMs: 180000,
    });
    assert.equal(retagged.content, doc.content);
    assert.equal(calls.lyric, 2);
    assert.equal(store.get(`lyric:${row.id}`).t, '别的歌');

    // 清除命令：封面与歌词全部移除，曲库设置不动。
    const cleared = await commands.get('library.cache.clear')({});
    assert.deepEqual(cleared, { ok: true, covers: 2, lyrics: 1 });
    assert.equal(store.has('coverMap'), false);
    assert.equal(store.has('coverHashes'), false);
    assert.equal(store.has(`coverimg:${coverHash}`), false);
    assert.equal(store.has('lyricIndex'), false);
    assert.equal(store.has(`lyric:${row.id}`), false);
    const settings = store.get('settings');
    assert.equal(settings.folders.length, 1, '清除不应影响曲库设置');
  } finally {
    await harness.deactivate();
  }
});

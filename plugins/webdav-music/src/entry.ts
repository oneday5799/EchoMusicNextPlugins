// Plugin entry: activation, WebDAV audio/lyric resolvers, browse/flat/play
// commands for the QML pages, settings persistence and the scan task.

import { awaitOperation } from 'echo:plugin-sdk';
import type {
  AudioSourceContext,
  AudioSourceValue,
  EchoPluginContext,
  EchoPluginRegistration,
  EchoPluginTask,
  JsonValue,
  QueueTrack,
} from 'echo:plugin-sdk';
import { cancelOperationAfter, raceTimeout } from './async.ts';
import { asArrayBuffer, bytesToBase64 } from './codec.ts';
import {
  activeLibrary,
  findLibrary,
  normalizeSettings,
  SETTINGS_KEY,
  type WebdavLibraryConfig,
  type WebdavSettings,
} from './config.ts';
import { createEnricher, matchesKeyword, type Enricher, type TrackEnrichment } from './enrich.ts';
import {
  buildQueueTrack,
  extensionOf,
  isAudioFile,
  parseSourceId,
  qualityForExtension,
  songFromEntry,
  SOURCE_ID_PREFIX,
  type QueueTrackExtras,
  type SongInit,
} from './library.ts';
import {
  baseName,
  buildAuthUrl,
  COVER_NAMES,
  endpointOf,
  normalizeDir,
  parsePropfind,
  propfindRequest,
  propfindStatusOk,
  readRangeRequest,
  type WebdavEndpoint,
} from './webdav.ts';
import { createLyricEngine, type LyricEngine } from './lyric.ts';
import {
  clearFlatCache,
  collectSongsUnder,
  flatMetaKey,
  metaMatches,
  parseFlatMeta,
  readFlatCache,
  writeFlatCache,
  FlatScanAborted,
} from './scan.ts';

const BROWSE_TIMEOUT_MS = 12000;
const COVER_READ_LIMIT = 1024 * 1024;
const COVER_TIMEOUT_MS = 8000;
const ENRICH_BUDGET_MS = 1800;
const DIR_COLLECT_CAP = 800;
const FLAT_PAGE_LIMIT = 500;

interface FileRowJson extends Record<string, JsonValue> {
  id: string;
  sourceId: string;
  path: string;
  title: string;
  artist: string;
  size: number;
  ext: string;
  quality: string;
}

interface DirRowJson extends Record<string, JsonValue> {
  name: string;
  path: string;
}

interface ScanJob {
  libraryId: string;
  aborted: boolean;
  task: EchoPluginTask | null;
  /** The directory request currently on the wire, cancellable on abort. */
  inflight: { cancel(): void } | null;
}

let context: EchoPluginContext | null = null;
let settings: WebdavSettings = normalizeSettings(undefined);
let enricher: Enricher | null = null;
let registrations: EchoPluginRegistration[] = [];
let flatSongs = new Map<string, SongInit[]>();
let dirCovers = new Map<string, string>();
let scanJob: ScanJob | null = null;
let scanEpoch = 0;
let settingsRevision = 0;
/** Last value published under flatScan; ui.setState replaces the whole state,
 * so every publish must carry both keys to avoid wiping its sibling. */
let lastFlatScan: JsonValue = null;

function requireContext(): EchoPluginContext {
  if (!context) throw new Error('插件未激活');
  return context;
}

function argString(args: Record<string, JsonValue>, key: string): string {
  const value = args ? args[key] : undefined;
  return typeof value === 'string' ? value : '';
}

function argNumber(args: Record<string, JsonValue>, key: string, fallback: number): number {
  const value = args ? args[key] : undefined;
  if (typeof value !== 'number' || !isFinite(value)) return fallback;
  return value;
}

function argBoolean(args: Record<string, JsonValue>, key: string): boolean {
  const value = args ? args[key] : undefined;
  return value === true;
}

function argStringArray(args: Record<string, JsonValue>, key: string): string[] {
  const value = args ? args[key] : undefined;
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item) items.push(item);
  }
  return items;
}

function libraryFromArgs(args: Record<string, JsonValue>): WebdavLibraryConfig | null {
  const requested = findLibrary(settings, argString(args, 'libraryId'));
  return requested ?? activeLibrary(settings);
}

function endpointForLibrary(libraryId: string): WebdavEndpoint | null {
  const library = findLibrary(settings, libraryId);
  return library ? endpointOf(library) : null;
}

function settingsToValue(value: WebdavSettings): JsonValue {
  return {
    libraries: value.libraries.map((library) => ({
      id: library.id,
      name: library.name,
      serverUrl: library.serverUrl,
      username: library.username,
      password: library.password,
      rootPath: library.rootPath,
      flatView: library.flatView,
    })),
    activeLibraryId: value.activeLibraryId,
    coverLyricSource: value.coverLyricSource,
  };
}

function fileRowFromSong(song: SongInit): FileRowJson {
  const extension = extensionOf(song.path);
  return {
    id: song.id,
    sourceId: song.sourceId,
    path: song.path,
    title: song.title,
    artist: song.artist,
    size: song.size,
    ext: extension,
    quality: qualityForExtension(extension),
  };
}

function compareByTitle(
  a: { title?: string; name?: string },
  b: { title?: string; name?: string },
): number {
  const left = (a.title ?? a.name ?? '').toLowerCase();
  const right = (b.title ?? b.name ?? '').toLowerCase();
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function guessImageMime(name: string): string {
  const extension = extensionOf(name);
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'gif') return 'image/gif';
  if (extension === 'bmp') return 'image/bmp';
  return 'image/jpeg';
}

async function fetchCoverDataUrl(
  ctx: EchoPluginContext,
  endpoint: WebdavEndpoint,
  candidates: string[],
): Promise<string> {
  for (const candidate of candidates) {
    const operation = readRangeRequest(
      ctx.net,
      endpoint,
      candidate,
      0,
      COVER_READ_LIMIT - 1,
      COVER_TIMEOUT_MS,
    );
    const disarm = cancelOperationAfter(ctx, operation, COVER_TIMEOUT_MS + 500);
    try {
      const response = await awaitOperation(operation);
      const buffer = asArrayBuffer(response.data);
      if ((response.status === 200 || response.status === 206) && buffer && buffer.byteLength > 0) {
        return `data:${guessImageMime(candidate)};base64,${bytesToBase64(new Uint8Array(buffer))}`;
      }
    } catch (error) {
      // Try the next cover candidate.
    } finally {
      disarm();
    }
  }
  return '';
}

async function browseLoad(args: Record<string, JsonValue>): Promise<JsonValue> {
  const ctx = requireContext();
  const library = libraryFromArgs(args);
  if (!library) return { error: 'no-library', message: '请先在设置中添加 WebDAV 库' };
  if (!library.serverUrl) return { error: 'no-server', message: '该库尚未配置服务器地址' };
  const endpoint = endpointOf(library);
  const directory = normalizeDir(argString(args, 'path') || endpoint.rootPath);
  const operation = propfindRequest(ctx.net, endpoint, directory, BROWSE_TIMEOUT_MS);
  const disarm = cancelOperationAfter(ctx, operation, BROWSE_TIMEOUT_MS + 500);
  let response;
  try {
    response = await awaitOperation(operation);
  } catch (error) {
    return {
      error: 'network',
      message: `连接失败：${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    disarm();
  }
  if (!propfindStatusOk(response.status)) {
    return {
      error: 'http',
      status: response.status,
      message: `服务器返回 HTTP ${response.status}，请检查地址、账号或目录权限`,
    };
  }
  const entries = parsePropfind(typeof response.data === 'string' ? response.data : '');
  const dirs: DirRowJson[] = [];
  const files: FileRowJson[] = [];
  const coverCandidates: string[] = [];
  for (const entry of entries) {
    if (entry.path === directory) continue;
    if (entry.isCollection) {
      dirs.push({ name: entry.name, path: entry.path });
      continue;
    }
    if (isAudioFile(entry.name)) {
      const song = songFromEntry({
        libraryId: library.id,
        path: entry.path,
        name: entry.name,
        size: entry.contentLength,
      });
      files.push(fileRowFromSong(song));
    } else if (COVER_NAMES.indexOf(entry.name.toLowerCase()) >= 0) {
      coverCandidates.push(entry.path);
    }
  }
  dirs.sort(compareByTitle);
  files.sort(compareByTitle);
  let cover = dirCovers.get(directory) ?? '';
  if (!cover && coverCandidates.length > 0) {
    cover = await fetchCoverDataUrl(ctx, endpoint, coverCandidates);
    if (cover) dirCovers.set(directory, cover);
  }
  return { libraryId: library.id, path: directory, root: endpoint.rootPath, dirs, files, cover };
}

async function readFlatSongsSafe(
  ctx: EchoPluginContext,
  library: WebdavLibraryConfig,
): Promise<SongInit[] | null> {
  try {
    return await readFlatCache(ctx, library);
  } catch (error) {
    return null;
  }
}

function publishScan(values: Record<string, JsonValue>): void {
  const ctx = context;
  if (!ctx) return;
  lastFlatScan = values;
  try {
    ctx.ui.setState({ settingsRevision, flatScan: values });
  } catch (error) {
    // UI may already be draining during deactivation.
  }
}

function requestScanAbort(job: ScanJob): void {
  job.aborted = true;
  if (job.inflight) {
    try {
      job.inflight.cancel();
    } catch (error) {
      // The request may already have settled.
    }
    job.inflight = null;
  }
}

async function runScanJob(
  ctx: EchoPluginContext,
  library: WebdavLibraryConfig,
  job: ScanJob,
  epoch: number,
): Promise<void> {
  const finishTask = (status: 'completed' | 'error' | 'aborted', label: string, error?: string) => {
    try {
      job.task?.finish(status, { progress: { done: 1, total: 1, label }, error });
    } catch (taskError) {
      // Task handle already gone.
    }
  };
  try {
    const songs = await collectSongsUnder(
      ctx,
      endpointOf(library),
      library.id,
      endpointOf(library).rootPath,
      {
        cap: 0,
        shouldAbort: () => job.aborted || epoch !== scanEpoch,
        onOperation: (operation) => {
          job.inflight = operation;
        },
        onProgress: (found, scanned) => {
          if (job.aborted || epoch !== scanEpoch) return;
          const label = `已扫描 ${scanned} 个目录，找到 ${found} 首`;
          try {
            job.task?.update({ progress: { done: scanned, total: 0, label } });
          } catch (taskError) {
            // Ignore update races with dismissal.
          }
          publishScan({ libraryId: job.libraryId, running: true, label, found, scanned });
        },
      },
    );
    await writeFlatCache(ctx, library, songs);
    flatSongs.set(library.id, songs);
    finishTask('completed', `扫描完成，共 ${songs.length} 首`);
    publishScan({ libraryId: job.libraryId, running: false, done: true, count: songs.length });
  } catch (error) {
    const aborted = error instanceof FlatScanAborted || job.aborted || epoch !== scanEpoch;
    if (aborted) {
      // Keep whatever was collected so the list button has something to show.
      const partial = error instanceof FlatScanAborted ? error.partial : [];
      if (partial.length > 0) {
        try {
          await writeFlatCache(ctx, library, partial);
          flatSongs.set(library.id, partial);
        } catch (cacheError) {
          // A failed partial write must not mask the abort itself.
        }
      }
      finishTask(
        'aborted',
        partial.length > 0 ? `扫描已中止，已保留 ${partial.length} 首` : '扫描已中止',
      );
      publishScan({
        libraryId: job.libraryId,
        running: false,
        aborted: true,
        count: partial.length,
      });
    } else {
      const message = error instanceof Error ? error.message : String(error);
      finishTask('error', '扫描失败', message);
      publishScan({ libraryId: job.libraryId, running: false, error: message });
    }
  } finally {
    if (scanJob && scanJob.libraryId === job.libraryId) scanJob = null;
  }
}

function startScanJob(ctx: EchoPluginContext, library: WebdavLibraryConfig): void {
  scanEpoch += 1;
  const epoch = scanEpoch;
  const job: ScanJob = { libraryId: library.id, aborted: false, task: null, inflight: null };
  job.task = ctx.tasks.registerTask('flat-scan', {
    name: `扫描「${library.name}」`,
    status: 'running',
    progress: { done: 0, total: 0, label: '正在连接服务器' },
    retention: {
      completed: { mode: 'auto', delayMs: 5000 },
      error: { mode: 'manual' },
      aborted: { mode: 'auto', delayMs: 3000 },
    },
    actions: [
      {
        id: 'abort',
        label: '停止',
        variant: 'ghost',
        onClick: () => {
          requestScanAbort(job);
        },
      },
    ],
  });
  scanJob = job;
  if (job.task) job.task.start();
  publishScan({
    libraryId: library.id,
    running: true,
    label: '正在连接服务器',
    found: 0,
    scanned: 0,
  });
  void runScanJob(ctx, library, job, epoch);
}

async function flatLoad(args: Record<string, JsonValue>): Promise<JsonValue> {
  const ctx = requireContext();
  const library = libraryFromArgs(args);
  if (!library) return { error: 'no-library', message: '请先在设置中添加 WebDAV 库' };
  if (!library.serverUrl) return { error: 'no-server', message: '该库尚未配置服务器地址' };
  if (!argBoolean(args, 'force')) {
    const memory = flatSongs.get(library.id);
    if (memory) return { ready: true, count: memory.length };
    const cached = await readFlatSongsSafe(ctx, library);
    if (cached) {
      flatSongs.set(library.id, cached);
      return { ready: true, count: cached.length };
    }
  }
  if (scanJob) {
    if (scanJob.libraryId === library.id) return { started: true, already: true };
    return { started: false, busy: true, message: '已有扫描任务正在进行' };
  }
  startScanJob(ctx, library);
  return { started: true };
}

async function flatPage(args: Record<string, JsonValue>): Promise<JsonValue> {
  const ctx = requireContext();
  const library = libraryFromArgs(args);
  if (!library) return { error: 'no-library', message: '请先在设置中添加 WebDAV 库' };
  let songs = flatSongs.get(library.id);
  if (!songs) {
    const cached = await readFlatSongsSafe(ctx, library);
    if (cached) {
      flatSongs.set(library.id, cached);
      songs = cached;
    }
  }
  const offset = Math.max(0, Math.floor(argNumber(args, 'offset', 0)));
  const limit = Math.min(FLAT_PAGE_LIMIT, Math.max(1, Math.floor(argNumber(args, 'limit', 100))));
  if (!songs) return { ready: false, total: 0, offset, limit, songs: [] };
  const keyword = argString(args, 'keyword').trim();
  const filtered = keyword
    ? songs.filter(
        (song) =>
          matchesKeyword(`${song.artist} ${song.title}`, keyword) ||
          matchesKeyword(song.title, keyword),
      )
    : songs;
  const page = filtered.slice(offset, offset + limit);
  return {
    ready: true,
    total: filtered.length,
    offset,
    limit,
    songs: page.map(fileRowFromSong),
  };
}

async function flatInfo(args: Record<string, JsonValue>): Promise<JsonValue> {
  const ctx = requireContext();
  const library = libraryFromArgs(args);
  if (!library) return { count: null, ready: false };
  const memory = flatSongs.get(library.id);
  if (memory) return { count: memory.length, ready: true };
  try {
    const meta = parseFlatMeta(await awaitOperation(ctx.io.readValue(flatMetaKey(library.id))));
    if (meta && metaMatches(meta, library)) return { count: meta.count, ready: false };
  } catch (error) {
    return { count: null, ready: false };
  }
  return { count: null, ready: false };
}

async function flatClear(args: Record<string, JsonValue>): Promise<JsonValue> {
  const ctx = requireContext();
  const library = libraryFromArgs(args);
  if (!library) return { ok: false };
  flatSongs.delete(library.id);
  await clearFlatCache(ctx, library.id);
  return { ok: true };
}

function enrichmentExtras(enrichment: TrackEnrichment): QueueTrackExtras {
  return {
    title: enrichment.title,
    artist: enrichment.artist,
    album: enrichment.album,
    cover: enrichment.cover,
    durationMs: enrichment.durationMs,
  };
}

async function enrichSong(
  ctx: EchoPluginContext,
  library: WebdavLibraryConfig,
  song: SongInit,
): Promise<TrackEnrichment | null> {
  if (!enricher) return null;
  const enrichment = enricher.enrichTrack(endpointOf(library), song, { title: '', artist: '' });
  return raceTimeout(ctx, enrichment, ENRICH_BUDGET_MS);
}

async function appendTracks(tracks: QueueTrack[], placement: 'next' | 'last'): Promise<JsonValue> {
  const ctx = requireContext();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const snapshot = ctx.playlist.snapshot;
    let target: { key: string; title: string } | null = null;
    for (const queue of snapshot) {
      if (queue.active) {
        target = queue;
        break;
      }
    }
    if (!target) {
      await awaitOperation(ctx.playlist.replace('browse', 'WebDAV 音乐', tracks, 0));
      return { ok: true, count: tracks.length, started: true };
    }
    try {
      await awaitOperation(ctx.playlist.append(target.key, tracks, placement));
      return { ok: true, count: tracks.length, queue: target.title };
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
  return { ok: false, message: '队列已变化，请重试' };
}

async function playCommand(args: Record<string, JsonValue>): Promise<JsonValue> {
  const ctx = requireContext();
  const library = libraryFromArgs(args);
  if (!library) return { error: 'no-library', message: '请先在设置中添加 WebDAV 库' };
  if (!library.serverUrl) return { error: 'no-server', message: '该库尚未配置服务器地址' };
  const mode = argString(args, 'mode') || 'now';
  const songs: SongInit[] = [];
  let startIndex = 0;
  let queueTitle = library.name;
  if (argBoolean(args, 'flat')) {
    const loaded = flatSongs.get(library.id) ?? (await readFlatSongsSafe(ctx, library));
    if (!loaded) return { error: 'flat-missing', message: '平铺列表尚未就绪，请先扫描' };
    flatSongs.set(library.id, loaded);
    startIndex = Math.max(0, Math.floor(argNumber(args, 'index', 0)));
    if (startIndex >= loaded.length) return { error: 'empty', message: '歌曲不存在' };
    for (const song of loaded) songs.push(song);
    queueTitle = `${library.name}（平铺）`;
  } else {
    const paths = argStringArray(args, 'paths');
    const directory = argString(args, 'dir');
    if (paths.length > 0) {
      for (const path of paths) {
        songs.push(
          songFromEntry({
            libraryId: library.id,
            path: normalizeDir(path),
            name: baseName(path),
            size: 0,
          }),
        );
      }
      startIndex = Math.max(0, Math.floor(argNumber(args, 'index', 0)));
      if (startIndex >= songs.length) startIndex = 0;
    } else if (directory) {
      const endpoint = endpointOf(library);
      const collected = await collectSongsUnder(
        ctx,
        endpoint,
        library.id,
        normalizeDir(directory),
        {
          cap: DIR_COLLECT_CAP,
        },
      );
      for (const song of collected) songs.push(song);
      startIndex = Math.max(0, Math.floor(argNumber(args, 'index', 0)));
      if (startIndex >= songs.length) startIndex = 0;
      const folder = baseName(directory);
      if (folder) queueTitle = `${library.name} · ${folder}`;
    } else {
      return { error: 'no-target', message: '缺少播放目标' };
    }
  }
  if (songs.length === 0) return { error: 'empty', message: '没有找到音频文件' };
  if (mode === 'now') {
    const firstIndex = Math.min(startIndex, songs.length - 1);
    const tracks = songs.map((song) => buildQueueTrack(song));
    const enrichment = await enrichSong(ctx, library, songs[firstIndex]);
    if (enrichment)
      tracks[firstIndex] = buildQueueTrack(songs[firstIndex], enrichmentExtras(enrichment));
    await awaitOperation(ctx.playlist.replace('browse', queueTitle, tracks, firstIndex));
    return { ok: true, count: tracks.length, index: firstIndex };
  }
  const tracks = songs.map((song) => buildQueueTrack(song));
  if (tracks.length === 1) {
    const enrichment = await enrichSong(ctx, library, songs[0]);
    if (enrichment) tracks[0] = buildQueueTrack(songs[0], enrichmentExtras(enrichment));
  }
  const placement = mode === 'next' ? 'next' : 'last';
  const result = await appendTracks(tracks, placement);
  return result;
}

function settingsGet(): JsonValue {
  return settingsToValue(settings);
}

async function persistSettings(next: WebdavSettings): Promise<void> {
  const ctx = requireContext();
  settings = next;
  flatSongs.clear();
  dirCovers.clear();
  await awaitOperation(ctx.io.writeValue(SETTINGS_KEY, settingsToValue(next)));
  settingsRevision += 1;
  ctx.ui.setState({ settingsRevision, flatScan: lastFlatScan });
}

async function settingsPatch(args: Record<string, JsonValue>): Promise<JsonValue> {
  await persistSettings(normalizeSettings(args));
  return { ok: true };
}

async function settingsReset(): Promise<JsonValue> {
  await persistSettings(normalizeSettings(undefined));
  return { ok: true };
}

function matchWebdavTrack(track: QueueTrack): boolean {
  return typeof track.sourceId === 'string' && track.sourceId.indexOf(SOURCE_ID_PREFIX) === 0;
}

function resolveAudioSource(resolverContext: AudioSourceContext): AudioSourceValue | null {
  const parsed = parseSourceId(resolverContext.track.sourceId ?? '');
  if (!parsed) return null;
  const library = findLibrary(settings, parsed.libraryId);
  if (!library) return null;
  const data = resolverContext.track.data;
  const path = data && typeof data.p === 'string' ? data.p : '';
  if (!path) return null;
  const url = buildAuthUrl(library.serverUrl, library.username, library.password, path);
  if (!url) return null;
  const duration = resolverContext.track.durationMs;
  return {
    url,
    quality: qualityForExtension(extensionOf(path)),
    sourceKind: 'plugin',
    durationMs: typeof duration === 'number' && duration > 0 ? Math.round(duration) : undefined,
  };
}

export async function activate(ctx: EchoPluginContext): Promise<void> {
  context = ctx;
  settings = normalizeSettings((await awaitOperation(ctx.io.readValue(SETTINGS_KEY))) as JsonValue);
  enricher = createEnricher(ctx, { coverLyricSource: () => settings.coverLyricSource });
  const lyricEngine: LyricEngine = createLyricEngine(ctx, endpointForLibrary, {
    coverLyricSource: () => settings.coverLyricSource,
    readTags: (libraryId, endpoint, path) => {
      const instance = enricher;
      return instance ? instance.readTags(libraryId, endpoint, path) : Promise.resolve(null);
    },
  });

  const audio = ctx.player.audioSource.registerResolver('webdav-audio', {
    order: 10,
    position: 'before-catalog',
    match: (resolverContext) => matchWebdavTrack(resolverContext.track),
    resolve: resolveAudioSource,
  });
  if (audio) registrations.push(audio);

  const lyrics = ctx.lyrics.registerResolver('webdav-lyrics', {
    order: 10,
    match: (resolverContext) => matchWebdavTrack(resolverContext.track),
    resolve: (resolverContext) => lyricEngine.resolve(resolverContext),
  });
  if (lyrics) registrations.push(lyrics);

  const page = ctx.ui.registerPage('webdav-browser', 'BrowserPage.qml');
  if (page) registrations.push(page);
  const settingsPage = ctx.ui.registerSettings('Settings.qml');
  if (settingsPage) registrations.push(settingsPage);
  const sidebar = ctx.ui.registerSidebarItem('webdav-browser', {
    title: 'WebDAV 音乐',
    icon: 'cloud',
    pageId: 'webdav-browser',
    section: 'library',
    order: 100,
  });
  if (sidebar) registrations.push(sidebar);

  ctx.registerCommand('settings.get', () => settingsGet());
  ctx.registerCommand('settings.patch', (commandArgs) => settingsPatch(commandArgs));
  ctx.registerCommand('settings.reset', () => settingsReset());
  ctx.registerCommand('browse.load', (commandArgs) => browseLoad(commandArgs));
  ctx.registerCommand('flat.load', (commandArgs) => flatLoad(commandArgs));
  ctx.registerCommand('flat.page', (commandArgs) => flatPage(commandArgs));
  ctx.registerCommand('flat.info', (commandArgs) => flatInfo(commandArgs));
  ctx.registerCommand('flat.clear', (commandArgs) => flatClear(commandArgs));
  ctx.registerCommand('flat.abort', () => {
    if (!scanJob) return { ok: false };
    requestScanAbort(scanJob);
    return { ok: true };
  });
  ctx.registerCommand('play', (commandArgs) => playCommand(commandArgs));

  ctx.ui.setState({ settingsRevision, flatScan: null });
  lastFlatScan = null;
}

export async function deactivate(): Promise<void> {
  scanEpoch += 1;
  if (scanJob) {
    scanJob.aborted = true;
    try {
      scanJob.task?.finish('aborted', { progress: { label: '插件已停用' } });
    } catch (error) {
      // Task already dismissed.
    }
    scanJob = null;
  }
  for (const registration of registrations.splice(0, registrations.length)) {
    try {
      registration.dispose();
    } catch (error) {
      // Registration already drained by the host.
    }
  }
  if (enricher) {
    enricher.dispose();
    enricher = null;
  }
  flatSongs = new Map();
  dirCovers = new Map();
  lastFlatScan = null;
  context = null;
  settings = normalizeSettings(undefined);
}

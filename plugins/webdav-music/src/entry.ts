// Plugin entry: activation, WebDAV audio/lyric resolvers, browse/flat/play
// commands for the QML pages, settings persistence and the scan task.

import { awaitOperation } from 'echo:plugin-sdk';
import type {
  AudioSourceContext,
  AudioSourceValue,
  EchoPluginContext,
  EchoPluginRegistration,
  EchoPluginTask,
  HostPlaybackSettings,
  JsonValue,
  QueueTrack,
} from 'echo:plugin-sdk';
import { cancelOperationAfter, raceTimeout } from './async.ts';
import { asArrayBuffer, bytesToBase64, coerceJsonArray } from './codec.ts';
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
  QUEUE_COVER_LIMIT,
  type QueueTrackExtras,
  type SongInit,
} from './library.ts';
import {
  baseName,
  buildAuthUrl,
  COVER_NAMES,
  endpointOf,
  isRangeUnsupported,
  isResponseTooLarge,
  markRangeUnsupported,
  normalizeDir,
  normalizeServerUrl,
  parsePropfind,
  propfindRequest,
  propfindStatusOk,
  readRangeRequest,
  resetRangeSupportMemo,
  type WebdavEndpoint,
} from './webdav.ts';
import { clearLyricCache, createLyricEngine, clearLyricStore, type LyricEngine } from './lyric.ts';
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
/** Hard ceiling shared with local-music so a runaway walk over a huge
 * server stays bounded; the meta record flags the truncation. */
const FLAT_SONG_CAP = 20000;
/** Coalescing window for scan progress publishes: each publish drives a
 * synchronous page re-render, and hundreds per scan saturate the main
 * thread (visible freeze → scene-graph recursion crash). */
const SCAN_PROGRESS_INTERVAL_MS = 300;
/** The task tray widget is another synchronous scene-graph consumer; its
 * progress only needs to tick about once a second, so it gets its own,
 * wider window on top of the shared flush. */
const TASK_PROGRESS_INTERVAL_MS = 1000;
/** Boot-time settings recovery: 2s then 6s intervals (~26s total window). */
const SETTINGS_RECOVERY_ATTEMPTS = 5;

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
let lyricEngine: LyricEngine | null = null;
let registrations: EchoPluginRegistration[] = [];
let flatSongs = new Map<string, SongInit[]>();
/** Library ids whose cached flat list hit the song cap — the lists are
 * usable but incomplete, and pages surface the fact. */
let truncatedIds = new Set<string>();
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

// ── Persisted per-song enrichment ──────────────────────────────────────────
//
// A song whose metadata was enriched while playing stores the resolved
// record, so the next play answers from the KV store and skips the tag
// range read and Kugou round trip entirely. Entries are keyed by song id —
// the hash of library|path — so a moved or renamed file naturally starts
// fresh; the trade-off (a changed file keeping its stale record) matches
// what local-music accepts for its cover store.

const ENRICH_STORE_PREFIX = 'enrich:';
const ENRICH_INDEX_KEY = 'enrichIndex';
/** KV reads and writes around a play must stay inside a small budget. */
const ENRICH_PERSIST_BUDGET_MS = 800;

// Enrichment store read-modify-write cycles (the index update) must not
// interleave; a chain serializes them like the lyric store's.
let enrichStoreChain: Promise<unknown> = Promise.resolve();

function queueEnrichStoreTask<T>(task: () => Promise<T>): Promise<T> {
  const next = enrichStoreChain.then(task, task);
  enrichStoreChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function enrichStoreKey(songId: string): string {
  return `${ENRICH_STORE_PREFIX}${songId}`;
}

function enrichRecordOf(enrichment: TrackEnrichment): Record<string, JsonValue> {
  return {
    title: enrichment.title,
    artist: enrichment.artist,
    album: enrichment.album,
    cover: enrichment.cover,
    durationMs: enrichment.durationMs,
  };
}

function parseEnrichRecord(value: JsonValue | undefined): TrackEnrichment | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as { [key: string]: JsonValue };
  const text = (key: string): string => (typeof record[key] === 'string' ? record[key] : '');
  const cover = text('cover');
  const title = text('title');
  // Only trust entries that actually resolved something; an all-empty
  // record would pin a failed enrichment for the song's lifetime.
  if (!cover && !title) return null;
  const durationMs = record.durationMs;
  return {
    title,
    artist: text('artist'),
    album: text('album'),
    cover,
    durationMs:
      typeof durationMs === 'number' && isFinite(durationMs) && durationMs > 0 ? durationMs : 0,
  };
}

async function readPersistedEnrichment(
  ctx: EchoPluginContext,
  songId: string,
): Promise<TrackEnrichment | null> {
  if (!songId) return null;
  try {
    const value = (await raceTimeout(
      ctx,
      awaitOperation(ctx.io.readValue(enrichStoreKey(songId))),
      ENRICH_PERSIST_BUDGET_MS,
    )) as JsonValue;
    return parseEnrichRecord(value);
  } catch (error) {
    return null;
  }
}

/** Fire-and-forget persistence for play-time enrichments. */
function queuePersistEnrichment(
  ctx: EchoPluginContext,
  songId: string,
  enrichment: TrackEnrichment,
): void {
  if (!songId) return;
  queueEnrichStoreTask(async () => {
    // The plugin may have deactivated while the enrichment was in flight;
    // writing through the drained context would only resurrect state the
    // host already considers gone.
    if (context !== ctx) return;
    await awaitOperation(ctx.io.writeValue(enrichStoreKey(songId), enrichRecordOf(enrichment)));
    const indexValue = (await awaitOperation(ctx.io.readValue(ENRICH_INDEX_KEY))) as JsonValue;
    const index: string[] = [];
    const seen: { [songId: string]: boolean } = {};
    for (const item of coerceJsonArray(indexValue)) {
      if (typeof item === 'string' && item && !seen[item]) {
        seen[item] = true;
        index.push(item);
      }
    }
    if (!seen[songId]) index.push(songId);
    await awaitOperation(ctx.io.writeValue(ENRICH_INDEX_KEY, index));
  }).catch(() => undefined);
}

/** Removes every stored enrichment record; returns how many were dropped. */
async function clearEnrichStore(ctx: EchoPluginContext): Promise<number> {
  return queueEnrichStoreTask(async () => {
    let count = 0;
    try {
      const indexValue = (await awaitOperation(ctx.io.readValue(ENRICH_INDEX_KEY))) as JsonValue;
      for (const item of coerceJsonArray(indexValue)) {
        if (typeof item !== 'string' || !item) continue;
        try {
          await awaitOperation(ctx.io.removeValue(enrichStoreKey(item)));
          count += 1;
        } catch (error) {
          // Best-effort.
        }
      }
      await awaitOperation(ctx.io.removeValue(ENRICH_INDEX_KEY));
    } catch (error) {
      // No index: nothing persisted.
    }
    return count;
  });
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
  // A Range-ignoring server turns every cover probe into a full-file
  // download that the host then aborts; skip the probes entirely.
  if (isRangeUnsupported(endpoint.serverUrl)) return '';
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
      // A whole-file body means the server ignored the Range header —
      // remember it so tag/lyric reads stop paying full transfers too.
      if (isResponseTooLarge(error)) markRangeUnsupported(endpoint.serverUrl);
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
): Promise<{ songs: SongInit[]; truncated: boolean } | null> {
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
  // Progress publishes are coalesced: each ui.setState drives a synchronous
  // page re-render, and a per-directory publish on a large library holds the
  // main thread until the scene graph starves (see the interval constants).
  let pendingProgress: Record<string, JsonValue> | null = null;
  let pendingTaskProgress: { done: number; total: number; label: string } | null = null;
  let lastProgressFlush = 0;
  let lastTaskProgress = 0;
  let progressFlushTimer: { dispose(): void } | null = null;
  const flushProgress = (): void => {
    if (progressFlushTimer) {
      try {
        progressFlushTimer.dispose();
      } catch (timerError) {
        // Timer registration may already be gone during deactivation.
      }
      progressFlushTimer = null;
    }
    const values = pendingProgress;
    const task = pendingTaskProgress;
    pendingProgress = null;
    pendingTaskProgress = null;
    if (!values) return;
    const now = Date.now();
    lastProgressFlush = now;
    if (task && now - lastTaskProgress >= TASK_PROGRESS_INTERVAL_MS) {
      lastTaskProgress = now;
      try {
        job.task?.update({ progress: task });
      } catch (taskError) {
        // Ignore update races with dismissal.
      }
    }
    publishScan(values);
  };
  const reportProgress = (
    values: Record<string, JsonValue>,
    task?: { done: number; total: number; label: string },
  ): void => {
    pendingProgress = { ...(pendingProgress ?? {}), ...values };
    if (task) pendingTaskProgress = task;
    const now = Date.now();
    if (now - lastProgressFlush >= SCAN_PROGRESS_INTERVAL_MS) {
      flushProgress();
      return;
    }
    if (!progressFlushTimer) {
      progressFlushTimer = ctx.setTimer(
        'webdav-scan-progress-flush',
        Math.max(1, SCAN_PROGRESS_INTERVAL_MS - (now - lastProgressFlush)),
        false,
        flushProgress,
      );
    }
  };
  let truncated = false;
  let skippedDirs = 0;
  try {
    const songs = await collectSongsUnder(
      ctx,
      endpointOf(library),
      library.id,
      endpointOf(library).rootPath,
      {
        cap: FLAT_SONG_CAP,
        shouldAbort: () => job.aborted || epoch !== scanEpoch,
        onOperation: (operation) => {
          job.inflight = operation;
        },
        onTruncated: () => {
          truncated = true;
        },
        onDirectorySkipped: () => {
          skippedDirs += 1;
        },
        onProgress: (found, scanned) => {
          if (job.aborted || epoch !== scanEpoch) return;
          const skippedNote = skippedDirs > 0 ? `，跳过 ${skippedDirs} 个目录` : '';
          const label = `已扫描 ${scanned} 个目录，找到 ${found} 首${skippedNote}`;
          reportProgress(
            { libraryId: job.libraryId, running: true, label, found, scanned },
            { done: scanned, total: 0, label },
          );
        },
      },
    );
    // Every directory unreadable and nothing found is a connection/auth
    // problem, not an empty library — report it as a failure.
    if (songs.length === 0 && skippedDirs > 0) {
      throw new Error(`无法读取服务器目录（${skippedDirs} 个目录失败），请检查地址、账号或权限`);
    }
    // A failed cache write must not fail the scan itself: the in-memory list
    // stays valid for this session and the next scan retries the write.
    try {
      await writeFlatCache(ctx, library, songs, truncated);
    } catch (cacheError) {
      // Best-effort persistence.
    }
    flatSongs.set(library.id, songs);
    if (truncated) truncatedIds.add(library.id);
    else truncatedIds.delete(library.id);
    flushProgress();
    const skippedNote = skippedDirs > 0 ? `，${skippedDirs} 个目录无法读取` : '';
    finishTask('completed', `扫描完成，共 ${songs.length} 首${skippedNote}`);
    publishScan({
      libraryId: job.libraryId,
      running: false,
      done: true,
      count: songs.length,
      truncated,
    });
  } catch (error) {
    const aborted = error instanceof FlatScanAborted || job.aborted || epoch !== scanEpoch;
    if (aborted) {
      // Keep whatever was collected so the list button has something to show.
      const partial = error instanceof FlatScanAborted ? error.partial : [];
      if (partial.length > 0) {
        try {
          await writeFlatCache(ctx, library, partial, truncated);
          flatSongs.set(library.id, partial);
        } catch (cacheError) {
          // A failed partial write must not mask the abort itself.
        }
      }
      finishTask(
        'aborted',
        partial.length > 0 ? `扫描已中止，已保留 ${partial.length} 首` : '扫描已中止',
      );
      flushProgress();
      publishScan({
        libraryId: job.libraryId,
        running: false,
        aborted: true,
        count: partial.length,
        truncated,
      });
    } else {
      const message = error instanceof Error ? error.message : String(error);
      finishTask('error', '扫描失败', message);
      flushProgress();
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
  truncatedIds.delete(library.id);
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
    if (memory)
      return { ready: true, count: memory.length, truncated: truncatedIds.has(library.id) };
    const cached = await readFlatSongsSafe(ctx, library);
    if (cached) {
      flatSongs.set(library.id, cached.songs);
      if (cached.truncated) truncatedIds.add(library.id);
      else truncatedIds.delete(library.id);
      return { ready: true, count: cached.songs.length, truncated: cached.truncated };
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
      flatSongs.set(library.id, cached.songs);
      if (cached.truncated) truncatedIds.add(library.id);
      else truncatedIds.delete(library.id);
      songs = cached.songs;
    }
  }
  const offset = Math.max(0, Math.floor(argNumber(args, 'offset', 0)));
  const limit = Math.min(FLAT_PAGE_LIMIT, Math.max(1, Math.floor(argNumber(args, 'limit', 100))));
  if (!songs)
    return {
      ready: false,
      total: 0,
      offset,
      limit,
      songs: [],
      truncated: truncatedIds.has(library.id),
    };
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
    truncated: truncatedIds.has(library.id),
    songs: page.map(fileRowFromSong),
  };
}

async function flatInfo(args: Record<string, JsonValue>): Promise<JsonValue> {
  const ctx = requireContext();
  const library = libraryFromArgs(args);
  if (!library) return { count: null, ready: false, truncated: false };
  const memory = flatSongs.get(library.id);
  if (memory) return { count: memory.length, ready: true, truncated: truncatedIds.has(library.id) };
  try {
    const meta = parseFlatMeta(await awaitOperation(ctx.io.readValue(flatMetaKey(library.id))));
    if (meta && metaMatches(meta, library))
      return { count: meta.count, ready: false, truncated: meta.truncated };
  } catch (error) {
    return { count: null, ready: false, truncated: false };
  }
  return { count: null, ready: false, truncated: false };
}

async function flatClear(args: Record<string, JsonValue>): Promise<JsonValue> {
  const ctx = requireContext();
  // Without an explicit libraryId this is the settings-page 缓存清理: drop
  // every persisted cache (scan chunks, enrichment records, online lyrics).
  const requested = argString(args, 'libraryId');
  const flatIds = requested ? [requested] : settings.libraries.map((library) => library.id);
  flatSongs.clear();
  truncatedIds.clear();
  dirCovers.clear();
  let flats = 0;
  for (const libraryId of flatIds) {
    try {
      await clearFlatCache(ctx, libraryId);
      flats += 1;
    } catch (error) {
      // Best-effort.
    }
  }
  const enrichments = await clearEnrichStore(ctx);
  const lyrics = await clearLyricStore(ctx);
  clearLyricCache();
  return { ok: true, flats, enrichments, lyrics };
}

/** Index of one song inside the flat list, so the page can locate a playing
 * row that pagination has not loaded. */
async function flatLocate(args: Record<string, JsonValue>): Promise<JsonValue> {
  const library = libraryFromArgs(args);
  if (!library) return { ready: false, index: -1, total: 0 };
  const songs = flatSongs.get(library.id);
  if (!songs) return { ready: true, index: -1, total: 0 };
  const id = argString(args, 'id');
  let index = -1;
  for (let i = 0; i < songs.length; i += 1) {
    if (songs[i].id === id) {
      index = i;
      break;
    }
  }
  return { ready: true, index, total: songs.length };
}

function enrichmentExtras(enrichment: TrackEnrichment): QueueTrackExtras {
  // The host queue validator caps a track's cover string (QUEUE_COVER_LIMIT)
  // and stays silent beyond it, taking the whole replace call down with it —
  // oversized embedded art is withheld instead of submitted.
  const cover =
    enrichment.cover && enrichment.cover.length <= QUEUE_COVER_LIMIT ? enrichment.cover : '';
  return {
    title: enrichment.title,
    artist: enrichment.artist,
    album: enrichment.album,
    cover,
    durationMs: enrichment.durationMs,
  };
}

async function enrichSong(
  ctx: EchoPluginContext,
  library: WebdavLibraryConfig,
  song: SongInit,
): Promise<TrackEnrichment | null> {
  const instance = enricher;
  if (!instance) return null;
  // A previous play already resolved this song: answer from the store and
  // skip the tag range read plus the Kugou round trip entirely.
  const persisted = await readPersistedEnrichment(ctx, song.id);
  if (persisted) return persisted;
  const enrichment = await raceTimeout(
    ctx,
    instance.enrichTrack(endpointOf(library), song, { title: '', artist: '' }),
    ENRICH_BUDGET_MS,
  );
  // The enricher was disposed (deactivate) while this was in flight: drop
  // the result instead of persisting into the cleared session.
  if (enricher !== instance) return null;
  if (enrichment) queuePersistEnrichment(ctx, song.id, enrichment);
  return enrichment;
}

/** The host's 播放队列模式 drives double-click semantics, mirroring the
 * legacy plugin: context mode replaces the queue with the whole view and
 * locates the song, single mode plays just that track. The read is bounded
 * so a wedged settings service cannot delay playback. */
async function hostQueueMode(ctx: EchoPluginContext): Promise<'context' | 'single'> {
  try {
    const playback = (await raceTimeout(
      ctx,
      awaitOperation(ctx.settings.read('playback')),
      800,
    )) as Readonly<HostPlaybackSettings> | null;
    return playback && playback.queueMode === 'single' ? 'single' : 'context';
  } catch (error) {
    return 'context';
  }
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
  let album = '';
  if (argBoolean(args, 'flat')) {
    const memory = flatSongs.get(library.id);
    const loaded = memory ?? (await readFlatSongsSafe(ctx, library))?.songs ?? null;
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
      if (folder) {
        queueTitle = `${library.name} · ${folder}`;
        // The folder name doubles as the album, mirroring the legacy plugin.
        album = folder;
      }
    } else {
      return { error: 'no-target', message: '缺少播放目标' };
    }
  }
  if (songs.length === 0) return { error: 'empty', message: '没有找到音频文件' };
  const extrasFor = (enrichment: TrackEnrichment | null): QueueTrackExtras | null => {
    const extras = enrichment ? enrichmentExtras(enrichment) : null;
    if (album && (!extras || !extras.album)) {
      return { ...(extras ?? {}), album };
    }
    return extras;
  };
  if (mode === 'now') {
    const firstIndex = Math.min(startIndex, songs.length - 1);
    // Host 播放队列模式: context replaces the queue with the whole view and
    // locates the song; single plays just that track. 播放全部 always plays
    // the whole view, in both modes (legacy semantics).
    const single = !argBoolean(args, 'all') && (await hostQueueMode(ctx)) === 'single';
    const chosen = single ? [songs[firstIndex]] : songs;
    const chosenIndex = single ? 0 : firstIndex;
    const tracks = chosen.map((song) => buildQueueTrack(song, album ? { album } : null));
    const enrichment = await enrichSong(ctx, library, songs[firstIndex]);
    const extras = extrasFor(enrichment);
    if (extras) tracks[chosenIndex] = buildQueueTrack(songs[firstIndex], extras);
    await awaitOperation(ctx.playlist.replace('browse', queueTitle, tracks, chosenIndex));
    return { ok: true, count: tracks.length, index: chosenIndex };
  }
  const tracks = songs.map((song) => buildQueueTrack(song, album ? { album } : null));
  if (tracks.length === 1) {
    const enrichment = await enrichSong(ctx, library, songs[0]);
    const extras = extrasFor(enrichment);
    if (extras) tracks[0] = buildQueueTrack(songs[0], extras);
  }
  const placement = mode === 'next' ? 'next' : 'last';
  const result = await appendTracks(tracks, placement);
  return result;
}

/**
 * The first storage read of an activation can transiently come back empty —
 * the same host window where local-music's grant ledger reads empty. When it
 * does, the library list stays invisible until the user re-adds everything.
 * Re-read storage whenever the library list is empty and adopt a recovered
 * settings record.
 */
async function ensureStorage(ctx: EchoPluginContext): Promise<void> {
  if (settings.libraries.length > 0) return;
  let fresh: WebdavSettings;
  try {
    fresh = normalizeSettings((await awaitOperation(ctx.io.readValue(SETTINGS_KEY))) as JsonValue);
  } catch (error) {
    // Storage may not be ready yet; the next command retries.
    return;
  }
  if (fresh.libraries.length === 0) return;
  settings = fresh;
  settingsRevision += 1;
  ctx.ui.setState({ settingsRevision, flatScan: lastFlatScan });
}

async function settingsGet(): Promise<JsonValue> {
  const ctx = requireContext();
  await ensureStorage(ctx);
  return settingsToValue(settings);
}

/** Identity of the library set the in-memory caches depend on: id plus the
 * coordinates the flat cache validates against. */
function cacheSignature(value: WebdavSettings): string {
  return value.libraries
    .map(
      (library) =>
        `${library.id}|${normalizeServerUrl(library.serverUrl)}|${normalizeDir(
          library.rootPath || '/',
        )}`,
    )
    .sort()
    .join('\n');
}

/** Drops the persisted caches of libraries that disappeared, so a removed
 * or reset library does not leave orphaned scan chunks behind. */
async function purgeRemovedLibraries(
  ctx: EchoPluginContext,
  previous: WebdavSettings,
  next: WebdavSettings,
): Promise<void> {
  const kept = new Set(next.libraries.map((library) => library.id));
  for (const library of previous.libraries) {
    if (kept.has(library.id)) continue;
    flatSongs.delete(library.id);
    truncatedIds.delete(library.id);
    try {
      await clearFlatCache(ctx, library.id);
    } catch (error) {
      // Best-effort.
    }
  }
  if (next.libraries.length === 0 && previous.libraries.length > 0) {
    // Full reset: no library can address the persisted enrichment records or
    // online lyrics anymore, so drop them instead of leaving orphans.
    await clearEnrichStore(ctx);
    await clearLyricStore(ctx);
    clearLyricCache();
  }
}

async function persistSettings(next: WebdavSettings, previous: WebdavSettings): Promise<void> {
  const ctx = requireContext();
  await awaitOperation(ctx.io.writeValue(SETTINGS_KEY, settingsToValue(next)));
  // Only commit to memory after the write succeeded: a failed persist must
  // not leave disk and memory disagreeing about the library list.
  settings = next;
  settingsRevision += 1;
  if (cacheSignature(previous) !== cacheSignature(next)) {
    flatSongs.clear();
    dirCovers.clear();
    truncatedIds.clear();
  }
  await purgeRemovedLibraries(ctx, previous, next);
  ctx.ui.setState({ settingsRevision, flatScan: lastFlatScan });
}

async function settingsPatch(args: Record<string, JsonValue>): Promise<JsonValue> {
  const previous = settings;
  // A malformed or unloaded draft must never wipe the library list: the
  // libraries block is applied only when it arrives as a real array. A page
  // whose settings.get failed sends no libraries at all — that patch keeps
  // the stored list instead of writing an empty one.
  const hasLibraries = !!args && Array.isArray(args.libraries);
  if (!hasLibraries) {
    const merged: WebdavSettings = { ...settings };
    if (args && typeof args.coverLyricSource === 'string') {
      merged.coverLyricSource = args.coverLyricSource === 'kugou' ? 'kugou' : 'embedded';
    }
    await persistSettings(merged, previous);
    return { ok: true, libraries: merged.libraries.length };
  }
  const next = normalizeSettings(args);
  await persistSettings(next, previous);
  return { ok: true, libraries: next.libraries.length };
}

async function settingsReset(): Promise<JsonValue> {
  const previous = settings;
  await persistSettings(normalizeSettings(undefined), previous);
  return { ok: true };
}

function matchWebdavTrack(track: QueueTrack): boolean {
  if (typeof track.sourceId !== 'string') return false;
  // Accept both the persisted form (`webdav:<library>:<song>`) and the
  // host-rewritten form with a plugin namespace prefix prepended by the
  // queue ingestion (`EchoPluginPlaylist::parse`).
  return /^([^/:]+\/)?webdav:/.test(track.sourceId);
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
  // The io service can transiently serve an activation read as failed or
  // empty; setting stays recoverable through ensureStorage below and in
  // settingsGet.
  let rawSettings: JsonValue | undefined;
  try {
    rawSettings = (await awaitOperation(ctx.io.readValue(SETTINGS_KEY))) as JsonValue;
  } catch (readError) {
    // A failed activation read behaves like empty storage below; the
    // timer retries shortly after boot.
  }
  settings = normalizeSettings(rawSettings);
  enricher = createEnricher(ctx, { coverLyricSource: () => settings.coverLyricSource });
  lyricEngine = createLyricEngine(ctx, endpointForLibrary, {
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
    resolve: (resolverContext) =>
      lyricEngine ? lyricEngine.resolve(resolverContext) : Promise.resolve(null),
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
  ctx.registerCommand('flat.locate', (commandArgs) => flatLocate(commandArgs));
  ctx.registerCommand('flat.abort', () => {
    if (!scanJob) return { ok: false };
    requestScanAbort(scanJob);
    return { ok: true };
  });
  ctx.registerCommand('play', (commandArgs) => playCommand(commandArgs));

  ctx.ui.setState({ settingsRevision, flatScan: null });
  lastFlatScan = null;
  // Belt and braces: if the activation read came back empty while libraries
  // are configured on disk, re-check shortly after boot so the sidebar and
  // the browser page show the recovered state without any interaction. The
  // chain is capped: an empty-but-valid store (fresh install) must not leave
  // the plugin polling io forever.
  if (settings.libraries.length === 0) {
    const recover = (delayMs: number, attempt: number): void => {
      if (attempt > SETTINGS_RECOVERY_ATTEMPTS) return;
      ctx.setTimer(`webdav-settings-recheck-${attempt}`, delayMs, false, () => {
        void (async () => {
          const active = context;
          if (!active) return;
          try {
            if (settings.libraries.length > 0) return;
            await ensureStorage(active);
            if (settings.libraries.length === 0) recover(6000, attempt + 1);
          } catch (error) {
            // Commands needing storage re-check before answering anyway.
          }
        })();
      });
    };
    recover(2000, 1);
  }
}

export async function deactivate(): Promise<void> {
  scanEpoch += 1;
  if (scanJob) {
    // requestScanAbort also cancels the in-flight request; leaving it
    // running would keep a host operation alive past deactivation.
    requestScanAbort(scanJob);
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
  lyricEngine = null;
  clearLyricCache();
  // The Range-support memo is session state like the caches above; a fresh
  // activation re-probes servers instead of trusting the old verdict.
  resetRangeSupportMemo();
  flatSongs = new Map();
  truncatedIds = new Set();
  dirCovers = new Map();
  lastFlatScan = null;
  context = null;
  settings = normalizeSettings(undefined);
}

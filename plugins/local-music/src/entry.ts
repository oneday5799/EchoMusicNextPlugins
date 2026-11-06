// Plugin entry: activation, the local audio/lyric resolvers, folder
// management, scan/enrich orchestration and the commands behind the QML
// pages. Playback hands the host a loopback URL from ctx.files.openMedia,
// so no file:// address ever leaks into the queue.

import { awaitOperation } from 'echo:plugin-sdk';
import type {
  AudioSourceContext,
  AudioSourceValue,
  EchoPluginContext,
  EchoPluginMediaLease,
  EchoPluginRegistration,
  EchoPluginTask,
  FileGrant,
  FileReference,
  JsonValue,
  QueueTrack,
} from 'echo:plugin-sdk';
import { raceTimeout } from './async.ts';
import { coerceJsonArray } from './codec.ts';
import { findFolder, normalizeSettings, SETTINGS_KEY, type LocalSettings } from './config.ts';
import {
  cleanupCovers,
  createTagReader,
  enrichCovers,
  enrichMetadata,
  readCover,
  writeCover,
  COVER_STORE_LIMIT,
  type CoverJob,
  type TagReader,
} from './enrich.ts';
import { coverDataUrl } from './tags.ts';
import {
  albumKeyOf,
  baseName,
  buildQueueTrack,
  dirNameOf,
  extensionOf,
  filterSongs,
  groupAlbums,
  lyricKeyOf,
  normalizeSortDescending,
  normalizeSortKey,
  parseSourceId,
  qualityForExtension,
  SOURCE_ID_PREFIX,
  sortSongs,
  type SongInit,
  type SongSortKey,
} from './library.ts';
import { createLyricEngine, clearLyricCache, type LyricEngine } from './lyric.ts';
import {
  collectLibrary,
  LibraryScanAborted,
  libraryMetaKey,
  metaMatches,
  parseCacheMeta,
  readLibraryCache,
  writeLibraryCache,
  type ScanCollected,
  type ScanFolder,
} from './scan.ts';

const COVER_BUDGET_MS = 1600;
/** A single KV cover lookup must never stall a browse command: the io
 * service can leave an operation unsettled, so each lookup races a small
 * budget and falls back to no cover. */
const COVER_LOOKUP_BUDGET_MS = 1200;
const PAGE_LIMIT_MAX = 500;
const ALBUM_PAGE_LIMIT_MAX = 120;
const QUEUE_KEY = 'library';
const QUEUE_TITLE = '本地音乐';

interface SongRowJson extends Record<string, JsonValue> {
  id: string;
  sourceId: string;
  path: string;
  folderId: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  size: number;
  ext: string;
  quality: string;
}

interface AlbumRowJson extends Record<string, JsonValue> {
  name: string;
  count: number;
  cover: string;
}

interface ScanJob {
  epoch: number;
  aborted: boolean;
  task: EchoPluginTask | null;
  /** The listing/metadata operation currently on the wire. */
  inflight: { cancel(): void } | null;
}

let context: EchoPluginContext | null = null;
let settings: LocalSettings = normalizeSettings(undefined);
let tagReader: TagReader | null = null;
let lyricEngine: LyricEngine | null = null;
let registrations: EchoPluginRegistration[] = [];
/** grantId → current FileReference, refreshed on activation and on failure. */
let grantRefs = new Map<string, FileReference>();
let grantPaths = new Map<string, string>();
/** normalized display path → grant id, for re-claiming re-issued grants. */
let grantPathsIndex = new Map<string, string>();
let librarySongs: SongInit[] = [];
let libraryById = new Map<string, SongInit>();
let libraryReady = false;
let cacheTruncated = false;
/** `folderId|dir` → folder cover path, from the last scan. */
let dirCovers = new Map<string, string>();
let scanJob: ScanJob | null = null;
let scanEpoch = 0;
let settingsRevision = 0;
let libraryRevision = 0;
/** Last value published under scan; setState replaces the whole state, so
 * every publish must carry all keys. */
let lastScanState: JsonValue = null;

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

function argStringArray(args: Record<string, JsonValue>, key: string): string[] {
  const value = args ? args[key] : undefined;
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item) items.push(item);
  }
  return items;
}

function folderIdsOf(value: LocalSettings): string[] {
  return value.folders.map((folder) => folder.id);
}

function normalizeDisplayPath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/[\\/]+$/, '')
    .toLowerCase();
}

function displayPathOf(folderId: string): string {
  const display = grantPaths.get(folderId);
  if (display) return display;
  const folder = findFolder(settings, folderId);
  return folder ? folder.path || folder.name || folderId : '';
}

function folderLabel(folderId: string): string {
  const folder = findFolder(settings, folderId);
  if (folder && folder.name) return folder.name;
  const display = grantPaths.get(folderId) || folder?.path || '';
  if (display) return baseName(display) || display;
  return folderId;
}

function usableFolders(): ScanFolder[] {
  const folders: ScanFolder[] = [];
  for (const folder of settings.folders) {
    const root = grantRefs.get(folder.id);
    if (root) folders.push({ folderId: folder.id, root });
  }
  return folders;
}

async function refreshGrants(ctx: EchoPluginContext): Promise<void> {
  const refs = new Map<string, FileReference>();
  const paths = new Map<string, string>();
  const pathIndex = new Map<string, string>();
  try {
    const grants = await awaitOperation(ctx.files.listGrants());
    for (const grant of grants ?? []) {
      const record: FileGrant = grant;
      if (record.revoked || !record.file) continue;
      const display = record.displayPath || record.name || '';
      if (display) pathIndex.set(normalizeDisplayPath(display), record.id);
      if (!record.available) continue;
      refs.set(record.id, record.file);
      paths.set(record.id, display);
    }
  } catch (error) {
    // Grants stay empty; commands report unavailable folders.
  }
  grantRefs = refs;
  grantPaths = paths;
  grantPathsIndex = pathIndex;
}

/**
 * Re-links settings folders whose grant disappeared but whose directory is
 * granted again under a new id (the host ledger drops grants that belong to
 * an installation that no longer exists, e.g. after uninstall/reinstall).
 * Adopting the new grant id keeps the user's folder list intact instead of
 * quietly dying as "unavailable".
 */
async function reconcileFolders(ctx: EchoPluginContext): Promise<void> {
  let changed = false;
  const superseded: string[] = [];
  const folders = settings.folders.map((folder) => {
    if (grantRefs.has(folder.id) || !folder.path) return folder;
    const reclaimed = grantPathsIndex.get(normalizeDisplayPath(folder.path));
    if (!reclaimed || reclaimed === folder.id) return folder;
    changed = true;
    superseded.push(folder.id);
    return { ...folder, id: reclaimed };
  });
  if (!changed) return;
  settings = { ...settings, folders };
  try {
    await awaitOperation(ctx.io.writeValue(SETTINGS_KEY, settingsToValue(settings)));
    settingsRevision += 1;
    publishState();
  } catch (error) {
    // The re-claim still works for this session even if the persist failed.
  }
  // Retire the superseded grants so the ledger does not accumulate one entry
  // per re-claim; the host keeps revoked rows but stops listing them.
  for (const id of superseded) {
    try {
      await awaitOperation(ctx.files.revoke(id));
    } catch (error) {
      // The grant may already be gone.
    }
  }
}

function refFor(folderId: string): FileReference | null {
  return grantRefs.get(folderId) ?? null;
}

function fileRefFor(folderId: string, path: string): FileReference | null {
  const root = grantRefs.get(folderId);
  return root ? { ...root, path } : null;
}

// ── Library state ──────────────────────────────────────────────────────────

function indexLibrary(songs: SongInit[]): void {
  librarySongs = songs;
  const byId = new Map<string, SongInit>();
  for (const song of songs) byId.set(song.id, song);
  libraryById = byId;
  viewCacheKey = '';
  viewCacheSongs = [];
}

/** Cached (filter, sort) view so pagination does not re-sort the library on
 * every page request; invalidated whenever the song index is rebuilt. */
let viewCacheKey = '';
let viewCacheSongs: SongInit[] = [];

function publishState(): void {
  const ctx = context;
  if (!ctx) return;
  try {
    ctx.ui.setState({ settingsRevision, scan: lastScanState, libraryRevision });
  } catch (error) {
    // UI may already be draining during deactivation.
  }
}

function publishScan(values: Record<string, JsonValue>): void {
  lastScanState = values;
  publishState();
}

function notifyLibraryChanged(): void {
  libraryRevision += 1;
  publishState();
}

function songRow(song: SongInit): SongRowJson {
  const extension = extensionOf(song.path);
  return {
    id: song.id,
    sourceId: song.sourceId,
    path: song.path,
    folderId: song.folderId,
    title: song.title,
    artist: song.artist,
    album: albumKeyOf(song),
    durationMs: Math.round(song.durationMs),
    size: song.size,
    ext: extension,
    quality: qualityForExtension(extension),
  };
}

function albumRow(name: string, count: number, cover: string): AlbumRowJson {
  return { name, count, cover };
}

function parsePageArgs(
  args: Record<string, JsonValue>,
  limitMax: number,
): {
  offset: number;
  limit: number;
} {
  return {
    offset: Math.max(0, Math.floor(argNumber(args, 'offset', 0))),
    limit: Math.min(limitMax, Math.max(1, Math.floor(argNumber(args, 'limit', 100)))),
  };
}

/**
 * Grants can transiently read as empty around plugin updates (the host
 * reloads its file service while the new activation starts). Whenever a
 * command needs grants, finds folders in settings but an empty grant table,
 * refresh once and re-claim by path before answering.
 */
async function ensureGrants(ctx: EchoPluginContext): Promise<void> {
  if (settings.folders.length === 0 || grantRefs.size > 0) return;
  await refreshGrants(ctx);
  await reconcileFolders(ctx);
}

/**
 * The first storage read of an activation can transiently come back empty —
 * the same host window where the grant ledger reads empty (see ensureGrants).
 * When it does, the folder list and the library cache both stay invisible
 * until the user re-adds everything. Re-read storage whenever the folder
 * list is empty, adopt the recovered settings, re-claim folders and warm
 * start the cache.
 */
async function ensureStorage(ctx: EchoPluginContext): Promise<void> {
  if (settings.folders.length > 0) return;
  let fresh: LocalSettings;
  try {
    fresh = normalizeSettings((await awaitOperation(ctx.io.readValue(SETTINGS_KEY))) as JsonValue);
  } catch (error) {
    // Storage may not be ready yet; the next command retries.
    return;
  }
  if (fresh.folders.length === 0) return;
  settings = fresh;
  settingsRevision += 1;
  await refreshGrants(ctx);
  await reconcileFolders(ctx);
  await warmStart(ctx);
  // The library may have been restored from cache: revisions tell live
  // pages to re-query even though they rendered before the recovery.
  notifyLibraryChanged();
}

async function settingsGet(): Promise<JsonValue> {
  const ctx = requireContext();
  await ensureStorage(ctx);
  await ensureGrants(ctx);
  return {
    folders: settings.folders.map((folder) => ({
      id: folder.id,
      name: folder.name,
      path: displayPathOf(folder.id),
      available: grantRefs.has(folder.id),
    })),
    readEmbedded: settings.readEmbedded,
    onlineFetch: settings.onlineFetch,
  };
}

async function libraryInfo(): Promise<JsonValue> {
  const ctx = requireContext();
  await ensureStorage(ctx);
  await ensureGrants(ctx);
  let stale = true;
  try {
    const meta = parseCacheMeta(await awaitOperation(ctx.io.readValue(libraryMetaKey())));
    stale = !metaMatches(meta, folderIdsOf(settings));
  } catch (error) {
    stale = true;
  }
  return {
    ready: libraryReady,
    count: librarySongs.length,
    albums: groupAlbums(librarySongs).length,
    truncated: cacheTruncated,
    stale,
    scanning: !!scanJob,
    folders: settings.folders.length,
    available: usableFolders().length,
  };
}

// ── Scan orchestration ─────────────────────────────────────────────────────

function requestScanAbort(job: ScanJob): void {
  job.aborted = true;
  if (job.inflight) {
    try {
      job.inflight.cancel();
    } catch (error) {
      // The operation may already have settled.
    }
    job.inflight = null;
  }
}

/** Adopts scan results into the library: drops songs of folders removed
 * mid-scan, pairs sidecar lyrics and stores the folder-cover map. */
function applyCollected(collected: ScanCollected): void {
  const valid = new Set(folderIdsOf(settings));
  const songs = collected.songs.filter((song) => valid.has(song.folderId));
  for (const song of songs) {
    const lyricPath = collected.lyricPaths.get(lyricKeyOf(song.path));
    if (lyricPath) song.lyricPath = lyricPath;
  }
  indexLibrary(songs);
  dirCovers = collected.dirCovers;
}

function representativeCoverJobs(): CoverJob[] {
  const jobs: CoverJob[] = [];
  for (const album of groupAlbums(librarySongs)) {
    const song = libraryById.get(album.representativeId);
    if (!song) continue;
    const folderCover = dirCovers.get(`${song.folderId}|${dirNameOf(song.path)}`) ?? '';
    jobs.push({ song, folderCover });
  }
  return jobs;
}

async function persistLibraryCache(ctx: EchoPluginContext, truncated: boolean): Promise<void> {
  try {
    await writeLibraryCache(ctx, folderIdsOf(settings), librarySongs, truncated);
  } catch (error) {
    // A failed cache write must not fail the scan itself.
  }
}

async function runScanJob(ctx: EchoPluginContext, job: ScanJob, epoch: number): Promise<void> {
  const abortedNow = () => job.aborted || epoch !== scanEpoch;
  const finishTask = (status: 'completed' | 'error' | 'aborted', label: string, error?: string) => {
    try {
      job.task?.finish(status, { progress: { done: 1, total: 1, label }, error });
    } catch (taskError) {
      // Task handle already gone.
    }
  };
  let indexed = false;
  try {
    let folders = usableFolders();
    if (folders.length === 0 && settings.folders.length > 0) {
      // A transient empty grant table (e.g. around a plugin update) must not
      // fail the scan while the folders themselves are still configured.
      await refreshGrants(ctx);
      await reconcileFolders(ctx);
      folders = usableFolders();
    }
    if (folders.length === 0) {
      throw new Error('没有可用的音乐文件夹，请先在设置中添加并保持授权有效');
    }
    const collected = await collectLibrary(ctx, folders, {
      shouldAbort: abortedNow,
      onOperation: (operation) => {
        job.inflight = operation;
      },
      onProgress: (progress) => {
        if (abortedNow()) return;
        const label = `已扫描 ${progress.dirs} 个目录，找到 ${progress.found} 首`;
        try {
          job.task?.update({ progress: { done: progress.found, total: 0, label } });
        } catch (taskError) {
          // Ignore update races with dismissal.
        }
        publishScan({ stage: 'scan', running: true, label, found: progress.found });
      },
    });
    if (collected.errors.length > 0) {
      try {
        ctx.toast.warning(collected.errors[0]);
      } catch (toastError) {
        // Toasts are best-effort.
      }
    }
    applyCollected(collected);
    indexed = true;
    cacheTruncated = collected.truncated;
    libraryReady = true;
    await persistLibraryCache(ctx, collected.truncated);
    notifyLibraryChanged();
    publishScan({
      stage: 'enrich',
      running: true,
      label: '正在读取标签…',
      found: librarySongs.length,
    });

    if (librarySongs.length > 0) {
      const total = librarySongs.length;
      await enrichMetadata(ctx, librarySongs, refFor, {
        shouldAbort: abortedNow,
        onOperation: (operation) => {
          job.inflight = operation;
        },
        onProgress: (done) => {
          if (abortedNow()) return;
          const label = `读取标签 ${done}/${total}`;
          try {
            job.task?.update({ progress: { done, total, label } });
          } catch (taskError) {
            // Ignore update races with dismissal.
          }
          publishScan({ stage: 'enrich', running: true, label, found: total });
        },
      });
      const coverJobs = representativeCoverJobs();
      const coverTotal = coverJobs.length;
      await enrichCovers(
        ctx,
        coverJobs,
        refFor,
        settings.readEmbedded ? tagReader : null,
        {
          shouldAbort: abortedNow,
          onOperation: (operation) => {
            job.inflight = operation;
          },
          onProgress: (done) => {
            if (abortedNow()) return;
            const label = `整理封面 ${done}/${coverTotal}`;
            try {
              job.task?.update({ progress: { done, total: coverTotal, label } });
            } catch (taskError) {
              // Ignore update races with dismissal.
            }
            publishScan({ stage: 'enrich', running: true, label, found: total });
          },
          onCover: (songId, url) => writeCover(ctx, songId, url),
        },
        settings.onlineFetch,
      );
      await cleanupCovers(ctx, libraryById);
    }
    await persistLibraryCache(ctx, cacheTruncated);
    finishTask('completed', `扫描完成，共 ${librarySongs.length} 首`);
    publishScan({ running: false, done: true, count: librarySongs.length });
    notifyLibraryChanged();
  } catch (error) {
    const aborted = error instanceof LibraryScanAborted || abortedNow();
    if (aborted) {
      // Keep whatever the walk collected before the stop so the list button
      // has something to show, mirroring the legacy plugins.
      if (!indexed && error instanceof LibraryScanAborted && error.partial.songs.length > 0) {
        applyCollected(error.partial);
        cacheTruncated = error.partial.truncated;
        libraryReady = true;
      }
      await persistLibraryCache(ctx, cacheTruncated);
      finishTask(
        'aborted',
        libraryReady ? `扫描已中止，已保留 ${librarySongs.length} 首` : '扫描已中止',
      );
      publishScan({
        running: false,
        aborted: true,
        count: libraryReady ? librarySongs.length : 0,
      });
      notifyLibraryChanged();
    } else {
      const message = error instanceof Error ? error.message : String(error);
      finishTask('error', '扫描失败', message);
      publishScan({ running: false, error: message });
    }
  } finally {
    if (scanJob && scanJob.epoch === epoch) scanJob = null;
  }
}

function startScanJob(ctx: EchoPluginContext): JsonValue {
  if (scanJob) {
    if (scanJob.aborted) return { started: false, busy: true, message: '正在停止上次扫描' };
    return { started: true, already: true };
  }
  scanEpoch += 1;
  const epoch = scanEpoch;
  const job: ScanJob = { epoch, aborted: false, task: null, inflight: null };
  job.task = ctx.tasks.registerTask('library-scan', {
    name: '扫描本地音乐',
    status: 'running',
    progress: { done: 0, total: 0, label: '正在读取文件夹' },
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
  publishScan({ stage: 'scan', running: true, label: '正在读取文件夹', found: 0 });
  void runScanJob(ctx, job, epoch);
  return { started: true };
}

async function stopScan(): Promise<JsonValue> {
  if (!scanJob) return { ok: false };
  requestScanAbort(scanJob);
  return { ok: true };
}

// ── Settings & folders ─────────────────────────────────────────────────────

async function persistSettings(next: LocalSettings): Promise<void> {
  const ctx = requireContext();
  const foldersChanged = folderSignatureOf(settings) !== folderSignatureOf(next);
  settings = next;
  await awaitOperation(ctx.io.writeValue(SETTINGS_KEY, settingsToValue(next)));
  settingsRevision += 1;
  if (foldersChanged) {
    libraryReady = false;
    indexLibrary([]);
    dirCovers = new Map();
  }
  publishState();
}

function folderSignatureOf(value: LocalSettings): string {
  return folderIdsOf(value).join('\n');
}

function settingsToValue(value: LocalSettings): JsonValue {
  return {
    folders: value.folders.map((folder) => ({
      id: folder.id,
      name: folder.name,
      path: folder.path,
    })),
    readEmbedded: value.readEmbedded,
    onlineFetch: value.onlineFetch,
  };
}

async function settingsPatch(args: Record<string, JsonValue>): Promise<JsonValue> {
  const next: LocalSettings = {
    folders: settings.folders,
    readEmbedded:
      typeof args?.readEmbedded === 'boolean' ? args.readEmbedded : settings.readEmbedded,
    onlineFetch: typeof args?.onlineFetch === 'boolean' ? args.onlineFetch : settings.onlineFetch,
  };
  await persistSettings(next);
  return { ok: true };
}

function suggestFolderName(grant: FileGrant): string {
  const display = grant.displayPath || grant.name || '';
  const segment = baseName(display.replace(/[\\/]+$/, ''));
  return segment || grant.name || '音乐文件夹';
}

async function addFolder(): Promise<JsonValue> {
  const ctx = requireContext();
  const selection = await awaitOperation(
    ctx.files.requestDirectory({
      purpose: '选择音乐文件夹',
      access: 'read',
      persist: true,
    }),
  );
  if (!selection || selection.canceled || !selection.directory) {
    return { ok: false, canceled: true };
  }
  const grant: FileGrant = selection.directory;
  const displayPath = grant.displayPath || grant.name || '';
  await refreshGrants(ctx);
  // A dead entry for the same directory (its grant died with a previous
  // installation) is re-claimed in place instead of duplicating the row.
  const normalized = normalizeDisplayPath(displayPath);
  const staleIndex = settings.folders.findIndex(
    (folder) =>
      folder.id === grant.id || (folder.path && normalizeDisplayPath(folder.path) === normalized),
  );
  if (staleIndex >= 0) {
    const stale = settings.folders[staleIndex];
    if (stale.id === grant.id && stale.path) {
      return { ok: false, duplicate: true, message: '该文件夹已在列表中' };
    }
    const name = stale.name || suggestFolderName(grant);
    const folders = settings.folders.slice();
    folders[staleIndex] = { id: grant.id, name, path: displayPath };
    await persistSettings({ ...settings, folders });
    if (stale.id !== grant.id) {
      try {
        await awaitOperation(ctx.files.revoke(stale.id));
      } catch (error) {
        // The superseded grant may already be gone.
      }
    }
    return { ok: true, id: grant.id, name, reclaimed: true };
  }
  const name = suggestFolderName(grant);
  const folders = settings.folders.concat([{ id: grant.id, name, path: displayPath }]);
  await persistSettings({ ...settings, folders });
  return { ok: true, id: grant.id, name };
}

async function removeFolder(args: Record<string, JsonValue>): Promise<JsonValue> {
  const ctx = requireContext();
  const id = argString(args, 'id');
  const folder = findFolder(settings, id);
  if (!folder) return { ok: false, message: '文件夹不存在' };
  try {
    await awaitOperation(ctx.files.revoke(id));
  } catch (error) {
    // The grant may already be gone; removing from the list is what matters.
  }
  await refreshGrants(ctx);
  const folders = settings.folders.filter((entry) => entry.id !== id);
  await persistSettings({ ...settings, folders });
  return { ok: true };
}

async function renameFolder(args: Record<string, JsonValue>): Promise<JsonValue> {
  const id = argString(args, 'id');
  const folder = findFolder(settings, id);
  if (!folder) return { ok: false, message: '文件夹不存在' };
  const name = argString(args, 'name').trim();
  const folders = settings.folders.map((entry) =>
    entry.id === id ? { id: entry.id, name, path: entry.path } : entry,
  );
  await persistSettings({ ...settings, folders });
  return { ok: true };
}

// ── Library page commands ──────────────────────────────────────────────────

function viewFilter(args: Record<string, JsonValue>): {
  keyword: string;
  folderId: string;
  album: string;
  sort: SongSortKey;
  descending: boolean;
} {
  return {
    keyword: argString(args, 'keyword'),
    folderId: argString(args, 'folderId'),
    album: argString(args, 'album'),
    sort: normalizeSortKey(args ? args.sort : undefined),
    descending: normalizeSortDescending(args ? args.sortDir : undefined),
  };
}

function collectionView(args: Record<string, JsonValue>): SongInit[] {
  const filter = viewFilter(args);
  const key = JSON.stringify(filter);
  if (key !== viewCacheKey) {
    viewCacheSongs = sortSongs(filterSongs(librarySongs, filter), filter.sort, filter.descending);
    viewCacheKey = key;
  }
  return viewCacheSongs;
}

async function libraryPage(args: Record<string, JsonValue>): Promise<JsonValue> {
  if (!libraryReady) return { ready: false, total: 0, offset: 0, limit: 0, songs: [] };
  const { offset, limit } = parsePageArgs(args, PAGE_LIMIT_MAX);
  const view = collectionView(args);
  const page = view.slice(offset, offset + limit);
  return {
    ready: true,
    total: view.length,
    offset,
    limit,
    songs: page.map(songRow),
  };
}

async function libraryAlbums(args: Record<string, JsonValue>): Promise<JsonValue> {
  if (!libraryReady) return { ready: false, total: 0, offset: 0, limit: 0, albums: [] };
  const ctx = requireContext();
  const { offset, limit } = parsePageArgs(args, ALBUM_PAGE_LIMIT_MAX);
  const keyword = argString(args, 'keyword');
  const folderId = argString(args, 'folderId');
  const visible = sortSongs(
    filterSongs(librarySongs, { keyword, folderId, album: '' }),
    normalizeSortKey(args ? args.sort : undefined),
    normalizeSortDescending(args ? args.sortDir : undefined),
  );
  const albums = groupAlbums(visible).filter(
    (album) => !keyword || album.name.toLowerCase().indexOf(keyword.trim().toLowerCase()) >= 0,
  );
  const page = albums.slice(offset, offset + limit);
  const covers = await Promise.all(
    page.map(async (album) => {
      try {
        return await readCoverBounded(ctx, album.representativeId);
      } catch (error) {
        return '';
      }
    }),
  );
  const rows: AlbumRowJson[] = page.map((album, index) =>
    albumRow(album.name, album.count, covers[index] ?? ''),
  );
  return { ready: true, total: albums.length, offset, limit, albums: rows };
}

/** Cover lookup for the page headers and rows, bounded so a wedged io
 * operation degrades to a missing cover instead of blocking the caller. */
async function readCoverBounded(ctx: EchoPluginContext, songId: string): Promise<string> {
  const value = await raceTimeout(ctx, readCover(ctx, songId), COVER_LOOKUP_BUDGET_MS);
  return value ?? '';
}

/** Cover lookup for the song rows the page currently displays. */
async function libraryCovers(args: Record<string, JsonValue>): Promise<JsonValue> {
  if (!libraryReady) return { covers: {} };
  const ctx = requireContext();
  const ids = argStringArray(args, 'ids');
  const covers: { [key: string]: JsonValue } = {};
  await Promise.all(
    ids.map(async (id) => {
      try {
        const url = await readCoverBounded(ctx, id);
        if (url) covers[id] = url;
      } catch (error) {
        // Missing covers simply keep the placeholder art.
      }
    }),
  );
  return { covers };
}

// ── Playback ───────────────────────────────────────────────────────────────

/** The host queue validator caps a track's cover string at 16384 chars
 * (EchoPluginPlaylist::parse) and stays silent beyond that, so oversized
 * embedded art must be withheld from queue payloads instead of submitting
 * it and failing the whole call. */
export const QUEUE_COVER_LIMIT = 16000;

export async function queueCoverForTrack(song: SongInit, cover: string): Promise<QueueTrack> {
  if (cover && cover.length <= QUEUE_COVER_LIMIT) return buildQueueTrack(song, { cover });
  return buildQueueTrack(song);
}

async function coverForTrack(song: SongInit): Promise<string> {
  const ctx = requireContext();
  try {
    const cached = await readCoverBounded(ctx, song.id);
    if (cached) return cached;
  } catch (error) {
    return '';
  }
  if (!settings.readEmbedded || !tagReader) return '';
  const tags = await raceTimeout(
    ctx,
    tagReader.readTags(song.folderId, song.path),
    COVER_BUDGET_MS,
  );
  // Keep parity with the enrichment cache: artwork beyond the store limit is
  // not persisted, otherwise oversized images inflate the KV repeatedly.
  const url =
    tags && tags.coverData && tags.coverData.length <= COVER_STORE_LIMIT ? coverDataUrl(tags) : '';
  if (url) {
    try {
      await writeCover(ctx, song.id, url);
    } catch (error) {
      // Cover caching is best-effort.
    }
  }
  return url;
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
      await awaitOperation(ctx.playlist.replace(QUEUE_KEY, QUEUE_TITLE, tracks, 0));
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

function queueTitleFor(args: Record<string, JsonValue>): string {
  const album = argString(args, 'album');
  if (album) return album;
  const folderId = argString(args, 'folderId');
  if (folderId) {
    const label = folderLabel(folderId);
    if (label && label !== folderId) return label;
  }
  return QUEUE_TITLE;
}

async function playCommand(args: Record<string, JsonValue>): Promise<JsonValue> {
  if (!libraryReady) return { error: 'not-ready', message: '曲库尚未就绪，请先扫描' };
  const mode = argString(args, 'mode') || 'now';
  const ids = argStringArray(args, 'ids');
  let songs: SongInit[] = [];
  let startIndex = 0;
  if (ids.length > 0) {
    for (const id of ids) {
      const song = libraryById.get(id);
      if (song) songs.push(song);
    }
    startIndex = Math.max(0, Math.floor(argNumber(args, 'index', 0)));
    if (startIndex >= songs.length) startIndex = 0;
  } else {
    songs = collectionView(args);
    startIndex = Math.max(0, Math.floor(argNumber(args, 'index', 0)));
    if (startIndex >= songs.length) startIndex = 0;
  }
  if (songs.length === 0) return { error: 'empty', message: '没有可播放的歌曲' };
  const tracks = songs.map((song) => buildQueueTrack(song));
  if (mode === 'now') {
    const firstIndex = Math.min(startIndex, songs.length - 1);
    try {
      const cover = await coverForTrack(songs[firstIndex]);
      // Withhold covers beyond the host queue cap: submitting them rejects
      // the whole replace call and playback never starts.
      tracks[firstIndex] = await queueCoverForTrack(songs[firstIndex], cover);
    } catch (error) {
      // A slow or missing cover must not delay playback.
    }
    const ctx = requireContext();
    await awaitOperation(ctx.playlist.replace(QUEUE_KEY, queueTitleFor(args), tracks, firstIndex));
    return { ok: true, count: tracks.length, index: firstIndex };
  }
  const placement = mode === 'next' ? 'next' : 'last';
  return appendTracks(tracks, placement);
}

// ── Resolvers ──────────────────────────────────────────────────────────────

function matchLocalTrack(track: QueueTrack): boolean {
  if (typeof track.sourceId !== 'string') return false;
  // Accept both the persisted form (`local:<folder>:<song>`) and the
  // host-rewritten form with a plugin namespace prefix prepended by the
  // queue ingestion (`EchoPluginPlaylist::parse`).
  return /^([^/:]+\/)?local:/.test(track.sourceId);
}

async function resolveAudioSource(
  resolverContext: AudioSourceContext,
): Promise<AudioSourceValue | null> {
  const parsed = parseSourceId(resolverContext.track.sourceId ?? '');
  if (!parsed) return null;
  const ctx = requireContext();
  const data = resolverContext.track.data;
  const path = data && typeof data.p === 'string' ? data.p : '';
  if (!path) return null;
  const folderId = data && typeof data.f === 'string' && data.f ? data.f : parsed.folderId;

  const attempt = (root: FileReference): Promise<AudioSourceValue | null> => {
    const fileRef: FileReference = { grantId: root.grantId, revision: root.revision, path };
    const operation = ctx.files.openMedia(fileRef, { lifetime: 'track' });
    try {
      resolverContext.request.track(operation);
    } catch (error) {
      // Tracking is optional; playback still works without it.
    }
    return awaitOperation(operation).then(
      (lease) => {
        if (lease && lease.url) {
          const duration = resolverContext.track.durationMs;
          return {
            url: lease.url.toString(),
            quality: qualityForExtension(extensionOf(path)),
            sourceKind: 'plugin',
            durationMs:
              typeof duration === 'number' && duration > 0 ? Math.round(duration) : undefined,
          };
        }
        disposeLease(lease);
        return null;
      },
      () => null,
    );
  };

  let root = grantRefs.get(folderId);
  if (!root) {
    await refreshGrants(ctx);
    root = grantRefs.get(folderId);
    if (!root) return null;
  }
  const first = await attempt(root);
  if (first) return first;
  if (resolverContext.request.canceled) return null;
  // The grant revision may have gone stale since activation; refresh once and
  // retry. Local tracks have no host-side fallback, so this second chance is
  // what keeps playback alive across reauthorizations.
  await refreshGrants(ctx);
  const fresh = grantRefs.get(folderId);
  if (!fresh) return null;
  if (fresh.grantId === root.grantId && fresh.revision === root.revision) return null;
  return attempt(fresh);
}

function disposeLease(lease: EchoPluginMediaLease | null | undefined): void {
  if (!lease) return;
  try {
    lease.dispose();
  } catch (error) {
    // The lease may already be gone.
  }
}

// ── Activation ─────────────────────────────────────────────────────────────

async function warmStart(ctx: EchoPluginContext): Promise<void> {
  try {
    const cached = await readLibraryCache(ctx, folderIdsOf(settings));
    if (cached) {
      indexLibrary(cached.songs);
      cacheTruncated = cached.truncated;
      libraryReady = true;
      // Restored songs change what pages should render, so bump the
      // revision even during activation.
      notifyLibraryChanged();
    }
  } catch (error) {
    // A broken cache simply means the page asks for a rescan.
  }
}

export async function activate(ctx: EchoPluginContext): Promise<void> {
  context = ctx;
  // The io service can transiently serve an activation read as failed or
  // empty; setting stays recoverable through ensureStorage below and in
  // every command that answers from storage.
  let rawSettings: JsonValue | undefined;
  try {
    rawSettings = (await awaitOperation(ctx.io.readValue(SETTINGS_KEY))) as JsonValue;
  } catch (readError) {
    // A failed activation read behaves like empty storage below; the
    // timer and per-command re-checks retry later.
  }
  settings = normalizeSettings(rawSettings);
  // Remove the leftover diagnostic snapshots from the debugging sessions.
  try {
    await awaitOperation(ctx.io.removeValue('__diag'));
    await awaitOperation(ctx.io.removeValue('__diag2'));
  } catch (cleanupError) {
    // Missing keys are fine.
  }
  // Resolve grant revisions up front: the settings page, resolvers and scans
  // all rely on grantRefs, and a not-yet-loaded map would flash folders as
  // unavailable. Re-claim folders whose grant was re-issued under a new
  // installation before anything renders them as unavailable.
  await refreshGrants(ctx);
  await reconcileFolders(ctx);
  tagReader = createTagReader(ctx, refFor);
  lyricEngine = createLyricEngine(ctx, {
    onlineFetch: () => settings.onlineFetch,
    readEmbedded: () => settings.readEmbedded,
    readTags: (folderId, path) =>
      tagReader ? tagReader.readTags(folderId, path) : Promise.resolve(null),
    fileRef: fileRefFor,
  });

  const audio = ctx.player.audioSource.registerResolver('local-audio', {
    order: 10,
    position: 'before-catalog',
    match: (resolverContext) => matchLocalTrack(resolverContext.track),
    resolve: resolveAudioSource,
  });
  if (audio) registrations.push(audio);

  const lyrics = ctx.lyrics.registerResolver('local-lyrics', {
    order: 10,
    match: (resolverContext) => matchLocalTrack(resolverContext.track),
    resolve: (resolverContext) =>
      lyricEngine ? lyricEngine.resolve(resolverContext) : Promise.resolve(null),
  });
  if (lyrics) registrations.push(lyrics);

  const page = ctx.ui.registerPage('local-browser', 'BrowserPage.qml');
  if (page) registrations.push(page);
  const settingsPage = ctx.ui.registerSettings('Settings.qml');
  if (settingsPage) registrations.push(settingsPage);
  const sidebar = ctx.ui.registerSidebarItem('local-browser', {
    title: '本地音乐',
    icon: 'music',
    pageId: 'local-browser',
    section: 'library',
    order: 90,
  });
  if (sidebar) registrations.push(sidebar);

  // settings.get/settings.patch claim provider-agnostic names that other
  // plugins (webdav-music, spectrum-visualizer) also register; the host
  // routes QML executeCommand by name, so keep them plugin-scoped.
  ctx.registerCommand('library.settings.get', () => settingsGet());
  ctx.registerCommand('library.settings.patch', (commandArgs) => settingsPatch(commandArgs));
  ctx.registerCommand('folders.add', () => addFolder());
  ctx.registerCommand('folders.remove', (commandArgs) => removeFolder(commandArgs));
  ctx.registerCommand('folders.rename', (commandArgs) => renameFolder(commandArgs));
  ctx.registerCommand('library.info', () => libraryInfo());
  ctx.registerCommand('library.scan', () => startScanJob(requireContext()));
  ctx.registerCommand('library.abort', () => stopScan());
  ctx.registerCommand('library.page', (commandArgs) => libraryPage(commandArgs));
  ctx.registerCommand('library.albums', (commandArgs) => libraryAlbums(commandArgs));
  ctx.registerCommand('library.covers', (commandArgs) => libraryCovers(commandArgs));
  ctx.registerCommand('play', (commandArgs) => playCommand(commandArgs));

  ctx.ui.setState({ settingsRevision, scan: null, libraryRevision: 0 });
  lastScanState = null;
  void warmStart(ctx);
  // Belt and braces: if the grant table reads empty while folders are
  // configured (a transient window around updates), re-check shortly after
  // activation and re-claim by path before the user notices anything.
  if (settings.folders.length > 0 && grantRefs.size === 0) {
    ctx.setTimer('grant-recheck', 2000, false, () => {
      void (async () => {
        const active = context;
        if (!active) return;
        try {
          await refreshGrants(active);
          await reconcileFolders(active);
          publishState();
        } catch (error) {
          // The next command that needs grants refreshes again anyway.
        }
      })();
    });
  }
  // And the same belt-and-braces for the settings row: if the activation
  // read came back empty, retry shortly after boot so the sidebar and
  // the library page show the recovered state without any interaction.
  if (settings.folders.length === 0) {
    const recover = (delayMs: number, attempt: number) => {
      ctx.setTimer(`settings-recheck-${attempt}`, delayMs, false, () => {
        void (async () => {
          const active = context;
          if (!active) return;
          try {
            if (settings.folders.length > 0) return;
            await ensureStorage(active);
            if (settings.folders.length === 0) recover(6000, attempt + 1);
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
  if (tagReader) {
    tagReader.dispose();
    tagReader = null;
  }
  lyricEngine = null;
  clearLyricCache();
  grantRefs = new Map();
  grantPaths = new Map();
  indexLibrary([]);
  dirCovers = new Map();
  libraryReady = false;
  lastScanState = null;
  context = null;
  settings = normalizeSettings(undefined);
}

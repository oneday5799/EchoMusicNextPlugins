// Local library scan: a recursive walk of every granted folder through
// ctx.files, plus the chunked KV cache that keeps results across sessions.
// Single KV values are capped at 1 MiB, so songs serialize into ~400-item
// chunks behind a meta record.

import { awaitOperation } from 'echo:plugin-sdk';
import type { EchoPluginContext, FileReference, FileStat, JsonValue } from 'echo:plugin-sdk';
import { coerceJsonArray } from './codec.ts';
import {
  compactSong,
  COVER_BASE_NAMES,
  COVER_EXTENSIONS,
  expandCompactSong,
  isAudioFile,
  isCoverImage,
  isLyricFile,
  LIBRARY_SONG_CAP,
  lyricKeyOf,
  lyricRank,
  songFromEntry,
  type SongInit,
} from './library.ts';

export const LIBRARY_CACHE_VERSION = 1;
const CHUNK_SIZE = 400;
/** Host ceiling for a single listFiles call. */
const LIST_PAGE_LIMIT = 5000;
const LIST_DEPTH = 24;

export interface ScanCollected {
  songs: SongInit[];
  /** `dir|base` (lowercased base, no extension) → best sidecar lyric path. */
  lyricPaths: Map<string, string>;
  /** `folderId|dir` → folder cover image path. */
  dirCovers: Map<string, string>;
  /** Song or entry caps were hit; results are incomplete. */
  truncated: boolean;
  /** Per-folder failures that did not stop the scan. */
  errors: string[];
}

export interface ScanProgress {
  folderIndex: number;
  folderTotal: number;
  found: number;
  dirs: number;
}

export interface ScanCallbacks {
  shouldAbort?: () => boolean;
  /** Receives each in-flight listing so callers can cancel it on abort. */
  onOperation?: (operation: { cancel(): void }) => void;
  onProgress?: (progress: ScanProgress) => void;
}

export class LibraryScanAborted extends Error {
  /** Everything collected before the abort; kept so a stopped scan stays usable. */
  readonly partial: ScanCollected;
  constructor(partial: ScanCollected) {
    super('扫描已中止');
    this.partial = partial;
  }
}

export interface ScanFolder {
  folderId: string;
  root: FileReference;
}

function emptyCollected(): ScanCollected {
  return {
    songs: [],
    lyricPaths: new Map(),
    dirCovers: new Map(),
    truncated: false,
    errors: [],
  };
}

function coverPriority(name: string): number {
  const cut = name.lastIndexOf('.');
  const base = (cut > 0 ? name.slice(0, cut) : name).toLowerCase();
  const extension = cut < 0 ? '' : name.slice(cut + 1).toLowerCase();
  const baseIndex = COVER_BASE_NAMES.indexOf(base);
  const extensionIndex = COVER_EXTENSIONS.indexOf(extension);
  return (baseIndex < 0 ? 99 : baseIndex) * 100 + (extensionIndex < 0 ? 99 : extensionIndex);
}

interface WalkState {
  collected: ScanCollected;
  shouldAbort?: () => boolean;
  onOperation?: (operation: { cancel(): void }) => void;
  onProgress?: (progress: ScanProgress) => void;
  folderIndex: number;
  folderTotal: number;
}

function classifyEntries(state: WalkState, folderId: string, entries: FileStat[]): void {
  for (const entry of entries) {
    if (!entry || entry.directory) continue;
    const path = entry.file && typeof entry.file.path === 'string' ? entry.file.path : '';
    if (!path) continue;
    const name = entry.name || '';
    if (isAudioFile(name)) {
      if (state.collected.songs.length >= LIBRARY_SONG_CAP) {
        state.collected.truncated = true;
        return;
      }
      state.collected.songs.push(songFromEntry({ folderId, path, name, size: entry.size }));
    } else if (isLyricFile(name)) {
      const key = lyricKeyOf(path);
      const existing = state.collected.lyricPaths.get(key);
      if (!existing || lyricRank(name) < lyricRank(existing)) {
        state.collected.lyricPaths.set(key, path);
      }
    } else if (isCoverImage(name)) {
      const dir = path.indexOf('/') >= 0 ? path.slice(0, path.lastIndexOf('/')) : '';
      const key = `${folderId}|${dir}`;
      const candidate = coverPriority(name);
      const existing = state.collected.dirCovers.get(key);
      if (existing === undefined || candidate < coverPriority(existing)) {
        state.collected.dirCovers.set(key, path);
      }
    }
  }
}

async function listEntries(
  context: EchoPluginContext,
  state: WalkState,
  ref: FileReference,
  depth: number,
): Promise<{ entries: FileStat[]; truncated: boolean } | null> {
  const operation = context.files.listFiles(ref, { kind: 'all', depth, limit: LIST_PAGE_LIMIT });
  if (state.onOperation) state.onOperation(operation);
  try {
    const result = await awaitOperation(operation);
    return result ?? null;
  } catch (error) {
    // A cancel lands here as a generic error; report it as an abort with
    // everything collected so far instead of silently skipping the folder.
    if (state.shouldAbort && state.shouldAbort()) throw new LibraryScanAborted(state.collected);
    return null;
  }
}

/** One folder: whole-tree listing first, falling back to a BFS walk when the
 * single-page result was truncated. */
async function walkFolder(
  context: EchoPluginContext,
  state: WalkState,
  folder: ScanFolder,
): Promise<void> {
  let dirs = 0;
  const whole = await listEntries(context, state, folder.root, LIST_DEPTH);
  if (state.shouldAbort && state.shouldAbort()) throw new LibraryScanAborted(state.collected);
  if (whole && !whole.truncated) {
    classifyEntries(state, folder.folderId, whole.entries ?? []);
    dirs = 1;
  } else {
    const queue: string[] = [''];
    const seen: { [key: string]: boolean } = {};
    while (queue.length > 0) {
      if (state.shouldAbort && state.shouldAbort()) throw new LibraryScanAborted(state.collected);
      const dir = queue.shift() ?? '';
      const ref: FileReference = { ...folder.root, path: dir };
      const page = await listEntries(context, state, ref, 1);
      if (!page) {
        state.collected.errors.push(`无法读取目录 ${dir || folder.folderId}`);
        continue;
      }
      dirs += 1;
      const entries = page.entries ?? [];
      classifyEntries(state, folder.folderId, entries);
      for (const entry of entries) {
        if (!entry || !entry.directory) continue;
        const path = entry.file && typeof entry.file.path === 'string' ? entry.file.path : '';
        if (!path || seen[path]) continue;
        seen[path] = true;
        queue.push(path);
      }
      if (state.collected.songs.length >= LIBRARY_SONG_CAP) {
        state.collected.truncated = true;
        break;
      }
    }
  }
  if (state.onProgress) {
    state.onProgress({
      folderIndex: state.folderIndex,
      folderTotal: state.folderTotal,
      found: state.collected.songs.length,
      dirs,
    });
  }
}

/**
 * Walk every granted folder and collect songs, sidecar lyrics and folder
 * covers. Folders are visited sequentially and a failed folder is reported
 * in `errors` instead of stopping the scan.
 */
export async function collectLibrary(
  context: EchoPluginContext,
  folders: ScanFolder[],
  callbacks: ScanCallbacks = {},
): Promise<ScanCollected> {
  const state: WalkState = {
    collected: emptyCollected(),
    shouldAbort: callbacks.shouldAbort,
    onOperation: callbacks.onOperation,
    onProgress: callbacks.onProgress,
    folderIndex: 0,
    folderTotal: folders.length,
  };
  for (const folder of folders) {
    if (callbacks.shouldAbort && callbacks.shouldAbort()) {
      throw new LibraryScanAborted(state.collected);
    }
    state.folderIndex += 1;
    try {
      await walkFolder(context, state, folder);
    } catch (error) {
      if (error instanceof LibraryScanAborted) throw error;
      state.collected.errors.push(
        `扫描文件夹失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (state.collected.truncated) break;
  }
  // Pair songs with their sidecar lyrics now that every folder was seen.
  for (const song of state.collected.songs) {
    const lyricPath = state.collected.lyricPaths.get(lyricKeyOf(song.path));
    if (lyricPath) song.lyricPath = lyricPath;
  }
  return state.collected;
}

// ── KV cache ──────────────────────────────────────────────────────────────

export interface LibraryCacheMeta extends Record<string, JsonValue> {
  version: number;
  count: number;
  chunks: number;
  truncated: boolean;
  folders: JsonValue;
}

export function libraryMetaKey(): string {
  return 'library';
}

export function libraryChunkKey(index: number): string {
  return `library:${index}`;
}

export function folderSignature(folderIds: string[]): string {
  return folderIds.join('\n');
}

export function parseCacheMeta(value: JsonValue | undefined): LibraryCacheMeta | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as { [key: string]: JsonValue };
  if (
    typeof record.version !== 'number' ||
    typeof record.count !== 'number' ||
    typeof record.chunks !== 'number'
  ) {
    return null;
  }
  const meta = {
    version: record.version,
    count: Math.max(0, Math.floor(record.count)),
    chunks: Math.max(0, Math.floor(record.chunks)),
    truncated: record.truncated === true,
    folders: coerceJsonArray(record.folders).filter(
      (item): item is string => typeof item === 'string' && item.length > 0,
    ),
  };
  return meta;
}

export function metaMatches(meta: LibraryCacheMeta | null, folderIds: string[]): boolean {
  if (!meta || meta.version !== LIBRARY_CACHE_VERSION) return false;
  const folders = Array.isArray(meta.folders) ? meta.folders : [];
  const names: string[] = [];
  for (const item of folders) {
    if (typeof item === 'string') names.push(item);
  }
  return folderSignature(names) === folderSignature(folderIds);
}

export async function writeLibraryCache(
  context: EchoPluginContext,
  folderIds: string[],
  songs: SongInit[],
  truncated: boolean,
): Promise<void> {
  const chunks: JsonValue[][] = [];
  for (let start = 0; start < songs.length; start += CHUNK_SIZE) {
    const chunk: JsonValue[] = [];
    for (let i = start; i < start + CHUNK_SIZE && i < songs.length; i += 1) {
      chunk.push(compactSong(songs[i]));
    }
    chunks.push(chunk);
  }
  const previousMeta = parseCacheMeta(await awaitOperation(context.io.readValue(libraryMetaKey())));
  for (let i = 0; i < chunks.length; i += 1) {
    await awaitOperation(context.io.writeValue(libraryChunkKey(i), chunks[i]));
  }
  await awaitOperation(
    context.io.writeValue(libraryMetaKey(), {
      version: LIBRARY_CACHE_VERSION,
      count: songs.length,
      chunks: chunks.length,
      truncated,
      folders: folderIds.slice(),
    }),
  );
  if (previousMeta && previousMeta.chunks > chunks.length) {
    for (let i = chunks.length; i < previousMeta.chunks; i += 1) {
      try {
        await awaitOperation(context.io.removeValue(libraryChunkKey(i)));
      } catch (error) {
        // A missing stale chunk is fine.
      }
    }
  }
}

export async function readLibraryCache(
  context: EchoPluginContext,
  folderIds: string[],
): Promise<{ songs: SongInit[]; truncated: boolean } | null> {
  const meta = parseCacheMeta(await awaitOperation(context.io.readValue(libraryMetaKey())));
  if (!meta || !metaMatches(meta, folderIds)) return null;
  const songs: SongInit[] = [];
  for (let i = 0; i < meta.chunks; i += 1) {
    const chunk = coerceJsonArray(
      (await awaitOperation(context.io.readValue(libraryChunkKey(i)))) as JsonValue | undefined,
    );
    if (chunk.length === 0) return null;
    for (const item of chunk) {
      const song = expandCompactSong(item);
      if (song) songs.push(song);
    }
  }
  if (songs.length !== meta.count) return null;
  return { songs, truncated: meta.truncated };
}

export async function clearLibraryCache(context: EchoPluginContext): Promise<void> {
  const meta = parseCacheMeta(await awaitOperation(context.io.readValue(libraryMetaKey())));
  if (meta) {
    for (let i = 0; i < meta.chunks; i += 1) {
      try {
        await awaitOperation(context.io.removeValue(libraryChunkKey(i)));
      } catch (error) {
        // Best-effort cleanup.
      }
    }
  }
  try {
    await awaitOperation(context.io.removeValue(libraryMetaKey()));
  } catch (error) {
    // Ignore missing meta.
  }
}

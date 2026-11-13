// Flat-library scan (recursive PROPFIND walk) and the chunked KV cache that
// keeps results across sessions. Single KV values are capped at 1 MiB, so
// songs serialize into ~400-item chunks behind a meta record.

import { awaitOperation } from 'echo:plugin-sdk';
import type { EchoPluginContext, JsonValue } from 'echo:plugin-sdk';
import { cancelOperationAfter } from './async.ts';
import type { WebdavLibraryConfig } from './config.ts';
import {
  compactSong,
  expandCompactSong,
  isAudioFile,
  songFromEntry,
  type SongInit,
} from './library.ts';
import {
  endpointOf,
  normalizeDir,
  normalizeServerUrl,
  parsePropfind,
  propfindRequest,
  propfindStatusOk,
  type WebdavEndpoint,
} from './webdav.ts';

const SCAN_TIMEOUT_MS = 15000;
const CHUNK_SIZE = 400;
export const FLAT_CACHE_VERSION = 2;

export interface FlatCacheMeta extends Record<string, JsonValue> {
  version: number;
  count: number;
  chunks: number;
  serverUrl: string;
  rootPath: string;
  truncated: boolean;
}

export function flatMetaKey(libraryId: string): string {
  return `flat:${libraryId}`;
}

export function flatChunkKey(libraryId: string, index: number): string {
  return `flat:${libraryId}:${index}`;
}

export function buildFlatMeta(
  library: WebdavLibraryConfig,
  count: number,
  chunks: number,
  truncated: boolean,
): FlatCacheMeta {
  return {
    version: FLAT_CACHE_VERSION,
    count,
    chunks,
    serverUrl: normalizeServerUrl(library.serverUrl),
    rootPath: normalizeDir(library.rootPath || '/'),
    truncated,
  };
}

function parseFlatMeta(value: JsonValue | undefined): FlatCacheMeta | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as { [key: string]: JsonValue };
  const version = record.version;
  const count = record.count;
  const chunks = record.chunks;
  if (typeof version !== 'number' || typeof count !== 'number' || typeof chunks !== 'number')
    return null;
  return {
    version,
    count: Math.max(0, Math.floor(count)),
    chunks: Math.max(0, Math.floor(chunks)),
    serverUrl: typeof record.serverUrl === 'string' ? record.serverUrl : '',
    rootPath: typeof record.rootPath === 'string' ? record.rootPath : '/',
    truncated: record.truncated === true,
  };
}

export { parseFlatMeta };

export function metaMatches(meta: FlatCacheMeta, library: WebdavLibraryConfig): boolean {
  return (
    meta.version === FLAT_CACHE_VERSION &&
    meta.serverUrl === normalizeServerUrl(library.serverUrl) &&
    meta.rootPath === normalizeDir(library.rootPath || '/')
  );
}

export function chunkSongs(songs: SongInit[]): JsonValue[][] {
  const chunks: JsonValue[][] = [];
  for (let start = 0; start < songs.length; start += CHUNK_SIZE) {
    const chunk: JsonValue[] = [];
    for (let i = start; i < start + CHUNK_SIZE && i < songs.length; i += 1) {
      chunk.push(compactSong(songs[i]));
    }
    chunks.push(chunk);
  }
  return chunks;
}

export async function writeFlatCache(
  context: EchoPluginContext,
  library: WebdavLibraryConfig,
  songs: SongInit[],
  truncated: boolean,
): Promise<void> {
  const chunks = chunkSongs(songs);
  const previousMeta = parseFlatMeta(
    await awaitOperation(context.io.readValue(flatMetaKey(library.id))),
  );
  for (let i = 0; i < chunks.length; i += 1) {
    await awaitOperation(context.io.writeValue(flatChunkKey(library.id, i), chunks[i]));
  }
  await awaitOperation(
    context.io.writeValue(
      flatMetaKey(library.id),
      buildFlatMeta(library, songs.length, chunks.length, truncated),
    ),
  );
  if (previousMeta && previousMeta.chunks > chunks.length) {
    for (let i = chunks.length; i < previousMeta.chunks; i += 1) {
      try {
        await awaitOperation(context.io.removeValue(flatChunkKey(library.id, i)));
      } catch (error) {
        // A missing stale chunk is fine.
      }
    }
  }
}

export async function readFlatCache(
  context: EchoPluginContext,
  library: WebdavLibraryConfig,
): Promise<{ songs: SongInit[]; truncated: boolean } | null> {
  const meta = parseFlatMeta(await awaitOperation(context.io.readValue(flatMetaKey(library.id))));
  if (!meta || !metaMatches(meta, library)) return null;
  const songs: SongInit[] = [];
  for (let i = 0; i < meta.chunks; i += 1) {
    const chunk = await awaitOperation(context.io.readValue(flatChunkKey(library.id, i)));
    if (!Array.isArray(chunk)) return null;
    for (const item of chunk) {
      const song = expandCompactSong(item);
      if (song) songs.push(song);
    }
  }
  if (songs.length !== meta.count) return null;
  return { songs, truncated: meta.truncated };
}

export async function clearFlatCache(context: EchoPluginContext, libraryId: string): Promise<void> {
  const meta = parseFlatMeta(await awaitOperation(context.io.readValue(flatMetaKey(libraryId))));
  if (meta) {
    for (let i = 0; i < meta.chunks; i += 1) {
      try {
        await awaitOperation(context.io.removeValue(flatChunkKey(libraryId, i)));
      } catch (error) {
        // Best-effort cleanup.
      }
    }
  }
  try {
    await awaitOperation(context.io.removeValue(flatMetaKey(libraryId)));
  } catch (error) {
    // Ignore missing meta.
  }
}

export interface FlatScanCallbacks {
  onProgress?: (found: number, scanned: number) => void;
  shouldAbort?: () => boolean;
  /** Receives each in-flight request so callers can cancel it on abort. */
  onOperation?: (operation: { cancel(): void }) => void;
  /** Counts directories whose PROPFIND failed and were skipped. */
  onDirectorySkipped?: () => void;
}

/** Non-zero caps the walk (play folder, and the flat scan's song ceiling);
 * 0 means unlimited. */
export interface CollectOptions extends FlatScanCallbacks {
  cap?: number;
  /** Fires once when the song cap stopped the walk early. */
  onTruncated?: () => void;
}

export class FlatScanAborted extends Error {
  /** Songs collected before the abort; kept so a stopped scan stays usable. */
  readonly partial: SongInit[];
  constructor(partial: SongInit[] = []) {
    super('扫描已中止');
    this.partial = partial;
  }
}

/**
 * Breadth-first walk of every directory under `root`. Directories are probed
 * sequentially — one PROPFIND at a time keeps WebDAV servers that throttle
 * concurrent requests responsive, mirroring the legacy plugin. A directory
 * whose listing fails (403, timeout, redirect loop) is skipped and counted;
 * only a failure on the root itself fails the walk, and visited dirs are
 * remembered so server-side mount cycles can never loop the walk.
 */
export async function collectSongsUnder(
  context: EchoPluginContext,
  endpoint: WebdavEndpoint,
  libraryId: string,
  root: string,
  options: CollectOptions = {},
): Promise<SongInit[]> {
  const cap = options.cap && options.cap > 0 ? options.cap : 0;
  const startDir = normalizeDir(root);
  const queue: string[] = [startDir];
  const visited = new Set<string>([startDir]);
  const songs: SongInit[] = [];
  let scanned = 0;
  let truncated = false;
  while (queue.length > 0) {
    if (options.shouldAbort && options.shouldAbort()) throw new FlatScanAborted(songs);
    if (cap > 0 && songs.length >= cap) {
      truncated = true;
      break;
    }
    const directory = queue.shift() ?? startDir;
    const operation = propfindRequest(context.net, endpoint, directory, SCAN_TIMEOUT_MS);
    if (options.onOperation) options.onOperation(operation);
    const disarm = cancelOperationAfter(context, operation, SCAN_TIMEOUT_MS + 500);
    let entries;
    try {
      const response = await awaitOperation(operation);
      if (!propfindStatusOk(response.status)) {
        throw new Error(`PROPFIND ${directory} 失败（HTTP ${response.status}）`);
      }
      entries = parsePropfind(typeof response.data === 'string' ? response.data : '');
    } catch (error) {
      // A cancel lands here as a generic error; report it as an abort with
      // everything collected so far.
      if (options.shouldAbort && options.shouldAbort()) throw new FlatScanAborted(songs);
      // The root failing means nothing on the server can be listed — surface
      // the real error instead of reporting an empty "success".
      if (directory === startDir) throw error;
      // One unreadable sub-directory must not fail the whole walk: the
      // legacy plugin skipped it and kept scanning.
      if (options.onDirectorySkipped) options.onDirectorySkipped();
      continue;
    } finally {
      disarm();
    }
    scanned += 1;
    for (const entry of entries) {
      if (entry.path === directory) continue;
      if (entry.isCollection) {
        if (!visited.has(entry.path)) {
          visited.add(entry.path);
          queue.push(entry.path);
        }
      } else if (isAudioFile(entry.name)) {
        songs.push(
          songFromEntry({
            libraryId,
            path: entry.path,
            name: entry.name,
            size: entry.contentLength,
          }),
        );
        if (cap > 0 && songs.length >= cap) {
          truncated = true;
          break;
        }
      }
    }
    if (options.onProgress) options.onProgress(songs.length, scanned);
  }
  if (truncated && options.onTruncated) options.onTruncated();
  return songs;
}

/** Full-library scan from the configured root, without a song cap. */
export async function scanLibraryFlat(
  context: EchoPluginContext,
  library: WebdavLibraryConfig,
  callbacks: FlatScanCallbacks = {},
): Promise<SongInit[]> {
  const endpoint = endpointOf(library);
  return collectSongsUnder(context, endpoint, library.id, endpoint.rootPath, callbacks);
}

// Metadata and cover enrichment for scanned songs: host FFmpeg metadata for
// text tags and duration, bounded header reads for embedded covers/lyrics,
// folder images as cover fallback and optional Kugou completion. Text tags
// mutate the song records in place; covers are persisted per song id in the
// KV store behind a small index so stale entries can be cleaned up.

import { awaitOperation } from 'echo:plugin-sdk';
import type { EchoPluginContext, FileReference, KugouDto_domain_SearchSong } from 'echo:plugin-sdk';
import { cancelOperationAfter, raceTimeout } from './async.ts';
import { asArrayBuffer, bytesToBase64, coerceJsonArray } from './codec.ts';
import { extensionOf, type SongInit } from './library.ts';
import { coverDataUrl, id3TagSize, parseAudioTags, type AudioTags } from './tags.ts';

const HEAD_PROBE_BYTES = 256 * 1024;
const TAG_REREAD_MARGIN = 64 * 1024;
const MAX_TAG_READ = 4 * 1024 * 1024;
const FOLDER_COVER_LIMIT = 1024 * 1024;
const METADATA_TIMEOUT_MS = 10000;
const COVER_BUDGET_MS = 1600;
const KUGOU_TIMEOUT_MS = 2500;
/** Embedded art larger than this is skipped to keep the KV store light. */
export const COVER_STORE_LIMIT = 384 * 1024;
const ENRICH_POOL = 6;
const COVER_POOL = 4;
const TAG_CACHE_LIMIT = 300;

export const COVER_INDEX_KEY = 'coverIndex';

export function coverKey(songId: string): string {
  return `cover:${songId}`;
}

export async function readCover(context: EchoPluginContext, songId: string): Promise<string> {
  try {
    const value = await awaitOperation(context.io.readValue(coverKey(songId)));
    return typeof value === 'string' ? value : '';
  } catch (error) {
    return '';
  }
}

export async function writeCover(
  context: EchoPluginContext,
  songId: string,
  url: string,
): Promise<void> {
  if (!url) return;
  try {
    await awaitOperation(context.io.writeValue(coverKey(songId), url));
    const indexValue = await awaitOperation(context.io.readValue(COVER_INDEX_KEY));
    const index: string[] = [];
    const seen: { [key: string]: boolean } = {};
    for (const item of coerceJsonArray(indexValue)) {
      if (typeof item === 'string' && item && !seen[item]) {
        seen[item] = true;
        index.push(item);
      }
    }
    if (!seen[songId]) index.push(songId);
    await awaitOperation(context.io.writeValue(COVER_INDEX_KEY, index));
  } catch (error) {
    // A failed cover write must not break enrichment.
  }
}

/** Drops cover entries whose song no longer exists after a rescan. */
export async function cleanupCovers(
  context: EchoPluginContext,
  validIds: { has(songId: string): boolean },
): Promise<void> {
  try {
    const indexValue = await awaitOperation(context.io.readValue(COVER_INDEX_KEY));
    const kept: string[] = [];
    for (const item of coerceJsonArray(indexValue)) {
      if (typeof item !== 'string' || !item) continue;
      if (validIds.has(item)) {
        kept.push(item);
        continue;
      }
      try {
        await awaitOperation(context.io.removeValue(coverKey(item)));
      } catch (error) {
        // Best-effort cleanup.
      }
    }
    await awaitOperation(context.io.writeValue(COVER_INDEX_KEY, kept));
  } catch (error) {
    // A missing index simply means nothing to clean.
  }
}

// ── Embedded tag reading ───────────────────────────────────────────────────

export interface TagReader {
  readTags(folderId: string, path: string): Promise<AudioTags | null>;
  dispose(): void;
}

function imageMimeFor(extension: string): string {
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'gif') return 'image/gif';
  if (extension === 'bmp') return 'image/bmp';
  return 'image/jpeg';
}

/** Bounded header read that follows the ID3 declared size when the probe
 * window was too small to hold the whole tag. */
async function readTagBytes(
  context: EchoPluginContext,
  ref: FileReference,
): Promise<Uint8Array | null> {
  try {
    const probe = await awaitOperation(
      context.files.readBytes(ref, { maxBytes: HEAD_PROBE_BYTES }),
    );
    const buffer = asArrayBuffer(probe && probe.bytes);
    if (!buffer || buffer.byteLength === 0) return null;
    const bytes = new Uint8Array(buffer);
    const declared = id3TagSize(bytes);
    if (declared > 0 && declared + 10 > bytes.byteLength) {
      const wanted = Math.min(declared + 10 + TAG_REREAD_MARGIN, MAX_TAG_READ);
      try {
        const full = await awaitOperation(context.files.readBytes(ref, { maxBytes: wanted }));
        const fullBuffer = asArrayBuffer(full && full.bytes);
        if (fullBuffer && fullBuffer.byteLength > bytes.byteLength) {
          return new Uint8Array(fullBuffer);
        }
      } catch (error) {
        // Fall back to the probe below; a truncated tag beats nothing.
      }
    }
    return bytes;
  } catch (error) {
    return null;
  }
}

export function createTagReader(
  context: EchoPluginContext,
  refFor: (folderId: string) => FileReference | null,
): TagReader {
  const cache = new Map<string, AudioTags | null>();
  const inflight = new Map<string, Promise<AudioTags | null>>();

  function bound(key: string, value: AudioTags | null): void {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, value);
    while (cache.size > TAG_CACHE_LIMIT) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }

  async function readTags(folderId: string, path: string): Promise<AudioTags | null> {
    const key = `${folderId}|${path}`;
    if (cache.has(key)) return cache.get(key) ?? null;
    const existing = inflight.get(key);
    if (existing) return existing;
    const promise = (async () => {
      try {
        const ref = refFor(folderId);
        if (!ref) return null;
        const bytes = await readTagBytes(context, { ...ref, path });
        if (!bytes) {
          bound(key, null);
          return null;
        }
        const tags = parseAudioTags(bytes);
        bound(key, tags);
        return tags;
      } catch (error) {
        bound(key, null);
        return null;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, promise);
    return promise;
  }

  return {
    readTags,
    dispose() {
      cache.clear();
      inflight.clear();
    },
  };
}

// ── Text metadata pass ─────────────────────────────────────────────────────

export interface EnrichCallbacks {
  shouldAbort?: () => boolean;
  onOperation?: (operation: { cancel(): void }) => void;
  onProgress?: (done: number, total: number) => void;
}

function applyMedia(
  song: SongInit,
  media:
    | {
        title: string | null;
        artist: string | null;
        album: string | null;
        durationMs: number | null;
      }
    | null
    | undefined,
): boolean {
  if (!media) return false;
  let changed = false;
  if (media.title && media.title !== song.title) {
    song.title = media.title;
    changed = true;
  }
  if (media.artist && media.artist !== song.artist) {
    song.artist = media.artist;
    changed = true;
  }
  if (media.album && media.album !== song.album) {
    song.album = media.album;
    changed = true;
  }
  if (typeof media.durationMs === 'number' && media.durationMs > 0) {
    const rounded = Math.round(media.durationMs);
    if (rounded !== song.durationMs) {
      song.durationMs = rounded;
      changed = true;
    }
  }
  return changed;
}

/** Reads host metadata for every song with a small concurrency pool. */
export async function enrichMetadata(
  context: EchoPluginContext,
  songs: SongInit[],
  refFor: (folderId: string) => FileReference | null,
  callbacks: EnrichCallbacks = {},
): Promise<void> {
  const total = songs.length;
  let done = 0;
  let index = 0;
  const announce = () => {
    if (callbacks.onProgress) callbacks.onProgress(done, total);
  };
  announce();
  const worker = async (): Promise<void> => {
    while (index < total) {
      if (callbacks.shouldAbort && callbacks.shouldAbort()) throw new Error('扫描已中止');
      const song = songs[index];
      index += 1;
      const ref = refFor(song.folderId);
      if (ref) {
        const operation = context.files.metadata({ ...ref, path: song.path });
        if (callbacks.onOperation) callbacks.onOperation(operation);
        const disarm = cancelOperationAfter(context, operation, METADATA_TIMEOUT_MS + 500);
        try {
          const result = await awaitOperation(operation);
          applyMedia(song, result && result.media ? result.media : null);
        } catch (error) {
          // Unreadable file: keep the filename-parsed identity.
        } finally {
          disarm();
        }
      }
      done += 1;
      announce();
    }
  };
  const runners: Promise<void>[] = [];
  for (let i = 0; i < Math.min(ENRICH_POOL, total); i += 1) runners.push(worker());
  await Promise.all(runners);
}

// ── Cover pass ─────────────────────────────────────────────────────────────

export interface CoverJob {
  song: SongInit;
  /** Folder cover image path inside the same directory, or ''. */
  folderCover: string;
}

export interface CoverCallbacks extends EnrichCallbacks {
  /** Persists a resolved cover; called once per newly resolved song. */
  onCover?: (songId: string, url: string) => Promise<void>;
}

async function embeddedCover(tags: AudioTags | null): Promise<string> {
  if (!tags || !tags.coverData || tags.coverData.length === 0) return '';
  if (tags.coverData.length > COVER_STORE_LIMIT) return '';
  return coverDataUrl(tags);
}

async function folderCover(
  context: EchoPluginContext,
  refFor: (folderId: string) => FileReference | null,
  job: CoverJob,
): Promise<string> {
  if (!job.folderCover) return '';
  const ref = refFor(job.song.folderId);
  if (!ref) return '';
  try {
    const result = await awaitOperation(
      context.files.readBytes({ ...ref, path: job.folderCover }, { maxBytes: FOLDER_COVER_LIMIT }),
    );
    const buffer = asArrayBuffer(result && result.bytes);
    if (!buffer || buffer.byteLength === 0) return '';
    const mime = imageMimeFor(extensionOf(job.folderCover));
    return `data:${mime};base64,${bytesToBase64(new Uint8Array(buffer))}`;
  } catch (error) {
    return '';
  }
}

function artistNames(song: KugouDto_domain_SearchSong): string {
  const names: string[] = [];
  const artists = Array.isArray(song.artists) ? song.artists : [];
  for (const artist of artists) {
    if (artist && artist.name) names.push(artist.name);
  }
  return names.join('/');
}

async function kugouCover(
  context: EchoPluginContext,
  title: string,
  artist: string,
): Promise<string> {
  const keyword = `${artist} ${title}`.trim() || title;
  if (!keyword) return '';
  try {
    const operation = context.kugou.request('search', {
      kind: 'song',
      keyword,
      page: 1,
      pageSize: 3,
    });
    const disarm = cancelOperationAfter(context, operation, KUGOU_TIMEOUT_MS);
    let response;
    try {
      response = await raceTimeout(context, awaitOperation(operation), KUGOU_TIMEOUT_MS + 250);
    } finally {
      disarm();
    }
    if (!response || response.kind !== 'songs') return '';
    const items = response.page && Array.isArray(response.page.items) ? response.page.items : [];
    const match = items.length > 0 ? items[0] : null;
    return match ? match.cover_url || '' : '';
  } catch (error) {
    return '';
  }
}

/** Resolves one cover: embedded art first, then the folder image, then an
 * optional Kugou lookup. Returns '' when nothing was found. */
async function resolveCover(
  context: EchoPluginContext,
  refFor: (folderId: string) => FileReference | null,
  tagReader: TagReader | null,
  job: CoverJob,
  onlineFetch: boolean,
): Promise<string> {
  if (tagReader) {
    const tags = await raceTimeout(
      context,
      tagReader.readTags(job.song.folderId, job.song.path),
      COVER_BUDGET_MS,
    );
    const embedded = await embeddedCover(tags);
    if (embedded) return embedded;
  }
  const folder = await folderCover(context, refFor, job);
  if (folder) return folder;
  if (onlineFetch) {
    return kugouCover(context, job.song.title, job.song.artist);
  }
  return '';
}

/** Resolves covers for album representatives that have none cached yet. */
export async function enrichCovers(
  context: EchoPluginContext,
  jobs: CoverJob[],
  refFor: (folderId: string) => FileReference | null,
  tagReader: TagReader | null,
  callbacks: CoverCallbacks = {},
  onlineFetch: boolean,
): Promise<void> {
  const pending: CoverJob[] = [];
  for (const job of jobs) {
    const cached = await readCover(context, job.song.id);
    if (!cached) pending.push(job);
  }
  const total = pending.length;
  let done = 0;
  let index = 0;
  const announce = () => {
    if (callbacks.onProgress) callbacks.onProgress(done, total);
  };
  announce();
  const worker = async (): Promise<void> => {
    while (index < pending.length) {
      if (callbacks.shouldAbort && callbacks.shouldAbort()) throw new Error('扫描已中止');
      const job = pending[index];
      index += 1;
      const url = await resolveCover(context, refFor, tagReader, job, onlineFetch);
      if (url && callbacks.onCover) {
        await callbacks.onCover(job.song.id, url);
      }
      done += 1;
      announce();
    }
  };
  const runners: Promise<void>[] = [];
  for (let i = 0; i < Math.min(COVER_POOL, total); i += 1) runners.push(worker());
  await Promise.all(runners);
}

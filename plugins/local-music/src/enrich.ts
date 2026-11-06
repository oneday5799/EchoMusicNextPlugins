// Metadata and cover enrichment for scanned songs: host FFmpeg metadata for
// text tags and duration, bounded header reads for embedded covers/lyrics,
// folder images as cover fallback and optional Kugou completion. Text tags
// mutate the song records in place; covers are persisted per song id in the
// KV store, deduplicated by content hash so every song of an album shares
// one stored image instead of copying the art into each entry.

import { awaitOperation } from 'echo:plugin-sdk';
import type {
  EchoPluginContext,
  FileReference,
  JsonValue,
  KugouDto_domain_SearchSong,
} from 'echo:plugin-sdk';
import { cancelOperationAfter, raceTimeout } from './async.ts';
import { asArrayBuffer, bytesToBase64, coerceJsonArray } from './codec.ts';
import { extensionOf, type SongInit } from './library.ts';
import { coverDataUrl, id3TagSize, parseAudioTags, type AudioTags } from './tags.ts';

const HEAD_PROBE_BYTES = 256 * 1024;
const TAG_REREAD_MARGIN = 64 * 1024;
const MAX_TAG_READ = 4 * 1024 * 1024;
const FOLDER_COVER_LIMIT = 1024 * 1024;
const METADATA_TIMEOUT_MS = 10000;
const KUGOU_TIMEOUT_MS = 2500;
/** Embedded art larger than this is skipped to keep the KV store light. */
export const COVER_STORE_LIMIT = 384 * 1024;
const ENRICH_POOL = 6;
const TAG_CACHE_LIMIT = 300;

// ── Cover store ────────────────────────────────────────────────────────────
//
// `coverMap`    → { [songId]: `${hash}|${fileSize}` }: which image a song
//                 uses and the song size the art was read from (the rescan
//                 change signal — an unchanged file keeps its entry without
//                 re-reading the tag).
// `coverimg:<hash>` → the data/URL string itself, shared by every song with
//                 the same artwork.
// `coverHashes` → every stored image hash, so cleanup and the clear command
//                 can enumerate images without a KV key listing API.
// Legacy pre-dedupe entries (`cover:<songId>` data URLs behind `coverIndex`)
// are dropped on the next scan or clear.

export const COVER_MAP_KEY = 'coverMap';
export const COVER_HASHES_KEY = 'coverHashes';
const LEGACY_COVER_INDEX_KEY = 'coverIndex';
const LEGACY_COVER_PREFIX = 'cover:';

export interface CoverStoreData {
  map: { [songId: string]: string };
  hashes: string[];
}

export function coverImageKey(hash: string): string {
  return `coverimg:${hash}`;
}

export function legacyCoverKey(songId: string): string {
  return `${LEGACY_COVER_PREFIX}${songId}`;
}

function fnv1a(bytes: Uint8Array, basis: number): number {
  let hash = basis >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** ES2016 has no String.padStart; hash words are always 8 hex digits. */
function hex8(value: number): string {
  let text = value.toString(16);
  while (text.length < 8) text = `0${text}`;
  return text;
}

/** Two independent 32-bit FNV passes over the artwork bytes: albums share
 * one stored image, and the 64-bit composite makes cross-content collisions
 * negligible. */
export function coverHashOfBytes(bytes: Uint8Array): string {
  const first = (fnv1a(bytes, 0x811c9dc5) ^ (bytes.length & 0xffff)) >>> 0;
  const second = fnv1a(bytes, 0x46b6d5a3);
  return `${hex8(first)}${hex8(second)}`;
}

export function coverHashOfText(text: string): string {
  let first = 0x811c9dc5;
  let second = 0x46b6d5a3;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ (code + i), 0x01000193) >>> 0;
  }
  return `${hex8(first)}${hex8(second)}`;
}

function parseCoverEntry(entry: JsonValue | undefined): { hash: string; size: number } | null {
  if (typeof entry !== 'string') return null;
  const cut = entry.indexOf('|');
  if (cut <= 0 || cut === entry.length - 1) return null;
  const hash = entry.slice(0, cut);
  const size = Number(entry.slice(cut + 1));
  if (!/^[0-9a-f]{16}$/.test(hash) || !isFinite(size) || size < 0) return null;
  return { hash, size };
}

export function coverEntryHash(entry: string | undefined): string {
  const parsed = parseCoverEntry(entry);
  return parsed ? parsed.hash : '';
}

export function coverEntrySize(entry: string | undefined): number {
  const parsed = parseCoverEntry(entry);
  return parsed ? parsed.size : -1;
}

export function coverEntryFor(hash: string, size: number): string {
  return `${hash}|${Math.max(0, Math.round(size))}`;
}

export async function readCoverStore(context: EchoPluginContext): Promise<CoverStoreData> {
  const store: CoverStoreData = { map: {}, hashes: [] };
  try {
    const mapValue = (await awaitOperation(context.io.readValue(COVER_MAP_KEY))) as JsonValue;
    if (mapValue && typeof mapValue === 'object' && !Array.isArray(mapValue)) {
      const record = mapValue as { [key: string]: JsonValue };
      for (const songId of Object.keys(record)) {
        if (parseCoverEntry(record[songId])) store.map[songId] = String(record[songId]);
      }
    }
    for (const item of coerceJsonArray(
      (await awaitOperation(context.io.readValue(COVER_HASHES_KEY))) as JsonValue,
    )) {
      if (typeof item === 'string' && /^[0-9a-f]{16}$/.test(item) && !store.hashes.includes(item)) {
        store.hashes.push(item);
      }
    }
  } catch (error) {
    // Missing or malformed store starts empty; the scan repopulates it.
  }
  return store;
}

export async function writeCoverStore(
  context: EchoPluginContext,
  store: CoverStoreData,
): Promise<void> {
  await awaitOperation(context.io.writeValue(COVER_MAP_KEY, store.map));
  await awaitOperation(context.io.writeValue(COVER_HASHES_KEY, store.hashes));
}

/** Reads one song's cover through the store. Falls back to the legacy
 * per-song entries until the next scan or clear removes them. */
export async function readSongCover(context: EchoPluginContext, songId: string): Promise<string> {
  try {
    const mapValue = (await awaitOperation(context.io.readValue(COVER_MAP_KEY))) as JsonValue;
    if (mapValue && typeof mapValue === 'object' && !Array.isArray(mapValue)) {
      const hash = coverEntryHash(String((mapValue as { [key: string]: JsonValue })[songId] ?? ''));
      if (hash) {
        const image = (await awaitOperation(
          context.io.readValue(coverImageKey(hash)),
        )) as JsonValue;
        if (typeof image === 'string' && image) return image;
      }
    }
    const legacy = (await awaitOperation(
      context.io.readValue(legacyCoverKey(songId)),
    )) as JsonValue;
    return typeof legacy === 'string' ? legacy : '';
  } catch (error) {
    return '';
  }
}

/** Stores one image once per content hash; callers keep ownership of the
 * store object and flush it with writeCoverStore. */
export async function writeCoverImage(
  context: EchoPluginContext,
  store: CoverStoreData,
  hash: string,
  url: string,
): Promise<void> {
  if (!hash || !url) return;
  if (!store.hashes.includes(hash)) {
    // Claim the slot before the await: the scan pool runs concurrently and
    // two workers carrying identical artwork must not both push the hash.
    store.hashes.push(hash);
    await awaitOperation(context.io.writeValue(coverImageKey(hash), url));
  }
}

/** Drops songs that no longer exist, then images nothing references, then
 * the legacy pre-dedupe entries. */
export async function reconcileCoverStore(
  context: EchoPluginContext,
  validIds: { has(songId: string): boolean },
): Promise<void> {
  try {
    const store = await readCoverStore(context);
    let changed = false;
    for (const songId of Object.keys(store.map)) {
      if (!validIds.has(songId)) {
        delete store.map[songId];
        changed = true;
      }
    }
    const referenced: { [hash: string]: boolean } = {};
    for (const songId of Object.keys(store.map)) {
      referenced[coverEntryHash(store.map[songId])] = true;
    }
    const kept: string[] = [];
    for (const hash of store.hashes) {
      if (referenced[hash]) {
        kept.push(hash);
        continue;
      }
      changed = true;
      try {
        await awaitOperation(context.io.removeValue(coverImageKey(hash)));
      } catch (error) {
        // Best-effort image cleanup.
      }
    }
    if (changed || kept.length !== store.hashes.length) {
      store.hashes = kept;
      await writeCoverStore(context, store);
    }
    await cleanupLegacyCovers(context);
  } catch (error) {
    // A broken store must not fail the scan.
  }
}

/** Removes the pre-dedupe per-song data URLs after their content moved into
 * the deduplicated store (or was cleared). */
export async function cleanupLegacyCovers(context: EchoPluginContext): Promise<void> {
  try {
    const indexValue = (await awaitOperation(
      context.io.readValue(LEGACY_COVER_INDEX_KEY),
    )) as JsonValue;
    const ids = coerceJsonArray(indexValue).filter(
      (item): item is string => typeof item === 'string' && item.length > 0,
    );
    for (const songId of ids) {
      try {
        await awaitOperation(context.io.removeValue(legacyCoverKey(songId)));
      } catch (error) {
        // Best-effort.
      }
    }
    await awaitOperation(context.io.removeValue(LEGACY_COVER_INDEX_KEY));
  } catch (error) {
    // No legacy index: nothing to migrate.
  }
}

/** Removes every persisted cover entry, image and legacy leftover. Returns
 * the number of song entries and images dropped. */
export async function clearCoverStore(
  context: EchoPluginContext,
): Promise<{ entries: number; images: number }> {
  let entries = 0;
  let images = 0;
  try {
    const store = await readCoverStore(context);
    entries += Object.keys(store.map).length;
    for (const hash of store.hashes) {
      try {
        await awaitOperation(context.io.removeValue(coverImageKey(hash)));
        images += 1;
      } catch (error) {
        // Best-effort.
      }
    }
  } catch (error) {
    // Continue with the legacy sweep below.
  }
  try {
    const indexValue = (await awaitOperation(
      context.io.readValue(LEGACY_COVER_INDEX_KEY),
    )) as JsonValue;
    const ids = coerceJsonArray(indexValue).filter(
      (item): item is string => typeof item === 'string' && item.length > 0,
    );
    entries += ids.length;
    for (const songId of ids) {
      try {
        await awaitOperation(context.io.removeValue(legacyCoverKey(songId)));
      } catch (error) {
        // Best-effort.
      }
    }
    await awaitOperation(context.io.removeValue(LEGACY_COVER_INDEX_KEY));
  } catch (error) {
    // No legacy index.
  }
  try {
    await awaitOperation(context.io.removeValue(COVER_MAP_KEY));
    await awaitOperation(context.io.removeValue(COVER_HASHES_KEY));
  } catch (error) {
    // Best-effort.
  }
  return { entries, images };
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

// ── Cover resolution helpers ───────────────────────────────────────────────
//
// The scan pass in entry.ts owns the store object and progress reporting;
// these helpers resolve a cover from one source at a time.

/** Embedded art within the store limit, as a data URL; '' when absent. */
export function embeddedCoverUrl(tags: AudioTags | null): string {
  if (!tags || !tags.coverData || tags.coverData.length === 0) return '';
  if (tags.coverData.length > COVER_STORE_LIMIT) return '';
  return coverDataUrl(tags);
}

/** Folder cover image read into a data URL; '' when absent or unreadable. */
export async function folderCoverUrl(
  context: EchoPluginContext,
  refFor: (folderId: string) => FileReference | null,
  folderId: string,
  folderCoverPath: string,
): Promise<string> {
  if (!folderCoverPath) return '';
  const ref = refFor(folderId);
  if (!ref) return '';
  try {
    const result = await awaitOperation(
      context.files.readBytes({ ...ref, path: folderCoverPath }, { maxBytes: FOLDER_COVER_LIMIT }),
    );
    const buffer = asArrayBuffer(result && result.bytes);
    if (!buffer || buffer.byteLength === 0) return '';
    const mime = imageMimeFor(extensionOf(folderCoverPath));
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

/** Online completion: first search hit's cover URL; '' when none. */
export async function kugouCover(
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

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
import { cancelOperationAfter, delay, raceTimeout, type WorkPacer } from './async.ts';
import { asArrayBuffer, bytesToBase64, bytesToBase64Range, coerceJsonArray } from './codec.ts';
import { extensionOf, type SongInit } from './library.ts';
import { coverDataUrl, parseAudioTags, tagReadTarget, type AudioTags } from './tags.ts';

const HEAD_PROBE_BYTES = 256 * 1024;
const TAG_REREAD_MARGIN = 64 * 1024;
const MAX_TAG_READ = 4 * 1024 * 1024;
/** Folder images above this are not used. Same math as COVER_STORE_LIMIT:
 * the data URL (×4/3) must stay far under the KV's 1 MiB per-value cap —
 * 600 KB of image becomes an ~800 KB value. */
const FOLDER_COVER_LIMIT = 600 * 1024;
const METADATA_TIMEOUT_MS = 10000;
const KUGOU_TIMEOUT_MS = 2500;
/** Embedded art above this is not persisted. The KV caps a single value at
 * 1 MiB, so the base64 data URL (×4/3) must stay well under it — 640 KB of
 * art becomes an ~853 KB value. Most real front covers fit; larger ones
 * fall back to folder image or online completion. */
export const COVER_STORE_LIMIT = 640 * 1024;
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
/** The removed browse diagnostics (fdc4257) persisted every request/reply
 * into a 12-slot KV ring plus two single keys; their snapshots (up to ~1.6
 * MB of stale data) survive in existing installs. The io service has no key
 * listing, but the ring wrote only these known names, so they can be swept
 * exactly. */
const LEGACY_DIAG_SLOTS = 12;
const LEGACY_DIAG_KEYS = [
  '__diag',
  '__diag2',
  ...Array.from({ length: LEGACY_DIAG_SLOTS }, (_, slot) => `__diag:${slot}`),
];

/** Removes every legacy diagnostic snapshot key. Absent keys are the normal
 * case after the first sweep. */
export async function sweepLegacyDiagnosticKeys(context: EchoPluginContext): Promise<void> {
  for (const key of LEGACY_DIAG_KEYS) {
    try {
      await awaitOperation(context.io.removeValue(key));
    } catch (error) {
      // Best-effort hygiene.
    }
  }
}

/** Removes `cover:<songId>` data URLs, counting only keys that actually
 * existed (removeValue succeeds for absent keys too); shared by the
 * legacy-index sweep and the orphan sweep for known song ids. */
async function removeLegacyCoverKeys(
  context: EchoPluginContext,
  songIds: readonly string[],
): Promise<number> {
  let removed = 0;
  for (const songId of songIds) {
    try {
      const existing = await awaitOperation(context.io.readValue(legacyCoverKey(songId)));
      if (existing === undefined) continue;
      await awaitOperation(context.io.removeValue(legacyCoverKey(songId)));
      removed += 1;
    } catch (error) {
      // Best-effort.
    }
  }
  return removed;
}

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

// Hashing the artwork bytes is per-song work even when every track of an
// album carries the same image, and for large covers the two FNV passes
// cost more main-thread time than the rest of the pass combined. The memo
// keys by byte-object identity: the tag reader's in-memory cache hands the
// same AudioTags (and thus the same coverData reference) back for every
// re-scan of an unchanged file within the session, so the FNV passes run
// once per read instead of once per scan. A fresh read — new session,
// changed file — is a different object and is hashed again, so the memo
// can never answer with a stale hash.

const coverHashByBytes = new WeakMap<Uint8Array, string>();

/** Content hash for one file's artwork bytes, memoized per byte identity. */
export function coverHashOfTagBytes(bytes: Uint8Array): string {
  const memo = coverHashByBytes.get(bytes);
  if (memo !== undefined) return memo;
  const hash = coverHashOfBytes(bytes);
  coverHashByBytes.set(bytes, hash);
  return hash;
}

const COVER_FULL_HASH_MAX = 160 * 1024;
const COVER_FINGERPRINT_BYTES = 64 * 1024;

/** Per-pass hash resolver. Covers up to COVER_FULL_HASH_MAX hash directly
 * (the FNV passes are cheap at that size); larger artwork fingerprints
 * through head+tail 64 KiB and the exact length, and identical artwork —
 * every track of an album — hashes its full bytes only once per pass. */
export function createCoverHashResolver(): (bytes: Uint8Array) => string {
  const byFingerprint = new Map<string, string>();
  return (bytes: Uint8Array): string => {
    if (bytes.length <= COVER_FULL_HASH_MAX) return coverHashOfTagBytes(bytes);
    const fingerprint =
      coverHashOfBytes(bytes.subarray(0, COVER_FINGERPRINT_BYTES)) +
      coverHashOfBytes(bytes.subarray(bytes.length - COVER_FINGERPRINT_BYTES)) +
      `:${bytes.length}`;
    const known = byFingerprint.get(fingerprint);
    if (known !== undefined) return known;
    const hash = coverHashOfTagBytes(bytes);
    byFingerprint.set(fingerprint, hash);
    return hash;
  };
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
    try {
      await awaitOperation(context.io.writeValue(coverImageKey(hash), url));
    } catch (error) {
      // Roll the claim back: a dangling hash with no coverimg value behind
      // it would make every rescan skip the songs that reference it.
      store.hashes = store.hashes.filter((existing) => existing !== hash);
      throw error;
    }
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
 * the deduplicated store (or was cleared). `extraSongIds` sweeps additional
 * known song ids (e.g. the current library) whose legacy entry may survive a
 * lost or interrupted index — a per-song key whose song vanished from the
 * library entirely cannot be discovered without a KV key listing API. */
export async function cleanupLegacyCovers(
  context: EchoPluginContext,
  extraSongIds: readonly string[] = [],
): Promise<void> {
  try {
    const indexValue = (await awaitOperation(
      context.io.readValue(LEGACY_COVER_INDEX_KEY),
    )) as JsonValue;
    const ids = coerceJsonArray(indexValue).filter(
      (item): item is string => typeof item === 'string' && item.length > 0,
    );
    await removeLegacyCoverKeys(context, ids);
    await awaitOperation(context.io.removeValue(LEGACY_COVER_INDEX_KEY));
  } catch (error) {
    // No legacy index: nothing to migrate.
  }
  if (extraSongIds.length > 0) {
    await removeLegacyCoverKeys(context, extraSongIds);
  }
}

/** Removes every persisted cover entry, image and legacy leftover. Returns
 * the number of song entries and images dropped. `extraSongIds` extends the
 * legacy sweep beyond the stored index (see cleanupLegacyCovers). */
export async function clearCoverStore(
  context: EchoPluginContext,
  extraSongIds: readonly string[] = [],
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
    entries += await removeLegacyCoverKeys(context, ids);
    await awaitOperation(context.io.removeValue(LEGACY_COVER_INDEX_KEY));
  } catch (error) {
    // No legacy index.
  }
  if (extraSongIds.length > 0) {
    entries += await removeLegacyCoverKeys(context, extraSongIds);
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

/** Bounded header read that follows the declared ID3 size or FLAC metadata
 * extent when the probe window was too small to hold them — a large
 * embedded picture is the usual culprit and hides the cover entirely. */
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
    const declared = tagReadTarget(bytes);
    if (declared <= bytes.byteLength) return bytes;
    const wanted = Math.min(declared + TAG_REREAD_MARGIN, MAX_TAG_READ);
    try {
      const full = await awaitOperation(context.files.readBytes(ref, { maxBytes: wanted }));
      const fullBuffer = asArrayBuffer(full && full.bytes);
      if (fullBuffer && fullBuffer.byteLength > bytes.byteLength) {
        return new Uint8Array(fullBuffer);
      }
    } catch (error) {
      // Fall back to the probe below; a truncated tag beats nothing.
    }
    return bytes;
  } catch (error) {
    return null;
  }
}

export function createTagReader(
  context: EchoPluginContext,
  refFor: (folderId: string) => FileReference | null,
  pacer?: WorkPacer,
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
        if (!bytes) return null;
        // Parsing the header bytes is the readTags path's heaviest
        // synchronous block; running it through the shared pacer (when one
        // is wired in) keeps concurrent scan workers from chaining their
        // blocks back-to-back inside a single event-loop pass.
        const tags = pacer ? await pacer.run(() => parseAudioTags(bytes)) : parseAudioTags(bytes);
        // Only a genuine parse result is cached — a failed or empty read
        // may be a transient io hiccup, and caching null would pin it for
        // the session (play-time lookups would never retry).
        bound(key, tags);
        return tags;
      } catch (error) {
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

/** Reads host metadata for every song with a small concurrency pool. Songs
 * already carrying enriched metadata for their current file content (see
 * carryOverMetadata) are skipped, so rescanning an unchanged library issues
 * no per-song round trips at all. */
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
      if (song.enriched) {
        done += 1;
        announce();
        continue;
      }
      const ref = refFor(song.folderId);
      if (ref) {
        const operation = context.files.metadata({ ...ref, path: song.path });
        if (callbacks.onOperation) callbacks.onOperation(operation);
        const disarm = cancelOperationAfter(context, operation, METADATA_TIMEOUT_MS + 500);
        try {
          const result = await awaitOperation(operation);
          const media = result && result.media ? result.media : null;
          applyMedia(song, media);
          // Only a reply that actually carried media marks the song: a null
          // or failed read may be transient, and pinning it would freeze the
          // filename-parsed identity until the file size changes.
          if (media) song.enriched = true;
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

// Encoding a cover data URL is the cover pass's most expensive synchronous
// work: bytesToBase64 walks every image byte, so an 800 KB artwork holds
// the main thread for well over 100 ms. Two counters keep it from stalling
// the scan: a session memo keyed by content hash (duplicate artwork across
// songs — every track of an album — and a re-scan after clear cache reuse
// the already-encoded URL) and a chunked encoder that yields to the event
// loop between chunks so one encode never holds a frame hostage.

const COVER_ENCODE_CHUNK = 49152; // 48 KiB, multiple of 3
const COVER_URL_MEMO_LIMIT = 32;

const coverUrlMemo = new Map<string, string>();

function memoCoverUrl(hash: string, url: string): void {
  if (coverUrlMemo.has(hash)) coverUrlMemo.delete(hash);
  coverUrlMemo.set(hash, url);
  while (coverUrlMemo.size > COVER_URL_MEMO_LIMIT) {
    const oldest = coverUrlMemo.keys().next();
    if (oldest.done) break;
    coverUrlMemo.delete(oldest.value);
  }
}

/** Cover data URL for embedded art: reuses the session memo per content
 * hash and otherwise encodes the bytes in bounded chunks, yielding to the
 * event loop between chunks. '' when there is nothing (or too much) to
 * store. */
export async function encodedCoverUrl(
  context: EchoPluginContext,
  hash: string,
  bytes: Uint8Array,
  mime: string,
): Promise<string> {
  if (!hash || !bytes || bytes.length === 0) return '';
  if (bytes.length > COVER_STORE_LIMIT) return '';
  const memo = coverUrlMemo.get(hash);
  if (memo !== undefined) return memo;
  const parts: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    const end = Math.min(bytes.length, start + COVER_ENCODE_CHUNK);
    parts.push(bytesToBase64Range(bytes, start, end));
    start = end;
    if (start < bytes.length) await delay(context, 0);
  }
  const url = `data:${mime || 'image/jpeg'};base64,${parts.join('')}`;
  memoCoverUrl(hash, url);
  return url;
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

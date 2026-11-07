// Lyric resolver: the sidecar .lrc/.txt file found during the scan first,
// then embedded USLT/Vorbis lyrics, then an optional Kugou lookup. Every hop
// runs under a shared deadline with per-step budgets.

import { awaitOperation } from 'echo:plugin-sdk';
import type {
  EchoPluginContext,
  FileReference,
  JsonValue,
  KugouDto_lyric_Lyrics,
  KugouDto_search_lyric_Candidate,
  LyricDocument,
  LyricResolverContext,
} from 'echo:plugin-sdk';
import { raceTimeout } from './async.ts';
import { coerceJsonArray } from './codec.ts';
import { buildLrcFromKugou, pickLyricCandidate } from './lrc.ts';
import { baseName, dirNameOf, parseSourceId, stripExtension, trackDataString } from './library.ts';
import type { AudioTags } from './tags.ts';

const RESOLVER_DEADLINE_MS = 2200;
const STEP_BUDGET_MS = 900;
const LYRIC_READ_LIMIT = 512 * 1024;
const LYRIC_CACHE_LIMIT = 200;
/** Persisted-lyric KV reads and writes must not stretch the resolver deadline. */
const LYRIC_PERSIST_BUDGET_MS = 600;

// ── Persisted online lyrics ────────────────────────────────────────────────
//
// Kugou lyrics fetched while playing are stored per song id so later plays
// never repeat the online round trip. Records keep the title/artist they
// were matched with, so a retagged file re-resolves instead of serving a
// stale match. `lyricIndex` enumerates the ids for cleanup and the clear
// command (the KV store has no key listing).

const LYRIC_INDEX_KEY = 'lyricIndex';
const LYRIC_STORE_PREFIX = 'lyric:';

// The lyric index is a read-modify-write cycle on one KV value: two songs
// persisting concurrently (playback resolution is not serialized) would
// both read the index and the second write would clobber the first, leaving
// the loser's record orphaned. A task chain serializes the cycles.
let lyricStoreChain: Promise<unknown> = Promise.resolve();

function queueLyricStoreTask<T>(task: () => Promise<T>): Promise<T> {
  const next = lyricStoreChain.then(task, task);
  lyricStoreChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function lyricStoreKey(songId: string): string {
  return `${LYRIC_STORE_PREFIX}${songId}`;
}

interface PersistedLyricRecord extends Record<string, JsonValue> {
  t: string;
  a: string;
  format: string;
  content: string;
  translation: string;
  romanization: string;
  source: string;
}

function parsePersistedLyric(value: JsonValue | undefined): PersistedLyricRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as { [key: string]: JsonValue };
  if (typeof record.content !== 'string' || !record.content) return null;
  const text = (key: string): string => (typeof record[key] === 'string' ? record[key] : '');
  return {
    t: text('t'),
    a: text('a'),
    format: 'lrc',
    content: record.content,
    translation: text('translation'),
    romanization: text('romanization'),
    source: text('source') || '酷狗歌词',
  };
}

/** Online lyric stored for this song on an earlier play, when the track
 * identity still matches. */
export async function readPersistedLyric(
  context: EchoPluginContext,
  songId: string,
  title: string,
  artist: string,
): Promise<LyricDocument | null> {
  try {
    const value = (await awaitOperation(context.io.readValue(lyricStoreKey(songId)))) as JsonValue;
    const record = parsePersistedLyric(value);
    if (!record || record.t !== title || record.a !== artist) return null;
    return {
      format: 'lrc',
      content: record.content,
      translation: record.translation,
      romanization: record.romanization,
      source: record.source,
    };
  } catch (error) {
    return null;
  }
}

export async function persistLyric(
  context: EchoPluginContext,
  songId: string,
  title: string,
  artist: string,
  document: LyricDocument,
): Promise<void> {
  if (!songId || !document.content) return;
  const record: PersistedLyricRecord = {
    t: title,
    a: artist,
    format: 'lrc',
    content: document.content,
    translation: document.translation || '',
    romanization: document.romanization || '',
    source: document.source || '酷狗歌词',
  };
  await awaitOperation(context.io.writeValue(lyricStoreKey(songId), record));
  await queueLyricStoreTask(async () => {
    const indexValue = (await awaitOperation(context.io.readValue(LYRIC_INDEX_KEY))) as JsonValue;
    const index: string[] = [];
    const seen: { [songId: string]: boolean } = {};
    for (const item of coerceJsonArray(indexValue)) {
      if (typeof item === 'string' && item && !seen[item]) {
        seen[item] = true;
        index.push(item);
      }
    }
    if (!seen[songId]) index.push(songId);
    await awaitOperation(context.io.writeValue(LYRIC_INDEX_KEY, index));
  });
}

/** Removes every stored lyric record; returns how many were dropped. */
export async function clearLyricStore(context: EchoPluginContext): Promise<number> {
  return queueLyricStoreTask(async () => {
    let count = 0;
    try {
      const indexValue = (await awaitOperation(context.io.readValue(LYRIC_INDEX_KEY))) as JsonValue;
      for (const item of coerceJsonArray(indexValue)) {
        if (typeof item !== 'string' || !item) continue;
        try {
          await awaitOperation(context.io.removeValue(lyricStoreKey(item)));
          count += 1;
        } catch (error) {
          // Best-effort.
        }
      }
      await awaitOperation(context.io.removeValue(LYRIC_INDEX_KEY));
    } catch (error) {
      // No index: nothing persisted.
    }
    return count;
  });
}

/** Drops lyric records for songs that no longer exist after a rescan. */
export async function reconcileLyricStore(
  context: EchoPluginContext,
  validIds: { has(songId: string): boolean },
): Promise<void> {
  await queueLyricStoreTask(async () => {
    try {
      const indexValue = (await awaitOperation(context.io.readValue(LYRIC_INDEX_KEY))) as JsonValue;
      const kept: string[] = [];
      for (const item of coerceJsonArray(indexValue)) {
        if (typeof item !== 'string' || !item) continue;
        if (validIds.has(item)) {
          kept.push(item);
          continue;
        }
        try {
          await awaitOperation(context.io.removeValue(lyricStoreKey(item)));
        } catch (error) {
          // Best-effort.
        }
      }
      await awaitOperation(context.io.writeValue(LYRIC_INDEX_KEY, kept));
    } catch (error) {
      // No index: nothing to clean.
    }
  });
}

interface LyricEngineOptions {
  onlineFetch: () => boolean;
  /** Mirrors the settings switch: when off, embedded lyrics are skipped. */
  readEmbedded: () => boolean;
  readTags(folderId: string, path: string): Promise<AudioTags | null>;
  /** Builds a file reference for a lyric read, or null when ungranted. */
  fileRef(folderId: string, path: string): FileReference | null;
}

export interface LyricEngine {
  resolve(resolverContext: LyricResolverContext): Promise<LyricDocument | null>;
}

interface LyricTarget {
  folderId: string;
  songId: string;
  path: string;
  sidecarPath: string;
}

function targetOf(context: LyricResolverContext): LyricTarget | null {
  const parsed = parseSourceId(context.track.sourceId ?? '');
  if (!parsed) return null;
  const data = context.track.data;
  const path = trackDataString(data, 'p');
  if (!path) return null;
  const explicit = trackDataString(data, 'ly');
  const base = stripExtension(baseName(path)).toLowerCase();
  const sidecar = explicit || `${dirNameOf(path) ? `${dirNameOf(path)}/` : ''}${base}.lrc`;
  return { folderId: parsed.folderId, songId: parsed.songId, path, sidecarPath: sidecar };
}

function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, '').trim();
}

async function sidecarLyric(
  context: EchoPluginContext,
  options: LyricEngineOptions,
  target: LyricTarget,
): Promise<string> {
  const cached = lyricCache.get(target.songId);
  if (cached !== undefined) return cached;
  const existing = lyricInflight.get(target.songId);
  if (existing) return existing;
  const promise = (async () => {
    let content = '';
    try {
      const ref = options.fileRef(target.folderId, target.sidecarPath);
      if (ref) {
        const result = await awaitOperation(
          context.files.readText(ref, { encoding: 'utf-8', maxBytes: LYRIC_READ_LIMIT }),
        );
        content = stripBom(result && result.text ? result.text : '');
      }
    } catch (error) {
      content = '';
    }
    if (!content && options.readEmbedded()) {
      try {
        const tags = await options.readTags(target.folderId, target.path);
        if (tags && tags.lyric) content = tags.lyric.trim();
      } catch (error) {
        content = '';
      }
    }
    bound(target.songId, content);
    return content;
  })();
  lyricInflight.set(target.songId, promise);
  const cleanup = () => lyricInflight.delete(target.songId);
  promise.then(cleanup, cleanup);
  return promise;
}

const lyricCache = new Map<string, string>();
const lyricInflight = new Map<string, Promise<string>>();

function bound(songId: string, content: string): void {
  if (lyricCache.has(songId)) lyricCache.delete(songId);
  lyricCache.set(songId, content);
  while (lyricCache.size > LYRIC_CACHE_LIMIT) {
    const oldest = lyricCache.keys().next();
    if (oldest.done) break;
    lyricCache.delete(oldest.value);
  }
}

function deadlineStep<T>(
  context: EchoPluginContext,
  deadline: number,
  run: () => Promise<T>,
): Promise<T | null> {
  const remaining = deadline - Date.now();
  if (remaining <= 50) return Promise.resolve(null);
  return raceTimeout(context, run(), Math.max(250, Math.min(remaining, STEP_BUDGET_MS)));
}

function documentFromKugou(lyrics: KugouDto_lyric_Lyrics): LyricDocument | null {
  const built = buildLrcFromKugou(lyrics);
  if (!built) return null;
  return {
    format: 'lrc',
    content: built.content,
    translation: built.translation,
    romanization: built.romanization,
    source: '酷狗歌词',
  };
}

async function kugouLyric(
  context: EchoPluginContext,
  trackTitle: string,
  trackArtist: string,
  durationMs: number,
  deadline: number,
): Promise<LyricDocument | null> {
  const title = stripExtension(trackTitle ?? '').trim();
  if (!title) return null;
  const attempts = trackArtist ? [`${trackArtist} ${title}`, title] : [title];
  for (const keyword of attempts) {
    if (Date.now() > deadline) return null;
    const search = await deadlineStep(context, deadline, () =>
      awaitOperation(
        context.kugou.request('search', {
          kind: 'song',
          keyword,
          page: 1,
          pageSize: 3,
        }),
      ),
    );
    if (!search || search.kind !== 'songs') continue;
    const items = Array.isArray(search.page.items) ? search.page.items : [];
    if (items.length === 0) continue;
    const duration =
      durationMs > 0
        ? Math.round(durationMs)
        : typeof items[0].duration_ms === 'number' && items[0].duration_ms > 0
          ? items[0].duration_ms
          : 0;
    const candidates = await deadlineStep(context, deadline, () =>
      awaitOperation(
        context.kugou.request('lyricCandidatesByKeywords', {
          keywords: keyword,
          durationMs: duration,
        }),
      ),
    );
    if (!candidates || !Array.isArray(candidates) || candidates.length === 0) continue;
    const candidate = pickLyricCandidate(candidates);
    if (!candidate) continue;
    const lyric = await deadlineStep(context, deadline, () =>
      awaitOperation(
        context.kugou.request('lyric', {
          id: candidate.source_id,
          accessKey: candidate.access_key,
        }),
      ),
    );
    if (!lyric) continue;
    const document = documentFromKugou(lyric);
    if (document) return document;
  }
  return null;
}

export function createLyricEngine(
  context: EchoPluginContext,
  options: LyricEngineOptions,
): LyricEngine {
  return {
    async resolve(resolverContext: LyricResolverContext): Promise<LyricDocument | null> {
      const target = targetOf(resolverContext);
      if (!target) return null;
      const title = resolverContext.track.title ?? '';
      const artist = resolverContext.track.artist ?? '';
      const deadline = Date.now() + RESOLVER_DEADLINE_MS;
      const local = await raceTimeout(
        context,
        sidecarLyric(context, options, target),
        RESOLVER_DEADLINE_MS,
      );
      if (local) {
        return { format: 'lrc', content: local, source: '本地歌词' };
      }
      // A lyric completed online on an earlier play: serve it instead of
      // repeating the search round trip.
      const persisted = await raceTimeout(
        context,
        readPersistedLyric(context, target.songId, title, artist),
        LYRIC_PERSIST_BUDGET_MS,
      );
      if (persisted) return persisted;
      if (options.onlineFetch()) {
        const remote = await kugouLyric(
          context,
          title,
          artist,
          resolverContext.durationMs,
          deadline,
        );
        if (remote) {
          // Best-effort persistence; the play itself never waits on the KV
          // write beyond a small budget.
          try {
            await raceTimeout(
              context,
              persistLyric(context, target.songId, title, artist, remote),
              LYRIC_PERSIST_BUDGET_MS,
            );
          } catch (error) {
            // The lyric still plays; the next run simply fetches again.
          }
          return remote;
        }
      }
      return null;
    },
  };
}

/** Test/refresh hook: forget cached lyric text. */
export function clearLyricCache(): void {
  lyricCache.clear();
  lyricInflight.clear();
}

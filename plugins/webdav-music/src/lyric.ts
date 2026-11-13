// Lyric resolver: sibling .lrc/.txt files on the server first, then embedded
// USLT/Vorbis lyrics and a Kugou search (in the order the configured source
// sets), with the Kugou result persisted per song so later plays never
// repeat the online round trip. Every remote hop runs under a shared
// deadline with per-step budgets.

import { awaitOperation } from 'echo:plugin-sdk';
import type {
  EchoPluginContext,
  JsonValue,
  KugouDto_lyric_Lyrics,
  KugouDto_search_lyric_Candidate,
  LyricDocument,
  LyricResolverContext,
} from 'echo:plugin-sdk';
import { raceTimeout } from './async.ts';
import { asArrayBuffer, coerceJsonArray, utf8Decode } from './codec.ts';
import { buildLrcFromKugou, pickLyricCandidate } from './lrc.ts';
import { parseSourceId, stripExtension } from './library.ts';
import type { AudioTags } from './tags.ts';
import { baseName, readRangeRequest, type WebdavEndpoint } from './webdav.ts';

const RESOLVER_DEADLINE_MS = 2300;
const STEP_BUDGET_MS = 900;
const SIDECAR_READ_LIMIT = 512 * 1024;
const SIDECAR_TIMEOUT_MS = 8000;
/** Persisted-lyric KV reads and writes must not stretch the resolver deadline. */
const LYRIC_PERSIST_BUDGET_MS = 600;

// ── Persisted online lyrics ────────────────────────────────────────────────
//
// Kugou lyrics fetched while playing are stored per song id so later plays
// never repeat the online round trip. Records keep the title/artist they
// were matched with, so a renamed file re-resolves instead of serving a
// stale match. `lyrIndex` enumerates the ids for cleanup and the cache-clear
// command (the KV store has no key listing).

const LYRIC_INDEX_KEY = 'lyrIndex';
const LYRIC_STORE_PREFIX = 'lyr:';

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
async function readPersistedLyric(
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

async function persistLyric(
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

// ── Resolver ───────────────────────────────────────────────────────────────

interface LyricEngineOptions {
  coverLyricSource: () => string;
  readTags(libraryId: string, endpoint: WebdavEndpoint, path: string): Promise<AudioTags | null>;
}

export interface LyricEngine {
  resolve(resolverContext: LyricResolverContext): Promise<LyricDocument | null>;
}

interface LyricTarget {
  libraryId: string;
  songId: string;
  path: string;
}

function targetOf(context: LyricResolverContext): LyricTarget | null {
  const parsed = parseSourceId(context.track.sourceId ?? '');
  if (!parsed) return null;
  const data = context.track.data;
  const path = data && typeof data.p === 'string' ? data.p : '';
  if (!path) return null;
  const songId = typeof context.track.id === 'string' ? context.track.id : '';
  return { libraryId: parsed.libraryId, songId, path };
}

function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, '').trim();
}

const SIDECAR_CACHE_LIMIT = 200;
const sidecarCache = new Map<string, string>();
const sidecarInflight = new Map<string, Promise<string>>();

function boundSidecar(songId: string, content: string): void {
  if (!songId) return;
  if (sidecarCache.has(songId)) sidecarCache.delete(songId);
  sidecarCache.set(songId, content);
  while (sidecarCache.size > SIDECAR_CACHE_LIMIT) {
    const oldest = sidecarCache.keys().next();
    if (oldest.done) break;
    sidecarCache.delete(oldest.value);
  }
}

/** Test/refresh hook: forget cached sidecar lookups. */
export function clearLyricCache(): void {
  sidecarCache.clear();
  sidecarInflight.clear();
}

/** Sibling lyric file on the server (`<song>.lrc`, then `<song>.txt`); ''
 * when neither exists or the budget ran out. Results — including misses —
 * are cached per song so replaying a track never re-probes the server. */
async function sidecarLyric(
  context: EchoPluginContext,
  endpoint: WebdavEndpoint,
  target: LyricTarget,
  deadline: number,
): Promise<string> {
  if (!target.songId) return '';
  const cached = sidecarCache.get(target.songId);
  if (cached !== undefined) return cached;
  const existing = sidecarInflight.get(target.songId);
  if (existing) return existing;
  const promise = (async () => {
    const content = await probeSidecar(context, endpoint, target, deadline);
    boundSidecar(target.songId, content);
    return content;
  })();
  sidecarInflight.set(target.songId, promise);
  const cleanup = () => sidecarInflight.delete(target.songId);
  promise.then(cleanup, cleanup);
  return promise;
}

async function probeSidecar(
  context: EchoPluginContext,
  endpoint: WebdavEndpoint,
  target: LyricTarget,
  deadline: number,
): Promise<string> {
  const dirCut = target.path.lastIndexOf('/');
  const directory = dirCut > 0 ? target.path.slice(0, dirCut) : '';
  const base = stripExtension(baseName(target.path));
  if (!base) return '';
  for (const extension of ['lrc', 'txt']) {
    if (Date.now() > deadline) return '';
    const path = `${directory ? `${directory}/` : ''}${base}.${extension}`;
    const operation = readRangeRequest(
      context.net,
      endpoint,
      path,
      0,
      SIDECAR_READ_LIMIT - 1,
      SIDECAR_TIMEOUT_MS,
    );
    const remaining = deadline - Date.now();
    if (remaining <= 50) return '';
    const response = await raceTimeout(
      context,
      awaitOperation(operation),
      Math.max(250, Math.min(remaining, SIDECAR_TIMEOUT_MS)),
    );
    if (!response) continue;
    if (response.status !== 200 && response.status !== 206) continue;
    const buffer = asArrayBuffer(response.data);
    if (!buffer || buffer.byteLength === 0) continue;
    const content = stripBom(utf8Decode(new Uint8Array(buffer)));
    if (content) return content;
  }
  return '';
}

async function embeddedLyric(
  engine: LyricEngineOptions,
  endpoint: WebdavEndpoint,
  target: LyricTarget,
): Promise<LyricDocument | null> {
  const tags = await engine.readTags(target.libraryId, endpoint, target.path);
  if (!tags || !tags.lyric) return null;
  return { format: 'lrc', content: tags.lyric, source: '内嵌歌词' };
}

async function deadlineStep<T>(
  context: EchoPluginContext,
  deadline: number,
  run: () => Promise<T>,
): Promise<T | null> {
  const remaining = deadline - Date.now();
  if (remaining <= 50) return null;
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
  endpointFor: (libraryId: string) => WebdavEndpoint | null,
  engine: LyricEngineOptions,
): LyricEngine {
  return {
    async resolve(resolverContext: LyricResolverContext): Promise<LyricDocument | null> {
      const target = targetOf(resolverContext);
      if (!target) return null;
      const endpoint = endpointFor(target.libraryId);
      if (!endpoint) return null;
      const deadline = Date.now() + RESOLVER_DEADLINE_MS;
      const title = resolverContext.track.title ?? '';
      const artist = resolverContext.track.artist ?? '';
      // A sidecar file is the most explicit user intent; it always wins.
      const sidecar = await sidecarLyric(context, endpoint, target, deadline);
      if (sidecar) return { format: 'lrc', content: sidecar, source: '伴生歌词' };
      const preferKugou = engine.coverLyricSource() === 'kugou';
      const persisted = async (): Promise<LyricDocument | null> => {
        const document = await raceTimeout(
          context,
          readPersistedLyric(context, target.songId, title, artist),
          LYRIC_PERSIST_BUDGET_MS,
        );
        return document;
      };
      const remote = async (): Promise<LyricDocument | null> => {
        const document = await kugouLyric(
          context,
          title,
          artist,
          resolverContext.durationMs,
          deadline,
        );
        if (!document) return null;
        // Best-effort persistence; the play itself never waits on the KV
        // write beyond a small budget.
        try {
          await raceTimeout(
            context,
            persistLyric(context, target.songId, title, artist, document),
            LYRIC_PERSIST_BUDGET_MS,
          );
        } catch (error) {
          // The lyric still plays; the next run simply fetches again.
        }
        return document;
      };
      if (preferKugou) {
        const stored = await persisted();
        if (stored) return stored;
        const online = await remote();
        if (online) return online;
        return embeddedLyric(engine, endpoint, target);
      }
      const embedded = await embeddedLyric(engine, endpoint, target);
      if (embedded) return embedded;
      const stored = await persisted();
      if (stored) return stored;
      return remote();
    },
  };
}

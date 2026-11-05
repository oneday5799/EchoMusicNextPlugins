// Lyric resolver: the sidecar .lrc/.txt file found during the scan first,
// then embedded USLT/Vorbis lyrics, then an optional Kugou lookup. Every hop
// runs under a shared deadline with per-step budgets.

import { awaitOperation } from 'echo:plugin-sdk';
import type {
  EchoPluginContext,
  FileReference,
  KugouDto_lyric_Lyrics,
  KugouDto_search_lyric_Candidate,
  LyricDocument,
  LyricResolverContext,
} from 'echo:plugin-sdk';
import { raceTimeout } from './async.ts';
import { buildLrcFromKugou, pickLyricCandidate } from './lrc.ts';
import { baseName, dirNameOf, parseSourceId, stripExtension } from './library.ts';
import type { AudioTags } from './tags.ts';

const RESOLVER_DEADLINE_MS = 2200;
const STEP_BUDGET_MS = 900;
const LYRIC_READ_LIMIT = 512 * 1024;
const LYRIC_CACHE_LIMIT = 200;

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
  const path = data && typeof data.p === 'string' ? data.p : '';
  if (!path) return null;
  const explicit = data && typeof data.ly === 'string' ? data.ly : '';
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
      const deadline = Date.now() + RESOLVER_DEADLINE_MS;
      const local = await raceTimeout(
        context,
        sidecarLyric(context, options, target),
        RESOLVER_DEADLINE_MS,
      );
      if (local) {
        return { format: 'lrc', content: local, source: '本地歌词' };
      }
      if (options.onlineFetch()) {
        const remote = await kugouLyric(
          context,
          resolverContext.track.title ?? '',
          resolverContext.track.artist ?? '',
          resolverContext.durationMs,
          deadline,
        );
        if (remote) return remote;
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

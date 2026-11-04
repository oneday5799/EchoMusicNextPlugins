// Lyric resolver: embedded USLT/Vorbis lyrics first (or last, depending on
// the configured source order), with Kugou search as the remote fallback.
// Every remote hop runs under a shared deadline with per-step budgets.

import { awaitOperation } from 'echo:plugin-sdk';
import type {
  EchoPluginContext,
  KugouDto_lyric_Lyrics,
  KugouDto_search_lyric_Candidate,
  LyricDocument,
  LyricResolverContext,
} from 'echo:plugin-sdk';
import { raceTimeout } from './async.ts';
import { buildLrcFromKugou, pickLyricCandidate } from './lrc.ts';
import { parseSourceId, stripExtension } from './library.ts';
import type { AudioTags } from './tags.ts';
import type { WebdavEndpoint } from './webdav.ts';

const RESOLVER_DEADLINE_MS = 2300;
const STEP_BUDGET_MS = 900;

interface LyricEngineOptions {
  coverLyricSource: () => string;
  readTags(libraryId: string, endpoint: WebdavEndpoint, path: string): Promise<AudioTags | null>;
}

export interface LyricEngine {
  resolve(resolverContext: LyricResolverContext): Promise<LyricDocument | null>;
}

function targetOf(context: LyricResolverContext): { libraryId: string; path: string } | null {
  const parsed = parseSourceId(context.track.sourceId ?? '');
  if (!parsed) return null;
  const data = context.track.data;
  const path = data && typeof data.p === 'string' ? data.p : '';
  if (!path) return null;
  return { libraryId: parsed.libraryId, path };
}

async function embeddedLyric(
  engine: LyricEngineOptions,
  endpoint: WebdavEndpoint,
  target: { libraryId: string; path: string },
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
      const preferKugou = engine.coverLyricSource() === 'kugou';
      if (preferKugou) {
        const remote = await kugouLyric(
          context,
          title,
          artist,
          resolverContext.durationMs,
          deadline,
        );
        if (remote) return remote;
        return embeddedLyric(engine, endpoint, target);
      }
      const embedded = await embeddedLyric(engine, endpoint, target);
      if (embedded) return embedded;
      return kugouLyric(context, title, artist, resolverContext.durationMs, deadline);
    },
  };
}

// Per-track enrichment: embedded tag read (cached, deduped per path) plus an
// optional Kugou lookup. Covers are cached as data URLs with a small LRU to
// keep the plugin memory footprint bounded.

import { awaitOperation } from 'echo:plugin-sdk';
import type { EchoPluginContext, KugouDto_domain_SearchSong } from 'echo:plugin-sdk';
import { cancelOperationAfter, raceTimeout } from './async.ts';
import { asArrayBuffer } from './codec.ts';
import { parseTitleArtist } from './library.ts';
import { coverDataUrl, parseAudioTags, type AudioTags } from './tags.ts';
import type { WebdavEndpoint } from './webdav.ts';
import {
  isRangeUnsupported,
  isResponseTooLarge,
  markRangeUnsupported,
  readRangeRequest,
} from './webdav.ts';

const HEAD_READ_LIMIT = 256 * 1024;
const HEAD_TIMEOUT_MS = 8000;
const KUGOU_TIMEOUT_MS = 2500;
const TAG_CACHE_LIMIT = 200;
const COVER_CACHE_LIMIT = 48;
const KUGOU_CACHE_LIMIT = 200;

export interface TrackEnrichment {
  title: string;
  artist: string;
  album: string;
  cover: string;
  durationMs: number;
}

export interface EnrichmentModeSource {
  coverLyricSource: () => string;
}

export interface Enricher {
  readTags(libraryId: string, endpoint: WebdavEndpoint, path: string): Promise<AudioTags | null>;
  enrichTrack(
    endpoint: WebdavEndpoint,
    song: { libraryId: string; path: string; title: string; artist: string },
    fallback: { title?: string; artist?: string },
  ): Promise<TrackEnrichment>;
  dispose(): void;
}

export function createEnricher(context: EchoPluginContext, mode: EnrichmentModeSource): Enricher {
  const tagsCache = new Map<string, AudioTags | null>();
  const tagsInFlight = new Map<string, Promise<AudioTags | null>>();
  const coverCache = new Map<string, string>();
  const kugouCache = new Map<string, TrackEnrichment | null>();
  // Session algebra: dispose() bumps the epoch, and every continuation that
  // settles after a dispose checks it — otherwise an in-flight read would
  // write back into the cleared caches and "resurrect" state the host
  // already considers gone (the legacy plugin's stateEpoch fix).
  let epoch = 0;

  function bound<T>(cache: Map<string, T>, limit: number, key: string, value: T): void {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, value);
    while (cache.size > limit) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }

  async function readTags(
    libraryId: string,
    endpoint: WebdavEndpoint,
    path: string,
  ): Promise<AudioTags | null> {
    const key = `${libraryId}|${path}`;
    if (tagsCache.has(key)) return tagsCache.get(key) ?? null;
    if (isRangeUnsupported(endpoint.serverUrl)) return null;
    const existing = tagsInFlight.get(key);
    if (existing) return existing;
    const session = epoch;
    const promise = (async () => {
      try {
        const operation = readRangeRequest(
          context.net,
          endpoint,
          path,
          0,
          HEAD_READ_LIMIT - 1,
          HEAD_TIMEOUT_MS,
        );
        const response = await awaitOperation(operation);
        if (epoch !== session) return null;
        if (response.status !== 200 && response.status !== 206) return null;
        const buffer = asArrayBuffer(response.data);
        if (!buffer) return null;
        const tags = parseAudioTags(new Uint8Array(buffer));
        if (epoch !== session) return null;
        // Only a genuine parse result is cached: a failed or empty read can
        // be transient (server hiccup, auth race), and caching null would
        // pin it for the whole session (local-music's rule).
        bound(tagsCache, TAG_CACHE_LIMIT, key, tags);
        return tags;
      } catch (error) {
        // A whole-file body means the server ignored the Range header; the
        // host aborts those transfers before delivering anything, so skip
        // every future read against this server.
        if (isResponseTooLarge(error)) markRangeUnsupported(endpoint.serverUrl);
        return null;
      } finally {
        tagsInFlight.delete(key);
      }
    })();
    tagsInFlight.set(key, promise);
    return promise;
  }

  function artistNames(song: KugouDto_domain_SearchSong): string {
    const names: string[] = [];
    const artists = Array.isArray(song.artists) ? song.artists : [];
    for (const artist of artists) {
      if (artist && artist.name) names.push(artist.name);
    }
    return names.join('/');
  }

  async function kugouEnrich(title: string, artist: string): Promise<TrackEnrichment | null> {
    const keyword = `${artist} ${title}`.trim() || title;
    if (!keyword) return null;
    const key = keyword.toLowerCase();
    if (kugouCache.has(key)) return kugouCache.get(key) ?? null;
    const session = epoch;
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
      if (epoch !== session) return null;
      let match = null;
      if (response && response.kind === 'songs') {
        const items =
          response.page && Array.isArray(response.page.items) ? response.page.items : [];
        match = items.length > 0 ? items[0] : null;
      }
      const enrichment: TrackEnrichment | null = match
        ? {
            title: '',
            artist: artistNames(match),
            album: match.album_title || '',
            cover: match.cover_url || '',
            durationMs:
              typeof match.duration_ms === 'number' && match.duration_ms > 0
                ? match.duration_ms
                : 0,
          }
        : null;
      bound(kugouCache, KUGOU_CACHE_LIMIT, key, enrichment);
      return enrichment;
    } catch (error) {
      return null;
    }
  }

  async function enrichTrack(
    endpoint: WebdavEndpoint,
    song: { libraryId: string; path: string; title: string; artist: string },
    fallback: { title?: string; artist?: string },
  ): Promise<TrackEnrichment> {
    // Embedded tags win over the filename parse, mirroring the legacy
    // plugin ("以嵌入标签为准覆盖文件名解析结果") and local-music's
    // metadata pass; the filename parse only fills what the tags lack.
    const parsed = parseTitleArtist(song.path.substring(song.path.lastIndexOf('/') + 1));
    let title = '';
    let artist = '';
    let album = '';
    let cover = '';
    let durationMs = 0;
    const session = epoch;
    const tags = await readTags(song.libraryId, endpoint, song.path);
    if (epoch !== session) {
      // Disposed while the tag read was in flight; the caches were cleared
      // on purpose, so hand back nothing instead of a half-resolved record.
      return { title: '', artist: '', album: '', cover: '', durationMs: 0 };
    }
    if (tags) {
      if (tags.title) title = tags.title;
      if (tags.artist) artist = tags.artist;
      if (tags.album) album = tags.album;
      if (tags.durationMs > 0) durationMs = tags.durationMs;
      if (tags.coverData) {
        const key = `${song.libraryId}|${song.path}`;
        if (coverCache.has(key)) {
          cover = coverCache.get(key) ?? '';
        } else {
          cover = coverDataUrl(tags);
          bound(coverCache, COVER_CACHE_LIMIT, key, cover);
        }
      }
    }
    if (!title) title = fallback.title || parsed.title || song.title;
    if (!artist) artist = fallback.artist || parsed.artist || song.artist;
    const preferKugou = mode.coverLyricSource() === 'kugou';
    // The legacy v1.0.5 optimization: when the embedded tags already carry
    // everything the enrichment needs, the online search is skipped —
    // except in kugou-priority mode, which is explicitly opted in.
    const tagsComplete =
      !!tags && !!tags.coverData && !!album && !!artist && !!title && durationMs > 0;
    const kugou =
      tagsComplete && !preferKugou ? null : await kugouEnrich(title || song.title, artist);
    if (kugou) {
      if (preferKugou) {
        // 酷狗资料优先: the online match drives the metadata wherever it has
        // one; embedded tags only fill the gaps the match left open.
        if (kugou.cover) cover = kugou.cover;
        if (kugou.album) album = kugou.album;
        if (kugou.artist) artist = kugou.artist;
        if (kugou.durationMs > 0) durationMs = kugou.durationMs;
      } else {
        if (!cover && kugou.cover) cover = kugou.cover;
        if (!album && kugou.album) album = kugou.album;
        if (!artist && kugou.artist) artist = kugou.artist;
        if (!durationMs && kugou.durationMs) durationMs = kugou.durationMs;
      }
    }
    return { title, artist, album, cover, durationMs };
  }

  return {
    readTags,
    enrichTrack,
    dispose() {
      epoch += 1;
      tagsCache.clear();
      tagsInFlight.clear();
      coverCache.clear();
      kugouCache.clear();
    },
  };
}

export function matchesKeyword(text: string, keyword: string): boolean {
  if (!keyword) return true;
  return text.toLowerCase().indexOf(keyword.toLowerCase()) >= 0;
}

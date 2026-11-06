// Song identity and display naming. Songs are keyed by a hash of
// "folder|path" so the same file keeps its identity across scans, and the
// source id encodes both ids for the host's playback resolver.

import type { JsonValue, QueueTrack } from 'echo:plugin-sdk';
import { coerceJsonArray, compareText } from './codec.ts';

export const AUDIO_EXTENSIONS = [
  'mp3',
  'flac',
  'wav',
  'aac',
  'ogg',
  'wma',
  'm4a',
  'ape',
  'opus',
  'aiff',
  'alac',
  'dsf',
  'dff',
];

/** Sibling files considered as sidecar lyrics, best match first. */
export const LYRIC_EXTENSIONS = ['lrc', 'txt'];

/** Folder images considered as album cover fallbacks, best match first. */
export const COVER_BASE_NAMES = ['cover', 'folder', 'front', 'album', 'albumart'];
export const COVER_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'bmp'];

const SONG_ID_PREFIX = 'local-';
export const SOURCE_ID_PREFIX = 'local:';
export const UNKNOWN_ALBUM = '未知专辑';
/** Hard ceiling shared with the legacy plugins so huge drives stay usable. */
export const LIBRARY_SONG_CAP = 20000;

export function hash36(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

export function makeSongId(folderId: string, path: string): string {
  return `${SONG_ID_PREFIX}${hash36(`${folderId}|${path}`)}`;
}

export function makeSourceId(folderId: string, songId: string): string {
  return `${SOURCE_ID_PREFIX}${folderId}:${songId}`;
}

export function parseSourceId(sourceId: JsonValue): { folderId: string; songId: string } | null {
  if (typeof sourceId !== 'string') return null;
  // The host stores queue tracks' plugin_source with a "<plugin-id>/" prefix
  // and hands that rewritten id back to resolvers; strip the prefix so the
  // sourceId matches the persisted form.
  const value = sourceId.replace(/^(?:[^/:]+\/)?(?=local:)/, '');
  if (value.indexOf(SOURCE_ID_PREFIX) !== 0) return null;
  const rest = value.slice(SOURCE_ID_PREFIX.length);
  const cut = rest.indexOf(':');
  if (cut <= 0) return null;
  const folderId = rest.slice(0, cut);
  const songId = rest.slice(cut + 1);
  if (!folderId || !songId) return null;
  return { folderId, songId };
}

export function extensionOf(name: string): string {
  const cut = name.lastIndexOf('.');
  if (cut < 0) return '';
  return name.slice(cut + 1).toLowerCase();
}

export function stripExtension(name: string): string {
  const cut = name.lastIndexOf('.');
  return cut > 0 ? name.slice(0, cut) : name;
}

export function baseName(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const cut = normalized.lastIndexOf('/');
  return cut >= 0 ? normalized.slice(cut + 1) : normalized;
}

export function dirNameOf(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const cut = normalized.lastIndexOf('/');
  return cut > 0 ? normalized.slice(0, cut) : '';
}

export function isAudioFile(name: string): boolean {
  const extension = extensionOf(name);
  if (!extension) return false;
  for (const item of AUDIO_EXTENSIONS) {
    if (item === extension) return true;
  }
  return false;
}

export function isLyricFile(name: string): boolean {
  const extension = extensionOf(name);
  if (!extension) return false;
  for (const item of LYRIC_EXTENSIONS) {
    if (item === extension) return true;
  }
  return false;
}

export function isCoverImage(name: string): boolean {
  const extension = extensionOf(name);
  if (!extension) return false;
  const base = stripExtension(name).toLowerCase();
  for (const item of COVER_BASE_NAMES) {
    if (item === base) {
      for (const imageExtension of COVER_EXTENSIONS) {
        if (imageExtension === extension) return true;
      }
      return false;
    }
  }
  return false;
}

/** LRC wins over TXT when a song has several sidecar lyric candidates. */
export function lyricRank(name: string): number {
  const extension = extensionOf(name);
  return extension === 'lrc' ? 0 : 1;
}

/** `<songBase>` without its own lyric extension, used as the pairing key. */
export function lyricKeyOf(name: string): string {
  return `${dirNameOf(name)}|${stripExtension(baseName(name)).toLowerCase()}`;
}

const TRACK_NUMBER_PATTERN = /^\d{1,3}\s*[-._]\s*/;

export function parseTitleArtist(fileName: string): { title: string; artist: string } {
  const base = stripExtension(fileName).trim().replace(TRACK_NUMBER_PATTERN, '').trim();
  const parts = base.split(' - ');
  if (parts.length >= 2) {
    const artist = parts[0].trim();
    const title = parts.slice(1).join(' - ').trim();
    if (artist && title) return { title, artist };
  }
  return { title: base, artist: '' };
}

const LOSSLESS_EXTENSIONS = ['flac', 'wav', 'ape', 'aiff', 'alac', 'wv', 'dsf', 'dff'];
const HIGH_EXTENSIONS = ['m4a', 'aac', 'mp3', 'opus', 'ogg'];

export function qualityForExtension(extension: string): 'flac' | 'higher' | 'standard' {
  const ext = typeof extension === 'string' ? extension.toLowerCase() : '';
  for (const item of LOSSLESS_EXTENSIONS) {
    if (item === ext) return 'flac';
  }
  for (const item of HIGH_EXTENSIONS) {
    if (item === ext) return 'higher';
  }
  return 'standard';
}

export interface SongInit {
  id: string;
  sourceId: string;
  path: string;
  folderId: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  size: number;
  /** Sidecar lyric path from the scan, if one matched. */
  lyricPath: string;
}

export function songFromEntry(input: {
  folderId: string;
  path: string;
  name: string;
  size: number;
}): SongInit {
  const id = makeSongId(input.folderId, input.path);
  const parsed = parseTitleArtist(input.name);
  return {
    id,
    sourceId: makeSourceId(input.folderId, id),
    path: input.path,
    folderId: input.folderId,
    title: parsed.title || input.name,
    artist: parsed.artist,
    album: '',
    durationMs: 0,
    size: input.size,
    lyricPath: '',
  };
}

export function albumKeyOf(song: { album?: string }): string {
  const album = typeof song.album === 'string' ? song.album.trim() : '';
  return album || UNKNOWN_ALBUM;
}

export interface AlbumSummary {
  name: string;
  count: number;
  /** Song id whose cached cover represents the album. */
  representativeId: string;
}

/** Group songs by album keeping first-seen order as the representative. */
export function groupAlbums(songs: SongInit[]): AlbumSummary[] {
  const order: string[] = [];
  const seen: { [key: string]: AlbumSummary } = {};
  for (const song of songs) {
    const key = albumKeyOf(song);
    const existing = seen[key];
    if (existing) {
      existing.count += 1;
      continue;
    }
    const summary: AlbumSummary = { name: key, count: 1, representativeId: song.id };
    seen[key] = summary;
    order.push(key);
  }
  const albums = order.map((key) => seen[key]);
  albums.sort((a, b) => compareText(a.name, b.name));
  return albums;
}

export interface SongFilter {
  keyword?: string;
  folderId?: string;
  album?: string;
}

export function filterSongs(songs: SongInit[], filter: SongFilter): SongInit[] {
  const folderId = typeof filter.folderId === 'string' ? filter.folderId : '';
  const album = typeof filter.album === 'string' ? filter.album : '';
  const keyword = (typeof filter.keyword === 'string' ? filter.keyword : '').trim().toLowerCase();
  let result = songs;
  if (folderId) {
    result = result.filter((song) => song.folderId === folderId);
  }
  if (album) {
    result = result.filter((song) => albumKeyOf(song) === album);
  }
  if (keyword) {
    result = result.filter(
      (song) =>
        song.title.toLowerCase().indexOf(keyword) >= 0 ||
        song.artist.toLowerCase().indexOf(keyword) >= 0 ||
        albumKeyOf(song).toLowerCase().indexOf(keyword) >= 0,
    );
  }
  return result;
}

export type SongSortKey = 'title' | 'artist' | 'album' | 'name' | 'size' | 'duration';

const SORTERS: { [key in SongSortKey]: (a: SongInit, b: SongInit) => number } = {
  title: (a, b) => compareText(a.title, b.title) || compareText(a.path, b.path),
  artist: (a, b) => compareText(a.artist, b.artist) || compareText(a.title, b.title),
  album: (a, b) => compareText(albumKeyOf(a), albumKeyOf(b)) || compareText(a.title, b.title),
  name: (a, b) => compareText(a.path, b.path),
  size: (a, b) => b.size - a.size,
  duration: (a, b) => a.durationMs - b.durationMs || compareText(a.path, b.path),
};

export function normalizeSortKey(value: JsonValue | undefined): SongSortKey {
  if (typeof value === 'string' && value in SORTERS) return value as SongSortKey;
  return 'title';
}

/** The host sort header signals 1 = ascending, 2 = descending. */
export function normalizeSortDescending(value: JsonValue | undefined): boolean {
  return value === 2 || value === 'desc';
}

export function sortSongs(songs: SongInit[], sort: SongSortKey, descending = false): SongInit[] {
  const sorted = songs.slice();
  sorted.sort(SORTERS[sort]);
  if (descending && sorted.length > 1) sorted.reverse();
  return sorted;
}

/** Bounded payload persisted with the queue; `ly` only when a sidecar exists. */
export function buildTrackData(song: SongInit): Record<string, JsonValue> {
  const data: Record<string, JsonValue> = { p: song.path, f: song.folderId, s: song.size };
  if (song.lyricPath) data.ly = song.lyricPath;
  return data;
}

export interface QueueTrackExtras {
  title?: string;
  artist?: string;
  album?: string;
  cover?: string;
  durationMs?: number;
}

export function buildQueueTrack(song: SongInit, extras?: QueueTrackExtras | null): QueueTrack {
  const track: {
    id: string;
    sourceId: string;
    data: Record<string, JsonValue>;
    title?: string;
    artist?: string;
    album?: string;
    cover?: string;
    durationMs?: number;
  } = {
    id: song.id,
    sourceId: song.sourceId,
    data: buildTrackData(song),
  };
  if (extras) {
    if (extras.title) track.title = extras.title;
    if (extras.artist) track.artist = extras.artist;
    if (extras.album) track.album = extras.album;
    if (extras.cover) track.cover = extras.cover;
    if (extras.durationMs && extras.durationMs > 0)
      track.durationMs = Math.round(extras.durationMs);
  }
  if (!track.title) track.title = song.title;
  if (!track.artist) track.artist = song.artist;
  if (!track.album && song.album) track.album = song.album;
  if (!track.durationMs && song.durationMs > 0) track.durationMs = Math.round(song.durationMs);
  return track;
}

const COMPACT_LENGTH = 10;

/** [id, sourceId, path, folderId, title, artist, album, durationMs, size, lyricPath] */
export function compactSong(song: SongInit): JsonValue[] {
  return [
    song.id,
    song.sourceId,
    song.path,
    song.folderId,
    song.title,
    song.artist,
    song.album,
    Math.round(song.durationMs),
    song.size,
    song.lyricPath,
  ];
}

export function expandCompactSong(value: JsonValue): SongInit | null {
  const fields = coerceJsonArray(value);
  if (fields.length < COMPACT_LENGTH) return null;
  const id = fields[0];
  const sourceId = fields[1];
  const path = fields[2];
  const folderId = fields[3];
  const title = fields[4];
  const artist = fields[5];
  const album = fields[6];
  const durationMs = fields[7];
  const size = fields[8];
  const lyricPath = fields[9];
  if (
    typeof id !== 'string' ||
    typeof sourceId !== 'string' ||
    typeof path !== 'string' ||
    typeof folderId !== 'string'
  ) {
    return null;
  }
  return {
    id,
    sourceId,
    path,
    folderId,
    title: typeof title === 'string' ? title : '',
    artist: typeof artist === 'string' ? artist : '',
    album: typeof album === 'string' ? album : '',
    durationMs:
      typeof durationMs === 'number' && isFinite(durationMs) && durationMs > 0 ? durationMs : 0,
    size: typeof size === 'number' && isFinite(size) && size >= 0 ? size : 0,
    lyricPath: typeof lyricPath === 'string' ? lyricPath : '',
  };
}

export function formatDuration(ms: number): string {
  if (!isFinite(ms) || ms <= 0) return '';
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${pad2(seconds)}`;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

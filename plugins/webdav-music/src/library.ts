// Song identity and display naming. Songs are keyed by a hash of
// "library|path" so the same file keeps its identity across scans, and the
// source id encodes both ids for the host's playback resolver.

import type { JsonValue, QueueTrack } from 'echo:plugin-sdk';

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

const SONG_ID_PREFIX = 'webdav-';
export const SOURCE_ID_PREFIX = 'webdav:';

export function hash36(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

export function makeSongId(libraryId: string, path: string): string {
  return `${SONG_ID_PREFIX}${hash36(`${libraryId}|${path}`)}`;
}

export function makeSourceId(libraryId: string, songId: string): string {
  return `${SOURCE_ID_PREFIX}${libraryId}:${songId}`;
}

export function parseSourceId(sourceId: JsonValue): { libraryId: string; songId: string } | null {
  if (typeof sourceId !== 'string' || sourceId.indexOf(SOURCE_ID_PREFIX) !== 0) return null;
  const rest = sourceId.slice(SOURCE_ID_PREFIX.length);
  const cut = rest.indexOf(':');
  if (cut <= 0) return null;
  const libraryId = rest.slice(0, cut);
  const songId = rest.slice(cut + 1);
  if (!libraryId || !songId) return null;
  return { libraryId, songId };
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

export function isAudioFile(name: string): boolean {
  const extension = extensionOf(name);
  if (!extension) return false;
  for (const item of AUDIO_EXTENSIONS) {
    if (item === extension) return true;
  }
  return false;
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
  libraryId: string;
  title: string;
  artist: string;
  size: number;
}

export function songFromEntry(input: {
  libraryId: string;
  path: string;
  name: string;
  size: number;
}): SongInit {
  const id = makeSongId(input.libraryId, input.path);
  const parsed = parseTitleArtist(input.name);
  return {
    id,
    sourceId: makeSourceId(input.libraryId, id),
    path: input.path,
    libraryId: input.libraryId,
    title: parsed.title || input.name,
    artist: parsed.artist,
    size: input.size,
  };
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
    data: { p: song.path, l: song.libraryId, s: song.size },
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
  return track;
}

const COMPACT_LENGTH = 6;

export function compactSong(song: SongInit): JsonValue[] {
  return [song.id, song.sourceId, song.path, song.title, song.artist, song.size];
}

export function expandCompactSong(value: JsonValue): SongInit | null {
  if (!Array.isArray(value) || value.length < COMPACT_LENGTH - 1) return null;
  const id = value[0];
  const sourceId = value[1];
  const path = value[2];
  const title = value[3];
  const artist = value[4];
  const size = value[5];
  if (typeof id !== 'string' || typeof sourceId !== 'string' || typeof path !== 'string')
    return null;
  const parsed = parseSourceId(sourceId);
  return {
    id,
    sourceId,
    path,
    libraryId: parsed ? parsed.libraryId : '',
    title: typeof title === 'string' ? title : '',
    artist: typeof artist === 'string' ? artist : '',
    size: typeof size === 'number' && isFinite(size) && size >= 0 ? size : 0,
  };
}

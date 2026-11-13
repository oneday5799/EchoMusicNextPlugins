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
  if (typeof sourceId !== 'string') return null;
  // The host stores queue tracks' plugin_source with a "<plugin-id>/" prefix
  // and hands that rewritten id back to resolvers; strip the prefix so the
  // sourceId matches the persisted form.
  const value = sourceId.replace(/^(?:[^/:]+\/)?(?=webdav:)/, '');
  if (value.indexOf(SOURCE_ID_PREFIX) !== 0) return null;
  const rest = value.slice(SOURCE_ID_PREFIX.length);
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
  /** Immediate parent folder name ('' at the library root); the legacy
   * plugin used it as the album for scanned songs. */
  album: string;
  size: number;
}

/** Immediate parent folder of a server path; '' when the file sits at the
 * root, where there is no folder name to speak of. */
export function parentFolderName(path: string): string {
  const normalized = (path ?? '').replace(/\\/g, '/');
  const cut = normalized.lastIndexOf('/');
  if (cut <= 0) return '';
  const dir = normalized.slice(0, cut);
  const dirCut = dir.lastIndexOf('/');
  return dirCut >= 0 ? dir.slice(dirCut + 1) : dir;
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
    album: parentFolderName(input.path),
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

/** The host queue validator caps a track's cover string at 16384 chars
 * (EchoPluginPlaylist::parse) and stays silent beyond that, so oversized
 * embedded art must be withheld from queue payloads instead of submitting
 * it and failing the whole call. */
export const QUEUE_COVER_LIMIT = 16000;

/** Same validator caps title/artist/album at 1024 chars each — a longer
 * string silently fails the whole replace call, so they are clamped. */
export const QUEUE_TEXT_LIMIT = 1024;

function clampQueueText(value: string): string {
  return value.length > QUEUE_TEXT_LIMIT ? value.slice(0, QUEUE_TEXT_LIMIT) : value;
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
    if (extras.title) track.title = clampQueueText(extras.title);
    if (extras.artist) track.artist = clampQueueText(extras.artist);
    if (extras.album) track.album = clampQueueText(extras.album);
    if (extras.cover) track.cover = extras.cover;
    if (extras.durationMs && extras.durationMs > 0)
      track.durationMs = Math.round(extras.durationMs);
  }
  if (!track.title) track.title = clampQueueText(song.title);
  if (!track.artist) track.artist = clampQueueText(song.artist);
  // Scanned songs carry their parent folder as a default album; explicit
  // extras (enrichment or folder play) always win.
  if (!track.album && song.album) track.album = clampQueueText(song.album);
  return track;
}

// v2 compact rows carried six fields; the album (parent folder name) was
// added as an optional seventh so existing caches keep loading without a
// forced rescan — expandCompactSong simply reads it when present.
const COMPACT_MIN_LENGTH = 5;

export function compactSong(song: SongInit): JsonValue[] {
  return [song.id, song.sourceId, song.path, song.title, song.artist, song.size, song.album];
}

export function expandCompactSong(value: JsonValue): SongInit | null {
  if (!Array.isArray(value) || value.length < COMPACT_MIN_LENGTH) return null;
  const id = value[0];
  const sourceId = value[1];
  const path = value[2];
  const title = value[3];
  const artist = value[4];
  const size = value[5];
  const album = value.length > 6 ? value[6] : undefined;
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
    album: typeof album === 'string' ? album : '',
    size: typeof size === 'number' && isFinite(size) && size >= 0 ? size : 0,
  };
}

// Audio tag readers for ID3v2.3/2.4 and FLAC streams. Only the header bytes
// (first 256 KiB by convention) are fetched over the wire, so every parser
// works on a bounded Uint8Array view.

import { bytesToBase64, latin1Decode, utf16Decode, utf8Decode } from './codec.ts';

export interface AudioTags {
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  coverMime: string;
  coverData: Uint8Array | null;
  lyric: string;
}

function emptyTags(): AudioTags {
  return {
    title: '',
    artist: '',
    album: '',
    durationMs: 0,
    coverMime: '',
    coverData: null,
    lyric: '',
  };
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function decodeId3String(bytes: Uint8Array, encoding: number, start: number, end: number): string {
  if (end <= start) return '';
  if (encoding === 3) return utf8Decode(bytes, start, end);
  if (encoding === 1) {
    // UTF-16 with a byte-order mark; fall back to little endian.
    if (start + 1 < end && bytes[start] === 255 && bytes[start + 1] === 254) {
      return utf16Decode(bytes, start + 2, end, false);
    }
    if (start + 1 < end && bytes[start] === 254 && bytes[start + 1] === 255) {
      return utf16Decode(bytes, start + 2, end, true);
    }
    return utf16Decode(bytes, start, end, false);
  }
  if (encoding === 2) return utf16Decode(bytes, start, end, true);
  return latin1Decode(bytes, start, end);
}

function decodeId3Text(bytes: Uint8Array, start: number, end: number): string {
  if (end <= start) return '';
  return decodeId3String(bytes, bytes[start], start + 1, end);
}

function normalizeImageMime(value: string): string {
  const mime = value.trim().toLowerCase();
  if (mime.indexOf('/') >= 0) return mime;
  if (mime === 'png') return 'image/png';
  if (mime === 'jpg' || mime === 'jpeg') return 'image/jpeg';
  if (mime === 'gif') return 'image/gif';
  if (mime === 'bmp') return 'image/bmp';
  if (mime === 'webp') return 'image/webp';
  return mime ? `image/${mime}` : 'image/jpeg';
}

export function coverDataUrl(tags: AudioTags): string {
  if (!tags.coverData || tags.coverData.length === 0) return '';
  return `data:${tags.coverMime || 'image/jpeg'};base64,${bytesToBase64(tags.coverData)}`;
}

function readUnsynchronisedLyrics(bytes: Uint8Array, start: number, end: number): string {
  if (end - start < 4) return '';
  const encoding = bytes[start];
  // Layout: encoding byte + 3-byte language descriptor, then a terminator
  // that separates the content descriptor from the lyric text.
  let offset = start + 4;
  if (encoding === 1 || encoding === 2) {
    let found = -1;
    for (let i = offset; i + 1 < end; i += 2) {
      if (bytes[i] === 0 && bytes[i + 1] === 0) {
        found = i;
        break;
      }
    }
    if (found < 0) return '';
    offset = found + 2;
  } else {
    let i = offset;
    while (i < end && bytes[i] !== 0) i += 1;
    if (i >= end) return '';
    offset = i + 1;
  }
  if (offset >= end) return '';
  return decodeId3String(bytes, encoding, offset, end).trim();
}

function readId3Picture(
  bytes: Uint8Array,
  start: number,
  end: number,
  v22: boolean,
): { mime: string; data: Uint8Array } | null {
  if (end - start < 2) return null;
  const encoding = bytes[start];
  let offset = start + 1;
  let mime: string;
  if (v22) {
    mime = `image/${latin1Decode(bytes, offset, Math.min(offset + 3, end)).toLowerCase()}`;
    offset += 3;
  } else {
    let i = offset;
    while (i < end && bytes[i] !== 0) i += 1;
    mime = latin1Decode(bytes, offset, i);
    offset = i + 1;
  }
  if (offset >= end) return null;
  offset += 1;
  if (encoding === 1 || encoding === 2) {
    for (let i = offset; i + 1 < end; i += 2) {
      if (bytes[i] === 0 && bytes[i + 1] === 0) {
        offset = i + 2;
        break;
      }
    }
  } else {
    let i = offset;
    while (i < end && bytes[i] !== 0) i += 1;
    offset = i + 1;
  }
  if (offset >= end) return null;
  return { mime: normalizeImageMime(mime), data: bytes.slice(offset, end) };
}

function applyId3Frame(
  tags: AudioTags,
  id: string,
  bytes: Uint8Array,
  start: number,
  end: number,
  v22: boolean,
): void {
  const text = () => decodeId3Text(bytes, start, end).trim();
  if (id === 'TIT2' || id === 'TT2') {
    tags.title = text();
  } else if (id === 'TPE1' || id === 'TP1') {
    tags.artist = text();
  } else if (id === 'TALB' || id === 'TAL') {
    tags.album = text();
  } else if (id === 'TLEN') {
    const ms = parseInt(text(), 10);
    if (isFinite(ms) && ms > 0) tags.durationMs = ms;
  } else if (id === 'USLT' || id === 'ULT') {
    tags.lyric = readUnsynchronisedLyrics(bytes, start, end);
  } else if (id === 'APIC' || id === 'PIC') {
    const picture = readId3Picture(bytes, start, end, v22);
    if (picture) {
      tags.coverMime = picture.mime;
      tags.coverData = picture.data;
    }
  }
}

function parseId3v2(bytes: Uint8Array): AudioTags | null {
  if (bytes.length < 10) return null;
  if (bytes[0] !== 73 || bytes[1] !== 68 || bytes[2] !== 51) return null;
  const major = bytes[3];
  if (major !== 3 && major !== 4) return null;
  const flags = bytes[5];
  // Syncsafe 28-bit size, one 7-bit group per byte.
  const size =
    ((bytes[6] & 127) << 21) |
    ((bytes[7] & 127) << 14) |
    ((bytes[8] & 127) << 7) |
    (bytes[9] & 127);
  let offset = 10;
  if ((flags & 64) !== 0 && offset + 4 <= bytes.length) {
    const view = viewOf(bytes);
    offset += 4 + view.getUint32(offset);
  }
  const limit = Math.min(bytes.length, 10 + size);
  const tags = emptyTags();
  let found = false;
  while (offset + 10 <= limit) {
    const id = String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3],
    );
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const view = viewOf(bytes);
    const frameSize =
      major === 4
        ? ((bytes[offset + 4] & 127) << 21) |
          ((bytes[offset + 5] & 127) << 14) |
          ((bytes[offset + 6] & 127) << 7) |
          (bytes[offset + 7] & 127)
        : view.getUint32(offset + 4);
    if (frameSize <= 0 || offset + 10 + frameSize > limit) break;
    applyId3Frame(tags, id, bytes, offset + 10, offset + 10 + frameSize, false);
    found = true;
    offset += 10 + frameSize;
  }
  return found ? tags : null;
}

function readVorbisComment(
  tags: AudioTags,
  bytes: Uint8Array,
  start: number,
  end: number,
): boolean {
  const view = viewOf(bytes);
  let offset = start;
  if (offset + 4 > end) return false;
  // Vorbis comment block lengths are little endian (unlike the FLAC block
  // header itself, which is big endian).
  const vendorLength = view.getUint32(offset, true);
  offset += 4 + vendorLength;
  if (offset + 4 > end) return false;
  const count = view.getUint32(offset, true);
  offset += 4;
  let found = false;
  for (let i = 0; i < count && offset + 4 <= end; i += 1) {
    const length = view.getUint32(offset, true);
    offset += 4;
    if (length > end - offset) break;
    const comment = utf8Decode(bytes, offset, offset + length);
    offset += length;
    const cut = comment.indexOf('=');
    if (cut <= 0) continue;
    const key = comment.slice(0, cut).toUpperCase();
    const value = comment.slice(cut + 1).trim();
    if (!value) continue;
    if (key === 'TITLE') {
      tags.title = value;
      found = true;
    } else if (key === 'ARTIST' && !tags.artist) {
      tags.artist = value;
      found = true;
    } else if (key === 'ALBUM' && !tags.album) {
      tags.album = value;
      found = true;
    } else if (
      key === 'LYRICS' ||
      key === 'LYRIC' ||
      key === 'UNSYNCEDLYRICS' ||
      key === 'SYNCEDLYRICS'
    ) {
      tags.lyric = value;
      found = true;
    }
  }
  return found;
}

function readFlacPicture(
  bytes: Uint8Array,
  start: number,
  end: number,
): { mime: string; data: Uint8Array } | null {
  const view = viewOf(bytes);
  let offset = start;
  if (offset + 4 > end) return null;
  offset += 4;
  if (offset + 4 > end) return null;
  const mimeLength = view.getUint32(offset);
  offset += 4;
  if (mimeLength > end - offset) return null;
  const mime = normalizeImageMime(latin1Decode(bytes, offset, offset + mimeLength));
  offset += mimeLength;
  if (offset + 4 > end) return null;
  const descriptionLength = view.getUint32(offset);
  offset += 4 + descriptionLength;
  offset += 16;
  if (offset + 4 > end) return null;
  const dataLength = view.getUint32(offset);
  offset += 4;
  if (dataLength <= 0 || dataLength > end - offset) return null;
  return { mime, data: bytes.slice(offset, offset + dataLength) };
}

function parseFlac(bytes: Uint8Array): AudioTags | null {
  if (bytes.length < 8) return null;
  if (bytes[0] !== 102 || bytes[1] !== 76 || bytes[2] !== 97 || bytes[3] !== 67) return null;
  const view = viewOf(bytes);
  const tags = emptyTags();
  let found = false;
  let offset = 4;
  while (offset + 4 <= bytes.length) {
    const header = bytes[offset];
    const isLast = (header & 128) !== 0;
    const type = header & 127;
    const length = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    const body = offset + 4;
    if (body + length > bytes.length) break;
    if (type === 0 && length >= 18) {
      // STREAMINFO carries the sample rate and total sample count needed for
      // a duration estimate.
      const sampleRate =
        (bytes[body + 10] << 12) | (bytes[body + 11] << 4) | (bytes[body + 12] >> 4);
      const totalSamples = (bytes[body + 13] & 15) * 4294967296 + view.getUint32(body + 14);
      if (sampleRate > 0 && totalSamples > 0) {
        tags.durationMs = Math.round((totalSamples / sampleRate) * 1000);
        found = true;
      }
    } else if (type === 4) {
      if (readVorbisComment(tags, bytes, body, body + length)) found = true;
    } else if (type === 6) {
      const picture = readFlacPicture(bytes, body, body + length);
      if (picture) {
        tags.coverMime = picture.mime;
        tags.coverData = picture.data;
        found = true;
      }
    }
    offset = body + length;
    if (isLast) break;
  }
  return found ? tags : null;
}

/** Declared ID3v2.3/2.4 tag size (header excluded), or -1 when the buffer is
 * not an ID3v2 tag. Used to re-read files whose tag extends past the
 * bounded probe window. */
export function id3TagSize(bytes: Uint8Array): number {
  if (bytes.length < 10) return -1;
  if (bytes[0] !== 73 || bytes[1] !== 68 || bytes[2] !== 51) return -1;
  const major = bytes[3];
  if (major !== 3 && major !== 4) return -1;
  return (
    ((bytes[6] & 127) << 21) | ((bytes[7] & 127) << 14) | ((bytes[8] & 127) << 7) | (bytes[9] & 127)
  );
}

export function parseAudioTags(bytes: Uint8Array): AudioTags | null {
  const id3 = parseId3v2(bytes);
  if (id3) return id3;
  return parseFlac(bytes);
}

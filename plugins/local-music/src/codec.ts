// Byte/text codecs for tag parsing and data URLs. The QML JS engine has no
// Node Buffer, so base64 and UTF-8/16 decoding are implemented locally in
// small, allocation-conscious helpers.

import type { JsonValue } from 'echo:plugin-sdk';

/**
 * Some host API responses — the io store in particular — deliver JSON arrays
 * as array-like objects that lost the JS Array prototype: Array.isArray is
 * false and .map is missing, yet serializing the same value back to the host
 * produces a real array again. These lost arrays silently emptied every io
 * read (settings folders, library cache chunks, cover index), so recover
 * them into genuine arrays: native array → iterable → numeric
 * length+index → contiguous "0..n-1" numeric keys → empty.
 */
export function coerceJsonArray(value: JsonValue | undefined): JsonValue[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  const source = value as object;
  try {
    if (Symbol.iterator in source) {
      return Array.from(value as unknown as Iterable<JsonValue>);
    }
  } catch (error) {
    // Fall through to the numeric-key recovery below.
  }
  const record = value as { [key: string]: JsonValue };
  const lengthValue = (record as { length?: JsonValue }).length;
  if (
    typeof lengthValue === 'number' &&
    Number.isInteger(lengthValue) &&
    lengthValue >= 0 &&
    lengthValue < 1000000
  ) {
    const items: JsonValue[] = new Array(lengthValue);
    let filled = 0;
    for (let index = 0; index < lengthValue; index += 1) {
      const item = (record as { [key: number]: JsonValue })[index];
      // Assigning undefined explicitly turns format holes into real entries,
      // so the array equals what a native parse would have produced.
      items[index] = item;
      if (item !== undefined) {
        filled += 1;
      }
    }
    if (filled > 0 || lengthValue === 0) return items;
  }
  const indexes = Object.keys(record)
    .filter((key) => /^(0|[1-9]\d*)$/.test(key))
    .map(Number)
    .sort((a, b) => a - b);
  if (indexes.length === 0 || indexes[indexes.length - 1] !== indexes.length - 1) {
    return [];
  }
  const items: JsonValue[] = new Array(indexes.length);
  for (let index = 0; index < indexes.length; index += 1) {
    items[index] = (record as { [key: number]: JsonValue })[indexes[index]];
  }
  return items;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const FLUSH_SIZE = 32768;

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let out = '';
  const total = bytes.length;
  for (let i = 0; i < total; i += 3) {
    const hasSecond = i + 1 < total;
    const hasThird = i + 2 < total;
    const first = bytes[i];
    const second = hasSecond ? bytes[i + 1] : 0;
    const third = hasThird ? bytes[i + 2] : 0;
    out += BASE64_ALPHABET[first >> 2];
    out += BASE64_ALPHABET[((first & 3) << 4) | (second >> 4)];
    out += hasSecond ? BASE64_ALPHABET[((second & 15) << 2) | (third >> 6)] : '=';
    out += hasThird ? BASE64_ALPHABET[third & 63] : '=';
    if (out.length >= FLUSH_SIZE) {
      parts.push(out);
      out = '';
    }
  }
  parts.push(out);
  return parts.join('');
}

export function utf8Decode(bytes: Uint8Array, start?: number, end?: number): string {
  const from = start === undefined ? 0 : start;
  const to = end === undefined ? bytes.length : end;
  let out = '';
  let chunk = '';
  let i = from;
  while (i < to) {
    const lead = bytes[i];
    let code: number;
    if (lead < 128) {
      code = lead;
      i += 1;
    } else if ((lead & 224) === 192 && i + 1 < to) {
      code = ((lead & 31) << 6) | (bytes[i + 1] & 63);
      i += 2;
    } else if ((lead & 240) === 224 && i + 2 < to) {
      code = ((lead & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63);
      i += 3;
    } else if ((lead & 248) === 240 && i + 3 < to) {
      code =
        ((lead & 7) << 18) |
        ((bytes[i + 1] & 63) << 12) |
        ((bytes[i + 2] & 63) << 6) |
        (bytes[i + 3] & 63);
      i += 4;
    } else {
      code = 65533;
      i += 1;
    }
    if (code > 65535) {
      const wide = code - 65536;
      chunk += String.fromCharCode(55296 + (wide >> 10), 56320 + (wide & 1023));
    } else {
      chunk += String.fromCharCode(code);
    }
    if (chunk.length >= FLUSH_SIZE) {
      out += chunk;
      chunk = '';
    }
  }
  return out + chunk;
}

export function utf16Decode(
  bytes: Uint8Array,
  start: number,
  end: number,
  bigEndian: boolean,
): string {
  let out = '';
  let chunk = '';
  for (let i = start; i + 1 < end; i += 2) {
    const unit = bigEndian ? (bytes[i] << 8) | bytes[i + 1] : (bytes[i + 1] << 8) | bytes[i];
    chunk += String.fromCharCode(unit);
    if (chunk.length >= FLUSH_SIZE) {
      out += chunk;
      chunk = '';
    }
  }
  return out + chunk;
}

export function latin1Decode(bytes: Uint8Array, start: number, end: number): string {
  let out = '';
  let chunk = '';
  for (let i = start; i < end; i += 1) {
    chunk += String.fromCharCode(bytes[i]);
    if (chunk.length >= FLUSH_SIZE) {
      out += chunk;
      chunk = '';
    }
  }
  return out + chunk;
}

export function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** Numeric-aware, accent-insensitive text comparison for song listings. */
export function compareText(a: string, b: string): number {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

export function asArrayBuffer(value: unknown): ArrayBuffer | null {
  if (value instanceof ArrayBuffer) return value;
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as ArrayBuffer).byteLength === 'number' &&
    typeof (value as ArrayBuffer).slice === 'function'
  ) {
    return value as ArrayBuffer;
  }
  return null;
}

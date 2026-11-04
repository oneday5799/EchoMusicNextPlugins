// WebDAV request building and PROPFIND parsing. URLs are built from the
// canonical server form plus per-segment encoded paths, and directory
// listings tolerate both prefixed and bare DAV XML responses.

import type { EchoPluginNetwork, EchoPluginOperation, NetworkResponse } from 'echo:plugin-sdk';
import { bytesToBase64, decodeHref, utf8Encode, xmlDecode } from './codec.ts';
import type { WebdavLibraryConfig } from './config.ts';

export type { NetworkResponse };

export interface WebdavEndpoint {
  serverUrl: string;
  username: string;
  password: string;
  rootPath: string;
}

export const COVER_NAMES = [
  'cover.jpg',
  'cover.png',
  'cover.webp',
  'folder.jpg',
  'folder.png',
  'front.jpg',
  'front.png',
  'album.jpg',
  'album.png',
  'albumart.jpg',
  'albumart.png',
];

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/><d:getcontentlength/><d:getcontenttype/><d:getlastmodified/></d:prop></d:propfind>';

const RESPONSE_PATTERN =
  /<(?:[\w.-]+:)?response(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?response\s*>/gi;
const COLLECTION_PATTERN = /<(?:[\w.-]+:)?collection[\s/>]/i;

export function normalizeServerUrl(value: string): string {
  let url = (value ?? '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  while (url.length > 0 && url.charCodeAt(url.length - 1) === 47) url = url.slice(0, -1);
  return url;
}

export function normalizeDir(value: string): string {
  let path = (value ?? '').replace(/\\/g, '/');
  if (path.indexOf('://') >= 0 && path.indexOf('/', path.indexOf('://') + 3) >= 0) {
    path = path.slice(path.indexOf('/', path.indexOf('://') + 3));
  }
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(/\/{2,}/g, '/');
  while (path.length > 1 && path.charCodeAt(path.length - 1) === 47) path = path.slice(0, -1);
  return path.length === 0 ? '/' : path;
}

/** Directory containing `path`; the root maps to itself. */
export function parentPath(path: string): string {
  const normalized = normalizeDir(path);
  const cut = normalized.lastIndexOf('/');
  return cut <= 0 ? '/' : normalized.slice(0, cut);
}

export function baseName(path: string): string {
  const normalized = normalizeDir(path);
  const cut = normalized.lastIndexOf('/');
  return cut < 0 ? normalized : normalized.slice(cut + 1);
}

export function encodePath(path: string): string {
  const segments = normalizeDir(path).split('/');
  let out = '';
  for (let i = 0; i < segments.length; i += 1) {
    if (i > 0) out += '/';
    if (i === 0 || segments[i].length === 0) {
      out += segments[i];
      continue;
    }
    let segment = segments[i];
    try {
      segment = encodeURIComponent(segment);
    } catch (error) {
      // Keep the raw segment if the engine rejects it.
    }
    out += segment;
  }
  return out;
}

function basicAuthHeader(username: string, password: string): string | null {
  if (!username && !password) return null;
  return `Basic ${bytesToBase64(utf8Encode(`${username ?? ''}:${password ?? ''}`))}`;
}

export function buildAuthUrl(
  serverUrl: string,
  username: string,
  password: string,
  path: string,
): string {
  const url = `${normalizeServerUrl(serverUrl)}${encodePath(path)}`;
  if (!username && !password) return url;
  const schemeCut = url.indexOf('://');
  if (schemeCut < 0) return url;
  const scheme = url.slice(0, schemeCut + 3);
  const rest = url.slice(schemeCut + 3);
  let user = username;
  let pass = password;
  try {
    user = encodeURIComponent(username).replace(/'/g, '%27');
    pass = encodeURIComponent(password).replace(/'/g, '%27');
  } catch (error) {
    // Fall back to the raw credentials.
  }
  return `${scheme}${user}:${pass}@${rest}`;
}

export function endpointOf(library: WebdavLibraryConfig): WebdavEndpoint {
  return {
    serverUrl: normalizeServerUrl(library.serverUrl),
    username: library.username ?? '',
    password: library.password ?? '',
    rootPath: normalizeDir(library.rootPath || '/'),
  };
}

function entryPath(rawHref: string): string {
  let href = rawHref.trim();
  const schemeCut = href.indexOf('://');
  if (schemeCut >= 0) {
    const pathCut = href.indexOf('/', schemeCut + 3);
    href = pathCut >= 0 ? href.slice(pathCut) : '/';
  }
  const queryCut = href.indexOf('?');
  if (queryCut >= 0) href = href.slice(0, queryCut);
  if (href.length === 0) return '/';
  return decodeHref(href);
}

function tagText(block: string, localName: string): string {
  const pattern = new RegExp(
    `<(?:[\\w.-]+:)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${localName}\\s*>`,
    'i',
  );
  const match = pattern.exec(block);
  return match ? xmlDecode(match[1].trim()) : '';
}

export interface DavEntry {
  path: string;
  name: string;
  isCollection: boolean;
  contentLength: number;
  contentType: string;
  lastModified: string;
}

export function parsePropfind(xml: string): DavEntry[] {
  const entries: DavEntry[] = [];
  if (!xml || xml.indexOf('response') < 0) return entries;
  RESPONSE_PATTERN.lastIndex = 0;
  let match = RESPONSE_PATTERN.exec(xml);
  while (match) {
    const block = match[1];
    const href = tagText(block, 'href');
    if (href) {
      const path = normalizeDir(entryPath(href));
      const contentType = tagText(block, 'getcontenttype');
      const lengthText = tagText(block, 'getcontentlength');
      entries.push({
        path,
        name: tagText(block, 'displayname').trim() || baseName(path),
        isCollection:
          COLLECTION_PATTERN.test(block) || contentType.toLowerCase().indexOf('directory') >= 0,
        contentLength: lengthText ? parseInt(lengthText, 10) || 0 : 0,
        contentType,
        lastModified: tagText(block, 'getlastmodified'),
      });
    }
    match = RESPONSE_PATTERN.exec(xml);
  }
  return entries;
}

export function propfindStatusOk(status: number): boolean {
  return status === 207 || status === 200;
}

function davHeaders(endpoint: WebdavEndpoint, depth: string): Record<string, string> {
  const headers: Record<string, string> = { Depth: depth };
  const auth = basicAuthHeader(endpoint.username, endpoint.password);
  if (auth) headers.Authorization = auth;
  return headers;
}

/** Lists one directory (Depth 1). Completes with status 207 on success. */
export function propfindRequest(
  net: EchoPluginNetwork,
  endpoint: WebdavEndpoint,
  path: string,
  timeoutMs: number,
): EchoPluginOperation<NetworkResponse> {
  return net.request({
    url: `${normalizeServerUrl(endpoint.serverUrl)}${encodePath(path)}`,
    method: 'PROPFIND',
    headers: davHeaders(endpoint, '1'),
    body: PROPFIND_BODY,
    responseType: 'text',
    timeoutMs,
    maxResponseBytes: 8 * 1024 * 1024,
  });
}

/** Reads a byte range (used for tag heads and directory covers). */
export function readRangeRequest(
  net: EchoPluginNetwork,
  endpoint: WebdavEndpoint,
  path: string,
  start: number,
  endInclusive: number,
  timeoutMs: number,
): EchoPluginOperation<NetworkResponse> {
  const headers = davHeaders(endpoint, '0');
  headers.Range = `bytes=${start}-${endInclusive}`;
  return net.request({
    url: `${normalizeServerUrl(endpoint.serverUrl)}${encodePath(path)}`,
    method: 'GET',
    headers,
    responseType: 'arrayBuffer',
    timeoutMs,
    maxResponseBytes: Math.max(endInclusive - start + 1, 0) + 64 * 1024,
  });
}

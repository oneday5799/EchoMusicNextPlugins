// Settings shape shared by the settings page and the plugin commands.
// normalizeSettings is the single gate every persisted value passes through,
// so pages can trust ids to be non-empty and server URLs to be canonical.

import type { JsonValue } from 'echo:plugin-sdk';

export interface WebdavLibraryConfig {
  id: string;
  name: string;
  serverUrl: string;
  username: string;
  password: string;
  rootPath: string;
  flatView: boolean;
}

export interface WebdavSettings {
  libraries: WebdavLibraryConfig[];
  activeLibraryId: string | null;
  coverLyricSource: 'embedded' | 'kugou';
}

export const DEFAULT_SETTINGS: WebdavSettings = {
  libraries: [],
  activeLibraryId: null,
  coverLyricSource: 'embedded',
};

export const SETTINGS_KEY = 'settings';

function asString(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

function asBoolean(value: JsonValue | undefined, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeLibrary(value: JsonValue | undefined): WebdavLibraryConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as { [key: string]: JsonValue };
  const id = asString(record.id);
  // serverUrl may be empty while a freshly added library is still being
  // filled in; commands guard against using such a library.
  if (!id) return null;
  // Keep one canonical server form (no trailing slash), matching
  // normalizeServerUrl at request time.
  const serverUrl = asString(record.serverUrl).trim().replace(/\/+$/, '');
  return {
    id,
    name: asString(record.name).trim() || asString(record.serverUrl).trim() || '未命名库',
    serverUrl,
    username: asString(record.username),
    password: asString(record.password),
    rootPath: asString(record.rootPath),
    flatView: asBoolean(record.flatView, false),
  };
}

export function normalizeSettings(value: JsonValue | undefined): WebdavSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_SETTINGS, libraries: [], activeLibraryId: null };
  }
  const record = value as { [key: string]: JsonValue };
  const libraries: WebdavLibraryConfig[] = [];
  const seen: { [key: string]: boolean } = {};
  const raw = record.libraries;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const library = normalizeLibrary(item);
      if (library && !seen[library.id]) {
        seen[library.id] = true;
        libraries.push(library);
      }
    }
  }
  const active = asString(record.activeLibraryId);
  return {
    libraries,
    coverLyricSource: record.coverLyricSource === 'kugou' ? 'kugou' : 'embedded',
    activeLibraryId: libraries.some((library) => library.id === active)
      ? active
      : libraries.length > 0
        ? libraries[0].id
        : null,
  };
}

export function findLibrary(
  settings: WebdavSettings,
  id: string | null,
): WebdavLibraryConfig | null {
  if (!id) return null;
  for (const library of settings.libraries) {
    if (library.id === id) return library;
  }
  return null;
}

export function activeLibrary(settings: WebdavSettings): WebdavLibraryConfig | null {
  return findLibrary(settings, settings.activeLibraryId) ?? settings.libraries[0] ?? null;
}

// Settings shape shared by the settings page and the plugin commands.
// normalizeSettings is the single gate every persisted value passes through,
// so pages can trust folder ids to be unique and flags to be booleans.

import type { JsonValue } from 'echo:plugin-sdk';

export interface LocalFolderConfig {
  /** The file grant id; doubles as the song folder identity. */
  id: string;
  /** Editable display name; may be empty (pages then show the grant path). */
  name: string;
  /** Display path captured at grant time; re-claims the folder when the
   * host ledger re-issues grants under a new installation. */
  path: string;
}

export interface LocalSettings {
  folders: LocalFolderConfig[];
  /** Read embedded covers and lyrics from file headers during enrichment. */
  readEmbedded: boolean;
  /** Fill missing covers/lyrics/albums from the Kugou catalog. */
  onlineFetch: boolean;
}

export const DEFAULT_SETTINGS: LocalSettings = {
  folders: [],
  readEmbedded: true,
  onlineFetch: false,
};

export const SETTINGS_KEY = 'settings';

function asBoolean(value: JsonValue | undefined, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeFolder(value: JsonValue | undefined): LocalFolderConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as { [key: string]: JsonValue };
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) return null;
  return {
    id,
    name: typeof record.name === 'string' ? record.name.trim() : '',
    path: typeof record.path === 'string' ? record.path : '',
  };
}

export function normalizeSettings(value: JsonValue | undefined): LocalSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_SETTINGS, folders: [] };
  }
  const record = value as { [key: string]: JsonValue };
  const folders: LocalFolderConfig[] = [];
  const seen: { [key: string]: boolean } = {};
  const raw = record.folders;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const folder = normalizeFolder(item);
      if (folder && !seen[folder.id]) {
        seen[folder.id] = true;
        folders.push(folder);
      }
    }
  }
  return {
    folders,
    readEmbedded: asBoolean(record.readEmbedded, DEFAULT_SETTINGS.readEmbedded),
    onlineFetch: asBoolean(record.onlineFetch, DEFAULT_SETTINGS.onlineFetch),
  };
}

export function findFolder(
  settings: LocalSettings,
  id: string | null | undefined,
): LocalFolderConfig | null {
  if (!id) return null;
  for (const folder of settings.folders) {
    if (folder.id === id) return folder;
  }
  return null;
}

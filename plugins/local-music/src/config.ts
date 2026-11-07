// Settings shape shared by the settings page and the plugin commands.
// normalizeSettings is the single gate every persisted value passes through,
// so pages can trust folder ids to be unique and flags to be booleans.

import type { JsonValue } from 'echo:plugin-sdk';
import { coerceJsonArray } from './codec.ts';

export interface LocalFolderConfig {
  /** The file grant id; doubles as the song folder identity. */
  id: string;
  /** Editable display name; may be empty (pages then show the grant path). */
  name: string;
  /** Display path captured at grant time; re-claims the folder when the
   * host ledger re-issues grants under a new installation. */
  path: string;
}

/** Online completion scope: nothing, only the playing track's own gaps, or
 * the full behavior including the scan's album-representative fallback. */
export type OnlineMode = 'off' | 'play' | 'scan';
export const ONLINE_MODES: OnlineMode[] = ['off', 'play', 'scan'];

export interface LocalSettings {
  folders: LocalFolderConfig[];
  /** Read embedded covers and lyrics from file headers during enrichment. */
  readEmbedded: boolean;
  /** Fill missing covers/lyrics from the Kugou catalog. */
  onlineMode: OnlineMode;
}

export const DEFAULT_SETTINGS: LocalSettings = {
  folders: [],
  readEmbedded: true,
  onlineMode: 'play',
};

export const SETTINGS_KEY = 'settings';

function asBoolean(value: JsonValue | undefined, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeOnlineMode(value: JsonValue | undefined): OnlineMode | null {
  return value === 'off' || value === 'play' || value === 'scan' ? value : null;
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
  for (const item of coerceJsonArray(record.folders)) {
    const folder = normalizeFolder(item);
    if (folder && !seen[folder.id]) {
      seen[folder.id] = true;
      folders.push(folder);
    }
  }
  // The boolean the dropdown replaced migrates one-to-one (on → 扫描补全,
  // off → 关闭补全) so an upgraded store keeps its behavior; only a store
  // that never carried the flag picks up the new default 播放补全.
  const legacyMode =
    record.onlineFetch === true ? 'scan' : record.onlineFetch === false ? 'off' : null;
  return {
    folders,
    readEmbedded: asBoolean(record.readEmbedded, DEFAULT_SETTINGS.readEmbedded),
    onlineMode: normalizeOnlineMode(record.onlineMode) ?? legacyMode ?? DEFAULT_SETTINGS.onlineMode,
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

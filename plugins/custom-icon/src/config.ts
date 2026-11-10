export type IconTarget = 'window' | 'tray' | 'desktop' | 'taskbar';

export const ICON_TARGETS: readonly IconTarget[] = ['window', 'tray', 'desktop', 'taskbar'];

export const TARGET_LABELS: Record<IconTarget, string> = {
  window: '窗口图标',
  tray: '托盘图标',
  desktop: '桌面快捷方式图标',
  taskbar: '固定任务栏图标',
};

export interface IconEntry {
  path: string;
  name: string;
}

export type IconEntries = Partial<Record<IconTarget, IconEntry>>;

export interface IconSettings {
  icons: IconEntries;
}

export const DEFAULT_SETTINGS: IconSettings = { icons: {} };

export const MAX_ICON_BYTES = 4 * 1024 * 1024;
export const MAX_ICON_EDGE = 2048;

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'ico', 'webp', 'bmp', 'gif'];

export function isIconTarget(value: unknown): value is IconTarget {
  return typeof value === 'string' && (ICON_TARGETS as readonly string[]).includes(value);
}

export function iconExtension(name: string): string {
  const fileName =
    String(name || '')
      .split(/[\\/]/)
      .pop() || '';
  const dot = fileName.lastIndexOf('.');
  if (dot < 0 || dot === fileName.length - 1) return 'png';
  const ext = fileName.slice(dot + 1).toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext) ? ext : 'png';
}

function normalizeEntry(value: unknown): IconEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const path = typeof record.path === 'string' ? record.path : '';
  if (!path || path.includes('..') || path.startsWith('/')) return null;
  return { path, name: typeof record.name === 'string' ? record.name : path };
}

export function normalizeIconSettings(value: unknown): IconSettings {
  const source =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const icons: IconEntries = {};
  const rawIcons = source.icons;
  if (rawIcons && typeof rawIcons === 'object' && !Array.isArray(rawIcons)) {
    const records = rawIcons as Record<string, unknown>;
    for (const target of ICON_TARGETS) {
      const entry = normalizeEntry(records[target]);
      if (entry) icons[target] = entry;
    }
  }
  return { icons };
}

export interface PlatformSupport {
  desktop: boolean;
  taskbar: boolean;
}

/** Targets that have a stored entry and are actually applicable on this platform. */
export function applicableTargets(settings: IconSettings, platform: PlatformSupport): IconTarget[] {
  return ICON_TARGETS.filter((target) => {
    if (!settings.icons[target]) return false;
    if (target === 'desktop') return platform.desktop;
    if (target === 'taskbar') return platform.taskbar;
    return true;
  });
}

export interface SkinSettings {
  enhanceContrast: boolean;
  fontScale: number;
  fontWeight: number;
  enableBlur: boolean;
  enableScale: boolean;
  enableSpring: boolean;
  fadeWidth: number;
  alignPosition: number;
}

export const SKIN_ID = 'apple-music';

export const DEFAULT_SETTINGS: SkinSettings = {
  enhanceContrast: false,
  fontScale: 100,
  fontWeight: 850,
  enableBlur: true,
  enableScale: true,
  enableSpring: true,
  fadeWidth: 50,
  alignPosition: 48,
};

const NUMBER_SETTINGS: Record<string, [number, number]> = {
  fontScale: [50, 200],
  fontWeight: [300, 900],
  fadeWidth: [0, 100],
  alignPosition: [0, 100],
};

const BOOLEAN_SETTINGS = ['enhanceContrast', 'enableBlur', 'enableScale', 'enableSpring'];

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function validateSettings(values: Record<string, unknown>): boolean | { errors?: string[] } {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return { errors: ['皮肤设置必须是 JSON 对象'] };
  }
  const errors: string[] = [];
  for (const key of BOOLEAN_SETTINGS) {
    if (values[key] !== undefined && typeof values[key] !== 'boolean') {
      errors.push(`${key} 必须是布尔值`);
    }
  }
  for (const key of Object.keys(NUMBER_SETTINGS)) {
    const [min, max] = NUMBER_SETTINGS[key];
    const value = values[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      errors.push(`${key} 必须是 ${min}..${max} 之间的数值`);
    }
  }
  return errors.length === 0 ? true : { errors };
}

export function normalizeSettings(value: unknown): SkinSettings {
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const number = (key: keyof SkinSettings, fallback: number) => {
    const raw = Number(source[key]);
    return Number.isFinite(raw) ? raw : fallback;
  };
  return {
    enhanceContrast: source.enhanceContrast === true,
    fontScale: clamp(number('fontScale', DEFAULT_SETTINGS.fontScale), 50, 200),
    fontWeight: clamp(number('fontWeight', DEFAULT_SETTINGS.fontWeight), 300, 900),
    enableBlur: source.enableBlur !== false,
    enableScale: source.enableScale !== false,
    enableSpring: source.enableSpring !== false,
    fadeWidth: clamp(number('fadeWidth', DEFAULT_SETTINGS.fadeWidth), 0, 100),
    alignPosition: clamp(number('alignPosition', DEFAULT_SETTINGS.alignPosition), 0, 100),
  };
}

const QUALITY_TAGS: Record<string, string> = {
  standard: 'SD',
  higher: 'HQ',
  flac: 'SQ',
  hi_res: 'HR',
  viper_tape: 'VPT',
  viper_clear: 'VPC',
  viper_atmos: 'VPA',
};

const QUALITY_LABELS: Record<string, string> = {
  standard: '标准',
  higher: '高品质',
  flac: '无损',
  hi_res: 'Hi-Res',
  viper_tape: '蝰蛇母带',
  viper_clear: '蝰蛇超清',
  viper_atmos: '蝰蛇全景声',
};

/** Short badge text for the current effective quality, mirroring host labels. */
export function qualityTag(quality: string, cloudSource: boolean): string {
  return cloudSource ? 'CLD' : (QUALITY_TAGS[quality] ?? '');
}

/** Full quality description for tooltips and accessibility. */
export function qualityLabel(quality: string, cloudSource: boolean): string {
  if (cloudSource) return '云盘';
  return QUALITY_LABELS[quality] ?? '';
}

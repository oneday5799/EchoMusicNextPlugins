// 原版 EchoMusic「GitHub 加速」插件（xiaotian2333，MIT）的数据模型与判定逻辑移植。
// 镜像列表来自社区维护的 data.json；宿主 EchoMusicNext 的网络设置不开放给插件，
// 因此插件只负责检测与推荐，由用户粘贴到宿主网络设置中生效。

export interface MirrorTest {
  /** 用于探测镜像连通性的真实资源地址。 */
  url: string;
  /** 探测地址追加缓存穿透参数。 */
  random: boolean;
  /** 单个镜像的探测超时（毫秒）。 */
  timeoutMs: number;
}

export interface MirrorData {
  version: string;
  update: string;
  test: MirrorTest;
  /** 按优先级排列的加速站地址；测速时首个可达者获胜。 */
  mirrors: string[];
}

/** 原版插件作者的云端数据源，保持沿用以共享社区镜像列表。 */
export const REMOTE_DATA_URL = 'https://oss.xt-url.com/EchoMusic/github-accelerate/data.json';

/** 随包内置的兜底数据，与原版插件 1.0.0 的 data.json 一致。 */
export const DEFAULT_DATA: MirrorData = {
  version: '1.0.0',
  update: '2026-07-27',
  test: {
    url: 'https://raw.githubusercontent.com/EchoMusic-org/github-accelerate/main/manifest.json',
    random: true,
    timeoutMs: 5000,
  },
  mirrors: ['https://github.cnmclash.de5.net'],
};

/** 镜像数量上限，防止异常数据拖垮激活。 */
export const MIRROR_LIMIT = 64;
export const TEST_TIMEOUT_RANGE = { minimum: 1000, maximum: 30000 } as const;

/** 原版插件的每日更新检查间隔；宿主定时器上限同为一天。 */
export const DAILY_REFRESH_MS = 24 * 60 * 60 * 1000;

/** 简易三段版本比较，只认数字段，返回 1/0/-1。 */
export function compareVersion(left: string, right: string): number {
  const a = String(left).split('.');
  const b = String(right).split('.');
  for (let i = 0; i < 3; ++i) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** 原版插件同样使用 UTC 日期判断“每日首次”。 */
export function todayStr(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function normalizeMirror(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

function normalizeTest(value: unknown): MirrorTest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_DATA.test };
  const source = value as Record<string, unknown>;
  const url =
    typeof source.url === 'string' && /^https?:\/\//i.test(source.url.trim())
      ? source.url.trim()
      : DEFAULT_DATA.test.url;
  const random = typeof source.random === 'boolean' ? source.random : true;
  const timeout =
    typeof source.timeout === 'number' && Number.isFinite(source.timeout)
      ? source.timeout
      : DEFAULT_DATA.test.timeoutMs;
  return {
    url,
    random,
    timeoutMs: Math.min(
      TEST_TIMEOUT_RANGE.maximum,
      Math.max(TEST_TIMEOUT_RANGE.minimum, Math.round(timeout)),
    ),
  };
}

/** 校验并规范化远端/本地数据；没有可用镜像时返回 null（视为无效数据）。 */
export function normalizeMirrorData(value: unknown): MirrorData | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const mirrors: string[] = [];
  // 云端 data.json 用 `data` 键，本插件落盘/回读用 `mirrors` 键，两者都接受。
  const raw = Array.isArray(source.mirrors)
    ? source.mirrors
    : Array.isArray(source.data)
      ? source.data
      : [];
  for (const item of raw) {
    const mirror = normalizeMirror(item);
    if (mirror && !mirrors.includes(mirror)) mirrors.push(mirror);
    if (mirrors.length >= MIRROR_LIMIT) break;
  }
  if (!mirrors.length) return null;
  return {
    version: typeof source.version === 'string' ? source.version : '',
    update: typeof source.update === 'string' ? source.update : '',
    test: normalizeTest(source.test),
    mirrors,
  };
}

/** 拼接镜像探测地址；test.url 本身是完整 URL，交由镜像前缀代理。 */
export function mirrorProbeUrl(mirror: string, test: MirrorTest, cacheBust: number): string {
  const base = `${mirror.replace(/\/+$/, '')}/${test.url}`;
  const separator = base.includes('?') ? '&' : '?';
  return test.random ? `${base}${separator}_=${cacheBust}` : base;
}

/** 与原版判定一致：镜像返回任意非 5xx 响应即视为可达。 */
export function reachable(status: number): boolean {
  return status >= 200 && status < 500;
}

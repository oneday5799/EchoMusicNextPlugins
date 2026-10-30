// 码池侧（Cloudflare Worker + Durable Object）v2 快照/租约协议客户端。
// 唯一入口 https://echo-team-pool.oneday.vip：*.workers.dev 在中国大陆被 DNS 污染，
// 单地址下候选列表机制只是空转（2026-09-30 实测确认），不保留备选地址。

import type { JsonValue } from 'echo:plugin-sdk';
import type { TeamMember, TeamView } from './kugou.ts';

export const POOL_URL = 'https://echo-team-pool.oneday.vip';
export const POOL_RATE_LIMIT_BACKOFF_MS = 60_000; // 429 短退避：令牌桶持续 1r/s，很快恢复
// 传输层失败（连接被重置/超时/无路由）的退避：固定短间隔。这类失败源于用户本地网络，
// 通常是瞬时的，5→15→30 分钟阶梯不成比例（2026-10-02 线上一次 RESET 即被锁进最深档）。
export const POOL_TRANSPORT_BACKOFF_MS = 60_000;

export interface PoolResponse {
  ok: boolean;
  status: number;
  data: unknown;
  error?: string;
  headers: Record<string, string>;
  cfChallenge?: boolean;
  cfEdgeError?: boolean;
  needUpdate?: boolean;
  cfRay?: string;
  cfMitigated?: string;
}

export interface PoolTeamState {
  code: string;
  member_count: number;
  captain: string;
  members: TeamMember[];
}

export interface PoolSnapshotPayload {
  period_id: string;
  uid: string;
  token: string;
  created: PoolTeamState | null;
  joined: PoolTeamState | null;
  joined_checked: boolean;
}

export function toPoolTeamState(team: TeamView | null): PoolTeamState | null {
  if (!team) return null;
  return {
    code: team.code,
    member_count: team.memberCount,
    captain: team.captain,
    members: team.members,
  };
}

// 码池请求头。补齐常规 API 客户端应携带的头属于让自有客户端正常表达自己，
// 不是绕过质询——质询（challenge）仍会拦，站点侧正确做法是配置 WAF 跳过规则。
// X-Plugin-Version 参与码池 MIN_CLIENT_VERSION（当前 1.2.0）门禁，须不低于它。
export function poolHeaders(pluginVersion: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    'X-Plugin-Version': pluginVersion,
  };
}

function bodyText(data: unknown): string {
  try {
    const text = typeof data === 'string' ? data : JSON.stringify(data ?? '');
    return text === undefined ? String(data ?? '') : text;
  } catch {
    return String(data ?? '');
  }
}

function headerValue(headers: Record<string, string>, name: string): string {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers || {})) {
    if (key.toLowerCase() === target) return String(headers[key] ?? '');
  }
  return '';
}

// Cloudflare 质询页识别：Electron/Qt 网络栈没有可执行 JS 的浏览器环境，质询永远过不了；
// 与其在退避阶梯里空转，不如直接识别出来告知站点侧去配 WAF 跳过规则。
export function isCfChallenge(response: PoolResponse): boolean {
  const status = Number(response.status) || 0;
  if (status !== 403 && status !== 503) return false;
  const text = bodyText(response.data);
  if (!text) return false;
  return /Attention Required|Just a moment|cf-browser-verification|cf_chl_|challenge-platform|Enable JavaScript and cookies/i.test(
    text,
  );
}

// Cloudflare 边缘错误（1xxx，如 1006/1016/1020/1033/1042）：说明该主机根本没有 Worker 脚本。
// 我们自己的 Worker 错误体是 {ok:false, error:"字符串码"}，与 CF 的数字 1xxx 区分开。
export function isCfEdgeError(response: PoolResponse): boolean {
  const data = response.data;
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    if (record.ok === false && typeof record.error === 'string') return false;
    const code = Number(record.error_code);
    if (record.cloudflare_error === true) return true;
    if (Number.isFinite(code) && code >= 1000 && code < 2000) return true;
  }
  const text = bodyText(data);
  return /cloudflare-1xxx-errors|workers_dev_script_not_found|No Workers script was found/i.test(
    text,
  );
}

// 质询诊断：优先取响应头 cf-ray / cf-mitigated；头缺失时回退解析 HTML 页脚。
// 有了 Ray ID，用户可在 Security → Events 精确查到是哪个产品拦的。
export function cfChallengeTrace(response: PoolResponse): { cfRay: string; cfMitigated: string } {
  let ray = headerValue(response.headers || {}, 'cf-ray');
  const mitigated = headerValue(response.headers || {}, 'cf-mitigated');
  if (!ray) {
    const match = /Ray ID:\s*([0-9a-f]{8,})|"?ray_id"?\s*:\s*"([0-9a-f]{8,})"/i.exec(
      bodyText(response.data),
    );
    if (match) ray = match[1] || match[2] || '';
  }
  return { cfRay: ray, cfMitigated: mitigated };
}

// 码池失败的现场诊断：进「复制错误详情」。
// 关键场景是 Cloudflare 安全挑战——body 是 HTML 而非 JSON；
// Ray ID 置于 body 之前：body 会被截断，而 Ray ID 在质询页页脚，截断后必丢。
export function buildPoolDiag(path: string, response: PoolResponse): { [key: string]: JsonValue } {
  const data = response.data;
  let text = '';
  if (data !== undefined && data !== null) {
    try {
      const serialized = typeof data === 'string' ? data : JSON.stringify(data);
      text = serialized === undefined ? String(data) : serialized;
    } catch {
      text = String(data);
    }
  }
  return {
    endpoint: POOL_URL + path,
    httpStatus: Number(response.status) || 0,
    poolError: String(response.error || ''),
    cfRay: String(response.cfRay || ''),
    cfMitigated: String(response.cfMitigated || ''),
    body: text.length > 1200 ? text.slice(0, 1200) + '…(已截断)' : text,
  };
}

// ---------- 退避状态 ----------

export const POOL_BACKOFF_STEPS_MS = [5, 15, 30].map((minutes) => minutes * 60_000);
export const POOL_EMPTY_BACKOFF_STEPS_MS = [20, 30, 60].map((minutes) => minutes * 60_000);

export interface BackoffState {
  step: number;
  nextAttemptAt: number;
}

export function createBackoff(): BackoffState {
  return { step: 0, nextAttemptAt: 0 };
}

// 退避阶梯 5→15→30 分钟后封顶，step 同步封顶避免长时间失败后计数无意义地膨胀。
export function poolDown(state: BackoffState, now: number, transport = false): void {
  if (transport) {
    // 不动 step：传输层失败与服务端故障的阶梯互不污染。
    state.nextAttemptAt = now + POOL_TRANSPORT_BACKOFF_MS;
    return;
  }
  const index = Math.min(state.step, POOL_BACKOFF_STEPS_MS.length - 1);
  state.nextAttemptAt = now + POOL_BACKOFF_STEPS_MS[index];
  state.step = Math.min(state.step + 1, POOL_BACKOFF_STEPS_MS.length - 1);
}

export function poolRateLimited(state: BackoffState, now: number): void {
  state.nextAttemptAt = Math.max(state.nextAttemptAt, now + POOL_RATE_LIMIT_BACKOFF_MS);
}

export function poolUp(state: BackoffState): void {
  state.step = 0;
  state.nextAttemptAt = 0;
}

export function poolAvailable(state: BackoffState, now: number): boolean {
  return now >= state.nextAttemptAt;
}

// 池空退避：池里暂时没有可用队伍时，不再每 10 分钟重复 snapshot+join。
// 手动刷新/启动/登录触发的完整流程（force）不受限制；成功领到码立即清零。
export function poolEmptyBackoffStart(state: BackoffState, now: number): void {
  if (state.nextAttemptAt > now) return;
  const index = Math.min(state.step, POOL_EMPTY_BACKOFF_STEPS_MS.length - 1);
  state.nextAttemptAt = now + POOL_EMPTY_BACKOFF_STEPS_MS[index];
  state.step = Math.min(state.step + 1, POOL_EMPTY_BACKOFF_STEPS_MS.length - 1);
}

export function backoffRemainingMs(state: BackoffState, now: number): number {
  return state.nextAttemptAt - now;
}

// 退避窗口内应当**保留**而非覆盖的根因错误码（与开启退避的分支一一对应）。
// 刻意不包含：pool_unauthorized（按期次永久停用）、pool_bad_response（直接 return）、
// pool_empty（独立池空退避）、pool_backoff（本身就是回显）。
export const POOL_ROOT_CAUSE_CODES = new Set([
  'pool_cf_challenge',
  'pool_down',
  'pool_rate_limited',
  'pool_net_error',
]);

// 码池响应的规范化（传输层调用后）：识别版本门禁、质询与边缘错误。
export function normalizePoolResponse(raw: {
  status: number;
  data: unknown;
  headers: Record<string, string>;
  error?: string;
  ok?: boolean;
}): PoolResponse {
  const response: PoolResponse = {
    ok: raw.ok ?? false,
    status: raw.status,
    data: raw.data,
    headers: raw.headers || {},
  };
  if (raw.error) response.error = raw.error;
  const data = raw.data;
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined;
  if (
    raw.status === 403 &&
    (record?.error === 'version_mismatch' || record?.error === 'version_missing')
  ) {
    response.needUpdate = true;
  }
  if (isCfChallenge(response)) {
    response.cfChallenge = true;
    response.ok = false;
    const trace = cfChallengeTrace(response);
    response.cfRay = trace.cfRay;
    response.cfMitigated = trace.cfMitigated;
  } else if (isCfEdgeError(response)) {
    response.cfEdgeError = true;
    response.ok = false;
    const trace = cfChallengeTrace(response);
    response.cfRay = trace.cfRay;
    response.cfMitigated = trace.cfMitigated;
  } else {
    response.ok = raw.ok ?? (raw.status >= 200 && raw.status < 300);
  }
  return response;
}

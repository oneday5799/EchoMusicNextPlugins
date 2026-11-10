// 酷狗概念版组队接口的观察者与请求构造。
// 接口为 gateway.kugou.com 的 /youth/v1/ut/*（与旧宿主 server/module/team_*.js 一致），
// 响应字段名可能随官方调整——解析保持旧插件的宽松多键名兼容。

import type { JsonValue } from 'echo:plugin-sdk';
import { h5Token, signatureWebParams, signatureWebParamsWithBody } from './crypto.ts';

export const TARGET_MEMBERS = 3; // 1 队长 + 2 队员（与 team-pool-worker 的 TEAM_CAPACITY 一致）
const GATEWAY_ORIGIN = 'https://gateway.kugou.com';
// 旧宿主 createRequest 的固定协议头（kg-* 为酷狗内部来源标识，静态值）
const PROTOCOL_HEADERS = {
  'User-Agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi',
  'kg-rc': '1',
  'kg-thash': '5d816a0',
  'kg-rec': '1',
  'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
};
const APPID = 3116; // 概念版 lite
const CLIENTVER = 11440;
const SRCAPPID = 2919;

// 旧宿主 teamRequest 的业务终态错误码：这些失败与验证码无关，不触发人机验证重试。
// 143005 为设备级终态（每台设备只能加入一个队伍）。
const BIZ_JOIN_CODES = new Set([143001, 143004, 143010, 143005, 20006]);

export interface KugouAuth {
  token: string;
  userid: string;
  t1: string;
  dfid: string;
  mid: string;
  uuid: string;
  guid: string;
  serverDev: string;
  mac: string;
}

export interface GatewayRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body: string | null;
}

export interface GatewayResponse {
  ok: boolean;
  status: number;
  body: unknown;
  error?: string;
  headers: Record<string, string>;
}

// 从拦截器捕获的逻辑 Authorization 头解析身份。
// 头格式与旧插件从 pinia 拼装的 buildAuthHeader 一致：token=…;userid=…;KUGOU_API_MID=…
export function parseAuthHeader(header: string): KugouAuth | null {
  const fields: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    fields[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  if (!fields.token || !fields.userid) return null;
  return {
    token: fields.token,
    userid: fields.userid,
    t1: fields.t1 || '',
    dfid: fields.dfid || '',
    mid: fields.KUGOU_API_MID || fields.mid || '',
    uuid: fields.uuid || '',
    guid: fields.KUGOU_API_GUID || fields.guid || '',
    serverDev: fields.KUGOU_API_DEV || fields.serverDev || '',
    mac: fields.KUGOU_API_MAC || fields.mac || '',
  };
}

function pick(obj: unknown, keys: string[], fallback: unknown): unknown {
  if (!obj || typeof obj !== 'object') return fallback;
  const record = obj as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

function asString(value: unknown, fallback = ''): string {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function asNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function buildTeamRequest(
  auth: KugouAuth,
  endpoint: TeamEndpoint,
  args: { periodId?: string; teamCode?: string },
  // 调用方用 h5TokenAsync 预计算并传入，让冷启动 RSA 不阻塞 UI 线程；
  // 缺省走同步缓存版（测试与旧调用路径）
  h5token?: string,
): GatewayRequest {
  const params: Record<string, string | number> = {
    srcappid: SRCAPPID,
    clientver: CLIENTVER,
    clienttime: Date.now(),
    mid: auth.mid || '',
    uuid: auth.uuid || '-',
    dfid: auth.dfid || '-',
    appid: APPID,
    userid: Number(auth.userid) || 0,
    token: h5token ?? h5Token(auth.token),
  };
  let method = 'GET';
  let body: string | null = null;
  if (endpoint === 'get_my_team_info') {
    params.period_id = asString(args.periodId);
  } else if (endpoint === 'create_team') {
    method = 'POST';
    body = JSON.stringify({ period_id: asString(args.periodId) });
  } else if (endpoint === 'join_team') {
    method = 'POST';
    body = JSON.stringify({ team_code: asString(args.teamCode) });
  }
  const signature = body ? signatureWebParamsWithBody(params, body) : signatureWebParams(params);
  const query: Record<string, string> = {};
  for (const key of Object.keys(params)) query[key] = String(params[key]);
  query.signature = signature;
  const headers: Record<string, string> = { ...PROTOCOL_HEADERS };
  headers.dfid = query.dfid;
  headers.clienttime = String(params.clienttime);
  headers.mid = query.mid;
  return {
    url: GATEWAY_ORIGIN + '/youth/v1/ut/' + endpoint,
    method,
    headers,
    query,
    body,
  };
}

export type TeamEndpoint = 'get_period_info' | 'get_my_team_info' | 'create_team' | 'join_team';

export interface PeriodInfo {
  periodId: string;
  periodName: string;
  startTime: string;
  endTime: string;
  active: boolean;
  totalMembers: number;
  raw: unknown;
}

export function normalizePeriod(body: unknown): PeriodInfo {
  const root = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const data = (root.data ?? root) as Record<string, unknown>;
  const current = (data.current_period_info ?? data.period_info ?? data ?? {}) as Record<
    string,
    unknown
  >;
  const total = asNumber(
    pick(
      current,
      ['team_member_count', 'member_count', 'team_num', 'target_member', 'limit', 'need_count'],
      TARGET_MEMBERS,
    ),
    TARGET_MEMBERS,
  );
  const statusRaw = asNumber(pick(current, ['status'], -1), -1);
  return {
    periodId: asString(pick(current, ['id', 'period_id', 'periodId', 'activity_id'], '')),
    periodName: asString(pick(current, ['name'], '')),
    startTime: asString(pick(current, ['start_time'], '')),
    endTime: asString(pick(current, ['end_time'], '')),
    active: statusRaw === 0,
    totalMembers: total >= TARGET_MEMBERS ? total : TARGET_MEMBERS,
    raw: body,
  };
}

export interface TeamMember {
  userid: string;
  nick: string;
  role: number;
  reward: string;
}

export interface TeamView {
  code: string;
  memberCount: number;
  captain: string;
  members: TeamMember[];
  vipDesc: string;
}

export interface TeamInfo {
  created: TeamView | null;
  joined: TeamView | null;
  /** 区分“明确拿到空 my_join_team_list”与“字段缺失/响应异常”：仅前者允许服务端清空 last_joined_code */
  joinedChecked: boolean;
  raw: unknown;
}

function toMembers(list: unknown): TeamMember[] {
  if (!Array.isArray(list)) return [];
  const out: TeamMember[] = [];
  for (const item of list.slice(0, TARGET_MEMBERS)) {
    const userid = asString(pick(item, ['userid', 'user_id'], ''));
    if (!userid) continue;
    out.push({
      userid,
      nick: asString(pick(item, ['nick_name', 'nickname', 'nick'], '')).slice(0, 48),
      role: asNumber(pick(item, ['role'], 2), 2) === 1 ? 1 : 2,
      reward: asString(pick(item, ['vip_desc', 'reward_desc'], '')).slice(0, 48),
    });
  }
  return out;
}

function toTeam(team: unknown): TeamView | null {
  if (!team || typeof team !== 'object') return null;
  const record = team as Record<string, unknown>;
  const code = asString(pick(record, ['team_code', 'code', 'teamCode'], ''));
  if (!code) return null;
  const listLength = Array.isArray(record.member_list) ? record.member_list.length : 0;
  const count =
    listLength > 0
      ? listLength
      : asNumber(pick(record, ['member_count', 'count', 'members_count', 'current_count'], 1), 1);
  return {
    code,
    memberCount: Math.min(TARGET_MEMBERS, Math.max(1, Math.round(count) || 1)),
    captain: asString(pick(record, ['captain'], '') || ''),
    members: toMembers(record.member_list),
    vipDesc: asString(pick(record, ['vip_desc'], '')),
  };
}

export function normalizeTeamInfo(body: unknown): TeamInfo {
  const root = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const data = (root.data ?? root) as Record<string, unknown>;
  const createList = Array.isArray(data.my_create_team_list) ? data.my_create_team_list : [];
  const joinListRaw = data.my_join_team_list;
  const joinList = Array.isArray(joinListRaw) ? joinListRaw : [];
  return {
    created: toTeam(createList[0]),
    joined: toTeam(joinList[0]),
    joinedChecked: Array.isArray(joinListRaw),
    raw: data,
  };
}

export interface JoinFailure {
  kind: 'transient' | 'full' | 'already_joined' | 'invalid';
  errorCode: number;
  errorMsg: string;
}

// 错误分类：仅显式证据才归类为队伍终态（full/already_joined/invalid），其余一律 transient。
// 分类原则：数值码证据最硬优先；文案关键词兜底；默认 transient 不惩罚队伍（非对称代价）。
export function classifyJoinError(body: unknown): JoinFailure {
  const errorCode = asNumber(pick(body, ['error_code', 'errcode', 'code'], 0), 0);
  const msg = asString(pick(body, ['error_msg', 'msg', 'message'], '')).toLowerCase();

  let kind: JoinFailure['kind'] = 'transient';
  if (errorCode === 143004 || errorCode === 20006 || msg.includes('满') || msg.includes('full'))
    kind = 'full';
  else if (
    errorCode === 143010 ||
    errorCode === 143005 ||
    msg.includes('已加入') ||
    msg.includes('是队伍成员') ||
    msg.includes('已参') ||
    msg.includes('只能加入') ||
    msg.includes('joined')
  )
    // 143010 实测文案“你已经是队伍成员~”；143005 为设备级“每台设备只能加入一个队伍~~”；
    // “只能加入”仅命中设备级约束文案，不误伤满员/无效码
    kind = 'already_joined';
  else if (
    errorCode === 143001 ||
    msg.includes('不存在') ||
    msg.includes('无效') ||
    msg.includes('已解散') ||
    msg.includes('组队码错误')
  )
    kind = 'invalid';
  return { kind, errorCode, errorMsg: asString(pick(body, ['error_msg', 'msg', 'message'], '')) };
}

// create_team 的“已建过队”拒绝（2026-11-01 实测文案“你已经创建过队伍啦~”，数值码未固定）：
// 队伍已存在＝建队目标已达成，调用方应转去取回已建队伍，而不是按建队失败处理。
export function isAlreadyCreatedError(body: unknown): boolean {
  const msg = asString(pick(body, ['error_msg', 'msg', 'message'], ''));
  return /创建过|已创建/.test(msg);
}

// 判定 join / create 响应是否成功：要求**显式** status === 1，错误码仅在字段确实存在时才要求为 0。
// 缺省值一律按失败处理（fail-closed），避免把 null/空对象静默吞成“入队成功”。
export function parseJoinResponse(response: GatewayResponse): {
  httpOk: boolean;
  bizOk: boolean;
  errorCode: number;
  errorMsg: string;
} {
  const body = response.body;
  const isObj = Boolean(body) && typeof body === 'object';
  const hasStatus = isObj && (body as Record<string, unknown>).status !== undefined;
  const bodyStatus = hasStatus ? asNumber(pick(body, ['status'], NaN), NaN) : NaN;
  const hasErrCode =
    isObj &&
    ((body as Record<string, unknown>).error_code !== undefined ||
      (body as Record<string, unknown>).errcode !== undefined ||
      (body as Record<string, unknown>).code !== undefined);
  const errorCode = asNumber(pick(body, ['error_code', 'errcode', 'code'], 0), 0);
  const errorMsg = asString(pick(body, ['error_msg', 'msg', 'message'], ''));
  const httpOk = Boolean(response.ok) && response.status > 0 && response.status < 400;
  const bizOk = bodyStatus === 1 && (!hasErrCode || errorCode === 0);
  return { httpOk, bizOk: hasStatus && bizOk, errorCode, errorMsg };
}

export interface PeriodFailure {
  code: string;
  msg: string;
  diag: { [key: string]: JsonValue };
}

export function headerValue(headers: Record<string, string | string[]>, name: string): string {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers || {})) {
    if (key.toLowerCase() !== target) continue;
    const value = headers[key];
    if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : '';
    return String(value ?? '');
  }
  return '';
}

export function bodyText(body: unknown): string {
  if (body === undefined || body === null) return '';
  try {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return text === undefined ? String(body) : text;
  } catch {
    return String(body);
  }
}

// 复制详情里的原始响应体截断：超长 JSON 全量进面板状态没有意义，保留头部字段结构即可
export function truncateBody(text: string): string {
  return text.length > 1200 ? text.slice(0, 1200) + '…(已截断)' : text;
}

// 期次 GUARD 的失败诊断：区分传输层失败/HTTP 非 2xx/业务异常/确实没有期次四类，
// 让用户不打开控制台也能把现场反馈出来。
export function classifyPeriodFailure(response: GatewayResponse): PeriodFailure {
  const body = response.body;
  const diag = {
    httpStatus: response.status || 0,
    bizStatus: asString(pick(body, ['status'], '')),
    errorCode: asNumber(pick(body, ['error_code', 'errcode', 'code'], 0), 0),
    errorMsg: asString(pick(body, ['error_msg', 'msg', 'message'], '')),
    ssaCode: asString(
      pick(body, ['ssaCode', 'eventId'], '') || headerValue(response.headers, 'ssa-code'),
    ),
    body: truncateBody(bodyText(body)),
  };
  if (!response.ok)
    return {
      code: 'period_transport',
      msg: '期次请求发送失败',
      diag: { ...diag, transportError: response.error || '' },
    };
  if (diag.httpStatus && (diag.httpStatus < 200 || diag.httpStatus >= 300))
    return { code: 'period_http_error', msg: '期次接口返回 HTTP ' + diag.httpStatus, diag };
  if (diag.bizStatus !== '' && diag.bizStatus !== '1')
    return {
      code: 'period_biz_error',
      msg: '期次接口返回异常（status=' + diag.bizStatus + '）',
      diag,
    };
  return { code: 'no_period', msg: '未找到活动期次', diag };
}

// 验证码触发条件：20028 显式要求；其他失败仅当非已知业务终态错误码时触发。
export function needsCaptcha(response: GatewayResponse): string {
  const body = response.body;
  const eventId = asString(
    pick(body, ['ssaCode', 'eventId'], '') || headerValue(response.headers, 'ssa-code'),
  );
  if (!eventId) return '';
  const errorCode = asNumber(pick(body, ['error_code', 'errcode', 'code'], 0), 0);
  const failed = asNumber(pick(body, ['status'], 1), 1) === 0;
  if (errorCode === 20028 || (failed && !BIZ_JOIN_CODES.has(errorCode))) return eventId;
  return '';
}

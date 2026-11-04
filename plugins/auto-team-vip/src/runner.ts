// 单 Runner 状态机（v2 快照/租约协议）：①GUARD → ②MYINFO（无队伍则自动建队）
// → ③SNAPSHOT → ④DECIDE → ⑤ASSIGN → ⑥JOIN_KUGOU → ⑦RESULT → ⑧VERIFY。
// 必须内部捕获全部异常、永不向调用链抛出——否则 runChain 变 rejected 后所有触发点静默失效。
// 依赖全部注入，便于隔离测试真实协议行为。

import type { JsonValue } from 'echo:plugin-sdk';
import { h5TokenAsync } from './crypto.ts';
import {
  classifyJoinError,
  classifyPeriodFailure,
  buildTeamRequest,
  isAlreadyCreatedError,
  needsCaptcha,
  normalizePeriod,
  normalizeTeamInfo,
  parseJoinResponse,
  TARGET_MEMBERS,
  truncateBody,
  type GatewayRequest,
  type GatewayResponse,
  type KugouAuth,
  type TeamInfo,
  type TeamView,
} from './kugou.ts';
import {
  backoffRemainingMs,
  buildPoolDiag,
  createBackoff,
  poolAvailable,
  poolDown,
  poolEmptyBackoffStart,
  poolRateLimited,
  poolUp,
  POOL_ROOT_CAUSE_CODES,
  POOL_TRANSPORT_BACKOFF_MS,
  toPoolTeamState,
  type PoolResponse,
} from './pool.ts';

export const RETRY_MAX = 3; // 当轮 join 重试上限（含首次）
const RETRY_DELAY_MS = 2000;
// 建队被拒后重查自己的队伍码：酷狗 myinfo 连续快查返回不一致（实测 ①空→②全量），
// 读不到码先短间隔重试再放弃，不把瞬时读空当终态
const CREATED_REQUERY_MAX = 4;
const CREATED_REQUERY_DELAY_MS = 2000;
const POOL_RETRY_DELAY_MS = 500; // 瞬时故障（网络/5xx）的一次补射间隔
export const MIN_RUN_INTERVAL_MS = 10_000; // 触发合并窗口
export const REFRESH_THROTTLE_MS = 3000;
export const SNAPSHOT_INTERVAL_MS = 5 * 60_000; // 面板打开时的保活快照间隔
export const JOINED_SNAPSHOT_INTERVAL_MS = 30 * 60_000; // 已入队且面板关闭时的保活快照间隔
export const FULLFLOW_INTERVAL_MS = 10 * 60_000; // 等待新码的完整流程间隔
export const INACTIVE_PROBE_INTERVAL_MS = 30 * 60_000; // 期次未开启时的低频探测
export const HEARTBEAT_TICK_MS = 60_000;

const MSG_CF_CHALLENGE =
  '码池请求被 Cloudflare 拦截。若你正在使用代理/VPN，出口 IP 可能落在境外导致被拒，请关闭代理后重试；否则请联系插件作者。';
const MSG_POOL_NETWORK =
  '无法连接组队服务器（网络中断或连接被重置），将自动重试；请检查网络连接或代理设置。';

export interface PanelError {
  code: string;
  message: string;
  detail: { [key: string]: JsonValue };
  at: number;
}

export interface PanelState {
  loggedIn: boolean;
  periodId: string;
  periodName: string;
  periodStart: string;
  periodEnd: string;
  periodActive: boolean;
  /** unknown | error | active | inactive：驱动心跳自愈与期次探测 */
  periodState: string;
  myCode: string;
  myMemberCount: number;
  myVipDesc: string;
  targetMembers: number;
  joined: boolean;
  joinedCode: string;
  joinedMemberCount: number;
  joinedVipDesc: string;
  poolDisabled: boolean;
  poolDown: boolean;
  lastMessage: string;
  lastError: PanelError | null;
}

export function createPanelState(): PanelState {
  return {
    loggedIn: false,
    periodId: '',
    periodName: '',
    periodStart: '',
    periodEnd: '',
    periodActive: false,
    periodState: 'unknown',
    myCode: '',
    myMemberCount: 0,
    myVipDesc: '',
    targetMembers: TARGET_MEMBERS,
    joined: false,
    joinedCode: '',
    joinedMemberCount: 0,
    joinedVipDesc: '',
    poolDisabled: false,
    poolDown: false,
    lastMessage: '',
    lastError: null,
  };
}

export interface RunnerServices {
  now(): number;
  /** 作用域仍有效；停用/账号切换后为 false，流程在检查点静默终止 */
  active(): boolean;
  log(message: string): void;
  toastWarning(message: string): void;
  sleep(ms: number): Promise<void>;
  readValue(key: string): Promise<unknown>;
  writeValue(key: string, value: unknown): Promise<void>;
  auth(): KugouAuth | null;
  /** 宿主账号会话状态：与 auth() 分开——已登录但拦截器尚未捕获鉴权头时用于区分提示 */
  loggedIn(): boolean;
  gatewaySend(request: GatewayRequest): Promise<GatewayResponse>;
  /** 让出一个事件循环回合（宏任务），供 RSA 冷计算分片；缺省/测试桩可省略（不让步） */
  yieldUi?(): Promise<void>;
  verifyCaptcha(eventId: string): Promise<boolean>;
  poolSend(path: string, payload: unknown): Promise<PoolResponse>;
  publish(): void;
  readonly state: PanelState;
  readonly autoEnabled: boolean;
  readonly panelOpen: boolean;
}

class Aborted extends Error {}

export function buildErrorDetail(error: PanelError, now: number): string {
  const lines = [
    '=== EchoMusic 自动组队错误详情 ===',
    '时间: ' + new Date(error.at || now).toLocaleString(),
    '错误码: ' + error.code,
    '描述: ' + error.message,
  ];
  const detail = error.detail || {};
  for (const key of Object.keys(detail)) {
    const value = detail[key];
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      lines.push(key + ':');
      value.forEach((item, index) =>
        lines.push(
          '  #' +
            (index + 1) +
            ' ' +
            (typeof item === 'object' ? JSON.stringify(item) : String(item)),
        ),
      );
    } else {
      lines.push(key + ': ' + (typeof value === 'object' ? JSON.stringify(value) : String(value)));
    }
  }
  return lines.join('\n');
}

export function createRunner(services: RunnerServices) {
  const state = services.state;
  const poolBackoff = createBackoff();
  const poolEmptyBackoff = createBackoff();
  const disabledPeriods = new Set<string>();
  // 设备级建队标记（键=期次 id）：酷狗以"当前设备已经创建过队伍~~"拒绝建队后落盘。
  // 2026-11-03 用户实测：从未组过队的账号也可能被同样拒（资格问题而非真已建队），
  // 但两种情况下期内继续 create 都只会得到同样的拒绝（组队无法解散，期内不可逆），
  // 标记用于免做拒建后的重查循环；账号切换不清除（设备维度），随期次切换裁剪。
  const deviceCreatedPeriods = new Set<string>();
  // 设备级“本期加入被拒”标记（仅内存）：租码加入被 143005 真实拒绝且 myinfo 可见
  // 创建队时落下，退回等待队员的等待态，避免逐轮浪费租约。2026-11-05 用户确认：
  // 建队与加入是两个独立行为，创建队（哪怕无人加入）不占用设备、不妨碍加入他人——
  // 143005 实为“账号从未组过队”的资格问题（需在概念版APP组队页面手动加入一次他人
  // 队伍）。默认队长照常租码，被真实拒绝的设备据此自适应退回；重启后重新学习，
  // 每期至多浪费一个租约。随期次切换裁剪。
  const joinBlockedPeriods = new Set<string>();

  let errorSeq = 0;
  let lastRunAt = 0;
  let lastSnapshotAt = 0;
  let lastFullAt = 0;
  let lastInactiveProbeAt = 0;
  let runUid = ''; // 本轮流程的账号 id：applyTeamInfo 回写建队码缓存时使用
  // 激活时从 storage 载入的最近期次/账号：鉴权头尚未捕获、任何流程都未上网之前，
  // applyKnownPoolDisable 靠它们判读停用标记（完整流程会被鉴权门控挡在 ① 之前）
  let knownPeriodId = '';
  let knownUid = '';
  let runChain: Promise<void> | null = null;
  let versionMismatchReported = false;
  let deviceBoundToastShown = false;

  function ensureActive(): void {
    if (!services.active()) throw new Aborted('scope retired');
  }

  function setLastError(
    message: string,
    code?: string,
    detail?: { [key: string]: JsonValue },
    atTime?: number,
  ): void {
    errorSeq += 1;
    state.lastMessage = message;
    state.lastError = code
      ? { code, message, detail: detail || {}, at: atTime ?? services.now() }
      : null;
    services.publish();
  }

  // 只在本轮流程的终态且状态已确认健康时清除；中途清除会在重试期间反复消失/重现。
  function clearLastError(): void {
    state.lastMessage = '';
    state.lastError = null;
    services.publish();
  }

  function applyTeamInfo(info: TeamInfo): void {
    if (!info || !info.raw) return;
    state.myCode = info.created ? info.created.code : '';
    state.myMemberCount = info.created ? info.created.memberCount : 0;
    state.myVipDesc = info.created ? info.created.vipDesc : '';
    state.joinedCode = info.joined ? info.joined.code : '';
    state.joinedMemberCount = info.joined ? info.joined.memberCount : 0;
    state.joinedVipDesc = info.joined ? info.joined.vipDesc : '';
    state.joined = Boolean(info.joined && info.joined.code);
    if (info.created && state.periodId) rememberCreatedTeam(state.periodId, info.created);
    services.publish();
  }

  // 本期已建队伍码的本地缓存：酷狗查询失败（网络/验证码）时面板仍能直接展示已创建的队伍码，
  // 而不是空卡片等下一次重试。按「账号:期次」隔离，换账号或跨期自动失效。
  interface CreatedTeamCache {
    uid: string;
    periodId: string;
    code: string;
    memberCount: number;
    vipDesc: string;
  }

  function rememberCreatedTeam(periodId: string, team: TeamView): void {
    const record: CreatedTeamCache = {
      uid: runUid,
      periodId,
      code: team.code,
      memberCount: team.memberCount,
      vipDesc: team.vipDesc,
    };
    void services.writeValue('lastCreatedTeam', record).catch(() => {
      // 缓存失败不影响主流程
    });
  }

  async function readCreatedCache(periodId: string, uid: string): Promise<CreatedTeamCache | null> {
    try {
      const raw = await services.readValue('lastCreatedTeam');
      if (!raw || typeof raw !== 'object') return null;
      const record = raw as Record<string, unknown>;
      if (String(record.uid || '') !== uid) return null;
      if (String(record.periodId || '') !== periodId) return null;
      const code = String(record.code || '');
      if (!code) return null;
      return {
        uid,
        periodId,
        code,
        memberCount: Number(record.memberCount) || 1,
        vipDesc: String(record.vipDesc || ''),
      };
    } catch {
      return null;
    }
  }

  function applyCreatedCache(cache: CreatedTeamCache): void {
    state.myCode = cache.code;
    state.myMemberCount = cache.memberCount;
    state.myVipDesc = cache.vipDesc;
    services.publish();
  }

  // 401 停用写入：读-改-写合并进存储（与旧插件 disablePool 语义一致），
  // 保留其他账号/会话已落库的停用记录；内存 Set 只作本会话的快速判定。
  async function disablePoolAuth(key: string): Promise<void> {
    if (key) disabledPeriods.add(key);
    try {
      const stored = await services.readValue('poolAuthDisabled');
      const map: Record<string, boolean> = {};
      if (stored && typeof stored === 'object') {
        const record = stored as Record<string, unknown>;
        for (const k of Object.keys(record)) {
          if (record[k] === true) map[k] = true;
        }
      }
      for (const entry of disabledPeriods) map[entry] = true;
      await services.writeValue('poolAuthDisabled', map);
    } catch {
      // 存储失败不影响内存判定
    }
  }

  // 把内存停用表整体覆写进存储；调用方先把内存裁剪到位（期次切换只留当前期次、
  // 解除停用删掉对应记录），跨期旧记录由此主动丢弃（旧插件 F7 语义）。
  async function persistDisabledTable(): Promise<void> {
    try {
      const map: Record<string, boolean> = {};
      for (const entry of disabledPeriods) map[entry] = true;
      await services.writeValue('poolAuthDisabled', map);
    } catch {
      // 存储失败不影响本轮
    }
  }

  // ---------- 酷狗侧（观察者 + 执行器） ----------

  // 组队请求统一入口：验证码触发时经宿主验证界面处理后重试一次。
  async function teamCall(
    auth: KugouAuth,
    endpoint: Parameters<typeof buildTeamRequest>[1],
    args: { periodId?: string; teamCode?: string } = {},
  ): Promise<GatewayResponse> {
    const send = async (): Promise<GatewayResponse> => {
      // token 参数经 h5TokenAsync 预计算：命中缓存是纯查表；冷计算按模幂分片让步，
      // 避免开启开关/心跳瞬间的一次 RSA 模幂在 UI 线程冻结动画数帧
      const h5token = await h5TokenAsync(auth.token, services.yieldUi ?? (() => Promise.resolve()));
      const request = buildTeamRequest(auth, endpoint, args, h5token);
      return normalizeGateway(await services.gatewaySend(request));
    };
    ensureActive();
    let response = await send();
    const eventId = needsCaptcha(response);
    if (eventId) {
      services.log('captcha required for ' + endpoint + ': ' + eventId);
      let verified = false;
      try {
        verified = await services.verifyCaptcha(eventId);
      } catch (error) {
        services.log('verification failed: ' + String((error as Error)?.message || error));
      }
      if (verified) response = await send();
    }
    return response;
  }

  function normalizeGateway(raw: {
    ok: boolean;
    status: number;
    body: unknown;
    error?: string;
    headers?: Record<string, string>;
  }): GatewayResponse {
    const headers: Record<string, string> = {};
    const source = raw.headers || {};
    for (const key of Object.keys(source)) {
      const value = source[key];
      headers[key.toLowerCase()] = Array.isArray(value)
        ? String(value[0] ?? '')
        : String(value ?? '');
    }
    const response: GatewayResponse = {
      ok: raw.ok,
      status: raw.status,
      body: raw.body,
      headers,
    };
    if (raw.error) response.error = raw.error;
    return response;
  }

  async function getPeriodInfo(auth: KugouAuth) {
    const response = await teamCall(auth, 'get_period_info');
    if (!response.ok) {
      const failure = classifyPeriodFailure(response);
      return {
        ok: false as const,
        error: failure.msg,
        errorCode: failure.code,
        diag: failure.diag,
      };
    }
    const period = normalizePeriod(response.body);
    if (!period.periodId) {
      const failure = classifyPeriodFailure(response);
      return {
        ok: false as const,
        error: failure.msg,
        errorCode: failure.code,
        diag: failure.diag,
      };
    }
    return { ok: true as const, ...period };
  }

  async function getMyTeamInfo(auth: KugouAuth, periodId: string) {
    const response = await teamCall(auth, 'get_my_team_info', { periodId });
    if (!response.ok) return { ok: false as const, error: response.error || '请求失败' };
    // 显式业务失败（status≠1）按查询失败处理：不把错误响应静默解析成“没有任何队伍”
    const body = response.body;
    const status =
      body && typeof body === 'object' ? Number((body as Record<string, unknown>).status) : NaN;
    if (Number.isFinite(status) && status !== 1)
      return { ok: false as const, error: response.error || '接口返回异常' };
    // 宿主把响应体经 QVariant 转成 JS 对象后，嵌套数组结构的直接属性访问与序列化结果
    // 可能不一致（实测：序列化含 team_code，直读 my_create_team_list 却取不到元素）。
    // 统一做一次 JSON 文本往返得到纯净对象再解析；载荷仅数 KB、全流程级频率，开销可忽略。
    let plain: unknown = body;
    try {
      const text = JSON.stringify(body);
      if (typeof text === 'string' && text.length > 0) plain = JSON.parse(text);
    } catch {
      // 往返失败时按原对象解析（解析器自身对普通对象已被验证正确）
    }
    return { ok: true as const, ...normalizeTeamInfo(plain) };
  }

  // 建队共用路径（自动/手动两种模式都走，仅经酷狗网关、与码池无关）：无自己创建的
  // 队伍即创建（与是否已加入他人队伍无关——两行为相互独立，旧插件同此语义）→ 重查；
  // 酷狗对重复建队的拒绝（实测文案“你已经创建过队伍啦~”）视为队伍已存在，转入取回
  // 已有队伍。stop=true 表示已设置终态错误（酷狗确认已建队但查询读不到码 / 重查失败），
  // 调用方应直接结束本轮；建队失败不 stop，仅提示。
  async function ensureTeamCreated(
    auth: KugouAuth,
    periodId: string,
    uid: string,
    current: { ok: true } & TeamInfo,
    failureHint: string,
  ): Promise<{ myInfo: { ok: true } & TeamInfo; stop: boolean }> {
    if (current.created) return { myInfo: current, stop: false };
    if (deviceCreatedPeriods.has(periodId)) {
      // 本期已确认设备建过队（或被以同文案拒建）：直接重查一次取队伍码，不做拒建后的
      // 重查循环——同步以分钟计，轮询无意义。组队无法解散（官方APP亦无解散入口），
      // "已建队却查不到码"只可能是查询侧滞后或从未组队账号的资格性拒建，两者都无法
      // 通过再次 create 解决；给轻提示等待下轮流程（不算终态故障）。
      const again = await getMyTeamInfo(auth, periodId);
      ensureActive();
      if (!again.ok) {
        setLastError('获取队伍信息失败', 'myinfo_failed');
        return { myInfo: current, stop: true };
      }
      if (!again.created) {
        setLastError(
          '设备本期已建队，酷狗暂未返回队伍码。若本账号从未组过队，在概念版APP中打开一次组队页面（会自动建队）即可恢复；稍后也会自动重试',
          'created_code_pending',
          {
            periodId,
            uid,
          },
        );
        return { myInfo: again, stop: true };
      }
      return { myInfo: again, stop: false };
    }
    const createdRes = await teamCall(auth, 'create_team', { periodId });
    ensureActive();
    const createdParsed = createdRes.ok ? parseJoinResponse(createdRes) : null;
    const alreadyCreated = Boolean(
      createdParsed && !createdParsed.bizOk && isAlreadyCreatedError(createdRes.body),
    );
    if (alreadyCreated) {
      // 本期已存在该设备的队伍（组队无法解散，期内不可逆）：落持久标记，后续流程不再尝试 create
      deviceCreatedPeriods.add(periodId);
      void persistDeviceCreatedPeriods();
    }
    const refreshed = await getMyTeamInfo(auth, periodId);
    ensureActive();
    if (!refreshed.ok) {
      const cached = await readCreatedCache(periodId, uid);
      if (cached) applyCreatedCache(cached);
      setLastError('获取队伍信息失败', 'myinfo_failed');
      return { myInfo: current, stop: true };
    }
    let myInfo: { ok: true } & TeamInfo = refreshed;
    if (alreadyCreated && !myInfo.created) {
      // 建队被拒＝真已建队或从未组队账号的资格性拒建（2026-11-03 用户实测），两种情况
      // 期内都无法靠再次 create 推进；重查读不到码按查询侧数据未同步处理，短间隔重试后再放弃
      for (let retry = 0; retry < CREATED_REQUERY_MAX && !myInfo.created; retry += 1) {
        await services.sleep(CREATED_REQUERY_DELAY_MS);
        ensureActive();
        const again = await getMyTeamInfo(auth, periodId);
        if (again.ok) myInfo = again;
      }
    }
    if (alreadyCreated && !myInfo.created) {
      // 酷狗确认已建队但查询读不到队伍码：如实提示并携带双方原始响应与解析探针，
      // 复制错误详情即可定位取数缺口（不虚构成功也不误报建队失败）。终止本轮：
      // 若队伍真实存在，本期状态以酷狗侧为准，等下轮直查；若是资格性拒建，
      // 需用户先在概念版APP手动组队一次，插件侧无能为力。
      const raw = JSON.stringify(myInfo.raw) || '';
      const list = (myInfo.raw as { my_create_team_list?: unknown } | undefined)
        ?.my_create_team_list;
      const first = Array.isArray(list) ? (list as unknown[])[0] : undefined;
      setLastError(
        '酷狗提示本期已创建过队伍，但暂时查询不到队伍码。若本账号从未组过队，在概念版APP中打开一次组队页面（会自动建队）即可恢复；若持续出现请复制错误详情反馈',
        'created_team_unreadable',
        {
          periodId,
          uid,
          createError: (createdParsed && createdParsed.errorMsg) || '',
          myTeamInfoBody: truncateBody(raw),
          parseProbe: [
            'rawType=' + typeof myInfo.raw,
            'list=' + (Array.isArray(list) ? 'array' : typeof list),
            'first=' + typeof first,
            'code=' +
              (first && typeof first === 'object'
                ? String((first as Record<string, unknown>).team_code ?? '')
                : '-'),
          ].join(','),
        },
      );
      return { myInfo, stop: true };
    } else if (
      !alreadyCreated &&
      (!createdParsed || !createdParsed.httpOk || !createdParsed.bizOk) &&
      !myInfo.created
    ) {
      // 建队失败不阻断本轮后续（自动模式仍可经码池加入他人；手动模式可手动输入组队码），
      // 但给出可见提示
      const detail =
        (createdParsed && createdParsed.errorMsg) || String(createdRes.error || '请求失败');
      setLastError(`自动创建队伍失败（${detail}），${failureHint}`, 'create_team_failed', {
        periodId,
        detail,
      });
    }
    return { myInfo, stop: false };
  }

  // ---------- 码池侧 ----------

  // 旧插件在每次打开面板时重置版本不匹配提示（用户重新看到"请更新"）。
  function onPanelOpened(): void {
    versionMismatchReported = false;
  }

  async function getPoolToken(uid: string): Promise<string> {
    try {
      const tokens = await services.readValue('poolTokens');
      if (tokens && typeof tokens === 'object') {
        const value = (tokens as Record<string, unknown>)[uid];
        if (typeof value === 'string') return value;
      }
    } catch {
      // 读取失败按无 token 处理，由服务端重签
    }
    return '';
  }

  async function isPoolDisabled(periodId: string, uid: string): Promise<boolean> {
    if (disabledPeriods.has(periodId + ':' + uid)) return true;
    try {
      const map = await services.readValue('poolAuthDisabled');
      return Boolean(
        map && typeof map === 'object' && (map as Record<string, unknown>)[periodId + ':' + uid],
      );
    } catch {
      return false;
    }
  }

  async function loadDisabledPeriods(): Promise<void> {
    try {
      const map = await services.readValue('poolAuthDisabled');
      if (map && typeof map === 'object') {
        for (const key of Object.keys(map as Record<string, unknown>)) disabledPeriods.add(key);
      }
    } catch {
      // 内存集合从空开始
    }
  }

  async function persistDeviceCreatedPeriods(): Promise<void> {
    try {
      const map: Record<string, boolean> = {};
      for (const entry of deviceCreatedPeriods) map[entry] = true;
      await services.writeValue('deviceCreatedPeriods', map);
    } catch {
      // 存储失败不影响内存判定
    }
  }

  async function loadDeviceCreatedPeriods(): Promise<void> {
    try {
      const map = await services.readValue('deviceCreatedPeriods');
      if (map && typeof map === 'object') {
        for (const key of Object.keys(map as Record<string, unknown>)) {
          if ((map as Record<string, unknown>)[key] === true) deviceCreatedPeriods.add(key);
        }
      }
    } catch {
      // 内存集合从空开始
    }
  }

  function remainingBackoffSeconds(now: number): number {
    return Math.max(1, Math.ceil(backoffRemainingMs(poolBackoff, now) / 1000));
  }

  // 上报快照；返回 "ok" | "disabled" | "down"。
  // confirm：入队成功后的 VERIFY 快照强制发送一次——即使结果回报失败刚开启了退避，
  // 否则 success 租约 10 分钟后过期、名额被释放，又可能分配给其他人。
  async function doSnapshot(
    periodId: string,
    uid: string,
    teamInfo: TeamInfo,
    options: { confirm?: boolean } = {},
  ): Promise<'ok' | 'disabled' | 'down'> {
    const now = services.now();
    if (await isPoolDisabled(periodId, uid)) {
      state.poolDisabled = true;
      services.publish();
      return 'disabled';
    }
    if (!options.confirm && !poolAvailable(poolBackoff, now)) {
      state.poolDown = true;
      services.publish();
      const waitSec = remainingBackoffSeconds(now);
      const previous = state.lastError;
      if (previous && POOL_ROOT_CAUSE_CODES.has(previous.code)) {
        // 保留根因：本轮并未发请求，上一轮失败携带的现场诊断才是唯一线索。
        setLastError(
          previous.message,
          previous.code,
          {
            ...(previous.detail || {}),
            退避剩余秒: waitSec,
            退避档位: poolBackoff.step,
            根因发生于: new Date(previous.at || now).toLocaleString(),
            note: '本轮处于退避窗口内未发请求，上述为退避起因的真实错误',
          },
          previous.at,
        );
      } else {
        setLastError(
          `码池暂时不可用，约 ${Math.ceil(waitSec / 60)} 分钟后自动重试`,
          'pool_backoff',
          {
            periodId,
            uid,
            waitSeconds: waitSec,
            backoffStep: poolBackoff.step,
          },
        );
      }
      return 'down';
    }

    const token = await getPoolToken(uid);
    const created = toPoolTeamState(teamInfo.created);
    if (created && !created.captain) created.captain = uid;
    const payload = {
      period_id: periodId,
      uid,
      token,
      created,
      joined: toPoolTeamState(teamInfo.joined),
      // 只有明确拿到 my_join_team_list（数组）时才允许服务端清空 last_joined_code
      joined_checked: teamInfo.joinedChecked === true,
    };
    const response = await poolRequest('/v2/snapshot', payload);
    if (response.ok) {
      poolUp(poolBackoff);
      const record =
        response.data && typeof response.data === 'object'
          ? (response.data as Record<string, unknown>)
          : undefined;
      if (record && typeof record.token === 'string' && record.token) {
        try {
          const tokens = await services.readValue('poolTokens');
          const map =
            tokens && typeof tokens === 'object' ? { ...(tokens as Record<string, unknown>) } : {};
          map[uid] = record.token;
          await services.writeValue('poolTokens', map);
        } catch {
          // token 入库失败不阻断流程，服务端会在后续快照重签
        }
      }
      state.poolDisabled = false;
      state.poolDown = false;
      services.publish();
      return 'ok';
    }
    if (response.status === 401) {
      await disablePoolAuth(periodId + ':' + uid);
      state.poolDisabled = true;
      services.publish();
      setLastError('身份校验失败，本期码池功能停用（下期自动恢复）', 'pool_unauthorized', {
        periodId,
        uid,
      });
      return 'disabled';
    }
    if (response.status === 429) {
      poolRateLimited(poolBackoff, services.now());
      setLastError('码池请求过于频繁，稍后自动重试', 'pool_rate_limited', {
        periodId,
        uid,
        ...buildPoolDiag('/v2/snapshot', response),
      });
      return 'down';
    }
    if (response.needUpdate) {
      reportVersionMismatch(response);
      return 'disabled';
    }
    state.poolDown = true;
    services.publish();
    if (response.status === 0) {
      poolDown(poolBackoff, services.now(), true);
      setLastError(MSG_POOL_NETWORK, 'pool_net_error', {
        periodId,
        uid,
        transportRetryAfter: POOL_TRANSPORT_BACKOFF_MS / 1000,
        ...buildPoolDiag('/v2/snapshot', response),
      });
      return 'down';
    }
    poolDown(poolBackoff, services.now());
    if (response.cfChallenge) {
      setLastError(MSG_CF_CHALLENGE, 'pool_cf_challenge', {
        periodId,
        uid,
        backoffStep: poolBackoff.step,
        ...buildPoolDiag('/v2/snapshot', response),
      });
      return 'down';
    }
    setLastError('码池暂时不可用，稍后自动重试', 'pool_down', {
      periodId,
      uid,
      backoffStep: poolBackoff.step,
      ...buildPoolDiag('/v2/snapshot', response),
    });
    return 'down';
  }

  function reportVersionMismatch(response: PoolResponse): void {
    if (versionMismatchReported) return;
    versionMismatchReported = true;
    const record =
      response.data && typeof response.data === 'object'
        ? (response.data as Record<string, unknown>)
        : undefined;
    const message = String((record && record.message) || '插件版本过低，请更新');
    setLastError(message, 'version_mismatch', {
      poolError: String((record && record.error) || ''),
    });
    services.toastWarning(message);
  }

  // 回报租约结果，并语义化处理码池侧失败。返回 "abort" 表示本轮应终止。
  async function reportLeaseResult(
    periodId: string,
    uid: string,
    leaseId: string,
    result: 'success' | 'failed',
    errorKind: string,
  ): Promise<'ok' | 'abort'> {
    const token = await getPoolToken(uid);
    const response = await poolRequest('/v2/join/result', {
      period_id: periodId,
      uid,
      token,
      lease_id: leaseId,
      result,
      error_kind: errorKind || '',
    });
    if (response.ok) return 'ok';
    // 租约已被服务端终态清理（超过 1 小时的迟到结果）：不是故障，不惩罚、不退避。
    if (response.status === 404) {
      const record =
        response.data && typeof response.data === 'object'
          ? (response.data as Record<string, unknown>)
          : undefined;
      if (record && record.error === 'lease_not_found') return 'ok';
    }
    if (response.status === 401) {
      await disablePoolAuth(periodId + ':' + uid);
      state.poolDisabled = true;
      services.publish();
      setLastError('身份校验失败，本期码池功能停用（下期自动恢复）', 'pool_unauthorized', {
        periodId,
        uid,
        stage: 'result',
      });
      return 'abort';
    }
    if (response.needUpdate) {
      reportVersionMismatch(response);
      return 'abort';
    }
    if (response.status === 429) {
      poolRateLimited(poolBackoff, services.now());
      setLastError('码池请求过于频繁，稍后自动重试', 'pool_rate_limited', {
        periodId,
        uid,
        stage: 'result',
      });
      return 'abort';
    }
    // 5xx / 网络：租约由服务端 120s TTL 回收，不阻断当轮重试。
    // 不设 lastMessage——入队成功路径下若提示"码池不可用"会误导用户（实际已入队成功）。
    poolDown(poolBackoff, services.now());
    services.log('lease result report failed: ' + result + ' ' + response.status);
    return 'ok';
  }

  // 码池请求统一入口：仅对"传输层不可达"与 5xx 补射一次；质询/边缘错误重试无意义
  async function poolRequest(path: string, payload: unknown): Promise<PoolResponse> {
    let response = await services.poolSend(path, payload);
    if (
      !response.ok &&
      !response.cfChallenge &&
      !response.cfEdgeError &&
      (response.status === 0 || response.status >= 500)
    ) {
      await services.sleep(POOL_RETRY_DELAY_MS);
      response = await services.poolSend(path, payload);
    }
    return response;
  }

  async function poolJoin(
    periodId: string,
    uid: string,
    excludeCodes: string[],
  ): Promise<PoolResponse> {
    const token = await getPoolToken(uid);
    return poolRequest('/v2/join', {
      period_id: periodId,
      uid,
      token,
      // 本轮流程内已失败的队不再命中（服务端仅对本次选队生效，不落库）
      exclude_codes: Array.isArray(excludeCodes) ? excludeCodes.slice(0, 3).map(String) : [],
    });
  }

  // ---------- 主流程 ----------

  async function runFullFlow(
    reason: string,
    options: { force?: boolean; snapshotOnly?: boolean } = {},
  ): Promise<void> {
    const snapshotOnly = Boolean(options.snapshotOnly);
    const now0 = services.now();
    if (!options.force && now0 - lastRunAt < MIN_RUN_INTERVAL_MS) return;
    lastRunAt = now0;
    if (!snapshotOnly) lastFullAt = lastRunAt;
    const seq0 = errorSeq;
    const clearIfNoNewError = () => {
      if (errorSeq === seq0) clearLastError();
    };
    try {
      ensureActive();
      const auth = services.auth();
      state.loggedIn = Boolean(auth) || services.loggedIn();
      if (!auth) {
        state.periodState = 'unknown';
        services.publish();
        if (services.loggedIn()) {
          // 已登录但拦截器尚未捕获鉴权头：等待宿主下一次带身份的请求，心跳会自动重试
          setLastError(
            '登录态同步中，稍后自动重试；如长时间无进展请播放一首歌曲后重试',
            'auth_syncing',
          );
        } else {
          setLastError('未登录 EchoMusic，请先登录', 'not_logged_in');
        }
        return;
      }
      const uid = String(auth.userid);
      if (uid !== runUid || uid !== knownUid) {
        runUid = uid;
        knownUid = uid;
        // 账号 id 落盘：重启/重装后 applyKnownPoolDisable 在鉴权头捕获前也有 uid 可用
        void services.writeValue('lastUid', uid);
      }

      // ① GUARD：期次信息；非进行中直接终止（不建队、不请求码池）
      const period = await getPeriodInfo(auth);
      ensureActive();
      if (!period.ok) {
        state.periodState = 'error'; // GUARD 失败：心跳按常规间隔自愈重试
        services.publish();
        setLastError(period.error || '获取活动信息失败', period.errorCode || 'no_period', {
          endpoint: '/youth/v1/ut/get_period_info',
          ...(period.diag || {}),
        });
        return;
      }
      const periodId = String(period.periodId);
      const lastPeriodId = await services.readValue('lastPeriodId');
      if (typeof lastPeriodId === 'string' && lastPeriodId && lastPeriodId !== periodId) {
        // 期次切换：清空本地缓存的码与 joined 状态（token 为账号级，由新期次 DO 重签覆盖）
        poolUp(poolEmptyBackoff); // 新期次重新开始，不继承上一期的池空退避
        state.myCode = '';
        state.myMemberCount = 0;
        state.joinedCode = '';
        state.joinedMemberCount = 0;
        state.joined = false;
        // poolAuthDisabled 跨期只会累积、从不清理；挂在期次切换分支上裁剪，只保留当前期次
        const kept = new Set<string>();
        for (const key of disabledPeriods) {
          if (key.startsWith(periodId + ':')) kept.add(key);
        }
        disabledPeriods.clear();
        for (const key of kept) disabledPeriods.add(key);
        await persistDisabledTable();
        // 设备建队标记同样按期次裁剪：新期次从空开始（创建状态随期次重置）
        const keptCreated = new Set<string>();
        for (const key of deviceCreatedPeriods) {
          if (key === periodId) keptCreated.add(key);
        }
        deviceCreatedPeriods.clear();
        for (const key of keptCreated) deviceCreatedPeriods.add(key);
        void persistDeviceCreatedPeriods();
        // 加入被拒标记按期次裁剪（仅内存）
        joinBlockedPeriods.clear();
      }
      await services.writeValue('lastPeriodId', periodId);
      state.periodId = periodId;
      state.periodName = period.periodName;
      state.periodStart = period.startTime;
      state.periodEnd = period.endTime;
      state.periodActive = period.active;
      state.periodState = period.active ? 'active' : 'inactive';
      state.targetMembers = period.totalMembers;
      services.publish();
      if (!period.active) {
        setLastError('本期活动未开启', 'period_inactive');
        return;
      }

      // 自动组队开关：关闭时**与码池服务器零交流**，走只读酷狗的手动模式
      const autoOn = services.autoEnabled;

      // ② MYINFO：查询我的队伍（两个维度）。手动模式下到此为止。
      let myInfo = await getMyTeamInfo(auth, periodId);
      ensureActive();
      if (!myInfo.ok) {
        // 查询失败：回退到本期已缓存的建队码，已创建过队伍的面板不必空等到下一次查询成功
        const cached = await readCreatedCache(periodId, uid);
        if (cached) applyCreatedCache(cached);
        setLastError('获取队伍信息失败', 'myinfo_failed');
        return;
      }

      if (!autoOn) {
        // 手动模式：同样自动建队并展示队伍码（可复制分享，或手动输入他人组队码加入），
        // 但与码池服务器零交流——不上报快照、不申请组队码、不做自动分配。
        // 记录刷新时间，避免心跳把面板刷新压成每 60s 一次（按 SNAPSHOT_INTERVAL_MS 节流）。
        const ensured = await ensureTeamCreated(
          auth,
          periodId,
          uid,
          myInfo,
          '可稍后重试，或手动输入组队码加入他人队伍',
        );
        if (ensured.stop) return;
        myInfo = ensured.myInfo;
        lastSnapshotAt = services.now();
        applyTeamInfo(myInfo as TeamInfo);
        clearIfNoNewError();
        return;
      }

      // 自动模式前置建队：无自己的队伍即创建（建队与加入相互独立，与是否已加入无关），
      // 新码经随后的快照立即供入码池；开闸突发时大家同时建队是预期行为——供给先行，
      // 快满优先负责把加入者集中填满。建队失败不阻断本轮，仍可队员身份租码加入。
      const ensured = await ensureTeamCreated(
        auth,
        periodId,
        uid,
        myInfo,
        '仍可加入其他队伍，下轮自动重试建队',
      );
      if (ensured.stop) return;
      myInfo = ensured.myInfo;
      applyTeamInfo(myInfo as TeamInfo);
      // ③ SNAPSHOT：两维度真实状态整体上报（新建队伍码由此入池）
      const snap = await doSnapshot(periodId, uid, myInfo as TeamInfo);
      lastSnapshotAt = services.now();
      if (snapshotOnly || snap !== 'ok') {
        // 快照成功＝鉴权/期次/队伍信息均正常；此路径无后续重试，清掉历史错误不会闪烁
        if (snap === 'ok') clearIfNoNewError();
        return;
      }

      // ④ DECIDE：已加入他人队伍、创建队已满员、或本期加入已被 143005 拒绝
      // （joinBlockedPeriods）即终态，本轮结束进入心跳模式。
      // 2026-11-03 用户更正：此前"创建队 1/3 占用设备"的判断依据（队长 join 被 143005
      // 拒）实为"账号从未组过队"的资格问题（需先在概念版APP手动组队一次），并非设备
      // 绑定。故未满员的创建队队长默认仍可租码加入他人；某设备若真实被拒，由下方
      // already_joined 分支落 joinBlockedPeriods 自适应退回等待态。
      // 2026-11-05 用户确认：建队与加入是两个独立行为，创建队（哪怕无人加入）不影响
      // 加入他人——队长租码不设前置排除，仅对真实 143005 落标记退回。
      if (myInfo.joined) {
        clearIfNoNewError();
        return;
      }
      if (myInfo.created && myInfo.created.memberCount >= TARGET_MEMBERS) {
        clearIfNoNewError();
        return;
      }
      if (joinBlockedPeriods.has(periodId)) {
        clearIfNoNewError();
        return;
      }

      // ⑤→⑦ ASSIGN / JOIN_KUGOU / RESULT（当轮重试 ≤ RETRY_MAX）
      const excludedCodes = new Set<string>(); // 本轮流程内失败过的队（network 除外），重试时请求服务端避开
      const attempts: { [key: string]: JsonValue }[] = []; // 全部失败后随 join_exhausted 进复制详情，供用户反馈
      for (let attempt = 1; attempt <= RETRY_MAX; attempt += 1) {
        ensureActive();
        // 结果回报失败已开启退避时，不再继续撞码池（避免故障期放大请求与写行）
        const nowAttempt = services.now();
        if (!poolAvailable(poolBackoff, nowAttempt)) {
          const waitSec = remainingBackoffSeconds(nowAttempt);
          setLastError(
            `码池暂时不可用，约 ${Math.ceil(waitSec / 60)} 分钟后自动重试`,
            'pool_backoff',
            {
              periodId,
              uid,
              waitSeconds: waitSec,
              backoffStep: poolBackoff.step,
            },
          );
          return;
        }
        const joinRes = await poolJoin(periodId, uid, Array.from(excludedCodes));
        ensureActive();
        if (!joinRes.ok) {
          if (joinRes.status === 401) {
            await disablePoolAuth(periodId + ':' + uid);
            state.poolDisabled = true;
            services.publish();
            setLastError('身份校验失败，本期码池功能停用（下期自动恢复）', 'pool_unauthorized', {
              periodId,
              uid,
            });
          } else if (joinRes.status === 429) {
            poolRateLimited(poolBackoff, services.now());
            setLastError('码池请求过于频繁，稍后自动重试', 'pool_rate_limited', { periodId, uid });
          } else if (!joinRes.needUpdate) {
            state.poolDown = true;
            services.publish();
            if (joinRes.status === 0) {
              poolDown(poolBackoff, services.now(), true);
              setLastError(MSG_POOL_NETWORK, 'pool_net_error', {
                periodId,
                uid,
                stage: 'join',
                transportRetryAfter: POOL_TRANSPORT_BACKOFF_MS / 1000,
                ...buildPoolDiag('/v2/join', joinRes),
              });
              return;
            }
            poolDown(poolBackoff, services.now());
            if (joinRes.cfChallenge) {
              setLastError(MSG_CF_CHALLENGE, 'pool_cf_challenge', {
                periodId,
                uid,
                stage: 'join',
                ...buildPoolDiag('/v2/join', joinRes),
              });
            } else {
              setLastError('码池暂时不可用，稍后自动重试', 'pool_down', {
                periodId,
                uid,
                stage: 'join',
                ...buildPoolDiag('/v2/join', joinRes),
              });
            }
          } else {
            reportVersionMismatch(joinRes);
          }
          return;
        }
        const data =
          joinRes.data && typeof joinRes.data === 'object'
            ? (joinRes.data as Record<string, unknown>)
            : {};
        if (data.reason === 'already_joined') {
          // 服务端判定已在队中：校正本地状态 + 立即快照，不执行酷狗 join
          if (data.code) {
            state.joinedCode = String(data.code);
            state.joined = true;
            services.publish();
          }
          const verify = await getMyTeamInfo(auth, periodId);
          ensureActive();
          if (verify.ok) applyTeamInfo(verify as TeamInfo);
          await doSnapshot(periodId, uid, verify.ok ? (verify as TeamInfo) : (myInfo as TeamInfo));
          clearIfNoNewError();
          return;
        }
        if (data.reason === 'pool_empty' || !data.code) {
          // 池内没有可加入的队伍：建队已前置完成并入池，此处仅武装空池退避并如实提示，
          // 避免每 10min 空转；等待其他设备租用我们的码，或用户手动输入组队码
          poolEmptyBackoffStart(poolEmptyBackoff, services.now());
          setLastError('暂无可加入的队伍，可手动组队或耐心等待', 'pool_empty', {
            periodId,
            uid,
          });
          return;
        }

        // 防御守卫：分配响应必须同时携带 lease_id 与 code——协议异常时不向酷狗发起无租约的 join
        if (!data.lease_id || !data.code) {
          setLastError('码池响应异常，稍后自动重试', 'pool_bad_response', { periodId, uid });
          return;
        }

        const leaseId = String(data.lease_id);
        const code = String(data.code);
        poolUp(poolEmptyBackoff); // 领到码 = 池子已恢复，清空池空退避
        const joinKugou = await teamCall(auth, 'join_team', { teamCode: code });
        ensureActive();
        if (!joinKugou.ok) {
          // 酷狗请求本身失败（网络/未登录）：与队伍状态无关，不参与服务端纠偏
          attempts.push({
            尝试: attempt,
            队伍码: code,
            类别: 'network',
            说明: joinKugou.error || '请求失败',
          });
          if ((await reportLeaseResult(periodId, uid, leaseId, 'failed', 'network')) === 'abort')
            return;
          if (attempt < RETRY_MAX) await services.sleep(RETRY_DELAY_MS);
          continue;
        }
        const parsed = parseJoinResponse(joinKugou);
        if (parsed.httpOk && parsed.bizOk) {
          await reportLeaseResult(periodId, uid, leaseId, 'success', '');
          // ⑧ VERIFY + SNAPSHOT：把成队后的真实人数报给码池（confirm 强制发送）
          const verify = await getMyTeamInfo(auth, periodId);
          ensureActive();
          if (verify.ok) applyTeamInfo(verify as TeamInfo);
          await doSnapshot(periodId, uid, verify.ok ? (verify as TeamInfo) : (myInfo as TeamInfo), {
            confirm: true,
          });
          clearIfNoNewError();
          return;
        }
        const failure = classifyJoinError(joinKugou.body);
        attempts.push({
          尝试: attempt,
          队伍码: code,
          类别: failure.kind,
          HTTP状态: joinKugou.status,
          ...(failure.errorCode ? { 酷狗错误码: failure.errorCode } : {}),
          ...(failure.errorMsg ? { 酷狗信息: failure.errorMsg } : {}),
        });
        if ((await reportLeaseResult(periodId, uid, leaseId, 'failed', failure.kind)) === 'abort')
          return;
        if (failure.kind === 'already_joined') {
          // 已在队中（如上轮租约迟到成功）：立即快照纠偏，不重试
          const verify = await getMyTeamInfo(auth, periodId);
          ensureActive();
          if (verify.ok) applyTeamInfo(verify as TeamInfo);
          await doSnapshot(periodId, uid, verify.ok ? (verify as TeamInfo) : (myInfo as TeamInfo));
          if (failure.errorCode === 143005 && verify.ok && !(verify as TeamInfo).joined) {
            const seen = verify as TeamInfo;
            // toast 只报酷狗原文（用户要求），完整补救指引进面板下方状态区
            const toastText = failure.errorMsg || '每台设备只能加入一个队伍~~';
            if (seen.created) {
              // 创建队可见仍被 143005 拒：与创建队无关（建队与加入相互独立，创建队
              // 不占用设备），实为账号资格问题——落标记自适应退回等待态，等队员的
              // 同时提示到概念版APP组队页面手动加入一次（见文案）。
              joinBlockedPeriods.add(periodId);
              const message =
                '酷狗拒绝了加入请求（每台设备只能加入一个队伍~~）。请在概念版APP的组队页面手动加入一次其他人的队伍，之后自动加入即可生效；本期先等待队员加入你的队伍';
              setLastError(message, 'device_already_bound', {
                periodId,
                uid,
                code,
                errorCode: failure.errorCode,
              });
              if (!deviceBoundToastShown) {
                deviceBoundToastShown = true;
                services.toastWarning(toastText);
              }
              return;
            }
            // 143005 但查不到任何队伍：设备绑定来源在查询侧不可见。常见于从未组过队的
            // 账号（资格问题，误报"设备已绑定"）——必须给出 APP 手动加入一次的补救
            // 指引，否则会退化成无声失败。
            const message =
              '无法加入其他队伍（每台设备只能加入一个队伍~~）。请在概念版APP的组队页面手动加入一次其他人的队伍，之后自动加入即可生效';
            setLastError(message, 'device_already_bound', {
              periodId,
              uid,
              code,
              errorCode: failure.errorCode,
              // 携带原始 myinfo 响应：酷狗声称设备已绑定而查询侧看不到任何队伍时，
              // 复制错误详情即可拿到 join 列表真实字段结构，用于定位解析缺口
              myTeamInfoBody: truncateBody(JSON.stringify((verify as TeamInfo).raw) || ''),
            });
            if (!deviceBoundToastShown) {
              deviceBoundToastShown = true;
              services.toastWarning(toastText);
            }
            return;
          }
          clearIfNoNewError();
          return;
        }
        excludedCodes.add(code); // transient/full/invalid：重试换队（full/invalid 另有服务端纠偏/冷却）
        services.log('retry ' + code + ' ' + failure.kind + ' attempt ' + attempt);
        if (attempt < RETRY_MAX) await services.sleep(RETRY_DELAY_MS);
      }
      setLastError('加入队伍未成功，稍后自动重试', 'join_exhausted', { periodId, uid, attempts });
    } catch (error) {
      if (error instanceof Aborted) return;
      services.log('runFullFlow error: ' + String((error as Error)?.message || error));
    }
  }

  // 手动加入（组队码由用户输入，不经码池）：验证码处理与自动流程一致。
  async function manualJoin(code: string): Promise<{ ok: boolean; message: string }> {
    const auth = services.auth();
    if (!auth) {
      return {
        ok: false,
        message: services.loggedIn() ? '登录态同步中，请稍后重试' : '未登录 EchoMusic，请先登录',
      };
    }
    // ensureActive 由 teamCall 内部检查点承担：此处提前抛出会绕过下方"插件已停用"兜底
    try {
      const response = await teamCall(auth, 'join_team', { teamCode: code });
      const parsed = parseJoinResponse(response);
      if (parsed.httpOk && parsed.bizOk) {
        clearLastError(); // 手动入队成功＝问题已解决
        // 手动加入成功后刷新一次：开启自动组队时该码顺带入池；关闭时只刷新酷狗侧展示
        void requestRun('manual_join', { snapshotOnly: true, force: true });
        return { ok: true, message: '已提交加入' };
      }
      const rawMessage = parsed.errorMsg || '加入失败，请检查组队码';
      if (parsed.errorCode === 143005) {
        // 从未组过队的账号手动加入也会被 143005 拒：toast 只报酷狗原文（与自动流程
        // 一致），完整补救指引进面板状态区
        setLastError(
          '无法加入该队伍（每台设备只能加入一个队伍~~）。请在概念版APP的组队页面手动加入一次其他人的队伍，之后即可正常加入',
          'manual_join_failed',
          { code, errorMsg: parsed.errorMsg },
        );
        return { ok: false, message: rawMessage };
      }
      setLastError(rawMessage, 'manual_join_failed', { code, errorMsg: parsed.errorMsg });
      return { ok: false, message: rawMessage };
    } catch (error) {
      if (error instanceof Aborted) return { ok: false, message: '插件已停用' };
      const message = String((error as Error)?.message || error) || '加入失败';
      return { ok: false, message };
    }
  }

  // 全流程互斥：任何触发点（启动/登录/开关/刷新/心跳）都汇入同一个串行链
  function requestRun(
    reason: string,
    options: { force?: boolean; snapshotOnly?: boolean } = {},
  ): Promise<void> {
    if (!runChain) runChain = Promise.resolve();
    const next = runChain.then(() => runFullFlow(reason, options));
    runChain = next.catch(() => undefined);
    return next;
  }

  // 心跳巡检：面板打开或自动开关开启时保活；本期未完成时定期触发完整流程等新码。
  // 以 periodState 取代 periodActive 硬门控：error/unknown 照常按常规间隔重试（自愈）、
  // active 走保活/等待循环、inactive 仅每 30min 低频探测（下一期自动开始）。
  function heartbeatTick(): void {
    try {
      if (!services.active()) return;
      const panelOpen = services.panelOpen;
      const autoOn = services.autoEnabled;
      if (!panelOpen && !autoOn) return;
      const now = services.now();
      if (state.periodState === 'inactive') {
        if (now - lastInactiveProbeAt >= INACTIVE_PROBE_INTERVAL_MS) {
          lastInactiveProbeAt = now;
          void requestRun('period_probe', { force: true });
        }
        return;
      }
      // 已加入他人队伍、创建队满员或本期加入被拒＝终态：只需低频保活快照。
      // 未满员队长仍随完整流程租码加入（除非已落 joinBlockedPeriods）；
      // 完整流程同时刷新成员人数并在未建队时前置建队。
      const joined = state.joined;
      const snapshotInterval = panelOpen ? SNAPSHOT_INTERVAL_MS : JOINED_SNAPSHOT_INTERVAL_MS;
      if (
        autoOn &&
        !joined &&
        now - lastFullAt >= FULLFLOW_INTERVAL_MS &&
        now >= poolEmptyBackoff.nextAttemptAt
      ) {
        lastFullAt = now;
        lastSnapshotAt = now;
        void requestRun('heartbeat_full');
      } else if (now - lastSnapshotAt >= snapshotInterval) {
        lastSnapshotAt = now;
        void requestRun('heartbeat_snapshot', { snapshotOnly: true });
      }
    } catch (error) {
      services.log('heartbeat error: ' + String((error as Error)?.message || error));
    }
  }

  function resetForAccountChange(): void {
    poolUp(poolBackoff);
    poolUp(poolEmptyBackoff);
    disabledPeriods.clear();
    // 内存清空后回读存储：停用表合并写入的其他记录不能因切换会话而丢基线
    void loadDisabledPeriods();
    versionMismatchReported = false;
    deviceBoundToastShown = false;
    // 143005 实为账号资格问题（建队与加入相互独立）：加入被拒标记随账号切换清除，
    // 新账号不应继承上一账号在本设备上的退回状态；deviceCreatedPeriods 是设备维度
    // （该设备名下确有队伍），跨账号保留
    joinBlockedPeriods.clear();
    lastRunAt = 0;
    lastSnapshotAt = 0;
    lastFullAt = 0;
    lastInactiveProbeAt = 0;
    runUid = '';
    knownUid = ''; // 切换账号后旧 uid 不再代表当前会话，等新鉴权头或首次流程回写
    state.periodId = '';
    state.periodName = '';
    state.periodStart = '';
    state.periodEnd = '';
    state.periodActive = false;
    state.periodState = 'unknown';
    state.myCode = '';
    state.myMemberCount = 0;
    state.myVipDesc = '';
    state.joined = false;
    state.joinedCode = '';
    state.joinedMemberCount = 0;
    state.joinedVipDesc = '';
    state.poolDisabled = false;
    state.poolDown = false;
    state.lastMessage = '';
    state.lastError = null;
    services.publish();
  }

  async function loadDisabled(): Promise<void> {
    await loadDisabledPeriods();
    await loadDeviceCreatedPeriods();
    try {
      const [periodId, uid, created] = await Promise.all([
        services.readValue('lastPeriodId'),
        services.readValue('lastUid'),
        services.readValue('lastCreatedTeam'),
      ]);
      if (typeof periodId === 'string') knownPeriodId = periodId;
      if (typeof uid === 'string' && uid) knownUid = uid;
      // lastUid 自首个成功流程才落盘；老存量用建队码缓存里的 uid 兜底
      if (!knownUid && created && typeof created === 'object') {
        const createdUid = (created as Record<string, unknown>).uid;
        if (typeof createdUid === 'string' && createdUid) knownUid = createdUid;
      }
    } catch {
      // 载入失败按未知处理，等首次成功流程回写
    }
  }

  // 开启自动组队（或激活载入停用表）时不等流程上网回来才披露本期停用状态：
  // 停用表与最近期次/账号激活时已载入内存，按 doSnapshot 首道判定（期次:uid）立即
  // 同步进面板——有标记则状态行即时显示，无标记则不误挂；全部未知时交由后续流程发现。
  function applyKnownPoolDisable(): void {
    const auth = services.auth();
    const uid = auth ? String(auth.userid) : runUid || knownUid;
    const periodId = state.periodId || knownPeriodId;
    if (!uid || !periodId) return;
    state.poolDisabled = disabledPeriods.has(periodId + ':' + uid);
  }

  // 解除本期停用标记（面板「解除停用并重试」）：换设备/重装后 token 失配会同时
  // 落下服务端与本地两道停用；站长在码池删除用户解除服务端绑定后，这里删掉本地
  // 标记并允许立即重发快照。服务端 token 校验原样保留——未解除绑定时重试仍会
  // 401，标记如实重新落下，不构成绕过。按期次前缀清除：该期内其他账号的标记
  // 一并放行重试，误放行只会换来一次 401，不会错报状态。
  async function clearPoolDisable(): Promise<{ ok: boolean; message: string }> {
    const auth = services.auth();
    const uid = auth ? String(auth.userid) : runUid || knownUid;
    const periodId = state.periodId || knownPeriodId;
    if (!periodId) return { ok: false, message: '本期期次未知，请先刷新一次再重试' };
    if (!uid) return { ok: false, message: '登录态未知，请先登录或播放一首歌曲后重试' };
    const prefix = periodId + ':';
    let removed = 0;
    for (const key of Array.from(disabledPeriods)) {
      if (key.startsWith(prefix)) {
        disabledPeriods.delete(key);
        removed += 1;
      }
    }
    await persistDisabledTable();
    if (removed > 0) {
      state.poolDisabled = false;
      if (state.lastError && state.lastError.code === 'pool_unauthorized') clearLastError();
    }
    services.publish();
    return {
      ok: true,
      message: removed > 0 ? '已解除本期停用标记，正在重试' : '本期没有停用标记，正在重试',
    };
  }

  return {
    requestRun,
    applyKnownPoolDisable,
    clearPoolDisable,
    /** 等待当前串行链排空（排水用，不触发新流程） */
    idle(): Promise<void> {
      return runChain ?? Promise.resolve();
    },
    heartbeatTick,
    onPanelOpened,
    resetForAccountChange,
    loadDisabled,
    manualJoin,
    poolBackoff,
    poolEmptyBackoff,
  };
}

export type Runner = ReturnType<typeof createRunner>;

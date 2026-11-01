// 自动组队领VIP —— v2 快照/租约协议
// 三方职责：酷狗服务器是队伍构成的唯一权威；码池服务器存储快照、计算名额、以租约下发组队码；
// 本插件是酷狗状态的观察者与组队操作执行器。
//
// 与旧 EchoMusic 插件的差异：
//   - 登录态不再读 pinia：宿主不向插件暴露账号凭证。插件经 serverIntercept 能力
//     （用户显式授权、管理页可撤销）从宿主业务请求中被动捕获逻辑 Authorization 头，
//     仅驻内存、账号切换即清除；未捕获前面板明确显示"登录态同步中"。
//   - 组队接口改为直连 gateway.kugou.com 的 /youth/v1/ut/*（与旧宿主内置模块逐位对齐），
//     签名/加密在插件内实现（src/crypto.ts）。
//   - 验证码走 ctx.kugou.verify(eventId)，由宿主现有验证界面承接。
//   - Vue 弹窗改为原生 QML 页面（qml/TeamPanel.qml），经标题栏 ★ 动作打开。

import { awaitOperation, type EchoPluginContext, type EchoPluginDialog } from 'echo:plugin-sdk';
import {
  buildTeamRequest,
  parseAuthHeader,
  type GatewayRequest,
  type GatewayResponse,
  type KugouAuth,
} from './kugou.ts';
import { backoffRemainingMs, normalizePoolResponse, poolHeaders, POOL_URL } from './pool.ts';
import {
  buildErrorDetail,
  createPanelState,
  createRunner,
  HEARTBEAT_TICK_MS,
  MIN_RUN_INTERVAL_MS,
  REFRESH_THROTTLE_MS,
  type Runner,
} from './runner.ts';

// 与 manifest.version 同步（宿主上下文不暴露 manifest）；码池 MIN_CLIENT_VERSION 门禁要求 ≥1.2.0
const PLUGIN_VERSION = '1.2.6';
const AUTO_RUN_DELAY_MS = 3000;
const LOGIN_RUN_DELAY_MS = 2000;
const GATEWAY_TIMEOUT_MS = 15_000;

function normalizeHeaders(headers: Record<string, string | string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(headers || {})) {
    const value = headers[key];
    out[key.toLowerCase()] = Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
  }
  return out;
}

function encodeQuery(query: Record<string, string>): string {
  const parts: string[] = [];
  for (const key of Object.keys(query)) {
    parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(query[key]));
  }
  return parts.join('&');
}

export function activate(ctx: EchoPluginContext) {
  const state = createPanelState();
  let autoEnabled = false;
  // 面板有两个入口：主窗口共享弹层（★ 默认，复刻旧插件弹窗）与页面（回退）。
  // 巡检门控取两者的并集；页面经 panel.opened 命令上报，弹窗经句柄 closed 信号跟踪。
  let pageOpen = false;
  let dialogHandle: EchoPluginDialog | null = null;
  let dialogActive = false;
  let dialogOpening = false;
  let capturedAuth: KugouAuth | null = null;
  let rawAuthHeader = '';
  let interceptorLease: { dispose(): void } | null = null;
  let lastRefreshTime = 0;
  let disposed = false;
  const pendingSleeps = new Set<() => void>();

  const runner: Runner = createRunner({
    now: () => Date.now(),
    active: () => !disposed && ctx.active,
    log: (message) => console.info('[auto-team-vip] ' + message),
    toastWarning: (message) => {
      void ctx.toast.warning(message);
    },
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        const finish = () => {
          pendingSleeps.delete(finish);
          resolve();
        };
        pendingSleeps.add(finish);
        const registration = ctx.setTimer('sleep', ms, false, finish);
        if (!registration) finish();
      }),
    readValue: (key) => awaitOperation(ctx.io.readValue(key)).catch(() => undefined),
    writeValue: (key, value) =>
      awaitOperation(ctx.io.writeValue(key, value as never))
        .then(() => undefined)
        .catch(() => undefined),
    auth: () => capturedAuth,
    loggedIn: () => Boolean(ctx.kugou.account && ctx.kugou.account.loggedIn),
    gatewaySend: (request) => gatewaySend(request),
    verifyCaptcha: (eventId) =>
      awaitOperation(ctx.kugou.verify(eventId))
        .then((result) => Boolean(result && result.verified))
        .catch(() => false),
    poolSend: (path, payload) => poolSend(path, payload),
    publish: () => publishPanel(),
    state,
    get autoEnabled() {
      return autoEnabled;
    },
    get panelOpen() {
      return pageOpen || dialogActive;
    },
  });

  // ---------- 传输层 ----------

  async function gatewaySend(request: GatewayRequest): Promise<GatewayResponse> {
    const options: Parameters<typeof ctx.net.request>[0] = {
      url: request.url + '?' + encodeQuery(request.query),
      method: request.method,
      headers: request.body
        ? { ...request.headers, 'Content-Type': 'application/json' }
        : request.headers,
      responseType: 'json',
      timeoutMs: GATEWAY_TIMEOUT_MS,
    };
    if (request.body !== null && request.body !== undefined) options.body = request.body;
    try {
      const response = await awaitOperation(ctx.net.request(options));
      // ok 表示"请求已送达"（与旧插件 teamRequest 语义一致）：HTTP 状态与业务结果
      // 由 status/body 分别承载，502 的业务错误也要进入分类/纠偏路径而不是 network 分支。
      return {
        ok: true,
        status: response.status,
        body: response.data,
        headers: normalizeHeaders(response.headers as Record<string, string | string[]>),
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        body: null,
        error: String((error as Error)?.message || error),
        headers: {},
      };
    }
  }

  async function poolSend(path: string, payload: unknown) {
    try {
      const response = await awaitOperation(
        ctx.net.request({
          url: POOL_URL + path,
          method: 'POST',
          headers: poolHeaders(PLUGIN_VERSION),
          body: payload as never,
          responseType: 'json',
          timeoutMs: GATEWAY_TIMEOUT_MS,
        }),
      );
      return normalizePoolResponse({
        status: response.status,
        data: response.data,
        headers: normalizeHeaders(response.headers as Record<string, string | string[]>),
      });
    } catch (error) {
      return normalizePoolResponse({
        status: 0,
        data: null,
        headers: {},
        error: String((error as Error)?.message || error),
      });
    }
  }

  // ---------- 状态发布 ----------

  function publishPanel(): void {
    if (disposed) return;
    const remaining = Math.max(0, backoffRemainingMs(runner.poolBackoff, Date.now()));
    ctx.ui.setState({
      loggedIn: state.loggedIn,
      authState: capturedAuth ? 'ok' : interceptorLease ? 'waiting' : 'unauthorized',
      periodId: state.periodId,
      periodName: state.periodName,
      periodStart: state.periodStart,
      periodEnd: state.periodEnd,
      periodActive: state.periodActive,
      periodState: state.periodState,
      myCode: state.myCode,
      myMemberCount: state.myMemberCount,
      myVipDesc: state.myVipDesc,
      targetMembers: state.targetMembers,
      joined: state.joined,
      joinedCode: state.joinedCode,
      joinedMemberCount: state.joinedMemberCount,
      joinedVipDesc: state.joinedVipDesc,
      poolDisabled: state.poolDisabled,
      poolDown: state.poolDown,
      poolRetryMinutes: Math.ceil(remaining / 60_000),
      autoEnabled,
      panelOpen: pageOpen || dialogActive,
      lastMessage: state.lastMessage,
      lastError: state.lastError
        ? {
            code: state.lastError.code,
            message: state.lastError.message,
            detail: state.lastError.detail,
            at: state.lastError.at,
          }
        : null,
    });
  }

  // ---------- 拦截器：被动捕获逻辑 Authorization（仅驻内存） ----------

  async function registerInterceptor(): Promise<void> {
    try {
      const lease = await awaitOperation(
        ctx.server.intercept({
          id: 'auth-capture',
          stage: 'api',
          match: (request) => {
            // 只捕获不拦截：返回 false 时宿主原样放行，不进入拦截链。
            const header = request.headers ? request.headers['Authorization'] : undefined;
            if (
              typeof header === 'string' &&
              header.indexOf('token=') >= 0 &&
              header !== rawAuthHeader
            ) {
              rawAuthHeader = header;
              capturedAuth = parseAuthHeader(header);
              publishPanel();
            }
            return false;
          },
          handle: () => undefined,
        }),
      );
      interceptorLease = lease;
    } catch (error) {
      interceptorLease = null;
      console.warn(
        '[auto-team-vip] interceptor authorization rejected: ' +
          String((error as Error)?.message || error),
      );
      state.lastMessage =
        '插件授权未开启：组队功能需要“请求拦截”授权，请在插件管理的授权入口开启后重新启用插件';
      state.lastError = null;
      publishPanel();
    }
  }

  // ---------- 按需会话快照：激活即得登录态，不再等宿主业务请求 ----------

  // kugouAuth 授权后的 authSnapshot 与拦截链同名头 9 字段一致；未登录时只有设备字段。
  // 与拦截器互补：快照解决"空闲时无流量可捕获"，拦截器在 token 续期时自动更新捕获。
  async function syncAuthSnapshot(): Promise<void> {
    try {
      const snapshot = await awaitOperation(ctx.kugou.authSnapshot());
      const header = String(snapshot?.Authorization || '');
      if (header.indexOf('token=') >= 0 && header !== rawAuthHeader) {
        rawAuthHeader = header;
        capturedAuth = parseAuthHeader(header);
        publishPanel();
      }
    } catch (error) {
      console.warn(
        '[auto-team-vip] authSnapshot unavailable, keeping passive capture: ' +
          String((error as Error)?.message || error),
      );
    }
  }

  // ---------- 主窗口弹窗 ----------

  async function openPanelDialog(): Promise<void> {
    // 重入守卫：弹窗打开是异步的（正文 QML 加载期间未完成），双击/连点不能叠加打开
    if (dialogActive || dialogOpening) return;
    dialogOpening = true;
    try {
      const handle = await awaitOperation(
        ctx.ui.showDialog({
          component: 'qml/PanelDialog.qml',
          width: 400,
          title: '自动组队领VIP',
          modal: true,
          closeOnMask: true,
        }),
      );
      if (disposed) {
        handle.close();
        return;
      }
      dialogHandle = handle;
      dialogActive = true;
      handle.closed.connect(() => {
        dialogHandle = null;
        dialogActive = false;
        publishPanel();
      });
      // 与旧插件一致：每次打开面板重置版本提示一次性开关，并补一次轻量查询
      runner.onPanelOpened();
      void runner.requestRun('panel_open', { snapshotOnly: true });
      publishPanel();
    } catch (error) {
      // 正文异步加载期间用户按遮罩/Esc，宿主会取消未完成的打开操作（Canceled）。
      // 这是主动关闭而非故障：静默收尾，不提示也不跳页，避免双击被误判成打开失败。
      const code = (error as Error & { code?: string })?.code;
      if (!disposed && code !== 'Canceled') {
        console.warn(
          '[auto-team-vip] dialog unavailable, falling back to page: ' +
            String((error as Error)?.message || error),
        );
        void ctx.toast.warning('弹窗打开失败，已改用页面面板');
        try {
          await awaitOperation(ctx.ui.navigate('panel'));
        } catch {
          // 页面回退也失败时保持静默：状态仍由心跳维护
        }
      }
    } finally {
      dialogOpening = false;
    }
  }

  function disposeDialog(): void {
    dialogOpening = false;
    if (dialogHandle) {
      const handle = dialogHandle;
      dialogHandle = null;
      dialogActive = false;
      handle.close();
    } else {
      dialogActive = false;
    }
  }

  // ---------- 启动 / 会话 ----------

  const settingsReady = (async () => {
    try {
      const saved = await awaitOperation(ctx.io.readValue('settings'));
      if (saved && typeof saved === 'object') {
        autoEnabled = (saved as Record<string, unknown>).autoEnabled === true;
      }
    } catch {
      autoEnabled = false;
    }
    await runner.loadDisabled();
    // 停用标记是持久状态：激活即同步进面板，首次打开（甚至未拨开关）就如实可见；
    // 此时鉴权头通常尚未捕获、完整流程会被门控挡在期次查询之前
    runner.applyKnownPoolDisable();
    publishPanel();
  })();

  function scheduleStartupRun(reason: string, delayMs: number): void {
    const registration = ctx.setTimer('startup-run', delayMs, false, () => {
      void settingsReady.then(() => runner.requestRun(reason));
    });
    if (!registration) void settingsReady.then(() => runner.requestRun(reason));
  }

  // 账号切换：旧会话的拦截租约与弹层已被宿主撤下；清空捕获的鉴权头与码池侧状态，
  // 在新会话重新注册并按需重取快照，稍后重跑。
  ctx.sessionInvalidated.connect(() => {
    capturedAuth = null;
    rawAuthHeader = '';
    dialogHandle = null;
    dialogActive = false;
    interceptorLease = null;
    void runner.resetForAccountChange();
    void registerInterceptor();
    void syncAuthSnapshot();
    scheduleStartupRun('login', LOGIN_RUN_DELAY_MS);
  });

  // 同账号内的续期/信息变化也按需重取快照（宿主建议：订阅 accountChanged 后按需重取）
  ctx.kugou.accountChanged.connect(() => {
    capturedAuth = null;
    rawAuthHeader = '';
    publishPanel();
    void syncAuthSnapshot();
  });

  ctx.registerCommand('panel.opened', (args) => {
    pageOpen = args?.active !== false;
    if (pageOpen) {
      runner.onPanelOpened(); // 与旧插件一致：每次打开面板重置版本提示的一次性开关
      // 面板数据可能滞后（心跳 60s 巡检 + 保活间隔）；不带 force：受 10s 合并窗口约束
      void runner.requestRun('panel_open', { snapshotOnly: true });
    }
    return null;
  });

  ctx.registerCommand('refresh', async () => {
    if (disposed) return { ok: false };
    const now = Date.now();
    if (now - lastRefreshTime < REFRESH_THROTTLE_MS) {
      void ctx.toast.info('刷新过于频繁，请稍后再试');
      return { ok: false };
    }
    lastRefreshTime = now;
    await runner.requestRun('manual', { force: true });
    void ctx.toast.success('已刷新');
    return { ok: true };
  });

  ctx.registerCommand('set-auto', async (args) => {
    const enabled = args?.enabled === true;
    if (enabled === autoEnabled) return { ok: true };
    autoEnabled = enabled;
    try {
      const saved = await awaitOperation(ctx.io.readValue('settings'));
      const base =
        saved && typeof saved === 'object' ? { ...(saved as Record<string, unknown>) } : {};
      base.autoEnabled = enabled;
      await awaitOperation(ctx.io.writeValue('settings', base as never));
    } catch {
      // 持久化失败不影响本次会话的开关
    }
    // 开关状态即时发布；已知的码池停用标记（激活时载入）同步带上，
    // 状态异常提示在开启瞬间即可见，不必等 toggle_on 流程走到快照
    runner.applyKnownPoolDisable();
    publishPanel();
    if (enabled) {
      void ctx.toast.info('已开启自动组队，正在执行~~~');
      void runner.requestRun('toggle_on', { force: true });
    } else {
      // 关闭后与码池服务器零交流——只重新查询一次酷狗侧状态刷新面板
      void ctx.toast.info('已关闭自动组队，不再与码池服务器通信');
      void runner.requestRun('toggle_off', { force: true });
    }
    return { ok: true };
  });

  // 换设备/重装后 token 失配的恢复入口：站长已在码池删除用户后，一键清除本地
  // 停用标记并立即重发快照；服务端 token 校验不变，未解除绑定时重试仍会 401
  ctx.registerCommand('pool-retry', async () => {
    const result = await runner.clearPoolDisable();
    if (result.ok) void ctx.toast.info(result.message);
    else void ctx.toast.warning(result.message);
    if (result.ok) await runner.requestRun('pool_retry', { force: true });
    return result;
  });

  ctx.registerCommand('join-manual', async (args) => {
    const code = String((args?.code as string) ?? '').trim();
    if (!code) return { ok: false, message: '请输入组队码' };
    const result = await runner.manualJoin(code);
    // 成败都即时提示（旧插件行为）：失败为分类原文，成功为“已提交加入”
    if (result.ok) void ctx.toast.success(result.message);
    else void ctx.toast.warning(result.message);
    return result;
  });

  // 复制队伍码由插件侧承接：空码时与旧插件一致给出提示（QML 侧无法弹 toast）；
  // 返回码字符串由 QML 写入剪贴板，空串表示无可复制内容
  ctx.registerCommand('copy-created', () => {
    const code = state.myCode;
    if (!code) {
      void ctx.toast.warning('暂无组队码，请先运行互助');
      return '';
    }
    return code;
  });

  ctx.registerCommand('copy-joined', () => {
    const code = state.joinedCode;
    if (!code) {
      void ctx.toast.warning('暂无组队码，请先运行互助');
      return '';
    }
    return code;
  });

  ctx.registerCommand('error-detail', () => {
    const error = state.lastError;
    if (!error) return '';
    return buildErrorDetail(error, Date.now());
  });

  // 调试用：排障时从宿主控制台查看关键状态（不参与面板流程，QML 不调用）
  ctx.registerCommand('status', () => ({
    poolUrl: POOL_URL,
    minRunIntervalMs: MIN_RUN_INTERVAL_MS,
    periodId: state.periodId,
    joined: state.joined,
    autoEnabled,
    authCaptured: Boolean(capturedAuth),
  }));

  ctx.ui.registerPage('panel', 'qml/TeamPanel.qml');
  ctx.ui.registerTitlebarActionDefinition('open-panel', {
    title: '自动组队',
    icon: 'star',
    tooltip: '自动组队领VIP',
    defaultPlacement: 'toolbar',
    order: 100,
    onClick: () => {
      void openPanelDialog();
    },
  });

  ctx.setTimer('heartbeat', HEARTBEAT_TICK_MS, true, () => {
    runner.heartbeatTick();
    // 重发布状态：让"约 N 分钟后重试"随时间递减
    publishPanel();
  });

  scheduleStartupRun('startup', AUTO_RUN_DELAY_MS);
  void registerInterceptor();
  void syncAuthSnapshot();

  ctx.onDispose(() => {
    disposed = true;
    disposeDialog();
    if (interceptorLease) {
      interceptorLease.dispose();
      interceptorLease = null;
    }
    for (const finish of Array.from(pendingSleeps)) finish();
    pendingSleeps.clear();
    pageOpen = false;
  });
}

export function deactivate() {
  // onDispose 已按逆序回收全部资源；保留导出以满足可选约定
}

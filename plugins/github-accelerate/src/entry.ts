import { awaitOperation, type EchoPluginContext, type JsonValue } from 'echo:plugin-sdk';
import {
  compareVersion,
  DEFAULT_DATA,
  DAILY_REFRESH_MS,
  mirrorProbeUrl,
  normalizeMirrorData,
  reachable,
  REMOTE_DATA_URL,
  todayStr,
  type MirrorData,
} from './config.ts';

const PLUGIN_NAME = 'GitHub 加速';
/** 探测/拉取配置都是小文本，限制响应体避免异常镜像拖垮传输。 */
const PROBE_MAX_BYTES = 65536;
const DATA_TIMEOUT_MS = 8000;
/** 面板展示的按延迟排序的可用地址数量。 */
export const RANKED_LIMIT = 3;
/** 并发探测数；宿主限制每 scope 最多 16 个在途请求，留余量给每日刷新等。 */
export const PROBE_CONCURRENCY = 8;

// 类型别名（而非 interface）才有隐式索引签名，setState 的 JsonValue 才能接受。
export type RankedMirror = {
  url: string;
  latencyMs: number;
};

/** 单次探测结果：HTTP 状态码与本次请求往返耗时（毫秒）。 */
export interface ProbeOutcome {
  status: number;
  elapsedMs: number;
}

export interface AccelerateState {
  /** 当前生效的数据版本。 */
  version: string;
  testing: boolean;
  tested: boolean;
  /** 本轮扫描进度；testing 为 false 时两者相等。 */
  probeDone: number;
  probeTotal: number;
  /** 延迟最低的可用镜像；空字符串表示直连。 */
  selectedUrl: string;
  /** 选中镜像的往返延迟（毫秒），-1 表示未知。 */
  latencyMs: number;
  /** 按延迟升序的最多三个可用镜像。 */
  ranked: RankedMirror[];
  /** 各镜像的探测延迟；-1 表示不可达。 */
  latencyMap: Record<string, number>;
  mirrorCount: number;
  /** 已写入宿主设置的加速地址；空表示尚未自动应用。 */
  appliedUrl: string;
  applying: boolean;
  applyError: string;
}

/**
 * 宿主服务抽象：activate 绑定真实 SDK，Node 测试注入假实现。
 * Promise 链风格与 Qt 6.12 引擎一致（不使用 async/await 语法糖亦可，
 * 构建工具会将 async 源码转译为 ES2016）。
 */
export interface AccelerateHost {
  now(): number;
  /** 把加速地址写入宿主网络设置，返回宿主实际保存的值。 */
  applyMirror(url: string): Promise<string>;
  /** 是否处于自动托管模式（接管开）：决定测速后是否自动应用最优地址。 */
  autoApply(): boolean;
  /** GET 探测；解析为状态码与往返耗时，网络失败或超时 reject。 */
  probe(url: string, timeoutMs: number): Promise<ProbeOutcome>;
  /** GET 并解析 JSON 正文。 */
  fetchJson(url: string, timeoutMs: number): Promise<unknown>;
  /** 读取上次持久化的镜像数据；不存在或损坏时 resolve undefined。 */
  loadData(): Promise<unknown>;
  saveData(data: MirrorData): Promise<void>;
  loadCheckedDate(): Promise<unknown>;
  saveCheckedDate(value: string): Promise<void>;
  /** 读取「自动托管」开关偏好；未存储时 resolve undefined（视为开启）。 */
  loadAutoTakeover(): Promise<unknown>;
  saveAutoTakeover(value: boolean): Promise<void>;
  publish(state: AccelerateState): void;
  notify(level: 'info' | 'success' | 'warning' | 'danger', message: string): void;
}

export interface AccelerateController {
  state(): AccelerateState;
  publish(): void;
  /** 每日首次调用时拉取云端数据；有新版本时返回 true。 */
  ensureFresh(): Promise<boolean>;
  /** 探测全部镜像，按延迟排出最多三个可用地址；托管模式下自动应用最优地址。 */
  runTest(): Promise<void>;
  invalidate(): void;
}

export function createController(host: AccelerateHost, initial: MirrorData): AccelerateController {
  let data = initial;
  let testing = false;
  let tested = false;
  let probeDone = 0;
  let probeTotal = 0;
  let selectedUrl = '';
  let latencyMs = -1;
  let ranked: RankedMirror[] = [];
  let latencyMap: Record<string, number> = {};
  let refreshing = false;
  let appliedUrl = '';
  let applying = false;
  let applyError = '';
  /** 数据代数：adopt 换代时自增；在途测速轮次携带旧代数，收尾时代数不符即丢弃。 */
  let generation = 0;

  function resetResults(): void {
    tested = false;
    probeDone = 0;
    probeTotal = 0;
    selectedUrl = '';
    latencyMs = -1;
    ranked = [];
    latencyMap = {};
  }

  function state(): AccelerateState {
    return {
      version: data.version,
      testing,
      tested,
      probeDone,
      probeTotal,
      selectedUrl,
      latencyMs,
      ranked: ranked.map((entry) => ({ ...entry })),
      latencyMap: { ...latencyMap },
      mirrorCount: data.mirrors.length,
      appliedUrl,
      applying,
      applyError,
    };
  }

  function publish(): void {
    host.publish(state());
  }

  function adopt(next: MirrorData): void {
    data = next;
    // 换代使在途测速轮次作废：它收尾时不得覆盖新数据的干净状态。
    generation += 1;
    testing = false;
    resetResults();
    publish();
  }

  function ensureFresh(): Promise<boolean> {
    if (refreshing) return Promise.resolve(false);
    refreshing = true;
    const done = (): void => {
      refreshing = false;
    };
    return host
      .loadCheckedDate()
      .catch(() => undefined)
      .then((checked) => {
        const today = todayStr(host.now());
        if (checked === today) return false;
        return host
          .fetchJson(`${REMOTE_DATA_URL}?_=${host.now()}`, DATA_TIMEOUT_MS)
          .catch(() => undefined)
          .then((remote) => {
            // 拉取失败不标记已检查：下次激活/次日立即重试，而不是等 24 小时。
            if (remote === undefined) return false;
            const next = normalizeMirrorData(remote);
            if (next && compareVersion(next.version, data.version) > 0) {
              return host.saveData(next).then(() => {
                adopt(next);
                return host
                  .saveCheckedDate(today)
                  .catch(() => undefined)
                  .then(() => true);
              });
            }
            return host
              .saveCheckedDate(today)
              .catch(() => undefined)
              .then(() => false);
          });
      })
      .then(
        (adopted) => {
          done();
          return adopted;
        },
        (error) => {
          done();
          throw error;
        },
      );
  }

  function runTest(): Promise<void> {
    if (testing || applying) return Promise.resolve();
    if (!data.mirrors.length) {
      publish();
      host.notify('warning', `[${PLUGIN_NAME}] 没有可用的加速地址`);
      return Promise.resolve();
    }
    // 捕获快照：测速期间数据更新不应改变本轮的列表与超时。
    const mirrors = data.mirrors.slice();
    const test = { ...data.test };
    testing = true;
    applyError = '';
    const round = generation;
    // 清掉上一轮的排名与耗时：重测期间面板显示进度而不是旧结果。
    probeDone = 0;
    probeTotal = mirrors.length;
    selectedUrl = '';
    latencyMs = -1;
    ranked = [];
    latencyMap = {};
    publish();
    const map: Record<string, number> = {};
    const candidates: Array<RankedMirror & { order: number }> = [];
    // 并发分片探测：64 个镜像最坏耗时从串行的数分钟压到 ceil(64/8)*超时。
    // 每个分片按 order + 并发数推进，耗时由 probe 自带（并发下共享时钟不可靠）。
    const worker = (order: number): Promise<void> => {
      if (order >= mirrors.length || generation !== round) return Promise.resolve();
      const mirror = mirrors[order];
      return host
        .probe(mirrorProbeUrl(mirror, test, host.now()), test.timeoutMs)
        .then((outcome) => {
          if (generation !== round) return;
          map[mirror] = Math.max(1, Math.round(outcome.elapsedMs));
          if (reachable(outcome.status))
            candidates.push({ url: mirror, latencyMs: map[mirror], order });
        })
        .catch(() => {
          if (generation === round) map[mirror] = -1;
        })
        .then(() => {
          if (generation !== round) return undefined;
          probeDone += 1;
          publish();
          return worker(order + PROBE_CONCURRENCY);
        });
    };
    const workers: Array<Promise<void>> = [];
    for (let w = 0; w < PROBE_CONCURRENCY && w < mirrors.length; ++w) workers.push(worker(w));
    return Promise.all(workers)
      .then(() => {
        testing = false;
        if (generation !== round) {
          // 数据在测速中途换代：丢弃陈旧结果，保持 adopt 后的干净状态。
          publish();
          return;
        }
        // 显式 order 决胜：排序稳定性不依赖宿主引擎实现。
        candidates.sort((a, b) => a.latencyMs - b.latencyMs || a.order - b.order);
        const top = candidates
          .slice(0, RANKED_LIMIT)
          .map(({ url, latencyMs: ms }) => ({ url, latencyMs: ms }));
        tested = true;
        selectedUrl = top.length ? top[0].url : '';
        latencyMs = top.length ? top[0].latencyMs : -1;
        ranked = top;
        latencyMap = map;
        publish();
        if (!selectedUrl) {
          host.notify(
            'warning',
            host.autoApply()
              ? `[${PLUGIN_NAME}] 未找到可用的加速地址，继续使用当前设置`
              : `[${PLUGIN_NAME}] 未找到可用的加速地址，请检查网络后重新检测`,
          );
          return;
        }
        // 手动模式只排名不落盘；托管模式自动把最优地址写入宿主网络设置。
        if (!host.autoApply()) return;
        applying = true;
        publish();
        return host
          .applyMirror(selectedUrl)
          .then((saved) => {
            if (generation !== round) return;
            appliedUrl = saved;
          })
          .catch((error: unknown) => {
            if (generation !== round) return;
            applyError = error instanceof Error ? error.message : String(error);
            host.notify('danger', `保存加速地址失败：${applyError}`);
          })
          .then(() => {
            if (generation !== round) return;
            applying = false;
            publish();
          });
      })
      .catch(() => {
        testing = false;
        if (generation !== round) {
          publish();
          return;
        }
        tested = true;
        latencyMap = map;
        publish();
      });
  }

  function invalidate(): void {
    generation += 1;
    testing = false;
    applying = false;
    resetResults();
    publish();
  }
  return { state, publish, ensureFresh, runTest, invalidate };
}

/** 统一 toast：固定插件名前缀，插件停用后静默。 */
function toast(
  ctx: EchoPluginContext,
  level: 'info' | 'success' | 'warning' | 'danger',
  message: string,
): void {
  if (ctx.active) void ctx.toast[level](`[${PLUGIN_NAME}] ${message}`);
}

function createQtHost(
  ctx: EchoPluginContext,
  presentation: () => Record<string, JsonValue>,
): AccelerateHost {
  return {
    now: () => Date.now(),
    applyMirror: (url) =>
      awaitOperation(ctx.settings.update('network', { githubProxyUrl: url })).then(
        (saved) => saved.githubProxyUrl,
      ),
    // 托管开/关由 activate 的 controlled 标志承载：只有真正接管后才自动应用。
    autoApply: () => presentation().controlled === true,
    probe: (url, timeoutMs) => {
      const startedAt = Date.now();
      return awaitOperation(
        ctx.net.request({
          url,
          method: 'GET',
          responseType: 'text',
          timeoutMs,
          maxResponseBytes: PROBE_MAX_BYTES,
        }),
      ).then((response) => ({
        status: (response as { status: number }).status,
        elapsedMs: Date.now() - startedAt,
      }));
    },
    fetchJson: (url, timeoutMs) =>
      awaitOperation(
        ctx.net.request({
          url,
          method: 'GET',
          responseType: 'json',
          timeoutMs,
          maxResponseBytes: PROBE_MAX_BYTES,
        }),
      ).then((response) => (response as { data: unknown }).data),
    loadData: () => awaitOperation(ctx.io.readValue('data')),
    saveData: (value) =>
      awaitOperation(ctx.io.writeValue('data', value as unknown as JsonValue)).then(
        () => undefined,
      ),
    loadCheckedDate: () => awaitOperation(ctx.io.readValue('lastUpdateDate')),
    saveCheckedDate: (value) =>
      awaitOperation(ctx.io.writeValue('lastUpdateDate', value)).then(() => undefined),
    loadAutoTakeover: () => awaitOperation(ctx.io.readValue('autoTakeover')),
    saveAutoTakeover: (value) =>
      awaitOperation(ctx.io.writeValue('autoTakeover', value)).then(() => undefined),
    publish: (value) => {
      if (ctx.active) ctx.ui.setState({ ...value, ...presentation() });
    },
    notify: (level, message) => toast(ctx, level, message),
  };
}

/** 解析复制目标：仅接受本轮探测过的镜像地址，其余（含未传/非法）一律回退到推荐地址。 */
export function resolveCopyTarget(
  args: Record<string, JsonValue> | undefined,
  state: AccelerateState,
): string {
  const requested = args?.url;
  return typeof requested === 'string' && state.latencyMap[requested] !== undefined
    ? requested
    : state.selectedUrl;
}

/** 复制地址到剪贴板；返回是否真正复制成功（空地址或写入失败均为 false）。 */
function copySelected(ctx: EchoPluginContext, selectedUrl: string): Promise<boolean> {
  if (!selectedUrl) {
    toast(ctx, 'warning', '尚未检测到可用的加速地址');
    return Promise.resolve(false);
  }
  return awaitOperation(ctx.clipboard.write(selectedUrl))
    .then(() => {
      toast(ctx, 'success', '已复制加速地址');
      return true;
    })
    .catch(() => {
      toast(ctx, 'danger', '复制到剪贴板失败');
      return false;
    });
}

export function activate(ctx: EchoPluginContext) {
  let controlled = false;
  let currentUrl = '';
  /** 「自动托管」开关（面板可切换，持久化）：关 = 1.0.0 手动模式，开 = 接管模式。 */
  let takeoverEnabled = true;
  let session = 0;
  let restore: (() => void) | undefined;
  const host = createQtHost(ctx, () => ({ controlled, currentUrl, autoTakeover: takeoverEnabled }));
  return host
    .loadData()
    .catch(() => undefined)
    .then((stored) =>
      Promise.all([Promise.resolve(stored), host.loadAutoTakeover().catch(() => undefined)]),
    )
    .then(([stored, pref]) => {
      if (!ctx.active) return undefined;
      // 未存储过偏好（首次安装/老版本升级）默认开启托管。
      takeoverEnabled = pref !== false;
      const controller = createController(host, normalizeMirrorData(stored) ?? DEFAULT_DATA);
      const withdraw = () => {
        controlled = false;
        const cleanup = restore;
        restore = undefined;
        cleanup?.();
        controller.publish();
      };
      controller.publish();
      // 用户是否已手动复制过地址（行内复制且写入成功才算）：手动模式“粘贴到设置”的兜底依据。
      let userCopied = false;
      ctx.registerCommand('accelerate.auto', (args) => {
        const enabled = args?.enabled === true;
        if (enabled === takeoverEnabled) return undefined;
        takeoverEnabled = enabled;
        return host.saveAutoTakeover(enabled).then(
          () => {
            if (!enabled) {
              // 关闭托管：退役会话使在途的授权/接管链作废（否则用户确认权限后接管会复活），
              // 撤回提示并恢复宿主输入框；已写入宿主的地址保留不动。
              session += 1;
              withdraw();
              return undefined;
            }
            if (controlled) {
              controller.publish();
              return undefined;
            }
            // 不等待整轮测速（最坏可达数十秒）：命令立即返回，失败由 start 内部 toast。
            void start();
            return undefined;
          },
          (error: unknown) => {
            // 存盘失败回滚开关，面板下一次发布时会恢复原位。
            takeoverEnabled = !enabled;
            controller.publish();
            throw error;
          },
        );
      });
      ctx.registerCommand('accelerate.test', () => {
        // 新一轮检测作废旧轮的“已复制”标记：重测后「粘贴到设置」重新兜底复制新的第 1 名。
        userCopied = false;
        if (controlled) return controller.runTest();
        return takeoverEnabled ? start() : controller.runTest();
      });
      ctx.registerCommand('accelerate.copy', (args) => {
        const target = resolveCopyTarget(args, controller.state());
        return copySelected(ctx, target).then((copied) => {
          if (copied && args !== undefined && args.url === target) userCopied = true;
        });
      });
      ctx.registerCommand('accelerate.open', () => {
        // 接管模式下宿主输入框已隐藏，无需复制兜底；手动模式保持 1.0.0 兜底复制行为。
        const fallback =
          controlled || userCopied
            ? Promise.resolve()
            : copySelected(ctx, controller.state().selectedUrl);
        return fallback
          .then(() =>
            awaitOperation(
              ctx.ui.navigation.navigate({ name: 'settings', query: { section: 'network' } }),
            ),
          )
          .then(() => undefined);
      });
      if (!ctx.ui.registerSettings('Settings.qml')) throw new Error('无法注册设置面板');

      const refresh = () => {
        const round = session;
        return controller
          .ensureFresh()
          .catch(() => false)
          .then(() => {
            if (round === session && ctx.active && controlled) return controller.runTest();
            return undefined;
          });
      };
      function start(): Promise<void> {
        const round = ++session;
        controller.invalidate();
        withdraw();
        // This lease gates the UI and is retired by permission revocation/account changes.
        return awaitOperation(
          ctx.settings.observe('network-takeover', 'network', (value) => {
            if (round !== session || !ctx.active) return;
            // 宿主可能以 null/缺字段回调：缺失按“直连”展示，避免抛错打断监听链。
            currentUrl =
              value && typeof value.githubProxyUrl === 'string' ? value.githubProxyUrl : '';
            controller.publish();
          }),
        )
          .then((watch) => {
            if (round !== session || !ctx.active) {
              watch.dispose();
              return;
            }
            const hint = ctx.ui.parts.contribute(
              'network-hint',
              { key: 'settingsGithubProxyUrl', owner: '@host' },
              {
                operation: 'insert',
                position: 'before',
                component: 'Takeover.qml',
                layout: { preferredWidth: 240, preferredHeight: 36 },
                priority: 10,
              },
            );
            const hide = ctx.ui.parts.contribute(
              'network-input',
              { key: 'settingsGithubProxyUrl', owner: '@host' },
              { operation: 'hide', priority: 10 },
            );
            if (!hint || !hide) {
              hint?.dispose();
              hide?.dispose();
              watch.dispose();
              throw new Error(ctx.ui.parts.errorMessage || '无法显示接管提示');
            }
            restore = () => {
              hint.dispose();
              hide.dispose();
              watch.dispose();
            };
            watch.activeChanged.connect(() => {
              if (!watch.active && round === session) {
                controller.invalidate();
                withdraw();
              }
            });
            controlled = true;
            controller.publish();
            return refresh();
          })
          .catch((error: unknown) => {
            if (round !== session || !ctx.active) return;
            withdraw();
            toast(
              ctx,
              'danger',
              `无法接管网络设置：${error instanceof Error ? error.message : String(error)}`,
            );
          });
      }
      // Network work starts after activation commits, never holding the activation deadline.
      // 托管模式走接管流程；手动模式只刷新镜像列表（测试在面板打开时触发，1.0.0 行为）。
      const schedule = () => {
        if (
          ctx.active &&
          !ctx.setTimer('startup-work', 1, false, () => {
            void (takeoverEnabled ? start() : refresh());
          })
        )
          throw new Error('无法创建启动检测任务');
      };
      ctx.sessionInvalidated.connect(() => {
        session += 1;
        controller.invalidate();
        withdraw();
        schedule();
      });
      ctx.onDispose(() => {
        session += 1;
        controller.invalidate();
        withdraw();
      });
      if (
        !ctx.setTimer('daily-refresh', DAILY_REFRESH_MS, true, () => {
          void refresh();
        })
      )
        throw new Error('无法创建每日更新定时器');
      schedule();
      return undefined;
    });
}

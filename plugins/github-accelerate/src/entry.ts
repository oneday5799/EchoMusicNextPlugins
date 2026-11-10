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
}

/**
 * 宿主服务抽象：activate 绑定真实 SDK，Node 测试注入假实现。
 * Promise 链风格与 Qt 6.12 引擎一致（不使用 async/await 语法糖亦可，
 * 构建工具会将 async 源码转译为 ES2016）。
 */
export interface AccelerateHost {
  now(): number;
  /** GET 探测；解析为状态码与往返耗时，网络失败或超时 reject。 */
  probe(url: string, timeoutMs: number): Promise<ProbeOutcome>;
  /** GET 并解析 JSON 正文。 */
  fetchJson(url: string, timeoutMs: number): Promise<unknown>;
  /** 读取上次持久化的镜像数据；不存在或损坏时 resolve undefined。 */
  loadData(): Promise<unknown>;
  saveData(data: MirrorData): Promise<void>;
  loadCheckedDate(): Promise<unknown>;
  saveCheckedDate(value: string): Promise<void>;
  publish(state: AccelerateState): void;
  notify(level: 'info' | 'success' | 'warning' | 'danger', message: string): void;
}

export interface AccelerateController {
  state(): AccelerateState;
  publish(): void;
  /** 每日首次调用时拉取云端数据；有新版本时返回 true。 */
  ensureFresh(): Promise<boolean>;
  /** 探测全部镜像，按延迟排出最多三个可用地址。 */
  runTest(): Promise<void>;
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

  function resetResults(): void {
    testing = false;
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
    };
  }

  function publish(): void {
    host.publish(state());
  }

  function adopt(next: MirrorData): void {
    data = next;
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
    if (testing) return Promise.resolve();
    if (!data.mirrors.length) {
      publish();
      host.notify('warning', `[${PLUGIN_NAME}] 没有可用的加速地址`);
      return Promise.resolve();
    }
    // 捕获快照：测速期间数据更新不应改变本轮的列表与超时。
    const mirrors = data.mirrors.slice();
    const test = { ...data.test };
    testing = true;
    probeDone = 0;
    probeTotal = mirrors.length;
    publish();
    const map: Record<string, number> = {};
    const candidates: Array<RankedMirror & { order: number }> = [];
    // 并发分片探测：64 个镜像最坏耗时从串行的数分钟压到 ceil(64/8)*超时。
    // 每个分片按 order + 并发数推进，耗时由 probe 自带（并发下共享时钟不可靠）。
    const worker = (order: number): Promise<void> => {
      if (order >= mirrors.length) return Promise.resolve();
      const mirror = mirrors[order];
      return host
        .probe(mirrorProbeUrl(mirror, test, host.now()), test.timeoutMs)
        .then((outcome) => {
          map[mirror] = Math.max(1, Math.round(outcome.elapsedMs));
          if (reachable(outcome.status))
            candidates.push({ url: mirror, latencyMs: map[mirror], order });
        })
        .catch(() => {
          map[mirror] = -1;
        })
        .then(() => {
          probeDone += 1;
          publish();
          return worker(order + PROBE_CONCURRENCY);
        });
    };
    const workers: Array<Promise<void>> = [];
    for (let w = 0; w < PROBE_CONCURRENCY && w < mirrors.length; ++w) workers.push(worker(w));
    return Promise.all(workers)
      .then(() => {
        // 显式 order 决胜：排序稳定性不依赖宿主引擎实现。
        candidates.sort((a, b) => a.latencyMs - b.latencyMs || a.order - b.order);
        const top = candidates
          .slice(0, RANKED_LIMIT)
          .map(({ url, latencyMs: ms }) => ({ url, latencyMs: ms }));
        testing = false;
        tested = true;
        selectedUrl = top.length ? top[0].url : '';
        latencyMs = top.length ? top[0].latencyMs : -1;
        ranked = top;
        latencyMap = map;
        publish();
        if (!selectedUrl)
          host.notify('warning', `[${PLUGIN_NAME}] 未找到可用的加速地址，请检查网络后重新检测`);
      })
      .catch(() => {
        testing = false;
        tested = true;
        latencyMap = map;
        publish();
      });
  }

  return { state, publish, ensureFresh, runTest };
}

function createQtHost(ctx: EchoPluginContext): AccelerateHost {
  return {
    now: () => Date.now(),
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
    publish: (value) => {
      if (ctx.active) ctx.ui.setState({ ...value });
    },
    notify: (level, message) => {
      if (!ctx.active) return;
      void ctx.toast[level](message);
    },
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

function copySelected(ctx: EchoPluginContext, selectedUrl: string): Promise<void> {
  if (!selectedUrl) {
    if (ctx.active) void ctx.toast.warning(`[${PLUGIN_NAME}] 尚未检测到可用的加速地址`);
    return Promise.resolve();
  }
  return awaitOperation(ctx.clipboard.write(selectedUrl))
    .then(() => {
      if (ctx.active)
        void ctx.toast.success(
          `[${PLUGIN_NAME}] 已复制加速地址，请粘贴到 设置 → 网络设置 → GitHub 加速地址`,
        );
    })
    .catch(() => {
      if (ctx.active) void ctx.toast.danger(`[${PLUGIN_NAME}] 复制到剪贴板失败`);
    });
}

export function activate(ctx: EchoPluginContext) {
  const host = createQtHost(ctx);
  return host
    .loadData()
    .catch(() => undefined)
    .then((stored) => {
      if (!ctx.active) return undefined;
      const controller = createController(host, normalizeMirrorData(stored) ?? DEFAULT_DATA);
      controller.publish();

      ctx.registerCommand('accelerate.test', () => controller.runTest());
      ctx.registerCommand('accelerate.copy', (args) =>
        copySelected(ctx, resolveCopyTarget(args, controller.state())),
      );
      ctx.registerCommand('accelerate.open', () =>
        awaitOperation(
          ctx.ui.navigation.navigate({ name: 'settings', query: { section: 'network' } }),
        ).then(() => undefined),
      );
      const settings = ctx.ui.registerSettings('Settings.qml');
      if (!settings) throw new Error('无法注册设置面板');

      const refresh = (): void => {
        controller.ensureFresh().catch(() => undefined);
      };
      refresh();
      if (!ctx.setTimer('daily-refresh', DAILY_REFRESH_MS, true, refresh))
        throw new Error('无法创建每日更新定时器');
      return undefined;
    });
}

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareVersion,
  DEFAULT_DATA,
  mirrorProbeUrl,
  normalizeMirrorData,
  reachable,
  todayStr,
} from '../plugins/github-accelerate/src/config.ts';
import {
  activate,
  createController,
  PROBE_CONCURRENCY,
  resolveCopyTarget,
} from '../plugins/github-accelerate/src/entry.ts';

// ---------- config.ts：数据规范化 ----------

test('normalizeMirrorData accepts the community data shape and normalizes mirrors', () => {
  const data = normalizeMirrorData({
    version: '1.0.1',
    update: '2026-07-27',
    test: { url: 'https://example.com/manifest.json', random: false, timeout: 3000 },
    data: ['https://a.example/', 'https://b.example//', 'https://a.example'],
  });
  assert.equal(data.version, '1.0.1');
  assert.deepEqual(data.mirrors, ['https://a.example', 'https://b.example']);
  assert.deepEqual(data.test, {
    url: 'https://example.com/manifest.json',
    random: false,
    timeoutMs: 3000,
  });
});

test('normalizeMirrorData round-trips through the persisted mirrors shape', () => {
  // saveData 落盘的是本函数的输出（mirrors 键）；重启后 loadData 回读同一形状，
  // 必须能再次通过校验，否则会静默回退到单镜像的内置数据。
  const remote = normalizeMirrorData({
    version: '1.0.3',
    test: { url: 'https://raw.example/m.json', random: true, timeout: 5000 },
    data: ['https://a.example', 'https://b.example'],
  });
  const reloaded = normalizeMirrorData(JSON.parse(JSON.stringify(remote)));
  assert.notEqual(reloaded, null);
  assert.deepEqual(reloaded.mirrors, remote.mirrors);
  assert.equal(reloaded.version, '1.0.3');
  assert.deepEqual(reloaded.test, remote.test);
});

test('normalizeMirrorData rejects payloads without a usable mirror list', () => {
  assert.equal(normalizeMirrorData(undefined), null);
  assert.equal(normalizeMirrorData(null), null);
  assert.equal(normalizeMirrorData('data'), null);
  assert.equal(normalizeMirrorData([]), null);
  assert.equal(normalizeMirrorData({ data: [] }), null);
  assert.equal(normalizeMirrorData({ data: ['ftp://x', 'not-a-url', 42] }), null);
});

test('normalizeMirrorData caps the mirror list at 64 entries', () => {
  const data = normalizeMirrorData({
    data: Array.from({ length: 100 }, (_, i) => `https://m${i}.example`),
  });
  assert.equal(data.mirrors.length, 64);
  assert.equal(data.mirrors[63], 'https://m63.example');
});

test('normalizeMirrorData clamps the probe timeout and keeps defaults', () => {
  assert.equal(
    normalizeMirrorData({ data: ['https://a'] }).test.timeoutMs,
    DEFAULT_DATA.test.timeoutMs,
  );
  assert.equal(
    normalizeMirrorData({ data: ['https://a'], test: { timeout: 1 } }).test.timeoutMs,
    1000,
  );
  assert.equal(
    normalizeMirrorData({ data: ['https://a'], test: { timeout: 99_999 } }).test.timeoutMs,
    30000,
  );
  assert.equal(
    normalizeMirrorData({ data: ['https://a'], test: { timeout: 'fast' } }).test.timeoutMs,
    DEFAULT_DATA.test.timeoutMs,
  );
  assert.equal(
    normalizeMirrorData({ data: ['https://a'], test: { timeout: 2500.6 } }).test.timeoutMs,
    2501,
  );
  assert.equal(
    normalizeMirrorData({ data: ['https://a'], test: { random: false } }).test.random,
    false,
  );
  assert.equal(normalizeMirrorData({ data: ['https://a'] }).test.random, true);
});

// ---------- config.ts：版本与工具 ----------

test('compareVersion performs a three-segment numeric comparison', () => {
  assert.equal(compareVersion('1.0.1', '1.0.0'), 1);
  assert.equal(compareVersion('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersion('0.9', '1.0.0'), -1);
  assert.equal(compareVersion('1.2', '1.1.9'), 1);
  assert.equal(compareVersion('', '1.0.0'), -1);
  // 非数字段按 0 处理，与原版 `Number(x) || 0` 行为一致
  assert.equal(compareVersion('a.b.c', '1.0.0'), -1);
  assert.equal(compareVersion('a.b.c', '0.0.0'), 0);
});

test('todayStr renders the UTC date of a timestamp', () => {
  assert.equal(todayStr(Date.UTC(2026, 10, 9, 23, 30)), '2026-11-09');
  assert.equal(todayStr(Date.UTC(2026, 0, 1, 0, 0)), '2026-01-01');
});

test('mirrorProbeUrl appends a cache-busting parameter only when enabled', () => {
  const test = { url: 'https://raw.example/m.json', random: true, timeoutMs: 5000 };
  assert.equal(
    mirrorProbeUrl('https://m.example/', test, 42),
    'https://m.example/https://raw.example/m.json?_=42',
  );
  assert.equal(
    mirrorProbeUrl('https://m.example', { ...test, random: false }, 42),
    'https://m.example/https://raw.example/m.json',
  );
  assert.equal(
    mirrorProbeUrl('https://m.example/', { ...test, url: 'https://raw.example/m.json?x=1' }, 42),
    'https://m.example/https://raw.example/m.json?x=1&_=42',
  );
});

test('reachable mirrors the original non-5xx criterion', () => {
  assert.equal(reachable(200), true);
  assert.equal(reachable(301), true);
  assert.equal(reachable(404), true);
  assert.equal(reachable(500), false);
  assert.equal(reachable(503), false);
});

// ---------- entry.ts：测速控制器 ----------

const TEST_DATA = normalizeMirrorData({
  version: '1.0.0',
  test: { url: 'https://raw.example/m.json', random: true, timeout: 5000 },
  data: ['https://a.example', 'https://b.example', 'https://c.example'],
});

function mockHost(overrides = {}) {
  const states = [];
  const probes = [];
  const notifications = [];
  const saves = [];
  const storage = { data: undefined, checkedDate: undefined, autoTakeover: undefined };
  let clock = 1_000_000;
  let inFlight = 0;
  let maxInFlight = 0;
  let remote = undefined;
  let remoteError = false;
  const host = {
    now: () => (clock += 10),
    probe: (url, timeoutMs) => {
      probes.push({ url, timeoutMs });
      const i = probes.length - 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const status = host.probeStatuses[i];
      const settle = () => {
        inFlight -= 1;
        if (status === 'error') throw new Error('network down');
        return { status, elapsedMs: host.probeDelays[i] ?? 0 };
      };
      return Promise.resolve().then(settle);
    },
    probeStatuses: [200, 200, 200],
    probeDelays: [],
    fetchJson: () => {
      if (remoteError) return Promise.reject(new Error('offline'));
      return Promise.resolve(remote);
    },
    loadData: () => Promise.resolve(storage.data),
    saveData: (value) => {
      storage.data = value;
      return Promise.resolve();
    },
    loadCheckedDate: () => Promise.resolve(storage.checkedDate),
    saveCheckedDate: (value) => {
      storage.checkedDate = value;
      return Promise.resolve();
    },
    applyMirror: (url) => {
      saves.push(url);
      return Promise.resolve(url);
    },
    // 默认手动模式（1.0.0 语义）：只排名不落盘；接管测试通过 overrides 打开。
    autoApply: () => false,
    loadAutoTakeover: () => Promise.resolve(storage.autoTakeover),
    saveAutoTakeover: (value) => {
      storage.autoTakeover = value;
      return Promise.resolve();
    },
    publish: (state) => states.push(state),
    notify: (level, message) => notifications.push({ level, message }),
    // 测试观察句柄
    states,
    probes,
    notifications,
    saves,
    get maxInFlight() {
      return maxInFlight;
    },
    storage: {
      get data() {
        return storage.data;
      },
      get checkedDate() {
        return storage.checkedDate;
      },
    },
    setRemote: (payload) => {
      remote = payload;
    },
    failRemote: () => {
      remoteError = true;
    },
    ...overrides,
  };
  return host;
}

test('all mirrors are probed and reachable ones are ranked by latency', async () => {
  const host = mockHost({ probeStatuses: [200, 200, 200], probeDelays: [40, 10, 25] });
  const controller = createController(host, TEST_DATA);
  await controller.runTest();

  assert.equal(host.probes.length, 3);
  assert.ok(host.probes[0].url.startsWith('https://a.example/'));
  assert.equal(host.probes[0].timeoutMs, 5000);
  const final = host.states.at(-1);
  assert.equal(final.testing, false);
  assert.equal(final.tested, true);
  // 延迟升序：b(10) < c(25) < a(40)；耗时来自 probe 自带的 elapsedMs
  assert.deepEqual(final.ranked, [
    { url: 'https://b.example', latencyMs: 10 },
    { url: 'https://c.example', latencyMs: 25 },
    { url: 'https://a.example', latencyMs: 40 },
  ]);
  assert.equal(final.selectedUrl, 'https://b.example');
  assert.equal(final.latencyMs, 10);
  assert.equal(final.latencyMap['https://a.example'], 40);
  // 进度收口：完成后 done === total
  assert.equal(final.probeDone, 3);
  assert.equal(final.probeTotal, 3);
});

test('probing runs in bounded concurrent waves with visible progress', async () => {
  const data = normalizeMirrorData({
    test: { url: 'https://raw.example/m.json', timeout: 5000 },
    data: Array.from({ length: 50 }, (_, i) => `https://m${i}.example`),
  });
  const host = mockHost({ probeStatuses: Array(50).fill(200) });
  const controller = createController(host, data);
  await controller.runTest();

  assert.equal(host.probes.length, 50);
  // 首波同时启动 min(并发数, 列表长度) 个探测
  assert.equal(host.maxInFlight, PROBE_CONCURRENCY);
  for (let i = 0; i < PROBE_CONCURRENCY; ++i)
    assert.ok(host.probes[i].url.startsWith(`https://m${i}.example/`));
  // 进行中状态携带进度，完成状态收口
  assert.equal(host.states[0].testing, true);
  assert.equal(host.states[0].probeDone, 0);
  assert.equal(host.states[0].probeTotal, 50);
  const final = host.states.at(-1);
  assert.equal(final.testing, false);
  assert.equal(final.probeDone, 50);
  assert.equal(final.probeTotal, 50);
  assert.ok(host.states.length > 10);
});

test('unreachable mirrors record -1 and equal latencies keep list order', async () => {
  const host = mockHost({ probeStatuses: ['error', 200, 200] });
  const controller = createController(host, TEST_DATA);
  await controller.runTest();

  assert.equal(host.probes.length, 3);
  const final = host.states.at(-1);
  assert.equal(final.latencyMap['https://a.example'], -1);
  assert.equal(final.selectedUrl, 'https://b.example');
  // 零耗时的成功探测也被钳制到 1ms；并列延迟按列表顺序决胜
  assert.deepEqual(final.ranked, [
    { url: 'https://b.example', latencyMs: 1 },
    { url: 'https://c.example', latencyMs: 1 },
  ]);
});

test('a mirror answering 5xx is skipped and a fully failing run notifies a warning', async () => {
  const host = mockHost({ probeStatuses: [503, 500, 'error'] });
  const controller = createController(host, TEST_DATA);
  await controller.runTest();

  assert.equal(host.probes.length, 3);
  const final = host.states.at(-1);
  assert.equal(final.selectedUrl, '');
  assert.equal(final.latencyMs, -1);
  assert.deepEqual(final.ranked, []);
  // 5xx 响应仍记录耗时（请求本身成功），只有网络失败记为 -1
  assert.equal(final.latencyMap['https://a.example'] > 0, true);
  assert.equal(final.latencyMap['https://b.example'] > 0, true);
  assert.equal(final.latencyMap['https://c.example'], -1);
  assert.deepEqual(
    host.notifications.map((n) => n.level),
    ['warning'],
  );
});

test('at most three mirrors are ranked even with more reachable ones', async () => {
  const data = normalizeMirrorData({
    test: { url: 'https://raw.example/m.json', timeout: 5000 },
    data: [
      'https://m1.example',
      'https://m2.example',
      'https://m3.example',
      'https://m4.example',
      'https://m5.example',
    ],
  });
  const host = mockHost({
    probeStatuses: [200, 200, 200, 200, 200],
    probeDelays: [50, 40, 30, 20, 10],
  });
  const controller = createController(host, data);
  await controller.runTest();

  assert.equal(host.probes.length, 5);
  const final = host.states.at(-1);
  assert.deepEqual(
    final.ranked.map((m) => m.url),
    ['https://m5.example', 'https://m4.example', 'https://m3.example'],
  );
  assert.equal(final.selectedUrl, 'https://m5.example');
});

test('runTest publishes a testing state first and guards re-entry', async () => {
  const host = mockHost();
  const controller = createController(host, TEST_DATA);
  const pending = controller.runTest();
  controller.runTest(); // second call while running must be ignored
  await pending;

  // 全量扫描三个镜像，重入调用不会叠加第二轮
  assert.equal(host.probes.length, 3);
  assert.equal(host.states[0].testing, true);
  const final = host.states.at(-1);
  assert.equal(final.testing, false);
  assert.equal(final.selectedUrl, 'https://a.example');
});

test('a re-test clears the previous round before probing', async () => {
  // mock 按绝对下标取状态/延迟：两轮各 3 个探测，提供 6 个
  const host = mockHost({
    probeStatuses: [200, 200, 200, 200, 200, 200],
    probeDelays: [40, 10, 25, 40, 10, 25],
  });
  const controller = createController(host, TEST_DATA);
  await controller.runTest();
  assert.equal(host.states.at(-1).ranked.length, 3);

  const before = host.states.length;
  await controller.runTest();
  // 第二轮开跑即清掉上一轮排名，面板此刻只显示进度
  const restart = host.states[before];
  assert.equal(restart.testing, true);
  assert.deepEqual(restart.ranked, []);
  assert.deepEqual(restart.latencyMap, {});
  assert.equal(restart.selectedUrl, '');
  assert.equal(host.states.at(-1).selectedUrl, 'https://b.example');
});

test('a data adoption mid-test abandons the in-flight round', async () => {
  const data = normalizeMirrorData({
    test: { url: 'https://raw.example/m.json', timeout: 5000 },
    data: Array.from({ length: 12 }, (_, i) => `https://m${i}.example`),
  });
  const host = mockHost({ probeStatuses: Array(12).fill(200) });
  // 门闩 probe：首波 8 个挂起，直到显式放行
  let releaseProbes;
  const gate = new Promise((resolve) => {
    releaseProbes = resolve;
  });
  host.probe = (url, timeoutMs) => {
    host.probes.push({ url, timeoutMs });
    return gate.then(() => ({ status: 200, elapsedMs: 5 }));
  };

  const controller = createController(host, data);
  const pending = controller.runTest();
  // 测速中途拉取到新版本数据，触发换代
  host.setRemote({
    version: '1.1.0',
    test: { url: 'https://raw.example/new.json', timeout: 5000 },
    data: ['https://new.example'],
  });
  const adopting = controller.ensureFresh();
  await new Promise((resolve) => setImmediate(resolve));
  releaseProbes();
  await adopting;
  assert.equal(host.storage.data.version, '1.1.0');

  // 放行后旧轮次不得再发后续波次：12 个镜像只发出首波 8 个探测
  await pending;
  assert.equal(host.probes.length, PROBE_CONCURRENCY);
  const final = host.states.at(-1);
  assert.equal(final.testing, false);
  assert.equal(final.tested, false);
  assert.equal(final.version, '1.1.0');
  assert.deepEqual(final.ranked, []);

  // 换代后的新数据可以正常重测出结果
  await controller.runTest();
  assert.equal(host.states.at(-1).tested, true);
  assert.equal(host.states.at(-1).selectedUrl, 'https://new.example');
});

test('an empty mirror list warns without probing', async () => {
  const host = mockHost();
  // 数据规范化不会产生空列表；直接构造以覆盖守卫分支
  const empty = normalizeMirrorData({ data: ['https://a.example'] });
  empty.mirrors.length = 0;
  const controller = createController(host, empty);
  await controller.runTest();

  assert.equal(host.probes.length, 0);
  assert.deepEqual(
    host.notifications.map((n) => n.level),
    ['warning'],
  );
  assert.equal(host.states.at(-1).tested, false);
});

test('ensureFresh adopts a newer remote data set and persists it', async () => {
  const host = mockHost();
  host.setRemote({
    version: '1.1.0',
    test: { url: 'https://raw.example/new.json', timeout: 2500 },
    data: ['https://new.example'],
  });
  const controller = createController(host, TEST_DATA);
  const adopted = await controller.ensureFresh();

  assert.equal(adopted, true);
  assert.equal(host.storage.data.version, '1.1.0');
  assert.equal(host.storage.checkedDate, todayStr(host.now()));
  const state = controller.state();
  assert.equal(state.version, '1.1.0');
  assert.equal(state.mirrorCount, 1);
  // 版本更新后旧测速结果作废
  assert.equal(state.tested, false);
});

test('ensureFresh ignores same or older versions and keeps the local data', async () => {
  const host = mockHost();
  host.setRemote({ version: '0.9.0', data: ['https://old.example'] });
  const controller = createController(host, TEST_DATA);
  assert.equal(await controller.ensureFresh(), false);
  assert.equal(host.storage.data, undefined);
  assert.equal(controller.state().version, '1.0.0');
  assert.equal(controller.state().mirrorCount, 3);
});

test('ensureFresh silently keeps local data when the remote fetch fails', async () => {
  const host = mockHost();
  host.failRemote();
  const controller = createController(host, TEST_DATA);
  assert.equal(await controller.ensureFresh(), false);
  assert.equal(host.storage.data, undefined);
  // 拉取失败不标记已检查：下次激活/次日立即重试，而不是等 24 小时
  assert.equal(host.storage.checkedDate, undefined);
});

test('ensureFresh fetches at most once per day', async () => {
  const host = mockHost();
  host.setRemote({ version: '1.1.0', data: ['https://new.example'] });
  const controller = createController(host, TEST_DATA);
  await controller.ensureFresh();
  const checked = host.storage.checkedDate;
  assert.equal(await controller.ensureFresh(), false);
  assert.equal(host.storage.checkedDate, checked);
});

test('a concurrent refresh does not duplicate the remote fetch', async () => {
  const host = mockHost();
  let release;
  host.fetchJson = () =>
    new Promise((resolve) => {
      release = () => resolve({ version: '1.1.0', data: ['https://new.example'] });
    });
  const controller = createController(host, TEST_DATA);
  const first = controller.ensureFresh();
  const second = await controller.ensureFresh();
  assert.equal(second, false);
  // 等待首个刷新链进入 fetchJson 后再放行
  await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.equal(await first, true);
});

test('resolveCopyTarget accepts probed mirrors and falls back to the selected one', async () => {
  const host = mockHost({ probeStatuses: [200, 200, 200], probeDelays: [40, 10, 25] });
  const controller = createController(host, TEST_DATA);
  await controller.runTest();
  const state = controller.state();

  // 行内复制：url 必须是本轮探测过的镜像
  assert.equal(resolveCopyTarget({ url: 'https://c.example' }, state), 'https://c.example');
  // 未知/非法/未传 url 一律回退到推荐地址
  assert.equal(resolveCopyTarget({ url: 'https://evil.example' }, state), 'https://b.example');
  assert.equal(resolveCopyTarget({ url: 42 }, state), 'https://b.example');
  assert.equal(resolveCopyTarget({}, state), 'https://b.example');
  assert.equal(resolveCopyTarget(undefined, state), 'https://b.example');
  // 未探测出结果时回退值为空串，复制动作提示尚未检测
  const empty = createController(mockHost(), TEST_DATA);
  assert.equal(resolveCopyTarget({ url: 'https://a.example' }, empty.state()), '');
});

// ---------- entry.ts：托管模式的自动应用 ----------

test('auto-takeover applies the fastest mirror to host settings', async () => {
  const host = mockHost({
    autoApply: () => true,
    probeStatuses: [200, 200, 200],
    probeDelays: [40, 10, 25],
  });
  const controller = createController(host, TEST_DATA);
  await controller.runTest();

  // 延迟最低的 b.example 被自动写入宿主设置
  assert.deepEqual(host.saves, ['https://b.example']);
  const final = host.states.at(-1);
  assert.equal(final.appliedUrl, 'https://b.example');
  assert.equal(final.applying, false);
  assert.equal(final.applyError, '');
});

test('manual mode ranks mirrors without writing host settings', async () => {
  const host = mockHost({ probeStatuses: [200, 200, 200], probeDelays: [40, 10, 25] });
  const controller = createController(host, TEST_DATA);
  await controller.runTest();

  // 手动模式（autoApply false）：只排名，不调用 applyMirror，也没有落盘类通知
  assert.deepEqual(host.saves, []);
  const final = host.states.at(-1);
  assert.equal(final.selectedUrl, 'https://b.example');
  assert.equal(final.appliedUrl, '');
  assert.equal(final.applying, false);
  assert.deepEqual(host.notifications, []);

  // 手动模式下全部探测失败：文案引导重新检测（托管模式则是“继续使用当前设置”）
  const failing = mockHost({ probeStatuses: ['error', 'error', 'error'] });
  const failingController = createController(failing, TEST_DATA);
  await failingController.runTest();
  assert.deepEqual(failing.saves, []);
  assert.deepEqual(
    failing.notifications.map((n) => /请检查网络后重新检测|继续使用当前设置/.exec(n.message)[0]),
    ['请检查网络后重新检测'],
  );
});

test('failed probes keep the host address and report keeping current settings', async () => {
  const host = mockHost({
    autoApply: () => true,
    probeStatuses: ['error', 'error', 'error'],
  });
  const controller = createController(host, TEST_DATA);
  await controller.runTest();

  assert.deepEqual(host.saves, []);
  const final = host.states.at(-1);
  assert.equal(final.appliedUrl, '');
  assert.equal(final.applying, false);
  assert.deepEqual(
    host.notifications.map((n) => /继续使用当前设置/.test(n.message)),
    [true],
  );
});

test('a failed save surfaces applyError without claiming success', async () => {
  const host = mockHost({ autoApply: () => true });
  host.applyMirror = (url) => {
    host.saves.push(url);
    return Promise.reject(new Error('disk full'));
  };
  const controller = createController(host, TEST_DATA);
  await controller.runTest();

  assert.deepEqual(host.saves, ['https://a.example']);
  const final = host.states.at(-1);
  assert.equal(final.appliedUrl, '');
  assert.match(final.applyError, /disk full/);
  assert.equal(final.applying, false);
  assert.deepEqual(
    host.notifications.map((n) => n.level),
    ['danger'],
  );
});

test('invalidate retires an in-flight round without applying', async () => {
  const host = mockHost({ autoApply: () => true });
  // 门闩 probe：所有探测共用同一放行 promise（各自独立 promise 会漏掉未持柄的探测）
  let releaseProbes;
  const gate = new Promise((resolve) => {
    releaseProbes = resolve;
  });
  host.probe = (url, timeoutMs) => {
    host.probes.push({ url, timeoutMs });
    return gate.then(() => ({ status: 200, elapsedMs: 1 }));
  };
  const controller = createController(host, TEST_DATA);
  const running = controller.runTest();
  controller.invalidate();
  releaseProbes();
  await running;

  // 中止的轮次不得把结果写进宿主设置
  assert.deepEqual(host.saves, []);
  const final = host.states.at(-1);
  assert.equal(final.tested, false);
  assert.equal(final.applying, false);
  assert.equal(final.applyError, '');
});

// ---------- entry.ts：activate 生命周期（接管 + 自动托管开关） ----------

// echo:plugin-sdk 的 awaitOperation 只接受 EchoPluginOperation 形状的对象。
const op = (result) => ({ state: 2, result });
const opReject = (message) => ({
  state: 3,
  result: undefined,
  errorMessage: message,
  errorCode: 'test',
});

function signal() {
  const callbacks = [];
  return {
    connect: (f) => callbacks.push(f),
    emit: () => callbacks.slice().forEach((f) => f()),
  };
}

/** 构造完整 EchoPluginContext 假实现；denied 模拟宿主拒绝 hostSettings 授权。 */
function context({ denied = false, autoTakeover = undefined } = {}) {
  const timers = new Map();
  const contributions = [];
  const saved = [];
  const notices = [];
  const clipboardWrites = [];
  const navigations = [];
  const writes = [];
  const commands = new Map();
  const storage = {
    data: TEST_DATA,
    checkedDate: todayStr(Date.now()),
    autoTakeover,
  };
  const sessionInvalidated = signal();
  let dispose;
  const watch = {
    active: true,
    activeChanged: signal(),
    dispose() {
      if (!this.active) return;
      this.active = false;
      this.activeChanged.emit();
    },
  };
  const ctx = {
    active: true,
    sessionInvalidated,
    io: {
      readValue: (key) => {
        if (key === 'data') return op(storage.data);
        if (key === 'autoTakeover') return op(storage.autoTakeover);
        return op(storage.checkedDate);
      },
      writeValue: (key, value) => {
        writes.push([key, value]);
        if (key === 'data') storage.data = value;
        if (key === 'autoTakeover') storage.autoTakeover = value;
        if (key === 'lastUpdateDate') storage.checkedDate = value;
        return op(undefined);
      },
    },
    settings: {
      observe(id, domain, callback) {
        if (denied) return opReject('denied');
        watch.active = true;
        callback({ githubProxyUrl: 'https://existing.example' });
        return op(watch);
      },
      update(domain, patch) {
        saved.push(patch.githubProxyUrl);
        return op({ githubProxyUrl: patch.githubProxyUrl });
      },
    },
    ui: {
      state: {},
      setState(value) {
        this.state = value;
      },
      registerSettings: () => ({}),
      navigation: {
        navigate: (target) => {
          navigations.push(target);
          return op(undefined);
        },
      },
      parts: {
        contribute(id, selector, definition) {
          const lease = {
            id,
            definition,
            active: true,
            dispose() {
              this.active = false;
            },
          };
          contributions.push(lease);
          return lease;
        },
      },
    },
    net: {
      request: () => op({ status: 200, data: {} }),
    },
    toast: Object.fromEntries(
      ['danger', 'success', 'warning', 'info'].map((k) => [k, (message) => notices.push(message)]),
    ),
    registerCommand: (key, handler) => commands.set(key, handler),
    setTimer: (id, ms, repeat, fn) => {
      timers.set(id, fn);
      return { id };
    },
    onDispose(fn) {
      dispose = fn;
      return {};
    },
    clipboard: {
      write: (value) => {
        clipboardWrites.push(value);
        return op(undefined);
      },
    },
  };
  return {
    ctx,
    commands,
    timers,
    contributions,
    saved,
    notices,
    clipboardWrites,
    navigations,
    writes,
    watch,
    state: () => ctx.ui.state,
    dispose: () => {
      ctx.active = false;
      dispose();
    },
  };
}

async function drain() {
  for (let n = 0; n < 40; ++n) await Promise.resolve();
}

test('first activation defaults to takeover when no preference is stored', async () => {
  const f = context();
  await activate(f.ctx);
  // 授权/接管必须等 activation 提交后才开始：此刻没有网络与 UI 副作用
  assert.equal(f.saved.length, 0);
  assert.equal(f.contributions.length, 0);

  f.timers.get('startup-work')();
  await drain();
  assert.equal(f.state().autoTakeover, true);
  assert.equal(f.state().controlled, true);
  assert.equal(f.contributions.filter((c) => c.active).length, 2);
  // 接管成功后自动测速并应用最快镜像
  assert.deepEqual(f.saved, ['https://a.example']);
  f.dispose();
  assert.equal(f.contributions.filter((c) => c.active).length, 0);
});

test('stored manual preference starts without takeover or probing', async () => {
  const f = context({ autoTakeover: false });
  await activate(f.ctx);
  f.timers.get('startup-work')();
  await drain();

  assert.equal(f.state().autoTakeover, false);
  assert.equal(f.state().controlled, false);
  assert.equal(f.contributions.length, 0);
  assert.equal(f.saved.length, 0);
  // 手动模式启动只刷新镜像列表，不主动测速（面板打开时才测）
  f.dispose();
});

test('denied host permission never hides the original setting or writes an address', async () => {
  const f = context({ denied: true });
  await activate(f.ctx);
  f.timers.get('startup-work')();
  await drain();

  assert.equal(f.saved.length, 0);
  assert.equal(f.contributions.length, 0);
  assert.equal(f.state().controlled, false);
  assert.match(f.notices[0], /无法接管网络设置/);
  f.dispose();
});

test('revocation withdraws the hint and restores the host field', async () => {
  const f = context();
  await activate(f.ctx);
  f.timers.get('startup-work')();
  await drain();
  assert.equal(f.state().controlled, true);

  f.watch.dispose();
  assert.equal(f.state().controlled, false);
  assert.equal(f.contributions.filter((c) => c.active).length, 0);
  f.dispose();
});

test('toggling auto-takeover off withdraws takeover and persists the preference', async () => {
  const f = context();
  await activate(f.ctx);
  f.timers.get('startup-work')();
  await drain();
  assert.equal(f.contributions.filter((c) => c.active).length, 2);

  await f.commands.get('accelerate.auto')({ enabled: false });
  // 偏好落盘；接管提示撤回、宿主输入框恢复，已写入的地址保留
  assert.deepEqual(f.writes.at(-1), ['autoTakeover', false]);
  assert.equal(f.contributions.filter((c) => c.active).length, 0);
  assert.equal(f.state().controlled, false);
  assert.equal(f.state().autoTakeover, false);
  assert.equal(f.saved.length, 1);
  f.dispose();
});

test('manual mode re-test ranks without writing host settings', async () => {
  const f = context({ autoTakeover: false });
  await activate(f.ctx);
  f.timers.get('startup-work')();
  await drain();

  await f.commands.get('accelerate.test')();
  await drain();
  // 手动模式：测速只排名，不写宿主设置
  assert.equal(f.saved.length, 0);
  assert.equal(f.state().tested, true);
  assert.equal(f.state().ranked.length, 3);
  f.dispose();
});

test('toggling auto-takeover back on restarts the takeover flow', async () => {
  const f = context({ autoTakeover: false });
  await activate(f.ctx);
  f.timers.get('startup-work')();
  await drain();
  assert.equal(f.state().controlled, false);

  await f.commands.get('accelerate.auto')({ enabled: true });
  await drain();
  assert.deepEqual(f.writes.at(-1), ['autoTakeover', true]);
  assert.equal(f.state().controlled, true);
  assert.equal(f.contributions.filter((c) => c.active).length, 2);
  f.dispose();
});

test('manual mode opens host settings with a fallback copy of the top mirror', async () => {
  const f = context({ autoTakeover: false });
  await activate(f.ctx);
  f.timers.get('startup-work')();
  await drain();
  await f.commands.get('accelerate.test')();
  await drain();
  const top = f.state().selectedUrl;
  assert.notEqual(top, '');

  // 未手动复制过：跳转前兜底复制推荐地址
  await f.commands.get('accelerate.open')();
  assert.deepEqual(f.clipboardWrites, [top]);
  assert.deepEqual(f.navigations, [{ name: 'settings', query: { section: 'network' } }]);

  // 行内复制成功后再跳转：不再重复兜底复制（剪贴板只多了显式复制那一次）
  await f.commands.get('accelerate.copy')({ url: top });
  await f.commands.get('accelerate.open')();
  assert.deepEqual(f.clipboardWrites, [top, top]);
  assert.equal(f.navigations.length, 2);
  f.dispose();
});

test('taken-over mode navigates without touching the clipboard', async () => {
  const f = context();
  await activate(f.ctx);
  f.timers.get('startup-work')();
  await drain();
  assert.equal(f.state().controlled, true);

  await f.commands.get('accelerate.open')();
  assert.deepEqual(f.clipboardWrites, []);
  assert.equal(f.navigations.length, 1);
  f.dispose();
});

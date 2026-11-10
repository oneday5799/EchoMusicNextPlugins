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
  const storage = { data: undefined, checkedDate: undefined };
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
    publish: (state) => states.push(state),
    notify: (level, message) => notifications.push({ level, message }),
    // 测试观察句柄
    states,
    probes,
    notifications,
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
  // 仍标记今日已检查，明天再试
  assert.equal(host.storage.checkedDate, todayStr(host.now()));
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

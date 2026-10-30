import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import {
  h5Token,
  md5Hex,
  signatureWebParams,
  signatureWebParamsWithBody,
} from '../plugins/auto-team-vip/src/crypto.ts';
import {
  buildTeamRequest,
  classifyJoinError,
  classifyPeriodFailure,
  needsCaptcha,
  normalizePeriod,
  normalizeTeamInfo,
  parseAuthHeader,
  parseJoinResponse,
} from '../plugins/auto-team-vip/src/kugou.ts';
import {
  buildPoolDiag,
  createBackoff,
  isCfChallenge,
  isCfEdgeError,
  normalizePoolResponse,
  poolAvailable,
  poolDown,
  poolEmptyBackoffStart,
  poolRateLimited,
} from '../plugins/auto-team-vip/src/pool.ts';
import {
  buildErrorDetail,
  createPanelState,
  createRunner,
  HEARTBEAT_TICK_MS,
  MIN_RUN_INTERVAL_MS,
} from '../plugins/auto-team-vip/src/runner.ts';

const LITE_PEM =
  '-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDECi0Np2UR87scwrvTr72L6oO01rBbbBPriSDFPxr3Z5syug0O24QyQO8bg27+0+4kBzTBTBOZ/WWU0WryL1JSXRTXLgFVxtzIY41Pe7lPOgsfTCn5kZcvKhYKJesKnnJDNr5/abvTGf+rHG3YRwsCHcQ08/q6ifSioBszvb3QiwIDAQAB\n-----END PUBLIC KEY-----';
const AUTH_HEADER =
  'token=REALTOKEN;userid=12345;t1=t1value;dfid=DFID1;KUGOU_API_MID=MID1;uuid=UUID1;KUGOU_API_GUID=GUID1;KUGOU_API_DEV=DEV1;KUGOU_API_MAC=MAC1';

// ---------- 加密与签名 ----------

test('md5 matches node crypto for empty, ascii, utf8 and long inputs', () => {
  assert.equal(md5Hex(''), crypto.createHash('md5').update('').digest('hex'));
  assert.equal(md5Hex('abc'), '900150983cd24fb0d6963f7d28e17f72');
  const utf8 = '签名测试NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
  assert.equal(md5Hex(utf8), crypto.createHash('md5').update(utf8, 'utf8').digest('hex'));
  const long = 'x'.repeat(4096);
  assert.equal(md5Hex(long), crypto.createHash('md5').update(long).digest('hex'));
});

test('h5 token reproduces the legacy RSA NO_PADDING derivation', () => {
  const token = h5Token('TESTTOKEN123');
  assert.ok(token.startsWith('h5'));
  const message = Buffer.alloc(128);
  Buffer.from('moc.uoguk.59::TESTTOKEN123', 'utf8').copy(message);
  const expected = crypto
    .publicEncrypt({ key: LITE_PEM, padding: crypto.constants.RSA_NO_PADDING }, message)
    .toString('hex')
    .toUpperCase();
  assert.equal(token.slice(2), expected);
});

test('gateway signatures match the legacy salt/body recipe', () => {
  const params = {
    srcappid: 2919,
    clientver: 11440,
    clienttime: 1700000000000,
    mid: 'MID1',
    uuid: 'UUID1',
    dfid: 'DFID1',
    appid: 3116,
    userid: 12345,
    token: 'H5HEX',
  };
  const salt = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('');
  assert.equal(
    signatureWebParams(params),
    crypto
      .createHash('md5')
      .update(salt + sorted + salt)
      .digest('hex'),
  );
  assert.equal(
    signatureWebParamsWithBody(params, '{"period_id":"a1"}'),
    crypto
      .createHash('md5')
      .update(salt + sorted + '{"period_id":"a1"}' + salt)
      .digest('hex'),
  );
});

// ---------- 鉴权头解析 ----------

test('parseAuthHeader keeps every legacy identity field', () => {
  const auth = parseAuthHeader(AUTH_HEADER);
  assert.ok(auth);
  assert.deepEqual(auth, {
    token: 'REALTOKEN',
    userid: '12345',
    t1: 't1value',
    dfid: 'DFID1',
    mid: 'MID1',
    uuid: 'UUID1',
    guid: 'GUID1',
    serverDev: 'DEV1',
    mac: 'MAC1',
  });
});

test('parseAuthHeader rejects headers without token or userid', () => {
  assert.equal(parseAuthHeader('t1=only'), null);
  assert.equal(parseAuthHeader('token=x'), null);
  assert.equal(parseAuthHeader(''), null);
});

// ---------- 网关请求构造 ----------

test('buildTeamRequest signs GET and POST payloads like the legacy modules', () => {
  const auth = parseAuthHeader(AUTH_HEADER);
  const get = buildTeamRequest(auth, 'get_my_team_info', { periodId: 'a1' });
  assert.equal(get.method, 'GET');
  assert.equal(get.url, 'https://gateway.kugou.com/youth/v1/ut/get_my_team_info');
  assert.equal(get.query.period_id, 'a1');
  assert.equal(get.query.mid, 'MID1');
  assert.ok(get.query.token.startsWith('h5'));
  assert.ok(get.query.signature);
  assert.ok(get.headers['kg-rc']);

  const post = buildTeamRequest(auth, 'join_team', { teamCode: 'CODE7' });
  assert.equal(post.method, 'POST');
  assert.deepEqual(JSON.parse(post.body), { team_code: 'CODE7' });
  assert.notEqual(post.query.signature, get.query.signature);
});

// ---------- 响应解析 ----------

test('normalizePeriod reads the current period and active flag', () => {
  const period = normalizePeriod({
    data: {
      current_period_info: {
        id: 'a2',
        name: '第2期',
        status: 0,
        start_time: '2026-10-01',
        end_time: '2026-10-31',
        team_member_count: 3,
      },
    },
  });
  assert.equal(period.periodId, 'a2');
  assert.equal(period.active, true);
  assert.equal(period.totalMembers, 3);

  const inactive = normalizePeriod({ data: { current_period_info: { id: 'a2', status: 1 } } });
  assert.equal(inactive.active, false);
});

test('normalizeTeamInfo distinguishes an empty join list from a missing one', () => {
  const empty = normalizeTeamInfo({ data: { my_create_team_list: [], my_join_team_list: [] } });
  assert.equal(empty.created, null);
  assert.equal(empty.joined, null);
  assert.equal(empty.joinedChecked, true);

  const missing = normalizeTeamInfo({ data: { my_create_team_list: [] } });
  assert.equal(missing.joinedChecked, false);

  const joined = normalizeTeamInfo({
    data: {
      my_join_team_list: [
        {
          team_code: 'JOIN1',
          member_count: 2,
          vip_desc: '1天VIP',
          member_list: [{ userid: '9', nick_name: '队友', role: 1, vip_desc: '1天' }],
        },
      ],
    },
  });
  // 成员名单长度优先于 member_count（旧插件行为）
  assert.equal(joined.joined.code, 'JOIN1');
  assert.equal(joined.joined.memberCount, 1);
  assert.equal(joined.joined.members.length, 1);
  assert.equal(joined.joined.members[0].role, 1);

  const counted = normalizeTeamInfo({
    data: { my_join_team_list: [{ team_code: 'JOIN2', member_count: 2 }] },
  });
  assert.equal(counted.joined.memberCount, 2);
});

test('classifyJoinError separates terminal kinds from transient noise', () => {
  assert.equal(classifyJoinError({ error_code: 143004 }).kind, 'full');
  assert.equal(classifyJoinError({ error_code: 143010 }).kind, 'already_joined');
  assert.equal(
    classifyJoinError({ error_code: 143005, error_msg: '每台设备只能加入一个队伍~~' }).kind,
    'already_joined',
  );
  assert.equal(classifyJoinError({ error_code: 143001, error_msg: '队伍不存在' }).kind, 'invalid');
  assert.equal(classifyJoinError({ error_msg: '队伍已满' }).kind, 'full');
  assert.equal(classifyJoinError({ error_msg: '未知故障' }).kind, 'transient');
});

test('parseJoinResponse fails closed without an explicit success status', () => {
  assert.equal(
    parseJoinResponse({ ok: true, status: 200, body: { status: 1, error_code: 0 }, headers: {} })
      .bizOk,
    true,
  );
  assert.equal(
    parseJoinResponse({ ok: true, status: 200, body: { status: 1 }, headers: {} }).bizOk,
    true,
  );
  assert.equal(parseJoinResponse({ ok: true, status: 200, body: {}, headers: {} }).bizOk, false);
  assert.equal(parseJoinResponse({ ok: true, status: 200, body: null, headers: {} }).bizOk, false);
  assert.equal(
    parseJoinResponse({
      ok: true,
      status: 502,
      body: { error_code: 143001, status: 0 },
      headers: {},
    }).bizOk,
    false,
  );
});

test('needsCaptcha honors 20028 and skips known terminal codes', () => {
  assert.equal(
    needsCaptcha({
      ok: true,
      status: 200,
      body: { ssaCode: 'EV1', status: 0, error_code: 20028 },
      headers: {},
    }),
    'EV1',
  );
  assert.equal(
    needsCaptcha({
      ok: true,
      status: 200,
      body: { status: 0, error_code: 143004 },
      headers: { 'ssa-code': 'EV2' },
    }),
    '',
  );
  assert.equal(
    needsCaptcha({ ok: true, status: 200, body: { status: 0 }, headers: { 'SSA-CODE': 'EV3' } }),
    'EV3',
  );
});

test('classifyPeriodFailure separates transport, http, business and missing period', () => {
  assert.equal(
    classifyPeriodFailure({ ok: false, status: 0, body: null, headers: {} }).code,
    'period_transport',
  );
  assert.equal(
    classifyPeriodFailure({ ok: true, status: 502, body: {}, headers: {} }).code,
    'period_http_error',
  );
  assert.equal(
    classifyPeriodFailure({
      ok: true,
      status: 200,
      body: { status: 0, error_code: 7 },
      headers: {},
    }).code,
    'period_biz_error',
  );
  assert.equal(
    classifyPeriodFailure({ ok: true, status: 200, body: { status: 1, data: {} }, headers: {} })
      .code,
    'no_period',
  );
});

// ---------- 码池侧 ----------

test('cloudflare challenge and edge errors are recognized without misreading worker bodies', () => {
  const challenge = {
    status: 403,
    data: '<html>Attention Required! | Cloudflare</html>',
    headers: { 'cf-ray': 'r1-SIN' },
  };
  assert.equal(isCfChallenge(challenge), true);
  assert.equal(isCfEdgeError(challenge), false);

  const workerError = { status: 404, data: { ok: false, error: 'lease_not_found' }, headers: {} };
  assert.equal(isCfEdgeError(workerError), false);

  const edge = { status: 404, data: { error_code: 1042, cloudflare_error: true }, headers: {} };
  assert.equal(isCfEdgeError(edge), true);
});

test('normalizePoolResponse flags version gating and attaches challenge traces', () => {
  const mismatch = normalizePoolResponse({
    status: 403,
    data: { ok: false, error: 'version_mismatch', message: '请更新' },
    headers: {},
  });
  assert.equal(mismatch.needUpdate, true);

  const challenged = normalizePoolResponse({
    status: 403,
    data: '<html>Just a moment...</html>',
    headers: { 'CF-RAY': 'abc-SIN' },
  });
  assert.equal(challenged.cfChallenge, true);
  assert.equal(challenged.cfRay, 'abc-SIN');
});

test('pool backoff ladder, transport short backoff and rate limit share one window', () => {
  const backoff = createBackoff();
  assert.equal(poolAvailable(backoff, 1000), true);
  poolDown(backoff, 1000);
  assert.equal(backoff.step, 1);
  assert.equal(backoff.nextAttemptAt, 1000 + 5 * 60_000);
  poolDown(backoff, 1000 + 5 * 60_000);
  assert.equal(backoff.nextAttemptAt, 1000 + 5 * 60_000 + 15 * 60_000);
  // 传输层失败只给 60s 短退避，且在阶梯之上取较晚者
  poolDown(backoff, 1000 + 6 * 60_000, true);
  assert.equal(backoff.nextAttemptAt, 1000 + 6 * 60_000 + 60_000);
  poolRateLimited(backoff, 1000 + 6 * 60_000);
  assert.equal(backoff.nextAttemptAt, 1000 + 6 * 60_000 + 60_000);
  assert.equal(backoff.step, 2);
});

test('pool-empty backoff escalates 20/30/60 and ignores overlaps while active', () => {
  const empty = createBackoff();
  poolEmptyBackoffStart(empty, 0);
  assert.equal(empty.nextAttemptAt, 20 * 60_000);
  poolEmptyBackoffStart(empty, 60_000); // 窗口内不加档
  assert.equal(empty.step, 1);
  assert.equal(empty.nextAttemptAt, 20 * 60_000);
  poolEmptyBackoffStart(empty, 21 * 60_000);
  assert.equal(empty.nextAttemptAt, 21 * 60_000 + 30 * 60_000);
  assert.equal(empty.step, 2);
});

test('buildPoolDiag keeps the ray id in front of a truncated body', () => {
  const diag = buildPoolDiag('/v2/join', {
    ok: false,
    status: 403,
    data: '<html>' + 'y'.repeat(2000) + '</html>',
    error: 'challenge',
    cfRay: 'RAY1',
    cfMitigated: 'challenge',
    headers: {},
  });
  assert.equal(diag.cfRay, 'RAY1');
  assert.ok(String(diag.body).includes('…(已截断)'));
  assert.equal(diag.httpStatus, 403);
});

// ---------- Runner 状态机 ----------

function periodBody(active = true) {
  return {
    status: 1,
    error_code: 0,
    data: {
      current_period_info: {
        id: 'a1',
        name: '第1期',
        status: active ? 0 : 1,
        start_time: '10-01',
        end_time: '10-31',
        team_member_count: 3,
      },
    },
  };
}

function teamInfoBody(created, joinedList) {
  return {
    status: 1,
    error_code: 0,
    data: {
      my_create_team_list: created ? [created] : [],
      my_join_team_list: joinedList || [],
    },
  };
}

function mockServices(overrides = {}) {
  const state = createPanelState();
  const store = { poolTokens: {}, poolAuthDisabled: {}, settings: {} };
  const calls = { gateway: [], pool: [], toasts: [] };
  let clock = 1_000_000;
  let authHeader = overrides.authHeader === undefined ? AUTH_HEADER : overrides.authHeader;
  let autoEnabled = overrides.autoEnabled ?? true;
  let panelOpen = overrides.panelOpen ?? false;
  const gatewayRoutes = overrides.gatewayRoutes ?? {};
  const poolRoutes = overrides.poolRoutes ?? {};
  let verifyCalls = 0;

  const services = {
    now: () => clock,
    active: () => true,
    log() {},
    toastWarning(message) {
      calls.toasts.push(message);
    },
    sleep(ms) {
      clock += ms;
      return Promise.resolve();
    },
    async readValue(key) {
      return store[key];
    },
    async writeValue(key, value) {
      store[key] = value;
    },
    auth: () => (authHeader ? parseAuthHeader(authHeader) : null),
    loggedIn: () => Boolean(authHeader),
    async gatewaySend(request) {
      calls.gateway.push(request);
      const route = gatewayRoutes[new URL(request.url).pathname];
      if (route) return route(request);
      return { ok: true, status: 200, body: {}, headers: {} };
    },
    async verifyCaptcha(eventId) {
      verifyCalls += 1;
      if (overrides.verifyCaptcha) return overrides.verifyCaptcha(eventId);
      return true;
    },
    async poolSend(path, payload) {
      calls.pool.push({ path, payload });
      const route = poolRoutes[path];
      if (route) return route(payload);
      return { ok: true, status: 200, data: {}, headers: {} };
    },
    publish() {},
    state,
    get autoEnabled() {
      return autoEnabled;
    },
    get panelOpen() {
      return panelOpen;
    },
  };
  return {
    services,
    state,
    calls,
    store,
    clock: () => clock,
    advance(ms) {
      clock += ms;
    },
    setAuth(value) {
      authHeader = value;
    },
    setAuto(value) {
      autoEnabled = value;
    },
    setPanelOpen(value) {
      panelOpen = value;
    },
    verifyCalls: () => verifyCalls,
  };
}

test('manual mode never touches the pool and only refreshes kugou state', async () => {
  const m = mockServices({
    autoEnabled: false,
    gatewayRoutes: {
      '/youth/v1/ut/get_period_info': () => ({
        ok: true,
        status: 200,
        body: periodBody(),
        headers: {},
      }),
      '/youth/v1/ut/get_my_team_info': () => ({
        ok: true,
        status: 200,
        body: teamInfoBody({ team_code: 'MINE', member_count: 1 }, [
          { team_code: 'OTHERS', member_count: 2 },
        ]),
        headers: {},
      }),
    },
  });
  const runner = createRunner(m.services);
  await runner.requestRun('startup', { force: true });
  assert.deepEqual(
    m.calls.pool.map((call) => call.path),
    [],
  );
  assert.equal(m.state.myCode, 'MINE');
  assert.equal(m.state.joined, true);
  assert.equal(m.state.lastError, null);
});

test('a full successful flow creates a team, joins via lease and confirms with a snapshot', async () => {
  let createdTeam = false;
  let joinedCode = '';
  const m = mockServices({
    gatewayRoutes: {
      '/youth/v1/ut/get_period_info': () => ({
        ok: true,
        status: 200,
        body: periodBody(),
        headers: {},
      }),
      '/youth/v1/ut/get_my_team_info': () => ({
        ok: true,
        status: 200,
        body: teamInfoBody(
          createdTeam
            ? { team_code: 'MINE', member_count: 1, member_list: [{ userid: '12345', role: 1 }] }
            : null,
          joinedCode ? [{ team_code: joinedCode, member_count: 2 }] : [],
        ),
        headers: {},
      }),
      '/youth/v1/ut/create_team': () => {
        createdTeam = true;
        return { ok: true, status: 200, body: { status: 1, error_code: 0 }, headers: {} };
      },
      '/youth/v1/ut/join_team': () => {
        joinedCode = 'JOINCODE';
        return { ok: true, status: 200, body: { status: 1, error_code: 0 }, headers: {} };
      },
    },
    poolRoutes: {
      '/v2/snapshot': () => ({
        ok: true,
        status: 200,
        data: { ok: true, token: 'POOL-TOKEN' },
        headers: {},
      }),
      '/v2/join': () => ({
        ok: true,
        status: 200,
        data: { ok: true, lease_id: 'L1', code: 'JOINCODE' },
        headers: {},
      }),
      '/v2/join/result': () => ({ ok: true, status: 200, data: { ok: true }, headers: {} }),
    },
  });
  const runner = createRunner(m.services);
  await runner.requestRun('startup', { force: true });

  const paths = m.calls.pool.map((call) => call.path);
  assert.deepEqual(paths, ['/v2/snapshot', '/v2/join', '/v2/join/result', '/v2/snapshot']);
  assert.deepEqual(m.calls.pool[1].payload.exclude_codes, []);
  const report = m.calls.pool[2].payload;
  assert.equal(report.lease_id, 'L1');
  assert.equal(report.result, 'success');
  const confirmSnapshot = m.calls.pool[3].payload;
  assert.equal(confirmSnapshot.joined.code, 'JOINCODE');
  assert.equal(confirmSnapshot.token, 'POOL-TOKEN');
  assert.equal(m.store.poolTokens['12345'], 'POOL-TOKEN');
  assert.equal(m.state.joined, true);
  assert.equal(m.state.joinedCode, 'JOINCODE');
  assert.equal(m.state.myCode, 'MINE');
  assert.equal(m.state.lastError, null);
  // 建队请求确实发生过
  assert.ok(m.calls.gateway.some((call) => call.url.endsWith('/create_team')));
});

test('a captcha-protected join is verified through the host and retried once', async () => {
  let joinAttempts = 0;
  const m = mockServices({
    gatewayRoutes: {
      '/youth/v1/ut/get_period_info': () => ({
        ok: true,
        status: 200,
        body: periodBody(),
        headers: {},
      }),
      '/youth/v1/ut/get_my_team_info': () => ({
        ok: true,
        status: 200,
        body: teamInfoBody(
          { team_code: 'MINE', member_count: 1 },
          joinAttempts >= 2 ? [{ team_code: 'JOINCODE', member_count: 2 }] : [],
        ),
        headers: {},
      }),
      '/youth/v1/ut/join_team': () => {
        joinAttempts += 1;
        if (joinAttempts === 1)
          return {
            ok: true,
            status: 200,
            body: { status: 0, error_code: 20028, ssaCode: 'EV-1' },
            headers: {},
          };
        return { ok: true, status: 200, body: { status: 1, error_code: 0 }, headers: {} };
      },
    },
    poolRoutes: {
      '/v2/snapshot': () => ({ ok: true, status: 200, data: { ok: true }, headers: {} }),
      '/v2/join': () => ({
        ok: true,
        status: 200,
        data: { ok: true, lease_id: 'L1', code: 'JOINCODE' },
        headers: {},
      }),
      '/v2/join/result': () => ({ ok: true, status: 200, data: { ok: true }, headers: {} }),
    },
  });
  const runner = createRunner(m.services);
  await runner.requestRun('startup', { force: true });
  assert.equal(m.verifyCalls(), 1);
  assert.equal(joinAttempts, 2);
  assert.equal(m.state.joined, true);
});

test('a full pool answers pool_empty and arms the empty backoff', async () => {
  const m = mockServices({
    gatewayRoutes: {
      '/youth/v1/ut/get_period_info': () => ({
        ok: true,
        status: 200,
        body: periodBody(),
        headers: {},
      }),
      '/youth/v1/ut/get_my_team_info': () => ({
        ok: true,
        status: 200,
        body: teamInfoBody({ team_code: 'MINE', member_count: 1 }),
        headers: {},
      }),
    },
    poolRoutes: {
      '/v2/snapshot': () => ({ ok: true, status: 200, data: { ok: true }, headers: {} }),
      '/v2/join': () => ({
        ok: true,
        status: 200,
        data: { ok: true, reason: 'pool_empty' },
        headers: {},
      }),
    },
  });
  const runner = createRunner(m.services);
  await runner.requestRun('startup', { force: true });
  assert.equal(m.state.lastError.code, 'pool_empty');
  assert.equal(runner.poolEmptyBackoff.step, 1);
  assert.equal(runner.poolEmptyBackoff.nextAttemptAt, m.clock() + 20 * 60_000);
});

test('full/invalid join failures exclude the code and retry within the round', async () => {
  let joinAttempts = 0;
  const m = mockServices({
    gatewayRoutes: {
      '/youth/v1/ut/get_period_info': () => ({
        ok: true,
        status: 200,
        body: periodBody(),
        headers: {},
      }),
      '/youth/v1/ut/get_my_team_info': () => ({
        ok: true,
        status: 200,
        body: teamInfoBody(
          { team_code: 'MINE', member_count: 1 },
          joinAttempts >= 2 ? [{ team_code: 'C1', member_count: 2 }] : [],
        ),
        headers: {},
      }),
      '/youth/v1/ut/join_team': () => {
        joinAttempts += 1;
        if (joinAttempts === 1)
          return {
            ok: true,
            status: 502,
            body: { status: 0, error_code: 143004, error_msg: '队伍已满' },
            headers: {},
          };
        return { ok: true, status: 200, body: { status: 1, error_code: 0 }, headers: {} };
      },
    },
    poolRoutes: {
      '/v2/snapshot': () => ({ ok: true, status: 200, data: { ok: true }, headers: {} }),
      '/v2/join': (payload) => ({
        ok: true,
        status: 200,
        data: {
          ok: true,
          lease_id: 'L' + payload.exclude_codes.length,
          code: 'C' + payload.exclude_codes.length,
        },
        headers: {},
      }),
      '/v2/join/result': () => ({ ok: true, status: 200, data: { ok: true }, headers: {} }),
    },
  });
  const runner = createRunner(m.services);
  await runner.requestRun('startup', { force: true });
  const joinCalls = m.calls.pool.filter((call) => call.path === '/v2/join');
  assert.equal(joinCalls.length, 2);
  assert.deepEqual(joinCalls[1].payload.exclude_codes, ['C0']);
  const failedReport = m.calls.pool.find((call) => call.path === '/v2/join/result');
  assert.equal(failedReport.payload.result, 'failed');
  assert.equal(failedReport.payload.error_kind, 'full');
  assert.equal(m.state.joined, true);
});

test('a device-bound 143005 with no visible team stops with a plain-language error', async () => {
  const m = mockServices({
    gatewayRoutes: {
      '/youth/v1/ut/get_period_info': () => ({
        ok: true,
        status: 200,
        body: periodBody(),
        headers: {},
      }),
      '/youth/v1/ut/get_my_team_info': () => ({
        ok: true,
        status: 200,
        body: teamInfoBody(null, []),
        headers: {},
      }),
      '/youth/v1/ut/join_team': () => ({
        ok: true,
        status: 502,
        body: { status: 0, error_code: 143005, error_msg: '每台设备只能加入一个队伍~~' },
        headers: {},
      }),
    },
    poolRoutes: {
      '/v2/snapshot': () => ({ ok: true, status: 200, data: { ok: true }, headers: {} }),
      '/v2/join': () => ({
        ok: true,
        status: 200,
        data: { ok: true, lease_id: 'L1', code: 'JOINCODE' },
        headers: {},
      }),
      '/v2/join/result': () => ({ ok: true, status: 200, data: { ok: true }, headers: {} }),
    },
  });
  const runner = createRunner(m.services);
  await runner.requestRun('startup', { force: true });
  assert.equal(m.state.lastError.code, 'device_already_bound');
  assert.equal(m.calls.toasts.length, 1);
  // 设备级终态只提示一次
  await runner.requestRun('retry', { force: true });
  assert.equal(m.calls.toasts.length, 1);
});

test('transient pool failures retry once on every pool call, not just join', async () => {
  let snapshotCalls = 0;
  let resultCalls = 0;
  let joined = false;
  const m = mockServices({
    gatewayRoutes: {
      '/youth/v1/ut/get_period_info': () => ({
        ok: true,
        status: 200,
        body: periodBody(),
        headers: {},
      }),
      '/youth/v1/ut/get_my_team_info': () => ({
        ok: true,
        status: 200,
        body: teamInfoBody(
          { team_code: 'MINE', member_count: 1 },
          joined ? [{ team_code: 'JOINCODE', member_count: 2 }] : [],
        ),
        headers: {},
      }),
      '/youth/v1/ut/join_team': () => {
        joined = true;
        return { ok: true, status: 200, body: { status: 1, error_code: 0 }, headers: {} };
      },
    },
    poolRoutes: {
      // 首次 500（服务端瞬时故障），补射一次成功——与旧 poolRequest 语义一致
      '/v2/snapshot': () => {
        snapshotCalls += 1;
        if (snapshotCalls % 2 === 1) return { ok: false, status: 500, data: 'boom', headers: {} };
        return { ok: true, status: 200, data: { ok: true }, headers: {} };
      },
      '/v2/join': () => ({
        ok: true,
        status: 200,
        data: { ok: true, lease_id: 'L1', code: 'JOINCODE' },
        headers: {},
      }),
      '/v2/join/result': () => {
        resultCalls += 1;
        if (resultCalls === 1) return { ok: false, status: 0, data: null, headers: {} };
        return { ok: true, status: 200, data: { ok: true }, headers: {} };
      },
    },
  });
  const runner = createRunner(m.services);
  await runner.requestRun('startup', { force: true });
  const snapshotPathCalls = m.calls.pool.filter((call) => call.path === '/v2/snapshot');
  const resultPathCalls = m.calls.pool.filter((call) => call.path === '/v2/join/result');
  assert.ok(snapshotPathCalls.length >= 4); // 首轮快照(2) + 入队成功确认快照(2)
  assert.ok(resultPathCalls.length >= 2); // 失败补射 + 成功回报
  assert.equal(m.state.joined, true);
});

test('the snapshot reports the creator as captain when kugou omits the field', async () => {
  const m = mockServices({
    gatewayRoutes: {
      '/youth/v1/ut/get_period_info': () => ({
        ok: true,
        status: 200,
        body: periodBody(),
        headers: {},
      }),
      '/youth/v1/ut/get_my_team_info': () => ({
        ok: true,
        status: 200,
        body: teamInfoBody({ team_code: 'MINE', member_count: 1 }),
        headers: {},
      }),
    },
    poolRoutes: {
      '/v2/snapshot': () => ({ ok: true, status: 200, data: { ok: true }, headers: {} }),
    },
  });
  const runner = createRunner(m.services);
  await runner.requestRun('startup', { force: true });
  const snapshot = m.calls.pool[0];
  assert.equal(snapshot.path, '/v2/snapshot');
  assert.equal(snapshot.payload.created.captain, '12345');
  assert.equal(snapshot.payload.joined, null);
  assert.equal(snapshot.payload.joined_checked, true);
});

test('a 401 from the pool disables the current period permanently', async () => {
  const m = mockServices({
    gatewayRoutes: {
      '/youth/v1/ut/get_period_info': () => ({
        ok: true,
        status: 200,
        body: periodBody(),
        headers: {},
      }),
      '/youth/v1/ut/get_my_team_info': () => ({
        ok: true,
        status: 200,
        body: teamInfoBody({ team_code: 'MINE', member_count: 1 }),
        headers: {},
      }),
    },
    poolRoutes: {
      '/v2/snapshot': () => ({
        ok: false,
        status: 401,
        data: { ok: false, error: 'unauthorized' },
        headers: {},
      }),
    },
  });
  const runner = createRunner(m.services);
  await runner.requestRun('startup', { force: true });
  assert.equal(m.state.poolDisabled, true);
  assert.equal(m.state.lastError.code, 'pool_unauthorized');
  assert.equal(m.store.poolAuthDisabled['a1:12345'], true);
  // 下一次流程在快照前直接短路，不再发出任何码池请求
  await runner.requestRun('again', { force: true });
  assert.deepEqual(
    m.calls.pool.map((call) => call.path),
    ['/v2/snapshot'],
  );
});

test('the run merge window collapses triggers inside ten seconds', async () => {
  let periodCalls = 0;
  const m = mockServices({
    gatewayRoutes: {
      '/youth/v1/ut/get_period_info': () => {
        periodCalls += 1;
        return { ok: true, status: 200, body: periodBody(), headers: {} };
      },
      '/youth/v1/ut/get_my_team_info': () => ({
        ok: true,
        status: 200,
        body: teamInfoBody(null),
        headers: {},
      }),
    },
  });
  const runner = createRunner(m.services);
  await runner.requestRun('startup');
  await runner.requestRun('panel_open');
  assert.equal(periodCalls, 1);
  m.advance(MIN_RUN_INTERVAL_MS);
  await runner.requestRun('panel_open');
  assert.equal(periodCalls, 2);
});

test('heartbeat schedules full flows, keepalive snapshots and inactive probes', async () => {
  let joined = false;
  const m = mockServices({
    panelOpen: true,
    autoEnabled: true,
    gatewayRoutes: {
      '/youth/v1/ut/get_period_info': () => ({
        ok: true,
        status: 200,
        body: periodBody(true),
        headers: {},
      }),
      '/youth/v1/ut/get_my_team_info': () => ({
        ok: true,
        status: 200,
        body: teamInfoBody(
          { team_code: 'MINE', member_count: 1 },
          joined ? [{ team_code: 'C1', member_count: 3 }] : [],
        ),
        headers: {},
      }),
      '/youth/v1/ut/join_team': () => {
        joined = true;
        return { ok: true, status: 200, body: { status: 1, error_code: 0 }, headers: {} };
      },
    },
    poolRoutes: {
      '/v2/snapshot': () => ({ ok: true, status: 200, data: { ok: true }, headers: {} }),
      '/v2/join': () => ({
        ok: true,
        status: 200,
        data: { ok: true, lease_id: 'L1', code: 'C1' },
        headers: {},
      }),
      '/v2/join/result': () => ({ ok: true, status: 200, data: { ok: true }, headers: {} }),
    },
  });
  const runner = createRunner(m.services);
  await runner.requestRun('startup', { force: true });
  assert.equal(m.state.joined, true); // 首轮完整流程即入队
  const paths = () => m.calls.pool.map((call) => call.path);
  const joins = () => paths().filter((path) => path === '/v2/join').length;

  // 已入队 + 面板打开：心跳只做 5 分钟保活快照，不再发起 join
  m.calls.pool.length = 0;
  m.advance(5 * 60_000);
  runner.heartbeatTick();
  await runner.idle();
  assert.deepEqual(paths(), ['/v2/snapshot']);

  // 面板关闭 + 已入队：保活间隔放宽到 30 分钟，5 分钟时不应有请求
  m.calls.pool.length = 0;
  m.setPanelOpen(false);
  m.advance(5 * 60_000);
  runner.heartbeatTick();
  await runner.idle();
  assert.deepEqual(paths(), []);
  m.advance(25 * 60_000);
  runner.heartbeatTick();
  await runner.idle();
  assert.deepEqual(paths(), ['/v2/snapshot']);
  assert.equal(joins(), 0);

  // 期次未开启：30 分钟低频探测，下一期自动开始
  const inactive = mockServices({
    gatewayRoutes: {
      '/youth/v1/ut/get_period_info': () => ({
        ok: true,
        status: 200,
        body: periodBody(false),
        headers: {},
      }),
    },
  });
  const inactiveRunner = createRunner(inactive.services);
  await inactiveRunner.requestRun('startup', { force: true });
  assert.equal(inactive.calls.gateway.length, 1);
  inactive.advance(29 * 60_000);
  inactiveRunner.heartbeatTick();
  await inactiveRunner.idle();
  assert.equal(inactive.calls.gateway.length, 2);
  inactive.advance(2 * 60_000);
  inactiveRunner.heartbeatTick();
  await inactiveRunner.idle();
  assert.equal(inactive.calls.gateway.length, 2); // 距上次探测仅 2 分钟
  inactive.advance(28 * 60_000);
  inactiveRunner.heartbeatTick();
  await inactiveRunner.idle();
  assert.equal(inactive.calls.gateway.length, 3);
});

test('account change clears the captured state without crashing the chain', async () => {
  const m = mockServices({
    gatewayRoutes: {
      '/youth/v1/ut/get_period_info': () => ({
        ok: true,
        status: 200,
        body: periodBody(),
        headers: {},
      }),
      '/youth/v1/ut/get_my_team_info': () => ({
        ok: true,
        status: 200,
        body: teamInfoBody({ team_code: 'MINE', member_count: 1 }),
        headers: {},
      }),
    },
    poolRoutes: {
      '/v2/snapshot': () => ({ ok: true, status: 200, data: { ok: true }, headers: {} }),
    },
  });
  const runner = createRunner(m.services);
  await runner.requestRun('startup', { force: true });
  m.setAuth(null);
  runner.resetForAccountChange();
  assert.equal(m.state.myCode, '');
  assert.equal(m.state.periodId, '');
  await runner.requestRun('after_change', { force: true });
  assert.equal(m.state.lastError.code, 'not_logged_in');
});

test('manual join reports failures verbatim and success refreshes once', async () => {
  let joined = false;
  const m = mockServices({
    gatewayRoutes: {
      '/youth/v1/ut/get_period_info': () => ({
        ok: true,
        status: 200,
        body: periodBody(),
        headers: {},
      }),
      '/youth/v1/ut/get_my_team_info': () => ({
        ok: true,
        status: 200,
        body: teamInfoBody(null, joined ? [{ team_code: 'TARGET', member_count: 1 }] : []),
        headers: {},
      }),
      '/youth/v1/ut/join_team': () => {
        if (!joined)
          return { ok: true, status: 200, body: { status: 1, error_code: 0 }, headers: {} };
        return { ok: true, status: 200, body: { status: 1, error_code: 0 }, headers: {} };
      },
    },
  });
  const runner = createRunner(m.services);
  const ok = await runner.manualJoin('TARGET');
  assert.equal(ok.ok, true);
  assert.equal(ok.message, '已提交加入');
  joined = true;

  const failing = mockServices({
    gatewayRoutes: {
      '/youth/v1/ut/join_team': () => ({
        ok: true,
        status: 502,
        body: { status: 0, error_code: 143001, error_msg: '队伍不存在' },
        headers: {},
      }),
    },
  });
  const failingRunner = createRunner(failing.services);
  const bad = await failingRunner.manualJoin('WRONG');
  assert.equal(bad.ok, false);
  assert.equal(bad.message, '队伍不存在');
  assert.equal(failing.state.lastError.code, 'manual_join_failed');
});

test('error detail copies preserve arrays and diagnostics for feedback', () => {
  const detail = buildErrorDetail(
    {
      code: 'join_exhausted',
      message: '加入队伍未成功',
      detail: { attempts: [{ 尝试: 1, 队伍码: 'C1', 类别: 'full' }], httpStatus: 502 },
      at: 1_700_000_000_000,
    },
    1_700_000_000_000,
  );
  assert.ok(detail.includes('错误码: join_exhausted'));
  assert.ok(detail.includes('#1 {"尝试":1,"队伍码":"C1","类别":"full"}'));
});

test('the heartbeat tick stays silent when the panel is closed and auto is off', () => {
  const m = mockServices({ panelOpen: false, autoEnabled: false });
  const runner = createRunner(m.services);
  m.advance(HEARTBEAT_TICK_MS * 100);
  runner.heartbeatTick();
  assert.deepEqual(m.calls.pool, []);
  assert.deepEqual(m.calls.gateway, []);
});

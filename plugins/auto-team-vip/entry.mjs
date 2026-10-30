var __defProp = Object.defineProperty;
var __defProps = Object.defineProperties;
var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __propIsEnum = Object.prototype.propertyIsEnumerable;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __spreadValues = (a, b) => {
  for (var prop in b || (b = {}))
    if (__hasOwnProp.call(b, prop))
      __defNormalProp(a, prop, b[prop]);
  if (__getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(b)) {
      if (__propIsEnum.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    }
  return a;
};
var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

// plugins/auto-team-vip/src/entry.ts
import { awaitOperation } from "echo:plugin-sdk";

// plugins/auto-team-vip/src/crypto.ts
var SIGNATURE_SALT = "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt";
var H5_TOKEN_PREFIX = "moc.uoguk.59::";
var LITE_MODULUS_HEX = "c40a2d0da76511f3bb1cc2bbd3afbd8bea83b4d6b05b6c13eb8920c53f1af7679b32ba0d0edb843240ef1b836efed3ee240734c14c1399fd6594d16af22f52525d14d72e0155c6dcc8638d4f7bb94f3a0b1f4c29f991972f2a160a25eb0a9e724336be7f69bbd319ffab1c6dd8470b021dc434f3faba89f4a2a01b33bdbdd08b";
var LITE_EXPONENT = 65537;
var RSA_BLOCK_BYTES = 128;
function hexToLimbs(hex) {
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  const limbs = [];
  for (let i = bytes.length - 2; i >= 0; i -= 2) {
    limbs.push(bytes[i] << 8 | bytes[i + 1]);
  }
  while (limbs.length > 0 && limbs[limbs.length - 1] === 0) limbs.pop();
  return limbs;
}
var LITE_MODULUS = hexToLimbs(LITE_MODULUS_HEX);
function limbsEqualZero(a) {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== 0) return false;
  return true;
}
function limbsCompare(a, b) {
  const length = Math.max(a.length, b.length);
  for (let i = length - 1; i >= 0; i -= 1) {
    const left = a[i] || 0;
    const right = b[i] || 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}
function limbsSubInPlace(a, b) {
  let borrow = 0;
  for (let i = 0; i < a.length; i += 1) {
    const diff = a[i] - (b[i] || 0) - borrow;
    if (diff < 0) {
      a[i] = diff + 65536;
      borrow = 1;
    } else {
      a[i] = diff;
      borrow = 0;
    }
  }
}
function limbsBitLength(a) {
  for (let i = a.length - 1; i >= 0; i -= 1) {
    if (a[i] !== 0) {
      let bits = i * 16;
      let value = a[i];
      while (value > 0) {
        bits += 1;
        value = Math.floor(value / 2);
      }
      return bits;
    }
  }
  return 0;
}
function limbsShiftLeft(a, bits) {
  const limbShift = Math.floor(bits / 16);
  const bitShift = bits % 16;
  const out = new Array(a.length + limbShift + 1).fill(0);
  for (let i = 0; i < a.length; i += 1) {
    const value = a[i] << bitShift;
    out[i + limbShift] |= value & 65535;
    out[i + limbShift + 1] |= value >>> 16;
  }
  return out;
}
function limbsShiftRightInPlace(a, bits) {
  const limbShift = Math.floor(bits / 16);
  const bitShift = bits % 16;
  for (let i = 0; i < a.length; i += 1) {
    const source = i + limbShift;
    let value = source < a.length ? a[source] >>> bitShift : 0;
    if (bitShift > 0 && source + 1 < a.length) value |= a[source + 1] << 16 - bitShift;
    a[i] = value & 65535;
  }
}
function limbsMod(a, n) {
  if (limbsCompare(a, n) < 0) return a.slice();
  const work = a.slice();
  const shift = limbsBitLength(work) - limbsBitLength(n);
  const shifted = limbsShiftLeft(n, shift);
  for (let s = shift; s >= 0; s -= 1) {
    if (limbsCompare(work, shifted) >= 0) limbsSubInPlace(work, shifted);
    limbsShiftRightInPlace(shifted, 1);
  }
  return work;
}
function limbsMul(a, b) {
  const out = new Array(a.length + b.length).fill(0);
  for (let i = 0; i < a.length; i += 1) {
    let carry = 0;
    for (let j = 0; j < b.length; j += 1) {
      const sum = out[i + j] + a[i] * b[j] + carry;
      out[i + j] = sum & 65535;
      carry = Math.floor(sum / 65536);
    }
    let index = i + b.length;
    while (carry > 0 && index < out.length) {
      const sum = out[index] + carry;
      out[index] = sum & 65535;
      carry = Math.floor(sum / 65536);
      index += 1;
    }
  }
  while (out.length > 0 && out[out.length - 1] === 0) out.pop();
  return out;
}
function limbsMulMod(a, b, n) {
  return limbsMod(limbsMul(a, b), n);
}
function limbsFromBytes(bytes) {
  const limbs = [];
  for (let i = bytes.length - 2; i >= 0; i -= 2) {
    limbs.push(bytes[i] << 8 | bytes[i + 1]);
  }
  if (bytes.length % 2 === 1) limbs.push(bytes[0]);
  while (limbs.length > 0 && limbs[limbs.length - 1] === 0) limbs.pop();
  return limbs;
}
function limbsToBytes(a, length) {
  const bytes = new Array(length).fill(0);
  for (let i = 0; i < a.length && i * 2 < length; i += 1) {
    bytes[length - 2 - i * 2] = a[i] >>> 8 & 255;
    bytes[length - 1 - i * 2] = a[i] & 255;
  }
  return bytes;
}
function limbsExpMod(base, exponent, n) {
  if (limbsEqualZero(n)) return [];
  const bits = [];
  for (let value = exponent; value > 0; value = Math.floor(value / 2)) bits.push(value % 2);
  let result = limbsFromBytes([1]);
  for (let i = bits.length - 1; i >= 0; i -= 1) {
    result = limbsMulMod(result, result, n);
    if (bits[i]) result = limbsMulMod(result, base, n);
  }
  return result;
}
var MD5_SINES = md5Sines();
function md5Sines() {
  const sines = [];
  for (let i = 0; i < 64; i += 1) {
    sines.push(Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296));
  }
  return sines;
}
function rotateLeft(value, bits) {
  return (value << bits | value >>> 32 - bits) >>> 0;
}
function utf8Bytes(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 55296 && code <= 56319 && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 56320 && low <= 57343) {
        code = 65536 + (code - 55296 << 10) + (low - 56320);
        i += 1;
      }
    }
    if (code < 128) bytes.push(code);
    else if (code < 2048) bytes.push(192 | code >> 6, 128 | code & 63);
    else if (code < 65536)
      bytes.push(224 | code >> 12, 128 | code >> 6 & 63, 128 | code & 63);
    else
      bytes.push(
        240 | code >> 18,
        128 | code >> 12 & 63,
        128 | code >> 6 & 63,
        128 | code & 63
      );
  }
  return bytes;
}
var MD5_SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
function md5Hex(text) {
  const message = utf8Bytes(text);
  const bitLength = message.length * 8;
  message.push(128);
  while (message.length % 64 !== 56) message.push(0);
  message.push(
    bitLength & 255,
    bitLength >>> 8 & 255,
    bitLength >>> 16 & 255,
    bitLength >>> 24 & 255
  );
  message.push(0, 0, 0, 0);
  let a0 = 1732584193;
  let b0 = 4023233417;
  let c0 = 2562383102;
  let d0 = 271733878;
  const words = new Array(16).fill(0);
  for (let chunk = 0; chunk < message.length; chunk += 64) {
    for (let i = 0; i < 16; i += 1) {
      const base = chunk + i * 4;
      words[i] = (message[base] | message[base + 1] << 8 | message[base + 2] << 16 | message[base + 3] << 24) >>> 0;
    }
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let f;
      let g;
      if (i < 16) {
        f = b & c | ~b & d;
        g = i;
      } else if (i < 32) {
        f = d & b | ~d & c;
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = 7 * i % 16;
      }
      const sum = a + f + MD5_SINES[i] + words[g] >>> 0;
      a = d;
      d = c;
      c = b;
      b = b + rotateLeft(sum, MD5_SHIFTS[Math.floor(i / 16) * 4 + i % 4]) >>> 0;
    }
    a0 = a0 + a >>> 0;
    b0 = b0 + b >>> 0;
    c0 = c0 + c >>> 0;
    d0 = d0 + d >>> 0;
  }
  return [a0, b0, c0, d0].map(toLittleEndianHex).join("");
}
function byteHex(value) {
  const hex = value.toString(16);
  return value < 16 ? "0" + hex : hex;
}
function toLittleEndianHex(word) {
  let hex = "";
  for (let i = 0; i < 4; i += 1) {
    hex += byteHex(word >>> i * 8 & 255);
  }
  return hex;
}
function rsaNoPadEncryptHex(message) {
  const padded = new Array(RSA_BLOCK_BYTES).fill(0);
  const used = Math.min(message.length, RSA_BLOCK_BYTES);
  for (let i = 0; i < used; i += 1) padded[i] = message[i];
  const result = limbsExpMod(limbsFromBytes(padded), LITE_EXPONENT, LITE_MODULUS);
  const bytes = limbsToBytes(result, RSA_BLOCK_BYTES);
  let hex = "";
  for (const byte of bytes) hex += byteHex(byte);
  return hex.toUpperCase();
}
function h5Token(realToken) {
  return "h5" + rsaNoPadEncryptHex(utf8Bytes(H5_TOKEN_PREFIX + realToken));
}
function sortedParamsString(params) {
  return Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join("");
}
function signatureWebParams(params) {
  return md5Hex(SIGNATURE_SALT + sortedParamsString(params) + SIGNATURE_SALT);
}
function signatureWebParamsWithBody(params, body) {
  return md5Hex(SIGNATURE_SALT + sortedParamsString(params) + body + SIGNATURE_SALT);
}

// plugins/auto-team-vip/src/kugou.ts
var TARGET_MEMBERS = 3;
var GATEWAY_ORIGIN = "https://gateway.kugou.com";
var PROTOCOL_HEADERS = {
  "User-Agent": "Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi",
  "kg-rc": "1",
  "kg-thash": "5d816a0",
  "kg-rec": "1",
  "kg-rf": "B9EDA08A64250DEFFBCADDEE00F8F25F"
};
var APPID = 3116;
var CLIENTVER = 11440;
var SRCAPPID = 2919;
var BIZ_JOIN_CODES = /* @__PURE__ */ new Set([143001, 143004, 143010, 143005, 20006]);
function parseAuthHeader(header) {
  const fields = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    fields[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  if (!fields.token || !fields.userid) return null;
  return {
    token: fields.token,
    userid: fields.userid,
    t1: fields.t1 || "",
    dfid: fields.dfid || "",
    mid: fields.KUGOU_API_MID || fields.mid || "",
    uuid: fields.uuid || "",
    guid: fields.KUGOU_API_GUID || fields.guid || "",
    serverDev: fields.KUGOU_API_DEV || fields.serverDev || "",
    mac: fields.KUGOU_API_MAC || fields.mac || ""
  };
}
function pick(obj, keys, fallback) {
  if (!obj || typeof obj !== "object") return fallback;
  const record = obj;
  for (const key of keys) {
    const value = record[key];
    if (value !== void 0 && value !== null && value !== "") return value;
  }
  return fallback;
}
function asString(value, fallback = "") {
  if (value === void 0 || value === null) return fallback;
  return String(value);
}
function asNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function buildTeamRequest(auth, endpoint, args) {
  const params = {
    srcappid: SRCAPPID,
    clientver: CLIENTVER,
    clienttime: Date.now(),
    mid: auth.mid || "",
    uuid: auth.uuid || "-",
    dfid: auth.dfid || "-",
    appid: APPID,
    userid: Number(auth.userid) || 0,
    token: h5Token(auth.token)
  };
  let method = "GET";
  let body = null;
  if (endpoint === "get_my_team_info") {
    params.period_id = asString(args.periodId);
  } else if (endpoint === "create_team") {
    method = "POST";
    body = JSON.stringify({ period_id: asString(args.periodId) });
  } else if (endpoint === "join_team") {
    method = "POST";
    body = JSON.stringify({ team_code: asString(args.teamCode) });
  }
  const signature = body ? signatureWebParamsWithBody(params, body) : signatureWebParams(params);
  const query = {};
  for (const key of Object.keys(params)) query[key] = String(params[key]);
  query.signature = signature;
  const headers = __spreadValues({}, PROTOCOL_HEADERS);
  headers.dfid = query.dfid;
  headers.clienttime = String(params.clienttime);
  headers.mid = query.mid;
  return {
    url: GATEWAY_ORIGIN + "/youth/v1/ut/" + endpoint,
    method,
    headers,
    query,
    body
  };
}
function normalizePeriod(body) {
  var _a, _b, _c, _d;
  const root = body && typeof body === "object" ? body : {};
  const data = (_a = root.data) != null ? _a : root;
  const current = (_d = (_c = (_b = data.current_period_info) != null ? _b : data.period_info) != null ? _c : data) != null ? _d : {};
  const total = asNumber(
    pick(
      current,
      ["team_member_count", "member_count", "team_num", "target_member", "limit", "need_count"],
      TARGET_MEMBERS
    ),
    TARGET_MEMBERS
  );
  const statusRaw = asNumber(pick(current, ["status"], -1), -1);
  return {
    periodId: asString(pick(current, ["id", "period_id", "periodId", "activity_id"], "")),
    periodName: asString(pick(current, ["name"], "")),
    startTime: asString(pick(current, ["start_time"], "")),
    endTime: asString(pick(current, ["end_time"], "")),
    active: statusRaw === 0,
    totalMembers: total >= TARGET_MEMBERS ? total : TARGET_MEMBERS,
    raw: body
  };
}
function toMembers(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list.slice(0, TARGET_MEMBERS)) {
    const userid = asString(pick(item, ["userid", "user_id"], ""));
    if (!userid) continue;
    out.push({
      userid,
      nick: asString(pick(item, ["nick_name", "nickname", "nick"], "")).slice(0, 48),
      role: asNumber(pick(item, ["role"], 2), 2) === 1 ? 1 : 2,
      reward: asString(pick(item, ["vip_desc", "reward_desc"], "")).slice(0, 48)
    });
  }
  return out;
}
function toTeam(team) {
  if (!team || typeof team !== "object") return null;
  const record = team;
  const code = asString(pick(record, ["team_code", "code", "teamCode"], ""));
  if (!code) return null;
  const listLength = Array.isArray(record.member_list) ? record.member_list.length : 0;
  const count = listLength > 0 ? listLength : asNumber(pick(record, ["member_count", "count", "members_count", "current_count"], 1), 1);
  return {
    code,
    memberCount: Math.min(TARGET_MEMBERS, Math.max(1, Math.round(count) || 1)),
    captain: asString(pick(record, ["captain"], "") || ""),
    members: toMembers(record.member_list),
    vipDesc: asString(pick(record, ["vip_desc"], ""))
  };
}
function normalizeTeamInfo(body) {
  var _a;
  const root = body && typeof body === "object" ? body : {};
  const data = (_a = root.data) != null ? _a : root;
  const createList = Array.isArray(data.my_create_team_list) ? data.my_create_team_list : [];
  const joinListRaw = data.my_join_team_list;
  const joinList = Array.isArray(joinListRaw) ? joinListRaw : [];
  return {
    created: toTeam(createList[0]),
    joined: toTeam(joinList[0]),
    joinedChecked: Array.isArray(joinListRaw),
    raw: data
  };
}
function classifyJoinError(body) {
  const errorCode = asNumber(pick(body, ["error_code", "errcode", "code"], 0), 0);
  const msg = asString(pick(body, ["error_msg", "msg", "message"], "")).toLowerCase();
  let kind = "transient";
  if (errorCode === 143004 || errorCode === 20006 || msg.includes("满") || msg.includes("full"))
    kind = "full";
  else if (errorCode === 143010 || errorCode === 143005 || msg.includes("已加入") || msg.includes("是队伍成员") || msg.includes("已参") || msg.includes("只能加入") || msg.includes("joined"))
    kind = "already_joined";
  else if (errorCode === 143001 || msg.includes("不存在") || msg.includes("无效") || msg.includes("已解散") || msg.includes("组队码错误"))
    kind = "invalid";
  return { kind, errorCode, errorMsg: asString(pick(body, ["error_msg", "msg", "message"], "")) };
}
function parseJoinResponse(response) {
  const body = response.body;
  const isObj = Boolean(body) && typeof body === "object";
  const hasStatus = isObj && body.status !== void 0;
  const bodyStatus = hasStatus ? asNumber(pick(body, ["status"], NaN), NaN) : NaN;
  const hasErrCode = isObj && (body.error_code !== void 0 || body.errcode !== void 0 || body.code !== void 0);
  const errorCode = asNumber(pick(body, ["error_code", "errcode", "code"], 0), 0);
  const errorMsg = asString(pick(body, ["error_msg", "msg", "message"], ""));
  const httpOk = Boolean(response.ok) && response.status > 0 && response.status < 400;
  const bizOk = bodyStatus === 1 && (!hasErrCode || errorCode === 0);
  return { httpOk, bizOk: hasStatus && bizOk, errorCode, errorMsg };
}
function responseHeader(response, name) {
  const target = name.toLowerCase();
  for (const key of Object.keys(response.headers || {})) {
    if (key.toLowerCase() !== target) continue;
    const value = response.headers[key];
    if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : "";
    return String(value != null ? value : "");
  }
  return "";
}
function bodyText(body) {
  if (body === void 0 || body === null) return "";
  try {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return text === void 0 ? String(body) : text;
  } catch (e) {
    return String(body);
  }
}
function truncate(text) {
  return text.length > 1200 ? text.slice(0, 1200) + "…(已截断)" : text;
}
function classifyPeriodFailure(response) {
  const body = response.body;
  const diag = {
    httpStatus: response.status || 0,
    bizStatus: asString(pick(body, ["status"], "")),
    errorCode: asNumber(pick(body, ["error_code", "errcode", "code"], 0), 0),
    errorMsg: asString(pick(body, ["error_msg", "msg", "message"], "")),
    ssaCode: asString(
      pick(body, ["ssaCode", "eventId"], "") || responseHeader(response, "ssa-code")
    ),
    body: truncate(bodyText(body))
  };
  if (!response.ok)
    return {
      code: "period_transport",
      msg: "期次请求发送失败",
      diag: __spreadProps(__spreadValues({}, diag), { transportError: response.error || "" })
    };
  if (diag.httpStatus && (diag.httpStatus < 200 || diag.httpStatus >= 300))
    return { code: "period_http_error", msg: "期次接口返回 HTTP " + diag.httpStatus, diag };
  if (diag.bizStatus !== "" && diag.bizStatus !== "1")
    return {
      code: "period_biz_error",
      msg: "期次接口返回异常（status=" + diag.bizStatus + "）",
      diag
    };
  return { code: "no_period", msg: "未找到活动期次", diag };
}
function needsCaptcha(response) {
  const body = response.body;
  const eventId = asString(
    pick(body, ["ssaCode", "eventId"], "") || responseHeader(response, "ssa-code")
  );
  if (!eventId) return "";
  const errorCode = asNumber(pick(body, ["error_code", "errcode", "code"], 0), 0);
  const failed = asNumber(pick(body, ["status"], 1), 1) === 0;
  if (errorCode === 20028 || failed && !BIZ_JOIN_CODES.has(errorCode)) return eventId;
  return "";
}

// plugins/auto-team-vip/src/pool.ts
var POOL_URL = "https://echo-team-pool.oneday.vip";
var POOL_RATE_LIMIT_BACKOFF_MS = 6e4;
var POOL_TRANSPORT_BACKOFF_MS = 6e4;
function toPoolTeamState(team) {
  if (!team) return null;
  return {
    code: team.code,
    member_count: team.memberCount,
    captain: team.captain,
    members: team.members
  };
}
function poolHeaders(pluginVersion) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    "X-Plugin-Version": pluginVersion
  };
}
function bodyText2(data) {
  try {
    const text = typeof data === "string" ? data : JSON.stringify(data != null ? data : "");
    return text === void 0 ? String(data != null ? data : "") : text;
  } catch (e) {
    return String(data != null ? data : "");
  }
}
function headerValue(headers, name) {
  var _a;
  const target = name.toLowerCase();
  for (const key of Object.keys(headers || {})) {
    if (key.toLowerCase() === target) return String((_a = headers[key]) != null ? _a : "");
  }
  return "";
}
function isCfChallenge(response) {
  const status = Number(response.status) || 0;
  if (status !== 403 && status !== 503) return false;
  const text = bodyText2(response.data);
  if (!text) return false;
  return /Attention Required|Just a moment|cf-browser-verification|cf_chl_|challenge-platform|Enable JavaScript and cookies/i.test(
    text
  );
}
function isCfEdgeError(response) {
  const data = response.data;
  if (data && typeof data === "object") {
    const record = data;
    if (record.ok === false && typeof record.error === "string") return false;
    const code = Number(record.error_code);
    if (record.cloudflare_error === true) return true;
    if (Number.isFinite(code) && code >= 1e3 && code < 2e3) return true;
  }
  const text = bodyText2(data);
  return /cloudflare-1xxx-errors|workers_dev_script_not_found|No Workers script was found/i.test(
    text
  );
}
function cfChallengeTrace(response) {
  let ray = headerValue(response.headers || {}, "cf-ray");
  const mitigated = headerValue(response.headers || {}, "cf-mitigated");
  if (!ray) {
    const match = /Ray ID:\s*([0-9a-f]{8,})|"?ray_id"?\s*:\s*"([0-9a-f]{8,})"/i.exec(
      bodyText2(response.data)
    );
    if (match) ray = match[1] || match[2] || "";
  }
  return { cfRay: ray, cfMitigated: mitigated };
}
function buildPoolDiag(path, response) {
  const data = response.data;
  let text = "";
  if (data !== void 0 && data !== null) {
    try {
      const serialized = typeof data === "string" ? data : JSON.stringify(data);
      text = serialized === void 0 ? String(data) : serialized;
    } catch (e) {
      text = String(data);
    }
  }
  return {
    endpoint: POOL_URL + path,
    httpStatus: Number(response.status) || 0,
    poolError: String(response.error || ""),
    cfRay: String(response.cfRay || ""),
    cfMitigated: String(response.cfMitigated || ""),
    body: text.length > 1200 ? text.slice(0, 1200) + "…(已截断)" : text
  };
}
var POOL_BACKOFF_STEPS_MS = [5, 15, 30].map((minutes) => minutes * 6e4);
var POOL_EMPTY_BACKOFF_STEPS_MS = [20, 30, 60].map((minutes) => minutes * 6e4);
function createBackoff() {
  return { step: 0, nextAttemptAt: 0 };
}
function poolDown(state, now, transport = false) {
  if (transport) {
    state.nextAttemptAt = now + POOL_TRANSPORT_BACKOFF_MS;
    return;
  }
  const index = Math.min(state.step, POOL_BACKOFF_STEPS_MS.length - 1);
  state.nextAttemptAt = now + POOL_BACKOFF_STEPS_MS[index];
  state.step = Math.min(state.step + 1, POOL_BACKOFF_STEPS_MS.length - 1);
}
function poolRateLimited(state, now) {
  state.nextAttemptAt = Math.max(state.nextAttemptAt, now + POOL_RATE_LIMIT_BACKOFF_MS);
}
function poolUp(state) {
  state.step = 0;
  state.nextAttemptAt = 0;
}
function poolAvailable(state, now) {
  return now >= state.nextAttemptAt;
}
function poolEmptyBackoffStart(state, now) {
  if (state.nextAttemptAt > now) return;
  const index = Math.min(state.step, POOL_EMPTY_BACKOFF_STEPS_MS.length - 1);
  state.nextAttemptAt = now + POOL_EMPTY_BACKOFF_STEPS_MS[index];
  state.step = Math.min(state.step + 1, POOL_EMPTY_BACKOFF_STEPS_MS.length - 1);
}
function backoffRemainingMs(state, now) {
  return state.nextAttemptAt - now;
}
var POOL_ROOT_CAUSE_CODES = /* @__PURE__ */ new Set([
  "pool_cf_challenge",
  "pool_down",
  "pool_rate_limited",
  "pool_net_error"
]);
function normalizePoolResponse(raw) {
  var _a, _b;
  const response = {
    ok: (_a = raw.ok) != null ? _a : false,
    status: raw.status,
    data: raw.data,
    headers: raw.headers || {}
  };
  if (raw.error) response.error = raw.error;
  const data = raw.data;
  const record = data && typeof data === "object" ? data : void 0;
  if (raw.status === 403 && ((record == null ? void 0 : record.error) === "version_mismatch" || (record == null ? void 0 : record.error) === "version_missing")) {
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
    response.ok = (_b = raw.ok) != null ? _b : raw.status >= 200 && raw.status < 300;
  }
  return response;
}

// plugins/auto-team-vip/src/runner.ts
var RETRY_MAX = 3;
var RETRY_DELAY_MS = 2e3;
var POOL_RETRY_DELAY_MS = 500;
var MIN_RUN_INTERVAL_MS = 1e4;
var REFRESH_THROTTLE_MS = 3e3;
var SNAPSHOT_INTERVAL_MS = 5 * 6e4;
var JOINED_SNAPSHOT_INTERVAL_MS = 30 * 6e4;
var FULLFLOW_INTERVAL_MS = 10 * 6e4;
var INACTIVE_PROBE_INTERVAL_MS = 30 * 6e4;
var HEARTBEAT_TICK_MS = 6e4;
var MSG_CF_CHALLENGE = "码池请求被 Cloudflare 拦截。若你正在使用代理/VPN，出口 IP 可能落在境外导致被拒，请关闭代理后重试；否则请联系插件作者。";
var MSG_POOL_NETWORK = "无法连接组队服务器（网络中断或连接被重置），将自动重试；请检查网络连接或代理设置。";
function createPanelState() {
  return {
    loggedIn: false,
    periodId: "",
    periodName: "",
    periodStart: "",
    periodEnd: "",
    periodActive: false,
    periodState: "unknown",
    myCode: "",
    myMemberCount: 0,
    myVipDesc: "",
    targetMembers: 3,
    joined: false,
    joinedCode: "",
    joinedMemberCount: 0,
    joinedVipDesc: "",
    poolDisabled: false,
    poolDown: false,
    lastMessage: "",
    lastError: null
  };
}
var Aborted = class extends Error {
};
function buildErrorDetail(error, now) {
  const lines = [
    "=== EchoMusic 自动组队错误详情 ===",
    "时间: " + new Date(error.at || now).toLocaleString(),
    "错误码: " + error.code,
    "描述: " + error.message
  ];
  const detail = error.detail || {};
  for (const key of Object.keys(detail)) {
    const value = detail[key];
    if (value === void 0 || value === null || value === "") continue;
    if (Array.isArray(value)) {
      lines.push(key + ":");
      value.forEach(
        (item, index) => lines.push(
          "  #" + (index + 1) + " " + (typeof item === "object" ? JSON.stringify(item) : String(item))
        )
      );
    } else {
      lines.push(key + ": " + (typeof value === "object" ? JSON.stringify(value) : String(value)));
    }
  }
  return lines.join("\n");
}
function createRunner(services) {
  const state = services.state;
  const poolBackoff = createBackoff();
  const poolEmptyBackoff = createBackoff();
  const disabledPeriods = /* @__PURE__ */ new Set();
  let errorSeq = 0;
  let lastRunAt = 0;
  let lastSnapshotAt = 0;
  let lastFullAt = 0;
  let lastInactiveProbeAt = 0;
  let runChain = null;
  let versionMismatchReported = false;
  let deviceBoundToastShown = false;
  function ensureActive() {
    if (!services.active()) throw new Aborted("scope retired");
  }
  function setLastError(message, code, detail, atTime) {
    errorSeq += 1;
    state.lastMessage = message;
    state.lastError = code ? { code, message, detail: detail || {}, at: atTime != null ? atTime : services.now() } : null;
    services.publish();
  }
  function clearLastError() {
    state.lastMessage = "";
    state.lastError = null;
    services.publish();
  }
  function applyTeamInfo(info) {
    if (!info || !info.raw) return;
    state.myCode = info.created ? info.created.code : "";
    state.myMemberCount = info.created ? info.created.memberCount : 0;
    state.myVipDesc = info.created ? info.created.vipDesc : "";
    state.joinedCode = info.joined ? info.joined.code : "";
    state.joinedMemberCount = info.joined ? info.joined.memberCount : 0;
    state.joinedVipDesc = info.joined ? info.joined.vipDesc : "";
    state.joined = Boolean(info.joined && info.joined.code);
    services.publish();
  }
  function updateDisabled(key, value) {
    return __async(this, null, function* () {
      if (key && value) disabledPeriods.add(key);
      try {
        const map = {};
        for (const entry of disabledPeriods) map[entry] = true;
        yield services.writeValue("poolAuthDisabled", map);
      } catch (e) {
      }
    });
  }
  function teamCall(_0, _1) {
    return __async(this, arguments, function* (auth, endpoint, args = {}) {
      const send = () => __async(null, null, function* () {
        const request = buildTeamRequest(auth, endpoint, args);
        return normalizeGateway(yield services.gatewaySend(request));
      });
      ensureActive();
      let response = yield send();
      const eventId = needsCaptcha(response);
      if (eventId) {
        services.log("captcha required for " + endpoint + ": " + eventId);
        let verified = false;
        try {
          verified = yield services.verifyCaptcha(eventId);
        } catch (error) {
          services.log("verification failed: " + String((error == null ? void 0 : error.message) || error));
        }
        if (verified) response = yield send();
      }
      return response;
    });
  }
  function normalizeGateway(raw) {
    var _a;
    const headers = {};
    const source = raw.headers || {};
    for (const key of Object.keys(source)) {
      const value = source[key];
      headers[key.toLowerCase()] = Array.isArray(value) ? String((_a = value[0]) != null ? _a : "") : String(value != null ? value : "");
    }
    const response = {
      ok: raw.ok,
      status: raw.status,
      body: raw.body,
      headers
    };
    if (raw.error) response.error = raw.error;
    return response;
  }
  function getPeriodInfo(auth) {
    return __async(this, null, function* () {
      const response = yield teamCall(auth, "get_period_info");
      if (!response.ok) {
        const failure = classifyPeriodFailure(response);
        return {
          ok: false,
          error: failure.msg,
          errorCode: failure.code,
          diag: failure.diag
        };
      }
      const period = normalizePeriod(response.body);
      if (!period.periodId) {
        const failure = classifyPeriodFailure(response);
        return {
          ok: false,
          error: failure.msg,
          errorCode: failure.code,
          diag: failure.diag
        };
      }
      return __spreadValues({ ok: true }, period);
    });
  }
  function getMyTeamInfo(auth, periodId) {
    return __async(this, null, function* () {
      const response = yield teamCall(auth, "get_my_team_info", { periodId });
      if (!response.ok) return { ok: false, error: response.error || "请求失败" };
      return __spreadValues({ ok: true }, normalizeTeamInfo(response.body));
    });
  }
  function onPanelOpened() {
    versionMismatchReported = false;
  }
  function getPoolToken(uid) {
    return __async(this, null, function* () {
      try {
        const tokens = yield services.readValue("poolTokens");
        if (tokens && typeof tokens === "object") {
          const value = tokens[uid];
          if (typeof value === "string") return value;
        }
      } catch (e) {
      }
      return "";
    });
  }
  function isPoolDisabled(periodId, uid) {
    return __async(this, null, function* () {
      if (disabledPeriods.has(periodId + ":" + uid)) return true;
      try {
        const map = yield services.readValue("poolAuthDisabled");
        return Boolean(
          map && typeof map === "object" && map[periodId + ":" + uid]
        );
      } catch (e) {
        return false;
      }
    });
  }
  function loadDisabledPeriods() {
    return __async(this, null, function* () {
      try {
        const map = yield services.readValue("poolAuthDisabled");
        if (map && typeof map === "object") {
          for (const key of Object.keys(map)) disabledPeriods.add(key);
        }
      } catch (e) {
      }
    });
  }
  function remainingBackoffSeconds(now) {
    return Math.max(1, Math.ceil(backoffRemainingMs(poolBackoff, now) / 1e3));
  }
  function doSnapshot(_0, _1, _2, _3) {
    return __async(this, arguments, function* (auth, periodId, uid, teamInfo, options = {}) {
      const now = services.now();
      if (yield isPoolDisabled(periodId, uid)) {
        state.poolDisabled = true;
        services.publish();
        return "disabled";
      }
      if (!options.confirm && !poolAvailable(poolBackoff, now)) {
        state.poolDown = true;
        services.publish();
        const waitSec = remainingBackoffSeconds(now);
        const previous = state.lastError;
        if (previous && POOL_ROOT_CAUSE_CODES.has(previous.code)) {
          setLastError(
            previous.message,
            previous.code,
            __spreadProps(__spreadValues({}, previous.detail || {}), {
              退避剩余秒: waitSec,
              退避档位: poolBackoff.step,
              根因发生于: new Date(previous.at || now).toLocaleString(),
              note: "本轮处于退避窗口内未发请求，上述为退避起因的真实错误"
            }),
            previous.at
          );
        } else {
          setLastError(
            `码池暂时不可用，约 ${Math.ceil(waitSec / 60)} 分钟后自动重试`,
            "pool_backoff",
            {
              periodId,
              uid,
              waitSeconds: waitSec,
              backoffStep: poolBackoff.step
            }
          );
        }
        return "down";
      }
      const token = yield getPoolToken(uid);
      const created = toPoolTeamState(teamInfo.created);
      if (created && !created.captain) created.captain = uid;
      const payload = {
        period_id: periodId,
        uid,
        token,
        created,
        joined: toPoolTeamState(teamInfo.joined),
        // 只有明确拿到 my_join_team_list（数组）时才允许服务端清空 last_joined_code
        joined_checked: teamInfo.joinedChecked === true
      };
      const response = yield poolRequest("/v2/snapshot", payload);
      if (response.ok) {
        poolUp(poolBackoff);
        const record = response.data && typeof response.data === "object" ? response.data : void 0;
        if (record && typeof record.token === "string" && record.token) {
          try {
            const tokens = yield services.readValue("poolTokens");
            const map = tokens && typeof tokens === "object" ? __spreadValues({}, tokens) : {};
            map[uid] = record.token;
            yield services.writeValue("poolTokens", map);
          } catch (e) {
          }
        }
        state.poolDisabled = false;
        state.poolDown = false;
        services.publish();
        return "ok";
      }
      if (response.status === 401) {
        yield updateDisabled(periodId + ":" + uid, true);
        state.poolDisabled = true;
        services.publish();
        setLastError("身份校验失败，本期码池功能停用（下期自动恢复）", "pool_unauthorized", {
          periodId,
          uid
        });
        return "disabled";
      }
      if (response.status === 429) {
        poolRateLimited(poolBackoff, services.now());
        setLastError("码池请求过于频繁，稍后自动重试", "pool_rate_limited", __spreadValues({
          periodId,
          uid
        }, buildPoolDiag("/v2/snapshot", response)));
        return "down";
      }
      if (response.needUpdate) {
        reportVersionMismatch(response);
        return "disabled";
      }
      state.poolDown = true;
      services.publish();
      if (response.status === 0) {
        poolDown(poolBackoff, services.now(), true);
        setLastError(MSG_POOL_NETWORK, "pool_net_error", __spreadValues({
          periodId,
          uid,
          transportRetryAfter: 60
        }, buildPoolDiag("/v2/snapshot", response)));
        return "down";
      }
      poolDown(poolBackoff, services.now());
      if (response.cfChallenge) {
        setLastError(MSG_CF_CHALLENGE, "pool_cf_challenge", __spreadValues({
          periodId,
          uid,
          backoffStep: poolBackoff.step
        }, buildPoolDiag("/v2/snapshot", response)));
        return "down";
      }
      setLastError("码池暂时不可用，稍后自动重试", "pool_down", __spreadValues({
        periodId,
        uid,
        backoffStep: poolBackoff.step
      }, buildPoolDiag("/v2/snapshot", response)));
      return "down";
    });
  }
  function reportVersionMismatch(response) {
    if (versionMismatchReported) return;
    versionMismatchReported = true;
    const record = response.data && typeof response.data === "object" ? response.data : void 0;
    const message = String(record && record.message || "插件版本过低，请更新");
    setLastError(message, "version_mismatch", {
      poolError: String(record && record.error || "")
    });
    services.toastWarning(message);
  }
  function reportLeaseResult(auth, periodId, uid, leaseId, result, errorKind) {
    return __async(this, null, function* () {
      const token = yield getPoolToken(uid);
      const response = yield poolRequest("/v2/join/result", {
        period_id: periodId,
        uid,
        token,
        lease_id: leaseId,
        result,
        error_kind: errorKind || ""
      });
      if (response.ok) return "ok";
      if (response.status === 404) {
        const record = response.data && typeof response.data === "object" ? response.data : void 0;
        if (record && record.error === "lease_not_found") return "ok";
      }
      if (response.status === 401) {
        yield updateDisabled(periodId + ":" + uid, true);
        state.poolDisabled = true;
        services.publish();
        setLastError("身份校验失败，本期码池功能停用（下期自动恢复）", "pool_unauthorized", {
          periodId,
          uid,
          stage: "result"
        });
        return "abort";
      }
      if (response.needUpdate) {
        reportVersionMismatch(response);
        return "abort";
      }
      if (response.status === 429) {
        poolRateLimited(poolBackoff, services.now());
        setLastError("码池请求过于频繁，稍后自动重试", "pool_rate_limited", {
          periodId,
          uid,
          stage: "result"
        });
        return "abort";
      }
      poolDown(poolBackoff, services.now());
      services.log("lease result report failed: " + result + " " + response.status);
      return "ok";
    });
  }
  function poolRequest(path, payload) {
    return __async(this, null, function* () {
      let response = yield services.poolSend(path, payload);
      if (!response.ok && !response.cfChallenge && !response.cfEdgeError && (response.status === 0 || response.status >= 500)) {
        yield services.sleep(POOL_RETRY_DELAY_MS);
        response = yield services.poolSend(path, payload);
      }
      return response;
    });
  }
  function poolJoin(auth, periodId, uid, excludeCodes) {
    return __async(this, null, function* () {
      const token = yield getPoolToken(uid);
      return poolRequest("/v2/join", {
        period_id: periodId,
        uid,
        token,
        // 本轮流程内已失败的队不再命中（服务端仅对本次选队生效，不落库）
        exclude_codes: Array.isArray(excludeCodes) ? excludeCodes.slice(0, 3).map(String) : []
      });
    });
  }
  function runFullFlow(_0) {
    return __async(this, arguments, function* (reason, options = {}) {
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
          state.periodState = "unknown";
          services.publish();
          if (services.loggedIn()) {
            setLastError(
              "登录态同步中，稍后自动重试；如长时间无进展请播放一首歌曲后重试",
              "auth_syncing"
            );
          } else {
            setLastError("未登录 EchoMusic，请先登录", "not_logged_in");
          }
          return;
        }
        const uid = String(auth.userid);
        const period = yield getPeriodInfo(auth);
        ensureActive();
        if (!period.ok) {
          state.periodState = "error";
          services.publish();
          setLastError(period.error || "获取活动信息失败", period.errorCode || "no_period", __spreadValues({
            endpoint: "/youth/v1/ut/get_period_info"
          }, period.diag || {}));
          return;
        }
        const periodId = String(period.periodId);
        const lastPeriodId = yield services.readValue("lastPeriodId");
        if (typeof lastPeriodId === "string" && lastPeriodId && lastPeriodId !== periodId) {
          poolEmptyBackoff.step = 0;
          poolEmptyBackoff.nextAttemptAt = 0;
          state.myCode = "";
          state.myMemberCount = 0;
          state.joinedCode = "";
          state.joinedMemberCount = 0;
          state.joined = false;
          const kept = /* @__PURE__ */ new Set();
          for (const key of disabledPeriods) {
            if (key.startsWith(periodId + ":")) kept.add(key);
          }
          disabledPeriods.clear();
          for (const key of kept) disabledPeriods.add(key);
          yield updateDisabled("", false);
        }
        yield services.writeValue("lastPeriodId", periodId);
        state.periodId = periodId;
        state.periodName = period.periodName;
        state.periodStart = period.startTime;
        state.periodEnd = period.endTime;
        state.periodActive = period.active;
        state.periodState = period.active ? "active" : "inactive";
        state.targetMembers = period.totalMembers;
        services.publish();
        if (!period.active) {
          setLastError("本期活动未开启", "period_inactive");
          return;
        }
        const autoOn = services.autoEnabled;
        let myInfo = yield getMyTeamInfo(auth, periodId);
        ensureActive();
        if (!myInfo.ok) {
          setLastError("获取队伍信息失败", "myinfo_failed");
          return;
        }
        if (!autoOn) {
          lastSnapshotAt = services.now();
          applyTeamInfo(myInfo);
          clearIfNoNewError();
          return;
        }
        if (!myInfo.created) {
          const createdRes = yield teamCall(auth, "create_team", { periodId });
          ensureActive();
          const createdParsed = createdRes.ok ? parseJoinResponse(createdRes) : null;
          if (!createdParsed || !createdParsed.httpOk || !createdParsed.bizOk) {
            const detail = createdParsed && createdParsed.errorMsg || String(createdRes.error || "请求失败");
            setLastError(`自动创建队伍失败（${detail}），仍可加入其他队伍`, "create_team_failed", {
              periodId,
              detail
            });
          }
          const refreshed = yield getMyTeamInfo(auth, periodId);
          ensureActive();
          if (!refreshed.ok) {
            setLastError("获取队伍信息失败", "myinfo_failed");
            return;
          }
          myInfo = refreshed;
        }
        applyTeamInfo(myInfo);
        const snap = yield doSnapshot(auth, periodId, uid, myInfo);
        lastSnapshotAt = services.now();
        if (snapshotOnly || snap !== "ok") {
          if (snap === "ok") clearIfNoNewError();
          return;
        }
        if (myInfo.joined) {
          clearIfNoNewError();
          return;
        }
        const excludedCodes = /* @__PURE__ */ new Set();
        const attempts = [];
        for (let attempt = 1; attempt <= RETRY_MAX; attempt += 1) {
          ensureActive();
          const nowAttempt = services.now();
          if (!poolAvailable(poolBackoff, nowAttempt)) {
            const waitSec = remainingBackoffSeconds(nowAttempt);
            setLastError(
              `码池暂时不可用，约 ${Math.ceil(waitSec / 60)} 分钟后自动重试`,
              "pool_backoff",
              {
                periodId,
                uid,
                waitSeconds: waitSec,
                backoffStep: poolBackoff.step
              }
            );
            return;
          }
          const joinRes = yield poolJoin(auth, periodId, uid, Array.from(excludedCodes));
          ensureActive();
          if (!joinRes.ok) {
            if (joinRes.status === 401) {
              yield updateDisabled(periodId + ":" + uid, true);
              state.poolDisabled = true;
              services.publish();
              setLastError("身份校验失败，本期码池功能停用（下期自动恢复）", "pool_unauthorized", {
                periodId,
                uid
              });
            } else if (joinRes.status === 429) {
              poolRateLimited(poolBackoff, services.now());
              setLastError("码池请求过于频繁，稍后自动重试", "pool_rate_limited", { periodId, uid });
            } else if (!joinRes.needUpdate) {
              state.poolDown = true;
              services.publish();
              if (joinRes.status === 0) {
                poolDown(poolBackoff, services.now(), true);
                setLastError(MSG_POOL_NETWORK, "pool_net_error", __spreadValues({
                  periodId,
                  uid,
                  stage: "join",
                  transportRetryAfter: 60
                }, buildPoolDiag("/v2/join", joinRes)));
                return;
              }
              poolDown(poolBackoff, services.now());
              if (joinRes.cfChallenge) {
                setLastError(MSG_CF_CHALLENGE, "pool_cf_challenge", __spreadValues({
                  periodId,
                  uid,
                  stage: "join"
                }, buildPoolDiag("/v2/join", joinRes)));
              } else {
                setLastError("码池暂时不可用，稍后自动重试", "pool_down", __spreadValues({
                  periodId,
                  uid,
                  stage: "join"
                }, buildPoolDiag("/v2/join", joinRes)));
              }
            } else {
              reportVersionMismatch(joinRes);
            }
            return;
          }
          const data = joinRes.data && typeof joinRes.data === "object" ? joinRes.data : {};
          if (data.reason === "already_joined") {
            if (data.code) {
              state.joinedCode = String(data.code);
              state.joined = true;
              services.publish();
            }
            const verify = yield getMyTeamInfo(auth, periodId);
            ensureActive();
            if (verify.ok) applyTeamInfo(verify);
            yield doSnapshot(
              auth,
              periodId,
              uid,
              verify.ok ? verify : myInfo
            );
            clearIfNoNewError();
            return;
          }
          if (data.reason === "pool_empty" || !data.code) {
            poolEmptyBackoffStart(poolEmptyBackoff, services.now());
            setLastError("暂无可加入的队伍，可手动组队或耐心等待", "pool_empty", { periodId, uid });
            return;
          }
          if (!data.lease_id || !data.code) {
            setLastError("码池响应异常，稍后自动重试", "pool_bad_response", { periodId, uid });
            return;
          }
          const leaseId = String(data.lease_id);
          const code = String(data.code);
          poolEmptyBackoff.step = 0;
          poolEmptyBackoff.nextAttemptAt = 0;
          const joinKugou = yield teamCall(auth, "join_team", { teamCode: code });
          ensureActive();
          if (!joinKugou.ok) {
            attempts.push({
              尝试: attempt,
              队伍码: code,
              类别: "network",
              说明: joinKugou.error || "请求失败"
            });
            if ((yield reportLeaseResult(auth, periodId, uid, leaseId, "failed", "network")) === "abort")
              return;
            if (attempt < RETRY_MAX) yield services.sleep(RETRY_DELAY_MS);
            continue;
          }
          const parsed = parseJoinResponse(joinKugou);
          if (parsed.httpOk && parsed.bizOk) {
            yield reportLeaseResult(auth, periodId, uid, leaseId, "success", "");
            const verify = yield getMyTeamInfo(auth, periodId);
            ensureActive();
            if (verify.ok) applyTeamInfo(verify);
            yield doSnapshot(
              auth,
              periodId,
              uid,
              verify.ok ? verify : myInfo,
              {
                confirm: true
              }
            );
            clearIfNoNewError();
            return;
          }
          const failure = classifyJoinError(joinKugou.body);
          attempts.push(__spreadValues(__spreadValues({
            尝试: attempt,
            队伍码: code,
            类别: failure.kind,
            HTTP状态: joinKugou.status
          }, failure.errorCode ? { 酷狗错误码: failure.errorCode } : {}), failure.errorMsg ? { 酷狗信息: failure.errorMsg } : {}));
          if ((yield reportLeaseResult(auth, periodId, uid, leaseId, "failed", failure.kind)) === "abort")
            return;
          if (failure.kind === "already_joined") {
            const verify = yield getMyTeamInfo(auth, periodId);
            ensureActive();
            if (verify.ok) applyTeamInfo(verify);
            yield doSnapshot(
              auth,
              periodId,
              uid,
              verify.ok ? verify : myInfo
            );
            if (failure.errorCode === 143005 && verify.ok && !verify.joined) {
              const message = "无法加入其他队伍，请到概念版APP手动加入或查看原因";
              setLastError(message, "device_already_bound", {
                periodId,
                uid,
                code,
                errorCode: failure.errorCode
              });
              if (!deviceBoundToastShown) {
                deviceBoundToastShown = true;
                services.toastWarning(message);
              }
              return;
            }
            clearIfNoNewError();
            return;
          }
          excludedCodes.add(code);
          services.log("retry " + code + " " + failure.kind + " attempt " + attempt);
          if (attempt < RETRY_MAX) yield services.sleep(RETRY_DELAY_MS);
        }
        setLastError("加入队伍未成功，稍后自动重试", "join_exhausted", { periodId, uid, attempts });
      } catch (error) {
        if (error instanceof Aborted) return;
        services.log("runFullFlow error: " + String((error == null ? void 0 : error.message) || error));
      }
    });
  }
  function manualJoin(code) {
    return __async(this, null, function* () {
      const auth = services.auth();
      if (!auth) {
        return {
          ok: false,
          message: services.loggedIn() ? "登录态同步中，请稍后重试" : "未登录 EchoMusic，请先登录"
        };
      }
      ensureActive();
      try {
        const response = yield teamCall(auth, "join_team", { teamCode: code });
        const parsed = parseJoinResponse(response);
        if (parsed.httpOk && parsed.bizOk) {
          clearLastError();
          void requestRun("manual_join", { snapshotOnly: true, force: true });
          return { ok: true, message: "已提交加入" };
        }
        const message = parsed.errorMsg || "加入失败，请检查组队码";
        setLastError(message, "manual_join_failed", { code, errorMsg: parsed.errorMsg });
        return { ok: false, message };
      } catch (error) {
        if (error instanceof Aborted) return { ok: false, message: "插件已停用" };
        const message = String((error == null ? void 0 : error.message) || error) || "加入失败";
        return { ok: false, message };
      }
    });
  }
  function requestRun(reason, options = {}) {
    if (!runChain) runChain = Promise.resolve();
    const next = runChain.then(() => runFullFlow(reason, options));
    runChain = next.catch(() => void 0);
    return next;
  }
  function heartbeatTick() {
    try {
      if (!services.active()) return;
      const panelOpen = services.panelOpen;
      const autoOn = services.autoEnabled;
      if (!panelOpen && !autoOn) return;
      const now = services.now();
      if (state.periodState === "inactive") {
        if (now - lastInactiveProbeAt >= INACTIVE_PROBE_INTERVAL_MS) {
          lastInactiveProbeAt = now;
          void requestRun("period_probe", { force: true });
        }
        return;
      }
      const joined = state.joined;
      const snapshotInterval = panelOpen ? SNAPSHOT_INTERVAL_MS : JOINED_SNAPSHOT_INTERVAL_MS;
      if (autoOn && !joined && now - lastFullAt >= FULLFLOW_INTERVAL_MS && now >= poolEmptyBackoff.nextAttemptAt) {
        lastFullAt = now;
        lastSnapshotAt = now;
        void requestRun("heartbeat_full");
      } else if (now - lastSnapshotAt >= snapshotInterval) {
        lastSnapshotAt = now;
        void requestRun("heartbeat_snapshot", { snapshotOnly: true });
      }
    } catch (error) {
      services.log("heartbeat error: " + String((error == null ? void 0 : error.message) || error));
    }
  }
  function resetForAccountChange() {
    poolUp(poolBackoff);
    poolEmptyBackoff.step = 0;
    poolEmptyBackoff.nextAttemptAt = 0;
    disabledPeriods.clear();
    versionMismatchReported = false;
    deviceBoundToastShown = false;
    lastRunAt = 0;
    lastSnapshotAt = 0;
    lastFullAt = 0;
    lastInactiveProbeAt = 0;
    state.periodId = "";
    state.periodName = "";
    state.periodStart = "";
    state.periodEnd = "";
    state.periodActive = false;
    state.periodState = "unknown";
    state.myCode = "";
    state.myMemberCount = 0;
    state.myVipDesc = "";
    state.joined = false;
    state.joinedCode = "";
    state.joinedMemberCount = 0;
    state.joinedVipDesc = "";
    state.poolDisabled = false;
    state.poolDown = false;
    state.lastMessage = "";
    state.lastError = null;
    services.publish();
  }
  function loadDisabled() {
    return __async(this, null, function* () {
      yield loadDisabledPeriods();
    });
  }
  return {
    requestRun,
    /** 等待当前串行链排空（排水用，不触发新流程） */
    idle() {
      return runChain != null ? runChain : Promise.resolve();
    },
    heartbeatTick,
    onPanelOpened,
    resetForAccountChange,
    loadDisabled,
    manualJoin,
    poolBackoff,
    poolEmptyBackoff
  };
}

// plugins/auto-team-vip/src/entry.ts
var PLUGIN_VERSION = "1.2.6";
var AUTO_RUN_DELAY_MS = 3e3;
var LOGIN_RUN_DELAY_MS = 2e3;
var GATEWAY_TIMEOUT_MS = 15e3;
function normalizeHeaders(headers) {
  var _a;
  const out = {};
  for (const key of Object.keys(headers || {})) {
    const value = headers[key];
    out[key.toLowerCase()] = Array.isArray(value) ? String((_a = value[0]) != null ? _a : "") : String(value != null ? value : "");
  }
  return out;
}
function encodeQuery(query) {
  const parts = [];
  for (const key of Object.keys(query)) {
    parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(query[key]));
  }
  return parts.join("&");
}
function activate(ctx) {
  const state = createPanelState();
  let autoEnabled = false;
  let panelOpen = false;
  let capturedAuth = null;
  let rawAuthHeader = "";
  let interceptorLease = null;
  let lastRefreshTime = 0;
  let disposed = false;
  const pendingSleeps = /* @__PURE__ */ new Set();
  const runner = createRunner({
    now: () => Date.now(),
    active: () => !disposed && ctx.active,
    log: (message) => console.info("[auto-team-vip] " + message),
    toastWarning: (message) => {
      void ctx.toast.warning(message);
    },
    sleep: (ms) => new Promise((resolve) => {
      const finish = () => {
        pendingSleeps.delete(finish);
        resolve();
      };
      pendingSleeps.add(finish);
      const registration = ctx.setTimer("sleep", ms, false, finish);
      if (!registration) finish();
    }),
    readValue: (key) => awaitOperation(ctx.io.readValue(key)).catch(() => void 0),
    writeValue: (key, value) => awaitOperation(ctx.io.writeValue(key, value)).then(() => void 0).catch(() => void 0),
    auth: () => capturedAuth,
    loggedIn: () => Boolean(ctx.kugou.account && ctx.kugou.account.loggedIn),
    gatewaySend: (request) => gatewaySend(request),
    verifyCaptcha: (eventId) => awaitOperation(ctx.kugou.verify(eventId)).then((result) => Boolean(result && result.verified)).catch(() => false),
    poolSend: (path, payload) => poolSend(path, payload),
    publish: () => publishPanel(),
    state,
    get autoEnabled() {
      return autoEnabled;
    },
    get panelOpen() {
      return panelOpen;
    }
  });
  function gatewaySend(request) {
    return __async(this, null, function* () {
      const options = {
        url: request.url + "?" + encodeQuery(request.query),
        method: request.method,
        headers: request.body ? __spreadProps(__spreadValues({}, request.headers), { "Content-Type": "application/json" }) : request.headers,
        responseType: "json",
        timeoutMs: GATEWAY_TIMEOUT_MS
      };
      if (request.body !== null && request.body !== void 0) options.body = request.body;
      try {
        const response = yield awaitOperation(ctx.net.request(options));
        return {
          ok: true,
          status: response.status,
          body: response.data,
          headers: normalizeHeaders(response.headers)
        };
      } catch (error) {
        return {
          ok: false,
          status: 0,
          body: null,
          error: String((error == null ? void 0 : error.message) || error),
          headers: {}
        };
      }
    });
  }
  function poolSend(path, payload) {
    return __async(this, null, function* () {
      try {
        const response = yield awaitOperation(
          ctx.net.request({
            url: POOL_URL + path,
            method: "POST",
            headers: poolHeaders(PLUGIN_VERSION),
            body: payload,
            responseType: "json",
            timeoutMs: GATEWAY_TIMEOUT_MS
          })
        );
        return normalizePoolResponse({
          status: response.status,
          data: response.data,
          headers: normalizeHeaders(response.headers)
        });
      } catch (error) {
        return normalizePoolResponse({
          status: 0,
          data: null,
          headers: {},
          error: String((error == null ? void 0 : error.message) || error)
        });
      }
    });
  }
  function publishPanel() {
    if (disposed) return;
    const remaining = Math.max(0, backoffRemainingMs(runner.poolBackoff, Date.now()));
    ctx.ui.setState({
      loggedIn: state.loggedIn,
      authState: capturedAuth ? "ok" : interceptorLease ? "waiting" : "unauthorized",
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
      poolRetryMinutes: Math.ceil(remaining / 6e4),
      autoEnabled,
      panelOpen,
      lastMessage: state.lastMessage,
      lastError: state.lastError ? {
        code: state.lastError.code,
        message: state.lastError.message,
        detail: state.lastError.detail,
        at: state.lastError.at
      } : null
    });
  }
  function registerInterceptor() {
    return __async(this, null, function* () {
      try {
        const lease = yield awaitOperation(
          ctx.server.intercept({
            id: "auth-capture",
            stage: "api",
            match: (request) => {
              const header = request.headers ? request.headers["Authorization"] : void 0;
              if (typeof header === "string" && header.indexOf("token=") >= 0 && header !== rawAuthHeader) {
                rawAuthHeader = header;
                capturedAuth = parseAuthHeader(header);
                publishPanel();
              }
              return false;
            },
            handle: () => void 0
          })
        );
        interceptorLease = lease;
      } catch (error) {
        interceptorLease = null;
        console.warn(
          "[auto-team-vip] interceptor authorization rejected: " + String((error == null ? void 0 : error.message) || error)
        );
        state.lastMessage = "插件授权未开启：组队功能需要“请求拦截”授权，请在插件管理的授权入口开启后重新启用插件";
        state.lastError = null;
        publishPanel();
      }
    });
  }
  const settingsReady = (() => __async(null, null, function* () {
    try {
      const saved = yield awaitOperation(ctx.io.readValue("settings"));
      if (saved && typeof saved === "object") {
        autoEnabled = saved.autoEnabled === true;
      }
    } catch (e) {
      autoEnabled = false;
    }
    yield runner.loadDisabled();
    publishPanel();
  }))();
  function scheduleStartupRun(reason, delayMs) {
    const registration = ctx.setTimer("startup-run", delayMs, false, () => {
      void settingsReady.then(() => runner.requestRun(reason));
    });
    if (!registration) void settingsReady.then(() => runner.requestRun(reason));
  }
  ctx.sessionInvalidated.connect(() => {
    capturedAuth = null;
    rawAuthHeader = "";
    interceptorLease = null;
    void runner.resetForAccountChange();
    void registerInterceptor();
    scheduleStartupRun("login", LOGIN_RUN_DELAY_MS);
  });
  ctx.registerCommand("panel.opened", (args) => {
    panelOpen = (args == null ? void 0 : args.active) !== false;
    if (panelOpen) {
      runner.onPanelOpened();
      void runner.requestRun("panel_open", { snapshotOnly: true });
    }
    return null;
  });
  ctx.registerCommand("refresh", () => __async(null, null, function* () {
    if (disposed) return { ok: false };
    const now = Date.now();
    if (now - lastRefreshTime < REFRESH_THROTTLE_MS) {
      void ctx.toast.info("刷新过于频繁，请稍后再试");
      return { ok: false };
    }
    lastRefreshTime = now;
    yield runner.requestRun("manual", { force: true });
    void ctx.toast.success("已刷新");
    return { ok: true };
  }));
  ctx.registerCommand("set-auto", (args) => __async(null, null, function* () {
    const enabled = (args == null ? void 0 : args.enabled) === true;
    if (enabled === autoEnabled) return { ok: true };
    autoEnabled = enabled;
    try {
      const saved = yield awaitOperation(ctx.io.readValue("settings"));
      const base = saved && typeof saved === "object" ? __spreadValues({}, saved) : {};
      base.autoEnabled = enabled;
      yield awaitOperation(ctx.io.writeValue("settings", base));
    } catch (e) {
    }
    publishPanel();
    if (enabled) {
      void ctx.toast.info("已开启自动组队，正在执行~~~");
      void runner.requestRun("toggle_on", { force: true });
    } else {
      void ctx.toast.info("已关闭自动组队，不再与码池服务器通信");
      void runner.requestRun("toggle_off", { force: true });
    }
    return { ok: true };
  }));
  ctx.registerCommand("join-manual", (args) => __async(null, null, function* () {
    var _a;
    const code = String((_a = args == null ? void 0 : args.code) != null ? _a : "").trim();
    if (!code) return { ok: false, message: "请输入组队码" };
    const result = yield runner.manualJoin(code);
    if (!result.ok) void ctx.toast.warning(result.message);
    return result;
  }));
  ctx.registerCommand("copy-created", () => {
    const code = state.myCode;
    if (!code) {
      void ctx.toast.warning("暂无组队码，请先运行互助");
      return "";
    }
    return code;
  });
  ctx.registerCommand("copy-joined", () => {
    const code = state.joinedCode;
    if (!code) {
      void ctx.toast.warning("暂无组队码，请先运行互助");
      return "";
    }
    return code;
  });
  ctx.registerCommand("error-detail", () => {
    const error = state.lastError;
    if (!error) return "";
    return buildErrorDetail(error, Date.now());
  });
  ctx.registerCommand("status", () => ({
    poolUrl: POOL_URL,
    minRunIntervalMs: MIN_RUN_INTERVAL_MS,
    periodId: state.periodId,
    joined: state.joined,
    autoEnabled,
    authCaptured: Boolean(capturedAuth)
  }));
  ctx.ui.registerPage("panel", "qml/TeamPanel.qml");
  ctx.ui.registerTitlebarActionDefinition("open-panel", {
    title: "自动组队",
    icon: "star",
    tooltip: "自动组队领VIP",
    defaultPlacement: "toolbar",
    order: 100,
    onClick: () => {
      void awaitOperation(ctx.ui.navigate("panel"));
    }
  });
  ctx.setTimer("heartbeat", HEARTBEAT_TICK_MS, true, () => {
    runner.heartbeatTick();
    publishPanel();
  });
  scheduleStartupRun("startup", AUTO_RUN_DELAY_MS);
  void registerInterceptor();
  ctx.onDispose(() => {
    disposed = true;
    if (interceptorLease) {
      interceptorLease.dispose();
      interceptorLease = null;
    }
    for (const finish of Array.from(pendingSleeps)) finish();
    pendingSleeps.clear();
    panelOpen = false;
  });
}
function deactivate() {
}
export {
  activate,
  deactivate
};

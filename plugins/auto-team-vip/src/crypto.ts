// 酷狗概念版网关（gateway.kugou.com）组队接口的请求签名。
// 与旧宿主 server/module/team_*.js 的实现逐位对齐：
//   token 参数 = 'h5' + RSA_NO_PADDING('moc.uoguk.59::' + 真实 token，128 字节零填充) 的十六进制大写
//   signature  = MD5(SALT + 按 key 排序的 k=v 串 + [POST 时 JSON 请求体] + SALT)
// Qt JS 引擎只有 ES7 基线（无 BigInt/WebCrypto），RSA 用 16 位肢的模幂实现。

const SIGNATURE_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
const H5_TOKEN_PREFIX = 'moc.uoguk.59::';
// 概念版 RSA 公钥（1024 位，指数 65537），与旧宿主 publicLiteRasKey 一致
const LITE_MODULUS_HEX =
  'c40a2d0da76511f3bb1cc2bbd3afbd8bea83b4d6b05b6c13eb8920c53f1af7679b32ba0d0edb843240ef1b836efed3ee240734c14c1399fd6594d16af22f52525d14d72e0155c6dcc8638d4f7bb94f3a0b1f4c29f991972f2a160a25eb0a9e724336be7f69bbd319ffab1c6dd8470b021dc434f3faba89f4a2a01b33bdbdd08b';
const LITE_EXPONENT = 65537;
const RSA_BLOCK_BYTES = 128;

function hexToLimbs(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  const limbs: number[] = [];
  for (let i = bytes.length - 2; i >= 0; i -= 2) {
    limbs.push((bytes[i] << 8) | bytes[i + 1]);
  }
  while (limbs.length > 0 && limbs[limbs.length - 1] === 0) limbs.pop();
  return limbs;
}

const LITE_MODULUS: number[] = hexToLimbs(LITE_MODULUS_HEX);

// ---------- 16 位肢大整数（小端），仅实现模幂所需的最小集合 ----------

function limbsEqualZero(a: number[]): boolean {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== 0) return false;
  return true;
}

function limbsCompare(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = length - 1; i >= 0; i -= 1) {
    const left = a[i] || 0;
    const right = b[i] || 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

function limbsSubInPlace(a: number[], b: number[]): void {
  let borrow = 0;
  for (let i = 0; i < a.length; i += 1) {
    const diff = a[i] - (b[i] || 0) - borrow;
    if (diff < 0) {
      a[i] = diff + 0x10000;
      borrow = 1;
    } else {
      a[i] = diff;
      borrow = 0;
    }
  }
}

function limbsBitLength(a: number[]): number {
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

function limbsShiftLeft(a: number[], bits: number): number[] {
  const limbShift = Math.floor(bits / 16);
  const bitShift = bits % 16;
  const out: number[] = new Array(a.length + limbShift + 1).fill(0);
  for (let i = 0; i < a.length; i += 1) {
    const value = a[i] << bitShift;
    out[i + limbShift] |= value & 0xffff;
    out[i + limbShift + 1] |= value >>> 16;
  }
  return out;
}

function limbsShiftRightInPlace(a: number[], bits: number): void {
  const limbShift = Math.floor(bits / 16);
  const bitShift = bits % 16;
  for (let i = 0; i < a.length; i += 1) {
    const source = i + limbShift;
    let value = source < a.length ? a[source] >>> bitShift : 0;
    if (bitShift > 0 && source + 1 < a.length) value |= a[source + 1] << (16 - bitShift);
    a[i] = value & 0xffff;
  }
}

// 二进制长除法求 a mod n
function limbsMod(a: number[], n: number[]): number[] {
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

function limbsMul(a: number[], b: number[]): number[] {
  const out: number[] = new Array(a.length + b.length).fill(0);
  for (let i = 0; i < a.length; i += 1) {
    let carry = 0;
    for (let j = 0; j < b.length; j += 1) {
      // 16 位肢乘积与行累加都在 2^53 精度内
      const sum = out[i + j] + a[i] * b[j] + carry;
      out[i + j] = sum & 0xffff;
      carry = Math.floor(sum / 0x10000);
    }
    let index = i + b.length;
    while (carry > 0 && index < out.length) {
      const sum = out[index] + carry;
      out[index] = sum & 0xffff;
      carry = Math.floor(sum / 0x10000);
      index += 1;
    }
  }
  while (out.length > 0 && out[out.length - 1] === 0) out.pop();
  return out;
}

function limbsMulMod(a: number[], b: number[], n: number[]): number[] {
  return limbsMod(limbsMul(a, b), n);
}

function limbsFromBytes(bytes: number[]): number[] {
  const limbs: number[] = [];
  for (let i = bytes.length - 2; i >= 0; i -= 2) {
    limbs.push((bytes[i] << 8) | bytes[i + 1]);
  }
  if (bytes.length % 2 === 1) limbs.push(bytes[0]);
  while (limbs.length > 0 && limbs[limbs.length - 1] === 0) limbs.pop();
  return limbs;
}

function limbsToBytes(a: number[], length: number): number[] {
  const bytes: number[] = new Array(length).fill(0);
  for (let i = 0; i < a.length && i * 2 < length; i += 1) {
    bytes[length - 2 - i * 2] = (a[i] >>> 8) & 0xff;
    bytes[length - 1 - i * 2] = a[i] & 0xff;
  }
  return bytes;
}

function limbsExpMod(base: number[], exponent: number, n: number[]): number[] {
  if (limbsEqualZero(n)) return [];
  const bits: number[] = [];
  for (let value = exponent; value > 0; value = Math.floor(value / 2)) bits.push(value % 2);
  let result = limbsFromBytes([1]);
  for (let i = bits.length - 1; i >= 0; i -= 1) {
    result = limbsMulMod(result, result, n);
    if (bits[i]) result = limbsMulMod(result, base, n);
  }
  return result;
}

// ---------- MD5 ----------

const MD5_SINES: number[] = md5Sines();

function md5Sines(): number[] {
  const sines: number[] = [];
  for (let i = 0; i < 64; i += 1) {
    sines.push(Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000));
  }
  return sines;
}

function rotateLeft(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000)
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
  }
  return bytes;
}

const MD5_SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

export function md5Hex(text: string): string {
  const message = utf8Bytes(text);
  const bitLength = message.length * 8;
  message.push(0x80);
  while (message.length % 64 !== 56) message.push(0);
  // 64 位小端长度；本场景消息远小于 2^32 字节，高 32 位恒为 0
  message.push(
    bitLength & 0xff,
    (bitLength >>> 8) & 0xff,
    (bitLength >>> 16) & 0xff,
    (bitLength >>> 24) & 0xff,
  );
  message.push(0, 0, 0, 0);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const words: number[] = new Array(16).fill(0);
  for (let chunk = 0; chunk < message.length; chunk += 64) {
    for (let i = 0; i < 16; i += 1) {
      const base = chunk + i * 4;
      words[i] =
        (message[base] |
          (message[base + 1] << 8) |
          (message[base + 2] << 16) |
          (message[base + 3] << 24)) >>>
        0;
    }
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const sum = (a + f + MD5_SINES[i] + words[g]) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotateLeft(sum, MD5_SHIFTS[Math.floor(i / 16) * 4 + (i % 4)])) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  return [a0, b0, c0, d0].map(toLittleEndianHex).join('');
}

function byteHex(value: number): string {
  const hex = value.toString(16);
  return value < 16 ? '0' + hex : hex;
}

function toLittleEndianHex(word: number): string {
  let hex = '';
  for (let i = 0; i < 4; i += 1) {
    hex += byteHex((word >>> (i * 8)) & 0xff);
  }
  return hex;
}

// ---------- 对外接口 ----------

function rsaNoPadEncryptHex(message: number[]): string {
  const padded: number[] = new Array(RSA_BLOCK_BYTES).fill(0);
  const used = Math.min(message.length, RSA_BLOCK_BYTES);
  for (let i = 0; i < used; i += 1) padded[i] = message[i];
  const result = limbsExpMod(limbsFromBytes(padded), LITE_EXPONENT, LITE_MODULUS);
  const bytes = limbsToBytes(result, RSA_BLOCK_BYTES);
  let hex = '';
  for (const byte of bytes) hex += byteHex(byte);
  return hex.toUpperCase();
}

export function h5Token(realToken: string): string {
  return 'h5' + rsaNoPadEncryptHex(utf8Bytes(H5_TOKEN_PREFIX + realToken));
}

function sortedParamsString(params: Record<string, string | number>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('');
}

export function signatureWebParams(params: Record<string, string | number>): string {
  return md5Hex(SIGNATURE_SALT + sortedParamsString(params) + SIGNATURE_SALT);
}

export function signatureWebParamsWithBody(
  params: Record<string, string | number>,
  body: string,
): string {
  return md5Hex(SIGNATURE_SALT + sortedParamsString(params) + body + SIGNATURE_SALT);
}

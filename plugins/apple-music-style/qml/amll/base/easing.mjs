/**
 * 三次贝塞尔缓动与基础钳制工具。
 *
 * AMLL 参考实现通过 bezier-easing 包提供相同语义，此处内置等价实现，
 * 保持 base 层零依赖（QML V4 与 Node 均可直接加载）。
 */

/** 将值钳制到 [0, 1] */
export function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

const NEWTON_MIN_SLOPE = 0.001;
const SUBDIVISION_PRECISION = 1e-7;
const SUBDIVISION_MAX_ITERATIONS = 24;

function aCoeff(a1, a2) {
  return 1.0 - 3.0 * a2 + 3.0 * a1;
}

function bCoeff(a1, a2) {
  return 3.0 * a2 - 6.0 * a1;
}

function cCoeff(a1) {
  return 3.0 * a1;
}

/** 贝塞尔参数曲线在 t 处的 x 值 */
function calcBezier(t, a1, a2) {
  return ((aCoeff(a1, a2) * t + bCoeff(a1, a2)) * t + cCoeff(a1)) * t;
}

/** 贝塞尔参数曲线在 t 处的 x 导数 */
function slope(t, a1, a2) {
  return 3.0 * aCoeff(a1, a2) * t * t + 2.0 * bCoeff(a1, a2) * t + cCoeff(a1);
}

function newtonRaphson(x, guess, a1, a2) {
  let t = guess;
  for (let i = 0; i < 8; i++) {
    const currentSlope = slope(t, a1, a2);
    if (currentSlope === 0) return t;
    const currentX = calcBezier(t, a1, a2) - x;
    t -= currentX / currentSlope;
  }
  return t;
}

function binarySubdivide(x, start, end, a1, a2) {
  let lo = start;
  let hi = end;
  let t = 0;
  for (let i = 0; i < SUBDIVISION_MAX_ITERATIONS; i++) {
    t = lo + (hi - lo) / 2;
    const currentX = calcBezier(t, a1, a2) - x;
    if (Math.abs(currentX) < SUBDIVISION_PRECISION) return t;
    if (currentX > 0) hi = t;
    else lo = t;
  }
  return t;
}

/**
 * 由目标 x 反解贝塞尔参数 t。
 *
 * x(t) 在 x1、x2 ∈ [0,1] 时单调，牛顿法失效时二分法必然收敛。
 */
function bezierTForX(x, x1, x2) {
  const guess = newtonRaphson(x, x, x1, x2);
  if (guess >= 0 && guess <= 1 && Math.abs(calcBezier(guess, x1, x2) - x) < SUBDIVISION_PRECISION) {
    return guess;
  }
  return binarySubdivide(x, 0, 1, x1, x2);
}

/**
 * 构造三次贝塞尔缓动函数，语义同 CSS `cubic-bezier()` / bezier-easing 包。
 * @param {number} x1 控制点 1 横坐标，须在 [0,1]
 * @param {number} y1 控制点 1 纵坐标
 * @param {number} x2 控制点 2 横坐标，须在 [0,1]
 * @param {number} y2 控制点 2 纵坐标
 * @returns {(x: number) => number} 输入 [0,1] 时间进度，输出 [0,1] 缓动值
 */
export function bezier(x1, y1, x2, y2) {
  if (!(x1 >= 0 && x1 <= 1 && x2 >= 0 && x2 <= 1)) {
    throw new RangeError(`bezier 控制点横坐标必须在 [0,1]：${x1}, ${x2}`);
  }
  if (x1 === y1 && x2 === y2) {
    return (t) => clamp01(t);
  }
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return calcBezier(bezierTForX(x, x1, x2), y1, y2);
  };
}

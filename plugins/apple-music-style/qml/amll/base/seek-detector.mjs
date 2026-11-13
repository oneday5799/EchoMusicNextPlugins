/**
 * 跳转状态自动推导器，移植自 AMLL base/seek-detector.ts。
 *
 * 让下游使用者只推送播放进度、无需自己判断某次进度变化是否为跳转。
 * 判定思路：把本次媒体时钟的推进量与当前播放状态下它应有的推进量比较，
 * 超出容差的偏离即视为跳转：
 * - 进度倒退视为跳转
 * - 播放时应有的推进量是物理时钟的推进量，容差随之按比例放宽
 * - 暂停时应有的推进量是零，容差只留固定底限
 */

/** 媒体时钟偏离期望推进量时的固定底限容差（毫秒） */
const JITTER_TOLERANCE = 150;

/** 媒体时钟相对于物理时钟允许的动态漂移比例 */
const DRIFT_SLACK = 0.5;

/** 单次判定所信任的最大物理时钟跨度（毫秒） */
const MAX_TRUSTED_GAP = 800;

/**
 * 读取单调递增的物理时钟的函数，单位为毫秒
 * @type {() => number}
 */
const defaultWallClock = () =>
  typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

export class SeekDetector {
  // 注意：QML V4 引擎不支持 class fields 语法（Qt 6.12 实测），
  // 字段一律在构造函数里赋值
  /**
   * @param {() => number} [now] 物理时钟读取函数，默认 performance.now / Date.now
   */
  constructor(now = defaultWallClock) {
    this.now = now;
    this.lastMediaTime = 0;
    this.lastWallTime = 0;
    this.hasBaseline = false;
  }

  /**
   * 推导本次进度变化是否为跳转
   * @param {number} time 下游推送的当前播放进度（毫秒）
   * @param {boolean} isPlaying 当前是否在播放，决定本次推送应有的推进量与容差
   * @returns {boolean} 是否应当按跳转处理
   */
  detect(time, isPlaying) {
    const wall = this.now();

    // 没有基线可比，无从推导，此时不视为跳转。
    // 需要强制对齐的场合（重新构建歌词、页面恢复等）由调用方显式传入跳转状态，
    // 无需在这里代为判断；在这里报告跳转会让恢复播放这类本质连续的场景被当作跳转
    if (!this.hasBaseline) {
      this.rebase(time, wall);
      this.hasBaseline = true;
      return false;
    }

    // 进度倒退始终按跳转处理
    if (time < this.lastMediaTime) {
      this.rebase(time, wall);
      return true;
    }

    const mediaDelta = time - this.lastMediaTime;
    const elapsed = Math.max(0, wall - this.lastWallTime);
    const wallDelta = Math.min(elapsed, MAX_TRUSTED_GAP);

    this.rebase(time, wall);

    // 暂停时进度本不该前进，因此应有的推进量是零，容差也只留固定底限，
    // 任何超过抖动幅度的前进都是跳转。
    // 播放时才以物理时钟应有的推进量为基准，并按其比例放宽容差，
    // 以容纳倍速播放与推送节奏的不均匀
    const expected = isPlaying ? wallDelta : 0;
    const tolerance = isPlaying
      ? Math.max(JITTER_TOLERANCE, wallDelta * DRIFT_SLACK)
      : JITTER_TOLERANCE;

    const drift = mediaDelta - expected;

    return drift > tolerance;
  }

  reset() {
    this.hasBaseline = false;
    this.lastMediaTime = 0;
    this.lastWallTime = 0;
  }

  rebase(time, wall) {
    this.lastMediaTime = time;
    this.lastWallTime = wall;
  }
}

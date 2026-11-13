/**
 * 滚动交互引擎，移植自 AMLL base/scroll.ts。
 *
 * AMLL 原版绑定 DOM 事件并用 RAF/定时器自驱；本移植把事件入口改为显式方法
 * （由 QML 的 WheelHandler/DragHandler 调用），把惯性步进与滚轮空闲判定合并进
 * 逐帧 `tick(now)`（由中央帧循环驱动），状态机语义保持一致：
 * - 触摸位移超过 10px 才确认滑动意图
 * - 松手后按 `speed *= 0.95^(dt/16.67ms)` 惯性衰减，|speed| ≤ 0.05 结束
 * - 滚轮直接叠加偏移量，150ms 无输入视为滚动结束
 * - 滚动静止 500ms 后才允许恢复自动对齐
 */

/**
 * @typedef {"touch" | "wheel"} ScrollInputType
 */

/**
 * 滚动引擎回调
 * @typedef {object} ScrollEngineHooks
 * @property {(isContinuous: boolean) => void} onScrollUpdate
 *   滚动偏移量变化时高频触发。连续输入（触摸/惯性）时上层应绕过弹簧直接照着
 *   偏移量重新布局；低频离散步进（滚轮）时保留弹簧以展示步进间平滑动画
 * @property {(type: ScrollInputType) => void} onInteractionStart
 *   用户明确产生滑动意图（触摸超过 10px）或使用滚轮时触发，一般在此暂停模糊与自动跟随
 */

/** 滚动静止后允许在歌词焦点切换时恢复自动对齐的等待时间（毫秒） */
const AUTO_ALIGN_RESUME_DELAY_MS = 500;

/** 滚轮交互结束防抖时间（毫秒） */
const WHEEL_IDLE_TIMEOUT_MS = 150;

/** 惯性动画基准物理帧时间（毫秒） */
const BASE_FRAME_DURATION_MS = 1000 / 60;

/** 惯性单帧最大跨度阈值，超过 100ms 视为掉帧并丢弃当前步进 */
const MAX_INERTIA_FRAME_DELTA_MS = 100;

const defaultWallClock = () =>
  typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

export class ScrollInteractionEngine {
  // 注意：QML V4 引擎不支持 class fields 语法（Qt 6.12 实测），
  // 字段一律在构造函数里赋值
  /**
   * @param {ScrollEngineHooks} hooks
   * @param {() => number} [now] 物理时钟，默认 performance.now / Date.now
   */
  constructor(hooks, now = defaultWallClock) {
    /** @type {ScrollEngineHooks} */
    this.hooks = hooks;
    this.now = now;

    this.offset = 0;
    this.minOffset = 0;
    this.maxOffset = 0;

    this.touchState = {
      startY: 0,
      startX: 0,
      lastY: 0,
      startOffset: 0,
      /** 触摸速度，px/ms，方向与屏幕滑动方向一致 */
      speed: 0,
      lastTimestamp: 0,
      /** 是否已经突破 10px 意图阈值 */
      isIntentConfirmed: false,
    };

    /**
     * 记录触摸开始时被打断的既有状态
     */
    this.interruptedState = {
      hadInertia: false,
      hadTimer: false,
      wasInteracting: false,
    };

    /** 惯性动画是否正在进行 */
    this.inertiaActive = false;
    this.inertiaLastFrameTime = 0;
    /** 滚动结束时刻（毫秒），undefined 表示从未滚动或已被重置 */
    this.scrollEndTime = undefined;
    this.isInteracting = false;
    /** 最近一次输入类型，滚轮空闲判定使用 */
    this.lastInputType = undefined;
    this.lastInputTime = 0;
  }

  //#region 生命周期控制
  startInteraction(type) {
    this.scrollEndTime = undefined;
    if (!this.isInteracting) {
      this.isInteracting = true;
      this.hooks.onInteractionStart(type);
    }
  }

  endInteraction() {
    this.isInteracting = false;
    this.clearTimers();
    this.scrollEndTime = this.now();
  }
  //#endregion

  //#region 输入入口（由 QML 输入处理器调用）
  /**
   * 触摸开始。多指时由调用方改用 {@link reanchorTouch}
   * @param {number} x 屏幕坐标
   * @param {number} y 屏幕坐标
   * @param {number} ts 事件时间戳（毫秒）
   */
  beginTouch(x, y, ts) {
    // 记录被打断的既有状态
    this.interruptedState.hadInertia = this.inertiaActive;
    this.interruptedState.hadTimer =
      this.lastInputType === 'wheel' &&
      this.isInteracting &&
      ts - this.lastInputTime < WHEEL_IDLE_TIMEOUT_MS;
    this.interruptedState.wasInteracting = this.isInteracting;

    this.clearTimers();

    const state = this.touchState;
    state.startY = y;
    state.startX = x;
    state.lastY = y;
    state.startOffset = this.offset;
    state.lastTimestamp = ts;
    state.speed = 0;
    state.isIntentConfirmed = false;
  }

  /**
   * 多指触摸时把基准点重锚定到最新/剩余的手指，不重置交互状态
   */
  reanchorTouch(x, y, ts) {
    const state = this.touchState;
    state.startY = y;
    state.startX = x;
    state.lastY = y;
    state.startOffset = this.offset;
    state.lastTimestamp = ts;
    state.speed = 0;
  }

  /**
   * 触摸移动。位移超过 10px 时确认滑动意图并开始交互
   * @returns {boolean} 本次移动是否确认了滑动意图
   */
  moveTouch(x, y, ts) {
    const state = this.touchState;

    const deltaY = y - state.startY;
    const deltaX = x - state.startX;

    if (!state.isIntentConfirmed) {
      // 手指移动超过 10px，认为是滑动
      if (Math.abs(deltaY) > 10 || Math.abs(deltaX) > 10) {
        state.isIntentConfirmed = true;
        this.lastInputType = 'touch';
        this.lastInputTime = ts;
        this.startInteraction('touch');
      } else {
        return false;
      }
    }

    this.offset = this.clampOffset(state.startOffset - (y - state.startY));

    const dtMs = ts - state.lastTimestamp;
    if (dtMs > 0) {
      state.speed = (y - state.lastY) / dtMs;
    }

    state.lastY = y;
    state.lastTimestamp = ts;

    this.hooks.onScrollUpdate(true);
    return true;
  }

  /**
   * 触摸结束。速度足够时启动惯性滚动
   * @param {number} ts 事件时间戳（毫秒）
   */
  endTouch(ts) {
    const state = this.touchState;

    if (!state.isIntentConfirmed) {
      const { hadInertia, hadTimer, wasInteracting } = this.interruptedState;

      if (hadInertia || hadTimer || wasInteracting) {
        this.endInteraction();
      }

      return;
    }

    state.isIntentConfirmed = false;
    state.startY = 0;

    if (Math.abs(state.speed) < 0.1) {
      state.speed = 0;
    }

    if (Math.abs(state.speed) > 0.05) {
      this.inertiaActive = true;
      this.inertiaLastFrameTime = this.now();
    } else {
      this.endInteraction();
    }
  }

  /**
   * 触摸取消。意图未确认时按「打断既有状态」处理，否则立即静止
   */
  cancelTouch() {
    const state = this.touchState;

    if (!state.isIntentConfirmed) {
      const { hadInertia, hadTimer, wasInteracting } = this.interruptedState;

      if (hadInertia || hadTimer || wasInteracting) {
        this.endInteraction();
      }

      return;
    }

    state.speed = 0;
    state.startY = 0;

    this.endInteraction();
  }

  /**
   * 滚轮输入。偏移量直接叠加并重置空闲计时
   * @param {number} deltaY 滚轮纵向增量；像素模式直接叠加，行/页模式按 AMLL 语义放大 50 倍
   * @param {boolean} isPixelMode 增量是否为像素单位
   */
  wheel(deltaY, isPixelMode) {
    const now = this.now();
    this.clearTimers();
    this.lastInputType = 'wheel';
    this.lastInputTime = now;
    this.startInteraction('wheel');

    this.offset += isPixelMode ? deltaY : deltaY * 50;

    this.offset = this.clampOffset(this.offset);
    this.hooks.onScrollUpdate(false);
  }
  //#endregion

  //#region 逐帧驱动
  /**
   * 帧循环驱动：推进惯性滚动并判定滚轮空闲结束。
   * 由宿主中央帧动画每帧调用
   * @param {number} [now] 当前物理时钟毫秒数
   */
  tick(now = this.now()) {
    // 滚轮空闲 150ms 视为滚动结束（等价 AMLL 的 wheel setTimeout）
    if (
      this.isInteracting &&
      this.lastInputType === 'wheel' &&
      !this.inertiaActive &&
      now - this.lastInputTime >= WHEEL_IDLE_TIMEOUT_MS
    ) {
      this.endInteraction();
    }

    if (!this.inertiaActive) return;

    const dtMs = now - this.inertiaLastFrameTime;
    this.inertiaLastFrameTime = now;
    const state = this.touchState;

    // 掉帧或页面切换：丢弃当前步进
    if (dtMs <= 0 || dtMs > MAX_INERTIA_FRAME_DELTA_MS) return;

    if (Math.abs(state.speed) > 0.05) {
      this.offset -= state.speed * dtMs;
      this.offset = this.clampOffset(this.offset);

      // 按基准帧时间换算衰减步数
      const steps = dtMs / BASE_FRAME_DURATION_MS;
      state.speed *= Math.pow(0.95, steps);

      this.hooks.onScrollUpdate(true);
    } else {
      this.inertiaActive = false;
      this.endInteraction();
    }
  }
  //#endregion

  /**
   * 将给定的偏移量限制在当前的 [minOffset, maxOffset] 边界内
   */
  clampOffset(val) {
    const min = Math.min(this.minOffset, this.maxOffset);
    const max = Math.max(this.minOffset, this.maxOffset);
    return Math.min(Math.max(val, min), max);
  }

  /**
   * 滚动结束是否已超过 500ms 自动对齐恢复等待时间
   */
  canResumeAutoAlign(now = this.now()) {
    return (
      this.scrollEndTime !== undefined && now - this.scrollEndTime >= AUTO_ALIGN_RESUME_DELAY_MS
    );
  }

  /**
   * 更新允许的滚动边界，并返回钳制后的实际 offset。
   *
   * 在歌词发生排版变化（resize、新歌词、行高改变等）时调用，确保滚动不越界
   * @param {number} min
   * @param {number} max
   * @returns {number} 钳制后的偏移量
   */
  updateBoundary(min, max) {
    this.minOffset = Math.min(0, min);
    this.maxOffset = Math.max(0, max);

    this.offset = this.clampOffset(this.offset);
    return this.offset;
  }

  /**
   * 覆盖当前的滚动偏移量并终止正在进行的惯性动画或等待状态。
   *
   * 用于清空全部用户手势带来的临时滚动状态，例如点击歌词行触发 Seek、
   * 切歌、或焦点切换时恢复自动对齐
   * @param {number} [targetOffset]
   */
  resetScroll(targetOffset = 0) {
    this.clearTimers();
    this.scrollEndTime = undefined;

    this.isInteracting = false;
    this.touchState.isIntentConfirmed = false;
    this.touchState.speed = 0;
    this.touchState.startY = 0;
    this.touchState.lastY = 0;
    this.touchState.lastTimestamp = 0;

    this.offset = this.clampOffset(targetOffset);
  }

  /**
   * 停止惯性动画并清理临时状态
   */
  clearTimers() {
    this.inertiaActive = false;
  }

  dispose() {
    this.clearTimers();
    this.scrollEndTime = undefined;
  }
}

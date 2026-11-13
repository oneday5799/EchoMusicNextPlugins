/**
 * 排版布局计算器，移植自 AMLL base/layout.ts。
 *
 * 基于歌词行高度数组维护前缀和，按焦点目标与对齐配置推导每帧的
 * 滚动边界与逐行渲染指令（Y 坐标 / 是否在视口内）。
 * 两阶段接口：`beginFrame` 解析焦点度量并给出滚动安全边界，
 * 由调用方把边界交给滚动引擎钳制后，`commit` 生成最终渲染指令。
 */

import { LayoutAlignAnchor } from './consts.mjs';

/**
 * 布局对齐的静态配置项
 * @typedef {object} LayoutConfig
 * @property {string} alignAnchor 自动对齐的锚点（LayoutAlignAnchor）
 * @property {number} alignPosition 0.0 - 1.0 的视口相对位置
 * @property {number} overscanPx 视口上下额外保留的预渲染距离（像素）
 */

/**
 * 每一帧都可能变化的排版上下文状态
 * @typedef {object} LayoutFrameContext
 * @property {number} containerHeight 播放器容器当前总高度
 * @property {number} scrollOffset 被滚动引擎钳制后的安全滚动量
 * @property {import("./focus.mjs").FocalTarget} target 当前视口焦点目标
 * @property {number} bottomLineHeight 底栏高度（本插件恒为 0）
 * @property {{ totalHeight: number, anchorIndex: number } | undefined} interlude
 *   间奏点状态：高度与挂载锚点行；无间奏时为 undefined
 */

/**
 * 单行歌词的渲染几何指令
 * @typedef {object} RenderInstruction
 * @property {number} y 当前行歌词的 Y 轴绝对目标坐标
 * @property {number} height 当前行歌词的高（测量值或估算值）
 * @property {boolean} isInViewport 当前是否在可视区域（含 Overscan 容差）内
 */

/**
 * 排版计算返回的复合结果
 * @typedef {object} LayoutResult
 * @property {number} lineCount 本次排版计算的有效歌词行数
 * @property {ReadonlyArray<RenderInstruction>} lineInstructions 渲染指令池（复用，遍历以 lineCount 为界）
 * @property {boolean} hasInterlude 是否需要显示间奏点
 * @property {number} interludeY 间奏点的 Y 轴绝对坐标
 * @property {number} bottomLineY 底栏的 Y 轴绝对坐标
 * @property {boolean} isBottomLineInViewport 底栏是否在可视范围内
 */

/** @typedef {{ isValid: boolean, focalTopY: number, anchorOffset: number, interludeTotalHeight: number, activeInterludeAnchor: number | undefined }} ResolvedLayoutMetrics */

/** 单帧排版会话句柄（beginFrame 产出，commit 消费）
 * @typedef {ResolvedLayoutMetrics & { containerHeight: number, alignPosition: number, overscanPx: number, bottomLineHeight: number }} LayoutFrameSession
 */

export class LayoutCalculator {
  // 注意：QML V4 引擎不支持 class fields 语法（Qt 6.12 实测），
  // 字段一律在构造函数里赋值
  constructor() {
    /**
     * 前缀和缓存，长度为歌词行数 + 1。
     * prefixSums[i] 存储第 0 行到第 i-1 行的总高度，不包含间奏点
     * （普通数组而非 Float64Array：QML V4 的严格模式下越界 typed array
     * 写入会抛 TypeError，而规范要求静默忽略——initHeights 之前的
     * calcLayout 就会踩中）
     */
    this.prefixSums = [];

    this.heights = [];
    /** 掩码：1 表示该行经历了真实测量，0 表示该行在使用 fallback 高度 */
    this.isMeasured = [];

    /** 渲染指令对象池，长度只增不减，避免 GC */
    /** @type {RenderInstruction[]} */
    this.instructionPool = [];
    this.isPrefixSumDirty = true;

    /** @type {ResolvedLayoutMetrics} */
    this.resolvedMetrics = {
      isValid: false,
      focalTopY: 0,
      anchorOffset: 0,
      interludeTotalHeight: 0,
      activeInterludeAnchor: undefined,
    };

    /** 全局唯一复用的返回结果实例 */
    this.layoutResult = {
      lineCount: 0,
      lineInstructions: this.instructionPool,
      bottomLineY: 0,
      isBottomLineInViewport: false,
      hasInterlude: false,
      interludeY: 0,
    };

    /** 缓存的歌词行数 */
    this.lyricCount = 0;
    /** 缓存的所有歌词总高度 */
    this.totalLyricHeight = 0;
  }

  /**
   * 初始化排版空间结构与高度缓存。在加载新歌词时调用
   * @param {number} count 歌词总行数
   * @param {number} defaultHeight 尚未渲染/测量的行的默认回退高度
   */
  initHeights(count, defaultHeight) {
    this.lyricCount = count;

    this.resetLayoutResult();

    if (this.prefixSums.length < count + 1) {
      this.prefixSums = new Array(count + 1).fill(0);
      this.heights = new Array(count);
      this.isMeasured = new Array(count);
    } else {
      this.prefixSums.fill(0);
    }

    for (let i = 0; i < count; i++) {
      this.heights[i] = defaultHeight;
      this.isMeasured[i] = 0;
    }

    this.isPrefixSumDirty = true;

    const currentPoolSize = this.instructionPool.length;
    if (count > currentPoolSize) {
      for (let i = currentPoolSize; i < count; i++) {
        this.instructionPool.push({
          y: 0,
          height: 0,
          isInViewport: false,
        });
      }
    }
  }

  /**
   * 获取指定索引歌词行的计算高度（可能为测量值或估算值）
   * @param {number} index
   * @returns {number}
   */
  getLineHeight(index) {
    if (index < 0 || index >= this.lyricCount) return 0;
    this.ensurePrefixSums();
    return this.prefixSums[index + 1] - this.prefixSums[index];
  }

  /**
   * 设置单行歌词的真实测量高度
   * @param {number} index
   * @param {number} height
   */
  setLineHeight(index, height) {
    if (index < 0 || index >= this.lyricCount) return;

    // 只有高度发生变化，或者该行原本是估算值时，才标记脏数据
    if (this.heights[index] !== height || this.isMeasured[index] === 0) {
      this.heights[index] = height;
      this.isMeasured[index] = 1;
      this.isPrefixSumDirty = true;
    }
  }

  /**
   * 批量更新所有未测量行的回退高度。
   *
   * 仅在容器 Resize 等会导致回退基准（containerHeight / 5）发生变化时调用，
   * 已被真实测量的行不受影响
   * @param {number} defaultHeight
   */
  updateUnmeasuredHeights(defaultHeight) {
    let changed = false;
    for (let i = 0; i < this.lyricCount; i++) {
      if (this.isMeasured[i] === 0 && this.heights[i] !== defaultHeight) {
        this.heights[i] = defaultHeight;
        changed = true;
      }
    }
    if (changed) {
      this.isPrefixSumDirty = true;
    }
  }

  /**
   * 解析焦点度量并计算物理滚动边界。
   *
   * 返回滚动安全闭区间 `{ min, max }` 以及本帧会话句柄；调用方把边界交给
   * ScrollInteractionEngine.updateBoundary 钳制 scrollOffset 后传给 commit
   * @param {LayoutFrameContext} ctx
   * @param {LayoutConfig} config
   * @returns {{ bounds: { min: number, max: number }, session: LayoutFrameSession }}
   */
  beginFrame(ctx, config) {
    this.ensurePrefixSums();

    const metrics = this.resolveLayoutMetrics(ctx, config);

    const session = {
      isValid: metrics.isValid,
      focalTopY: metrics.focalTopY,
      anchorOffset: metrics.anchorOffset,
      interludeTotalHeight: metrics.interludeTotalHeight,
      activeInterludeAnchor: metrics.activeInterludeAnchor,
      containerHeight: ctx.containerHeight,
      alignPosition: config.alignPosition,
      overscanPx: config.overscanPx,
      bottomLineHeight: ctx.bottomLineHeight,
    };

    if (!metrics.isValid) {
      return { bounds: { min: 0, max: 0 }, session };
    }

    const { focalTopY, anchorOffset, interludeTotalHeight, activeInterludeAnchor } = metrics;

    const minOffset = Math.min(0, -focalTopY);

    const basePosWithoutScroll =
      -focalTopY + ctx.containerHeight * config.alignPosition - anchorOffset;

    let totalContentHeight = this.totalLyricHeight;
    if (activeInterludeAnchor !== undefined) {
      totalContentHeight += interludeTotalHeight;
    }

    const rawMaxOffset = basePosWithoutScroll + totalContentHeight - ctx.containerHeight / 2;
    const maxOffset = Math.max(0, rawMaxOffset);

    return { bounds: { min: minOffset, max: maxOffset }, session };
  }

  /**
   * 基于已钳制的 scrollOffset 和第一阶段的会话句柄提交排版并生成指令
   * @param {LayoutFrameSession} session
   * @param {number} scrollOffset
   * @returns {LayoutResult}
   */
  commit(session, scrollOffset) {
    this.ensurePrefixSums();

    if (!session.isValid) {
      return this.resetLayoutResult();
    }

    this.layoutResult.lineCount = this.lyricCount;

    const {
      focalTopY,
      anchorOffset,
      interludeTotalHeight,
      activeInterludeAnchor,
      containerHeight,
      alignPosition,
      overscanPx,
      bottomLineHeight,
    } = session;

    const viewportStartY =
      containerHeight * alignPosition - anchorOffset - scrollOffset - focalTopY;

    const motionBuffer = containerHeight * 0.4;
    const viewportTopBound = -overscanPx - motionBuffer;
    const viewportBottomBound = containerHeight + overscanPx + motionBuffer;

    for (let i = 0; i < this.lyricCount; i++) {
      const instruction = this.instructionPool[i];
      let lineY = viewportStartY + this.prefixSums[i];
      const lineH = this.prefixSums[i + 1] - this.prefixSums[i];

      if (activeInterludeAnchor !== undefined && i > activeInterludeAnchor) {
        lineY += interludeTotalHeight;
      }

      instruction.y = lineY;
      instruction.height = lineH;
      instruction.isInViewport = lineY <= viewportBottomBound && lineY + lineH >= viewportTopBound;
    }

    if (activeInterludeAnchor !== undefined) {
      this.layoutResult.hasInterlude = true;
      this.layoutResult.interludeY = viewportStartY + this.prefixSums[activeInterludeAnchor + 1];
    } else {
      this.layoutResult.hasInterlude = false;
      this.layoutResult.interludeY = 0;
    }

    let bottomY = viewportStartY + this.totalLyricHeight;
    if (activeInterludeAnchor !== undefined) {
      bottomY += interludeTotalHeight;
    }

    this.layoutResult.bottomLineY = bottomY;
    this.layoutResult.isBottomLineInViewport =
      bottomY <= viewportBottomBound && bottomY + bottomLineHeight >= viewportTopBound;

    return this.layoutResult;
  }

  /**
   * 解析当前排版帧所对应的间奏点挂载锚点行索引
   * @param {{ anchorLineIndex: number } | undefined} interlude 当前时间线处于激活状态的间奏点信息
   * @param {import("./focus.mjs").FocalTarget} focalTarget 当前帧对齐的物理焦点
   * @returns {number | undefined}
   */
  static resolveInterludeAnchorIndex(interlude, focalTarget) {
    // 若处于间奏时间段内，优先使用活跃间奏的锚点行
    if (interlude) {
      return interlude.anchorLineIndex;
    }

    // 若用户正处于手势滑动中且焦点被冻结在间奏点，保持冻结焦点的锚点行
    if (focalTarget.type === 'interlude') {
      return focalTarget.anchorIndex;
    }
    return undefined;
  }

  /**
   * 如果高度发生过改变，则重新计算前缀和
   */
  ensurePrefixSums() {
    if (!this.isPrefixSumDirty) return;

    let sum = 0;
    this.prefixSums[0] = 0;
    for (let i = 0; i < this.lyricCount; i++) {
      sum += this.heights[i];
      this.prefixSums[i + 1] = sum;
    }
    this.totalLyricHeight = sum;
    this.isPrefixSumDirty = false;
  }

  /**
   * 公共的焦点度量与范围校验逻辑
   */
  resolveLayoutMetrics(ctx, config) {
    const interludeTotalHeight = ctx.interlude?.totalHeight ?? 0;
    const activeInterludeAnchor = ctx.interlude?.anchorIndex;

    this.resolvedMetrics.interludeTotalHeight = interludeTotalHeight;
    this.resolvedMetrics.activeInterludeAnchor = activeInterludeAnchor;

    if (
      this.lyricCount === 0 ||
      (ctx.target.type === 'line' &&
        (ctx.target.index < 0 || ctx.target.index >= this.lyricCount)) ||
      (ctx.target.type === 'interlude' &&
        (ctx.target.anchorIndex < -1 || ctx.target.anchorIndex >= this.lyricCount - 1))
    ) {
      this.resolvedMetrics.isValid = false;
      this.resolvedMetrics.focalTopY = 0;
      this.resolvedMetrics.anchorOffset = 0;
      return this.resolvedMetrics;
    }

    this.updateFocalMetrics(
      ctx.target,
      interludeTotalHeight,
      activeInterludeAnchor,
      ctx.bottomLineHeight,
      config,
    );

    this.resolvedMetrics.isValid = true;
    return this.resolvedMetrics;
  }

  /**
   * 测量对齐目标的几何信息
   */
  updateFocalMetrics(
    target,
    interludeTotalHeight,
    activeInterludeAnchor,
    bottomLineHeight,
    config,
  ) {
    let focalTopY = 0;
    let targetHeight = 0;

    if (target.type === 'line') {
      focalTopY = this.prefixSums[target.index];
      // 如果这行歌词前面存在间奏点，那么这行歌词已经被间奏点往下推了，需要加上 interludeTotalHeight
      if (activeInterludeAnchor !== undefined && target.index > activeInterludeAnchor) {
        focalTopY += interludeTotalHeight;
      }
      targetHeight = this.prefixSums[target.index + 1] - this.prefixSums[target.index];
    } else if (target.type === 'interlude') {
      focalTopY = this.prefixSums[target.anchorIndex + 1];
      targetHeight = interludeTotalHeight;
    } else if (target.type === 'bottom') {
      focalTopY = this.totalLyricHeight;
      if (activeInterludeAnchor !== undefined) {
        focalTopY += interludeTotalHeight;
      }
      targetHeight = bottomLineHeight;
    }

    this.resolvedMetrics.focalTopY = focalTopY;
    this.resolvedMetrics.anchorOffset = this.calculateAnchorOffset(
      config.alignAnchor,
      targetHeight,
    );
  }

  /**
   * 根据锚点与目标高度计算内部相对偏移
   */
  calculateAnchorOffset(alignAnchor, targetHeight) {
    if (targetHeight <= 0) return 0;

    switch (alignAnchor) {
      case LayoutAlignAnchor.Top:
        return 0;
      case LayoutAlignAnchor.Center:
        return targetHeight / 2;
      case LayoutAlignAnchor.Bottom:
        return targetHeight;
    }
    return 0;
  }

  /**
   * 重置排版结果为安全干净的状态（全部不可见/无底栏）
   */
  resetLayoutResult() {
    this.layoutResult.lineCount = 0;
    this.layoutResult.hasInterlude = false;
    this.layoutResult.interludeY = 0;
    this.layoutResult.bottomLineY = 0;
    this.layoutResult.isBottomLineInViewport = false;

    for (let i = 0; i < this.instructionPool.length; i++) {
      this.instructionPool[i].isInViewport = false;
      this.instructionPool[i].y = 0;
      this.instructionPool[i].height = 0;
    }

    return this.layoutResult;
  }
}

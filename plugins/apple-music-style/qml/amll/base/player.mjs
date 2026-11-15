/**
 * 歌词播放器编排核心，移植自 AMLL base/index.ts（LyricPlayerBase）。
 *
 * 包含歌词操作（数据管理/视图重建）、时间推进（跳转推导）、排版布局
 * （焦点/滚动边界/视觉状态推导）与逐帧动画推进；DOM 相关部分
 * （ResizeObserver/底栏/背景行）按宿主形态移植为显式调用接口，
 * 视觉应用由 QML 渲染层完成。
 */

import {
  LayoutAlignAnchor,
  LayoutReason,
  LayoutReasonStrategyMap,
  MAX_FRAME_DELTA,
} from './consts.mjs';
import { clampPositive } from './easing.mjs';
import { FocusController } from './focus.mjs';
import { InterludeDots } from './interlude.mjs';
import { LayoutCalculator } from './layout.mjs';
import { LyricLineCore, LyricLineGroupCore } from './line-group.mjs';
import { ScrollInteractionEngine } from './scroll.mjs';
import { SeekDetector } from './seek-detector.mjs';
import { getPosYSpringPolicy } from './spring.mjs';
import { TimelineController } from './timeline.mjs';

/** 活跃窗口向前后两端扩展保留亮度层副本的缓冲行数 */
const BRIGHTNESS_WINDOW_LINES = 2;

const defaultWallClock = () =>
  typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

/**
 * 歌词行数据（宿主适配层产出的规范形状）
 * @typedef {object} LyricLineData
 * @property {number} startTime 行开始时间（毫秒）
 * @property {number} endTime 行结束时间（毫秒）
 * @property {Array<{ startTime: number, endTime: number, word: string }>} words 逐词时间（非逐词歌词为单元素或空）
 * @property {string} [translation] 翻译文本
 * @property {string} [romanization] 音译文本
 * @property {boolean} [isDuet] 是否对唱行（用于间奏点右对齐）
 */

/**
 * 校验歌词时间戳满足基本数值约束（非负有限、start ≤ end），
 * 移植自 AMLL utils/validate-lyric.ts assertValidLyricTimestamps（本数据形状
 * 无 ruby，行与词两级足够）。坏数据抛出 TypeError/RangeError 早失败，
 * 而非静默流入时间线产生错乱排版
 * @param {LyricLineData[]} lines
 */
function assertValidLyricTimestamps(lines) {
  const assertTimestamp = (value, path) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      throw new TypeError(`Invalid lyric timestamp at ${path}: ${String(value)}`);
  };
  const assertRange = (value, path) => {
    assertTimestamp(value.startTime, `${path}.startTime`);
    assertTimestamp(value.endTime, `${path}.endTime`);
    if (value.startTime > value.endTime)
      throw new RangeError(
        `Invalid lyric timestamp range at ${path}: startTime ${value.startTime} > endTime ${value.endTime}`,
      );
  };
  for (let i = 0; i < lines.length; ++i) {
    const line = lines[i];
    assertRange(line, `lines[${i}]`);
    const words = line.words || [];
    for (let w = 0; w < words.length; ++w) assertRange(words[w], `lines[${i}].words[${w}]`);
  }
}

/**
 * 歌词数据管理器（AMLL LyricDataManager 的瘦身版）：
 * 掩码与优化管线按范围决策不移植，保留非动态歌词与对唱行检测。
 */
class LyricDataManager {
  // 注意：QML V4 引擎不支持 class fields 语法（Qt 6.12 实测），
  // 字段一律在构造函数里赋值
  constructor() {
    this.rawLines = [];
    this.processedLines = [];
    this.isDirty = true;
    this.isNonDynamic = false;
    this.hasDuetLine = false;
  }

  setOriginalLines(lines) {
    // AMLL 在克隆前校验时间戳（lyric-data-manager.ts:46 assertValidLyricTimestamps）：
    // 坏数据早失败而非静默产生错乱排版。本宿主歌词模型经 collectLines 构造，
    // 校验常态恒过，仅作防御
    assertValidLyricTimestamps(lines);
    // 数据来自宿主播放器，形状为纯 JSON；深拷贝阻断外部修改
    this.rawLines = JSON.parse(JSON.stringify(lines));
    this.isDirty = true;
  }

  getRawLines() {
    return this.rawLines;
  }

  getProcessedLines() {
    this.ensurePipeline();
    return this.processedLines;
  }

  getIsNonDynamic() {
    this.ensurePipeline();
    return this.isNonDynamic;
  }

  getHasDuetLine() {
    this.ensurePipeline();
    return this.hasDuetLine;
  }

  ensurePipeline() {
    if (!this.isDirty) return;
    this.processPipeline();
    this.isDirty = false;
  }

  processPipeline() {
    // 管线只读（isNonDynamic/hasDuetLine 判定），与 rawLines 共享引用即可；
    // AMLL 同位置再做一次 structuredClone（lyric-data-manager.ts:109）属冗余，
    // 本移植省去每轮切歌的第二次全量序列化
    this.processedLines = this.rawLines;

    let checkNonDynamic = true;
    let checkDuet = false;

    for (const line of this.processedLines) {
      if (line.words.length > 1) checkNonDynamic = false;
      if (line.isDuet) checkDuet = true;
    }

    this.isNonDynamic = checkNonDynamic && this.processedLines.length > 0;
    this.hasDuetLine = checkDuet;
  }
}

/**
 * 歌词播放器编排核心
 * @typedef {object} LyricPlayerHooks
 * @property {() => void} [onGroupsChanged] 歌词视图重建完成（组数量/顺序变化）后回调
 * @property {() => void} [onResize] 容器尺寸变化后回调
 */
export class LyricPlayerCore {
  // 注意：QML V4 引擎不支持 class fields 语法（Qt 6.12 实测），
  // 字段一律在构造函数里赋值
  /**
   * @param {LyricPlayerHooks} [hooks]
   * @param {{ now?: () => number }} [options]
   */
  constructor(hooks = {}, options = {}) {
    /** @type {LyricPlayerHooks} */
    this.hooks = hooks;
    this.now = options.now ?? defaultWallClock;

    this.isPlaying = false;
    this.timelineController = new TimelineController();
    this.seekDetector = new SeekDetector(this.now);
    this.enableAutoSeekDetection = true;

    this.hasBottomContent = false;
    this.disableSpring = false;

    this.dataManager = new LyricDataManager();

    /** 间奏点元素当前测量得到的尺寸 */
    this.layoutState = { interludeDotsSize: [0, 0] };

    this.layoutConfig = {
      alignAnchor: LayoutAlignAnchor.Center,
      alignPosition: 0.35,
      overscanPx: 300,
    };

    /** LayoutCalculator 所使用的排版上下文状态 */
    this.frameContext = {
      containerHeight: 0,
      scrollOffset: 0,
      target: { index: 0, type: 'line' },
      interlude: undefined,
    };

    /** 逐帧刷新的视觉推导派生值 */
    this.visualFrame = {
      /** 最靠后的高亮行，无高亮时回退到 scrollToIndex */
      latestIndex: 0,
      /** 已播放行的分界，hidePassedLines 启用时此行之前的歌词被隐藏 */
      passedBoundary: 0,
      /** 是否为窄视口，窄视口下模糊强度打折 */
      isNarrowViewport: false,
    };

    /** @type {InterludeDots} */
    this.interludeDots = new InterludeDots();
    this.enableBlur = true;
    this.enableScale = true;
    this.hidePassedLines = false;

    this.scrollState = {
      isAutoAlignSuspended: false,
      isTouchScrolled: false,
    };

    /** @type {ScrollInteractionEngine} */
    this.scrollEngine = new ScrollInteractionEngine(
      {
        onScrollUpdate: (isContinuous) => {
          this.calcLayout(
            isContinuous ? LayoutReason.ContinuousScroll : LayoutReason.DiscreteScroll,
          );
        },
        onInteractionStart: (type) => {
          this.scrollState.isAutoAlignSuspended = true;
          this.scrollState.isTouchScrolled = type === 'touch';
          this.calcLayout(LayoutReason.InteractionStart);
        },
      },
      this.now,
    );

    this.layoutCalculator = new LayoutCalculator();
    this.focusController = new FocusController();

    /** @type {LyricLineGroupCore[]} */
    this.currentLyricGroups = [];
    /** 每组最近一次上报的测量尺寸，去重测量回调 */
    this.lyricGroupSizes = [];
    /** 播放器视口尺寸 */
    this.size = [0, 0];
    this.isPageVisible = true;

    /** 文字扫掠渐变带宽度（相对主文字字体大小倍数，AMLL 默认 0.5） */
    this.wordFadeWidth = 0.5;

    this.posYSpringParams = {
      mass: 0.9,
      damping: 15,
      stiffness: 90,
    };
    this.scaleSpringParams = {
      mass: 2,
      damping: 25,
      stiffness: 100,
    };

    /** 间奏点上下边距所依据的主文字字体大小（像素） */
    this.baseFontSize = 24;

    this.interludeDots.setTransform(0, 200);
  }

  //#region 数据
  /**
   * 设置当前播放歌词
   * @param {LyricLineData[]} lines 歌词数组（传入后内部深拷贝，外部可安全释放）
   * @param {number} [initialTime] 初始时间
   */
  setLyricLines(lines, initialTime = 0) {
    this.dataManager.setOriginalLines(lines);
    this.rebuildLyricView(initialTime);
  }

  /** @returns {ReadonlyArray<LyricLineData>} 原始歌词数组 */
  getLyricLines() {
    return this.dataManager.getRawLines();
  }

  /** @returns {ReadonlyArray<LyricLineData>} 处理后的歌词数组 */
  get processedLines() {
    return this.dataManager.getProcessedLines();
  }

  /** 歌词是否为非动态歌词（逐行歌词） */
  get isNonDynamic() {
    return this.dataManager.getIsNonDynamic();
  }

  /** 歌词是否包含对唱行 */
  get hasDuetLine() {
    return this.dataManager.getHasDuetLine();
  }
  //#endregion

  //#region 配置
  /**
   * 设置文字动画的渐变带宽度（相对主文字字体大小倍数），默认 0.5。
   * 近乎禁用渐变可设 0.0001，不可为 0
   */
  setWordFadeWidth(value = 0.5) {
    this.wordFadeWidth = Math.max(0.0001, value);
  }

  getWordFadeWidth() {
    return this.wordFadeWidth;
  }

  /** 是否启用歌词行缩放效果，默认启用 */
  setEnableScale(enable = true) {
    this.enableScale = enable;
    this.calcLayout(LayoutReason.ConfigChange);
  }

  getEnableScale() {
    return this.enableScale;
  }

  setEnableBlur(enable) {
    if (this.enableBlur === enable) return;
    this.enableBlur = enable;
    this.calcLayout(LayoutReason.ConfigChange);
  }

  /** 设置是否隐藏已经播放过的歌词行，默认不隐藏 */
  setHidePassedLines(hide) {
    this.hidePassedLines = hide;
    this.calcLayout(LayoutReason.ConfigChange);
  }

  /** 设置对齐锚点（默认 center） */
  setAlignAnchor(alignAnchor) {
    this.layoutConfig.alignAnchor = alignAnchor;
  }

  /** 设置对齐位置，组件高度 [0,1] 比例，默认 0.35 */
  setAlignPosition(alignPosition) {
    this.layoutConfig.alignPosition = alignPosition;
  }

  /** 设置 overscan 视口缓冲距离（像素），默认 300 */
  setOverscanPx(px) {
    this.layoutConfig.overscanPx = clampPositive(px | 0);
  }

  getOverscanPx() {
    return this.layoutConfig.overscanPx;
  }

  /** 设置是否使用物理弹簧算法（关闭时位置直接吸附） */
  setEnableSpring(enable = true) {
    this.disableSpring = !enable;
    this.calcLayout(LayoutReason.ConfigChange);
  }

  getEnableSpring() {
    return !this.disableSpring;
  }

  /** 设置是否自动推导跳转状态，默认启用 */
  setEnableAutoSeekDetection(enable = true) {
    if (this.enableAutoSeekDetection === enable) return;
    this.enableAutoSeekDetection = enable;
    this.seekDetector.reset();
  }

  getEnableAutoSeekDetection() {
    return this.enableAutoSeekDetection;
  }

  setBaseFontSize(px) {
    this.baseFontSize = px;
  }

  /**
   * 更新所有歌词行与间奏点纵向弹簧参数（未提供的属性保持原样）
   * @param {Partial<SpringParams>} [params]
   */
  setLinePosYSpringParams(params = {}) {
    this.posYSpringParams = Object.assign(Object.assign({}, this.posYSpringParams), params);
    this.interludeDots.posY.updateParams(this.posYSpringParams);
    for (const group of this.currentLyricGroups) {
      group.posY.updateParams(this.posYSpringParams);
    }
  }

  /**
   * 更新所有歌词行缩放弹簧参数
   * @param {Partial<SpringParams>} [params]
   */
  setLineScaleSpringParams(params = {}) {
    this.scaleSpringParams = Object.assign(Object.assign({}, this.scaleSpringParams), params);
    for (const group of this.currentLyricGroups) {
      group.mainLine.scaleSpring.updateParams(this.scaleSpringParams);
    }
  }
  //#endregion

  //#region 时间
  /** @returns {boolean} 当前是否在播放 */
  getIsPlaying() {
    return this.isPlaying;
  }

  /**
   * 设置当前播放进度。内部根据调用间隔和播放进度自动决定应如何滚动和显示歌词。
   * 调用完成后应每帧调用 update 执行动画
   * @param {number} time 当前播放进度（毫秒），非有限值被忽略
   * @param {boolean} [isSeek] 是否强制按跳转处理，默认交由内部推导
   */
  setCurrentTime(time, isSeek = false) {
    if (!Number.isFinite(time)) return;

    const mediaTime = Math.round(time);

    // 探测器必须消费每一次进度推送才能维持内部状态正确，即使本次已被标记为跳转
    const isDetectedSeek = this.enableAutoSeekDetection
      ? this.seekDetector.detect(mediaTime, this.isPlaying)
      : false;

    this.syncTime(mediaTime, isSeek || isDetectedSeek);
  }

  /**
   * 推进时间线并把增量变化应用到视图状态上
   */
  syncTime(mediaTime, isSeek) {
    const wasFocusOnInterlude = this.timelineController.getSnapshot().isFocusOnInterlude;
    const diff = this.timelineController.sync(mediaTime, isSeek);

    // 间奏播放时，时间线没有任何差异，calcLayout 与 setInterlude 不会执行，
    // 演出时钟需要在这里对齐到推送的媒体时间，否则只能靠 update 的 delta 累加推进，
    // 页面挂起恢复后 delta 被钳制，时钟会落后于媒体时间
    this.interludeDots.syncClock(mediaTime);

    if (!diff.hasChanged) {
      return;
    }

    // 时间轴是否跳跃由时间线统一推导，除了传入的 isSeek 外还包含进度倒退的情况
    const isTimeJumped = diff.isTimeJumped;
    const snapshot = this.timelineController.getSnapshot();

    for (let i = 0; i < diff.removedHighlighted.length; i++) {
      this.currentLyricGroups[diff.removedHighlighted[i]]?.mainLine.disable();
    }

    if (isTimeJumped) {
      for (const index of snapshot.highlightedGroups) {
        this.currentLyricGroups[index]?.mainLine.enable();
      }
    } else {
      for (let i = 0; i < diff.addedHighlighted.length; i++) {
        this.currentLyricGroups[diff.addedHighlighted[i]]?.mainLine.enable();
      }
    }

    if (isTimeJumped) {
      if (!this.scrollState.isTouchScrolled) {
        this.resetScroll();
      }
    } else if (
      (diff.isScrollToChanged || wasFocusOnInterlude) &&
      !snapshot.isFocusOnInterlude &&
      snapshot.playingGroups.has(snapshot.scrollToIndex) &&
      this.scrollState.isAutoAlignSuspended &&
      this.scrollEngine.canResumeAutoAlign(this.now()) &&
      this.currentLyricGroups[snapshot.scrollToIndex]?.isInRenderRange(false)
    ) {
      this.resetScroll();
    }

    if (
      diff.isInterludeChanged ||
      diff.isScrollToChanged ||
      diff.isEndOfSongChanged ||
      isTimeJumped
    ) {
      this.updateSpringParams(!!snapshot.activeInterlude, isTimeJumped, snapshot.isEndOfSong);
    }

    this.calcLayout(isTimeJumped ? LayoutReason.Seek : LayoutReason.PlaybackTick);
  }

  /**
   * 更新歌词纵向滚动动画的弹簧参数。
   *
   * 策略：seeking 或间奏时使用更稳定的固定参数；普通播放时根据相邻歌词的
   * 时间间隔动态调整 stiffness / damping；播放完毕时使用中速参数
   */
  updateSpringParams(isInterludeActive, isSeeking, isEndOfSong) {
    if (!this.getEnableSpring() || this.currentLyricGroups.length === 0) {
      return;
    }

    const { scrollToIndex } = this.timelineController.getSnapshot();

    const currentGroup = this.currentLyricGroups[scrollToIndex];
    const prevGroup = this.currentLyricGroups[scrollToIndex - 1];

    let interval;
    if (currentGroup && prevGroup) {
      interval = currentGroup.startTime - prevGroup.startTime;
    }

    const policy = getPosYSpringPolicy(isSeeking, isInterludeActive, interval, isEndOfSong);

    this.setLinePosYSpringParams(policy);
  }

  /** 获取当前歌词的播放位置 */
  getCurrentTime() {
    return this.timelineController.getSnapshot().currentTime;
  }
  //#endregion

  //#region 视图构建
  /**
   * 重新构建歌词行和时间状态。
   * 一般在载入新歌词或视图结构变化后调用
   * @param {number} [initialTime] 重建后对齐的初始时间（毫秒），默认使用当前播放进度
   */
  rebuildLyricView(initialTime = this.getCurrentTime()) {
    this.resetScroll();
    this.focusController.reset();

    for (const group of this.currentLyricGroups) {
      group.mainLine.disable();
    }
    this.currentLyricGroups = [];
    this.lyricGroupSizes = [];

    this.interludeDots.clearInterlude(true);

    this.buildLyricGroups();

    // 对歌词组进行排序，确保滑动窗口与二分查找算法面对的时间线是严格升序的
    this.currentLyricGroups.sort((a, b) => a.startTime - b.startTime);

    const bounds = this.currentLyricGroups.map((group) => ({
      startTime: group.startTime,
      endTime: group.endTime,
    }));
    this.timelineController.setTimeBounds(bounds);

    this.layoutCalculator.initHeights(this.currentLyricGroups.length, this.defaultLineHeight);

    this.seekDetector.reset();
    this.setCurrentTime(initialTime, true);
    this.calcLayout(LayoutReason.RebuildView);

    // 与 DOM 层一致：重建后重放弹簧参数并驱动一帧
    this.setLinePosYSpringParams({});
    this.setLineScaleSpringParams({});
    this.update(0);

    this.hooks.onGroupsChanged?.();
  }

  /**
   * 由处理后的歌词数据构建歌词组
   */
  buildLyricGroups() {
    const lines = this.dataManager.getProcessedLines();
    for (let i = 0; i < lines.length; i++) {
      const lineCore = new LyricLineCore(lines[i], this);
      this.currentLyricGroups.push(new LyricLineGroupCore(lineCore, this));
    }
  }
  //#endregion

  //#region 排版
  /** 默认/回退单行歌词估算高度基准 (containerHeight / 5) */
  get defaultLineHeight() {
    return this.size[1] / 5;
  }

  /**
   * 获取指定索引歌词行的高度（可能为测量值或估算值）
   */
  getLineHeight(index) {
    return this.layoutCalculator.getLineHeight(index);
  }

  /**
   * 容器尺寸变化（QML 视图的 ResizeObserver 等价入口）
   */
  setSize(width, height) {
    if (this.size[0] === width && this.size[1] === height) return;
    this.size[0] = width;
    this.size[1] = height;
    this.layoutCalculator.updateUnmeasuredHeights(this.defaultLineHeight);
    this.calcLayout(LayoutReason.Resize);
    this.hooks.onResize?.();
  }

  /**
   * 歌词行测量结果上报（QML 视图测得真实高度后调用）
   */
  setGroupMeasured(index, width, height) {
    const group = this.currentLyricGroups[index];
    if (!group) return;
    const last = this.lyricGroupSizes[index];
    if (last && last[0] === width && last[1] === height) return;
    this.lyricGroupSizes[index] = [width, height];
    this.layoutCalculator.setLineHeight(index, height);
    this.calcLayout(LayoutReason.Resize);
  }

  /**
   * 间奏点尺寸测量上报
   */
  setInterludeMeasured(width, height) {
    const [lastW, lastH] = this.layoutState.interludeDotsSize;
    if (lastW === width && lastH === height) return;
    this.layoutState.interludeDotsSize[0] = width;
    this.layoutState.interludeDotsSize[1] = height;
    this.calcLayout(LayoutReason.Resize);
  }

  /**
   * 重新计算歌词行的几何排版坐标与视觉状态。
   *
   * 计算完成后，每一帧调用 update() 后由渲染层应用即可让歌词平滑移动至目标位置
   * @param {string} reason 触发排版布局更新的原因场景（LayoutReason）
   */
  calcLayout(reason) {
    const strategy = LayoutReasonStrategyMap[reason];

    const snapshot = this.timelineController.getSnapshot();
    const interlude = snapshot.activeInterlude;

    // 确定间奏演出状态与可用性
    let canDisplayInterlude = false;
    if (interlude) {
      canDisplayInterlude = this.interludeDots.setInterlude(
        [interlude.startTime, interlude.endTime],
        snapshot.currentTime,
        strategy.resetInterlude,
        interlude.anchorLineIndex,
      );
    } else {
      this.interludeDots.clearInterlude();
    }

    // 确定这一帧焦点应该对齐谁
    const focalTarget = this.focusController.resolve(snapshot, this.currentLyricGroups.length, {
      isAutoAlignSuspended: this.scrollState.isAutoAlignSuspended,
      hasBottomContent: this.hasBottomContent,
      canDisplayInterlude,
    });

    // 组装给布局计算器和滚动引擎用的数据
    const fontSize = this.baseFontSize || 24;
    const dotMargin = fontSize * 0.4;
    const totalInterludeHeight = this.layoutState.interludeDotsSize[1] + dotMargin * 2;

    const ctx = this.frameContext;
    ctx.containerHeight = this.size[1];
    ctx.target = focalTarget;

    // 设置间奏相关的上下文参数
    const activeInterludeForLayout = canDisplayInterlude ? interlude : undefined;
    const interludeAnchorIndex = LayoutCalculator.resolveInterludeAnchorIndex(
      activeInterludeForLayout,
      focalTarget,
    );

    if (interludeAnchorIndex !== undefined) {
      ctx.interlude = ctx.interlude || { totalHeight: 0, anchorIndex: 0 };
      ctx.interlude.totalHeight = totalInterludeHeight;
      ctx.interlude.anchorIndex = interludeAnchorIndex;
    } else {
      ctx.interlude = undefined;
    }

    // 获取滚动边界与帧 Session，钳制出安全 offset 后提交排版
    const { bounds, session } = this.layoutCalculator.beginFrame(ctx, this.layoutConfig);
    ctx.scrollOffset = this.scrollEngine.updateBoundary(bounds.min, bounds.max);

    // 让 LayoutCalculator 算出各个排版信息
    const result = this.layoutCalculator.commit(session, ctx.scrollOffset);

    // 检查是否需要显示间奏点
    if (result.hasInterlude && canDisplayInterlude && interlude) {
      const nextLineIndex = interlude.anchorLineIndex + 1;
      const nextGroup = this.currentLyricGroups[nextLineIndex];
      const isNextDuet = nextGroup?.mainLine.line.isDuet ?? false;

      // 如果下一行是对唱，让间奏点右对齐
      const targetX = isNextDuet ? this.size[0] - this.layoutState.interludeDotsSize[0] : 0;

      this.interludeDots.setTransform(
        targetX,
        result.interludeY + dotMargin,
        strategy.snapPosY || !this.getEnableSpring(),
      );
    }

    // 刷新本帧的视觉推导派生值
    const visual = this.visualFrame;
    visual.latestIndex = snapshot.latestHighlightedIndex ?? snapshot.scrollToIndex;
    visual.passedBoundary = interlude ? interlude.anchorLineIndex + 1 : snapshot.scrollToIndex;
    visual.isNarrowViewport = this.size[0] <= 1024;

    // 计算亮度层副本的保留区间。该区间需完整覆盖当前焦点行与所有高亮行，并向前后各扩展 2 行。
    // 其中向上扩展确保离开高亮时的淡出过渡动画完整播放，向下扩展则为即将高亮的行预先构建所需副本
    let windowEarliest = snapshot.scrollToIndex;
    let windowLatest = snapshot.scrollToIndex;
    for (const index of snapshot.highlightedGroups) {
      if (index < windowEarliest) windowEarliest = index;
      if (index > windowLatest) windowLatest = index;
    }
    const brightnessWindowFrom = windowEarliest - BRIGHTNESS_WINDOW_LINES;
    const brightnessWindowTo = windowLatest + BRIGHTNESS_WINDOW_LINES;

    // 遍历 LayoutCalculator 算出的排版信息并应用视觉效果
    const activeCount = result.lineCount;

    let delay = 0;
    let baseDelay = strategy.disableStagger ? 0 : 50;

    for (let i = 0; i < activeCount; i++) {
      const group = this.currentLyricGroups[i];
      const instruction = result.lineInstructions[i];
      const curPos = instruction.y;
      const isInViewport = instruction.isInViewport;
      const isActive = this.resolveIsActive(i, snapshot);

      // 设置样式
      group.setTransform(
        curPos,
        strategy.snapPosY,
        delay,
        isActive,
        this.resolveOpacity(i, isInViewport, snapshot),
        this.resolveBlurLevel(i, isActive, isInViewport, snapshot),
        i >= brightnessWindowFrom && i <= brightnessWindowTo,
      );

      // 应用阶梯式的动画延迟
      const lineH = instruction.height;
      if (curPos + lineH >= 0) {
        delay += baseDelay;
        if (i >= snapshot.scrollToIndex) {
          baseDelay /= 1.05;
        }
      }
    }
  }

  /**
   * 推导某一行是否处于激活状态
   */
  resolveIsActive(index, snapshot) {
    return (
      snapshot.highlightedGroups.has(index) ||
      (index >= snapshot.scrollToIndex && index < this.visualFrame.latestIndex)
    );
  }

  /**
   * 推导一行的目标透明度
   */
  resolveOpacity(index, isInViewport, snapshot) {
    // 在视口外则剔除渲染
    if (!isInViewport) return 0;

    if (this.hidePassedLines && this.isPlaying && index < this.visualFrame.passedBoundary) {
      // 为了避免优化器吞掉，这里使用了一个极小但不为零的值（几乎不可见）
      return 1e-4;
    }

    if (snapshot.highlightedGroups.has(index)) return 0.85;

    return this.isNonDynamic ? 0.2 : 1;
  }

  /**
   * 按距焦点的行距推导模糊档位
   * @param {number} index 歌词行索引
   * @param {boolean} isFocused 该目标是否为当前焦点
   * @param {boolean} isInViewport 该目标是否在可视区域内
   */
  resolveBlurLevel(index, isFocused, isInViewport, snapshot) {
    if (!this.enableBlur) return 0;

    // 视口外不施加模糊
    if (!isInViewport) return 0;

    // 用户触摸滑动期间和对焦目标不施加模糊
    if (this.scrollState.isTouchScrolled || isFocused) return 0;

    // 当前行（最近高亮行；高亮被间奏/曲末清空后回退到 scrollToIndex =
    // 最后演唱行）任何时候都不得模糊：清空态下 isFocused 不再覆盖它，
    // 1 + distance 在 distance=0 时会给它留下 1 档模糊（2026-11-15 浏览态
    // 实测当前行发虚）。有意偏离 AMLL 同名公式（其保留该 1 档）
    if (index === this.visualFrame.latestIndex) return 0;

    const scrollToIndex = snapshot.scrollToIndex;
    const distance =
      index < scrollToIndex
        ? Math.abs(scrollToIndex - index) + 1
        : Math.abs(index - this.visualFrame.latestIndex);

    const level = 1 + distance;
    return this.visualFrame.isNarrowViewport ? level * 0.8 : level;
  }
  //#endregion

  //#region 播放状态与逐帧
  /**
   * 暂停部分效果演出（间奏点动画暂停、非活动行恢复原大）
   */
  pause() {
    this.interludeDots.pause();
    if (this.isPlaying) {
      this.isPlaying = false;
      this.calcLayout(LayoutReason.ConfigChange);
    }
  }

  /** 恢复部分效果演出 */
  resume() {
    this.interludeDots.resume();
    if (!this.isPlaying) {
      this.isPlaying = true;
      this.calcLayout(LayoutReason.ConfigChange);
    }
  }

  /**
   * 页面可见性变化（QML 页面挂起/恢复入口）
   * @param {boolean} visible
   */
  setPageVisible(visible) {
    this.isPageVisible = visible;
    if (visible) {
      // 挂起恢复的第一帧 setCurrentTime 重推，避免时钟落后
      this.setCurrentTime(this.getCurrentTime(), true);
    }
  }

  /**
   * 标签页挂起恢复时丢弃跳转检测基线：
   * 挂起期间音频可能仍在持续播放，恢复首帧的推送间隔会远超 SeekDetector
   * 信任的物理时钟跨度（MAX_TRUSTED_GAP），被误判为跳转
   */
  seekDetectorInvalidateBaseline() {
    this.seekDetector.reset();
  }

  /**
   * 更新动画，这个函数应该被逐帧调用或者在刚调用完设置歌词函数时调用一次
   * @param {number} [deltaMs] 距离上一次被调用到现在的时长（毫秒，可为浮点数）
   */
  update(deltaMs = 0) {
    const d = Math.min(deltaMs, MAX_FRAME_DELTA);
    this.scrollEngine.tick(this.now());
    this.interludeDots.update(d);
    if (!this.isPageVisible) return;
    for (const group of this.currentLyricGroups) {
      group.update(d);
    }
  }
  //#endregion

  //#region 滚动
  /**
   * 重置用户滚动状态并恢复自动对齐。
   * 典型场景是在用户滚动完毕、但歌词未自动归位时立刻归位
   */
  resetScroll() {
    this.scrollEngine.resetScroll(0);
    this.scrollState.isAutoAlignSuspended = false;
    this.scrollState.isTouchScrolled = false;
  }
  //#endregion

  dispose() {
    this.scrollEngine.dispose();
    this.interludeDots.dispose();
    this.currentLyricGroups = [];
  }
}

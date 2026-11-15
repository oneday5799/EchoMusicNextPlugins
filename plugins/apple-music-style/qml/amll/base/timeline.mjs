/**
 * 时间线控制器，移植自 AMLL base/timeline.ts。
 *
 * 职责：由歌词行时间边界推导每帧的播放/高亮行集合、间奏区间与滚动对齐目标，
 * 并输出相对上一帧的增量变化（diff）供渲染层增量更新。
 *
 * 歌词行的高亮生命周期为「唱完不熄灭」：
 * - 命中 `[startTime, endTime)` 时高亮
 * - 唱完后不会自行熄灭，而是继续保持高亮，直到：
 *   1. 有新的歌词行开始播放，此时已唱完的行被一起熄灭
 *   2. 进入间奏区间，此时清空全部高亮并把焦点交给间奏点
 *   3. 歌曲播放完毕，此时清空全部高亮
 *   4. 发生跳转，此时按跳转后的时间重新推导
 */

/** 判定为间奏所需的最小空隙时长（毫秒） */
const MIN_INTERLUDE_GAP = 7000;

/**
 * 用于进度计算的最小歌词数据
 * @typedef {{ startTime: number, endTime: number }} TimeBounds
 */

/**
 * 当前命中的间奏区间信息
 * @typedef {object} PlayerInterlude
 * @property {number} startTime 间奏开始时间，即此前全部歌词行中最晚的结束时间
 * @property {number} endTime 间奏结束时间，即间奏后第一行歌词的开始时间
 * @property {number} anchorLineIndex 间奏点应插入的位置基准（显示顺序上间奏前最后一行的索引，-1 表示第一句之前）
 */

/**
 * 当前播放时间线状态的只读快照（每帧原地覆写，不得跨帧保留引用）
 * @typedef {object} TimelineSnapshot
 * @property {number} currentTime 推导所依据的绝对播放时间（毫秒）
 * @property {ReadonlySet<number>} playingGroups 当前进度命中的、正在播放的歌词组
 * @property {ReadonlySet<number>} highlightedGroups 当前进度命中的、正在高亮的歌词组
 * @property {number} scrollToIndex 自动滚动应该对齐到哪一行歌词
 * @property {number | undefined} latestHighlightedIndex 处于高亮状态的歌词行中最靠后的一行
 * @property {boolean} isEndOfSong 歌曲是否播放完毕
 * @property {PlayerInterlude | undefined} activeInterlude 当前命中的间奏区间数据
 * @property {boolean} isFocusOnInterlude 当前是否应当聚焦在间奏点上
 */

/**
 * 时间线增量变化（每帧原地覆写）
 * @typedef {object} TimelineDiff
 * @property {boolean} hasChanged 当前帧是否有任何实质性状态变更
 * @property {boolean} isTimeJumped 本次同步的时间轴是否发生了跳转
 * @property {ReadonlyArray<number>} addedPlaying 本帧开始播放的歌词索引列表
 * @property {ReadonlyArray<number>} removedPlaying 本帧脱离播放状态的歌词索引列表
 * @property {ReadonlyArray<number>} addedHighlighted 本帧需要变成高亮行的歌词索引列表
 * @property {ReadonlyArray<number>} removedHighlighted 本帧不再是高亮行的歌词索引列表
 * @property {boolean} isInterludeChanged 间奏状态是否发生了切换
 * @property {boolean} isScrollToChanged 自动对齐的目标歌词行索引是否发生了变化
 * @property {boolean} isEndOfSongChanged 歌曲播放完毕状态是否发生了变化
 */

export class TimelineController {
  // 注意：QML V4 引擎不支持 class fields 语法（Qt 6.12 实测），
  // 字段一律在构造函数里赋值
  constructor() {
    /** @type {readonly TimeBounds[]} */
    this.lyricBounds = [];
    /** 全部歌词行中最晚的结束时间，用于判定歌曲是否播放完毕 */
    this.maxEndTime = 0;
    /** @type {PlayerInterlude[]} 预先计算的间奏区域 */
    this.precalculatedInterludes = [];
    /** 上次顺序扫描停止的位置，避免每次都从头遍历 */
    this.playbackCursor = 0;
    this.interludeCursor = 0;

    this.playingGroupsSet = new Set();
    this.highlightedGroupsSet = new Set();

    /** @type {Set<number>} */
    this.nextPlayingSet = new Set();
    /** @type {Set<number>} */
    this.nextHighlightedSet = new Set();

    /** @type {number[]} */
    this.addedPlayingIds = [];
    /** @type {number[]} */
    this.removedPlayingIds = [];
    /** @type {number[]} */
    this.addedHighlightedIds = [];
    /** @type {number[]} */
    this.removedHighlightedIds = [];
    /** @type {number[]} */
    this.expiredHighlightedIds = [];

    /** @type {TimelineSnapshot} */
    this.snapshot = {
      currentTime: 0,
      playingGroups: this.playingGroupsSet,
      highlightedGroups: this.highlightedGroupsSet,
      scrollToIndex: 0,
      latestHighlightedIndex: undefined,
      isEndOfSong: false,
      activeInterlude: undefined,
      isFocusOnInterlude: false,
    };

    /** @type {TimelineDiff} */
    this.diff = {
      hasChanged: false,
      isTimeJumped: false,
      addedPlaying: this.addedPlayingIds,
      removedPlaying: this.removedPlayingIds,
      addedHighlighted: this.addedHighlightedIds,
      removedHighlighted: this.removedHighlightedIds,
      isInterludeChanged: false,
      isScrollToChanged: false,
      isEndOfSongChanged: false,
    };
  }

  /**
   * 提前设置好歌词的时间数据，内部会预计算间奏区间
   * @param {readonly TimeBounds[]} bounds 歌词行的时间边界，必须按 startTime 升序排列
   */
  setTimeBounds(bounds) {
    this.lyricBounds = bounds;
    this.precalculatedInterludes = this.calculateInterludes(bounds);

    // 歌词行按开始时间排序，末行的结束时间不一定是最大值
    // 例如末尾存在时间上被前一行包住的重叠行，因此单独预计算一次
    let maxEnd = 0;
    for (const bound of bounds) {
      maxEnd = Math.max(maxEnd, bound.endTime);
    }
    this.maxEndTime = maxEnd;

    this.reset();
  }

  /**
   * 获取当前播放时间线状态的只读快照（必须在同一帧内消费完毕）
   * @returns {TimelineSnapshot}
   */
  getSnapshot() {
    return this.snapshot;
  }

  /**
   * 将播放进度推进到指定时间，并返回相对上一帧的增量变化
   * @param {number} time 当前播放时间（毫秒）
   * @param {boolean} [forceSeek] 这次时间变化是否由跳转触发
   * @returns {TimelineDiff}
   */
  sync(time, forceSeek = false) {
    this.addedPlayingIds.length = 0;
    this.removedPlayingIds.length = 0;
    this.addedHighlightedIds.length = 0;
    this.removedHighlightedIds.length = 0;

    const prevInterlude = this.snapshot.activeInterlude;
    const prevFocusOnInterlude = this.snapshot.isFocusOnInterlude;
    const prevScrollToIndex = this.snapshot.scrollToIndex;
    const prevEndOfSong = this.snapshot.isEndOfSong;

    // 时间倒退时一律按跳转处理，因为 performPlayback 会保存上次扫描停止的位置，
    // 下次从该位置继续扫描以提高性能，若时间倒退，倒退到的行可能位于扫描位置之前，
    // 只能重新推导
    const isTimeRetreating = time < this.snapshot.currentTime;
    const isJump = forceSeek || isTimeRetreating;

    // 间奏命中情况需要先于歌词状态确定
    // Seek 时要按同样的规则决定是否保留已经唱完的行，需要提前知道结果
    const activeInterlude = this.resolveActiveInterlude(time, isJump);
    this.snapshot.activeInterlude = activeInterlude;

    const isPastLastLine = this.lyricBounds.length > 0 && time >= this.maxEndTime;

    if (isJump) {
      this.performSeek(time, !!activeInterlude || isPastLastLine);
    } else {
      this.performPlayback(time);
    }

    // 高亮行本身不会因为唱完而熄灭，这里处理两个需要清空的场景
    // 1. 进入间奏区间：间奏点接过焦点，不应该再有亮着的旧歌词
    // 2. 歌曲播放完毕：不会再有新歌词接续，需要主动熄灭
    if (activeInterlude && this.playingGroupsSet.size === 0) {
      this.flushAllHighlighted();
    }
    if (isPastLastLine) {
      this.flushAllHighlighted();
    }

    this.updateInterludeFocus(activeInterlude);

    const isInterludeChanged = prevInterlude !== activeInterlude;
    const isFocusChanged = prevFocusOnInterlude !== this.snapshot.isFocusOnInterlude;
    const isScrollToChanged = prevScrollToIndex !== this.snapshot.scrollToIndex;
    const isEndOfSongChanged = isPastLastLine !== prevEndOfSong;

    const hasChanged =
      isJump ||
      this.addedPlayingIds.length > 0 ||
      this.removedPlayingIds.length > 0 ||
      this.addedHighlightedIds.length > 0 ||
      this.removedHighlightedIds.length > 0 ||
      isInterludeChanged ||
      isFocusChanged ||
      isScrollToChanged ||
      isEndOfSongChanged;

    this.snapshot.currentTime = time;

    if (this.highlightedGroupsSet.size > 0) {
      let maxIndex = -1;
      for (const id of this.highlightedGroupsSet) {
        if (id > maxIndex) maxIndex = id;
      }
      this.snapshot.latestHighlightedIndex = maxIndex;
    } else {
      this.snapshot.latestHighlightedIndex = undefined;
    }

    this.snapshot.isEndOfSong = isPastLastLine;

    this.diff.hasChanged = hasChanged;
    this.diff.isTimeJumped = isJump;
    this.diff.isInterludeChanged = isInterludeChanged;
    this.diff.isScrollToChanged = isScrollToChanged;
    this.diff.isEndOfSongChanged = isEndOfSongChanged;

    return this.diff;
  }

  //#region 时间线推导
  /**
   * 处理正常播放时的时间线推导
   * @param {number} time
   */
  performPlayback(time) {
    // 定义歌词的不同状态：
    // 播放行：只要当前时间落在 [startTime, endTime) 内，就是在播放行，播放行是高亮行的子集
    // 高亮行：UI 层真正看到的高亮状态
    //
    // 一行歌词播放完毕后会立刻退出播放状态，但会继续保持高亮，直到下一行开始播放才熄灭
    // 空隙长到构成间奏、以及歌曲已经播完这两种没有下一行接续的情况，由 sync 统一清空

    // 清理不再播放的行
    for (const lastPlayingId of this.playingGroupsSet) {
      const bound = this.lyricBounds[lastPlayingId];
      if (!bound || time < bound.startTime || bound.endTime <= time) {
        this.playingGroupsSet.delete(lastPlayingId);
        this.removedPlayingIds.push(lastPlayingId);
      }
    }

    // 顺序查找并激活新的播放中的行
    // 从 playbackCursor 开始往下找，跳过已经唱完的歌词，提高性能
    let cursor = Math.max(0, this.playbackCursor);
    const len = this.lyricBounds.length;

    while (cursor < len) {
      const bound = this.lyricBounds[cursor];
      if (bound.startTime > time) {
        break; // 已经排序过
      }

      if (bound.startTime <= time && bound.endTime > time && !this.playingGroupsSet.has(cursor)) {
        this.playingGroupsSet.add(cursor);
        this.addedPlayingIds.push(cursor);
      }
      cursor++;
    }

    // 更新 playbackCursor 指针
    this.playbackCursor = cursor;

    // 找出那些已经唱完但仍处于高亮状态的歌词行
    // 它们会保持高亮，直到有新歌词开始播放才被一起熄灭
    this.expiredHighlightedIds.length = 0;
    for (const id of this.highlightedGroupsSet) {
      if (!this.playingGroupsSet.has(id)) {
        this.expiredHighlightedIds.push(id);
      }
    }

    const addedPlayingCount = this.addedPlayingIds.length;
    const expiredCount = this.expiredHighlightedIds.length;

    // 只要有新歌词开始播放，将其存入 highlightedGroupsSet，并向 addedHighlightedIds 压入 Diff
    for (let i = 0; i < addedPlayingCount; i++) {
      const id = this.addedPlayingIds[i];
      this.highlightedGroupsSet.add(id);
      this.addedHighlightedIds.push(id);
    }

    // 清理旧高亮的唯一条件是「有新歌词进入播放状态」。
    // 注意 expiredCount > 0 不作为清理条件，一行歌词唱完时若没有新行接续，
    // 它会继续保持高亮，这样多行高亮时先唱完的行和句间空隙的上一行不会失去可读性
    if (addedPlayingCount > 0) {
      for (let i = 0; i < expiredCount; i++) {
        const id = this.expiredHighlightedIds[i];
        this.highlightedGroupsSet.delete(id);
        this.removedHighlightedIds.push(id);
      }

      let minHighlighted = Number.POSITIVE_INFINITY;
      for (const id of this.highlightedGroupsSet) {
        if (id < minHighlighted) minHighlighted = id;
      }

      // 只在歌词更替时更新，以便在播放完毕后保持聚焦在这一组歌词
      this.snapshot.scrollToIndex = minHighlighted;
    }
  }

  /**
   * 处理 Seek 时的时间线推导
   *
   * 直接按目标时间重建播放与高亮行集合，结果与正常播放到该时刻时一致
   * @param {number} time 跳转到的时间
   * @param {boolean} dropLingeringWhenIdle 在没有任何行正在播放时，是否丢弃那些已经唱完、
   * 但在正常播放中仍会保持高亮的行，用于在间奏和播放完时清空高亮行
   */
  performSeek(time, dropLingeringWhenIdle) {
    const nextPlaying = this.nextPlayingSet;
    const nextHighlighted = this.nextHighlightedSet;
    nextPlaying.clear();
    nextHighlighted.clear();

    // 二分法找出第一个开始时间晚于目标时间的歌词行，排除所有尚未开始唱的歌词
    let left = 0;
    let right = this.lyricBounds.length - 1;
    let firstGreater = this.lyricBounds.length;

    while (left <= right) {
      const mid = (left + right) >> 1;
      if (this.lyricBounds[mid].startTime > time) {
        firstGreater = mid;
        right = mid - 1;
      } else {
        left = mid + 1;
      }
    }

    // 往前找到最后一个真正开始播放过的歌词行作为锚点
    let anchorIndex = -1;
    for (let i = firstGreater - 1; i >= 0; i--) {
      const bound = this.lyricBounds[i];
      // 有意跳过时长为 0 的歌词行
      if (bound.endTime > bound.startTime) {
        anchorIndex = i;
        break;
      }
    }

    if (anchorIndex === -1) {
      // 目标时间在第一行歌词开始之前，或此前所有已开始的行都是零时长
      // 正常播放时尚未有任何歌词行进入播放状态，scrollToIndex 保持为 0
      this.playbackCursor = firstGreater;
      this.snapshot.scrollToIndex = 0;
      this.commitSeekDiff();
      return;
    }

    // 还原「歌词唱完不熄灭，直到下一句开始才更替」的状态
    // 锚点之后的歌词行要么开始时间晚于目标时间、要么时长为零，都不可能命中，无需遍历
    const anchorStart = this.lyricBounds[anchorIndex].startTime;
    let minPlaying = -1;
    let minHighlighted = -1;

    for (let i = anchorIndex; i >= 0; i--) {
      const bound = this.lyricBounds[i];

      // 锚点时刻尚未唱完的行，在正常播放中会一直亮到下一行开始
      // 正在播放的行必然满足此条件，因为其结束时间晚于目标时间，而目标时间不早于锚点
      if (bound.endTime <= anchorStart) continue;

      if (bound.startTime <= time && bound.endTime > time) {
        nextPlaying.add(i);
        minPlaying = i;
      }

      nextHighlighted.add(i);
      minHighlighted = i;
    }

    // 间奏与曲末清空高亮行，如果没有行在播放的话
    if (dropLingeringWhenIdle && nextPlaying.size === 0) {
      nextHighlighted.clear();
    }

    this.playbackCursor = minPlaying === -1 ? firstGreater : minPlaying;
    this.snapshot.scrollToIndex = minHighlighted;

    this.commitSeekDiff();
  }

  /**
   * 把 Seek 重建出的目标集合与上一帧的集合求对称差，输出发生变化的部分
   */
  commitSeekDiff() {
    for (const id of this.playingGroupsSet) {
      if (!this.nextPlayingSet.has(id)) {
        this.playingGroupsSet.delete(id);
        this.removedPlayingIds.push(id);
      }
    }
    for (const id of this.nextPlayingSet) {
      if (!this.playingGroupsSet.has(id)) {
        this.playingGroupsSet.add(id);
        this.addedPlayingIds.push(id);
      }
    }

    for (const id of this.highlightedGroupsSet) {
      if (!this.nextHighlightedSet.has(id)) {
        this.highlightedGroupsSet.delete(id);
        this.removedHighlightedIds.push(id);
      }
    }
    for (const id of this.nextHighlightedSet) {
      if (!this.highlightedGroupsSet.has(id)) {
        this.highlightedGroupsSet.add(id);
        this.addedHighlightedIds.push(id);
      }
    }
  }

  /**
   * 立即熄灭当前全部高亮歌词行
   *
   * 用于间奏与曲末这两个没有下一行接续、但必须清空高亮的场景
   */
  flushAllHighlighted() {
    if (this.highlightedGroupsSet.size === 0) return;

    for (const id of this.highlightedGroupsSet) {
      this.removedHighlightedIds.push(id);
    }
    this.highlightedGroupsSet.clear();
  }
  //#endregion

  //#region 间奏计算
  /**
   * 预计算全部间奏区间
   * @param {readonly TimeBounds[]} bounds 按 startTime 升序排列的歌词时间边界
   * @returns {PlayerInterlude[]} 按时间升序排列、互不重叠的间奏区间
   */
  calculateInterludes(bounds) {
    /** @type {PlayerInterlude[]} */
    const interludes = [];

    // 已扫描过的歌词行中最晚的结束时间
    let maxEnd = 0;

    // 歌词行只保证按 startTime 升序，前一行的 endTime 并不等于此前
    // 所有行的最晚结束时间（例如多行高亮的情况）。
    // 所以这里按前缀最大结束时间做一次区间并集扫描，保证产出的区间与任何歌词行都不重叠
    for (let i = -1; i < bounds.length - 1; i++) {
      if (i >= 0) {
        maxEnd = Math.max(maxEnd, bounds[i].endTime);
      }

      const gapEnd = Math.max(maxEnd, bounds[i + 1].startTime);

      if (gapEnd - maxEnd >= MIN_INTERLUDE_GAP) {
        interludes.push({
          startTime: maxEnd,
          endTime: gapEnd,
          anchorLineIndex: i,
        });
      }
    }

    return interludes;
  }

  /**
   * 查找当前时间命中的间奏区间，并顺带推进或重定位间奏游标
   * @param {number} time 当前播放时间
   * @param {boolean} isSeek 当前帧是否为跳转
   * @returns {PlayerInterlude | undefined}
   */
  resolveActiveInterlude(time, isSeek) {
    if (this.precalculatedInterludes.length === 0) return undefined;

    if (isSeek) {
      let cursor = this.precalculatedInterludes.length;
      let left = 0;
      let right = this.precalculatedInterludes.length - 1;

      while (left <= right) {
        const mid = (left + right) >> 1;
        const inter = this.precalculatedInterludes[mid];

        if (inter.endTime > time) {
          cursor = mid;
          right = mid - 1;
        } else {
          left = mid + 1;
        }
      }

      this.interludeCursor = cursor;

      if (cursor < this.precalculatedInterludes.length) {
        const inter = this.precalculatedInterludes[cursor];
        if (time >= inter.startTime && time < inter.endTime) {
          return inter;
        }
      }

      return undefined;
    }

    while (this.interludeCursor < this.precalculatedInterludes.length) {
      const inter = this.precalculatedInterludes[this.interludeCursor];
      if (time >= inter.startTime && time < inter.endTime) {
        return inter;
      }
      if (time >= inter.endTime) {
        this.interludeCursor++;
      } else {
        break;
      }
    }

    return undefined;
  }

  /**
   * 根据间奏命中情况和当前高亮状态推导是否应当聚焦间奏点
   *
   * 处于间奏区域且没有任何歌词高亮时聚焦间奏点，否则交还给歌词行
   * @param {PlayerInterlude | undefined} activeInterlude
   */
  updateInterludeFocus(activeInterlude) {
    this.snapshot.isFocusOnInterlude = !!activeInterlude && this.highlightedGroupsSet.size === 0;
  }
  //#endregion

  //#region 重置
  /**
   * 清空全部推导状态，回到时间原点
   */
  reset() {
    this.playbackCursor = 0;
    this.interludeCursor = 0;

    this.playingGroupsSet.clear();
    this.highlightedGroupsSet.clear();
    this.nextPlayingSet.clear();
    this.nextHighlightedSet.clear();

    this.snapshot.currentTime = 0;
    this.snapshot.scrollToIndex = 0;
    this.snapshot.latestHighlightedIndex = undefined;
    this.snapshot.isEndOfSong = false;
    this.snapshot.activeInterlude = undefined;
    this.snapshot.isFocusOnInterlude = false;
  }
  //#endregion
}

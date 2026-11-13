/**
 * 对齐焦点状态机，移植自 AMLL base/focus.ts。
 *
 * 持有跨帧的冻结对齐目标，并在每一帧根据时间线快照与交互状态推导出
 * 本帧排版应当对齐的焦点。规则：
 * - 用户滚动挂起期间冻结上一帧的焦点，不再跟随播放进度
 * - 若冻结在间奏点上而间奏已经结束，则自动顺延至间奏后的第一行歌词
 * - 未挂起时跟随播放状态：间奏中对齐间奏点，曲末对齐末行，其余对齐 scrollToIndex
 * - 任何情况下产出的歌词行索引都被钳制在 `[0, lineCount - 1]` 内
 */

/**
 * 对齐焦点目标
 * @typedef {{ type: "line", index: number } | { type: "interlude", anchorIndex: number } | { type: "bottom" }} FocalTarget
 */

/**
 * 焦点推导所依赖的播放器交互状态
 * @typedef {object} FocusResolveFlags
 * @property {boolean} isAutoAlignSuspended 是否处于用户滚动过、尚未回归自动对齐的状态
 * @property {boolean} hasBottomContent 底栏当前是否有内容
 * @property {boolean} canDisplayInterlude 当前命中的间奏点是否具备可展示的时长
 */

export class FocusController {
  // 注意：QML V4 引擎不支持 class fields 语法（Qt 6.12 实测），
  // 字段一律在构造函数里赋值
  constructor() {
    /** @type {FocalTarget} */
    this.target = { type: 'line', index: 0 };
  }

  /**
   * 推导本帧的对齐焦点，并将其记录为新的冻结目标
   * @param {import("./timeline.mjs").TimelineSnapshot} snapshot 当前帧的时间线快照
   * @param {number} lineCount 当前歌词行总数
   * @param {FocusResolveFlags} flags 播放器的交互状态
   * @returns {FocalTarget}
   */
  resolve(snapshot, lineCount, flags) {
    const nextTarget = flags.isAutoAlignSuspended
      ? this.resolveSuspendedTarget(snapshot, lineCount, flags)
      : this.resolveActiveTarget(snapshot, lineCount, flags);

    this.target = nextTarget;
    return nextTarget;
  }

  /**
   * 用户滚动挂起期间的焦点解析（维持上一帧目标或在间奏结束/不可用时顺延）
   */
  resolveSuspendedTarget(snapshot, lineCount, flags) {
    const target = this.target;

    switch (target.type) {
      case 'line':
        return {
          type: 'line',
          index: this.clampLineIndex(target.index, lineCount),
        };

      case 'interlude': {
        const isInterludeActive =
          snapshot.isFocusOnInterlude && !!snapshot.activeInterlude && flags.canDisplayInterlude;

        // 离开间奏区间或间奏不可显示时，将冻结目标移动至间奏后的下一行歌词
        if (!isInterludeActive) {
          return {
            type: 'line',
            index: this.clampLineIndex(target.anchorIndex + 1, lineCount),
          };
        }
        return target;
      }

      case 'bottom':
        return target;
    }
  }

  /**
   * 正常播放状态下的自动焦点解析
   */
  resolveActiveTarget(snapshot, lineCount, flags) {
    // 处于间奏区间且需聚焦间奏点
    if (snapshot.isFocusOnInterlude && snapshot.activeInterlude) {
      // 若间奏不可显示，焦点顺延至下一行待唱歌词
      if (!flags.canDisplayInterlude) {
        return {
          type: 'line',
          index: this.clampLineIndex(snapshot.activeInterlude.anchorLineIndex + 1, lineCount),
        };
      }
      return {
        type: 'interlude',
        anchorIndex: snapshot.activeInterlude.anchorLineIndex,
      };
    }

    // 播放完了，如果有底栏则对齐底栏，没有则对齐最后一行歌词
    // （本插件不做底栏，hasBottomContent 恒为 false，分支保留以镜像 AMLL）
    if (snapshot.isEndOfSong) {
      if (flags.hasBottomContent) {
        return { type: 'bottom' };
      }
      return {
        type: 'line',
        index: this.clampLineIndex(lineCount - 1, lineCount),
      };
    }

    // 常规播放跟随
    return {
      type: 'line',
      index: this.clampLineIndex(snapshot.scrollToIndex, lineCount),
    };
  }

  /**
   * 将歌词行索引钳制到当前歌词范围内
   */
  clampLineIndex(index, lineCount) {
    if (lineCount <= 0) return 0;
    return Math.min(Math.max(0, index), lineCount - 1);
  }

  /**
   * 重置焦点至首行。一般在载入新歌词、重建歌词视图时调用
   */
  reset() {
    this.target = { type: 'line', index: 0 };
  }
}

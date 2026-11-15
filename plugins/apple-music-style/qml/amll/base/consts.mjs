/**
 * 播放器共享常量。
 * 移植自 AMLL base/consts.ts（不雅词掩码与布局对齐锚点相关条目按范围
 * 决策不移植——锚点恒为居中）。
 */

/**
 * 歌词行的渲染模式
 */
export const LyricLineRenderMode = {
  /** 单色静态渲染：整行统一透明度，无逐词扫掠 */
  SOLID: 0,
  /** 渐变渲染：活动行逐词扫掠（已唱亮/未唱暗 + 软边渐变带） */
  GRADIENT: 1,
};

/**
 * 触发排版布局更新的原因场景
 */
export const LayoutReason = {
  /** 正常播放时间推进 */
  PlaybackTick: 'playback-tick',
  /** 容器或窗口尺寸调整 */
  Resize: 'resize',
  /** 用户交互挂起开始（触摸/滚轮触发） */
  InteractionStart: 'interaction-start',
  /** 连续高频滚动（手指触摸滑动或松手后的惯性滑动） */
  ContinuousScroll: 'continuous-scroll',
  /** 离散单步滚动（鼠标滚轮单次滚动） */
  DiscreteScroll: 'discrete-scroll',
  /** 跳转播放进度 */
  Seek: 'seek',
  /** 重新构建歌词视图 */
  RebuildView: 'rebuild-view',
  /** 视图结构或样式配置改变 */
  ConfigChange: 'config-change',
};

/**
 * 对应各个 LayoutReason 的排版执行策略定义
 * @typedef {{ disableStagger: boolean, resetInterlude: boolean, snapPosY: boolean }} LayoutStrategy
 */

/**
 * 排版原因到排版执行策略的映射字典。
 *
 * RebuildView 时也不应该瞬移 Y 轴，因为载入歌词时有一个歌词行从底部远处
 * 飞入的动画，需要弹簧来动画。
 * @type {Record<string, LayoutStrategy>}
 */
export const LayoutReasonStrategyMap = {
  [LayoutReason.PlaybackTick]: {
    disableStagger: false,
    resetInterlude: false,
    snapPosY: false,
  },
  [LayoutReason.ContinuousScroll]: {
    disableStagger: true,
    resetInterlude: false,
    snapPosY: true,
  },
  [LayoutReason.DiscreteScroll]: {
    disableStagger: true,
    resetInterlude: false,
    snapPosY: false,
  },
  [LayoutReason.InteractionStart]: {
    disableStagger: true,
    resetInterlude: false,
    snapPosY: false,
  },
  [LayoutReason.Seek]: {
    disableStagger: true,
    resetInterlude: true,
    snapPosY: false,
  },
  [LayoutReason.RebuildView]: {
    disableStagger: true,
    resetInterlude: true,
    snapPosY: false,
  },
  [LayoutReason.Resize]: {
    disableStagger: true,
    resetInterlude: false,
    snapPosY: false,
  },
  [LayoutReason.ConfigChange]: {
    disableStagger: true,
    resetInterlude: false,
    snapPosY: false,
  },
};

/**
 * 单帧动画时长的钳制上限（毫秒），用于页面挂起等场景。
 *
 * 此时首帧 update 的 delta 携带整个挂起时长，直接透传会导致动画以数秒的时长过冲。
 */
export const MAX_FRAME_DELTA = 100;

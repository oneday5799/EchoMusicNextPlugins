/**
 * 歌词行与歌词组的核心状态，移植自 AMLL base/line.ts、base/group.ts 与
 * dom/lyric-line.ts 的变换接线、dom/lyric-group.ts 的渲染范围判定。
 *
 * 与 AMLL 的差异：背景人声行按范围决策不移植（无 bgLine/bgSlideY）；
 * 视觉应用由 QML 渲染层读取核心状态完成，核心只保存目标值与弹簧。
 */

import { LyricLineRenderMode } from './consts.mjs';
import { isCJK } from './is-cjk.mjs';
import { Spring } from './spring.mjs';

/**
 * 歌词行核心状态（AMLL LyricLineBase + DOM 行变换接线的合体）
 *
 * 持有缩放弹簧与离散视觉目标（透明度/模糊/渲染模式/亮度窗口），
 * QML 行视图逐帧读取 scaleSpring 当前值，并在 revision 变化时应用离散目标。
 */
export class LyricLineCore {
  // 注意：QML V4 引擎不支持 class fields 语法（Qt 6.12 实测），
  // 字段一律在构造函数里赋值
  /**
   * @param {import("./player.mjs").LyricLineData} line
   * @param {import("./player.mjs").LyricPlayerCore} player
   */
  constructor(line, player) {
    this.line = line;
    this.player = player;

    /** 行内缩放弹簧，值域为百分比（100 = 原大），AMLL 同款 */
    this.scaleSpring = new Spring(100);

    this.scale = 100;
    this.blur = 0;
    this.opacity = 1;
    this.delay = 0;

    // AMLL 镜像字段（LyricLineRenderMode）：渲染层由 current/words 独立推导
    // GRADIENT/SOLID，此字段当前仅测试断言消费
    /** @type {number} LyricLineRenderMode */
    this.renderMode = LyricLineRenderMode.SOLID;

    // AMLL 镜像字段：亮度层窗口（焦点行 ±2 行）。渲染层的亮层由 isActive/
    // highlight 驱动，此字段当前仅测试断言消费
    this.inBrightnessWindow = true;

    /** 行是否处于高亮（启用）状态 */
    this.isEnabled = false;
    // AMLL 镜像字段：启用时携带的媒体时间。QML 扫掠用组级 sweepTime 时钟，
    // 此字段当前仅测试断言消费
    this.enabledAtTime = 0;

    /** 离散视觉目标的版本号，渲染层用于变更检测 */
    this.revision = 0;
  }

  get startTime() {
    return this.line.startTime;
  }

  get endTime() {
    return this.line.endTime;
  }

  /**
   * 设置行级视觉目标（AMLL 行 setTransform 语义）
   * @param {number} scale 目标缩放（百分比）
   * @param {number} opacity
   * @param {number} blur
   * @param {number} delayMs 阶梯延迟
   * @param {number} mode LyricLineRenderMode
   * @param {boolean} inBrightnessWindow
   */
  setTransform(
    scale = this.scale,
    opacity = this.opacity,
    blur = this.blur,
    delayMs = 0,
    mode = LyricLineRenderMode.SOLID,
    inBrightnessWindow = true,
  ) {
    this.scale = scale;
    this.opacity = opacity;
    this.blur = blur;
    this.delay = delayMs;
    this.renderMode = mode;
    this.inBrightnessWindow = inBrightnessWindow;

    if (this.player?.getEnableSpring() ?? true) {
      this.scaleSpring.setTargetPosition(scale);
    } else {
      this.scaleSpring.setPosition(scale);
    }

    this.revision++;
  }

  /**
   * 逐帧推进缩放弹簧
   * @param {number} deltaMs
   */
  update(deltaMs = 0) {
    if (!(this.player?.getEnableSpring() ?? true)) return;

    this.scaleSpring.update(deltaMs);
  }

  /**
   * 启用（高亮）行，携带当前媒体时间供扫掠定位。
   * AMLL 还记录 enabledShouldPlay（暂停中启用则扫掠静止）；本移植的扫掠
   * 由 QML 侧以播放状态门控（AmlGroupView sweepTime），无需存储
   * @param {number} [maskAnimationTime] 媒体时间，扫掠取相对行起点的正数部分
   * @param {boolean} [shouldPlay] 是否播放扫掠动画（未存储，见上）
   */
  enable(maskAnimationTime, shouldPlay) {
    this.isEnabled = true;
    this.enabledAtTime = maskAnimationTime ?? this.player?.getCurrentTime() ?? 0;
    this.revision++;
  }

  /**
   * 停用行（AMLL disable 语义：渲染模式交由下一次组变换回落为 SOLID）
   */
  disable() {
    this.isEnabled = false;
    this.revision++;
  }

  /**
   * 判定歌词是否可以应用强调辉光效果（AMLL shouldEmphasize 语义）。
   * 条件：单词时长 ≥ 1s 且（CJK 或长度 2~7）
   * @param {{ word: string, startTime: number, endTime: number }} word
   */
  static shouldEmphasize(word) {
    if (isCJK(word.word)) return word.endTime - word.startTime >= 1000;

    return (
      word.endTime - word.startTime >= 1000 &&
      word.word.trim().length <= 7 &&
      word.word.trim().length > 1
    );
  }
}

/**
 * 歌词组核心状态（AMLL LyricLineGroupBase 的无背景行版本）
 *
 * 持有纵向位移弹簧与组级视觉目标（isActive/opacity/blur/亮度窗口），
 * 并把渲染模式与缩放目标下发给主行。
 */
export class LyricLineGroupCore {
  // 注意：QML V4 引擎不支持 class fields 语法（Qt 6.12 实测），
  // 字段一律在构造函数里赋值
  /**
   * @param {LyricLineCore} mainLine
   * @param {import("./player.mjs").LyricPlayerCore} player
   */
  constructor(mainLine, player) {
    this.mainLine = mainLine;
    this.player = player;

    this.posY = new Spring(0);

    this.delay = 0;
    this.isActive = false;
    this.opacity = 1;
    this.blur = 0;

    /**
     * AMLL 镜像字段：指示当前歌词组是否处于亮度层活跃窗口内（焦点行与高亮行
     * 向前后各扩展 2 行）。渲染层的亮层由 isActive/highlight 驱动，仅测试消费
     */
    this.inBrightnessWindow = true;

    /** 离散视觉目标的版本号 */
    this.revision = 0;

    // 与 AMLL 相同：初始位置放在视口下方两倍高度处，载入时从远处飞入
    this.posY.setPosition(Math.max(player.size[1], 0) * 2);
  }

  get startTime() {
    return this.mainLine.startTime;
  }

  get endTime() {
    return this.mainLine.endTime;
  }

  /**
   * 设置组级变换目标
   * @param {number} top Y 轴目标坐标
   * @param {boolean} immediate 是否绕过弹簧瞬移（触摸拖动跟手）
   * @param {number} delayMs 阶梯延迟
   * @param {boolean} isActive
   * @param {number} opacity
   * @param {number} blur
   * @param {boolean} inBrightnessWindow
   */
  setTransform(top, immediate, delayMs, isActive, opacity, blur, inBrightnessWindow) {
    this.delay = delayMs;
    this.isActive = isActive;
    this.opacity = opacity;
    this.blur = blur;
    this.inBrightnessWindow = inBrightnessWindow;

    this.setLineTransformations(delayMs);

    const enableSpring = this.player.getEnableSpring();
    if (immediate || !enableSpring) {
      this.posY.setPosition(top);
    } else {
      this.posY.setTargetPosition(top, delayMs);
    }

    this.revision++;
  }

  /**
   * 把渲染模式与缩放目标下发给主行（AMLL setLineTransformations 语义）
   * @param {number} delayMs
   */
  setLineTransformations(delayMs) {
    const enableScale = this.player.getEnableScale();
    const isPlaying = this.player.getIsPlaying();

    const renderMode = this.isActive ? LyricLineRenderMode.GRADIENT : LyricLineRenderMode.SOLID;

    const SCALE_ASPECT = enableScale ? 97 : 100;
    let mainScale = 100;
    // 非活动行在播放中轻微缩小以凸显当前行
    if (!this.isActive && isPlaying) {
      mainScale = SCALE_ASPECT;
    }

    this.mainLine.setTransform(mainScale, 1, 0, delayMs, renderMode, this.inBrightnessWindow);
  }

  /**
   * 根据当前弹簧动画位置判断歌词行是否处于渲染范围内
   * @param {boolean} [includeOverscan] 是否包含 overscan 渲染缓冲范围，默认包含
   */
  isInRenderRange(includeOverscan = true) {
    const top = this.posY.getCurrentPosition();

    const index = this.player.currentLyricGroups.indexOf(this);
    const height = index !== -1 ? this.player.getLineHeight(index) : this.player.defaultLineHeight;

    const viewportHeight = this.player.size[1];
    if (viewportHeight <= 0 || height <= 0) return false;

    const overscan = includeOverscan ? this.player.getOverscanPx() : 0;

    return top < viewportHeight + overscan && top + height > -overscan;
  }

  /**
   * 逐帧推进位移与缩放弹簧
   * @param {number} deltaMs
   */
  update(deltaMs = 0) {
    if (this.player.getEnableSpring()) {
      this.posY.update(deltaMs);
    }

    this.mainLine.update(deltaMs);
  }
}

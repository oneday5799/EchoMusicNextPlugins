/**
 * AMLL dom/animation/mask/animator-web.ts（WebMaskAnimator）的纯数据移植。
 *
 * AMLL 为行内每个词建一个独立遮罩元素：遮罩图带在词盒 [0, W] 上布局
 * 「[0,W] 全亮 | [W,W+f] 亮→暗线性渐变带 | [W+f,2W+f] 全暗」（f = fadeWidth），
 * maskPosition X 在 [-(W+f), 0] 间动画：X=0 带左缘恰在词文本终点（全亮）、
 * X=-(W+f) 带右缘恰在词文本起点（全暗），带心 = X + width + f/2。所有词的
 * 时间线由同一条游标推进：词间隙只走时间（带停驻），词演唱期按词宽匀速移动
 * （行首词 +1.5f、行尾词 +0.5f 行程补偿），位置钳制并在穿越边界时插值折点帧
 * （驻停 → 线性启动），关键帧为行时长分数 offset + px 位置的线性插值时间线。
 *
 * 本移植只保留几何与时序（generateWordKeyframes / evaluateMaskPosition），
 * DOM/WAAPI 细节（generateFadeGradient 渐变串、element.animate、ruby 时间线）
 * 不在范围：本插件用 GlyphRun pose 切片渲染渐变带（AmlLineView.qml
 * __sweepPosesCore），消费的是逐词带位置。ruby 不移植（输入无 ruby）。
 *
 * 纯空白词（blank）不参与游标——AMLL buildWord 对纯空白 chunk 只建纯文本
 * 节点、无遮罩元素。若把零时长空白词纳入游标，其宽度会按「零时长不压帧」
 * 规则折叠进下一个关键帧（下一词演唱结束时才落地），使后词扫掠相位滞后一个
 * 词宽；排除后空白词的时长自然成为后词的停顿步，各词带相位始终锚在自己的
 * 文本起点/终点上。
 */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 生成每个词的钳制关键帧时间线。
 *
 * @param {Array<{width: number, t0: number, t1: number, blank?: boolean}>} words
 *   行内全部词（按词序）；width = 词文本盒宽（连续文本坐标 x1-x0），
 *   t0/t1 = 原始词时间（ms），blank = 纯空白词（不参与游标）。
 *   行首/行尾由非空白词的数组下标判定（AMLL wordIndex）。
 * @param {number} lineStart 行时间窗起点（ms；建议 min(words.t0)）
 * @param {number} lineEnd 行时间窗终点（ms；建议 max(words.t1)）
 * @param {number} fadeWidth 软边带宽（px；AMLL word.height × wordFadeWidth）
 * @returns {Array<{minOffset: number, frames: Array<{offset: number, position: number}>}>}
 *   与 words 等长；frames 按 offset（行时长分数 0..1）递增，position = 词局部
 *   遮罩 X（px，∈ [minOffset, 0]）；空白词返回空时间线。
 */
export function generateWordKeyframes(words, lineStart, lineEnd, fadeWidth) {
  const results = words.map(() => ({ minOffset: 0, frames: [] }));
  const walkWords = [];
  const walkSlots = [];
  for (let i = 0; i < words.length; ++i) {
    if (!words[i].blank) {
      walkWords.push(words[i]);
      walkSlots.push(i);
    }
  }
  // 行时长 1ms 下限防除零：AMLL 的 totalFadeDuration 无下限，仅在 WAAPI
  // duration 处设同款 max(…,1)（animator-web.ts:84）
  const total = Math.max(lineEnd - lineStart, 1);
  for (let targetIndex = 0; targetIndex < walkWords.length; ++targetIndex) {
    const targetWord = walkWords[targetIndex];
    // AMLL generateWordKeyframes：前置累加宽度（有词即 +f——words[0] 存在
    // 时恒真，等价于游标起点整体左移一个带宽）
    const widthBeforeSelf =
      walkWords.slice(0, targetIndex).reduce((a, b) => a + b.width, 0) +
      (walkWords[0] ? fadeWidth : 0);
    const minOffset = -(targetWord.width + fadeWidth);
    const initialPos = -widthBeforeSelf - targetWord.width - fadeWidth;
    const config = { minOffset, fadeWidth, total, wordCount: walkWords.length };
    const cursor = {
      curPos: initialPos,
      lastPos: initialPos,
      timeOffset: 0,
      lastTime: 0,
      lastTimeStamp: 0,
      frames: [],
    };
    // 压入起始帧
    pushClampedKeyframe(cursor, config);
    // 遍历整行所有词推进时间线
    for (let j = 0; j < walkWords.length; ++j) {
      const otherWord = walkWords[j];
      // 处理单词开始前的停顿区间（空白词的时长由后词停顿步吸收）
      advancePauseTimeline(cursor, otherWord.t0 - lineStart, config);
      // 处理单词播放时的移动区间（AMLL 的 ruby 分支不移植）
      advancePlainWordTimeline(cursor, otherWord, config, j);
    }
    results[walkSlots[targetIndex]] = { minOffset, frames: cursor.frames };
  }
  return results;
}

function advancePauseTimeline(cursor, targetStartStamp, config) {
  const staticDuration = targetStartStamp - cursor.lastTimeStamp;
  if (staticDuration > 0) {
    advanceTimelineStep(cursor, config, staticDuration, 0);
  }
  // 无条件写入（AMLL 对时间回退的重叠词同样置回）
  cursor.lastTimeStamp = targetStartStamp;
}

function advancePlainWordTimeline(cursor, otherWord, config, wordIndex) {
  const duration = Math.max(0, otherWord.t1 - otherWord.t0);
  let movePx = otherWord.width;
  if (wordIndex === 0) {
    movePx += config.fadeWidth * 1.5;
  }
  if (wordIndex === config.wordCount - 1) {
    movePx += config.fadeWidth * 0.5;
  }
  advanceTimelineStep(cursor, config, duration, movePx);
  cursor.lastTimeStamp += duration;
}

function advanceTimelineStep(cursor, config, duration, movePx) {
  cursor.timeOffset += duration / config.total;
  cursor.curPos += movePx;
  if (duration > 0) {
    // 零时长词不压帧：位置跳变折叠进下一个关键帧（AMLL 同语义）
    pushClampedKeyframe(cursor, config);
  }
}

function pushClampedKeyframe(cursor, config) {
  const moveOffset = cursor.curPos - cursor.lastPos;
  const time = clamp(cursor.timeOffset, 0, 1);
  const duration = time - cursor.lastTime;
  const msPerPixel = moveOffset !== 0 ? Math.abs(duration / moveOffset) : 0;
  // 穿越左侧不可见边界进入有效视野时，插值一个折点
  if (cursor.curPos > config.minOffset && cursor.lastPos < config.minOffset) {
    const staticTime = Math.abs(cursor.lastPos - config.minOffset) * msPerPixel;
    cursor.frames.push({
      offset: cursor.lastTime + staticTime,
      position: clamp(cursor.lastPos, config.minOffset, 0),
    });
  }
  // 穿越右侧越界边界时，插值一个折点
  if (cursor.curPos > 0 && cursor.lastPos < 0) {
    const staticTime = Math.abs(cursor.lastPos) * msPerPixel;
    cursor.frames.push({
      offset: cursor.lastTime + staticTime,
      position: clamp(cursor.curPos, config.minOffset, 0),
    });
  }
  cursor.frames.push({
    offset: time,
    position: clamp(cursor.curPos, config.minOffset, 0),
  });
  cursor.lastPos = cursor.curPos;
  cursor.lastTime = time;
}

/**
 * 求值词局部遮罩 X：时间 → 行时长分数（钳 [0,1]）→ 关键帧线性插值。
 * frames 为空时返回 0（空白词无时间线，调用方应跳过其词元簇）。
 */
export function evaluateMaskPosition(frames, timeMs, lineStart, lineEnd) {
  if (!frames || frames.length === 0) return 0;
  const total = Math.max(lineEnd - lineStart, 1);
  const t = clamp((timeMs - lineStart) / total, 0, 1);
  // 二分最后一个 offset ≤ t 的帧（同 offset 帧对取后者）
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid].offset <= t) lo = mid;
    else hi = mid - 1;
  }
  const a = frames[lo];
  if (lo + 1 >= frames.length) return a.position;
  const b = frames[lo + 1];
  const dt = b.offset - a.offset;
  if (dt <= 0) return b.position;
  return a.position + (b.position - a.position) * ((t - a.offset) / dt);
}

/**
 * 词带心换算到连续文本坐标：全局带心 = 词文本起点 x0 + 词局部 X + 词宽 + f/2。
 * 词未入场（X=minOffset）带心 = x0 - f/2（带右缘恰在文本起点，全暗）；
 * 词已出场（X=0）带心 = x0 + width + f/2（带左缘恰在文本终点，全亮）。
 */
export function maskBandCenter(x0, width, position, fade) {
  return x0 + position + width + fade / 2;
}

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FocusController,
  InterludeDots,
  LayoutCalculator,
  LayoutReason,
  LayoutReasonStrategyMap,
  LyricLineCore,
  LyricPlayerCore,
  MAX_FRAME_DELTA,
  ScrollInteractionEngine,
  SeekDetector,
  Spring,
  TimelineController,
  getPosYSpringPolicy,
  isCJK,
} from '../plugins/apple-music-style/qml/amll/base/index.mjs';

function approx(actual, expected, epsilon = 1e-3, message) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    message ?? `expected ${actual} ≈ ${expected} (±${epsilon})`,
  );
}

/** 连续推进弹簧直至静止，返回最终位置 */
function settle(spring, stepMs = 16, maxSteps = 600) {
  for (let i = 0; i < maxSteps; i++) {
    spring.update(stepMs);
    if (spring.arrived()) break;
  }
  return spring.getCurrentPosition();
}

/** 驱动播放器弹簧若干帧，模拟真实渲染循环 */
function pump(player, frames = 120) {
  for (let i = 0; i < frames; i++) player.update(16);
}

test('getPosYSpringPolicy mirrors AMLL interval policy', () => {
  assert.deepEqual(getPosYSpringPolicy(true, false), {
    stiffness: 90,
    damping: 15,
  });
  assert.deepEqual(getPosYSpringPolicy(false, true), {
    stiffness: 90,
    damping: 15,
  });
  assert.deepEqual(getPosYSpringPolicy(false, false, undefined, true), {
    stiffness: 140,
    damping: 22,
  });
  assert.deepEqual(getPosYSpringPolicy(false, false, undefined, false), {
    stiffness: 90,
    damping: 15,
  });
  // 短间隔（钳制到 100ms）→ 最快档 stiffness 220
  const fast = getPosYSpringPolicy(false, false, 50);
  assert.equal(fast.stiffness, 220);
  approx(fast.damping, 2.2 * Math.sqrt(220));
  // 长间隔（钳制到 800ms）→ 最慢档 stiffness 170
  const slow = getPosYSpringPolicy(false, false, 1200);
  assert.equal(slow.stiffness, 170);
  approx(slow.damping, 2.2 * Math.sqrt(170));
  // 中点间隔 → ratio^0.2 插值
  const mid = getPosYSpringPolicy(false, false, 450);
  const ratio = (1 - (450 - 100) / 700) ** 0.2;
  approx(mid.stiffness, 170 + ratio * 50);
});

test('Spring settles analytically and honours queued targets/params', () => {
  const spring = new Spring(5);
  assert.equal(spring.getCurrentPosition(), 5);
  assert.equal(spring.arrived(), true);

  spring.setTargetPosition(10);
  assert.equal(spring.arrived(), false);
  const settled = settle(spring);
  approx(settled, 10, 0.05);

  // 软弹簧（过阻尼）不应过冲
  const soft = new Spring(0);
  soft.updateParams({ soft: true, stiffness: 100, damping: 10, mass: 1 });
  soft.setTargetPosition(100);
  let maxSeen = 0;
  for (let i = 0; i < 600; i++) {
    soft.update(16);
    maxSeen = Math.max(maxSeen, soft.getCurrentPosition());
    if (soft.arrived()) break;
  }
  assert.ok(maxSeen <= 100 + 1e-6, `soft spring overshoot: ${maxSeen}`);
  approx(soft.getCurrentPosition(), 100, 0.05);

  // 带延迟的目标：延迟到期前不动，到期后开始逼近
  const queued = new Spring(0);
  queued.setTargetPosition(20, 100);
  queued.update(50);
  approx(queued.getCurrentPosition(), 0, 0.05, '延迟未到期位置应保持');
  assert.equal(queued.arrived(), false, '存在排队目标时不得视为 arrived');
  queued.update(60);
  assert.equal(queued.arrived(), false, '目标生效后应处于运动中');
  queued.update(3000);
  approx(queued.getCurrentPosition(), 20, 0.05);
});

test('TimelineController keeps finished lines highlighted until replaced', () => {
  const timeline = new TimelineController();
  const bounds = [
    { startTime: 1000, endTime: 5000 },
    { startTime: 8000, endTime: 12000 },
  ];
  timeline.setTimeBounds(bounds);

  let diff = timeline.sync(2000);
  assert.deepEqual([...diff.addedPlaying], [0]);
  assert.ok(timeline.getSnapshot().highlightedGroups.has(0));
  assert.equal(timeline.getSnapshot().scrollToIndex, 0);

  // 唱完不熄灭：line0 结束后没有新行接续，高亮保持
  diff = timeline.sync(6000);
  assert.deepEqual([...diff.removedPlaying], [0]);
  assert.deepEqual([...diff.removedHighlighted], []);
  assert.ok(timeline.getSnapshot().highlightedGroups.has(0));
  assert.equal(timeline.getSnapshot().scrollToIndex, 0);
  assert.equal(timeline.getSnapshot().latestHighlightedIndex, 0);

  // 新行开始播放时旧高亮一起熄灭
  diff = timeline.sync(8500);
  assert.deepEqual([...diff.addedPlaying], [1]);
  assert.deepEqual([...diff.removedHighlighted], [0]);
  assert.deepEqual([...timeline.getSnapshot().highlightedGroups], [1]);
  assert.equal(timeline.getSnapshot().scrollToIndex, 1);

  // 曲末清空全部高亮
  diff = timeline.sync(12500);
  assert.equal(timeline.getSnapshot().isEndOfSong, true);
  assert.deepEqual([...timeline.getSnapshot().highlightedGroups], []);
  assert.deepEqual([...diff.removedHighlighted], [1]);
  assert.equal(timeline.getSnapshot().latestHighlightedIndex, undefined);
});

test('TimelineController precalculates interludes with prefix-max union', () => {
  const timeline = new TimelineController();
  // 行 1 的结束时间早于行 0（被行 0 包住），前缀最大并集必须仍然不与歌词重叠
  timeline.setTimeBounds([
    { startTime: 1000, endTime: 9000 },
    { startTime: 2000, endTime: 3000 },
    { startTime: 18000, endTime: 19000 },
  ]);

  timeline.sync(10000);
  const interlude = timeline.getSnapshot().activeInterlude;
  assert.ok(interlude, '9s 空隙必须命中间奏');
  assert.equal(interlude.startTime, 9000);
  assert.equal(interlude.endTime, 18000);
  // 锚点 = 显示顺序上间奏前的最后一行（行 1 起始时间晚于行 0）
  assert.equal(interlude.anchorLineIndex, 1);
  assert.equal(timeline.getSnapshot().isFocusOnInterlude, true);

  // 短空隙不构成间奏
  const short = new TimelineController();
  short.setTimeBounds([
    { startTime: 0, endTime: 5000 },
    { startTime: 9000, endTime: 12000 },
  ]);
  short.sync(2000);
  short.sync(6000);
  assert.equal(short.getSnapshot().activeInterlude, undefined);
  assert.equal(short.getSnapshot().isFocusOnInterlude, false);
  // 4s 空隙小于 7s 阈值，高亮保持
  assert.ok(short.getSnapshot().highlightedGroups.has(0));
});

test('TimelineController seek rebuilds highlight state like playback', () => {
  const timeline = new TimelineController();
  timeline.setTimeBounds([
    { startTime: 1000, endTime: 5000 },
    { startTime: 5000, endTime: 8000 },
    { startTime: 8000, endTime: 11000 },
  ]);

  // 跳到第二行中段：锚点向前重建，锚点前已结束的行不再亮
  timeline.sync(0, true);
  timeline.sync(6000, true);
  let snapshot = timeline.getSnapshot();
  assert.deepEqual([...snapshot.playingGroups], [1]);
  assert.deepEqual([...snapshot.highlightedGroups], [1]);
  assert.equal(snapshot.scrollToIndex, 1);

  // 跳到曲末：无行在播，高亮清空
  timeline.sync(9000, false); // 先让 line2 进入播放
  timeline.sync(14000, true);
  snapshot = timeline.getSnapshot();
  assert.equal(snapshot.isEndOfSong, true);
  assert.deepEqual([...snapshot.highlightedGroups], []);

  // 跳回开头
  timeline.sync(500, true);
  snapshot = timeline.getSnapshot();
  assert.deepEqual([...snapshot.playingGroups], []);
  assert.deepEqual([...snapshot.highlightedGroups], []);
  assert.equal(snapshot.scrollToIndex, 0);
  assert.equal(snapshot.isEndOfSong, false);
});

test('Seek into interlude with no playing lines clears highlights', () => {
  const timeline = new TimelineController();
  timeline.setTimeBounds([
    { startTime: 1000, endTime: 5000 },
    { startTime: 15000, endTime: 18000 },
  ]);

  timeline.sync(2000);
  assert.ok(timeline.getSnapshot().highlightedGroups.has(0));

  const diff = timeline.sync(10000, true);
  const snapshot = timeline.getSnapshot();
  assert.ok(snapshot.activeInterlude);
  assert.deepEqual([...snapshot.playingGroups], []);
  assert.deepEqual([...snapshot.highlightedGroups], []);
  assert.deepEqual([...diff.removedHighlighted], [0]);
  assert.equal(snapshot.isFocusOnInterlude, true);
});

test('FocusController freezes during suspension and follows playback otherwise', () => {
  const focus = new FocusController();
  const baseSnapshot = {
    isFocusOnInterlude: false,
    activeInterlude: undefined,
    isEndOfSong: false,
    scrollToIndex: 2,
  };

  // 先在未挂起状态跟随到 index 1，再挂起 → 冻结保持
  focus.resolve({ ...baseSnapshot, scrollToIndex: 1 }, 5, {
    isAutoAlignSuspended: false,
    hasBottomContent: false,
    canDisplayInterlude: false,
  });
  let target = focus.resolve(baseSnapshot, 5, {
    isAutoAlignSuspended: true,
    hasBottomContent: false,
    canDisplayInterlude: false,
  });
  assert.deepEqual(target, { type: 'line', index: 1 });

  // 未挂起时常规跟随 scrollToIndex
  target = focus.resolve(baseSnapshot, 5, {
    isAutoAlignSuspended: false,
    hasBottomContent: false,
    canDisplayInterlude: false,
  });
  assert.deepEqual(target, { type: 'line', index: 2 });

  // 间奏命中且可显示 → 对齐间奏点
  target = focus.resolve(
    {
      ...baseSnapshot,
      isFocusOnInterlude: true,
      activeInterlude: { startTime: 0, endTime: 1, anchorLineIndex: 2 },
    },
    5,
    {
      isAutoAlignSuspended: false,
      hasBottomContent: false,
      canDisplayInterlude: true,
    },
  );
  assert.deepEqual(target, { type: 'interlude', anchorIndex: 2 });

  // 间奏不可显示 → 顺延到下一行
  target = focus.resolve(
    {
      ...baseSnapshot,
      isFocusOnInterlude: true,
      activeInterlude: { startTime: 0, endTime: 1, anchorLineIndex: 2 },
    },
    5,
    {
      isAutoAlignSuspended: false,
      hasBottomContent: false,
      canDisplayInterlude: false,
    },
  );
  assert.deepEqual(target, { type: 'line', index: 3 });

  // 曲末 → 最后一行（无底栏）
  target = focus.resolve({ ...baseSnapshot, isEndOfSong: true }, 5, {
    isAutoAlignSuspended: false,
    hasBottomContent: false,
    canDisplayInterlude: false,
  });
  assert.deepEqual(target, { type: 'line', index: 4 });
});

test('ScrollInteractionEngine clamps offsets and resumes auto-align after 500ms', () => {
  let clock = 0;
  const events = [];
  const engine = new ScrollInteractionEngine(
    {
      onScrollUpdate: (isContinuous) => events.push(['scroll', isContinuous]),
      onInteractionStart: (type) => events.push(['start', type]),
    },
    () => clock,
  );

  engine.updateBoundary(-100, 500);
  assert.equal(engine.offset, 0);

  // 滚轮：离散输入，直接叠加
  engine.wheel(120, true);
  assert.equal(engine.offset, 120);
  assert.equal(engine.isInteracting, true);
  assert.ok(events.some((e) => e[0] === 'start' && e[1] === 'wheel'));
  assert.ok(events.some((e) => e[0] === 'scroll' && e[1] === false));

  // 150ms 空闲后结束交互；结束后 500ms 才允许恢复自动对齐
  clock += 150;
  engine.tick();
  assert.equal(engine.isInteracting, false);
  clock += 100;
  assert.equal(engine.canResumeAutoAlign(), false);
  clock += 500;
  assert.equal(engine.canResumeAutoAlign(), true);

  // 边界钳制
  engine.resetScroll(400);
  assert.equal(engine.offset, 400);
  engine.wheel(500, true);
  assert.equal(engine.offset, 500, '滚轮 500px 不应越过 max 500');
  engine.wheel(-1000, true);
  assert.equal(engine.offset, -100, '向下滚动不应越过 min -100');
});

test('ScrollInteractionEngine touch intent, inertia decay and boundary clamp', () => {
  let clock = 0;
  const engine = new ScrollInteractionEngine(
    { onScrollUpdate: () => {}, onInteractionStart: () => {} },
    () => clock,
  );
  engine.updateBoundary(-1000, 1000);

  // 5px 不确认意图
  engine.beginTouch(0, 0, clock);
  assert.equal(engine.moveTouch(0, 5, clock + 50), false);
  assert.equal(engine.isInteracting, false);

  // 超过 10px 确认意图，offset = startOffset - deltaY
  assert.equal(engine.moveTouch(0, 30, clock + 100), true);
  assert.equal(engine.isInteracting, true);
  assert.equal(engine.offset, -30);

  // 松手启动惯性（速度 0.3px/ms）
  clock += 100;
  engine.endTouch(clock);
  assert.equal(engine.inertiaActive, true);

  // 单步惯性：offset -= speed*dt，speed *= 0.95^(dt/16.67)
  const before = engine.offset;
  const speedBefore = engine.touchState.speed;
  clock += 101; // 超过 100ms 的帧被丢弃
  engine.tick();
  assert.equal(engine.offset, before, '超过 100ms 的帧应丢弃步进');
  clock += 16;
  engine.tick();
  assert.ok(engine.offset < before, '惯性应继续推进 offset');
  approx(engine.touchState.speed, speedBefore * 0.95 ** (16 / (1000 / 60)), 1e-6);

  // 惯性衰减到 0.05 以下后结束
  for (let i = 0; i < 200; i++) {
    clock += 16;
    engine.tick();
  }
  assert.equal(engine.inertiaActive, false);
  assert.equal(engine.isInteracting, false);

  // 触摸拖动越界被钳制
  engine.beginTouch(0, 0, clock);
  engine.moveTouch(0, -5000, clock + 50);
  assert.equal(engine.offset, 1000, '向上拖动不应越过 max 1000');
});

test('LayoutCalculator prefix sums, focal metrics and interlude shift', () => {
  const layout = new LayoutCalculator();
  layout.initHeights(3, 100);
  assert.equal(layout.getLineHeight(1), 100);
  layout.setLineHeight(1, 250);
  assert.equal(layout.getLineHeight(1), 250);
  assert.equal(layout.getLineHeight(0), 100);
  assert.equal(layout.getLineHeight(2), 100);

  const ctx = {
    containerHeight: 1000,
    scrollOffset: 0,
    target: { type: 'line', index: 1 },
    bottomLineHeight: 0,
    interlude: undefined,
  };
  const config = { alignAnchor: 'center', alignPosition: 0.5, overscanPx: 0 };

  const { bounds, session } = layout.beginFrame(ctx, config);
  // focalTopY = 100，anchorOffset = 125
  approx(session.focalTopY, 100);
  approx(session.anchorOffset, 125);
  assert.equal(bounds.min, -100);
  // base = -100 + 500 - 125 = 275；max = max(0, 275 + 450 - 500) = 225
  assert.equal(bounds.max, 225);

  const result = layout.commit(session, 0);
  assert.equal(result.lineCount, 3);
  approx(result.lineInstructions[0].y, 275);
  approx(result.lineInstructions[1].y, 375);
  approx(result.lineInstructions[2].y, 625);
  assert.ok(result.lineInstructions.every((ins) => ins.isInViewport));

  // 间奏挂在行 0 之后：焦点行（>锚点）与后续行整体下移
  const interludeCtx = {
    containerHeight: 1000,
    scrollOffset: 0,
    target: { type: 'line', index: 1 },
    bottomLineHeight: 0,
    interlude: { totalHeight: 200, anchorIndex: 0 },
  };
  const withInterlude = layout.beginFrame(interludeCtx, config);
  approx(withInterlude.session.focalTopY, 300, 0.001, '焦点行应被间奏高度下推');
  const shifted = layout.commit(withInterlude.session, 0);
  approx(shifted.lineInstructions[0].y, 75);
  approx(shifted.lineInstructions[1].y, 375);
  approx(shifted.lineInstructions[2].y, 625);
  assert.equal(shifted.hasInterlude, true);
  approx(shifted.interludeY, 175);

  // 滚动偏移整体上移
  const scrolled = layout.commit(withInterlude.session, 50);
  approx(scrolled.lineInstructions[1].y, 325);
});

test('SeekDetector distinguishes drift from jitter', () => {
  let clock = 0;
  const detector = new SeekDetector(() => clock);

  // 首次建立基线
  assert.equal(detector.detect(1000, true), false);

  // 播放中：推进量与物理时钟一致 → 非跳转
  clock += 100;
  assert.equal(detector.detect(1100, true), false);

  // 播放中超量前进（容差 = max(150, wallDelta*0.5)，wallDelta 钳到 800）→ 跳转
  clock += 100;
  assert.equal(detector.detect(1400, true), true);

  // 暂停中前进超过抖动底限（150ms）→ 跳转；底限内 → 连续
  assert.equal(detector.detect(1650, false), true, '暂停中前进 250ms 应视为跳转');
  clock += 50;
  assert.equal(detector.detect(1750, false), false, '暂停中 100ms 内的微动不应视为跳转');

  // 倒退一律跳转
  assert.equal(detector.detect(1000, true), true);
});

test('InterludeDots full lifecycle: enter, breathe, fallback and dismiss fade', () => {
  const dots = new InterludeDots();

  // 20s 间奏：body = 20000 - 500 - 1000 = 18500 ≥ 3s → breathe 模式
  assert.equal(dots.setInterlude([20000, 40000]), true);
  assert.equal(dots.phase, 'performing');
  assert.equal(dots.mode, 'breathe');

  // 入场延迟 500ms 内完全透明
  dots.syncClock(20000);
  dots.update(0);
  assert.equal(dots.getSnapshot().isActive, true);
  assert.equal(dots.getSnapshot().opacity, 0);

  // 入场后容器渐入，圆点 1 先点亮
  dots.update(600);
  let snap = dots.getSnapshot();
  assert.ok(snap.opacity > 0, '入场延迟结束后应开始渐入');
  assert.ok(snap.dotOpacities[0] > 0, '圆点 1 应开始点亮');
  assert.equal(snap.dotOpacities[2], 0, '圆点 3 应在错峰延迟（160ms）前保持熄灭');
  assert.ok(snap.scale > 1, '呼吸缩放应处于上升段');

  // 演出时长不足进退场 → 隐藏
  const short = new InterludeDots();
  assert.equal(short.setInterlude([0, 2000]), false);
  assert.equal(short.phase, 'idle');

  // 短主体降级 fallback-hold：缩放恒 1，三颗圆点错峰淡入并保持全亮
  const fallback = new InterludeDots();
  assert.equal(fallback.setInterlude([0, 4000]), true);
  assert.equal(fallback.mode, 'fallback-hold');
  fallback.syncClock(0);
  fallback.update(1600);
  snap = fallback.getSnapshot();
  assert.equal(snap.scale, 1);
  assert.ok(snap.dotOpacities[0] > 0.2, '圆点错峰淡入完成后应接近全亮');

  // 演出自然结束 → 回到 idle
  const ending = new InterludeDots();
  ending.setInterlude([0, 4000]);
  ending.syncClock(0);
  for (let i = 0; i < 200; i++) ending.update(50);
  assert.equal(ending.phase, 'idle');
  assert.equal(ending.getSnapshot().isActive, false);

  // dismiss 触发 150ms 淡出
  const dismissing = new InterludeDots();
  dismissing.setInterlude([0, 60000]);
  dismissing.syncClock(0);
  dismissing.update(600);
  const fadeStart = dismissing.getSnapshot().opacity;
  assert.ok(fadeStart > 0);
  dismissing.dismiss();
  assert.equal(dismissing.phase, 'fading');
  dismissing.update(200);
  assert.equal(dismissing.getSnapshot().isActive, false, '淡出完成后应隐藏');
  assert.equal(dismissing.getSnapshot().opacity, 0);
});

test('LyricPlayerCore end-to-end: highlight lifecycle, opacity, blur, stagger', () => {
  const rebuilds = [];
  const player = new LyricPlayerCore({ onGroupsChanged: () => rebuilds.push(1) }, { now: () => 0 });
  // 关闭自动跳转推导，用显式 forceSeek 测试跳转路径（时钟冻结下推导必然误报）
  player.setEnableAutoSeekDetection(false);
  player.setSize(800, 1000);
  player.setBaseFontSize(30);
  player.resume();

  const words = (start, end, n) =>
    Array.from({ length: n }, (_, i) => ({
      startTime: start + ((end - start) * i) / n,
      endTime: start + ((end - start) * (i + 1)) / n,
      word: `w${i}`,
    }));
  const lines = [
    { startTime: 1000, endTime: 5000, words: words(1000, 5000, 2) },
    { startTime: 8000, endTime: 12000, words: words(8000, 12000, 2) },
    { startTime: 12000, endTime: 16000, words: words(12000, 16000, 2) },
  ];
  player.setLyricLines(lines, 500);
  assert.equal(player.currentLyricGroups.length, 3);
  assert.equal(rebuilds.length, 1);
  assert.equal(player.isNonDynamic, false);

  const [g0, g1, g2] = player.currentLyricGroups;

  // 高亮行 0：isActive、GRADIENT、0.85 透明度；焦点行无模糊
  player.setCurrentTime(1500);
  assert.equal(g0.isActive, true);
  assert.equal(g0.mainLine.renderMode, 1, '活动行应为 GRADIENT 模式');
  assert.equal(g0.opacity, 0.85);
  assert.equal(g0.blur, 0);
  assert.equal(g0.mainLine.isEnabled, true);
  assert.equal(g0.mainLine.enabledAtTime, 1500, '启用时间应为命中高亮的媒体时间');

  // 非活动行保持动态歌词全透明度并按距离模糊（宽 800 ≤ 1024 → 窄视口打 0.8 折）
  assert.equal(g1.opacity, 1);
  approx(g1.blur, (1 + 1) * 0.8, 1e-9, '窄视口下模糊档位应打 0.8 折');
  approx(g2.blur, (1 + 2) * 0.8);

  // 阶梯延迟：0 / 50 / 50+50/1.05
  assert.equal(g0.delay, 0);
  approx(g1.delay, 50);
  approx(g2.delay, 50 + 50 / 1.05);

  // 重建后的默认弹簧参数（AMLL posY 起步 {m0.9, d15, k90}）
  approx(player.posYSpringParams.stiffness, 90);

  // 唱完不熄灭：6000ms 处 line0 已唱完且无新行，高亮保持
  player.setCurrentTime(6000);
  assert.equal(g0.isActive, true, '唱完后应保持高亮直到新行开始');
  assert.equal(g0.mainLine.renderMode, 1);
  assert.equal(g1.isActive, false, '句间空隙内下一行尚未点亮');

  // 新行开始 → 旧行熄灭、新行 GRADIENT；scrollToIndex 变更触发区间弹簧策略
  player.setCurrentTime(8500);
  assert.equal(g0.isActive, false);
  assert.equal(g1.isActive, true);
  assert.equal(g1.mainLine.renderMode, 1);
  assert.equal(g0.mainLine.renderMode, 0, '熄灭行应回到 SOLID');
  approx(g0.blur, (1 + 2) * 0.8, 1e-9, '焦点后方第 1 行模糊档位为 3');
  assert.equal(g1.blur, 0, '焦点行无模糊');
  approx(
    player.posYSpringParams.stiffness,
    170,
    1e-9,
    '行间隔 7000ms 钳制到 800ms 档 → stiffness 170',
  );

  // 末行高亮保持；曲末判定后清空
  player.setCurrentTime(15500);
  assert.equal(g2.isActive, true);
  assert.equal(g2.opacity, 0.85);
  player.setCurrentTime(16000);
  assert.equal(
    player.timelineController.getSnapshot().isEndOfSong,
    true,
    '越过最晚结束时间即判定曲末',
  );
  assert.equal(
    player.currentLyricGroups.every((g) => !g.isActive),
    true,
  );
  assert.equal(g2.opacity, 1, '高亮清空后回到非高亮透明度');

  // 逐行歌词：非高亮行 0.2 透明度
  const linePlayer = new LyricPlayerCore({}, { now: () => 0 });
  linePlayer.setEnableAutoSeekDetection(false);
  linePlayer.setSize(800, 1000);
  linePlayer.setLyricLines(
    [
      { startTime: 0, endTime: 4000, words: [{ startTime: 0, endTime: 4000, word: '整行' }] },
      {
        startTime: 4000,
        endTime: 8000,
        words: [{ startTime: 4000, endTime: 8000, word: '第二行' }],
      },
    ],
    0,
  );
  linePlayer.setCurrentTime(1000);
  assert.equal(linePlayer.isNonDynamic, true);
  assert.equal(linePlayer.currentLyricGroups[1].opacity, 0.2);
});

test('LyricPlayerCore interlude focus, dots placement and seek policy', () => {
  const player = new LyricPlayerCore({}, { now: () => 0 });
  player.setEnableAutoSeekDetection(false);
  player.setSize(800, 1000);
  player.setBaseFontSize(30);
  player.setInterludeMeasured(60, 24);
  player.resume();

  player.setLyricLines(
    [
      {
        startTime: 1000,
        endTime: 5000,
        words: [
          { startTime: 1000, endTime: 3000, word: 'a' },
          { startTime: 3000, endTime: 5000, word: 'b' },
        ],
      },
      {
        startTime: 15000,
        endTime: 19000,
        words: [{ startTime: 15000, endTime: 19000, word: 'c' }],
      },
    ],
    1000,
  );

  player.setCurrentTime(10000);
  const snapshot = player.timelineController.getSnapshot();
  assert.equal(snapshot.isFocusOnInterlude, true);
  assert.ok(player.interludeDots.getSnapshot().isActive, '间奏点应进入演出');
  assert.ok(player.interludeDots.top > 0, '间奏点应挂在行 0 之后的排版位置');

  approx(player.posYSpringParams.stiffness, 90, 1e-9, '间奏期间应使用慢速弹簧');

  // 间奏结束回到歌词行，弹簧恢复区间策略
  player.setCurrentTime(16000);
  approx(player.posYSpringParams.stiffness, 170, 1e-9, '行间隔 14000ms 钳制到 800ms 档');

  // 跳转路径：慢速弹簧 + 间奏重置
  player.setCurrentTime(10000, true);
  approx(player.posYSpringParams.stiffness, 90, 1e-9, 'Seek 期间应使用慢速弹簧');
});

test('LyricPlayerCore wheel suspension freezes focus and resumes after 500ms', () => {
  let clock = 0;
  const player = new LyricPlayerCore({}, { now: () => clock });
  player.setEnableAutoSeekDetection(false);
  player.setSize(800, 1000);
  player.setLyricLines(
    [
      { startTime: 0, endTime: 4000, words: [{ startTime: 0, endTime: 4000, word: 'a' }] },
      { startTime: 4000, endTime: 8000, words: [{ startTime: 4000, endTime: 8000, word: 'b' }] },
      { startTime: 8000, endTime: 12000, words: [{ startTime: 8000, endTime: 12000, word: 'c' }] },
      {
        startTime: 12000,
        endTime: 16000,
        words: [{ startTime: 12000, endTime: 16000, word: 'd' }],
      },
    ],
    0,
  );
  player.resume();
  player.setCurrentTime(1000);
  pump(player);

  // 滚轮挂起自动对齐
  player.scrollEngine.wheel(200, true);
  assert.equal(player.scrollState.isAutoAlignSuspended, true);
  assert.equal(player.scrollState.isTouchScrolled, false);
  assert.equal(player.focusController.target.index, 0, '焦点应冻结在首行');

  // 挂起期间时间推进不跟随（scrollToIndex 已变为 1）
  player.setCurrentTime(5000);
  assert.equal(player.focusController.target.index, 0, '挂起期间焦点应保持冻结');
  assert.equal(player.scrollState.isAutoAlignSuspended, true);

  // 滚轮空闲 150ms 后结束交互，但 500ms 内仍不恢复
  clock += 300;
  player.update(16);
  assert.equal(player.scrollEngine.isInteracting, false);
  player.setCurrentTime(5600);
  assert.equal(player.scrollState.isAutoAlignSuspended, true);

  // 静止超过 500ms 且 scrollToIndex 再次变化 → 恢复自动对齐
  clock += 600;
  pump(player, 200);
  player.setCurrentTime(8300);
  assert.equal(player.scrollState.isAutoAlignSuspended, false, '滚动静止 500ms 后应恢复跟随');
  assert.equal(player.scrollEngine.offset, 0, '恢复时应清空滚动偏移');
});

test('LyricPlayerCore measures lines and rebuilds view deterministically', () => {
  const player = new LyricPlayerCore({}, { now: () => 0 });
  player.setEnableAutoSeekDetection(false);
  player.setSize(800, 1000);

  player.setLyricLines(
    [
      { startTime: 0, endTime: 4000, words: [{ startTime: 0, endTime: 4000, word: 'a' }] },
      { startTime: 4000, endTime: 8000, words: [{ startTime: 4000, endTime: 8000, word: 'b' }] },
    ],
    0,
  );

  // 未测量前使用回退高度 containerHeight / 5
  assert.equal(player.getLineHeight(0), 200);
  player.setGroupMeasured(0, 800, 260);
  assert.equal(player.getLineHeight(0), 260);
  player.setGroupMeasured(0, 800, 260);
  assert.equal(player.getLineHeight(0), 260, '重复上报相同尺寸不应重复排版');

  // MAX_FRAME_DELTA 钳制页面挂起场景（常量锁定）
  assert.equal(MAX_FRAME_DELTA, 100);

  // 对唱行检测：间奏点在下一行是对唱时右对齐
  player.setLyricLines(
    [
      { startTime: 0, endTime: 1000, words: [{ startTime: 0, endTime: 1000, word: 'a' }] },
      {
        startTime: 9000,
        endTime: 12000,
        words: [{ startTime: 9000, endTime: 12000, word: 'b' }],
        isDuet: true,
      },
    ],
    0,
  );
  assert.equal(player.hasDuetLine, true);
  player.setCurrentTime(5000);
  assert.ok(player.interludeDots.left > 0, '下一行对唱时间奏点应右对齐');
});

test('LayoutReasonStrategyMap and line core mirrors AMLL semantics', () => {
  assert.equal(LayoutReasonStrategyMap[LayoutReason.ContinuousScroll].snapPosY, true);
  assert.equal(LayoutReasonStrategyMap[LayoutReason.Seek].resetInterlude, true);
  assert.equal(LayoutReasonStrategyMap[LayoutReason.RebuildView].snapPosY, false);

  // shouldEmphasize：CJK 长音节 ≥1s；非 CJK 2~7 字符且 ≥1s
  assert.equal(LyricLineCore.shouldEmphasize({ word: '梦', startTime: 0, endTime: 1200 }), true);
  assert.equal(LyricLineCore.shouldEmphasize({ word: '梦', startTime: 0, endTime: 900 }), false);
  assert.equal(
    LyricLineCore.shouldEmphasize({ word: 'o', startTime: 0, endTime: 1200 }),
    false,
    '单字符不强调',
  );
  assert.equal(
    LyricLineCore.shouldEmphasize({ word: 'oh', startTime: 0, endTime: 1200 }),
    true,
    '2~7 字符且 ≥1s 应强调',
  );
  assert.equal(LyricLineCore.shouldEmphasize({ word: 'yeah', startTime: 0, endTime: 1200 }), true);
  assert.equal(
    LyricLineCore.shouldEmphasize({
      word: 'supercalifragilistic',
      startTime: 0,
      endTime: 1200,
    }),
    false,
  );
  assert.equal(isCJK('你好'), true);
  assert.equal(isCJK('hello'), false);
});

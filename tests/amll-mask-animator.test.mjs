import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateMaskPosition,
  generateWordKeyframes,
  maskBandCenter,
} from '../plugins/apple-music-style/qml/amll/base/index.mjs';

const F = 30;

// 三词连续文本坐标词表：x0 = 前词 x1（AMLL 词文本盒连续），时间含一个
// 词间停顿（词 1→词 2 之间 600ms）
function fixture() {
  const words = [
    { width: 100, t0: 0, t1: 1000 },
    { width: 80, t0: 1000, t1: 2000 },
    { width: 120, t0: 2600, t1: 3600 },
  ];
  const keyframes = generateWordKeyframes(words, 0, 3600, F);
  const x0 = [0, 100, 180];
  // 各词带心（连续文本坐标）：带心 = x0 + X + width + f/2
  const centers = keyframes.map(
    (k, i) => (t) =>
      maskBandCenter(x0[i], words[i].width, evaluateMaskPosition(k.frames, t, 0, 3600), F),
  );
  return { words, keyframes, x0, centers };
}

test('行首各词全暗：X 钳制在 minOffset，带右缘不越过文本起点', () => {
  const { keyframes, x0, words } = fixture();
  keyframes.forEach((k, i) => {
    const x = evaluateMaskPosition(k.frames, 0, 0, 3600);
    assert.equal(x, k.minOffset, `词 ${i} 行首应驻停在 minOffset`);
    const center = maskBandCenter(x0[i], words[i].width, x, F);
    assert.ok(center <= x0[i] - F / 2 + 1e-9, `词 ${i} 行首应全暗`);
  });
  // AMLL 初始位置钳制在 minOffset：首词带心 = x0 - f/2（非钳制游标值 x0 - 1.5f）
  assert.equal(evaluateMaskPosition(keyframes[0].frames, 0, 0, 3600), -(100 + F));
});

test('词 i 开始（i>0）带心恰在词文本起点', () => {
  const { centers, x0 } = fixture();
  assert.equal(centers[1](1000), x0[1]);
  assert.equal(centers[2](2600), x0[2]);
});

test('词 i 结束（非末）带心恰在词文本终点', () => {
  const { centers, words, x0 } = fixture();
  assert.equal(centers[0](1000), x0[0] + words[0].width);
  assert.equal(centers[1](2000), x0[1] + words[1].width);
});

test('末词结束时带左缘恰在文本终点（整词全亮）', () => {
  const { centers, words, x0 } = fixture();
  assert.equal(centers[2](3600), x0[2] + words[2].width + F / 2);
});

test('词间停顿带冻结（时间推进位置不动）', () => {
  const { centers } = fixture();
  // 词 1 唱完（2000）到词 2 开唱（2600）之间：词 1 带心停在文本终点，
  // 词 2 带心停在文本起点（游标冻结，均不推进）
  assert.equal(centers[1](2000), centers[1](2599.999));
  assert.equal(centers[2](2000), centers[2](2599.999));
  assert.equal(centers[2](2600), 180);
});

test('未入场词钳制 minOffset（全暗）、出场词钳制 0（全亮）', () => {
  const { keyframes } = fixture();
  assert.equal(evaluateMaskPosition(keyframes[2].frames, 500, 0, 3600), keyframes[2].minOffset);
  assert.equal(evaluateMaskPosition(keyframes[0].frames, 3000, 0, 3600), 0);
  keyframes.forEach((k) => {
    assert.equal(evaluateMaskPosition(k.frames, 5000, 0, 3600), 0);
  });
});

test('折点帧使驻停到线性启动连续（入场前带心恒定、入场后线性推进）', () => {
  const { centers } = fixture();
  // 词 2 在词 1 唱完后段入场（band 心越过 x0 - f/2 = 165 后开始推进）：
  // 驻停期带心恒 165，入场后线性趋近文本起点
  assert.equal(centers[2](500), 165);
  assert.equal(centers[2](1500), 165);
  assert.ok(centers[2](1900) > 165 && centers[2](1900) < 180);
  assert.equal(centers[2](2000), 180);
});

test('空白词不入游标：空时间线，后词带相位不受空白词宽影响', () => {
  // "A␣C"：A [0,60)，空格 [60,80)（零时长），C [80,130)
  const words = [
    { width: 60, t0: 0, t1: 800 },
    { width: 20, t0: 800, t1: 800, blank: true },
    { width: 50, t0: 1000, t1: 2200 },
  ];
  const keyframes = generateWordKeyframes(words, 0, 2200, F);
  assert.equal(keyframes[1].frames.length, 0, '空白词应返回空时间线');
  assert.equal(evaluateMaskPosition(keyframes[1].frames, 1000, 0, 2200), 0);
  const c2 = (t) =>
    maskBandCenter(80, words[2].width, evaluateMaskPosition(keyframes[2].frames, t, 0, 2200), F);
  // C 开唱时带心恰在其文本起点（空白词宽 20 未折入游标）
  assert.equal(c2(1000), 80);
  // 空白词时长成为 C 的停顿步：带在 [800,1000] 冻结
  assert.equal(c2(800), c2(999.999));
  assert.equal(c2(2200), 80 + 50 + F / 2);
  // 词 A 的行程不含空格宽：结束带心 = 文本终点 60
  const c0 = (t) =>
    maskBandCenter(0, words[0].width, evaluateMaskPosition(keyframes[0].frames, t, 0, 2200), F);
  assert.equal(c0(800), 60);
});

test('零时长非空白词位置跳变折叠进后续关键帧（AMLL 同语义）', () => {
  const words = [
    { width: 100, t0: 0, t1: 1000 },
    { width: 50, t0: 2000, t1: 2000 },
    { width: 80, t0: 2000, t1: 3000 },
  ];
  const keyframes = generateWordKeyframes(words, 0, 3000, F);
  // 零时长词自身：t0 前后同值（其行程折叠、无独立关键帧），行末全亮
  const x1 = (t) => evaluateMaskPosition(keyframes[1].frames, t, 0, 3000);
  assert.equal(x1(1999), x1(2000));
  assert.equal(x1(3000), 0);
  // 折叠宽与后词行程一并落入后词的关键帧：后词在行末全亮
  assert.equal(evaluateMaskPosition(keyframes[2].frames, 3000, 0, 3000), 0);
  // 全部位置仍在合法域内
  keyframes.forEach((k) => {
    k.frames.forEach((f) => {
      assert.ok(f.position <= 1e-9 && f.position >= k.minOffset - 1e-9);
    });
  });
});

test('负时长（t1<t0）按 0 时长处理，不产生负推进', () => {
  const words = [
    { width: 100, t0: 1000, t1: 0 },
    { width: 80, t0: 1000, t1: 2000 },
  ];
  const keyframes = generateWordKeyframes(words, 0, 2000, F);
  keyframes.forEach((k) => {
    k.frames.forEach((f) => {
      assert.ok(f.position <= 1e-9 && f.position >= k.minOffset - 1e-9);
    });
  });
  // 后词行末全亮
  assert.equal(evaluateMaskPosition(keyframes[1].frames, 2000, 0, 2000), 0);
});

test('空词表返回空、空时间线求值为 0', () => {
  assert.equal(generateWordKeyframes([], 0, 1000, F).length, 0);
  assert.equal(evaluateMaskPosition([], 500, 0, 1000), 0);
});

test('maskBandCenter 钳制端点几何：全暗带右缘=x0、全亮带左缘=x1', () => {
  const x0 = 40,
    width = 90;
  assert.equal(maskBandCenter(x0, width, -(width + F), F), x0 - F / 2);
  assert.equal(maskBandCenter(x0, width, 0, F), x0 + width + F / 2);
});

// 等价性回归：旧实现 rawEdge（手写前沿累积）与关键帧模型在饱和亮度下逐时刻
// 等价——o(x) = 0.5 + (带心 - x)/fade，钳制到 [0,1]（≤0 全暗、≥1 全亮，
// 带内线性段必须精确相等）。锚定「观感不变」。
function legacyRawEdge(spans, timeMs, fade) {
  if (spans.length === 0) return -2 * fade;
  let position = spans[0].x0 - 1.5 * fade;
  for (let i = 0; i < spans.length; ++i) {
    const word = spans[i];
    const duration = word.t1 - word.t0;
    const progress =
      duration > 0
        ? Math.min(1, Math.max(0, (timeMs - word.t0) / duration))
        : timeMs >= word.t0
          ? 1
          : 0;
    position +=
      (word.x1 - word.x0 + (i === 0 ? 1.5 * fade : 0) + (i + 1 === spans.length ? 0.5 * fade : 0)) *
      progress;
  }
  return position;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

test('与旧 rawEdge 前沿在饱和亮度下逐时刻等价（含停顿）', () => {
  const spans = [
    { x0: 0, x1: 100, t0: 0, t1: 1000 },
    { x0: 100, x1: 180, t0: 1000, t1: 2000 },
    { x0: 180, x1: 300, t0: 2600, t1: 3600 },
  ];
  const keyframes = generateWordKeyframes(
    spans.map((s) => ({ width: s.x1 - s.x0, t0: s.t0, t1: s.t1 })),
    0,
    3600,
    F,
  );
  const centers = keyframes.map(
    (k, i) => (t) =>
      maskBandCenter(
        spans[i].x0,
        spans[i].x1 - spans[i].x0,
        evaluateMaskPosition(k.frames, t, 0, 3600),
        F,
      ),
  );
  for (let t = 0; t <= 3600; t += 25) {
    const edge = legacyRawEdge(spans, t, F);
    for (let i = 0; i < spans.length; ++i) {
      for (const x of [spans[i].x0, (spans[i].x0 + spans[i].x1) / 2, spans[i].x1]) {
        const legacy = clamp01(0.5 + (edge - x) / F);
        const modern = clamp01(0.5 + (centers[i](t) - x) / F);
        assert.ok(
          Math.abs(legacy - modern) < 1e-9,
          `t=${t} 词${i} x=${x}: legacy=${legacy} modern=${modern}`,
        );
      }
    }
  }
});

test('与旧 rawEdge 前沿等价：末词唱完后全亮驻停、行首前全暗', () => {
  const spans = [
    { x0: 0, x1: 70, t0: 200, t1: 800 },
    { x0: 70, x1: 150, t0: 800, t1: 1400 },
  ];
  const keyframes = generateWordKeyframes(
    spans.map((s) => ({ width: s.x1 - s.x0, t0: s.t0, t1: s.t1 })),
    200,
    1400,
    F,
  );
  const centers = keyframes.map(
    (k, i) => (t) =>
      maskBandCenter(
        spans[i].x0,
        spans[i].x1 - spans[i].x0,
        evaluateMaskPosition(k.frames, t, 200, 1400),
        F,
      ),
  );
  for (const t of [0, 100, 200, 1400, 1600, 3000]) {
    const edge = legacyRawEdge(spans, t, F);
    for (let i = 0; i < spans.length; ++i) {
      const legacy = clamp01(0.5 + (edge - spans[i].x1) / F);
      const modern = clamp01(0.5 + (centers[i](t) - spans[i].x1) / F);
      assert.ok(Math.abs(legacy - modern) < 1e-9, `t=${t} 词${i}`);
    }
  }
});

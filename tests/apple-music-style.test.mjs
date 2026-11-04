import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  DEFAULT_SETTINGS,
  SKIN_ID,
  clamp,
  normalizeSettings,
  qualityLabel,
  qualityTag,
  validateSettings,
} from '../plugins/apple-music-style/src/config.ts';

test('skin settings defaults mirror the ported plugin', () => {
  assert.equal(SKIN_ID, 'apple-music');
  assert.deepEqual(DEFAULT_SETTINGS, {
    enhanceContrast: false,
    fontScale: 100,
    fontWeight: 850,
    enableBlur: true,
    enableScale: true,
    enableSpring: true,
    fadeWidth: 50,
    alignPosition: 48,
  });
});

test('skin settings validation accepts the default set and full ranges', () => {
  assert.equal(validateSettings(DEFAULT_SETTINGS), true);
  assert.equal(validateSettings({}), true);
  assert.equal(
    validateSettings({ fontScale: 50, fontWeight: 300, fadeWidth: 0, alignPosition: 0 }),
    true,
  );
  assert.equal(
    validateSettings({
      fontScale: 200,
      fontWeight: 900,
      fadeWidth: 100,
      alignPosition: 100,
      enhanceContrast: true,
      enableBlur: false,
      enableScale: false,
      enableSpring: false,
    }),
    true,
  );
});

test('skin settings validation rejects wrong types and out-of-range values', () => {
  assert.ok(validateSettings('no').errors);
  assert.ok(validateSettings([]).errors);
  assert.ok(validateSettings({ fontScale: '150' }).errors);
  assert.ok(validateSettings({ fontScale: 49 }).errors);
  assert.ok(validateSettings({ fontScale: 201 }).errors);
  assert.ok(validateSettings({ fontWeight: 299 }).errors);
  assert.ok(validateSettings({ fontWeight: 901 }).errors);
  assert.ok(validateSettings({ fadeWidth: -1 }).errors);
  assert.ok(validateSettings({ fadeWidth: 101 }).errors);
  assert.ok(validateSettings({ alignPosition: -1 }).errors);
  assert.ok(validateSettings({ alignPosition: 101 }).errors);
  assert.ok(validateSettings({ enhanceContrast: 1 }).errors);
  assert.ok(validateSettings({ enableBlur: 'yes' }).errors);
  assert.ok(validateSettings({ enableScale: 0 }).errors);
  assert.ok(validateSettings({ enableSpring: null }).errors);
});

test('skin settings normalization clamps and fills defaults', () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({ enhanceContrast: 1 }).enhanceContrast, false);
  assert.deepEqual(normalizeSettings({ fontScale: 999 }), { ...DEFAULT_SETTINGS, fontScale: 200 });
  assert.deepEqual(normalizeSettings({ fontWeight: -5 }), { ...DEFAULT_SETTINGS, fontWeight: 300 });
  assert.deepEqual(normalizeSettings({ fadeWidth: 80 }), { ...DEFAULT_SETTINGS, fadeWidth: 80 });
  assert.deepEqual(normalizeSettings({ enableBlur: false }), {
    ...DEFAULT_SETTINGS,
    enableBlur: false,
  });
  assert.deepEqual(normalizeSettings({ enableScale: 0 }).enableScale, true);
  assert.deepEqual(normalizeSettings({ alignPosition: 33 }), {
    ...DEFAULT_SETTINGS,
    alignPosition: 33,
  });
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-5, 0, 3), 0);
});

test('quality badges mirror host quality keys and cloud sources', () => {
  for (const [quality, tag] of [
    ['standard', 'SD'],
    ['higher', 'HQ'],
    ['flac', 'SQ'],
    ['hi_res', 'HR'],
    ['viper_tape', 'VPT'],
    ['viper_clear', 'VPC'],
    ['viper_atmos', 'VPA'],
  ])
    assert.equal(qualityTag(quality, false), tag);
  assert.equal(qualityTag('cloud', true), 'CLD');
  assert.equal(qualityTag('unknown', false), '');
  assert.equal(qualityLabel('flac', false), '无损');
  assert.equal(qualityLabel('anything', true), '云盘');
  assert.equal(qualityLabel('unknown', false), '');
});

test('AMLL renderer wiring keeps the old plugin behavior in the skin', async () => {
  const pluginRoot = fileURLToPath(new URL('../plugins/apple-music-style/', import.meta.url));
  const skin = await readFile(pluginRoot + 'qml/Skin.qml', 'utf8');
  const flow = await readFile(pluginRoot + 'qml/LyricFlow.qml', 'utf8');
  const line = await readFile(pluginRoot + 'qml/AmllLine.qml', 'utf8');
  const spring = await readFile(pluginRoot + 'qml/AmllSpring.qml', 'utf8');
  const interlude = await readFile(pluginRoot + 'qml/AmllInterlude.qml', 'utf8');
  const config = JSON.parse(await readFile(pluginRoot + 'plugin.config.json', 'utf8'));
  const manifest = JSON.parse(await readFile(pluginRoot + 'manifest.json', 'utf8'));

  // 八项旧设置全部接线到渲染属性
  for (const key of [
    'enhanceContrast',
    'fontScale',
    'fontWeight',
    'enableBlur',
    'enableScale',
    'enableSpring',
    'fadeWidth',
    'alignPosition',
  ])
    assert.ok(skin.includes(`"${key}"`), `Skin.qml missing setting ${key}`);
  assert.ok(skin.includes('LyricFlow {'), '右栏必须使用 AMLL 歌词流');
  assert.ok(skin.includes('sublineOpacity: root.s.enhanceContrast ? 0.72 : 0.56'));
  assert.ok(skin.includes('wordFade: root.s.fadeWidth / 100'));
  assert.ok(skin.includes('focusPosition: root.s.alignPosition / 100'));
  assert.ok(!skin.includes('EchoPluginLyricsView'), '不再依赖宿主原生歌词视图');
  // 播放页背景直接复用宿主“封面歌词”模式的渲染器与材质语义
  assert.ok(skin.includes('import EchoMusic.Playback'), '背景必须导入宿主 Playback 模块');
  assert.ok(skin.includes('PlaybackBlurredBackground'), '背景必须复用宿主模糊封面渲染器');
  assert.ok(skin.includes('lyricBackground'), '底色必须走宿主 lyricBackground(封面主色)');
  assert.ok(!skin.includes('blurMax: 64'), '不再手搓封面模糊');

  // 时间轴/弹簧/间奏/逐词扫掠移植完整存在
  assert.ok(flow.includes('function rebuild()'));
  assert.ok(flow.includes('AmllInterlude'));
  assert.ok(flow.includes('scrollMotion.retarget'));
  assert.ok(flow.includes('EchoWheelScroll'));
  assert.ok(line.includes('hasWordTiming'));
  // 逐词行走宿主 GlyphRun 原生塑形：整行连字/字距与内建歌词页一致，
  // 单层按词元簇颜色/透明度插值呈现 AMLL 软边前沿（GlyphRun 经 layer 抓取会丢内容）
  assert.ok(line.includes('import EchoMusic.PluginSdk'), 'AmllLine 必须使用宿主 GlyphRun');
  assert.ok(line.includes('GlyphRun {'));
  assert.ok(line.includes('clusterStart'));
  assert.ok(line.includes('maxWidth'));
  assert.ok(line.includes('__sweepPoses'), '扫掠必须按词元簇求值');
  assert.ok(line.includes('0.5 + (edge - x) / fade'), '簇透明度必须由前沿与软边求值');
  assert.ok(line.includes('dimColor'), '未唱样必须随高亮量提亮（宿主 0.2 → 0.4）');
  assert.ok(line.includes('brightColor'), '已唱样必须随高亮量从未唱色渐入');
  assert.ok(!line.includes('layer.enabled'), 'GlyphRun 不得进入 layer 抓取');
  assert.ok(skin.includes('Qt.rgba(1, 1, 1, 0.2)'), '未唱色必须用宿主默认 20% 白');
  for (const feature of ['text.glyphs', 'graphics.glyphRun.canvas', 'settings.host'])
    assert.ok(manifest.requires.features.includes(feature), `manifest missing ${feature}`);
  assert.ok(
    manifest.capabilities.includes('hostSettings'),
    '读取宿主歌词设置需声明 hostSettings capability',
  );
  // 背景律动跟随宿主 backgroundRhythm：read/observe 同步 + 30fps 相位推进
  assert.ok(skin.includes("settings.read('lyrics')"));
  assert.ok(skin.includes('settings.observe('));
  assert.ok(skin.includes('backgroundRhythm'));
  assert.ok(skin.includes('hostPhase'));
  assert.ok(
    spring.includes('Math.pow((800 - Math.min(800, Math.max(100, intervalMs))) / 700, 0.2)'),
  );
  assert.ok(interlude.includes('__breath'));

  // 包配置：不带着色器（扫掠由词元簇 pose 完成）
  assert.ok(config.assets.includes('qml/LyricFlow.qml'));
  assert.ok(!config.shaders?.length, '扫掠不再依赖着色器');
  assert.ok(!config.assets.some((asset) => asset.startsWith('shaders/')));
  // 播放控制与播放顺序按钮样式对照旧插件：旧版内联 SVG 资产 + .amms-ctrl-btn 尺寸/配色
  assert.ok(skin.includes('AmCtrlButton'), '播放控制按钮必须使用旧版样式组件');
  assert.ok(skin.includes('icons/shuffle.svg'), '随机播放使用旧版图标');
  assert.ok(skin.includes('icons/loop.svg'), '列表循环使用旧版图标');
  assert.ok(skin.includes('icons/skip.svg'), '上一首/下一首使用旧版图标');
  assert.ok(skin.includes('icons/pause.svg') && skin.includes('icons/play.svg'));
  assert.ok(skin.includes('anchors.leftMargin: -13'), '两侧模式钮外扩 13px（旧版 margin 0 -13px）');
  assert.ok(skin.includes('alpha: root.playMode === 2 ? 1 : 0.5'), '随机激活态全白、非激活 0.5 白');
  for (const icon of ['shuffle', 'skip', 'play', 'pause', 'loop'])
    assert.ok(config.assets.includes(`qml/icons/${icon}.svg`), `缺少旧版图标资产 ${icon}.svg`);
});

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

test('skin settings defaults mirror the AMLL alignment default', () => {
  assert.equal(SKIN_ID, 'apple-music');
  assert.deepEqual(DEFAULT_SETTINGS, {
    fontScale: 100,
    fontWeight: 850,
    enableBlur: true,
    enableScale: true,
    enableSpring: true,
    fadeWidth: 50,
    alignPosition: 35,
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
  // 已移除的 enhanceContrast 键按未知键忽略，不得再参与校验
  assert.equal(validateSettings({ enhanceContrast: 1 }), true);
  assert.equal(validateSettings({ enhanceContrast: true }), true);
  assert.ok(validateSettings({ enableBlur: 'yes' }).errors);
  assert.ok(validateSettings({ enableScale: 0 }).errors);
  assert.ok(validateSettings({ enableSpring: null }).errors);
});

test('skin settings normalization clamps and fills defaults', () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
  // 已移除的 enhanceContrast 不再出现在归一化结果里
  assert.equal('enhanceContrast' in normalizeSettings({ enhanceContrast: 1 }), false);
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

test('AMLL base modules are dependency-free ES modules consumable from QML and Node', async () => {
  const pluginRoot = fileURLToPath(new URL('../plugins/apple-music-style/', import.meta.url));
  const config = JSON.parse(await readFile(pluginRoot + 'plugin.config.json', 'utf8'));

  // base 模块全部入包（QML .mjs 导入 + 结构保留）
  for (const mod of [
    'consts',
    'easing',
    'focus',
    'index',
    'interlude',
    'is-cjk',
    'layout',
    'line-group',
    'player',
    'scroll',
    'seek-detector',
    'spring',
    'timeline',
  ])
    assert.ok(
      config.assets.includes(`qml/amll/base/${mod}.mjs`),
      `plugin.config.json 缺少 base 模块 ${mod}.mjs`,
    );
  // base 出口是零依赖 ES module（可直接被 QML 引擎与 Node 消费）
  const player = await readFile(pluginRoot + 'qml/amll/base/player.mjs', 'utf8');
  assert.ok(player.includes('export class LyricPlayerCore'));
  assert.ok(player.includes('import {'), 'base 模块按 ES module 相对导入');
  assert.ok(!/from ['"]node:[^'"]+['"]/.test(player), '产物不得依赖 Node 内建模块');
  assert.ok(!/require\(/.test(player), '产物不得使用 CommonJS');
});

test('AMLL refactor wiring drives the lyric page through the base core', async () => {
  const pluginRoot = fileURLToPath(new URL('../plugins/apple-music-style/', import.meta.url));
  const skin = await readFile(pluginRoot + 'qml/Skin.qml', 'utf8');
  const flow = await readFile(pluginRoot + 'qml/LyricFlow.qml', 'utf8');
  const view = await readFile(pluginRoot + 'qml/amll/AmlLyricView.qml', 'utf8');
  const group = await readFile(pluginRoot + 'qml/amll/AmlGroupView.qml', 'utf8');
  const line = await readFile(pluginRoot + 'qml/amll/AmlLineView.qml', 'utf8');
  const dots = await readFile(pluginRoot + 'qml/amll/AmlInterludeDots.qml', 'utf8');
  const skinSettings = await readFile(pluginRoot + 'qml/SkinSettings.qml', 'utf8');
  const entry = await readFile(pluginRoot + 'entry.mjs', 'utf8');
  const config = JSON.parse(await readFile(pluginRoot + 'plugin.config.json', 'utf8'));
  const manifest = JSON.parse(await readFile(pluginRoot + 'manifest.json', 'utf8'));

  // 七项旧设置全部接线到渲染属性（enhanceContrast 已移除）
  for (const key of [
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
  assert.ok(skin.includes('sublineOpacity: 0.56'));
  assert.ok(!skin.includes('enhanceContrast'), '增强对比度设置已整体移除');
  assert.ok(skin.includes('wordFade: root.s.fadeWidth / 100'));
  assert.ok(skin.includes('focusPosition: root.s.alignPosition / 100'));
  // 对齐位置 AMLL 默认 0.35：QML 兜底与 entry.mjs 捆绑须与 config.ts 同步
  assert.ok(skin.includes('values.alignPosition, 35, 0, 100'), 'Skin.qml 兜底默认须为 35');
  assert.ok(
    skinSettings.includes('values.alignPosition, 35, 0, 100'),
    'SkinSettings.qml 兜底默认须为 35',
  );
  assert.ok(
    entry.includes('alignPosition: 35'),
    'entry.mjs 捆绑 DEFAULT_SETTINGS 须与 config.ts 同步',
  );
  // 恢复默认入口由宿主抽屉统一渲染（LyricSkinDrawer 底部 EchoSoftButton），
  // 插件设置面板不得自带——否则抽屉里出现两个重置按钮（忽略注释里的字样）
  const skinSettingsCode = skinSettings.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!skinSettingsCode.includes('恢复默认'), 'SkinSettings 不得自带恢复默认按钮');
  assert.ok(!skinSettingsCode.includes('errorMessage'), '错误提示同样由宿主抽屉渲染');
  assert.ok(!skinSettingsCode.includes('调整歌词外观'), '设置面板顶部说明文字已移除');
  assert.ok(
    entry.includes('"Apple Music Style"'),
    '皮肤注册标题须为 Apple Music Style（换肤卡片与设置页头共用）',
  );
  assert.ok(!skin.includes('EchoPluginLyricsView'), '不再依赖宿主原生歌词视图');
  // 播放页背景直接复用宿主“封面歌词”模式的渲染器与材质语义
  assert.ok(skin.includes('import EchoMusic.Playback'), '背景必须导入宿主 Playback 模块');
  assert.ok(skin.includes('PlaybackBlurredBackground'), '背景必须复用宿主模糊封面渲染器');
  assert.ok(skin.includes('lyricBackground'), '底色必须走宿主 lyricBackground(封面主色)');
  assert.ok(!skin.includes('blurMax: 64'), '不再手搓封面模糊');
  assert.ok(skin.includes('Qt.rgba(1, 1, 1, 0.2)'), '未唱色必须用宿主默认 20% 白');
  // 背景律动跟随宿主 backgroundRhythm：read/observe 同步 + 30fps 相位推进
  assert.ok(skin.includes("settings.read('lyrics')"));
  assert.ok(skin.includes('settings.observe('));
  assert.ok(skin.includes('backgroundRhythm'));
  assert.ok(skin.includes('hostPhase'));

  // LyricFlow 瘦身为宿主适配器：核心创建/时间推送/歌词数据/跳转
  assert.ok(flow.includes('import "amll/base/player.mjs" as AmlPlayer'));
  assert.ok(flow.includes('new AmlPlayer.LyricPlayerCore'));
  assert.ok(flow.includes('core.setCurrentTime'), '媒体时间必须推送进编排核心');
  assert.ok(flow.includes('core.setLyricLines'), '歌词数据必须进编排核心');
  assert.ok(flow.includes('setAlignPosition(focusPosition)'));
  assert.ok(flow.includes('setWordFadeWidth(wordFade)'));
  assert.ok(flow.includes('setLinePosYSpringParams'), 'posY 弹簧参数 m0.9/d15/k90');
  assert.ok(flow.includes('seekToGroup'));
  assert.ok(!flow.includes('ListView'), '排版与滚动交由 base 核心（无 ListView）');
  assert.ok(!flow.includes('EchoWheelScroll'));
  assert.ok(!flow.includes('AmllLineMotion'), '旧组件已删除');
  assert.ok(!flow.includes('AmllInterlude'));

  // AmlLyricView：帧循环推进核心 + 滚动引擎输入
  assert.ok(view.includes('FrameAnimation'));
  assert.ok(view.includes('c.update(frameTime * 1000)'), '帧循环必须推进编排核心');
  assert.ok(view.includes('lyricView.commitFrame()'));
  assert.ok(view.includes('scrollEngine.wheel('));
  assert.ok(view.includes('scrollEngine.beginTouch('));
  assert.ok(view.includes('notifyGroupsChanged'));

  // AmlGroupView：弹簧落盘 + AMLL 过渡时长 + 测量上报
  assert.ok(group.includes('g.posY.getCurrentPosition()'), '组 y 由 posY 弹簧逐帧落盘');
  assert.ok(group.includes('setGroupMeasured'), '自然高度必须上报布局计算器');
  assert.ok(group.includes('duration: 400'), 'wrapper 透明度/模糊 0.4s（AMLL CSS）');
  assert.ok(group.includes('? 300 : 450'), '亮层点亮 0.3s / 熄灭 0.45s（AMLL 亮度层）');

  // AmlInterludeDots：快照消费 + 测量上报
  assert.ok(dots.includes('getSnapshot()'));
  assert.ok(dots.includes('setInterludeMeasured'));

  // AmlLineView 扫掠内核（宿主 GlyphRun 原生塑形 + 1px 切片）
  // 活动行必须经 layer 离屏合成：Qt 对非分层子树的 item opacity 逐 draw
  // 相乘，扫掠带「前片外伸 + 本片」叠画在 ρ<1 时底层亮墨以 (1−ρ) 泄漏
  // （带比平台亮 +20~28、亮端窗口 +17 斑，2026-11-12 dpr1.25 实测）；
  // 抵消用的 pose.opacity=1/ρ 被宿主 finiteRange(opacity,0,1) 拒收（整行
  // poses 丢弃 → 高亮消失）。layer 内满 α 合成、ρ 只在出口乘一次。
  assert.ok(line.includes('import EchoMusic.PluginSdk'), 'AmlLineView 必须使用宿主 GlyphRun');
  assert.ok(line.includes('GlyphRun {'));
  assert.ok(line.includes('clusterStart'));
  assert.ok(line.includes('maxWidth'));
  assert.ok(line.includes('__sweepPoses'), '扫掠必须按词元簇求值');
  assert.ok(line.includes('0.5 + (edge - x) / fade'), '簇透明度必须由前沿与软边求值');
  assert.ok(line.includes('dimColor'), '未唱样必须随高亮量提亮（宿主 0.2 → 0.4）');
  assert.ok(line.includes('brightColor'), '已唱样必须从未唱色渐入');
  assert.ok(
    line.includes('layer.enabled: current && hasWordTiming'),
    '活动行必须离屏合成（逐 draw 行链 ρ 使切片叠画泄漏）',
  );
  assert.ok(
    !line.includes('layer.sourceRect'),
    '禁用 sourceRect 外扩：外扩区域会被缩放映射回 item 矩形（行压扁、右移，2026-11-12 实测）',
  );
  // AMLL fade 语义：软边 = 单行行盒高 × fadeWidth（下限 0.0001），
  // 移除宿主的 em×1.2 与 [0.05, 1] 钳制
  assert.ok(
    line.includes('rowHeight * Math.max(0.0001, fadeWidth)'),
    '软边宽度必须按 AMLL word.height × wordFadeWidth',
  );
  assert.ok(
    !line.includes('em * 1.2 * Math.min(1, Math.max(0.05'),
    'AMLL fade 不得保留宿主 [0.05,1] 钳制',
  );

  // 包配置：新视图 + base 模块入包，旧组件出包，不带着色器
  for (const asset of [
    'qml/LyricFlow.qml',
    'qml/amll/AmlLyricView.qml',
    'qml/amll/AmlGroupView.qml',
    'qml/amll/AmlLineView.qml',
    'qml/amll/AmlInterludeDots.qml',
  ])
    assert.ok(config.assets.includes(asset), `plugin.config.json 缺少 ${asset}`);
  for (const removed of [
    'qml/AmllLine.qml',
    'qml/AmllLineMotion.qml',
    'qml/AmllSpring.qml',
    'qml/AmllInterlude.qml',
  ])
    assert.ok(!config.assets.includes(removed), `旧组件须移出包配置：${removed}`);
  assert.ok(!config.shaders?.length, '扫掠不依赖着色器');
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

  // 收藏按钮：收藏态只切换爱心填充字形，不点亮圆底或改变图标颜色
  assert.ok(
    skin.includes('root.player.snapshot.favorite ? "heart-filled" : "heart"'),
    '收藏态必须只切换爱心填充字形',
  );
  assert.ok(!skin.includes('actionButton.active'), '收藏态不得改变按钮背景或图标颜色');

  // 封面投影：对照旧插件 .amms-cover-img 双层 box-shadow（12/40 + 2/8），
  // 用宿主 EchoSurfaceShadow（SDF 环带，不画源矩形）；无封面占位不投影
  assert.ok(skin.includes('EchoSurfaceShadow'), '封面投影必须用宿主 EchoSurfaceShadow');
  assert.ok(
    skin.includes('blur: 40') && skin.includes('Qt.vector2d(0, 12)'),
    '主投影层 0 12px 40px',
  );
  assert.ok(skin.includes('blur: 8') && skin.includes('Qt.vector2d(0, 2)'), '贴合投影层 0 2px 8px');
  assert.ok(skin.includes('visible: coverItem.hasArtwork'), '无封面占位时不投影');

  // 宿主能力声明不变
  for (const feature of ['text.glyphs', 'graphics.glyphRun.canvas', 'settings.host'])
    assert.ok(manifest.requires.features.includes(feature), `manifest missing ${feature}`);
  assert.ok(
    manifest.capabilities.includes('hostSettings'),
    '读取宿主歌词设置需声明 hostSettings capability',
  );
});

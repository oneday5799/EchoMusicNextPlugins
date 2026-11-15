# Apple Music 风格播放页

完整播放页皮肤插件，从 EchoMusicPlugins/apple-music-style（Vue/DOM + AMLL 版）移植。注册为换肤抽屉中的候选皮肤，选中后把播放页替换为双栏布局：左侧封面、歌曲信息、进度与播放控制，右侧 AMLL 风格逐字歌词流；整页使用当前封面放大模糊后的背景。

- 只使用公开 SDK：`ctx.ui.lyricsPage.registerSkin` 注册皮肤，皮肤与设置组件接收注入的 `plugin`/`page`/`configuration`。
- 右栏歌词是插件自绘的 AMLL 风格渲染（`qml/LyricFlow.qml` 为宿主数据适配层；`qml/amll/base/*.mjs` 逐模块移植 AMLL core 逻辑——编排/时间线/焦点/布局/滚动/弹簧/间奏点/Seek 检测，QML V4 兼容、Node 直接单测；`qml/amll/Aml{LyricView,GroupView,LineView,InterludeDots}.qml` 为渲染视图），不打包 AMLL 或任何 DOM 依赖；呈现语义对照 AMLL 与宿主内建歌词页移植：唱完行保持高亮（AMLL「唱完不熄灭」生命周期）、逐词扫掠、词上浮、非活动行缩小与随距离模糊、间奏三点呼吸、按行间时间差的弹簧滚动；鼠标悬停歌词区时暂时禁用远行模糊（AMLL `.amll-lyric-player:hover` → 所有行 `filter: unset`，离开后按 0.4s 过渡恢复）；当前播放行任何时候都不模糊——有意偏离 AMLL：间奏/曲末清空高亮后其同名公式会给最后演唱行留 1 档模糊。数据来自 `page.player.lyrics` 只读模型与 `samplePosition()` 时钟。文本经宿主新公开的 `GlyphRun`（`EchoMusic.PluginSdk`，需要 `text.glyphs`、`graphics.glyphRun.canvas` feature）整行原生塑形，连字、字距、回退字体与换行和内建歌词页一致；扫掠颜色对照宿主 `LyricLine` 模型——亮色 = 未唱色 lerp 播放色（随高亮量渐变：亮入 300ms / 暗出 450ms，对照 AMLL CSS `.gradientMask` 态 0.3s 与基础态 0.45s）、当前行未唱色 alpha ×（1+高亮量）（20% → 40% 白提亮）。已唱前沿渐变带用 1px 切片内核呈现：按词元簇矩形切出逐像素不透明外观切片（rgb = 暗端↔亮端两个背景合成值的插值、a=1，背景项由 Skin 的逐位置背景估计器按片取样），活动行整行走 Qt layer 合成保证切片叠画精确（纹理按设备像素建立、采样随运动态切换；纯 GlyphRun 子树 layer 抓取内容完整——旧内核 ShaderEffect 遮罩方案连同「layer 抓取会丢内容」的旧结论一并废弃），无 GPU 遮罩与着色器资源，旧插件因此需要的 AGPL 依赖不再存在，本插件按仓库默认 MIT 许可分发。
- 播放控制通过 `page.command` 调用宿主真实命令：`toggle`/`previous`/`next`/`mode`/`quality`/`seek`/`favorite`/`comments`/`share`；随机与列表循环对应播放模式 2/0。进度条支持点击与拖动，携带 `revision` 防止作用到已切换的新歌。
- 专辑标题、歌手名可跳转对应详情页：皮肤 QML 调用插件命令 `open-detail`，入口再经 `ctx.ui.navigation.navigate` 进入宿主真实路由；`navigation` capability 首次使用时由宿主请求授权。
- 播放页背景直接复用宿主"封面歌词"模式的模糊封面背景：实例化宿主 `EchoMusic.Playback` 的 `PlaybackBlurredBackground`（与内建封面歌词页同一 fluid 着色器与封面交叉淡化管线），底色、磨砂与透明度材质语义对照宿主 `PlaybackBackground`（`lyricBackground(封面主色)` 500ms 渐变、`1 - transparency/100`、磨砂时黑 55% 底）。背景律动跟随宿主歌词设置 `backgroundRhythm`：经 `settings.host` capability 授权后 `settings.read/observe('lyrics')` 同步，30fps 相位推进与宿主一致；拒绝授权或关闭该设置时背景保持静止。歌词区上下缘用逐组透明度淡出（组进入边缘渐隐带时透明度线性降至 0，触及视口边界前已完全隐藏；作用于 item 透明度而非 glyph pose，行链不透明度不受影响；整层遮罩方案经实测不可行已废弃），消除行移入移出视口的硬切分界线；动画全部遵循宿主"减少动效"开关。

皮肤设置还原旧插件的排版七项（与皮肤页面共享同一配置句柄，保存在安装私有数据）：字体缩放（50–200%）、字体粗细（300–900）、非活动行模糊、非活动行缩小、弹簧滚动、逐词渐变宽度（0–100%）、对齐位置（0–100%）。旧插件的「增强对比度」不移植——多种实现方案均无法在宿主 pose 渲染下复现 DOM text-shadow 观感，且 AMLL 基线的明暗比本身已足够。设置组件与皮肤共用 `validate` 校验；「恢复默认」与保存错误提示由宿主换肤抽屉统一渲染（`LyricSkinDrawer` 底部按钮，调用同一 `configuration.reset()`），设置面板不重复提供，避免抽屉里出现两个重置按钮。

与旧插件（EchoMusicPlugins/apple-music-style 1.2.3）的有意差异：

- 音质徽标点击弹出音质列表并切换（复用宿主 `EchoAnchoredPopup` 弹层与 `PlaybackOptionsPopup` 的 quality 行样式，候选键/标签/色值对照 `PlaybackService::qualities` 常量，选择经 `page.command('quality')` 白名单命令切换，无需 capability）；与旧插件的剩余差异源于宿主未向插件公开逐曲可用性——旧插件由宿主 `qualityOptions` 提供 `disabled` 态、`hasCloudSource` 门控与文件大小，本插件弹层无禁用态与大小详情，CLD 云盘项恒显示（无云盘文件时宿主 `setQuality` 静默忽略）；viper 三档随宿主「蝰蛇音质」开关过滤（`settings.read('playback')` 读取 `viperQualityEnabled`，与背景律动共用 `settings.host` 授权）。
- 皮肤注册后不自动选中，由用户在换肤抽屉中选择；宿主皮肤模型的候选/选择协议不允许插件静默替用户做决定。
- 旧版悬浮在宿主工具区的评论/分享按钮改为左栏操作按钮行；分享与评论直接走宿主命令。
- Ruby（音译注音到字上方）暂以副行形式显示；宿主未向插件公开逐字注音排版能力。

命令（管理页/`executeCommand` 可用）：`open-detail` 参数 `{ name, resourceId }`，导航到宿主详情页，供皮肤内部使用。

构建：仓库根执行 `npm run build`；生成 `dist/apple-music-style-1.0.0.echomod`。通过插件管理面板安装，或使用 `--plugin-dir` 加载构建目录。SDK 保持 1.0.0，插件版本 1.0.0。

# Apple Music 风格播放页

完整播放页皮肤插件，从 EchoMusicPlugins/apple-music-style（Vue/DOM + AMLL 版）移植。注册为换肤抽屉中的候选皮肤，选中后把播放页替换为双栏布局：左侧封面、歌曲信息、进度与播放控制，右侧 AMLL 风格逐字歌词流；整页使用当前封面放大模糊后的背景。

- 只使用公开 SDK：`ctx.ui.lyricsPage.registerSkin` 注册皮肤，皮肤与设置组件接收注入的 `plugin`/`page`/`configuration`。
- 右栏歌词是插件自绘的 AMLL 风格渲染（`qml/LyricFlow.qml` + `qml/AmllLine.qml`），不打包 AMLL 或任何 DOM 依赖；呈现语义对照宿主内建歌词页移植：连续亮度前沿逐词推进、词上浮、非活动行缩小与随距离模糊、间奏三点呼吸、按行间时间差的弹簧滚动。数据来自 `page.player.lyrics` 只读模型与 `samplePosition()` 时钟。文本经宿主新公开的 `GlyphRun`（`EchoMusic.PluginSdk`，需要 `text.glyphs`、`graphics.glyphRun.canvas` feature）整行原生塑形，连字、字距、回退字体与换行和内建歌词页一致；扫掠颜色对照宿主 `LyricLine` 模型——亮色 = 未唱色 lerp 播放色（随高亮量 300ms 渐入）、当前行未唱色 alpha ×（1+高亮量）（20% → 40% 白提亮），单层 GlyphRun 按词元簇给出颜色/透明度插值呈现软边前沿（前沿连续坐标来自原生词元簇矩形、簇中点取样即宿主逐像素线性渐变的精确均值，上浮用词首簇 pose；不做亮/暗双层叠放，避免词上浮时双层错位重影）。未唱部分用 Qt Quick `ShaderEffect` 的旧 GPU 遮罩已废弃（GlyphRun 自定义节点经 layer 抓取会丢内容），旧插件因此需要的 AGPL 依赖不再存在，本插件按仓库默认 MIT 许可分发。
- 播放控制通过 `page.command` 调用宿主真实命令：`toggle`/`previous`/`next`/`mode`/`seek`/`favorite`/`comments`/`share`；随机与列表循环对应播放模式 2/0。进度条支持点击与拖动，携带 `revision` 防止作用到已切换的新歌。
- 专辑标题、歌手名可跳转对应详情页：皮肤 QML 调用插件命令 `open-detail`，入口再经 `ctx.ui.navigation.navigate` 进入宿主真实路由；`navigation` capability 首次使用时由宿主请求授权。
- 播放页背景直接复用宿主"封面歌词"模式的模糊封面背景：实例化宿主 `EchoMusic.Playback` 的 `PlaybackBlurredBackground`（与内建封面歌词页同一 fluid 着色器与封面交叉淡化管线），底色、磨砂与透明度材质语义对照宿主 `PlaybackBackground`（`lyricBackground(封面主色)` 500ms 渐变、`1 - transparency/100`、磨砂时黑 55% 底）。背景律动跟随宿主歌词设置 `backgroundRhythm`：经 `settings.host` capability 授权后 `settings.read/observe('lyrics')` 同步，30fps 相位推进与宿主一致；拒绝授权或关闭该设置时背景保持静止。歌词区上下渐隐用遮罩实现；动画全部遵循宿主"减少动效"开关。

皮肤设置还原旧插件全部八项（与皮肤页面共享同一配置句柄，保存在安装私有数据）：增强对比度、字体缩放（50–200%）、字体粗细（300–900）、非活动行模糊、非活动行缩小、弹簧滚动、逐词渐变宽度（0–100%）、对齐位置（0–100%）。设置组件与皮肤共用 `validate` 校验，"恢复默认"调用 `configuration.reset()`。

与旧插件（EchoMusicPlugins/apple-music-style 1.2.3）的有意差异：

- 音质徽标只展示当前音质（含云盘 CLD）；宿主未向插件公开可切换音质列表，插件不伪造切换入口。
- 皮肤注册后不自动选中，由用户在换肤抽屉中选择；宿主皮肤模型的候选/选择协议不允许插件静默替用户做决定。
- 旧版悬浮在宿主工具区的评论/分享按钮改为左栏操作按钮行；分享与评论直接走宿主命令。
- Ruby（音译注音到字上方）暂以副行形式显示；宿主未向插件公开逐字注音排版能力。

命令（管理页/`executeCommand` 可用）：`open-detail` 参数 `{ name, resourceId }`，导航到宿主详情页，供皮肤内部使用。

构建：仓库根执行 `npm run build`（着色器编译需要 `ECHO_QSB` 指向与宿主同版本的 `qsb`）；生成 `dist/apple-music-style-1.0.0.echomod`。通过插件管理面板安装，或使用 `--plugin-dir` 加载构建目录。SDK 保持 1.0.0，插件版本 1.0.0。

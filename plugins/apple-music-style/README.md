# Apple Music 风格播放页

完整播放页皮肤插件，从 EchoMusicPlugins/apple-music-style（Vue/DOM 版）移植。注册为换肤抽屉中的候选皮肤，选中后把播放页替换为双栏布局：左侧封面、歌曲信息、进度与播放控制，右侧宿主原生逐字歌词；整页使用当前封面放大模糊后的背景。

- 只使用公开 SDK：`ctx.ui.lyricsPage.registerSkin` 注册皮肤，皮肤与设置组件接收注入的 `plugin`/`page`/`configuration`。
- 歌词使用宿主共享的 `EchoPluginLyricsView`（原生逐字绘制、翻译/音译、点击跳行），不打包 AMLL 或任何 DOM 渲染；旧插件因此需要的 AGPL 依赖不再存在，本插件按仓库默认 MIT 许可分发。
- 播放控制通过 `page.command` 调用宿主真实命令：`toggle`/`previous`/`next`/`mode`/`seek`/`favorite`/`comments`/`share`；随机与列表循环对应播放模式 2/0。进度条支持点击与拖动，携带 `revision` 防止作用到已切换的新歌。
- 专辑标题、歌手名可跳转对应详情页：皮肤 QML 调用插件命令 `open-detail`，入口再经 `ctx.ui.navigation.navigate` 进入宿主真实路由；`navigation` capability 首次使用时由宿主请求授权。
- 封面模糊背景用 Qt Quick `MultiEffect` GPU 模糊/饱和/亮度实现，歌词区上下渐隐用遮罩实现；动画全部遵循宿主"减少动效"开关。

皮肤设置（与皮肤页面共享同一配置句柄，保存在安装私有数据）：增强对比度、字体缩放（50–200%）、字体粗细（300–900）、对齐位置（0–100%）。设置组件与皮肤共用 `validate` 校验，"恢复默认"调用 `configuration.reset()`。

与旧插件（EchoMusicPlugins/apple-music-style 1.2.3）的有意差异：

- AMLL 专属的弹簧动画、逐字模糊、聚焦缩放、逐字渐变宽度设置不再提供；宿主原生歌词渲染有自己随"减少动效"开关的逐字动画，不伪装等效开关。
- 音质徽标只展示当前音质（含云盘 CLD）；宿主未向插件公开可切换音质列表，插件不伪造切换入口。
- 皮肤注册后不自动选中，由用户在换肤抽屉中选择；宿主皮肤模型的候选/选择协议不允许插件静默替用户做决定。
- 旧版悬浮在宿主工具区的评论/分享按钮改为左栏操作按钮行；分享与评论直接走宿主命令。

命令（管理页/`executeCommand` 可用）：`open-detail` 参数 `{ name, resourceId }`，导航到宿主详情页，供皮肤内部使用。

构建：仓库根执行 `npm run build`；生成 `dist/apple-music-style-1.0.0.echomod`。通过插件管理面板安装，或使用 `--plugin-dir` 加载构建目录。SDK 保持 1.0.0，插件版本 1.0.0。

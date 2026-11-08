pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Effects
import QtQuick.Layouts
import EchoMusic.Controls
import EchoMusic.Playback
import EchoMusic.Theme
import EchoMusic.PluginSdk

// Apple Music 风格完整播放页皮肤。
// 左栏：封面、歌曲信息、进度与播放控制；右栏：宿主原生逐字歌词。
Item {
    id: root

    required property EchoPluginContext plugin
    required property EchoPluginViewContext page
    required property AppearanceConfiguration configuration

    readonly property var player: page.player
    readonly property bool motion: Theme.store.motionEnabled
    readonly property string coverUrl: player.coverUrl.toString()
    readonly property bool wide: width > 800
    // PlaybackService::PlayMode：ListLoop=0、SingleLoop=1、Shuffle=2、Sequential=3
    readonly property int playMode: player.snapshot.playMode
    readonly property bool cloudSource: player.snapshot.sourceKind === "cloud"
    readonly property string quality: player.snapshot.effectiveQuality || player.snapshot.quality

    // 与宿主 PlaybackService::qualities 徽标一致；宿主未向插件公开可切换列表，
    // 因此徽标只做展示，不提供切换入口
    readonly property var qualityTags: ({
            "standard": "SD",
            "higher": "HQ",
            "flac": "SQ",
            "hi_res": "HR",
            "viper_tape": "VPT",
            "viper_clear": "VPC",
            "viper_atmos": "VPA"
        })
    readonly property string qualityTag: root.cloudSource ? "CLD" : (root.qualityTags[root.quality] ?? "")

    function num(value: var, fallback: real, min: real, max: real): real {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
    }
    function formatTime(ms: real): string {
        const total = Math.max(0, Math.floor(ms / 1000));
        const minutes = Math.floor(total / 60);
        const seconds = total % 60;
        return minutes + ":" + (seconds < 10 ? "0" : "") + seconds;
    }
    // 收起播放页走 playback.page 部件的 close action：宿主 onActionRequested →
    // PlaybackPage.close()，与收起按钮同路径共享 Popup 退出过渡（Qt 退出过渡期
    // 间 visible 保持 true，弹层在过渡结束后才释放）。淡出与封面飞行来自下方
    // hostOpacity 绑定与 findPageMotion 的 targetCover 接管；命令通道
    // closePlayback 同样落到 playbackPageLoader.close()，仅作部件兜底。
    function closePlayback(): void {
        const part = root.plugin.ui.parts.queryUnique({
            "role": "playback.page",
            "key": "player",
            "surface": "playback"
        });
        if (part && part.valid && part.actions.includes("close")) {
            const op = part.invoke("close");
            if (op && !(op.finished && op.state === EchoPluginOperation.Failed))
                return;
        }
        root.page.command("closePlayback");
    }
    function openDetail(name: string, resourceId: string): void {
        if (!name || !resourceId)
            return;
        // 详情页在播放页之下：open-detail（entry 注册，经 ctx.ui.navigation 落地
        // 宿主路由）成功后再关播放页——对齐旧 web 版先 push 后关歌词层的顺序，
        // 避免遮罩后旧页面闪现；导航失败则保留播放页现状。
        const op = root.plugin.executeCommand("open-detail", {
            "name": name,
            "resourceId": String(resourceId)
        });
        if (!op)
            return;
        if (op.finished) {
            if (op.state === EchoPluginOperation.Succeeded)
                closePlayback();
            return;
        }
        op.completed.connect(() => {
            if (op.state === EchoPluginOperation.Succeeded)
                closePlayback();
        });
    }

    // 皮肤设置与换肤抽屉的设置组件共享同一 configuration 句柄
    readonly property var s: ({
            "enhanceContrast": root.configuration.values.enhanceContrast === true,
            "fontScale": root.num(root.configuration.values.fontScale, 100, 50, 200),
            "fontWeight": root.num(root.configuration.values.fontWeight, 850, 300, 900),
            "enableBlur": root.configuration.values.enableBlur !== false,
            "enableScale": root.configuration.values.enableScale !== false,
            "enableSpring": root.configuration.values.enableSpring !== false,
            "fadeWidth": root.num(root.configuration.values.fadeWidth, 50, 0, 100),
            "alignPosition": root.num(root.configuration.values.alignPosition, 48, 0, 100)
        })

    // Apple Music 观感固定为深色封面背景上的白色文字，不随主题翻转
    readonly property ThemeColors am: ThemeColors {
        text: "#ffffff"
        tone: "#ffffff"
        secondaryText: "#ccffffff"
        elevated: "#26ffffff"
        card: "#1fffffff"
        border: "#33ffffff"
        accent: root.plugin.accent
        accentText: "#ffffff"
    }

    // 旧版 AMLL 字号：clamp(24px, 4.2vh × 缩放, 52px)，vh 取整个页面高度
    readonly property real lyricFontSize: Math.min(52, Math.max(24, root.height * 0.042 * root.s.fontScale / 100))
    // 旧版 AMLL 字号：clamp(24px, 4.2vh × 缩放, 52px)，vh 取整个页面高度。
    // 字体必须经宿主 styledFont 构建：宿主引擎里对 QFont 属性读取的副本
    // 直接赋 pixelSize/weight 不生效，会静默回落到 13px/400 的宿主默认字号
    readonly property font lyricFont: Theme.store.styledFont(Theme.store.lyricBaseFont, Math.round(root.lyricFontSize), Math.round(root.s.fontWeight), 0, false, false)
    // 副歌词字号为最大(10, 字号×0.5)，粗细上限 650，与旧版一致
    readonly property font secondaryLyricFont: Theme.store.styledFont(Theme.store.lyricBaseFont, Math.max(10, root.lyricFontSize * 0.5), Math.min(650, Math.round(root.s.fontWeight)), 0, false, false)

    implicitWidth: 960
    implicitHeight: 640

    // ===== 背景：直接复用宿主"封面歌词"模式的模糊封面背景 =====
    // 渲染器即宿主 EchoMusic.Playback 的 PlaybackBlurredBackground（与内建
    // 封面歌词页同一 fluid 着色器、同一封面交叉淡化管线）；包裹逻辑对照
    // 宿主 PlaybackBackground：底色 lyricBackground(封面主色) 500ms 渐变、
    // 磨砂/透明度材质、模糊未就绪或无封面时只显示底色四边形。
    readonly property bool hostFrosted: Theme.store.windowFrosted
    readonly property real hostMaterialOpacity: 1 - Theme.store.transparency / 100
    readonly property color hostCoverColor: root.player.snapshot.coverColor ?? "#20242c"
    readonly property color hostBaseColor: Theme.store.lyricBackground(root.hostCoverColor)
    property color hostDisplayedBaseColor: root.hostBaseColor
    Behavior on hostDisplayedBaseColor {
        ColorAnimation {
            duration: Theme.store.motionEnabled ? 500 : 0
        }
    }
    readonly property bool hostBlurActive: root.visible && root.coverUrl.toString().length > 0 && !root.hostFrosted && root.hostMaterialOpacity > 0
    // ===== 背景均色估计（渐变带切片色的背景项注入，见 AmllLine.__sweepPoses）=====
    // 不透明外观切片要与半透明未唱字无缝衔接，切片色须含背景贡献。复刻宿主
    // 合成链的均值：封面 → background-preprocess（对比 .4 → 饱和 ×3 →
    // 对比 1.7 → 亮度 .75，8bit 钳制）→ 8 次盒模糊（均值保持）→ lyric-fluid
    // （×0.5 压暗，backgroundOpacity 权重叠在底色渐变 #20242c→#12151b 上）。
    // 封面均值经 Canvas 8×8 采样；模糊不可用时与宿主一致只显示底色四边形
    // （磨砂时 55% 黑）。采样前退化为底色估计，不劣于旧黑底烘焙。
    property bool coverSampled: false
    property color coverAvgColor: "#000000"
    readonly property color lyricGradMid: Qt.rgba(25 / 255, 28.5 / 255, 35.5 / 255, 1)
    readonly property color backdropColor: {
        const g = root.lyricGradMid, bo = root.hostMaterialOpacity;
        if (root.hostBlurActive && root.coverSampled)
            return Qt.rgba(root.coverAvgColor.r * 0.5 * bo + g.r * (1 - bo),
                           root.coverAvgColor.g * 0.5 * bo + g.g * (1 - bo),
                           root.coverAvgColor.b * 0.5 * bo + g.b * (1 - bo), 1);
        if (root.hostFrosted)
            return Qt.rgba(g.r * 0.45, g.g * 0.45, g.b * 0.45, 1);
        return Qt.rgba(root.hostDisplayedBaseColor.r * bo + g.r * (1 - bo),
                       root.hostDisplayedBaseColor.g * bo + g.g * (1 - bo),
                       root.hostDisplayedBaseColor.b * bo + g.b * (1 - bo), 1);
    }
    // ===== 背景逐像素估计器（v10，直接抓宿主渲染结果）=====
    // 可见背景 = 皮肤 bgLoader 里的宿主 PlaybackBlurredBackground 输出四边形
    // （模糊封面网格 + 晕影 + ×0.5 压暗 + ×BO），以 alpha=BO 叠在皮肤渐变底
    // #20242c→#12151b 上，故可见背景 = 四边形输出 + grad·(1−BO)。
    // v9 曾在 JS 逐级复刻渲染链（grade→盒模糊→Coons 网格逆映射→晕影），其中
    // 网格逆映射无法离线验证，采样落点偏移会把封面饱和色直接烘进切片墨色
    // （所见"暗端取封面色"）。v10 不再复刻：grabToImage 直接抓宿主组件的
    // 渲染结果并由 GPU 降到 48×24，Canvas 只做像素读回——模糊/网格/晕影/
    // 压暗/换曲交叉淡化全部真实，复刻只剩一句渐变透出。LUT 只在抓取回调
    // （异步、绑定外）写入，__sampleBg 纯读，poses 绑定求值期不再有属性
    // 写入，绑定环随之消失。
    property var __blurTex: null
    property var __bgLut: null
    property bool __bgGrabDirty: true
    property bool __bgFadeActive: false
    property var __bgGrabResult: null
    // 律动推进时相位持续变化，按 400ms 步进跟进重抓
    readonly property bool __bgRhythmMoving: root.hostRhythmActive && root.player.playing
    onWidthChanged: root.__scheduleBgGrab()
    onHeightChanged: root.__scheduleBgGrab()
    onHostMaterialOpacityChanged: root.__scheduleBgGrab()

    // background-preprocess 全链：grade（一次 8bit 钳制）+ 8 道盒模糊
    function __buildBlurChain(d) {
        const piv = 128 / 255;
        let tex = new Float32Array(32 * 32 * 3);
        for (let i = 0, o = 0; i < d.length; i += 4, o += 3) {
            let r = (d[i] / 255 - piv) * 0.4 + piv, g = (d[i + 1] / 255 - piv) * 0.4 + piv, b = (d[i + 2] / 255 - piv) * 0.4 + piv;
            const gray = 0.3 * r + 0.59 * g + 0.11 * b;
            r = ((3 * r - 2 * gray - piv) * 1.7 + piv) * 0.75;
            g = ((3 * g - 2 * gray - piv) * 1.7 + piv) * 0.75;
            b = ((3 * b - 2 * gray - piv) * 1.7 + piv) * 0.75;
            tex[o] = Math.round(Math.min(1, Math.max(0, r)) * 255) / 255;
            tex[o + 1] = Math.round(Math.min(1, Math.max(0, g)) * 255) / 255;
            tex[o + 2] = Math.round(Math.min(1, Math.max(0, b)) * 255) / 255;
        }
        // 偶道水平/奇道垂直；偶道后 RGBA16F（无量化）、奇道后 RGBA8（量化）
        for (let p = 0; p < 8; ++p) {
            const horiz = p % 2 === 0, quant = !horiz;
            const dst = new Float32Array(32 * 32 * 3);
            for (let y = 0; y < 32; ++y)
                for (let x = 0; x < 32; ++x) {
                    let r = 0, g = 0, b = 0;
                    for (let i = -2; i <= 2; ++i) {
                        const sx = horiz ? Math.min(31, Math.max(0, x + i)) : x;
                        const sy = horiz ? y : Math.min(31, Math.max(0, y + i));
                        const oo = (sy * 32 + sx) * 3;
                        r += tex[oo];
                        g += tex[oo + 1];
                        b += tex[oo + 2];
                    }
                    const o = (y * 32 + x) * 3;
                    if (quant) {
                        dst[o] = Math.round(r / 5 * 255) / 255;
                        dst[o + 1] = Math.round(g / 5 * 255) / 255;
                        dst[o + 2] = Math.round(b / 5 * 255) / 255;
                    } else {
                        dst[o] = r / 5;
                        dst[o + 1] = g / 5;
                        dst[o + 2] = b / 5;
                    }
                }
            tex = dst;
        }
        root.__blurTex = tex;
    }
    // 抓取调度：脏标记 + 30ms 合并窗（封面/尺寸/透明度变化、换曲补抓）
    function __scheduleBgGrab() {
        root.__bgGrabDirty = true;
        bgGrabKick.restart();
    }
    // 抓取宿主 bgLoader 的渲染结果（真实模糊封面合成）。ready 才抓（纹理链
    // 就绪）；grabToImage 第二参数由 GPU 直接降到 48×24，结果由 Image 元素
    // 中转读回像素（见 bgGrabImg/bgLutCanvas）。
    // 两个踩坑记录：grab 结果 url 是 "itemgrabber:#N" 内存 scheme，
    // Canvas.loadImage 不认（静默挂起），必须走 Image 元素（QQuickPixmap
    // 支持该 scheme）；activeArtwork.texture 是不可见 live:false RGBA16F
    // ShaderEffectSource，抓出全零，故抓可见的合成四边形本身——fluid 的
    // ×0.5×BO 压暗与换曲交叉淡化已烘入，__fillBgLut 仅补渐变透出。
    function __captureBg() {
        const item = bgLoader.item;
        if (!item || item.ready !== true || root.width <= 0 || root.height <= 0)
            return;
        item.grabToImage(function (result) {
            if (!result)
                return;
            root.__bgGrabResult = result;
        }, Qt.size(48, 24));
    }
    // 像素 → LUT：合成四边形抓取已含模糊/网格/晕影/压暗/淡化与抖动，
    // 补渐变透出项 grad·(1−BO)（bg 四边形 alpha=BO，皮肤渐变底自下透出）。
    function __fillBgLut(d) {
        const LW = 48, LH = 24;
        const lut = new Float32Array(LW * LH * 3);
        const gw = 1 - root.hostMaterialOpacity;
        for (let iy = 0; iy < LH; ++iy) {
            const t = (iy + 0.5) / LH;
            const gr = (32 + (18 - 32) * t) / 255, gg = (36 + (21 - 36) * t) / 255, gb = (44 + (27 - 44) * t) / 255;
            for (let ix = 0; ix < LW; ++ix) {
                const o = (iy * LW + ix) * 3, p = (iy * LW + ix) * 4;
                lut[o] = d[p] / 255 + gr * gw;
                lut[o + 1] = d[p + 1] / 255 + gg * gw;
                lut[o + 2] = d[p + 2] / 255 + gb * gw;
            }
        }
        root.__bgLut = lut;
        root.__bgGrabDirty = false;
    }
    function __sampleBg(fx, fy) {
        // 纯读：LUT 由抓取回调异步填写，绑定求值期不触发任何属性写入
        const lut = root.__bgLut;
        if (!lut)
            return null;
        const LW = 48, LH = 24;
        const gx = Math.min(LW - 1.001, Math.max(0, fx * (LW - 1)));
        const gy = Math.min(LH - 1.001, Math.max(0, fy * (LH - 1)));
        const x0 = Math.floor(gx), y0 = Math.floor(gy);
        const ax = gx - x0, ay = gy - y0, x1 = x0 + 1, y1 = y0 + 1;
        const o00 = (y0 * LW + x0) * 3, o10 = (y0 * LW + x1) * 3, o01 = (y1 * LW + x0) * 3, o11 = (y1 * LW + x1) * 3;
        return [(lut[o00] * (1 - ax) + lut[o10] * ax) * (1 - ay) + (lut[o01] * (1 - ax) + lut[o11] * ax) * ay,
                (lut[o00 + 1] * (1 - ax) + lut[o10 + 1] * ax) * (1 - ay) + (lut[o01 + 1] * (1 - ax) + lut[o11 + 1] * ax) * ay,
                (lut[o00 + 2] * (1 - ax) + lut[o10 + 2] * ax) * (1 - ay) + (lut[o01 + 2] * (1 - ax) + lut[o11 + 2] * ax) * ay];
    }
    // LyricFlow→AmllLine 的每片背景项入口：条目坐标 → 皮肤分数 → LUT 采样
    function backdropSample(item, x, y) {
        const p = item.mapToItem(root, x, y);
        return root.__sampleBg(p.x / Math.max(1, root.width), p.y / Math.max(1, root.height));
    }
    // 背景律动取宿主歌词设置 backgroundRhythm（settings.host 授权后经 read/observe 同步）
    property bool hostRhythm: false
    readonly property bool hostRhythmActive: root.hostBlurActive && root.hostRhythm && root.motion
    property real hostPhase: 0
    // 宿主播放页开合动效源：PlaybackPageMotion.hostOpacity 与宿主 chrome 同曲线。
    // 皮肤全幅不透明，不跟随则退出过渡期间画面静止到弹层销毁，观感为无动画。
    // 经 objectName 在场景树定位宿主 motion（backdropScene → playbackPageMotion）；
    // 定位失败时保持不透明，仅丢失同步淡入淡出。定位成功后一并接管封面飞行
    // （见 findPageMotion）：皮肤封面交给 motion.targetCover，宿主 enter/exit
    // 过渡驱动飞行与淡出，时长随之切到飞行档（进 200ms / 出 220ms）。
    property PlaybackPageMotion pageMotion: null
    opacity: pageMotion ? pageMotion.hostOpacity : 1
    function findByName(item, name) {
        for (const child of item.children) {
            if (child.objectName === name)
                return child;
            const found = root.findByName(child, name);
            if (found)
                return found;
        }
        return null;
    }
    function findPageMotion(): void {
        let p = root.parent;
        while (p && p.objectName !== "playbackBackdropScene")
            p = p.parent;
        if (!p)
            return;
        // motion 声明在 nativePlaybackContents 之下（皮肤加载时该项不可见但存活），
        // 不能只扫 backdropScene 的直接子项
        root.pageMotion = root.findByName(p, "playbackPageMotion");
        if (!root.pageMotion)
            return;
        // 封面飞行复用宿主动效：enter/exit 过渡的 ScriptAction 调 motion.prepare()
        // 并用 openingMotion/closingMotion 驱动 progress（460/360ms 贝塞尔），插件
        // 不自绘任何东西。皮肤封面本就是 EchoCover（与播放条 coverItem 同类型，
        // transitionArtwork/圆角占位均适用），直接作为 targetCover。motion 藏在
        // 皮肤加载时不可见的 nativePlaybackContents 里，重挂到 backdropScene 才能
        // 画在皮肤之上（anchors.fill 与原几何一致）；赋值断开宿主对 coverBody 的
        // 绑定，弹层释放销毁后随下次加载重建。若入场飞行已在旧目标上起跑（皮肤
        // 晚于 ScriptAction 加载的竞速），以当前矩形为起点调 prepare 改道皮肤封面。
        const m = root.pageMotion;
        if (m.parent !== p)
            m.parent = p;
        m.targetCover = coverItem;
        if (m.coverFlight && m.progress < 1)
            m.prepare(true);
    }
    Component.onCompleted: {
        root.findPageMotion();
        const read = root.plugin.settings.read('lyrics');
        const applyRead = () => {
            if (read.state === 2)
                root.hostRhythm = read.result.backgroundRhythm === true;
        };
        read.completed.connect(applyRead);
        applyRead();
        root.plugin.settings.observe('apple-music-style-background-rhythm', 'lyrics', values => {
            root.hostRhythm = values.backgroundRhythm === true;
        });
        if (root.coverUrl.length > 0)
            coverSampler.loadImage(root.coverUrl);
    }

    // 无封面时的基础底色，与宿主封面占位观感一致
    Rectangle {
        anchors.fill: parent
        gradient: Gradient {
            GradientStop {
                position: 0
                color: "#20242c"
            }
            GradientStop {
                position: 1
                color: "#12151b"
            }
        }
    }
    // 与宿主一致：只显示一个最终背景四边形，避免叠加 alpha 累积
    Rectangle {
        anchors.fill: parent
        visible: !(bgLoader.item && bgLoader.item.ready)
        color: root.hostFrosted ? Qt.rgba(0, 0, 0, 0.55) : Theme.withAlpha(root.hostDisplayedBaseColor, root.hostMaterialOpacity)
    }
    Loader {
        id: bgLoader
        anchors.fill: parent
        active: root.hostBlurActive
        sourceComponent: PlaybackBlurredBackground {
            anchors.fill: parent
            coverSource: root.player.coverUrl
            rhythm: root.hostRhythmActive
            phase: root.hostPhase
            baseColor: root.hostDisplayedBaseColor
            backgroundOpacity: root.hostMaterialOpacity
        }
    }
    // 封面采样：32×32 降采样 ≡ 宿主 Image sourceSize(32,32)，onPaint 里构建
    // grade+盒模糊纹理（回退均色 backdropColor 的输入；LUT 走 bgLoader 实抓）
    Canvas {
        id: coverSampler
        visible: false
        width: 32
        height: 32
        property string sampleUrl: root.coverUrl
        onSampleUrlChanged: {
            root.coverSampled = false;
            root.__blurTex = null;
            root.__bgLut = null;
            // 换曲交叉淡化（500ms）期间补抓，避免 LUT 停在旧封面/中途淡化态
            root.__bgFadeActive = true;
            bgFadeStop.restart();
            if (sampleUrl.length > 0)
                loadImage(sampleUrl);
        }
        onImageLoaded: requestPaint()
        onPaint: {
            const ctx = coverSampler.getContext('2d');
            ctx.clearRect(0, 0, 32, 32);
            if (coverSampler.sampleUrl.length === 0)
                return;
            ctx.drawImage(coverSampler.sampleUrl, 0, 0, 32, 32);
            const d = ctx.getImageData(0, 0, 32, 32).data;
            root.__buildBlurChain(d);
            root.__scheduleBgGrab();
            // 回退用全局均色：模糊纹理均值（已含 grade+模糊，语义同宿主合成）
            let r = 0, g = 0, b = 0;
            const tex = root.__blurTex;
            for (let i = 0; i < tex.length; i += 3) {
                r += tex[i];
                g += tex[i + 1];
                b += tex[i + 2];
            }
            const n = tex.length / 3;
            root.coverAvgColor = Qt.rgba(r / n, g / n, b / n, 1);
            root.coverSampled = true;
        }
    }
    // 背景抓取降采样画布：bgLoader 渲染结果 → 48×24 像素（LUT 数据源）
    // 背景抓取读回：grab 结果（itemgrabber: 内存 scheme）由 Image 元素加载
    // （Canvas.loadImage 不认该 scheme），就绪后触发降采样画布取像素填 LUT
    Image {
        id: bgGrabImg
        visible: false
        cache: false
        source: root.__bgGrabResult ? root.__bgGrabResult.url : ""
        onStatusChanged: {
            if (bgGrabImg.status === Image.Ready)
                bgLutCanvas.requestPaint();
            else if (bgGrabImg.status === Image.Error)
                console.warn('[bg-grab] Image 读回失败 ' + bgGrabImg.source);
        }
    }
    Canvas {
        id: bgLutCanvas
        visible: false
        width: 48
        height: 24
        onPaint: {
            if (!root.__bgGrabResult || bgGrabImg.status !== Image.Ready)
                return;
            const ctx = bgLutCanvas.getContext('2d');
            ctx.clearRect(0, 0, 48, 24);
            try {
                ctx.drawImage(bgGrabImg, 0, 0, 48, 24);
            } catch (e) {
                console.warn('[bg-grab] drawImage 异常: ' + e);
                return;
            }
            root.__fillBgLut(ctx.getImageData(0, 0, 48, 24).data);
            root.__bgGrabResult = null;
        }
    }
    // 抓取节奏：30ms 合并窗处理突发失效；400ms 步进跟进律动相位与换曲淡化
    Timer {
        id: bgGrabKick
        interval: 30
        onTriggered: root.__captureBg()
    }
    Timer {
        id: bgGrabPacer
        interval: 400
        repeat: true
        running: root.visible && root.hostBlurActive && !!root.__blurTex
                 && (root.__bgGrabDirty || root.__bgRhythmMoving || root.__bgFadeActive)
        onTriggered: root.__captureBg()
    }
    // 换曲交叉淡化补抓窗口（500ms 淡化 + 余量）
    Timer {
        id: bgFadeStop
        interval: 1200
        onTriggered: root.__bgFadeActive = false
    }
    // 与宿主 PlaybackBackground 一致：律动相位按 30fps 上限推进
    FrameAnimation {
        running: root.hostRhythmActive && bgLoader.item && bgLoader.item.ready && root.player.playing && Theme.store.motionEnabled
        property real accumulated: 0
        onRunningChanged: accumulated = 0
        onTriggered: {
            accumulated += Math.min(frameTime, 0.1);
            if (accumulated >= 1 / 30) {
                const remainder = accumulated % (1 / 30);
                root.hostPhase += accumulated - remainder;
                accumulated = remainder;
            }
        }
    }

    // ===== 左栏 =====
    Item {
        id: leftPanel
        anchors.left: parent.left
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        width: root.wide ? Math.max(320, parent.width * 0.42) : parent.width

        Item {
            id: leftContent
            anchors.fill: parent
            anchors.leftMargin: root.wide ? 96 : 24
            anchors.rightMargin: root.wide ? 96 : 24
            anchors.topMargin: 24
            anchors.bottomMargin: 28

            // 旧版 CSS 为封面 100% 宽 + 96px 下边距；在矮窗口下按剩余高度收缩
            readonly property real coverSize: root.wide ? Math.min(width, Math.max(160, height * 0.46)) : Math.min(260, width * 0.7)
            readonly property real coverGap: root.wide ? Math.min(96, Math.max(16, height * 0.1)) : 16

            ColumnLayout {
                anchors.verticalCenter: parent.verticalCenter
                width: parent.width
                spacing: 0

                Item {
                    id: coverWrap
                    Layout.alignment: Qt.AlignHCenter
                    Layout.preferredWidth: leftContent.coverSize
                    Layout.preferredHeight: leftContent.coverSize
                    Layout.bottomMargin: leftContent.coverGap

                    // 封面直接叠在封面模糊背景上：MultiEffect 阴影会把纯黑
                    // 源矩形一并画出，暂停缩小时露出一圈黑底，故不使用阴影
                    EchoCover {
                        id: coverItem
                        anchors.fill: parent
                        source: root.player.coverUrl
                        cornerRadius: 14
                        colors: root.am
                        // 切歌换图期间保留旧图（同 PortraitBackdrop）：避免 Image 加载期
                        // hasArtwork 短暂失效使圆角遮罩 Loader 反复重建——封面闪烁与卡顿来源
                        retainWhileLoading: true
                        // 封面弹簧对照旧插件 coverAnim（500ms ease 关键帧）：
                        // 播放 0.75 → 1.1（60%） → 1；暂停 1 → 0.75；挂载时直接落位不动画
                        property bool lastPlaying: false
                        Component.onCompleted: {
                            scale = root.player.playing ? 1 : 0.75;
                            lastPlaying = root.player.playing;
                        }
                        SequentialAnimation {
                            id: coverSpring
                            NumberAnimation {
                                target: coverItem
                                property: "scale"
                                from: 0.75
                                to: 1.1
                                duration: 300
                                easing.type: Easing.BezierSpline
                                easing.bezierCurve: [0.25, 0.1, 0.25, 1, 1, 1]
                            }
                            NumberAnimation {
                                target: coverItem
                                property: "scale"
                                to: 1
                                duration: 200
                                easing.type: Easing.BezierSpline
                                easing.bezierCurve: [0.25, 0.1, 0.25, 1, 1, 1]
                            }
                        }
                        NumberAnimation {
                            id: coverShrink
                            target: coverItem
                            property: "scale"
                            from: 1
                            to: 0.75
                            duration: 500
                            easing.type: Easing.BezierSpline
                            easing.bezierCurve: [0.25, 0.1, 0.25, 1, 1, 1]
                        }
                        Connections {
                            target: root.player
                            // 按封面实际呈现收敛：只在该动的端点间驱动弹簧，
                            // 切歌后自动起播时封面已在满尺寸，不重复弹簧
                            function syncCoverAnimated(): void {
                                if (root.player.playing) {
                                    if (coverItem.scale < 0.9)
                                        coverSpring.restart();
                                } else {
                                    if (coverItem.scale > 0.9)
                                        coverShrink.restart();
                                }
                            }
                            function onPlayingChanged(): void {
                                // 播放态 NOTIFY 与曲名/封面等共用 changed 信号，按真实变化去重；
                                // 切歌加载期 playing 会 False→True 抖动，只记账不驱动封面
                                if (root.player.loading) {
                                    coverItem.lastPlaying = root.player.playing;
                                    return;
                                }
                                if (coverItem.lastPlaying === root.player.playing)
                                    return;
                                coverItem.lastPlaying = root.player.playing;
                                syncCoverAnimated();
                            }
                            function onLoadingChanged(): void {
                                // 加载完成后收敛到最终播放态（加载期被跳过的状态在此落位；
                                // 连续播放跨曲时封面已在满尺寸，弹簧不触发）
                                if (root.player.loading)
                                    return;
                                if (coverItem.lastPlaying !== root.player.playing) {
                                    coverItem.lastPlaying = root.player.playing;
                                    syncCoverAnimated();
                                } else if (root.player.playing !== (coverItem.scale > 0.9)) {
                                    syncCoverAnimated();
                                }
                            }
                        }
                    }
                }

                // 歌曲信息 + 操作按钮
                Item {
                    Layout.fillWidth: true
                    Layout.preferredHeight: 66
                    Layout.bottomMargin: 16

                    ColumnLayout {
                        id: infoText
                        anchors.left: parent.left
                        anchors.right: actions.left
                        anchors.rightMargin: 8
                        anchors.verticalCenter: parent.verticalCenter
                        spacing: 2

                        Label {
                            id: titleLabel
                            Layout.fillWidth: true
                            text: root.player.title.length > 0 ? root.player.title : qsTr("未知歌曲")
                            font: Theme.font(22, 700)
                            color: root.am.text
                            elide: Text.ElideRight
                            opacity: albumArea.enabled && albumArea.containsMouse ? 0.85 : 1
                            Behavior on opacity {
                                enabled: root.motion
                                NumberAnimation {
                                    duration: 150
                                }
                            }
                            // 专辑可跳转详情时整行可点
                            MouseArea {
                                id: albumArea
                                anchors.fill: parent
                                hoverEnabled: true
                                enabled: root.player.snapshot.track.albumId.length > 0
                                cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                                onClicked: root.openDetail("album-detail", root.player.snapshot.track.albumId)
                            }
                        }
                        EchoArtistLinks {
                            id: artistLinks
                            Layout.fillWidth: true
                            visible: root.player.snapshot.track.artistLinks.length > 0
                            artists: root.player.snapshot.track.artistLinks
                            font: Theme.font(22, 700)
                            color: "#ccffffff"
                            hoverColor: root.am.text
                            onArtistRequested: id => root.openDetail("artist-detail", id)
                        }
                        Label {
                            Layout.fillWidth: true
                            visible: !artistLinks.visible
                            text: root.player.artist.length > 0 ? root.player.artist : qsTr("未知歌手")
                            font: Theme.font(22, 700)
                            color: "#ccffffff"
                            elide: Text.ElideRight
                        }
                    }
                    Row {
                        id: actions
                        anchors.right: parent.right
                        anchors.verticalCenter: parent.verticalCenter
                        spacing: 8

                        AmActionButton {
                            glyph: root.player.snapshot.favorite ? "heart-filled" : "heart"
                            label: qsTr("收藏")
                            active: root.player.snapshot.favorite
                            enabled: root.page.active && root.player.hasTrack
                            onClicked: root.page.command("favorite", {
                                "revision": root.player.revision
                            })
                        }
                        // 评论/分享已由 entry 经 parts.contribute 上移到宿主右缘
                        // 歌词工具列（qml/SideActions.qml），对齐旧 web 版布局
                        AmActionButton {
                            glyph: "list"
                            label: qsTr("更多外观")
                            onClicked: root.plugin.ui.lyricsPage.openSkins()
                        }
                    }
                }

                // 进度条 + 时间 + 音质徽标：布局对照旧插件——轨道盒固定 12px（--bar-h），
                // 可见条在盒的竖直中线上放大（悬停/拖动 1.5 倍 = 18px），不推动下方时间行；
                // 高度过渡 0.5s ease；停留 ≥100ms 后离开播放 0.5s 弹簧回落
                // （旧 amms-progress-spring：18 → 6 → 12），悬停重新进入则冻结当前高度过渡放大
                Item {
                    id: progressSection
                    Layout.fillWidth: true
                    Layout.preferredHeight: 46
                    Layout.bottomMargin: 6

                    readonly property real durationMs: root.player.durationMs
                    readonly property real fraction: durationMs > 0 ? Math.min(1, Math.max(0, root.player.positionMs / durationMs)) : 0
                    property real dragFraction: 0
                    property bool dragging: false
                    // seek 异步：释放后闩住目标进度，等播放位置真正到达再交还（否则先闪回旧进度）
                    property bool seekPending: false
                    property real seekFraction: 0
                    readonly property real shownFraction: dragging ? dragFraction : (seekPending ? seekFraction : fraction)
                    property string dragRevision: ""
                    property real hoverStart: 0
                    onFractionChanged: {
                        // 到达判定：位置落在目标 ±600ms 内即解除闩锁；超时由 seekGuard 兜底
                        if (seekPending && Math.abs(fraction - seekFraction) * durationMs <= 600)
                            seekPending = false;
                    }
                    function beginSeek(target: real): void {
                        seekFraction = target;
                        seekPending = true;
                        seekGuard.restart();
                    }
                    Timer {
                        id: seekGuard
                        interval: 1500
                        onTriggered: progressSection.seekPending = false
                    }
                    // 可见条高度：悬停/拖动 18px，静息 12px；轨道盒高度不变
                    property real barHeight: progressArea.containsMouse || progressSection.dragging ? 18 : 12
                    Behavior on barHeight {
                        enabled: root.motion && !springSeq.running
                        NumberAnimation {
                            duration: 500
                            easing.type: Easing.BezierSpline
                            easing.bezierCurve: [0.25, 0.1, 0.25, 1, 1, 1]
                        }
                    }
                    function springSettle(): void {
                        // 旧 handleProgressMouseLeave：停留 ≥100ms 后离开才播放弹簧
                        if (!progressArea.containsMouse && !progressSection.dragging && Date.now() - hoverStart >= 100)
                            springSeq.restart();
                    }
                    SequentialAnimation {
                        id: springSeq
                        // 关键帧对照旧版：0% 18px → 60% 6px → 100% 12px（0.5s ease）
                        NumberAnimation {
                            target: progressSection
                            property: "barHeight"
                            from: 18
                            to: 6
                            duration: 300
                            easing.type: Easing.BezierSpline
                            easing.bezierCurve: [0.25, 0.1, 0.25, 1, 1, 1]
                        }
                        NumberAnimation {
                            target: progressSection
                            property: "barHeight"
                            to: 12
                            duration: 200
                            easing.type: Easing.BezierSpline
                            easing.bezierCurve: [0.25, 0.1, 0.25, 1, 1, 1]
                        }
                    }

                    Item {
                        id: track
                        // 轨道盒顶对齐（旧版流式布局：信息块 16px 间距后紧跟轨道），
                        // 12 + 14 + 时间行恰好占满 46px 段高，时间行不再侵入按钮悬停区
                        anchors.top: parent.top
                        anchors.left: parent.left
                        anchors.right: parent.right
                        height: 12

                        Rectangle {
                            id: bar
                            anchors.left: parent.left
                            anchors.right: parent.right
                            anchors.verticalCenter: parent.verticalCenter
                            height: progressSection.barHeight
                            radius: height / 2
                            color: "#33ffffff"
                        }
                        Rectangle {
                            id: fill
                            anchors.left: parent.left
                            anchors.verticalCenter: parent.verticalCenter
                            width: Math.max(progressSection.barHeight, track.width * progressSection.shownFraction)
                            height: progressSection.barHeight
                            radius: height / 2
                            color: "#ffffff"
                        }
                    }
                    MouseArea {
                        id: progressArea
                        anchors.fill: track
                        anchors.margins: -8
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        enabled: root.page.active && root.player.hasTrack && progressSection.durationMs > 0
                        onContainsMouseChanged: {
                            // 重新进入时打断弹簧：Behavior 从当前高度过渡到悬停态（旧版冻结 --fill-h）
                            if (containsMouse)
                                progressSection.hoverStart = Date.now();
                            else
                                progressSection.springSettle();
                        }

                        function fractionAt(x: real): real {
                            // MouseArea 上下左右各扩 8px 命中区，换算回轨道坐标
                            return Math.min(1, Math.max(0, (x - anchors.margins) / track.width));
                        }
                        onPressed: mouse => {
                            progressSection.dragging = true;
                            progressSection.seekPending = false;
                            progressSection.dragRevision = root.player.revision;
                            progressSection.dragFraction = fractionAt(mouse.x);
                        }
                        onPositionChanged: mouse => {
                            if (progressSection.dragging)
                                progressSection.dragFraction = fractionAt(mouse.x);
                        }
                        onReleased: mouse => {
                            const fraction = fractionAt(mouse.x);
                            progressSection.dragging = false;
                            progressSection.beginSeek(fraction);
                            root.page.command("seek", {
                                "value": Math.round(fraction * progressSection.durationMs),
                                "revision": progressSection.dragRevision
                            });
                            progressSection.springSettle();
                        }
                        onCanceled: {
                            progressSection.dragging = false;
                            progressSection.springSettle();
                        }
                    }
                    RowLayout {
                        anchors.left: parent.left
                        anchors.right: parent.right
                        anchors.top: track.bottom
                        anchors.topMargin: 14
                        spacing: 8

                        Label {
                            text: root.formatTime(progressSection.dragging || progressSection.seekPending ? progressSection.shownFraction * progressSection.durationMs : root.player.positionMs)
                            font: Theme.font(12, Theme.mediumWeight)
                            color: "#80ffffff"
                        }
                        Item {
                            Layout.fillWidth: true
                            Layout.alignment: Qt.AlignHCenter
                            implicitHeight: qualityBadge.height
                            Rectangle {
                                id: qualityBadge
                                anchors.centerIn: parent
                                visible: root.qualityTag.length > 0
                                radius: 4
                                color: "#26ffffff"
                                width: qualityText.implicitWidth + 16
                                height: 20
                                Label {
                                    id: qualityText
                                    anchors.centerIn: parent
                                    text: root.qualityTag
                                    font: Theme.font(11, 600)
                                    color: "#ccffffff"
                                }
                            }
                        }
                        Label {
                            text: "-" + root.formatTime(Math.max(0, progressSection.durationMs - (progressSection.dragging || progressSection.seekPending ? progressSection.shownFraction * progressSection.durationMs : root.player.positionMs)))
                            font: Theme.font(12, Theme.mediumWeight)
                            color: "#80ffffff"
                        }
                    }
                }

                // 播放控制：随机 | 上一首/播放/下一首 | 列表循环
                // 布局与尺寸逐项对照旧插件（.amms-playback-controls）：两侧 48px 模式钮
                // 外扩 13px（margin 0 -13px），中央 72px 钮组间距 16px
                Item {
                    Layout.fillWidth: true
                    Layout.preferredHeight: 72

                    AmCtrlButton {
                        anchors.left: parent.left
                        anchors.leftMargin: -13
                        anchors.verticalCenter: parent.verticalCenter
                        box: 48
                        glyphSize: 22
                        alpha: root.playMode === 2 ? 1 : 0.5
                        asset: "icons/shuffle.svg"
                        label: qsTr("随机播放")
                        enabled: root.page.active && root.player.hasTrack
                        onClicked: root.page.command("mode", {
                            "value": 2
                        })
                    }
                    AmCtrlButton {
                        anchors.right: parent.right
                        anchors.rightMargin: -13
                        anchors.verticalCenter: parent.verticalCenter
                        box: 48
                        glyphSize: 22
                        alpha: root.playMode === 0 ? 1 : 0.5
                        asset: "icons/loop.svg"
                        label: qsTr("列表循环")
                        enabled: root.page.active && root.player.hasTrack
                        onClicked: root.page.command("mode", {
                            "value": 0
                        })
                    }
                    Row {
                        anchors.centerIn: parent
                        spacing: 16

                        AmCtrlButton {
                            box: 72
                            glyphSize: 42
                            alpha: 0.75
                            asset: "icons/skip.svg"
                            label: qsTr("上一首")
                            enabled: root.page.active && root.player.hasTrack
                            onClicked: root.page.command("previous")
                        }
                        AmCtrlButton {
                            box: 72
                            glyphSize: 36
                            alpha: 1
                            asset: root.player.playing ? "icons/pause.svg" : "icons/play.svg"
                            label: root.player.playing ? qsTr("暂停") : qsTr("播放")
                            enabled: root.page.active && root.player.hasTrack
                            onClicked: root.page.command("toggle")
                        }
                        AmCtrlButton {
                            box: 72
                            glyphSize: 42
                            alpha: 0.75
                            asset: "icons/skip.svg"
                            mirror: true
                            label: qsTr("下一首")
                            enabled: root.page.active && root.player.hasTrack
                            onClicked: root.page.command("next")
                        }
                    }
                }
            }
        }
    }

    // ===== 右栏歌词 =====
    Item {
        id: rightPanel
        anchors.left: leftPanel.right
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        anchors.rightMargin: 40
        anchors.topMargin: 24
        anchors.bottomMargin: 24
        visible: root.wide

        // AMLL 风格歌词流：时间轴/弹簧滚动/逐词扫掠与间奏点在插件侧实现
        LyricFlow {
            id: lyrics
            page: root.page
            anchors.fill: parent
            fontSize: root.lyricFontSize
            baseFont: root.lyricFont
            secondaryFont: root.secondaryLyricFont
            // 演唱行 #fff，未唱行 rgba(255,255,255,0.92)，与旧版一致
            // 演唱行 #fff；未唱部分对照宿主 LyricColors 默认 20% 白（AMLL 明暗比），
            // 扫掠前沿才有可感知的明暗对比
            textColor: "#ffffff"
            unplayedColor: Qt.rgba(1, 1, 1, 0.2)
            // 背景均色估计：渐变带切片色注入背景项（消除带端明暗边界）
            backdropColor: root.backdropColor
            // v9 逐像素背景估计器（null 时 AmllLine 回退 backdropColor 均色）
            backdropSampler: root.backdropSample
            focusPosition: root.s.alignPosition / 100
            wordFade: root.s.fadeWidth / 100
            blurEnabled: root.s.enableBlur
            scaleEnabled: root.s.enableScale
            springEnabled: root.s.enableSpring
            // 副歌词透明度：普通 0.56，增强对比度 0.72
            sublineOpacity: root.s.enhanceContrast ? 0.72 : 0.56
            lineWidthAspect: 0.86
            pageHeight: root.height
        }

        // 上下渐隐，对应旧版 mask-image 12%/88% 边缘遮罩
        layer.enabled: true
        layer.effect: MultiEffect {
            maskEnabled: true
            maskSource: ShaderEffectSource {
                sourceItem: Rectangle {
                    width: Math.max(1, rightPanel.width)
                    height: Math.max(1, rightPanel.height)
                    gradient: Gradient {
                        orientation: Gradient.Vertical
                        GradientStop {
                            position: 0
                            color: "#00ffffff"
                        }
                        GradientStop {
                            position: 0.12
                            color: "#ffffffff"
                        }
                        GradientStop {
                            position: 0.88
                            color: "#ffffffff"
                        }
                        GradientStop {
                            position: 1
                            color: "#00ffffff"
                        }
                    }
                }
            }
        }
    }

    // 圆形操作按钮（收藏/评论/分享/更多），对应旧版 38px 圆形按钮
    component AmActionButton: AbstractButton {
        id: actionButton
        property string glyph
        property string label
        property bool active: false

        implicitWidth: 38
        implicitHeight: 38
        hoverEnabled: true
        Accessible.name: label
        background: Rectangle {
            radius: width / 2
            color: actionButton.enabled && (actionButton.hovered || actionButton.active) ? "#40ffffff" : "#26ffffff"
            Behavior on color {
                enabled: root.motion
                ColorAnimation {
                    duration: 150
                }
            }
        }
        contentItem: Item {
            EchoIcon {
                anchors.centerIn: parent
                width: 18
                height: 18
                name: actionButton.glyph
                color: actionButton.active ? "#ffffff" : "#ccffffff"
            }
        }
    }

    // 播放控制圆钮，样式逐项对照旧插件 .amms-ctrl-btn（style.css）：
    // 48/72px 圆钮；悬停 15% 白圆底（background 0.18s 过渡）；图标为旧版内联 SVG
    // 打包资产（白色，透明度着色：常态 0.75、随机/循环 0.5、激活与播放钮全白）；
    // 按压时序 = 旧版 pressing/holding/releasing 关键帧——压下 0.2s 缩至 0.8，
    // 长按 0.3s 回弹 0.9，释放 0.3s 弹至 1.1 再回 1（释放期间忽略新按压）。
    component AmCtrlButton: AbstractButton {
        id: ctrl
        property string label
        property string asset
        property real box: 72
        property real glyphSize: 36
        property real alpha: 0.75
        property bool mirror: false

        implicitWidth: box
        implicitHeight: box
        hoverEnabled: true
        Accessible.name: label
        transformOrigin: Item.Center
        function endPress(): void {
            holdTimer.stop();
            if (!pressAnim.running && scale > 0.999)
                return;
            pressAnim.stop();
            // 旧关键帧 releasing 0% 固定 scale(0.9)，快速点按时先落回 0.9 再弹出
            releaseStep1.from = 0.9;
            releaseSeq.start();
        }
        onPressed: {
            // 释放弹回期间忽略新按压（旧版 btnReleasing 守卫）
            if (releaseSeq.running)
                return;
            releaseSeq.stop();
            pressAnim.from = scale;
            pressAnim.to = 0.8;
            pressAnim.restart();
            holdTimer.restart();
        }
        onReleased: endPress()
        onCanceled: endPress()

        Timer {
            id: holdTimer
            interval: 200
            onTriggered: {
                pressAnim.stop();
                holdAnim.from = ctrl.scale;
                holdAnim.to = 0.9;
                holdAnim.restart();
            }
        }
        NumberAnimation {
            id: pressAnim
            target: ctrl
            property: "scale"
            duration: 200
            easing.type: Easing.BezierSpline
            easing.bezierCurve: [0.25, 0.1, 0.25, 1, 1, 1]
        }
        NumberAnimation {
            id: holdAnim
            target: ctrl
            property: "scale"
            duration: 300
            easing.type: Easing.BezierSpline
            easing.bezierCurve: [0.25, 0.1, 0.25, 1, 1, 1]
        }
        SequentialAnimation {
            id: releaseSeq
            NumberAnimation {
                id: releaseStep1
                target: ctrl
                property: "scale"
                to: 1.1
                duration: 200
                easing.type: Easing.BezierSpline
                easing.bezierCurve: [0.25, 0.1, 0.25, 1, 1, 1]
            }
            NumberAnimation {
                target: ctrl
                property: "scale"
                to: 1
                duration: 100
                easing.type: Easing.BezierSpline
                easing.bezierCurve: [0.25, 0.1, 0.25, 1, 1, 1]
            }
        }
        background: Rectangle {
            radius: width / 2
            color: ctrl.enabled && ctrl.hovered ? "#26ffffff" : "transparent"
            Behavior on color {
                ColorAnimation {
                    duration: 180
                }
            }
        }
        contentItem: Item {
            Image {
                anchors.centerIn: parent
                width: ctrl.glyphSize
                height: ctrl.glyphSize
                source: ctrl.asset
                sourceSize: Qt.size(ctrl.glyphSize, ctrl.glyphSize)
                fillMode: Image.PreserveAspectFit
                mirror: ctrl.mirror
                opacity: ctrl.enabled ? ctrl.alpha : ctrl.alpha * 0.6
                smooth: true
            }
        }
    }
}

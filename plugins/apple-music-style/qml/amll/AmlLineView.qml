pragma ComponentBehavior: Bound
import QtQuick
import EchoMusic.PluginSdk

// AMLL 风格逐词歌词行（参照 AMLL 完全重构后的渲染层，由 AmllLine.qml 演化）。
// 扫掠语义对齐 AMLL WebMaskAnimator：一条连续亮度前沿按词时长推进（时值间隙
// 停留），软边宽度 = 行盒高度 × fadeWidth（AMLL word.height × wordFadeWidth，
// 无上下钳制，下限 0.0001；实测换行时按检测行数折算单行高）；行程首词
// +1.5×fade、末词 +0.5×fade（revealDistance 与 AMLL 关键帧一致）。
// 渲染对照宿主的单层逐像素渐变：pose 颜色整簇均匀，改用 1px 互斥
// 亮度切片（pose.clip 以 run 局部坐标裁剪，右缘外伸 1.5 footprint 压住
// 宿主 clip 软边窗，窗内 = 满覆盖左色 × 递减右色的精确线性插值）铺满
// 软边段；暗墨基底只从带右缘起罩、不进带内 —— 任何叠层都会复利字形
// 抗锯齿边缘（变粗、偏亮），带内每像素至多一次满覆盖字形 + 一次递减形。
// 亮暗色模型对齐 AMLL 亮度层（亮 1/暗 0.4，随高亮量交叉淡化 300ms 入 /
// 450ms 出，由 AmlGroupView 的 Behavior 驱动）：未唱样（暗：未唱色 alpha ×
// （1 + 高亮量），当前行 0.2 → 0.4 提亮）与已唱样（亮：未唱色 lerp 播放色，
// 随高亮量渐入）。全局逐行歌词（isNonDynamic）对齐 AMLL 无遮罩形态：
// 整行全 alpha，0.2/0.85 由组透明度承担。
// 播放中的词上浮 em × 5%；未逐词的行激活时整行点亮。
// 强调词（时长 ≥1s 且全 CJK 或 2–7 字符）按宿主 LyricLine::pose：
// 逐字交错 rise(.2,.4,.58,1)/fall(.3,0,.58,1) 包络，缩放 1+.1×amount、
// 推移 −em×.03×amount×(字数/2−序)×scale；lift 整体替换为
// −em×(.05×sin×高亮量 + .025×amount×scale)（floatPhase 带 400ms 提前量）、
// 白色辉光 halo（半径 em×strength×.15，透明度 strength×包络×高亮量×亮色α）；
// 缩放围绕簇盒中心（锚点在基线上，需 (1−scale)×中心距补偿）。
// 不做亮/暗双层叠放：双层在词上浮时错位会露出下层形成重影。
// 活动行经 layer 离屏合成（见 layer.enabled 注释）：Qt 对非分层子树的
// item opacity 逐 draw 相乘，切片「前片外伸 + 本片」叠画在 ρ<1 时底层
// 亮墨以 (1−ρ) 泄漏（带比平台亮 +20~28、亮端窗口 +17 斑，实测 dpr1.25）；
// 抵消用的 pose.opacity=1/ρ 又被宿主 finiteRange(opacity,0,1) 拒收。
// layer 内满 α 合成、ρ 在合成出口只乘一次，切片恢复单层逐像素语义。
// 实测 GlyphRun 自定义节点经 layer 抓取内容完好（旧注释「会丢内容」已过时）。
Item {
    id: line

    property string text: ""
    // [{text, t0, t1}]，原始歌词时间（未含歌词偏移）
    property var words: []
    property real timeMs: -1
    // 常走媒体时钟（随播放推进、暂停冻结，不随行失活冻结）：强调包络与
    // 上浮倒放用它——AMLL 的字符动画独立于遮罩（disable 只暂停 maskAnimator，
    // 字符动画继续自然播完/倒放）
    property real animTimeMs: -1
    // 行失活媒体时刻（sweepTime 时钟；<0 = 行在唱）。失活后持久上浮按
    // AMLL disable 语义以 playbackRate=-1 倒放，按词时长缓慢落回基线
    property real disabledAt: -1
    // 行首次启用的媒体时刻（<0 = 尚未启用）。AMLL 字符动画 enable 时才
    // setCurrentTime 起跑——未启用的 upcoming 行无任何浮起
    property real enabledAt: -1
    property bool current: false
    property real highlightAmount: 1
    // 全局逐行歌词（宿主编排核心 isNonDynamic）：对齐 AMLL 无遮罩形态，
    // 静息/过渡态使用全 alpha 播放色，明暗交给组透明度（0.2/0.85）
    property bool nonDynamicLyric: false
    property font font
    property color playedColor: "#ffffff"
    property color unplayedColor: Qt.rgba(1, 1, 1, 0.2)
    // 背景均色估计（Skin 复刻宿主模糊封面合成链算出）。扫掠切片是不透明
    // 外观层，颜色须含背景贡献才与半透明未唱字无缝衔接（否则带尾暗端
    // 相对未唱字有 −bg(1−dimA) 的明暗边界）。
    property color backdropColor: "#000000"
    // v10 逐位置背景估计（Skin.backdropSample 复刻整条背景渲染链）：入参
    // (行局部 x, 行 y)，返回 [r,g,b] 0..1；null 时回退 backdropColor 均色。
    // 背景在空间上大幅变化（封面映射+网格形变），均色无法锚定带端。
    property var backdropAt: null
    // 行视口锚点（调用方按 4px 量化喂入）：雾色在烘焙时按行的当前屏幕位置
    // 采样背景，而 poses 绑定的其余依赖（timeMs/current）在纯滚动
    // 期间都不变——行被滚到新背景区域后雾色会停留在旧位置采的值上（手动
    // 调整进度、滚轮滚动后非当前行颜色不对的根因）。绑定经此读取锚点，
    // 移动超过量化步长即整体重烘焙，静止时零开销。
    property real poseAnchor: 0
    // 0..1，软边宽度系数（AMLL wordFadeWidth，无钳制，下限 0.0001）
    property real fadeWidth: 0.5
    // 活动行离屏合成：Qt 对非分层子树的 item opacity 逐 draw 相乘，扫掠带
    // 「前片外伸 + 本片」叠画在 ρ<1 时底层亮墨以 (1−ρ) 泄漏（带比平台亮
    // +20~28、亮端窗口 +17 斑）；抵消用的 pose.opacity=1/ρ 被宿主
    // finiteRange(opacity,0,1) 拒收（整行 poses 丢弃 → 高亮消失，已实测）。
    // layer 让整个字形子树在层内满 α 精确合成（切片窗口恢复线性插值、halo
    // 不再抬亮已唱墨），ρ 在合成出口只乘一次——带与平台同基准。非活动行
    // 不开层：单 pose 绘制无叠画问题，且避免缩放动画时纹理重采样发虚。
    // 实测 GlyphRun 自定义节点经 layer 抓取内容完好（旧结论「会丢内容」
    // 已过时）。注意不可外扩层源矩形垫越界绘制：外扩区域会被缩放映射回
    // item 矩形（行被压扁、右移，2026-11-12 实测），lift/halo 的越界裁剪
    // 由字体行盒的 ascent/descent 余量吸收。
    layer.enabled: current && hasWordTiming
    // 采样滤波随运动状态切换（lineSmooth 由组视图按弹簧运动逐帧驱动）。
    // 层显示四边形落在亚像素设备原点（弹簧 y 分数 + em=30 在 dpr1.25 下
    // x=37.5）时，静止态双线性会把 1:1 纹理按半纹素混合——当前行整体发糊，
    // 悬停禁模糊后与非当前行直绘对比尤其明显（2026-11-15 实测）→ 静止用
    // 最近邻。但 nearest 的运动是 1 设备像素步进：换行后 posY 弹簧欠阻尼
    // 振荡 ~1-2s，步进的当前行与直绘邻行的亚像素平滑形成相对抖动（同日
    // 实测）→ 运动中回双线性。静止判定带 200ms 迟滞 + 12 帧位移窗
    // （<0.3 逻辑 px 才算静止）。宿主 EchoFloatingSurface 对亚像素 origin
    // 的既有结论：「layer.textureSize alone cannot preserve the subpixel
    // origin of Qt's layer display quad」
    property bool lineSmooth: false
    layer.smooth: lineSmooth
    // 纹理必须按设备像素建：Qt 默认按 item 逻辑尺寸建层 FBO，dpr1.25 下
    // 显示时放大 1.25×，即使 nearest 也有周期性像素重复（当前行残余发糊，
    // 2026-11-15 实测）。宿主所有 layer（EchoCover/EchoFloatingSurface）
    // 均显式设置 textureSize 同因。尺寸取 ceil：FBO 比显示矩形最多大 1
    // 纹素，整幅亚纹素拉伸仅在最右/底缘产生 1 列重复，不可见
    layer.textureSize: Qt.size(
        Math.ceil(width * Screen.devicePixelRatio),
        Math.ceil(height * Screen.devicePixelRatio))
    property bool animateWords: true

    readonly property real em: font.pixelSize
    // AMLL WebMaskAnimator：fadeWidth = word.height × wordFadeWidth。
    // word.height ≈ 单行行盒高度；换行时按检测行数折算（metrics.height 为
    // 总高），未测量前回退 em × 1.2
    readonly property real fade: Math.max(0.0001, rowHeight * Math.max(0.0001, fadeWidth))
    // 单行行盒高度（__refreshGeometry 时随行数折算更新）
    property real rowHeight: em * 1.2
    readonly property bool hasWordTiming: words.some(w => Number(w.t1) !== Number(w.t0))
    // 宿主 LyricLine 的颜色模型：亮色随高亮量从未唱色渐入，
    // 暗色随高亮量提亮（当前行未唱部分 0.2 → 0.4），静止行保持未唱色
    readonly property color dimColor: Qt.rgba(unplayedColor.r, unplayedColor.g, unplayedColor.b, Math.min(1, unplayedColor.a * (1 + highlightAmount)))
    readonly property color brightColor: Qt.rgba(
        unplayedColor.r + (playedColor.r - unplayedColor.r) * highlightAmount,
        unplayedColor.g + (playedColor.g - unplayedColor.g) * highlightAmount,
        unplayedColor.b + (playedColor.b - unplayedColor.b) * highlightAmount,
        unplayedColor.a + (playedColor.a - unplayedColor.a) * highlightAmount)
    // 逐行歌词的全 alpha 形态：AMLL 无 mask 文本（wrapper 0.2/0.85 承担明暗）
    readonly property color solidDimColor: nonDynamicLyric ? Qt.rgba(playedColor.r, playedColor.g, playedColor.b, 1) : dimColor
    readonly property color solidBrightColor: nonDynamicLyric ? Qt.rgba(playedColor.r, playedColor.g, playedColor.b, 1) : brightColor
    readonly property real textWidth: width
    readonly property real textHeight: height
    // 整行塑形指标同步可用；空行没有 run
    readonly property var runMetrics: run.metrics.length > 0 ? run.metrics[0] : null
    implicitHeight: runMetrics ? runMetrics.height : 0
    // 每个词的上浮位移，随播放逐帧更新
    property var lifts: []
    // [{t0, t1, x0, x1, u0, u1, poseStart}]，x 为连续文本坐标（跨行累计前缀），u 为 utf16 区间
    property var wordSpans: []
    // 每个词元簇的连续 x（与 wordSpans 同源）
    property var clusterBases: []
    // 塑形指标缓存（__refreshGeometry 时与 clusterBases 同步更新）：
    // __sweepPoses 经它取 graphemes/height/baseline，避免 poses 绑定直接依赖
    // run.metrics——metrics 随 pose 应用重建并再通知，会让 poses 绑定成环
    property var __metricsCache: null
    readonly property real rawEdge: {
        if (timeMs < 0 || highlightAmount <= 0)
            return -2 * fade;
        if (!hasWordTiming)
            return textWidth + textHeight + 4 * fade;
        const spans = line.wordSpans;
        if (spans.length === 0)
            return -2 * fade;
        let position = spans[0].x0 - 1.5 * fade;
        for (let i = 0; i < spans.length; ++i) {
            const word = spans[i];
            const duration = word.t1 - word.t0;
            const progress = duration > 0 ? Math.min(1, Math.max(0, (timeMs - word.t0) / duration)) : (timeMs >= word.t0 ? 1 : 0);
            position += (word.x1 - word.x0 + (i === 0 ? 1.5 * fade : 0) + (i + 1 === spans.length ? 0.5 * fade : 0)) * progress;
        }
        return position;
    }
    readonly property real edge: rawEdge

    readonly property var runDefinition: text.length > 0 ? [{
                "key": "line",
                "text": text,
                "maxWidth": Math.min(4096, Math.max(1, width)),
                // 辉光贴图预算（合法档位 40/80/160/512/1024）：
                // 强调词 halo 半径 em×strength×.15（strength≤.8 → ≤.12em），
                // em ≤333px 时 ≤40
                "maxHaloRadius": 40,
                // 身体模糊预算（合法档位 0/8/16/32）：AMLL 上限 5px 折算 pose
                // 值 2.5，档位 8 足够；显式声明同时把 effects 图集 tile 的
                // padding 从默认 32 档的 98px 收到 26px（省 ~4 倍显存）。
                // 注意 haloSampling=canvas 模式拒收身体模糊，本皮肤用默认 static。
                "maxBlur": 8
            }] : []

    function __bez(p: real, x1: real, y1: real, x2: real): real {
        // 三次贝塞尔 (0,0)(x1,y1)(x2,1)(1,1) 的 y(x) 牛顿求解，
        // 三条曲线（ease-out、强调升/落包络）终点纵坐标均为 1
        if (p <= 0)
            return 0
        if (p >= 1)
            return 1
        let u = p
        for (let i = 0; i < 8; ++i) {
            const o = 1 - u
            const cx = 3 * o * o * u * x1 + 3 * o * u * u * x2 + u * u * u - p
            if (Math.abs(cx) < 1e-5)
                break
            const dx = 3 * o * o * x1 + 6 * o * u * (x2 - x1) + 3 * u * u * (1 - x2)
            if (Math.abs(dx) < 1e-6)
                break
            u = Math.min(1, Math.max(0, u - cx / dx))
        }
        const o = 1 - u
        return 3 * o * o * u * y1 + 3 * o * u * u + u * u * u
    }
    function __ease(p: real): real {
        // 贝塞尔 (0,0)(0,0)(0.58,1)(1,1)，与宿主逐词上浮一致
        return __bez(p, 0, 0, 0.58)
    }
    function __intensity(x: real): real {
        // AMLL/宿主强度曲线：不足 1 呈三次方，之后开方
        return x < 1 ? x * x * x : Math.sqrt(x)
    }
    function __emphasized(content: string, duration: real): bool {
        // 宿主 LyricLine 强调判定（AMLL shouldEmphasize）：时长 ≥1s 且（全 CJK（≥0x2e80）或去空白 2–7 字符）
        // V4 引擎没有 codePointAt：手写代理对展开
        if (duration < 1000)
            return false
        const s = String(content).trim()
        if (!s)
            return false
        let cjk = true, units = 0
        for (let i = 0; i < s.length; ) {
            const hi = s.charCodeAt(i)
            let code = hi, width = 1
            if (hi >= 0xD800 && hi <= 0xDBFF && i + 1 < s.length) {
                const lo = s.charCodeAt(i + 1)
                if (lo >= 0xDC00 && lo <= 0xDFFF) {
                    code = 0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)
                    width = 2
                }
            }
            if (code < 0x2e80)
                cjk = false
            units += 1
            i += width
        }
        return cjk || (units >= 2 && units <= 7)
    }
    function refreshLifts(): void {
        const count = line.wordSpans.length;
        const list = new Array(count).fill(0);
        // AMLL float 语义：词级 fill:both 持久上浮；行失活（disable）时 float
        // 动画以 playbackRate=-1 倒放——已唱字从各自失活时的进度出发、按词
        // 时长（≥1s）缓慢落回基线，而非随 450ms 亮度衰减塌落（2026-11-15
        // 实测「唱完回落」根因：旧实现 lift 乘 highlightAmount，行尾随高亮量
        // 一起归零）。倒放进度冻结于暂停（animTimeMs 随播放推进）
        if (animateWords && animTimeMs >= 0 && hasWordTiming && count > 0) {
            // 未唱行（未失活且尚未到首词）：上浮恒 0，跳过逐词计算
            if (disabledAt >= 0 || animTimeMs > line.wordSpans[0].t0) {
                for (let i = 0; i < count; ++i) {
                    const word = line.wordSpans[i];
                    const duration = Math.max(1000, word.t1 - word.t0);
                    let p;
                    if (disabledAt < 0) {
                        p = (animTimeMs - word.t0) / duration;
                    } else {
                        p = Math.min(1, Math.max(0, (disabledAt - word.t0) / duration)) -
                                (animTimeMs - disabledAt) / duration;
                    }
                    list[i] = -em * 0.05 * __ease(Math.min(1, Math.max(0, p)));
                }
            }
        }
        // 仅在变化时写回：未唱行/倒放已走完的长眠行每帧重算结果恒定，
        // 跳过赋值避免 lifts 通知触发 poses 绑定逐帧重算
        const old = lifts;
        let same = old.length === count;
        if (same) {
            for (let i = 0; i < count; ++i) {
                if (old[i] !== list[i]) {
                    same = false;
                    break;
                }
            }
        }
        if (!same)
            lifts = list;
    }
    function __graphemeAt(graphemes, position: int): int {
        // 覆盖 utf16 位置的首个词元簇；位置落在簇中间时返回该簇
        for (let i = 0; i < graphemes.length; ++i) {
            const g = graphemes[i];
            if ((Number(g.start) || 0) + (Number(g.length) || 0) > position)
                return i;
        }
        return -1;
    }
    function __refreshGeometry(): void {
        // 由整行塑形结果重建词的连续坐标跨度；同一行内词元共享基线 y，
        // 行前缀 = 之前各行横向步进之和
        const m = line.runMetrics;
        __metricsCache = m;
        const graphemes = m ? m.graphemes : [];
        const rows = [];
        const bases = [];
        let prefix = 0, rowEnd = 0, rowY = null, rowBaseline = 0;
        for (let i = 0; i < graphemes.length; ++i) {
            const g = graphemes[i];
            const y = Math.round(Number(g.y) || 0);
            if (rowY === null || y !== rowY) {
                if (rowY !== null) {
                    rows.push({
                            "baseline": rowBaseline,
                            "end": prefix + rowEnd
                        });
                    prefix += rowEnd;
                }
                rowY = y;
                rowEnd = 0;
                rowBaseline = (Number(m.baseline) || 0) + (Number(g.y) || 0);
            }
            rowEnd = Math.max(rowEnd, (Number(g.x) || 0) + (Number(g.advance) || 0));
            bases[i] = prefix + (Number(g.x) || 0);
        }
        if (rowY !== null)
            rows.push({
                    "baseline": rowBaseline,
                    "end": prefix + rowEnd
                });
        // AMLL fadeWidth 基准 = 单行行盒高度：换行时用相邻行基线距，否则用
        // 整个 run 的高度（单行时两者一致）
        if (rows.length >= 2)
            rowHeight = Math.max(1, rows[1].baseline - rows[0].baseline);
        else if (m && m.height > 0)
            rowHeight = m.height;
        const spans = [];
        const list = line.words;
        let offset = 0;
        let lastContent = -1;
        for (let i = 0; i < list.length; ++i) {
            const word = list[i];
            const content = String(word.text ?? "");
            if (!content)
                continue;
            const start = offset;
            offset += content.length;
            const first = __graphemeAt(graphemes, start);
            if (first < 0)
                continue;
            // 强调元数据：去空白区间的词元簇序号与总数（AMLL 逐字交错用）。
            // V4 引擎没有 trimStart/trimEnd：trim 串在原串中必起于首个非空白位置
            // （其前皆为空白且 trim 串首字符非空白），indexOf 即首空白段长度
            const trimmed = content.trim();
            const lead = content.indexOf(trimmed);
            const trail = content.length - lead - trimmed.length;
            const trimEnd = start + content.length - trail;
            let ec = 0, eg = -1;
            for (let gi = first; gi < graphemes.length; ++gi) {
                const gs = Number(graphemes[gi].start) || 0;
                if (gs >= trimEnd)
                    break;
                if (gs + (Number(graphemes[gi].length) || 0) <= start + lead)
                    continue;
                if (eg < 0)
                    eg = gi;
                ++ec;
            }
            if (content.trim().length > 0)
                lastContent = spans.length;
            spans.push({
                    "t0": Number(word.t0) || 0,
                    "t1": Number(word.t1) || 0,
                    "x0": bases[first],
                    "u0": start,
                    "u1": start + content.length,
                    // 词首所在词元簇的起点是 pose 的合法锚点（跨词连字时共享簇）
                    "poseStart": Number(graphemes[first].clusterStart) || 0,
                    "em": __emphasized(content, (Number(word.t1) || 0) - (Number(word.t0) || 0)),
                    "eg": eg,
                    "ec": ec,
                    "last": false
                });
        }
        // 句尾词（AMLL lastWord：末词时值 ×1.2、强调量 ×1.6）
        if (lastContent >= 0)
            spans[lastContent].last = true;
        for (let i = 0; i < spans.length; ++i)
            spans[i].x1 = i + 1 < spans.length ? spans[i + 1].x0 : (rows.length > 0 ? rows[rows.length - 1].end : 0);
        wordSpans = spans;
        clusterBases = bases;
        refreshLifts();
    }
    function __clusterSpan(start: int): var {
        const spans = line.wordSpans;
        for (let w = 0; w < spans.length; ++w) {
            if (start >= spans[w].u0 && start < spans[w].u1)
                return spans[w];
        }
        return null;
    }
    function __clusterLift(start: int): real {
        const span = line.__clusterSpan(start);
        if (!span)
            return 0;
        const index = line.wordSpans.indexOf(span);
        return line.lifts[index] ?? 0;
    }
    function __flatPoses(): var {
        if (line.text.length === 0)
            return [];
        // 未逐词的行整行同色：激活行点亮，静止行未唱色；
        // 全局逐行歌词用全 alpha 播放色（明暗由组透明度承担）
        return [{
                "key": "line",
                "opacity": line.solidBrightColor.a,
                "color": line.solidBrightColor
            }];
    }
    function __transitionalPoses(): var {
        // 换行复用/首帧时塑形指标还是旧文本：整行单 pose（无 start，任意布局合法）。
        // 若仍按旧簇序号逐簇发 pose，会被提供方整体拒收并回退默认全亮一帧
        return [{
                "key": "line",
                "opacity": line.solidDimColor.a,
                "color": line.solidDimColor
            }];
    }
    // 逐簇 pose 复现宿主/AMLL 的逐像素渐变前沿：o(x) = 0.5 + (前沿 − x)/软边宽。
    // GlyphRun 的 pose 颜色整簇均匀，无法在簇内取样渐变；按前沿把簇切成
    // 亮核 + n 段含背景项的不透明外观切片 + 半透明暗基底（clip 为 run 局部坐标）。
    // 关键：上层切片的左过渡带（fwidth 抗锯齿斜坡）必须整体落在下层切片的
    // 不透明全覆盖区内，下层残尾由上层不透明内部盖住——若相邻两层在边界
    // 同时部分覆盖，premultiplied over 会损失 T_A·T_B·c·(1−c)（亮端 0.25，
    // 与切片数无关；亚像素切片间距还会与像素网格混叠成宽条纹）。
    // 切片 rgb 取基底渲染值↔亮预乘的外观插值、a=1：与半透明渲染逐像素同值
    // （背景项由 Skin 的 backdropColor 估计）。强调变换所有层共享。
    // 强调辉光独立层（形体透明只留 halo），垫在所有字迹层之下——canvas
    // shadowBlur 语义（辉光在字后）。挂在不透明字迹之上会把 228 墨色抬向
    // 255，形成渐变带亮端比已唱平台亮 +18 的竖向亮带。
    function __haloPose(halos, start, y, ex, ey, escale): var {
        const pose = {
                "key": "line",
                "start": start,
                "instance": "h",
                "y": y,
                "opacity": 1,
                "color": Qt.rgba(1, 1, 1, 0),
                "halos": halos
            };
        if (ex !== 0 || ey !== 0 || escale !== 1) {
            pose.x = ex;
            pose.y = y + ey;
            pose.scale = escale;
        }
        return pose;
    }

    function __sweepPosesCore(): var {
        if (line.text.length === 0)
            return [];
        if (!line.hasWordTiming)
            return line.__flatPoses();
        const m = line.__metricsCache;
        const graphemes = m ? m.graphemes : [];
        const bases = line.clusterBases;
        if (line.wordSpans.length === 0 || graphemes.length === 0 || bases.length === 0)
            return line.__transitionalPoses();
        // 塑形覆盖长度必须与当前文本一致，否则簇序号是旧文本的，
        // 发出去会被整体拒收（未知簇）→ 默认全亮闪帧
        const lastG = graphemes[graphemes.length - 1];
        if ((Number(lastG.start) || 0) + (Number(lastG.length) || 0) !== line.text.length)
            return line.__transitionalPoses();
        // 簇基与词元必须同长：塑形晚于 words 到达时（delegate 复用/宽度变化），
        // bases 可能仍是旧文本的——偏短则尾簇 x 取 0 被判全亮，一行出现两处高亮
        if (bases.length !== graphemes.length)
            return line.__transitionalPoses();
        const list = [];
        const seen = new Set();
        const edge = line.edge, fade = line.fade;
        const em = line.em;
        // 强调变换不随高亮量衰减（AMLL disable 只倒放 float，辉光/缩放动画
        // 继续自然播完）；且仅在行启用后起跑（AMLL 字符动画 enable 时才
        // setCurrentTime 起跑，未启用的 upcoming 行无任何浮起——2026-11-15
        // 实测「下一句的字提前上浮」根因：包络走全局媒体时钟，行未启用就
        // 按 400ms 提前量起浮）
        const empActive = line.animateWords && line.enabledAt >= 0;
        // GlyphRun 缩放围绕簇锚点（中点 x、基线 y），
        // AMLL 围绕字盒中心：需 (1−scale)×(盒中心−基线) 补偿
        const centerDy = m.height / 2 - m.baseline;
        // 渐变分区几何：不透明外观切片（色含背景项、a=1）+ 带右暗基底。
        // 宿主 clip 软边 = 以裁剪边为中心、宽 1 footprint（fp = 1/dpr 逻辑px，
        // glyph-run.frag 的 fwidth 渐变）的线性渐变。相邻切片共享边界 b 时，
        // 窗口 [b−fp/2, b+fp/2] 内要得到精确线性插值（满覆盖左色 × 递减右色），
        // 左片必须以满覆盖压住整个窗口 ⟹ 右缘外伸 X ≥ fp，取 1.5fp 容差。
        // X 不足：左片在窗口内已递减，底层从二次混合项泄漏 α(1−α)(C−底层)，
        // 带内出现暗釉/接缝（F=1、pitch≈fp 时实测核心 −10~−17）；X 过大：两片
        // 同时满覆盖的区域变宽，同形字形边缘 coverage 复利 1−(1−g)^N，扫掠字
        // 变粗（F=4 时带内每像素 ~5 层叠画）。暗基底只从带右缘 g1 起罩：带内
        // 若垫暗墨底层，字形边缘像素额外叠 dimA·g 的墨（≈+13/255），整条带
        // 像浮在歌词上的一层——底层一律不进带；带左半由 slice 1 向左无限延伸
        // 兜底，带右半由末片外伸 + 暗基底衔接。
        // 切片色 = 暗端与亮端两个背景合成值的插值（暗端 dimPr+bg(1−dimA)、
        // 亮端 brightPr+bg(1−brightA)，bg 逐片取样）：宿主像素 = mix(dim,bright,p)
        // 以逐像素 alpha 合成到真实背景，两端锚定后带内与宿主逐像素同值
        // （unplayed/played 同 rgb 时精确相等）；bg 估计残差只表现为中心段
        // ≤ ±8/255 的平滑倾斜（无周期结构）。dpr 与行层 textureSize（见
        // layer.textureSize 注释）同用 Screen.devicePixelRatio 口径
        const dpr = Screen.devicePixelRatio || 1;
        const PITCH = 1.0;
        const F = 1.5 / dpr;
        const g0 = edge - fade * 0.5, g1 = edge + fade * 0.5;
        const K = Math.max(1, Math.ceil(fade / PITCH));
        const pitch = fade / K;
        const dimA = line.dimColor.a, brightA = line.brightColor.a;
        const dc = line.dimColor, bc = line.brightColor;
        const dimPr = [dc.r * dimA, dc.g * dimA, dc.b * dimA];
        const brightPr = [bc.r * brightA, bc.g * brightA, bc.b * brightA];
        // 切片背景项：v10 有逐位置估计器时切片各自取样（背景空间变化大，均色
        // 锚不住带端），此均色仅作估计器未就绪时的回退。
        const bgc = line.backdropColor;
        for (let i = 0; i < graphemes.length; ++i) {
            const g = graphemes[i];
            const start = Number(g.clusterStart) || 0;
            if (seen.has(start))
                continue;
            seen.add(start);
            const gx = Number(g.x) || 0;
            const advance = Number(g.advance) || 0;
            const x = bases[i] ?? 0;              // 连续文本坐标簇左缘
            const rowPrefix = x - gx;             // 所在行的行前缀（clip 用行内局部坐标）
            const y = line.__clusterLift(start);
            const span = line.__clusterSpan(start);
            // 强调词逐字动画（宿主 LyricLine::pose 同式，包络 rise/fall 分段）
            let ex = 0, ey = 0, escale = 1, halos = null;
            if (empActive && span && span.em && span.ec > 0) {
                const charIndex = i - span.eg;
                if (charIndex >= 0 && charIndex < span.ec) {
                    const rawDu = span.t1 - span.t0;
                    const length = Math.max(1000, rawDu) * (span.last ? 1.2 : 1);
                    const t = line.animTimeMs - span.t0;
                    const stagger = length / 2.5 / span.ec * charIndex;
                    const phase = Math.min(1, Math.max(0, (t - stagger) / length));
                    const env = phase < 0.5 ? line.__bez(phase * 2, 0.2, 0.4, 0.58)
                                            : 1 - line.__bez((phase - 0.5) * 2, 0.3, 0, 0.58);
                    const amount = Math.min(
                                1.2, line.__intensity(rawDu / 2000) * 0.6 * (span.last ? 1.6 : 1)) *
                            env;
                    escale = 1 + 0.1 * amount;
                    ex = -em * 0.03 * amount * (span.ec / 2 - charIndex) * escale;
                    // 强调字浮动 = 持久上浮 + 正弦弹跳（AMLL 语义：词级
                    // createFloatAnimation fill:both 持久保持，字符级
                    // emphasize-word-float composite:add 叠加其上，弹跳落点 =
                    // 持久上浮位而非基线——覆盖式写法会让弹跳结束后停留在
                    // 基线，已唱强调字「上浮后回落」）。正弦随字交错时刻起
                    // 浮、带 400ms 提前量（(t−stagger+400)/(length×1.4)），
                    // 另加 .025×amount×scale 的包络推抬（glow offsetY 同式）
                    const floatPhase = Math.min(1, Math.max(0, (t - stagger + 400) / (length * 1.4)));
                    ey = -em * (0.05 * Math.sin(floatPhase * Math.PI)
                                + 0.025 * amount * escale)
                            + (1 - escale) * centerDy;
                    const blurBase = Math.min(
                                0.8, line.__intensity(rawDu / 3000) * 0.5 * (span.last ? 1.5 : 1));
                    // 宿主 shader 合成把 halo 乘 bright.a：辉光随亮色 alpha 渐入渐出
                    const haloOpacity = blurBase * env * line.brightColor.a;
                    if (haloOpacity > 0.01)
                        halos = [{
                                // 宿主 mask 烘焙半径 max(1, ceil(em·dpr·strength·.15))：
                                // dpr 抵消后逻辑半径 = em×strength×.15（≤.12em）
                                "radius": Math.max(1, Math.ceil(line.em * blurBase * 0.15)),
                                "opacity": haloOpacity,
                                "color": Qt.rgba(1, 1, 1, 1)
                            }];
                }
            }
            // 簇两端亮度：oL（左缘）≥ oR（右缘，亮度沿 x 递减）
            const oL = 0.5 + (edge - x) / fade;
            const oR = 0.5 + (edge - x - advance) / fade;
            // 全亮判定必须与下方切片 break 的原始比较（bandL ≥ x+advance）
            // 同侧：扫掠终点 edge 恰停在 x+advance+fade/2 边界上，(edge-x-adv)/fade
            // 的除法舍入可能得 0.99… 而落入 cross 路径，此时切片对簇内各列全部
            // break（li ≥ x+advance）、暗基底又只从带右缘 g1（已越过簇右缘）起
            // 罩——整簇无任何 pose，末字消失直到换行。此处并列原始比较，边界态
            // 一律全亮。
            if (oR >= 1 || edge - x - advance >= fade * 0.5) {
                // 整簇全亮（右缘未进过渡带）：halo 垫底 + 单层 pose
                if (halos)
                    list.push(line.__haloPose(halos, start, y, ex, ey, escale));
                const pose = {
                        "key": "line",
                        "start": start,
                        "y": y,
                        "opacity": 1,
                        "color": line.brightColor
                    };
                if (ex !== 0 || ey !== 0 || escale !== 1) {
                    pose.x = ex;
                    pose.y = y + ey;
                    pose.scale = escale;
                }
                list.push(pose);
                continue;
            }
            if (oL <= 0) {
                // 整簇全暗：halo 垫底 + 单层 pose
                if (halos)
                    list.push(line.__haloPose(halos, start, y, ex, ey, escale));
                const pose = {
                        "key": "line",
                        "start": start,
                        "y": y,
                        "opacity": 1,
                        "color": line.dimColor,
                        // 行局部 x 中心：模糊注入时换算不透明外观需按簇位置取背景
                        "__bgx": x - rowPrefix + advance * 0.5
                    };
                if (ex !== 0 || ey !== 0 || escale !== 1) {
                    pose.x = ex;
                    pose.y = y + ey;
                    pose.scale = escale;
                }
                list.push(pose);
                continue;
            }
            // 跨越簇：halo 垫底 → 不透明外观切片（先铺暗基底：其 ramp-up 窗整个
            // 落在切片 1 的不透明内部之下，被遮住）。切片 1 强制 τ=1 并向左无限
            // 延伸（兼作旧亮核，满亮区无台阶）；同簇多层 pose 需互异 instance。
            if (halos)
                list.push(line.__haloPose(halos, start, y, ex, ey, escale));
            const bandL = g0;
            {
                const pose = {
                        "key": "line",
                        "start": start,
                        "instance": "d",
                        "y": y,
                        "opacity": 1,
                        "color": line.dimColor,
                        "clip": {
                            // 只从带右缘 g1 起罩：带内不能垫暗墨底层（字形边缘
                            // 会复利一层 dimA·g 的墨 ≈ +13/255，形成浮层）。
                            // 带左半由 slice 1 向左无限延伸兜底；末片外伸越过
                            // g1 后由本基底衔接，浮点边界态不再有裸露区
                            "x": g1 - rowPrefix,
                            "y": -100000,
                            "width": 900000,
                            "height": 200000
                        }
                    };
                if (ex !== 0 || ey !== 0 || escale !== 1) {
                    pose.x = ex;
                    pose.y = y + ey;
                    pose.scale = escale;
                }
                list.push(pose);
            }
            for (let s = 1; s <= K; ++s) {
                const li = bandL + pitch * (s - 1);     // 切片左缘（= 台阶边界）
                if (li >= x + advance)
                    break;      // 切片已越到簇右侧
                const ri = li + pitch + F;              // 右缘多伸 F：残尾没入下级内部
                if (s > 1 && ri <= x)
                    continue;   // 切片整体在簇左侧（切片 1 向左无限延伸，不受此限）
                const tau = s === 1
                        ? 1
                        : Math.min(1, Math.max(0, 0.5 + (edge - (li + pitch * 0.5)) / fade));
                if (tau <= 0.005)
                    break;      // 余下切片与暗基底同观感
                // 每片自己的背景项：切片中心行局部 x（= clip 坐标系）取样；
                // 带端与未唱字衔接的是该片所在位置的背景，而非整行均值
                let bgR = bgc.r, bgG = bgc.g, bgB = bgc.b;
                if (line.backdropAt) {
                    const bgS = line.backdropAt(li - rowPrefix + pitch * 0.5, y);
                    if (bgS) {
                        bgR = bgS[0];
                        bgG = bgS[1];
                        bgB = bgS[2];
                    }
                }
                // 不透明外观：两端都锚定背景合成值——暗端 = 暗墨叠背景，亮端 =
                // 亮墨叠背景（含 bg(1−brightA) 项）。宿主像素 = mix(dim,bright,p)
                // 以逐像素 alpha 合成到真实背景；亮端缺背景项时高亮渐入/渐出
                // （brightA<1）期间已唱平台偏暗。unplayed/played 同 rgb 时与宿主
                // 逐像素同值，异色时差异为二阶小量
                const d0 = dimPr[0] + bgR * (1 - dimA),
                      d1 = dimPr[1] + bgG * (1 - dimA),
                      d2 = dimPr[2] + bgB * (1 - dimA);
                const e0 = brightPr[0] + bgR * (1 - brightA),
                      e1 = brightPr[1] + bgG * (1 - brightA),
                      e2 = brightPr[2] + bgB * (1 - brightA);
                const pose = {
                        "key": "line",
                        "start": start,
                        "instance": "s" + s,
                        "y": y,
                        // 宿主校验 opacity ∈ [0,1]（GlyphRun.cpp finiteRange），
                        // >1 整体拒收 → 行渲染退化为无 poses——不得在此抵消 ρ
                        "opacity": 1,
                        "color": Qt.rgba(d0 + (e0 - d0) * tau,
                                         d1 + (e1 - d1) * tau,
                                         d2 + (e2 - d2) * tau, 1),
                        "clip": {
                            "x": s === 1 ? -100000 : li - rowPrefix,
                            "y": -100000,
                            // 切片 1 的 width 以连续坐标 ri 表达右缘：clip 矩形
                            // 是行局部空间，右缘 = −100000 + width 必须落在
                            // ri − rowPrefix。行 1（rowPrefix=0）下二者相等故
                            // 旧写法侥幸正确；换行后连续 ri（≈edge，数百 px）
                            // 恒大于行 2 局部任意 x → τ=1 亮片罩满整个跨越簇
                            // 的字形四边形，带右侧出现全亮墨——渐变观感反向
                            // （2026-11-15 换行第二行渐变反向根因，冻结态实测）
                            "width": (s === 1 ? ri - rowPrefix + 100000 : ri - li),
                            "height": 200000
                        }
                    };
                if (ex !== 0 || ey !== 0 || escale !== 1) {
                    pose.x = ex;
                    pose.y = y + ey;
                    pose.scale = escale;
                }
                list.push(pose);
            }
        }
        return list;
    }
    // 远行模糊不在此注入 GlyphPose.blur：宿主 pose quad = inkBounds ±
    // (blur×3+2)（GlyphRun.cpp:2247），而模糊档位的实际烘焙支撑 ≈
    // 3×qRound(8×density)/density ≈ blur×3.6（dpr1.25 时 28.8px vs 22.6px）
    // ——mask 尾部在 quad 边缘仍非零，被 quad 几何硬切成贯穿行宽的直边亮带
    // （2026-11-15 实测「已播放行辉光有明显边界」根因，钳小 blur 只能缩带
    // 不能消边）。模糊改由 AmlGroupView 的组级 layer.effect（MultiEffect）
    // 承担，等价 AMLL 的 CSS filter blur；本行保持锐利位图交组层统一模糊。
    // 曾在此按标定曲线（pose ≈ 6.35+0.1×B，标定数据随历史提交可考）注入
    // blur，并对模糊行做「暗墨叠背景」不透明重映射（glowGain .45，抑制
    // 半透明墨令同 pose 溶解显著加重的实测现象）——二者均为 pose.blur 路径
    // 的补偿，随该路径一并移除。
    function __sweepPoses(): var {
        // 经此读取 poseAnchor 注册绑定依赖：行移动时重烘焙，雾色背景采样
        // 始终对应当前屏幕位置（见 poseAnchor 注释）
        const anchor = line.poseAnchor;
        return __sweepPosesCore();
    }

    onWordsChanged: __refreshGeometry()
    // 塑形结果异步晚于 words 到达（换行/宽度变化都会触发重排）：
    // metrics 落地时必须重建几何，否则 clusterBases/wordSpans 永远停在旧文本上
    onRunMetricsChanged: __refreshGeometry()
    onAnimTimeMsChanged: refreshLifts()
    onDisabledAtChanged: refreshLifts()
    onAnimateWordsChanged: refreshLifts()
    Component.onCompleted: __refreshGeometry()

    GlyphRun {
        id: run
        font: line.font
        runs: line.runDefinition
        poses: line.visible ? line.__sweepPoses() : []
        width: line.width
        height: line.textHeight
        onLayoutChanged: line.__refreshGeometry()
        onErrorChanged: if (errorString)
            console.warn('[apple-music-style] GlyphRun:', errorString)
    }
}

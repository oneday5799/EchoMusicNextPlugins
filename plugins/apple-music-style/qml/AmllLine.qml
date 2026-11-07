pragma ComponentBehavior: Bound
import QtQuick
import EchoMusic.PluginSdk

// AMLL 风格逐词歌词行。移植宿主 LyricLine / AMLL core 的呈现语义：
// 一条连续亮度前沿按词时长推进（时值间隙停留），软边宽度 fadeWidth × em × 1.2；
// 播放中的词上浮 em × 5%；未逐词的行激活时整行点亮。
// 渲染对照宿主的单层逐像素渐变：pose 颜色整簇均匀，改用 16 段互斥
// 亮度切片（pose.clip 以 run 局部坐标逐像素 fwidth 抗锯齿裁剪）铺满
// 软边段，每像素恰好一层 —— 叠层会复利字形抗锯齿边缘（变粗、偏亮）；
// 未唱样（暗：未唱色 alpha ×（1 + 高亮量），当前行 0.2 → 0.4 提亮）
// 与已唱样（亮：未唱色 lerp 播放色，随高亮量渐入）。上浮随所属词。
// 强调词（时长 ≥1s 且全 CJK 或 2–7 字符）按 AMLL emphasize：
// 逐字交错 rise(.2,.4,.58,1)/fall(.3,0,.58,1) 包络，缩放 1+.1×amount、
// 推移 −em×.03×amount×(字数/2−序)×scale、常幅正弦浮动（随字起浮，
// 叠加在 −em×.05 基础上浮之上，落点保持在抬起态）、
// 白色辉光 halo（半径 min(.3, blur×.3)em，透明度 blur×包络×高亮量）；
// 缩放围绕簇盒中心（锚点在基线上，需 (1−scale)×中心距补偿）。
// 不做亮/暗双层叠放：双层在词上浮时错位会露出下层形成重影，
// 也不经过 layer/ShaderEffect（GlyphRun 的自定义节点经 layer 抓取会丢内容）。
Item {
    id: line

    property string text: ""
    // [{text, t0, t1}]，原始歌词时间（未含歌词偏移）
    property var words: []
    property real timeMs: -1
    property bool current: false
    property real highlightAmount: 1
    property font font
    property color playedColor: "#ffffff"
    property color unplayedColor: Qt.rgba(1, 1, 1, 0.2)
    // 背景均色估计（Skin 复刻宿主模糊封面合成链算出）。扫掠切片是不透明
    // 外观层，颜色须含背景贡献才与半透明未唱字无缝衔接（否则带尾暗端
    // 相对未唱字有 −bg(1−dimA) 的明暗边界）。
    property color backdropColor: "#000000"
    // v9 逐位置背景估计（Skin.backdropSample 复刻整条背景渲染链）：入参
    // (行局部 x, 行 y)，返回 [r,g,b] 0..1；null 时回退 backdropColor 均色。
    // 背景在空间上大幅变化（封面映射+网格形变），均色无法锚定带端。
    property var backdropAt: null
    // 0..1，软边宽度系数（对应旧 AMLL 的 fadeWidth）
    property real fadeWidth: 0.5
    property bool animateWords: true

    readonly property real em: font.pixelSize
    readonly property real fade: Math.max(1, em * 1.2 * fadeWidth)
    readonly property bool hasWordTiming: words.some(w => Number(w.t1) !== Number(w.t0))
    // 宿主 LyricLine 的颜色模型：亮色随高亮量从未唱色渐入，
    // 暗色随高亮量提亮（当前行未唱部分 0.2 → 0.4），静止行保持未唱色
    readonly property color dimColor: Qt.rgba(unplayedColor.r, unplayedColor.g, unplayedColor.b, Math.min(1, unplayedColor.a * (1 + highlightAmount)))
    readonly property color brightColor: Qt.rgba(
        unplayedColor.r + (playedColor.r - unplayedColor.r) * highlightAmount,
        unplayedColor.g + (playedColor.g - unplayedColor.g) * highlightAmount,
        unplayedColor.b + (playedColor.b - unplayedColor.b) * highlightAmount,
        unplayedColor.a + (playedColor.a - unplayedColor.a) * highlightAmount)
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
                // 强调词 halo 半径 min(.3, blur×.3)em，em ≤133px 时 ≤40
                "maxHaloRadius": 40
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
        // 宿主 LyricLine 强调判定：时长 ≥1s 且（全 CJK（≥0x2e80）或去空白 2–7 字符）
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
        if (current && animateWords && timeMs >= 0 && hasWordTiming && highlightAmount > 0) {
            for (let i = 0; i < count; ++i) {
                const word = line.wordSpans[i];
                const duration = Math.max(1000, word.t1 - word.t0);
                list[i] = -em * 0.05 * __ease(Math.min(1, Math.max(0, (timeMs - word.t0) / duration))) * highlightAmount;
            }
        }
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
        // 未逐词的行整行同色：激活行点亮，静止行未唱色
        return [{
                "key": "line",
                "opacity": line.brightColor.a,
                "color": line.brightColor
            }];
    }
    function __transitionalPoses(): var {
        // 换行复用/首帧时塑形指标还是旧文本：整行单 pose（无 start，任意布局合法）。
        // 若仍按旧簇序号逐簇发 pose，会被提供方整体拒收并回退默认全亮一帧
        return [{
                "key": "line",
                "opacity": line.dimColor.a,
                "color": line.dimColor
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
            pose.y = ey;
            pose.scale = escale;
        }
        return pose;
    }

    function __sweepPoses(): var {
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
        const empActive = line.current && line.animateWords && line.highlightAmount > 0;
        // GlyphRun 缩放围绕簇锚点（中点 x、基线 y），
        // AMLL 围绕字盒中心：需 (1−scale)×(盒中心−基线) 补偿
        const centerDy = m.height / 2 - m.baseline;
        // 渐变分区几何：不透明外观切片（色含背景项、a=1）+ 暗基底，pitch = F。
        // 宿主 clip 为软边缘（以裁剪边为中心、宽 = footprint 的渐变）：每片右缘
        // 多伸 F，ramp-down 尾恰好整个落在下级内部、ramp-up 窗恰好整个落在上级
        // 内部——满覆盖处中间层不透明，遮住邻片残尾，任意点只显现单层外观，
        // 带内梯度 = 逐格常色 + 1px 线性过渡，台阶 Δ ≈ (bright−dim 外观)·F/fade
        // ≈ 3/255（旧方案 pitch≥2F 时 Δ≈13，即用户所见条纹）。
        // 切片色 = 基底渲染值 U 与亮预乘的插值（U = dimPr + bg(1−dimA)，bg 取
        // Skin 的背景均色估计）：不透明层渲染 lerp(U, brightPr, τ)，与"半透明
        // 亮墨 τ 叠暗基底"逐像素同值，带两端与已唱/未唱平台精确锚定，无明暗
        // 边界；bg 估计残差只表现为中心段 ≤ ±8/255 的平滑倾斜（无周期结构）。
        // 半透明分解（α=τ 亮切片叠基底）虽天然含背景项，但相邻切片软窗重叠
        // 过合成 / 互补窗欠覆盖（±26~38），条纹不可接受，不可取。
        // F 为设计 footprint 上限（dpr ≥ 1、强调 scale ≥ 1 → 实际 ≤ 1）。
        const F = 1.0;
        const g0 = edge - fade * 0.5, g1 = edge + fade * 0.5;
        const K = Math.max(1, Math.ceil(fade / F));
        const pitch = fade / K;
        const dimA = line.dimColor.a, brightA = line.brightColor.a;
        const dc = line.dimColor, bc = line.brightColor;
        const dimPr = [dc.r * dimA, dc.g * dimA, dc.b * dimA];
        const brightPr = [bc.r * brightA, bc.g * brightA, bc.b * brightA];
        // 基底渲染值（含背景项）：暗墨叠背景 = 已唱/未唱平台间的暗端锚点。
        // v9 有逐位置估计器时切片各自取样（背景空间变化大，均色锚不住带端），
        // 此均值仅作估计器未就绪时的回退。
        const bgc = line.backdropColor;
        const baseApp = [dimPr[0] + bgc.r * (1 - dimA),
                         dimPr[1] + bgc.g * (1 - dimA),
                         dimPr[2] + bgc.b * (1 - dimA)];
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
                    const t = line.timeMs - span.t0;
                    const stagger = length / 2.5 / span.ec * charIndex;
                    const phase = Math.min(1, Math.max(0, (t - stagger) / length));
                    const env = phase < 0.5 ? line.__bez(phase * 2, 0.2, 0.4, 0.58)
                                            : 1 - line.__bez((phase - 0.5) * 2, 0.3, 0, 0.58);
                    const amount = Math.min(
                                1.2, line.__intensity(rawDu / 2000) * 0.6 * (span.last ? 1.6 : 1)) *
                            env * line.highlightAmount;
                    escale = 1 + 0.1 * amount;
                    ex = -em * 0.03 * amount * (span.ec / 2 - charIndex) * escale;
                    // AMLL emphasize float：常幅正弦叠加在基础上浮之上（复合而非替代），
                    // 落点保持在抬起态；随字自身交错时刻起浮，无提前量
                    const floatPhase = Math.min(1, Math.max(0, (t - stagger) / (length * 1.4 - 400)));
                    ey = -em * 0.05
                                * line.__ease(Math.min(1, Math.max(0, t / Math.max(1000, rawDu))))
                                * line.highlightAmount
                            - em * 0.05 * Math.sin(floatPhase * Math.PI)
                            + (1 - escale) * centerDy;
                    const blurBase = Math.min(
                                0.8, line.__intensity(rawDu / 3000) * 0.5 * (span.last ? 1.5 : 1));
                    const haloOpacity = blurBase * env * line.highlightAmount;
                    if (haloOpacity > 0.01)
                        halos = [{
                                "radius": Math.min(0.3, blurBase * 0.3) * em,
                                "opacity": haloOpacity,
                                "color": Qt.rgba(1, 1, 1, 1)
                            }];
                }
            }
            // 簇两端亮度：oL（左缘）≥ oR（右缘，亮度沿 x 递减）
            const oL = 0.5 + (edge - x) / fade;
            const oR = 0.5 + (edge - x - advance) / fade;
            if (oR >= 1) {
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
                    pose.y = ey;
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
                        "color": line.dimColor
                    };
                if (ex !== 0 || ey !== 0 || escale !== 1) {
                    pose.x = ex;
                    pose.y = ey;
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
                            "x": bandL - rowPrefix,
                            "y": -100000,
                            "width": 900000,
                            "height": 200000
                        }
                    };
                if (ex !== 0 || ey !== 0 || escale !== 1) {
                    pose.x = ex;
                    pose.y = ey;
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
                let b0 = baseApp[0], b1 = baseApp[1], b2 = baseApp[2];
                if (line.backdropAt) {
                    const bgS = line.backdropAt(li - rowPrefix + pitch * 0.5, y);
                    if (bgS) {
                        b0 = dimPr[0] + bgS[0] * (1 - dimA);
                        b1 = dimPr[1] + bgS[1] * (1 - dimA);
                        b2 = dimPr[2] + bgS[2] * (1 - dimA);
                    }
                }
                // 不透明外观：外观目标 P(τ) = lerp(baseApp, brightPr, τ)（a=1 时
                // 直色 = 预乘色），与半透明亮墨叠暗基底逐像素同值
                const pose = {
                        "key": "line",
                        "start": start,
                        "instance": "s" + s,
                        "y": y,
                        "opacity": 1,
                        "color": Qt.rgba(b0 + (brightPr[0] - b0) * tau,
                                         b1 + (brightPr[1] - b1) * tau,
                                         b2 + (brightPr[2] - b2) * tau, 1),
                        "clip": {
                            "x": s === 1 ? -100000 : li - rowPrefix,
                            "y": -100000,
                            "width": (s === 1 ? ri + 100000 : ri - li),
                            "height": 200000
                        }
                    };
                if (ex !== 0 || ey !== 0 || escale !== 1) {
                    pose.x = ex;
                    pose.y = ey;
                    pose.scale = escale;
                }
                list.push(pose);
            }
        }
        return list;
    }

    onWordsChanged: __refreshGeometry()
    // 塑形结果异步晚于 words 到达（delegate 复用/换行/宽度变化都会触发重排）：
    // metrics 落地时必须重建几何，否则 clusterBases/wordSpans 永远停在旧文本上
    onRunMetricsChanged: __refreshGeometry()
    onCurrentChanged: refreshLifts()
    onTimeMsChanged: refreshLifts()
    onAnimateWordsChanged: refreshLifts()
    onHighlightAmountChanged: refreshLifts()
    Component.onCompleted: __refreshGeometry()

    GlyphRun {
        id: run
        font: line.font
        runs: line.runDefinition
        poses: line.__sweepPoses()
        width: line.width
        height: line.textHeight
        onLayoutChanged: line.__refreshGeometry()
        onErrorChanged: if (errorString)
            console.warn('[apple-music-style] GlyphRun:', errorString)
    }
}

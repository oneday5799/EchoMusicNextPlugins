pragma ComponentBehavior: Bound
import QtQuick
import EchoMusic.PluginSdk

// AMLL 风格逐词歌词行。移植宿主 LyricLine / AMLL core 的呈现语义：
// 一条连续亮度前沿按词时长推进（时值间隙停留），软边宽度 fadeWidth × em × 1.2；
// 播放中的词上浮 em × 5%；未逐词的行激活时整行点亮。
// 渲染对照宿主的单层逐像素渐变：每簇一个 pose，颜色与透明度由
// 未唱样（暗：未唱色 alpha ×（1 + 高亮量），当前行 0.2 → 0.4 提亮）
// 与已唱样（亮：未唱色 lerp 播放色，随高亮量渐入）按前沿透明度插值。
// 簇中点取样即宿主线性渐变在该簇的精确均值；上浮随所属词。
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
                "maxWidth": Math.min(4096, Math.max(1, width))
            }] : []

    function __ease(p: real): real {
        // 贝塞尔 (0,0)(0,0)(0.58,1)(1,1)，与宿主逐词上浮一致
        let u = Math.min(1, Math.max(0, p));
        for (let i = 0; i < 8; ++i) {
            const o = 1 - u;
            const cx = 3 * o * u * u * 0.58 + u * u * u - p;
            if (Math.abs(cx) < 1e-5)
                break;
            const dx = 6 * o * u * (0.58 - 0) + 3 * u * u * (1 - 0.58);
            if (Math.abs(dx) < 1e-6)
                break;
            u = Math.min(1, Math.max(0, u - cx / dx));
        }
        const o = 1 - u;
        return 3 * o * u * u * 1 + u * u * u;
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
            spans.push({
                    "t0": Number(word.t0) || 0,
                    "t1": Number(word.t1) || 0,
                    "x0": bases[first],
                    "u0": start,
                    "u1": start + content.length,
                    // 词首所在词元簇的起点是 pose 的合法锚点（跨词连字时共享簇）
                    "poseStart": Number(graphemes[first].clusterStart) || 0
                });
        }
        for (let i = 0; i < spans.length; ++i)
            spans[i].x1 = i + 1 < spans.length ? spans[i + 1].x0 : (rows.length > 0 ? rows[rows.length - 1].end : 0);
        wordSpans = spans;
        clusterBases = bases;
        refreshLifts();
    }
    function __clusterLift(start: int): real {
        const spans = line.wordSpans;
        for (let w = 0; w < spans.length; ++w) {
            if (start >= spans[w].u0 && start < spans[w].u1)
                return line.lifts[w] ?? 0;
        }
        return 0;
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
    // 逐簇 pose：透明度 = 0.5 + (前沿 - 簇中点x) / 软边宽，
    // 颜色/透明度在未唱样与已唱样之间按该值插值——
    // 宿主渐变在簇内逐像素线性，簇中点取样即其均匀着色的精确均值。
    function __sweepPoses(): var {
        if (line.text.length === 0)
            return [];
        if (!line.hasWordTiming)
            return line.__flatPoses();
        const m = line.runMetrics;
        const graphemes = m ? m.graphemes : [];
        const bases = line.clusterBases;
        if (line.wordSpans.length === 0 || graphemes.length === 0 || bases.length === 0)
            return [];
        const list = [];
        const seen = new Set();
        const edge = line.edge, fade = line.fade;
        const darkA = line.dimColor.a, brightA = line.brightColor.a;
        for (let i = 0; i < graphemes.length; ++i) {
            const g = graphemes[i];
            const start = Number(g.clusterStart) || 0;
            if (seen.has(start))
                continue;
            seen.add(start);
            const x = (bases[i] ?? 0) + (Number(g.advance) || 0) / 2;
            const o = Math.min(1, Math.max(0, 0.5 + (edge - x) / fade));
            const alpha = darkA + (brightA - darkA) * o;
            if (alpha <= 0.004)
                continue;
            list.push({
                    "key": "line",
                    "start": start,
                    "y": line.__clusterLift(start),
                    "opacity": alpha,
                    "color": Qt.rgba(
                        line.dimColor.r + (line.brightColor.r - line.dimColor.r) * o,
                        line.dimColor.g + (line.brightColor.g - line.dimColor.g) * o,
                        line.dimColor.b + (line.brightColor.b - line.dimColor.b) * o,
                        1)
                });
        }
        return list;
    }

    onWordsChanged: __refreshGeometry()
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

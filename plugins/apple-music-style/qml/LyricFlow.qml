pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Effects
import EchoMusic.Controls
import EchoMusic.Theme
import EchoMusic.PluginSdk

// AMLL 风格歌词流：宿主 PlaybackLyricViewport 的时间轴（LyricTimeline）、
// 弹簧滚动（LyricSpring）与间奏点（LyricInterlude）行为在插件只读歌词模型
// 上的等价移植。只使用文档化的插件模块，不导入 EchoMusic.Playback。
Item {
    id: flow

    required property EchoPluginViewContext page

    // ---- 观感输入（Skin 接线旧版设置）----
    property real fontSize: 30
    property font baseFont: Theme.store.lyricBaseFont
    property font secondaryFont: Theme.store.lyricBaseFont
    property color textColor: "#ffffff"
    property color unplayedColor: "#ebffffff"
    // 背景均色估计（Skin 复刻宿主合成链算出）：渐变带切片色注入背景项
    property color backdropColor: "#000000"
    // v9 逐像素背景估计（Skin.backdropSample）；null 时 AmllLine 回退均色
    property var backdropSampler: null
    // 0..1，歌词对齐高度比例（旧设置 alignPosition/100）
    property real focusPosition: 0.48
    // 0..1，软边宽度系数（旧设置 fadeWidth/100）
    property real wordFade: 0.5
    property bool blurEnabled: true
    property bool scaleEnabled: true
    property bool springEnabled: true
    property real sublineOpacity: 0.56
    property real lineWidthAspect: 0.86
    property real pageHeight: height

    readonly property real secondaryFontSize: Math.max(10, fontSize * .5)
    readonly property real secondaryGap: fontSize * .3
    readonly property bool motion: Theme.store.motionEnabled
    readonly property bool softFocus: true
    readonly property bool staggerEnabled: true

    readonly property var player: page.player
    readonly property var info: page.player.lyricsInfo
    readonly property bool live: visible && page.active && Window.window !== null && Window.window.visible && Window.window.visibility !== Window.Minimized
    readonly property bool scrollable: live && info ? info.scrollable === true : false
    readonly property bool wantRomanization: live && info ? info.romanization === true : false
    readonly property bool wantTranslation: live && info ? info.translation === true : false
    readonly property real offsetMs: live && info ? Number(info.offsetMs) || 0 : 0

    // 时间源统一走 SDK samplePosition()（共享锚点的单调投影）：
    // 锚点 positionMs 与投影混写会相互回跳，造成每拍假 seek 重建
    property real renderTime: 0
    onRenderTimeChanged: flow.setTime(renderTime)
    onLiveChanged: {
        resume.stop();
        lines.initialized = false;
        if (live) {
            renderTime = page.player.samplePosition();
            lines.following = true;
            rebuild();
            scheduleUpdate(true, true, true);
        }
    }
    onHeightChanged: scheduleUpdate(false, false, true)
    onWidthChanged: scheduleUpdate(false, false, true)
    onFontSizeChanged: scheduleUpdate(false, false, true)
    onBaseFontChanged: scheduleUpdate(false, false, true)
    onSecondaryFontChanged: scheduleUpdate(false, false, true)
    onSecondaryGapChanged: scheduleUpdate(false, false, true)

    Connections {
        target: flow.page.player
        // 锚点推进（播放节拍/暂停拖动/seek 完成）都到这里；clockChanged 不逐拍通知
        function onPositionChanged(): void {
            if (flow && flow.live)
                flow.renderTime = flow.page.player.samplePosition();
        }
    }
    FrameAnimation {
        running: flow.live && flow.page.player.clock.isAdvancing === true && flow.scrollable
        onTriggered: flow.renderTime = flow.page.player.samplePosition()
    }

    // ---- 时间轴（LyricTimeline 移植）----
    property var __bounds: []
    property var __gaps: []
    property var __orders: []
    property real __maxEnd: 0
    property var __state: null
    property int revision: 0

    property int focusRow: -1
    property int latestRow: -1
    property int gapAnchorRow: -2
    property real gapStart: -1
    property real gapEnd: -1
    readonly property bool waiting: gapStart >= 0
    readonly property bool interlude: waiting && interludeAnim.available
    readonly property real interludeRowHeight: Math.max(fontSize * .5, Math.min(pageHeight * .01, fontSize * 3)) + fontSize * 1.6

    function __rowFor(order: int): int {
        return order >= 0 && order < __bounds.length ? __bounds[order].row : -1;
    }
    function ordinal(row: int): int {
        return row >= 0 && row < __orders.length ? __orders[row] : -1;
    }
    function activeRow(row: int): bool {
        if (!__state)
            return false;
        const i = ordinal(row);
        return i >= 0 && (__state.highlighted.has(i) || (i >= __state.focus && i < __state.latest));
    }
    function highlightedRow(row: int): bool {
        return __state ? __state.highlighted.has(ordinal(row)) : false;
    }
    function startAt(row: int): real {
        const i = ordinal(row);
        return i < 0 ? -1 : __bounds[i].start;
    }
    function previousRow(row: int): int {
        return __rowFor(ordinal(row) - 1);
    }
    function nextRow(row: int): int {
        return __rowFor(ordinal(row) + 1);
    }
    function rebuild(): void {
        const model = live ? page.player.lyrics : null;
        const offset = offsetMs;
        const bounds = [];
        const orders = [];
        if (model) {
            const count = model.rowCount();
            for (let i = 0; i < count; ++i)
                orders.push(-1);
            for (let row = 0; row < count; ++row) {
                const line = model.row(row);
                if (line.filtered === true)
                    continue;
                let start = Number(line.startMs) || 0;
                let end = start + (Number(line.durationMs) || 0);
                const words = line.words || [];
                if (words.length > 0) {
                    const first = words[0], last = words[words.length - 1];
                    const untimedSingle = words.length === 1 && Number(first.start_ms) === 0 && Number(first.duration_ms) === 0;
                    if (!untimedSingle) {
                        start = Number(first.start_ms) + offset;
                        end = Number(last.start_ms) + Number(last.duration_ms) + offset;
                    }
                }
                bounds.push({ "row": row, "start": start, "end": end });
            }
        }
        bounds.sort((a, b) => a.start - b.start);
        // 短时值碰撞是转写接缝而非对唱，只修剪呈现区间，词时间保持不变
        for (let i = 0; i < bounds.length; ++i) {
            for (let j = i + 1; j < bounds.length && bounds[j].start < bounds[i].end; ++j) {
                const overlap = bounds[i].end - bounds[j].start;
                if (overlap < 500 && (overlap <= 100 || overlap <= (bounds[j].end - bounds[j].start) * .1)) {
                    bounds[i].end = bounds[j].start;
                    break;
                }
            }
        }
        let groupStart = offset, groupEnd = offset, previousStart = offset, previousEnd = offset;
        for (let i = 0; i < bounds.length; ++i) {
            const bound = bounds[i];
            const rawStart = bound.start, rawEnd = bound.end;
            const overlapDuration = previousEnd - rawStart;
            const overlap = i > 0 && overlapDuration > 0;
            const lead = !overlap ? 600 : overlapDuration < 400 ? overlapDuration * .7 : 400;
            const boundary = i === 0 ? offset : overlap ? previousStart : groupEnd;
            bound.start = Math.min(rawStart, Math.max(boundary, rawStart - lead));
            if (i > 0 && rawStart < groupEnd && rawEnd > groupStart) {
                groupStart = Math.min(groupStart, rawStart);
                groupEnd = Math.max(groupEnd, rawEnd);
            } else {
                groupStart = rawStart;
                groupEnd = rawEnd;
            }
            previousStart = bound.start;
            previousEnd = rawEnd;
            orders[bound.row] = i;
        }
        const gaps = [];
        let end = offset;
        for (let i = 0; i < bounds.length; ++i) {
            if (bounds[i].start - end >= 7000)
                gaps.push({ "anchor": i - 1, "start": end, "end": bounds[i].start });
            end = Math.max(end, bounds[i].end);
        }
        __maxEnd = end;
        __bounds = bounds;
        __gaps = gaps;
        __orders = orders;
        __state = { "cursor": 0, "gapCursor": 0, "playing": new Set(), "highlighted": new Set(), "focus": 0, "latest": 0, "gap": -1, "time": 0 };
        reset(renderTime);
    }
    function __update(time: real, seek: bool): void {
        const s = __state, bounds = __bounds;
        const oldFocus = s.focus, oldGap = s.gap, oldLatest = s.latest;
        const oldHighlight = Array.from(s.highlighted).sort().join();
        let changed = seek;
        if (seek) {
            s.cursor = 0;
            s.gapCursor = 0;
            s.playing = new Set();
            s.highlighted = new Set();
            s.focus = 0;
        }
        while (s.gapCursor < __gaps.length && time >= __gaps[s.gapCursor].end)
            ++s.gapCursor;
        s.gap = s.gapCursor < __gaps.length && time >= __gaps[s.gapCursor].start ? s.gapCursor : -1;
        for (const i of Array.from(s.playing))
            if (bounds[i].end <= time)
                s.playing.delete(i);
        let added = false;
        while (s.cursor < bounds.length && bounds[s.cursor].start <= time) {
            if (bounds[s.cursor].end > time) {
                s.playing.add(s.cursor);
                added = true;
            }
            ++s.cursor;
        }
        if (seek) {
            // 与连续播放一致：在最近一个非空行的激活点重建跨行重叠
            let anchor = s.cursor - 1;
            while (anchor >= 0 && bounds[anchor].end <= bounds[anchor].start)
                --anchor;
            if (anchor >= 0) {
                for (let i = anchor; i >= 0; --i)
                    if (bounds[i].end > bounds[anchor].start)
                        s.highlighted.add(i);
                s.focus = s.highlighted.size > 0 ? Math.min(...s.highlighted) : anchor;
            }
        } else if (added) {
            s.highlighted = new Set(s.playing);
            s.focus = s.highlighted.size > 0 ? Math.min(...s.highlighted) : 0;
        }
        if ((s.gap >= 0 && s.playing.size === 0) || (bounds.length > 0 && time >= __maxEnd))
            s.highlighted = new Set();
        s.latest = s.highlighted.size > 0 ? Math.max(...s.highlighted) : s.focus;
        s.time = time;
        if (seek || oldHighlight !== Array.from(s.highlighted).sort().join() || oldFocus !== s.focus || oldGap !== s.gap || oldLatest !== s.latest)
            changed = true;
        if (changed)
            ++revision;
        // 与宿主时间轴 onChanged 一致：状态变化即安排间奏同步与跟随滚动
        if (changed)
            scheduleUpdate(true, false, false);
        focusRow = __rowFor(s.focus);
        latestRow = __rowFor(s.latest);
        gapAnchorRow = s.gap < 0 ? -2 : __rowFor(__gaps[s.gap].anchor);
        gapStart = s.gap < 0 ? -1 : __gaps[s.gap].start;
        gapEnd = s.gap < 0 ? -1 : __gaps[s.gap].end;
    }
    function setTime(time: real): void {
        if (!__state || !isFinite(time) || time === __state.time)
            return;
        __update(time, time < __state.time);
    }
    function reset(time: real): void {
        if (!isFinite(time))
            return;
        __update(time, true);
    }

    // ---- 更新调度（与视口一致：合并状态再测量新锚点）----
    property bool pendingInterludeSync: false
    property bool pendingInterludeReset: false
    property bool pendingImmediateFollow: false
    property bool seekingLayout: false
    function scheduleUpdate(sync: bool, reset: bool, immediate: bool): void {
        pendingInterludeSync = pendingInterludeSync || sync;
        pendingInterludeReset = pendingInterludeReset || reset;
        pendingImmediateFollow = pendingImmediateFollow || immediate;
        if (deferredUpdate)
            deferredUpdate.restart();
    }
    Timer {
        id: deferredUpdate
        interval: 0
        onTriggered: {
            const sync = flow.pendingInterludeSync;
            const resetFlag = flow.pendingInterludeReset;
            const immediate = flow.pendingImmediateFollow;
            flow.pendingInterludeSync = false;
            flow.pendingInterludeReset = false;
            flow.pendingImmediateFollow = false;
            if (resetFlag)
                flow.reset(flow.renderTime);
            if (sync)
                flow.syncInterlude(resetFlag);
            flow.seekingLayout = resetFlag;
            flow.follow(immediate);
            flow.seekingLayout = false;
        }
    }
    function syncInterlude(restart: bool): void {
        interludeAnim.configure(waiting ? gapStart : -1, waiting ? gapEnd : -1, renderTime, gapAnchorRow < 0, restart);
    }
    AmllInterlude {
        id: interludeAnim
        timeMs: flow.waiting && flow.live ? flow.renderTime : 0
    }
    Component.onCompleted: {
        // live 可能在完成时已为 true（不再触发 onLiveChanged），先采样一次
        renderTime = page.player.samplePosition();
        scheduleUpdate(true, true, true)
    }
    onWaitingChanged: scheduleUpdate(true, false, false)
    onGapStartChanged: scheduleUpdate(true, false, false)
    onGapEndChanged: scheduleUpdate(true, false, false)
    onInterludeChanged: scheduleUpdate(false, false, false)
    Connections {
        target: flow.page.player.lyrics
        function onDataChanged(): void {
            flow.rebuildFromModel();
        }
        function onModelReset(): void {
            flow.rebuildFromModel();
        }
        function onRowsInserted(): void {
            flow.rebuildFromModel();
        }
        function onRowsRemoved(): void {
            flow.rebuildFromModel();
        }
    }
    function rebuildFromModel(): void {
        resume.stop();
        rebuild();
        scheduleUpdate(true, true, true);
    }
    signal scrollRequested(real from, real destination, bool animate)

    // ---- 跟随滚动 ----
    function delayFor(index: int): real {
        // 只统计已实例化的行，按行数累加节拍，不按屏幕坐标折算
        const rows = lines.contentItem.children.filter(item => item.index !== undefined && item.pooled === false && item.y + item.height >= lines.contentY).sort((a, b) => ordinal(a.index) - ordinal(b.index));
        let delay = 0;
        let step = 50;
        for (const row of rows) {
            if (ordinal(row.index) >= ordinal(index))
                return delay;
            delay += step;
            if (ordinal(row.index) >= ordinal(focusRow))
                step /= 1.05;
        }
        return 0;
    }
    function follow(immediate: bool): void {
        if (!live || !lines.following || lines.count === 0 || lines.height <= 0)
            return;
        const target = Math.max(0, waiting ? nextRow(gapAnchorRow) : focusRow);
        const targetOrdinal = ordinal(target);
        const animate = !immediate && lines.initialized && Math.abs(targetOrdinal - lines.lastFollowIndex) <= 2 && motion;
        const previous = lines.contentY;
        const previousOrigin = lines.originY;
        lines.currentIndex = target;
        lines.forceLayout();
        let measured = lines.itemAtIndex(target);
        if (!measured) {
            lines.positionViewAtIndex(target, ListView.Center);
            lines.forceLayout();
            measured = lines.itemAtIndex(target);
        }
        if (!measured)
            return;
        lines.focusBlockHeight = measured.textRowHeight;
        // 高度不足时保持演唱文本居中，而不是连副文本一起居中导致亮行被裁
        const textAnchor = lines.height < measured.textRowHeight ? fontSize * .4 + measured.mainHeight / 2 : measured.textRowHeight / 2;
        const anchor = interlude ? measured.headerHeight / 2 : measured.headerHeight + textAnchor;
        const desired = measured.y + anchor - lines.focusCenter;
        lines.contentY = desired;
        lines.animateScroll = animate;
        // ListView 负责虚拟化与目标几何；每行独立跟踪目标，保留各自弹簧位置
        scrollRequested(previous + lines.originY - previousOrigin, desired, animate);
        lines.initialized = true;
        lines.lastFollowIndex = targetOrdinal;
    }
    function resumeFollow(): void {
        lines.following = true;
        resume.stop();
        scheduleUpdate(false, false, true);
    }
    signal settleMotion
    onMotionChanged: if (!motion)
        settleMotion()

    ListView {
        id: lines
        EchoWheelScroll.enabled: flow.live
        EchoWheelScroll.motionEnabled: flow.motion
        anchors.fill: parent
        clip: true
        reuseItems: true
        cacheBuffer: 200
        topMargin: height
        bottomMargin: height
        model: flow.live ? flow.page.player.lyrics : null
        boundsBehavior: Flickable.StopAtBounds
        currentIndex: -1
        keyNavigationEnabled: false
        highlightRangeMode: ListView.NoHighlightRange
        readonly property real focusCenter: height * flow.focusPosition
        property bool initialized: false
        property real focusBlockHeight: 0
        property int lastFollowIndex: -1
        property bool following: true
        property bool animateScroll: false
        onCountChanged: flow.scheduleUpdate(false, false, true)
        onMovementStarted: {
            following = false;
            resume.stop();
        }
        onMovementEnded: if (flow.scrollable)
            resume.restart()
        WheelHandler {
            blocking: false
            onWheel: event => {
                lines.following = false;
                if (flow.scrollable)
                    resume.restart();
                event.accepted = false;
            }
        }
        delegate: Item {
            id: line

            required property int index
            required property string lineText
            required property real startMs
            required property real durationMs
            required property bool wordTimed
            required property var words
            required property string translation
            required property string romanization
            required property bool filtered
            property bool pooled: false
            readonly property bool active: {
                const rev = flow.revision;
                return !flow.scrollable || flow.activeRow(index);
            }
            readonly property bool inViewport: !pooled && y + height >= Math.min(lines.contentY, scrollY) - 64 && y <= Math.max(lines.contentY, scrollY) + lines.height + 64
            readonly property real scrollY: scrollMotion.value
            property bool animatePosition: false
            property bool freshPosition: true
            readonly property real headerHeight: flow.interlude && index === flow.nextRow(flow.gapAnchorRow) ? flow.interludeRowHeight : 0
            readonly property real mainHeight: lyric.textHeight
            readonly property real textRowHeight: filtered ? 0 : mainHeight + (secondary.visible ? secondary.implicitHeight + flow.secondaryGap : 0) + flow.fontSize * .8
            onTextRowHeightChanged: if (positioned && !pooled && flow.live && lines.following)
                reflow.restart()
            property bool positioned: false
            property real previousY: 0
            property real previousHeader: 0
            property bool dotsPositioned: false
            onYChanged: {
                if (positioned && lines.initialized && !pooled) {
                    scrollMotion.shift(y - previousY);
                    dotMotion.shift(y - previousY);
                }
                previousY = y;
            }
            onHeaderHeightChanged: {
                if (positioned && lines.initialized && !pooled)
                    scrollMotion.shift(headerHeight - previousHeader);
                previousHeader = headerHeight;
                dotsPositioned = false;
            }
            AmllSpring {
                id: dotMotion
            }
            AmllSpring {
                id: scrollMotion
            }
            Component.onCompleted: {
                scrollMotion.snap(lines.contentY);
                dotMotion.snap(lines.contentY);
                previousY = y;
                previousHeader = headerHeight;
                positioned = true;
            }
            Connections {
                target: lines
                function onFollowingChanged(): void {
                    if (!lines.following) {
                        line.animatePosition = false;
                        scrollMotion.snap(lines.contentY);
                        dotMotion.snap(lines.contentY);
                    }
                }
            }
            Connections {
                target: flow
                function onSettleMotion(): void {
                    scrollMotion.snap(lines.contentY);
                    dotMotion.snap(lines.contentY);
                    lineMotion.settle();
                }
                function onScrollRequested(from: real, destination: real, animate: bool): void {
                    if (line.headerHeight > 0) {
                        if (!animate || !line.dotsPositioned)
                            dotMotion.snap(destination);
                        else
                            dotMotion.retarget(destination, 0, 0, flow.springEnabled);
                        line.dotsPositioned = true;
                    } else {
                        dotMotion.snap(destination);
                    }
                    if (!animate || line.pooled || !line.inViewport || line.freshPosition) {
                        line.animatePosition = false;
                        scrollMotion.snap(destination);
                    } else {
                        line.animatePosition = true;
                        const previous = flow.previousRow(flow.focusRow);
                        const interval = previous >= 0 ? flow.startAt(flow.focusRow) - flow.startAt(previous) : 0;
                        scrollMotion.retarget(destination, flow.waiting || flow.seekingLayout ? 0 : interval, flow.seekingLayout || !flow.staggerEnabled ? 0 : Math.round(flow.delayFor(line.index)), flow.springEnabled);
                    }
                    line.freshPosition = false;
                }
            }
            readonly property real distance: {
                const rev = flow.revision;
                const row = flow.ordinal(index), focus = flow.ordinal(flow.focusRow);
                return row < focus ? focus - row + 1 : Math.abs(row - flow.ordinal(flow.latestRow));
            }
            readonly property real lineOpacity: {
                const rev = flow.revision;
                return flow.highlightedRow(index) ? .85 : 1;
            }
            readonly property string secondaryText: [flow.wantRomanization ? romanization : "", flow.wantTranslation ? translation : ""].filter(value => value.length > 0).join("\n")
            width: lines.width
            height: filtered ? 0 : textRowHeight + headerHeight
            visible: !filtered
            ListView.onPooled: {
                pooled = true;
                freshPosition = true;
                animatePosition = false;
                scrollMotion.snap(lines.contentY);
                dotMotion.snap(lines.contentY);
                dotsPositioned = false;
                lineMotion.settle();
            }
            ListView.onReused: {
                freshPosition = true;
                animatePosition = false;
                scrollMotion.snap(lines.contentY);
                dotMotion.snap(lines.contentY);
                dotsPositioned = false;
                pooled = false;
                lineMotion.settle();
            }
            Loader {
                active: line.headerHeight > 0 && flow.live
                width: line.width
                height: line.headerHeight
                transform: Translate {
                    y: lines.following ? lines.contentY - dotMotion.value : 0
                }
                sourceComponent: Component {
                    Item {
                        objectName: "amllInterludeRow"
                        opacity: interludeAnim.opacity
                        // 呼吸缩放：水平原点锚定三点组左缘（= 文本对齐线），
                        // 呼吸只向右扩展，最大 1.25 倍时左缘也不越过歌词区；
                        // AMLL 的内容盒中心原点在最大档会左探 0.16×字号
                        transform: Scale {
                            origin.x: flow.fontSize
                            origin.y: line.headerHeight / 2
                            xScale: flow.motion ? interludeAnim.scaleFactor : 1
                            yScale: xScale
                        }
                        width: line.width
                        height: line.headerHeight
                        Repeater {
                            model: 3
                            Rectangle {
                                required property int index
                                x: flow.fontSize * (1 + index * .48)
                                y: flow.fontSize * .4 + (flow.interludeRowHeight - flow.fontSize * .8 - height) / 2
                                width: flow.fontSize * .3
                                height: width
                                radius: width / 2
                                color: flow.textColor
                                opacity: !flow.motion ? .9 : index === 0 ? interludeAnim.firstOpacity : index === 1 ? interludeAnim.secondOpacity : interludeAnim.thirdOpacity
                            }
                        }
                    }
                }
            }
            Item {
                objectName: "amllTextRow" + line.index
                y: line.headerHeight
                width: line.width
                height: line.textRowHeight
                transform: Translate {
                    y: lines.following ? lines.contentY - line.scrollY : 0
                }
                Rectangle {
                    objectName: "amllRowBackground"
                    anchors.fill: parent
                    radius: flow.fontSize * .25
                    color: Theme.withAlpha(flow.textColor, tap.pressed ? .03 : hover.hovered ? .07 : 0)
                }
                Item {
                    id: visual
                    x: flow.fontSize
                    y: flow.fontSize * .4
                    width: parent.width - flow.fontSize * 2
                    height: parent.height - flow.fontSize * .8
                    opacity: lineMotion.opacity
                    scale: lineMotion.scale
                    transformOrigin: Item.Left
                    readonly property real blurAmount: lineMotion.blur
                    AmllLineMotion {
                        id: lineMotion
                        activeLine: line.active
                        resourceActive: flow.live && !line.pooled
                        animationEnabled: line.inViewport && flow.motion
                        springEnabled: flow.springEnabled && !line.freshPosition
                        shrinkInactive: flow.scaleEnabled && flow.player.playing
                        blurInactive: flow.softFocus && flow.blurEnabled && lines.following
                        inactiveBlur: Math.min(5, (1 + line.distance) * (flow.width <= 1024 ? .8 : 1))
                        targetOpacity: line.lineOpacity
                    }
                    layer.enabled: flow.live && line.inViewport && visual.blurAmount > .01
                    layer.effect: MultiEffect {
                        blurEnabled: true
                        blurMax: 12
                        blur: visual.blurAmount / 12
                        autoPaddingEnabled: true
                    }
                    AmllLine {
                        id: lyric
                        x: 0
                        y: 0
                        width: visual.width * flow.lineWidthAspect
                        height: implicitHeight
                        text: line.lineText
                        words: line.wordTimed ? line.words.map(word => ({
                                    "text": String(word.text ?? ""),
                                    "t0": Number(word.start_ms) || 0,
                                    "t1": Number(word.start_ms) + Number(word.duration_ms) || 0
                                })) : []
                        timeMs: (line.active || lineMotion.highlight > .001) && line.inViewport && flow.live ? flow.renderTime - flow.offsetMs : -1
                        current: line.active || lineMotion.highlight > .001
                        highlightAmount: lineMotion.highlight
                        font: flow.baseFont
                        playedColor: flow.textColor
                        unplayedColor: flow.unplayedColor
                        backdropColor: flow.backdropColor
                        backdropAt: flow.backdropSampler ? (x, y) => flow.backdropSampler(lyric, x, y) : null
                        fadeWidth: flow.wordFade
                        animateWords: flow.scaleEnabled && flow.motion
                    }
                    Label {
                        id: secondary
                        y: line.mainHeight + flow.secondaryGap
                        width: parent.width
                        visible: text.length > 0
                        text: line.secondaryText
                        textFormat: Text.PlainText
                        wrapMode: Text.Wrap
                        lineHeightMode: Text.FixedHeight
                        lineHeight: flow.secondaryFontSize * 1.5
                        font: flow.secondaryFont
                        color: flow.textColor
                        opacity: flow.sublineOpacity
                    }
                    HoverHandler {
                        id: hover
                    }
                    TapHandler {
                        id: tap
                        enabled: flow.scrollable && line.lineOpacity > 0
                        acceptedButtons: Qt.LeftButton
                        gesturePolicy: TapHandler.DragThreshold
                        onTapped: line.jumpToLine()
                    }
                }
            }
            function jumpToLine(): void {
                if (!flow.live || line.pooled || !tap.enabled)
                    return;
                // 模型行时间含偏移；跳转到不可变的演唱时间戳
                const sourceTime = line.wordTimed && line.words.length > 0 ? line.words[0].start_ms : line.startMs - flow.offsetMs;
                if (!Number.isFinite(sourceTime))
                    return;
                lines.cancelFlick();
                lines.following = true;
                resume.stop();
                flow.page.command("seek", {
                    "value": Math.max(0, Math.round(sourceTime)),
                    "revision": flow.page.player.revision
                });
                if (!flow.player.playing)
                    flow.page.command("toggle");
                flow.follow(false);
            }
            Accessible.role: flow.scrollable ? Accessible.Button : Accessible.StaticText
            Accessible.name: line.lineText
            Accessible.onPressAction: line.jumpToLine()
        }
    }
    Connections {
        target: lines.currentItem
        function onYChanged(): void {
            reconcile.restart();
        }
    }
    Timer {
        id: reconcile
        interval: 0
        onTriggered: flow.follow(!lines.animateScroll)
    }
    Timer {
        id: reflow
        interval: 0
        onTriggered: flow.follow(true)
    }
    Timer {
        id: resume
        objectName: "amllFollowResume"
        interval: 3000
        onTriggered: {
            if (!flow.scrollable)
                return;
            lines.following = true;
            flow.follow(false);
        }
    }
    Label {
        anchors.centerIn: parent
        visible: lines.count === 0
        text: flow.info && flow.info.state === "loading" ? qsTr("正在加载歌词…") : flow.info && flow.info.state === "error" ? qsTr("歌词加载失败") : qsTr("暂无歌词")
        color: flow.unplayedColor
        font: flow.secondaryFont
    }
}

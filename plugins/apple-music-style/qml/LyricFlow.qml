pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import EchoMusic.Theme
import EchoMusic.PluginSdk
import "amll"
import "amll/base/player.mjs" as AmlPlayer

// AMLL 风格歌词页（宿主适配器）。参照 AMLL 完全重构后的形态：
// - 编排核心 LyricPlayerCore（qml/amll/base/*.mjs，纯 JS 移植自 AMLL
//   base/）在此创建并持有：时间线生命周期（唱完不熄灭）、排版布局
//   （对齐位置/滚动边界/视口剔除）、滚动交互引擎（触摸意图/惯性/滚轮
//   空闲/500ms 自动回归）、间奏点演出状态机、SeekDetector。
// - 渲染由 AmlLyricView（qml/amll/）消费核心指令：绝对定位 + posY/
//   scale 解析解弹簧 + AMLL 语义透明度/模糊/亮度层。
// - 本文件只做宿主桥接：时间源（samplePosition 单调投影）、歌词模型
//   （只读行模型 → LyricLineData 规范形状）、Skin 设置透传、点击跳转。
// 与 AMLL 的差异（宿主形态决定）：
// - 时间来自 SDK samplePosition() 的锚点节拍（暂停拖动/seek 完成也推送），
//   在此做平滑单调投影后喂给编排核心（见 mediaTime 属性注释），真实跳转
//   经 seek 事件/大步进透传，SeekDetector 语义与 AMLL 一致。
// - 歌词偏移（offsetMs）不进词时间（与旧实现一致）：行时间偏移进
//   startTime/endTime，扫掠时间 = 媒体时间 − 偏移（词时间保持原始值）。
// - 不做背景人声行/不雅词掩码/底部提示行（无输入源）。
Item {
    id: flow

    required property EchoPluginViewContext page

    // ---- 观感输入（Skin 接线旧版设置，名称保持不变）----
    property real fontSize: 30
    property font baseFont: Theme.store.lyricBaseFont
    property font secondaryFont: Theme.store.lyricBaseFont
    property color textColor: "#ffffff"
    property color unplayedColor: "#ebffffff"
    // 背景均色估计（Skin 复刻宿主模糊封面合成链算出）：扫掠切片色注入背景项
    property color backdropColor: "#000000"
    // v10 逐像素背景估计（Skin.backdropSample）；null 时行视图回退均色
    property var backdropSampler: null
    // 0..1，歌词对齐高度比例（AMLL alignPosition，默认 0.35）
    property real focusPosition: 0.35
    // 0..1，软边宽度系数（AMLL wordFadeWidth）
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

    readonly property var player: page.player
    readonly property var info: page.player.lyricsInfo
    readonly property bool live: visible && page.active && Window.window !== null && Window.window.visible && Window.window.visibility !== Window.Minimized
    readonly property bool scrollable: live && info ? info.scrollable === true : false
    readonly property bool wantRomanization: live && info ? info.romanization === true : false
    readonly property bool wantTranslation: live && info ? info.translation === true : false
    readonly property real offsetMs: live && info ? Number(info.offsetMs) || 0 : 0
    readonly property bool playing: player.playing

    // 媒体时间（SDK samplePosition() 的平滑单调投影）。宿主锚点按音频
    // 后端节拍推送，值量化在 ~250ms 网格上且锚点之间读数不连续（外推被
    // 每次观测重置），逐拍直喂会让 SeekDetector 在节拍处看到远超 150ms
    // 抖动容差的假漂移/假回退 → calcLayout(Seek) → setInterlude(forceReset)
    // → 间奏点每拍重锚，「出现一帧即消失」（2026-11-15 实测根因）。
    // 此处从最近锚点做墙钟外推 + 限速追赶 + 单调钳制（SeekDetector 把任何
    // 回退都视为跳转）；真实跳转（seek 事件 / 大步进 / 暂停拖动）一步透传。
    property real mediaTime: 0
    onMediaTimeChanged: flow.pushTime()
    // ---- 投影状态（仅由 __ingestAnchor/__projectTick/__projResetToCurrent 维护）----
    property bool __projAnchored: false // 已有有效锚点
    property real __projAnchorMedia: 0 // 最近锚点媒体时间
    property real __projAnchorWall: 0 // 最近锚点墙钟（Date.now）
    property real __projPushed: 0 // 最近推送值（单调基准）
    property real __projPushedWall: 0 // 最近推送墙钟
    property bool __projSeekPending: false // 收到 seek 事件后的首拍透传标记
    // 外推上限（锚点后最多外推的媒体毫秒数）：缓冲停滞时不无限超前，
    // 同时限定锚点回跳的最大吸收幅度
    readonly property real __projMaxLeadMs: 500
    // 追赶限速：每墙钟毫秒最多推进的媒体毫秒。2 倍速消化量化台阶时单帧
    // 漂移 ≤ 帧间隔（~16ms），远低于 SeekDetector 的 150ms 抖动容差
    readonly property real __projCatchUpRate: 2
    // 透传阈值：推送值与锚点偏差超过此值视为真实跳转（seek 事件之外的兜底，
    // 如切歌/远端同步；阈值需大于外推上限 + 台阶宽度）
    readonly property real __projSeekToleranceMs: 600
    property int rawRowCount: 0
    // 编排核心（LyricPlayerCore，纯 JS 对象）
    property var core: null

    onPlayingChanged: flow.applyPlaying()
    onLiveChanged: {
        if (!core)
            return;
        if (live) {
            // 页面挂起恢复：时钟重锚 + 丢弃跳转检测基线（挂起期间音频可能
            // 仍在播放，恢复首帧推送间隔远超信任跨度会被误判为跳转）
            core.setPageVisible(true);
            core.seekDetectorInvalidateBaseline();
            flow.__projResetToCurrent();
            rebuild();
        } else {
            core.setPageVisible(false);
        }
    }
    onWidthChanged: if (core)
        core.setSize(width, height)
    onHeightChanged: if (core)
        core.setSize(width, height)
    onFontSizeChanged: flow.syncConfig()
    onFocusPositionChanged: flow.syncConfig()
    onWordFadeChanged: flow.syncConfig()
    onBlurEnabledChanged: flow.syncConfig()
    onScaleEnabledChanged: flow.syncConfig()
    onSpringEnabledChanged: flow.syncConfig()
    onOffsetMsChanged: flow.rebuild()

    Component.onCompleted: {
        createCore();
        flow.__projResetToCurrent();
        applyPlaying();
        rebuild();
    }
    function createCore(): void {
        const c = new AmlPlayer.LyricPlayerCore({
                "onGroupsChanged": () => lyricView.notifyGroupsChanged()
            });
        c.setAlignPosition(focusPosition);
        c.setEnableBlur(blurEnabled);
        c.setEnableScale(scaleEnabled);
        c.setEnableSpring(springEnabled);
        c.setWordFadeWidth(wordFade);
        c.setBaseFontSize(fontSize);
        c.setSize(width, height);
        // AMLL 默认弹簧参数：posY 质量 0.9（区间策略在此基础上调 k/c），
        // 行缩放 m2/d25/k100
        c.setLinePosYSpringParams({
                "mass": 0.9,
                "damping": 15,
                "stiffness": 90
            });
        c.setLineScaleSpringParams({
                "mass": 2,
                "damping": 25,
                "stiffness": 100
            });
        core = c;
        lyricView.core = c;
    }
    function syncConfig(): void {
        if (!core)
            return;
        core.setAlignPosition(focusPosition);
        core.setEnableBlur(blurEnabled);
        core.setEnableScale(scaleEnabled);
        core.setEnableSpring(springEnabled);
        core.setWordFadeWidth(wordFade);
        core.setBaseFontSize(fontSize);
    }
    function applyPlaying(): void {
        if (!core)
            return;
        // 暂停停演（间奏点冻结、非活动行恢复原大）与恢复
        if (playing) {
            core.resume();
            // 恢复播放：投影重锚（暂停间隔不得计入外推与追赶预算，否则
            // 恢复首帧会把整段暂停时长外推成媒体时间）
            if (__projAnchored) {
                const now = Date.now();
                __projAnchorMedia = Math.max(page.player.samplePosition(), __projPushed);
                __projAnchorWall = now;
                __projPushedWall = now;
            }
        } else {
            core.pause();
        }
    }
    function pushTime(): void {
        if (core)
            core.setCurrentTime(Math.round(mediaTime));
    }
    // ---- 媒体时间投影（见 mediaTime 属性注释）----
    // 投影状态整体重置到当前锚点：页面恢复/初建时用，mediaTime 直接落值
    //（此时跳转检测基线已被丢弃或尚未建立，回退无副作用）
    function __projResetToCurrent(): void {
        const now = Date.now();
        const raw = page.player.samplePosition();
        __projAnchored = true;
        __projAnchorMedia = raw;
        __projAnchorWall = now;
        __projPushed = raw;
        __projPushedWall = now;
        __projSeekPending = false;
        if (mediaTime !== raw)
            mediaTime = raw;
    }
    // 锚点节拍入口（onPositionChanged）：平滑路径只重锚不推送——推进由
    // 帧循环限速追赶承担，节拍直推会把量化台阶原样喂给 SeekDetector
    function __ingestAnchor(): void {
        if (!core)
            return;
        const now = Date.now();
        const raw = page.player.samplePosition();
        if (!playing || !Number.isFinite(raw)) {
            // 暂停：拖动/seek 直通（回退即真实跳转，保持检测语义）
            __projSeekPending = false;
            __projPassThrough(raw, now);
            return;
        }
        const seekPass = __projSeekPending || !__projAnchored
            || raw - __projPushed > __projSeekToleranceMs
            || __projPushed - raw > __projSeekToleranceMs;
        __projSeekPending = false;
        if (seekPass) {
            // 真实跳转一步透传（SeekDetector 需要在单次推送里看到大步进）
            __projPassThrough(raw, now);
            return;
        }
        __projAnchorMedia = raw;
        __projAnchorWall = now;
        __projAnchored = true;
    }
    function __projPassThrough(raw, now): void {
        __projAnchorMedia = raw;
        __projAnchorWall = now;
        __projAnchored = true;
        __projPushed = raw;
        __projPushedWall = now;
        if (mediaTime !== raw)
            mediaTime = raw;
    }
    // 播放速率（speed ≤ 0 视为无效回退 1）
    function __projRate(): real {
        const s = Number(player.speed);
        return Number.isFinite(s) && s > 0 ? s : 1;
    }
    // 帧循环（FrameAnimation）：从最近锚点外推并限速追赶，永不回退
    function __projectTick(): void {
        if (!core || !playing || !__projAnchored)
            return;
        const now = Date.now();
        const gap = Math.max(0, now - __projPushedWall);
        __projPushedWall = now;
        const lead = Math.min((now - __projAnchorWall) * __projRate(), __projMaxLeadMs);
        let next = __projAnchorMedia + lead;
        const budget = __projPushed + gap * __projCatchUpRate;
        if (next > budget)
            next = budget;
        if (next <= __projPushed)
            return;
        __projPushed = next;
        mediaTime = next;
    }
    function rebuild(): void {
        const lines = collectLines();
        rawRowCount = live && player.lyrics ? player.lyrics.rowCount() : 0;
        if (!core)
            return;
        core.setLyricLines(lines, Math.round(mediaTime));
    }
    function rebuildFromModel(): void {
        rebuild();
    }
    // 只读歌词模型 → AMLL LyricLineData 规范形状。
    // - filtered 行跳过
    // - 逐词行：startTime/endTime = 首末词时间 + 偏移；words 保持原始
    //   时间（扫掠侧用媒体时间−偏移对齐，见文件头差异说明）
    // - 非逐词行：行时间原样（模型行时间含偏移），words 为空（整行
    //   SOLID 点亮路径）
    // - 单词零时值行回退行边界（转写占位词）
    // - seekTime：不含偏移的演唱时间戳（点击跳转用）
    function collectLines(): var {
        const model = live ? player.lyrics : null;
        const out = [];
        if (!model)
            return out;
        const offset = offsetMs;
        const count = model.rowCount();
        for (let row = 0; row < count; ++row) {
            const line = model.row(row);
            if (line.filtered === true)
                continue;
            let start = Number(line.startMs) || 0;
            let end = start + (Number(line.durationMs) || 0);
            let seekTime = start - offset;
            const words = [];
            const rawWords = line.words || [];
            if (line.wordTimed === true && rawWords.length > 0) {
                const untimedSingle = rawWords.length === 1 && Number(rawWords[0].start_ms) === 0 && Number(rawWords[0].duration_ms) === 0;
                if (!untimedSingle) {
                    const first = rawWords[0], last = rawWords[rawWords.length - 1];
                    start = Number(first.start_ms) + offset;
                    end = Number(last.start_ms) + Number(last.duration_ms) + offset;
                    seekTime = Number(first.start_ms);
                }
                for (let i = 0; i < rawWords.length; ++i) {
                    const w = rawWords[i];
                    words.push({
                            "startTime": Number(w.start_ms) || 0,
                            "endTime": (Number(w.start_ms) || 0) + (Number(w.duration_ms) || 0),
                            "word": String(w.text ?? "")
                        });
                }
            }
            out.push({
                    "startTime": start,
                    "endTime": end,
                    // 行文本（AMLL 由 words[].word 拼接，宿主模型直接提供；
                    // 非逐词行 words 为空，文本只能来自此处）
                    "text": String(line.lineText ?? ""),
                    "words": words,
                    "translation": String(line.translation ?? ""),
                    "romanization": String(line.romanization ?? ""),
                    "seekTime": Math.max(0, seekTime)
                });
        }
        return out;
    }
    function seekToGroup(groupIndex: int): void {
        if (!live || !core)
            return;
        const data = core.getLyricLines()[groupIndex];
        if (!data || !Number.isFinite(data.seekTime))
            return;
        page.command("seek", {
                "value": Math.max(0, Math.round(data.seekTime)),
                "revision": page.player.revision
            });
        if (!page.player.playing)
            page.command("toggle");
    }

    Connections {
        target: flow.page.player
        // 锚点推进（播放节拍/暂停拖动/seek 完成）都到这里；clockChanged 不逐拍通知
        function onPositionChanged(): void {
            if (flow && flow.live)
                flow.__ingestAnchor();
        }
        // 显式跳转完成先于对应 positionChanged 到达：置透传标记，让下一次
        // 锚点直通（engine 的 seeked 事件 → seekCompleted → eventOccurred("seek")）
        function onEventOccurred(kind, payload): void {
            if (kind === "seek")
                flow.__projSeekPending = true;
        }
    }
    FrameAnimation {
        // 播放时钟推进的媒体时间刷新（暂停时不推进；滚轮/拖拽滚动由
        // 编排核心的滚动引擎自闭环处理）
        running: flow.live && flow.page.player.clock.isAdvancing === true && flow.scrollable
        onTriggered: flow.__projectTick()
    }
    Connections {
        target: flow.live ? flow.page.player.lyrics : null
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
    AmlLyricView {
        id: lyricView
        anchors.fill: parent
        flow: flow
    }
    Label {
        anchors.centerIn: parent
        visible: flow.rawRowCount === 0
        text: flow.info && flow.info.state === "loading" ? qsTr("正在加载歌词…") : flow.info && flow.info.state === "error" ? qsTr("歌词加载失败") : qsTr("暂无歌词")
        color: flow.unplayedColor
        font: flow.secondaryFont
    }
}

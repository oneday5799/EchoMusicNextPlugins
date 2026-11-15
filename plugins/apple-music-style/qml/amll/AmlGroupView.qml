pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Effects
import EchoMusic.Theme

// AMLL 歌词组视图（对应 dom/lyric-group.ts + lyric-line.ts 的变换接线）。
// 消费 base 的 LyricLineGroupCore 指令：每帧 commitFrame() 把纵向弹簧位置、
// 行缩放弹簧位置落到 item 上；离散目标（组透明度/模糊/高亮量）在 revision
// 变化时更新，由 Behavior 按 AMLL 的过渡时长动画（wrapper opacity 0.4s、
// filter blur 0.4s、亮层点亮 0.3s / 熄灭 0.45s ease-out）。
// 几何 = AMLL wrapper padding（0.4em 1em）+ 主行 + 副行（翻译/音译，
// 间距 0.3em，行高 1.5×副字号，透明度 sublineOpacity）。
// 测量结果经 core.setGroupMeasured 上报（与 AMLL DOM 的 ResizeObserver 等价）。
Item {
    id: group

    required property int index
    // 外层 AmlLyricView（property var 避免循环类型引用）
    property var view
    readonly property var flow: view.flow
    // 组核心状态（LyricLineGroupCore；组数组只在重建时整体替换，此绑定
    // 在 delegate 创建时求值一次即可）
    readonly property var groupCore: view.core && view.core.currentLyricGroups.length > index ? view.core.currentLyricGroups[index] : null
    readonly property real em: flow.fontSize

    // ---- 尺寸（自然内容高度，上报给布局计算器）----
    readonly property real mainHeight: mainView.textHeight
    readonly property string secondaryText: [flow.wantRomanization ? modelRomanization : "", flow.wantTranslation ? modelTranslation : ""].filter(value => value.length > 0).join("\n")
    readonly property bool secondaryVisible: secondaryText.length > 0
    readonly property real naturalHeight: em * 0.8 + mainHeight + (secondaryVisible ? flow.secondaryGap + secondaryView.implicitHeight : 0)
    width: view.width
    height: naturalHeight

    // 副文本取自核心行数据（LyricLineData.translation/romanization）
    readonly property string modelRomanization: groupCore ? String(groupCore.mainLine.line.romanization ?? "") : ""
    readonly property string modelTranslation: groupCore ? String(groupCore.mainLine.line.translation ?? "") : ""

    // ---- 离散视觉目标（commitFrame 按revision 变化写入，Behavior 动画）----
    property real opacityTarget: 0
    property real blurTarget: 0
    property real highlightTarget: 0
    property int highlightDuration: 450

    opacity: opacityTarget
    Behavior on opacity {
        // AMLL wrapper CSS transition opacity 0.4s
        NumberAnimation {
            duration: 400
            easing.type: Easing.OutQuad
        }
    }
    property real blur: blurTarget
    Behavior on blur {
        // AMLL wrapper CSS transition filter 0.4s
        NumberAnimation {
            duration: 400
            easing.type: Easing.OutQuad
        }
    }
    property real highlight: highlightTarget
    Behavior on highlight {
        // AMLL 亮度层：点亮 300ms / 熄灭 450ms ease-out（写入目标前先设时长）
        NumberAnimation {
            duration: group.highlightDuration
            easing.type: Easing.OutQuad
        }
    }

    // 远行模糊走组级 layer.effect（MultiEffect），等价 AMLL 对整个行包装盒
    // （含副行）施加 CSS filter blur 的语义。不走 GlyphPose.blur：宿主 pose
    // quad = inkBounds ± (blur×3+2)（GlyphRun.cpp:2247），而模糊档位的实际
    // 烘焙支撑 ≈ 3×qRound(8×density)/density ≈ blur×3.6（dpr1.25 时 28.8px
    // vs 22.6px）——mask 尾部在 quad 边缘仍非零，被 quad 几何硬切成贯穿行宽
    // 的直边亮带（2026-11-15 实测「已播放行辉光有明显边界」根因）。层模糊的
    // 衰减自然收敛，无结构性直边。
    // 钳制与增益：AMLL base 端 blur = 1+distance（已播行 +1）不封顶，钳制
    // min(5,·) 在 DOM 渲染端（lyric-group.ts:184）——在此复刻同语义，避免远
    // 行无界。CSS blur(B) 的 σ = B/2；MultiEffect 的核虽标称 radius =
    // blur×blurMax，但同标称值的视觉溶解宽度远窄于 CSS 高斯（2026-11-15
    // 实测 1:1 映射被评「太弱且各行无梯度」），×2.5 增益恢复 CSS px 观感。
    layer.enabled: group.blur > 0.02
    layer.smooth: true
    layer.effect: MultiEffect {
        blurEnabled: true
        blurMax: 16
        blur: Math.min(5, group.blur) * 2.5 / 16
    }
    Rectangle {
        objectName: "amllGroupBackground" + group.index
        anchors.fill: parent
        radius: group.em * 0.25
        opacity: group.edgeFade
        // 悬停提示底色。不取 tap.pressed 分支：DragThreshold 策略的 TapHandler
        // 经 passive grab 会让 pressed 长时间为真（2026-11-15 实测所有组同时
        // 显示 3% 底色面板、出现明显边界），且按压反馈本就难以察觉
        color: Theme.withAlpha(flow.textColor, hover.hovered ? 0.07 : 0)
    }
    Item {
        id: inner
        x: group.em
        y: group.em * 0.4
        // 视口边缘渐隐（commitFrame 逐帧落盘）：触及视口边界前先降为 0，
        // 消除 clip 硬切分界线
        opacity: group.edgeFade
        width: group.width - group.em * 2
        height: group.naturalHeight - group.em * 0.8
        // 行缩放弹簧（非活动行播放中 97%，AMLL .lyricLine transform 语义）
        scale: 1
        transformOrigin: Item.Left
        AmlLineView {
            id: mainView
            x: 0
            y: 0
            width: inner.width * flow.lineWidthAspect
            height: implicitHeight
            text: groupCore ? String(groupCore.mainLine.line.text ?? "") : ""
            words: groupCore && groupCore.mainLine.line.words ? groupCore.mainLine.line.words.map(word => ({
                        "text": String(word.word ?? word.text ?? ""),
                        "t0": Number(word.startTime) || 0,
                        "t1": Number(word.endTime) || 0
                    })) : []
            timeMs: group.sweepTime
            // 常走媒体时钟：强调包络与上浮倒放（不随行失活/暂停遮罩冻结）
            animTimeMs: flow.mediaTime - flow.offsetMs
            disabledAt: group.disabledAt
            enabledAt: group.enabledAt
            current: group.groupCore ? group.groupCore.mainLine.isEnabled || group.highlight > 0.001 : false
            highlightAmount: group.highlight
            blurAmount: group.blur
            nonDynamicLyric: view.core ? view.core.isNonDynamic : false
            font: flow.baseFont
            playedColor: flow.textColor
            unplayedColor: flow.unplayedColor
            backdropColor: flow.backdropColor
            backdropAt: flow.backdropSampler ? __backdropAt : null
            // 4px 量化视口锚点（组 spring 位置即视口 y）：滚动/跟随移动超过
            // 步长即重烘焙雾色
            poseAnchor: Math.round(group.y * 0.25)
            fadeWidth: flow.wordFade
            animateWords: flow.scaleEnabled && flow.motion
        }
        Label {
            id: secondaryView
            y: group.mainHeight + flow.secondaryGap
            width: parent.width
            visible: group.secondaryVisible
            text: group.secondaryText
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            lineHeightMode: Text.FixedHeight
            lineHeight: flow.secondaryFontSize * 1.5
            font: flow.secondaryFont
            color: flow.textColor
            opacity: flow.sublineOpacity
        }
    }
    HoverHandler {
        id: hover
    }
    TapHandler {
        id: tap
        enabled: flow.scrollable && group.opacityTarget > 0
        acceptedButtons: Qt.LeftButton
        gesturePolicy: TapHandler.DragThreshold
        onTapped: flow.seekToGroup(group.index)
    }
    Accessible.role: flow.scrollable ? Accessible.Button : Accessible.StaticText
    Accessible.name: groupCore ? String(groupCore.mainLine.line.text ?? "") : ""
    Accessible.onPressAction: if (tap.enabled)
        flow.seekToGroup(group.index)

    onNaturalHeightChanged: reportMeasure()
    onWidthChanged: reportMeasure()
    Component.onCompleted: {
        lastRevision = -1
        lastLineRevision = -1
        reportMeasure()
    }
    function reportMeasure(): void {
        // 与 AMLL DOM 的 ResizeObserver 等价：测得自然高度即上报
        if (view.core && view.core.currentLyricGroups.length > index && naturalHeight > 0)
            view.core.setGroupMeasured(index, width, naturalHeight)
    }
    // 逐位置背景估计回调。注意不可写成绑定内联箭头函数：QML V4 引擎
    // （Qt 6.12）对绑定内箭头不做组件作用域捕获，调用时 flow/mainView 均
    // 解析为 undefined 并抛 TypeError，poses 绑定整体中断 → 行无 pose 不渲染
    // （2026-11-13 实测根因）。方法函数的作用域在定义处绑定，不受影响。
    function __backdropAt(x: real, y: real): var {
        return flow.backdropSampler(mainView, x, y)
    }
    // 每帧提交：读弹簧当前值 + revision 变化检测（由 AmlLyricView 的帧循环驱动）
    function commitFrame(): void {
        const g = group.groupCore;
        if (!g)
            return;
        // 纵向位置与行缩放：弹簧当前值逐帧落盘
        group.y = g.posY.getCurrentPosition();
        inner.scale = g.mainLine.scaleSpring.getCurrentPosition() / 100;
        // 视口边缘渐隐：上侧以组顶缘为锚（最先被视口裁掉的部分），下侧以
        // 底缘对称——顶/底缘进入边缘带（edgeBand）时整体线性降至 0，触及
        // 视口边界前已完全隐藏，clip 硬切分界线不再出现
        const vh = view.height;
        const band = view.edgeBand;
        edgeFade = band > 0 ? Math.min(1,
            Math.max(0, group.y / band),
            Math.max(0, (vh - group.y - group.height) / band)) : 1;
        // 离散目标：revision 变化时应用
        if (g.revision !== lastRevision) {
            lastRevision = g.revision;
            group.opacityTarget = g.opacity;
            group.blurTarget = g.blur;
            const newHighlight = g.isActive ? 1 : 0;
            group.highlightDuration = newHighlight > group.highlightTarget ? 300 : 450;
            group.highlightTarget = newHighlight;
        }
        // 扫掠时间：启用且播放中跟随媒体时间；暂停/停用冻结在当前值
        //（AMLL WAAPI 动画随媒体时钟推进、暂停即冻结；disable 后冻结边沿
        // 配合高亮量衰减回到 SOLID 静息态）。重新启用（revision 变化）时
        // 重锚到当前媒体时间
        const ml = g.mainLine;
        if (ml.revision !== lastLineRevision) {
            lastLineRevision = ml.revision;
            // 行重建：等待下一次启用沿再起跑字符动画（AMLL 重建后同样
            // 处于未启用态，enable 时才 setCurrentTime 起跑）
            enabledAt = -1;
            if (ml.isEnabled)
                sweepTime = flow.mediaTime - flow.offsetMs;
        }
        if (ml.isEnabled && flow.playing)
            sweepTime = flow.mediaTime - flow.offsetMs;
        // 启用沿捕获：强调包络仅在行启用后起跑（未启用的 upcoming 行不浮起）。
        // 失活不清除——失活后包络继续自然播完（AMLL disable 不动辉光动画）
        if (ml.isEnabled && enabledAt < 0)
            enabledAt = flow.mediaTime - flow.offsetMs;
        // 行失活捕获：冻结的 sweepTime 即失活媒体时刻，供 AmlLineView 倒放
        // 持久上浮（AMLL disable 的 float playbackRate=-1 语义）。建给已失活
        // 行的 delegate（sweepTime 尚未锚定）以 10s 前兜底——倒放视为已走完
        if (ml.isEnabled) {
            disabledAt = -1;
        } else if (disabledAt < 0) {
            disabledAt = sweepTime >= 0 ? sweepTime : flow.mediaTime - flow.offsetMs - 10000;
        }
        // 视口外剔除（含边缘渐隐至 0 的组）
        group.visible = (group.opacityTarget > 0.005 || group.opacity > 0.005) && edgeFade > 0.005;
    }
    // 视口边缘渐隐系数（0-1）；由 commitFrame 逐帧落盘
    property real edgeFade: 1
    property real sweepTime: -1
    // 行失活媒体时刻（<0 = 在唱）；由 commitFrame 沿检测捕获
    property real disabledAt: -1
    // 行首次启用媒体时刻（<0 = 尚未启用）；重建后复位，等待启用沿
    property real enabledAt: -1
    property int lastRevision: -1
    property int lastLineRevision: -1
}

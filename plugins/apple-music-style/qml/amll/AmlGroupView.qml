pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
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

    Rectangle {
        objectName: "amllGroupBackground" + group.index
        anchors.fill: parent
        radius: group.em * 0.25
        color: Theme.withAlpha(flow.textColor, tap.pressed ? 0.03 : hover.hovered ? 0.07 : 0)
    }
    Item {
        id: inner
        x: group.em
        y: group.em * 0.4
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
            if (ml.isEnabled)
                sweepTime = flow.mediaTime - flow.offsetMs;
        }
        if (ml.isEnabled && flow.playing)
            sweepTime = flow.mediaTime - flow.offsetMs;
        // 视口外剔除
        group.visible = group.opacityTarget > 0.005 || group.opacity > 0.005;
    }
    property real sweepTime: -1
    property int lastRevision: -1
    property int lastLineRevision: -1
}

pragma ComponentBehavior: Bound
import QtQuick

// AMLL 间奏点视图（对应 dom/interlude-dots.ts 的渲染端）。
// 消费 base InterludeDots 的逐帧快照（getSnapshot）与 posY 弹簧。
// 几何对齐 AMLL CSS：三点盒 padding 0.4em 1em，圆点 0.3em、点距 0.18em
// （0.48em 步进），内容盒高度 clamp(0.5em, 1vh, 3em)。
// 与 AMLL 的差异（宿主要求）：呼吸缩放原点不是盒中心（AMLL
// transform-origin: center，放大时左右同时外扩），而是首点左缘 = 歌词
// 文本左对齐线（AmlGroupView.inner.x = em）：缩放只向右展开，左缘始终
// 钉在歌词左对齐线上，不越出歌词左边范围。
// 宽高测量经 core.setInterludeMeasured 上报；布局上下边距（dotMargin =
// 0.4em ×2）由编排核心在 totalInterludeHeight 中计入。
Item {
    id: dots

    property var view
    readonly property var flow: view.flow
    readonly property var state: view.core ? view.core.interludeDots : null
    readonly property real em: flow.fontSize
    // 内容盒高度 = clamp(0.5em, 1vh, 3em)（1vh = 页面高度的 1%）
    readonly property real contentHeight: Math.max(em * 0.5, Math.min(flow.pageHeight * 0.01, em * 3))
    readonly property real dotSize: em * 0.3
    readonly property real dotStep: em * 0.48
    width: em * 3.26
    height: contentHeight + em * 0.8

    onWidthChanged: reportMeasure()
    onHeightChanged: reportMeasure()
    Component.onCompleted: reportMeasure()
    function reportMeasure(): void {
        if (view.core)
            view.core.setInterludeMeasured(width, height)
    }
    // 每帧提交快照（由 AmlLyricView 的帧循环驱动）
    function commitFrame(): void {
        const st = dots.state;
        if (!st)
            return;
        const snap = st.getSnapshot();
        content.opacity = snap.opacity;
        // 呼吸缩放仅在开启动效时生效（关闭动效时恒为 1，不与快照叠加）
        content.scale = flow.motion ? snap.scale : 1;
        dot0.opacity = snap.dotOpacities[0];
        dot1.opacity = snap.dotOpacities[1];
        dot2.opacity = snap.dotOpacities[2];
        dots.x = st.left;
        dots.y = st.posY.getCurrentPosition();
        dots.visible = snap.isActive || snap.opacity > 0.005;
    }
    // 内容盒（呼吸缩放/容器透明度宿主）；外层 item 只承担 x/y 定位。
    // content.x = em 让圆点坐标系原点落在歌词文本左对齐线上，配合
    // transformOrigin: Item.Left，呼吸/退场缩放以首点左缘为原点向右展开
    Item {
        id: content
        x: dots.em
        width: parent.width - dots.em
        height: parent.height
        transformOrigin: Item.Left
        Rectangle {
            id: dot0
            x: 0
            y: dots.em * 0.4 + (dots.contentHeight - height) / 2
            width: dots.dotSize
            height: width
            radius: width / 2
            color: flow.textColor
            opacity: 0
        }
        Rectangle {
            id: dot1
            x: dots.dotStep
            y: dot0.y
            width: dot0.width
            height: dot0.height
            radius: width / 2
            color: dot0.color
            opacity: 0
        }
        Rectangle {
            id: dot2
            x: dots.dotStep * 2
            y: dot0.y
            width: dot0.width
            height: dot0.height
            radius: width / 2
            color: dot0.color
            opacity: 0
        }
    }
}

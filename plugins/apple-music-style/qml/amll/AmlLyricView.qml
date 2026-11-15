pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import EchoMusic.Theme

// AMLL 歌词渲染视图（对应 dom/lyric-player.ts 的渲染端）。
// 帧循环：FrameAnimation 每帧以 frameTime×1000（秒→毫秒）推进编排核心
// LyricPlayerCore（滚动引擎 tick/间奏演出/行弹簧），随后逐组提交视觉状态。
// 输入：滚轮与触摸/拖拽喂入 ScrollInteractionEngine（意图阈值 10px、惯性
// 0.95^(dt/16.67)、滚轮 150ms 空闲、自动回归 500ms 均在引擎内闭环，无需
// QML 计时器）。
// 布局：无 ListView——与 AMLL 相同的绝对定位 + 视口剔除，组视图 y 由
// posY 弹簧逐帧落盘，测量结果反向上报布局计算器。
// 未同步歌词（scrollable === false）：静态列全亮 SOLID 展示，无排版/滚动
// /交互（旧实现的未同步行为即全亮静态列）。
Item {
    id: lyricView

    property var flow
    // 编排核心（LyricPlayerCore，由 LyricFlow 创建赋值；纯 JS 对象，
    // 属性变化无通知——组内一律命令式读取）
    property var core: null
    // 组数量（onGroupsChanged 钩子同步；Repeater 以此重建 delegate）
    property int groupCount: 0

    clip: true
    readonly property bool interactive: flow.scrollable && core !== null && flow.live

    WheelHandler {
        id: wheelHandler
        enabled: lyricView.interactive
        acceptedDevices: PointerDevice.Mouse | PointerDevice.TouchPad
        onWheel: event => {
            const c = lyricView.core;
            if (!c) {
                event.accepted = false;
                return;
            }
            // QML → AMLL 语义换算：向下滚动为正增量（AMLL DOM deltaY 方向）。
            // pixelDelta 直接为像素；angleDelta 每格 ±120，按 AMLL 行模式
            // 每格 ±3 行 ×50px 换算为 ±150px
            const pd = event.pixelDelta;
            if (pd && pd.y !== 0)
                c.scrollEngine.wheel(-pd.y, true);
            else if (event.angleDelta.y !== 0)
                c.scrollEngine.wheel(-event.angleDelta.y / 120 * 150, true);
            event.accepted = true;
        }
    }
    DragHandler {
        id: dragHandler
        enabled: lyricView.interactive
        onActiveChanged: {
            const c = lyricView.core;
            if (!c)
                return;
            const p = dragHandler.centroid.position;
            if (dragHandler.active)
                c.scrollEngine.beginTouch(p.x, p.y, Date.now());
            else
                c.scrollEngine.endTouch(Date.now());
        }
        onTranslationChanged: {
            const c = lyricView.core;
            if (!c || !dragHandler.active)
                return;
            const p = dragHandler.centroid.position;
            c.scrollEngine.moveTouch(p.x, p.y, Date.now());
        }
        onCanceled: {
            const c = lyricView.core;
            if (c)
                c.scrollEngine.cancelTouch();
        }
    }
    // AMLL :hover 语义（lyric-player.module.css:304）：鼠标悬停播放器容器
    // 时所有行 filter: unset !important——悬停歌词区期间暂时禁用远行模糊
    // 便于阅读，离开后经组级 blur Behavior 0.4s ease 平滑恢复（CSS wrapper
    // transition filter 0.4s 双向同值）。不门控 interactive：悬停与滚动输入
    // 无关，未同步静态列本就无模糊
    HoverHandler {
        id: viewHover
    }
    readonly property bool hoverBlurOff: viewHover.hovered
    // 视口上下缘淡出：消除歌词移出顶部/进入底部时被 clip 硬切的水平分界
    // 线。不用 MultiEffect.mask 整层遮罩——遮罩源 Item 必须可见且在视口内
    // 才能渲染出纹理内容（visible:false / opacity:0 / 摆出视口外经代理渲
    // 染均为全 0 alpha，整列歌词被遮没；可见时又把白色渐变自绘进场景，
    // 2026-11-15 五轮实测无解），改为逐组透明度淡出：组上/下缘进入边缘
    // 渐隐带（edgeBand，≈1 行行距）时整体线性降至 0，触及视口边界前已完
    // 全隐藏。作用于 item 透明度而非 glyph pose ρ（行链 ρ 不变，扫掠带亮
    // 度不泄漏），间奏点与未同步列同规则淡出。
    // 边缘渐隐带高度：视口的 10%（≈1 行行距），上下对称
    readonly property real edgeBand: height * 0.1
    // 组视图宿主（非滚动歌词时整体隐藏）
    Item {
        id: groupsHost
        visible: flow.scrollable
        width: parent.width
        height: parent.height
        Repeater {
            id: groupsRepeater
            model: lyricView.groupCount
            // 注意：delegate 内不得重复声明 required property int index——
            // AmlGroupView 根对象已声明，重复声明会使 Repeater 的模型角色
            // 注入失效（Required property index was not initialized）
            delegate: AmlGroupView {
                view: lyricView
            }
        }
    }
    // 间奏点
    AmlInterludeDots {
        id: dotsView
        view: lyricView
    }
    // 未同步歌词：静态列（全亮 SOLID），首行主文本中心对齐 focusPosition
    Column {
        id: staticColumn
        visible: !flow.scrollable && flow.live
        x: 0
        y: Math.max(0, lyricView.height * flow.focusPosition - flow.fontSize * 0.6)
        width: parent.width
        Repeater {
            model: flow.live && !flow.scrollable ? flow.page.player.lyrics : null
            delegate: Item {
                id: staticRow

                required property int index
                required property string lineText
                required property string translation
                required property string romanization
                required property bool filtered
                readonly property real em: flow.fontSize
                readonly property string secondaryText: [flow.wantRomanization ? romanization : "", flow.wantTranslation ? translation : ""].filter(value => value.length > 0).join("\n")
                readonly property real naturalHeight: filtered ? 0 : em * 0.8 + mainView.textHeight + (secondaryText.length > 0 ? flow.secondaryGap + secondaryView.implicitHeight : 0)
                width: staticColumn.width
                height: naturalHeight
                visible: !filtered
                // 视口边缘渐隐（同组视图规则）：未同步长列表底部溢出同样
                // 会被 clip 硬切，按行视口位置线性降透明
                opacity: {
                    const band = lyricView.edgeBand
                    const yv = staticColumn.y + staticRow.y
                    return band > 0 ? Math.min(1, Math.max(0, yv / band), Math.max(0, (lyricView.height - yv - naturalHeight) / band)) : 1
                }
                Rectangle {
                    anchors.fill: parent
                    radius: staticRow.em * 0.25
                    color: Theme.withAlpha(flow.textColor, hover.hovered ? 0.07 : 0)
                }
                Item {
                    x: staticRow.em
                    y: staticRow.em * 0.4
                    width: parent.width - staticRow.em * 2
                    height: staticRow.naturalHeight - staticRow.em * 0.8
                    AmlLineView {
                        id: mainView
                        width: parent.width * flow.lineWidthAspect
                        height: implicitHeight
                        text: staticRow.lineText
                        // 静态全亮：无逐词时序（flat 路径）+ 高亮量 1 → 播放色全 alpha
                        words: []
                        timeMs: -1
                        current: false
                        highlightAmount: 1
                        nonDynamicLyric: false
                        font: flow.baseFont
                        playedColor: flow.textColor
                        unplayedColor: flow.unplayedColor
                        fadeWidth: flow.wordFade
                    }
                    Label {
                        id: secondaryView
                        y: mainView.textHeight + flow.secondaryGap
                        width: parent.width
                        visible: staticRow.secondaryText.length > 0
                        text: staticRow.secondaryText
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
            }
        }
    }
    // 帧循环：推进核心并提交视觉。运行条件 = 页面活跃 + 已同步歌词
    //（静态路径无需帧循环）。核心内部钳制单帧 delta（MAX_FRAME_DELTA）
    FrameAnimation {
        id: ticker
        running: flow.live && lyricView.core !== null && flow.scrollable
        onTriggered: {
            const c = lyricView.core;
            if (!c)
                return;
            c.update(frameTime * 1000);
            lyricView.commitFrame();
        }
    }
    // onGroupsChanged 钩子入口（LyricFlow 创建核心时接线）。
    // 必须先清零再设值：核心每次重建（setLyricLines）都会整体替换
    // currentLyricGroups 的组对象，而 Repeater 在 model 数值不变时不会重建
    // delegate——切歌时连续两次 rebuild 且行数相同（如 64→64）会让旧
    // delegate 继续持有已被核心弃用的上一代组核心，弹簧/revision 全部冻结，
    // 歌词整页停摆（2026-11-13 实测）。清零强制 Repeater 销毁重建，delegate
    // 重新绑定到新组对象（对齐 AMLL DOM 每次重建全量重建行元素的行为）。
    function notifyGroupsChanged(): void {
        groupCount = 0;
        groupCount = core ? core.currentLyricGroups.length : 0;
    }
    // 每帧提交：逐组落盘弹簧/离散目标，间奏点提交快照
    function commitFrame(): void {
        const c = core;
        if (!c)
            return;
        for (let i = 0; i < groupsRepeater.count; ++i) {
            const g = groupsRepeater.itemAt(i);
            if (g)
                g.commitFrame();
        }
        dotsView.commitFrame();
    }
}

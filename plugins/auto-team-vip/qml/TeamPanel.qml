pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import EchoMusic.Controls
import EchoMusic.PluginSdk

// 页面入口（保留作弹窗不可用时的回退）；弹窗入口见 PanelDialog.qml。
// EchoPluginPage 提供 required plugin/context 与 pageActive，宿主经 initialProperties 注入。
EchoPluginPage {
    id: panelRoot

    implicitWidth: 520
    implicitHeight: 620

    Flickable {
        id: scroll
        anchors.fill: parent
        anchors.margins: 24
        contentWidth: width
        contentHeight: body.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        ScrollBar.vertical: EchoScrollBar {
            resourceActive: scroll.visible
        }

        TeamPanelBody {
            id: body
            width: panelRoot.width - 48
            plugin: panelRoot.plugin
        }
    }

    // 经 notifyPanel 上报（不占用 pending）；开合状态逻辑保持原样
    Component.onCompleted: body.notifyPanel(true)
    Component.onDestruction: body.notifyPanel(false)
    onPageActiveChanged: {
        if (!panelRoot.pageActive) body.notifyPanel(false)
    }
}

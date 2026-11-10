pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import EchoMusic.Controls
import EchoMusic.PluginSdk

// 主窗口共享弹层面板：标题与关闭（Esc/遮罩/✕）由宿主弹层提供，
// 此文件不绘制背景、边框或页眉，只承载正文并提供超长时滚动。
Item {
    id: dialogRoot

    required property EchoPluginContext plugin
    required property EchoPluginDialog dialog

    implicitWidth: 400
    implicitHeight: Math.min(body.implicitHeight, 560) + 24

    Flickable {
        id: dialogScroll
        anchors.fill: parent
        anchors.margins: 12
        contentWidth: width
        contentHeight: body.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        ScrollBar.vertical: EchoScrollBar {
            resourceActive: dialogScroll.visible
        }

        TeamPanelBody {
            id: body
            width: dialogScroll.width
            showTitle: false
            plugin: dialogRoot.plugin
        }
    }
}

pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import EchoMusic.Controls
import EchoMusic.PluginSdk

// Standalone settings surface opened via ui.showDialog from the browser
// page. The shared dialog body does not scroll, so this wrapper provides
// the flickable viewport that the registerSettings host dialog adds there.
Item {
    id: dialogRoot
    objectName: "webdavMusicSettingsDialog"

    required property EchoPluginContext plugin
    required property EchoPluginDialog dialog

    readonly property real maxBodyHeight: Window.window ? Math.max(320, Window.window.height - 160) : 680
    implicitHeight: Math.min(body.implicitHeight, maxBodyHeight)

    Flickable {
        id: viewport
        anchors.fill: parent
        contentWidth: width
        contentHeight: body.implicitHeight
        boundsBehavior: Flickable.StopAtBounds
        clip: true
        interactive: body.implicitHeight > height
        ScrollBar.vertical: EchoScrollBar {
        }

        Settings {
            id: body
            plugin: dialogRoot.plugin
            width: viewport.width
        }
    }
}

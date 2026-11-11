pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import EchoMusic.PluginSdk
import EchoMusic.Theme

Rectangle {
    id: hint
    objectName: "githubAccelerateTakeover"
    required property EchoPluginContext plugin
    required property EchoUiPartRef part
    implicitWidth: 240
    implicitHeight: 36
    radius: 8
    color: Theme.floating.card
    border.color: Qt.rgba(0.94, 0.27, 0.27, 0.3)
    border.width: 1
    Accessible.name: label.text
    Label {
        id: label
        anchors.fill: parent
        anchors.leftMargin: 12
        anchors.rightMargin: 12
        text: qsTr("当前设置由 GitHub 加速插件接管")
        color: "#ef4444"
        font: Theme.font(12, Theme.mediumWeight)
        verticalAlignment: Text.AlignVCenter
        elide: Text.ElideRight
    }
}

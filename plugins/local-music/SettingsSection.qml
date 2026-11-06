pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Layouts
import EchoMusic.Controls
import EchoMusic.Theme

// Section composition copied from the host settings pages: icon + heading
// above a muted card, rows declared as direct children of the card column.
ColumnLayout {
    id: section
    property string heading: ""
    property string glyph: ""
    default property alias rows: content.data
    spacing: 16
    RowLayout {
        Layout.fillHeight: false
        Layout.fillWidth: true
        spacing: 12
        EchoIcon {
            objectName: "settingsSectionIcon"
            name: section.glyph
            Layout.preferredWidth: 20
            Layout.preferredHeight: 20
            color: Theme.floatingAccentText
        }
        EchoTextTagRow {
            text: section.heading
            font: Theme.font(15, Theme.semiboldWeight)
            color: Theme.floatingText
        }
    }
    Rectangle {
        Layout.fillWidth: true
        implicitHeight: content.implicitHeight + 40
        radius: Theme.cardRadius
        color: Theme.floating.mutedSurface
        border.color: "transparent"
        // Clicking blank card space clears text focus so the rename editor
        // loses its caret; control clicks take priority and do not pass
        // through.
        MouseArea {
            anchors.fill: parent
            z: -1
            onClicked: section.forceActiveFocus(Qt.MouseFocusReason)
        }
        ColumnLayout {
            id: content
            x: 20
            y: 20
            width: parent.width - 40
            spacing: 20
        }
    }
}

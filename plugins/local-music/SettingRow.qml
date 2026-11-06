pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import EchoMusic.Theme

// Settings row copied from the host SettingsRow: copy column on the left
// (heading / description), controls passed as children on the right. Lives
// inside a section card; separate rows with a hairline EchoDivider between
// them.
RowLayout {
    id: row
    property string heading: ""
    property string description: ""
    property real controlGap: 12
    default property alias controls: actions.data
    Layout.fillWidth: true
    Layout.minimumWidth: 0
    spacing: 24
    ColumnLayout {
        Layout.fillHeight: false
        Layout.fillWidth: true
        Layout.minimumWidth: 0
        Layout.topMargin: 4
        Layout.bottomMargin: 4
        spacing: 4
        Label {
            Layout.fillWidth: true
            text: row.heading
            textFormat: Text.PlainText
            color: Theme.floatingText
            font: Theme.font(13, Theme.semiboldWeight)
            wrapMode: Text.Wrap
        }
        Label {
            Layout.fillWidth: true
            visible: text.length > 0
            text: row.description
            textFormat: Text.PlainText
            color: Theme.floatingSecondaryText
            font: Theme.font(12, Theme.regularWeight)
            wrapMode: Text.Wrap
        }
    }
    RowLayout {
        id: actions
        Layout.fillHeight: false
        Layout.fillWidth: false
        spacing: row.controlGap
    }
}

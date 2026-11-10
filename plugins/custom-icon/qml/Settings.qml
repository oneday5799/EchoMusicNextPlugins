pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import EchoMusic.PluginSdk
import EchoMusic.Controls
import EchoMusic.Theme

ColumnLayout {
    id: settingsRoot
    objectName: "customIconSettings"

    required property EchoPluginContext plugin

    readonly property var s: plugin.ui.state
    readonly property var snapshot: plugin.appIcons.snapshot
    property EchoPluginOperation pending: null
    readonly property bool busy: pending !== null && (pending.state === 0 || pending.state === 1)
    property string lastResult: ""

    spacing: 14

    function run(command: string, args: var): void {
        lastResult = "";
        pending = plugin.executeCommand(command, args);
    }

    function targetEntry(target: string): var {
        const targets = settingsRoot.s.targets;
        return targets && targets[target] ? targets[target] : null;
    }

    function targetModel(): var {
        const platform = settingsRoot.snapshot;
        return [
            {
                target: "window",
                title: qsTr("窗口图标"),
                hint: qsTr("窗口标题栏与任务栏程序图标（macOS Dock）"),
                formats: qsTr("所有系统（.ico/.png/.jpg/.webp/.bmp/.gif）"),
                supported: true
            },
            {
                target: "tray",
                title: qsTr("托盘图标"),
                hint: qsTr("系统托盘区域显示的图标"),
                formats: qsTr("所有系统（.ico/.png/.jpg/.webp/.bmp/.gif）"),
                supported: true
            },
            {
                target: "desktop",
                title: qsTr("桌面快捷方式图标"),
                hint: qsTr("宿主写入桌面已有的快捷方式（.lnk/启动器）"),
                formats: qsTr("Windows / Linux（.ico/.png/.jpg/.webp/.bmp/.gif，宿主分别转存为 .ico/.png）"),
                supported: platform.desktop === true
            },
            {
                target: "taskbar",
                title: qsTr("固定任务栏图标"),
                hint: qsTr("固定到任务栏的快捷方式图标"),
                formats: qsTr("仅 Windows（.ico/.png/.jpg/.webp/.bmp/.gif，宿主转存为 .ico）"),
                supported: platform.taskbar === true
            },
        ];
    }

    Connections {
        target: settingsRoot.pending
        function onCompleted(): void {
            const op = settingsRoot.pending;
            if (!op) return;
            if (op.state === 3) settingsRoot.lastResult = op.errorMessage;
            else if (op.state === 2) settingsRoot.lastResult = qsTr("已应用");
        }
    }

    Label {
        Layout.fillWidth: true
        text: qsTr("为窗口、托盘和快捷方式设置自定义图标。首次应用需要确认“更改应用、托盘或快捷方式图标”授权；停用插件即恢复默认。")
        font: Theme.font(12, Theme.regularWeight)
        color: Theme.floatingSecondaryText
        wrapMode: Text.Wrap
    }

    Repeater {
        model: settingsRoot.targetModel()

        delegate: Rectangle {
            id: rowCard
            required property var modelData
            readonly property var entry: settingsRoot.targetEntry(modelData.target)
            readonly property bool configured: entry !== null

            Layout.fillWidth: true
            implicitHeight: rowBody.implicitHeight + 28
            radius: 16
            color: Theme.floating.elevated
            border.color: Theme.floatingBorder

            ColumnLayout {
                id: rowBody
                anchors.fill: parent
                anchors.margins: 14
                spacing: 10

                RowLayout {
                    Layout.fillWidth: true
                    spacing: 12

                    Rectangle {
                        Layout.preferredWidth: 48
                        Layout.preferredHeight: 48
                        radius: 10
                        color: Theme.floating.elevated
                        border.color: Theme.floatingBorder

                        Image {
                            anchors.fill: parent
                            anchors.margins: 4
                            source: rowCard.entry ? rowCard.entry.preview : ""
                            fillMode: Image.PreserveAspectFit
                            asynchronous: true
                            visible: rowCard.entry && rowCard.entry.preview !== ""
                        }
                        Label {
                            anchors.centerIn: parent
                            visible: !(rowCard.entry && rowCard.entry.preview !== "")
                            text: qsTr("无")
                            font: Theme.font(11, Theme.regularWeight)
                            color: Theme.floatingSecondaryText
                        }
                    }

                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 3

                        RowLayout {
                            Layout.fillWidth: true
                            spacing: 8

                            Label {
                                text: rowCard.modelData.title
                                font: Theme.font(13, 700)
                                color: Theme.floatingText
                            }
                            EchoTag {
                                text: rowCard.modelData.supported ? qsTr("可用") : qsTr("当前平台不支持")
                                tone: rowCard.modelData.supported ? EchoTag.Accent : EchoTag.Neutral
                            }
                            Item {
                                Layout.fillWidth: true
                            }
                            Label {
                                Layout.maximumWidth: 220
                                elide: Text.ElideMiddle
                                visible: rowCard.configured
                                text: rowCard.entry ? rowCard.entry.name : ""
                                font: Theme.font(12, Theme.regularWeight)
                                color: Theme.floatingSecondaryText
                            }
                        }
                        Label {
                            Layout.fillWidth: true
                            text: rowCard.modelData.hint
                            font: Theme.font(12, Theme.regularWeight)
                            color: Theme.floatingSecondaryText
                            wrapMode: Text.Wrap
                        }
                        Label {
                            Layout.fillWidth: true
                            text: rowCard.modelData.formats
                            font: Theme.font(12, Theme.regularWeight)
                            color: Theme.floatingSecondaryText
                            wrapMode: Text.Wrap
                        }
                    }
                }

                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8

                    Item {
                        Layout.fillWidth: true
                    }
                    EchoButton {
                        objectName: "customIconPick" + rowCard.modelData.target
                        text: rowCard.configured ? qsTr("更换") : qsTr("选择")
                        colors: Theme.floating
                        enabled: rowCard.modelData.supported && !settingsRoot.busy
                        Accessible.name: rowCard.modelData.title
                        onClicked: settingsRoot.run("icons.pick", { target: rowCard.modelData.target })
                    }
                    EchoButton {
                        objectName: "customIconClear" + rowCard.modelData.target
                        text: qsTr("清除")
                        colors: Theme.floating
                        enabled: rowCard.configured && rowCard.modelData.supported && !settingsRoot.busy
                        Accessible.name: qsTr("清除") + rowCard.modelData.title
                        onClicked: settingsRoot.run("icons.clear", { target: rowCard.modelData.target })
                    }
                }
            }
        }
    }

            RowLayout {
                Layout.fillWidth: true
                spacing: 8

                EchoButton {
                    objectName: "customIconResetButton"
                    text: qsTr("恢复默认")
                    colors: Theme.floating
                    enabled: !settingsRoot.busy
                    Accessible.name: qsTr("恢复默认")
                    onClicked: settingsRoot.run("icons.reset", {})
                }
                EchoButton {
                    objectName: "customIconApplyButton"
                    visible: settingsRoot.s.pendingAuthorization === true
                    text: qsTr("应用图标")
                    colors: Theme.floating
                    enabled: !settingsRoot.busy
                    Accessible.name: qsTr("应用图标")
                    onClicked: settingsRoot.run("icons.apply", {})
                }
                Item {
                    Layout.fillWidth: true
                }
                Label {
                    Layout.fillWidth: true
                    horizontalAlignment: Text.AlignRight
                    elide: Text.ElideRight
                    readonly property string applyError: settingsRoot.s.error ?? ""
                    readonly property string shortcutError: settingsRoot.snapshot.error ?? ""
                    visible: settingsRoot.busy || settingsRoot.lastResult !== ""
                             || applyError !== "" || shortcutError !== ""
                    text: settingsRoot.busy ? qsTr("正在应用…")
                        : applyError !== "" ? applyError
                        : shortcutError !== "" ? qsTr("快捷方式：") + shortcutError
                        : settingsRoot.lastResult
                    wrapMode: Text.Wrap
                    font: Theme.font(12, Theme.regularWeight)
                    color: applyError !== "" || shortcutError !== ""
                           ? Theme.colors.danger : Theme.floatingSecondaryText
                }
    }
}

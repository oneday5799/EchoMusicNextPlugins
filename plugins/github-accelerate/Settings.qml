pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import EchoMusic.PluginSdk
import EchoMusic.Controls
import EchoMusic.Theme

ColumnLayout {
    id: settingsRoot
    objectName: "githubAccelerateSettings"

    required property EchoPluginContext plugin

    readonly property var s: plugin.ui.state
    readonly property bool testing: settingsRoot.s.testing === true
    readonly property int probeDone: typeof settingsRoot.s.probeDone === "number" ? settingsRoot.s.probeDone : 0
    readonly property int probeTotal: typeof settingsRoot.s.probeTotal === "number" ? settingsRoot.s.probeTotal : 0
    readonly property string selectedUrl: typeof settingsRoot.s.selectedUrl === "string" ? settingsRoot.s.selectedUrl : ""
    // ui.state 是 QVariantMap，其嵌套 QVariantList 在 QML 中是宿主引擎的序列对象
    // 而非真数组：JSON.stringify/下标可用，但 Array.isArray 为 false。归一化成真数组。
    readonly property var ranked: settingsRoot.toList(settingsRoot.s.ranked)
    property EchoPluginOperation pending: null
    readonly property bool busy: pending !== null && (pending.state === 0 || pending.state === 1)
    property string lastResult: ""

    function toList(value: var): var {
        if (Array.isArray(value)) return value;
        if (typeof value === "string") {
            try {
                const parsed = JSON.parse(value);
                return Array.isArray(parsed) ? parsed : [];
            } catch (error) {
                return [];
            }
        }
        if (value !== null && value !== undefined && typeof value === "object") {
            try {
                const parsed = JSON.parse(JSON.stringify(value));
                return Array.isArray(parsed) ? parsed : [];
            } catch (error) {
                return [];
            }
        }
        return [];
    }

    spacing: 14

    function run(command: string, args: var): void {
        lastResult = "";
        pending = plugin.executeCommand(command, args);
    }

    // 面板随对话框按需创建/销毁，每次打开都触发一次自动检测。
    Component.onCompleted: settingsRoot.run("accelerate.test", {})

    Connections {
        target: settingsRoot.pending
        function onCompleted(): void {
            const op = settingsRoot.pending;
            if (!op) return;
            if (op.state === 3) settingsRoot.lastResult = op.errorMessage;
        }
    }

    Rectangle {
        Layout.fillWidth: true
        radius: 16
        color: Theme.floating.elevated
        border.color: Theme.floatingBorder
        implicitHeight: overview.implicitHeight + 28

        RowLayout {
            id: overview
            anchors.fill: parent
            anchors.margins: 14
            spacing: 14

            Rectangle {
                Layout.preferredWidth: 52
                Layout.preferredHeight: 52
                radius: 16
                gradient: Gradient {
                    orientation: Gradient.Horizontal
                    GradientStop {
                        position: 0
                        color: "#58a6ff"
                    }
                    GradientStop {
                        position: 1
                        color: "#a86dff"
                    }
                }
                Label {
                    anchors.centerIn: parent
                    text: "⇄"
                    font: Theme.font(24, 700)
                    color: "#f7ffffff"
                }
            }
            ColumnLayout {
                Layout.fillWidth: true
                spacing: 4
                Label {
                    Layout.fillWidth: true
                    text: qsTr("GitHub 加速")
                    font: Theme.font(13, 700)
                    color: Theme.floatingText
                }
                Label {
                    Layout.fillWidth: true
                    text: settingsRoot.testing ? qsTr("正在探测镜像 %1/%2…").arg(settingsRoot.probeDone).arg(settingsRoot.probeTotal)
                        : settingsRoot.selectedUrl !== "" ? qsTr("已找到可用地址，复制第 1 名粘贴到宿主网络设置即可生效")
                        : settingsRoot.s.tested === true ? qsTr("暂无可用地址，可稍后重新检测")
                        : qsTr("每日拉取社区镜像列表，按延迟排出最优加速地址")
                    font: Theme.font(12, Theme.regularWeight)
                    color: Theme.floatingSecondaryText
                    wrapMode: Text.Wrap
                }
            }
            EchoTag {
                text: settingsRoot.testing ? qsTr("检测中")
                    : settingsRoot.selectedUrl !== "" ? qsTr("可用")
                    : settingsRoot.s.tested === true ? qsTr("直连")
                    : qsTr("待检测")
                tone: settingsRoot.testing ? EchoTag.Neutral
                    : settingsRoot.selectedUrl !== "" ? EchoTag.Accent
                    : EchoTag.Neutral
            }
        }
    }

    Rectangle {
        Layout.fillWidth: true
        radius: 16
        color: Theme.floating.elevated
        border.color: Theme.floatingBorder
        implicitHeight: infoBody.implicitHeight + 28

        ColumnLayout {
            id: infoBody
            anchors.fill: parent
            anchors.margins: 14
            spacing: 10

            RowLayout {
                Layout.fillWidth: true
                spacing: 8
                Label {
                    text: qsTr("数据版本")
                    font: Theme.font(12, Theme.regularWeight)
                    color: Theme.floatingSecondaryText
                    Layout.fillWidth: true
                }
                Label {
                    text: typeof settingsRoot.s.version === "string" && settingsRoot.s.version !== "" ? settingsRoot.s.version : "-"
                    font: Theme.font(12, 500)
                    color: Theme.floatingText
                }
            }
            RowLayout {
                Layout.fillWidth: true
                spacing: 8
                Label {
                    text: qsTr("镜像数量")
                    font: Theme.font(12, Theme.regularWeight)
                    color: Theme.floatingSecondaryText
                    Layout.fillWidth: true
                }
                Label {
                    text: typeof settingsRoot.s.mirrorCount === "number" ? String(settingsRoot.s.mirrorCount) : "-"
                    font: Theme.font(12, 500)
                    color: Theme.floatingText
                }
            }
            RowLayout {
                Layout.fillWidth: true
                spacing: 8
                Label {
                    text: qsTr("可用地址（按延迟）")
                    font: Theme.font(12, Theme.regularWeight)
                    color: Theme.floatingSecondaryText
                    Layout.fillWidth: true
                }
                Label {
                    visible: settingsRoot.ranked.length === 0
                    text: settingsRoot.testing ? qsTr("检测中 %1/%2…").arg(settingsRoot.probeDone).arg(settingsRoot.probeTotal)
                        : settingsRoot.s.tested === true ? qsTr("无")
                        : "-"
                    font: Theme.font(12, 500)
                    color: Theme.floatingText
                }
            }
            Repeater {
                model: settingsRoot.ranked

                delegate: RowLayout {
                    id: rankRow
                    required property var modelData
                    required property int index

                    Layout.fillWidth: true
                    spacing: 8

                    Label {
                        text: String(rankRow.index + 1)
                        font: Theme.font(12, 700)
                        color: rankRow.index === 0 ? Theme.colors.accent : Theme.floatingSecondaryText
                    }
                    Label {
                        Layout.maximumWidth: 240
                        elide: Text.ElideMiddle
                        text: rankRow.modelData.url
                        font: Theme.font(12, rankRow.index === 0 ? 700 : 500)
                        color: rankRow.index === 0 ? Theme.colors.accent : Theme.floatingText
                    }
                    Item {
                        Layout.fillWidth: true
                    }
                    EchoTag {
                        text: rankRow.index === 0 ? qsTr("推荐") : qsTr("可用")
                        tone: rankRow.index === 0 ? EchoTag.Accent : EchoTag.Neutral
                    }
                    Label {
                        text: (typeof rankRow.modelData.latencyMs === "number" ? rankRow.modelData.latencyMs : -1) + " ms"
                        font: Theme.font(12, 500)
                        color: Theme.colors.success
                    }
                    EchoButton {
                        objectName: "githubAccelerateRowCopyButton" + rankRow.index
                        size: EchoControlSize.Small
                        text: qsTr("复制")
                        colors: Theme.floating
                        Accessible.name: qsTr("复制地址")
                        onClicked: settingsRoot.run("accelerate.copy", { url: rankRow.modelData.url })
                    }
                }
            }
        }
    }

    RowLayout {
        Layout.fillWidth: true
        spacing: 8

        EchoButton {
            objectName: "githubAccelerateTestButton"
            text: settingsRoot.testing ? qsTr("检测中…") : qsTr("重新检测")
            colors: Theme.floating
            enabled: !settingsRoot.testing
            Accessible.name: qsTr("重新检测")
            onClicked: settingsRoot.run("accelerate.test", {})
        }
        EchoButton {
            objectName: "githubAccelerateOpenSettingsButton"
            text: qsTr("粘贴到设置")
            colors: Theme.floating
            Accessible.name: qsTr("粘贴到设置")
            onClicked: settingsRoot.run("accelerate.open", {})
        }
        Item {
            Layout.fillWidth: true
        }
        Label {
            Layout.fillWidth: true
            horizontalAlignment: Text.AlignRight
            elide: Text.ElideRight
            visible: settingsRoot.busy || settingsRoot.lastResult !== ""
            text: settingsRoot.busy ? qsTr("执行中…") : settingsRoot.lastResult
            font: Theme.font(12, Theme.regularWeight)
            color: Theme.colors.danger
        }
    }

    Label {
        Layout.fillWidth: true
        text: qsTr("打开本面板会自动重新检测；每行“复制”复制对应地址，推荐用第 1 名。“粘贴到设置”直达 设置 → 网络设置，在“GitHub 加速地址”里粘贴一次即可生效，之后插件市场与应用更新的 GitHub 下载都会经镜像加速，镜像失败时宿主自动回源。")
        font: Theme.font(12, Theme.regularWeight)
        color: Theme.floatingSecondaryText
        wrapMode: Text.Wrap
    }
}

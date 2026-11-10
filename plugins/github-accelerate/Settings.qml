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
    readonly property string versionLabel: typeof settingsRoot.s.version === "string" && settingsRoot.s.version !== "" ? settingsRoot.s.version : ""
    readonly property int mirrorCount: typeof settingsRoot.s.mirrorCount === "number" ? settingsRoot.s.mirrorCount : 0
    property EchoPluginOperation pending: null
    readonly property bool busy: pending !== null && (pending.state === 0 || pending.state === 1)
    property string lastResult: ""

    spacing: 14

    function run(command: string, args: var): void {
        lastResult = "";
        pending = plugin.executeCommand(command, args);
    }

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

    // ── 概览：品牌 + 状态 ──
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
                    text: settingsRoot.testing ? qsTr("正在探测镜像 %1/%2，按延迟排出最优地址").arg(settingsRoot.probeDone).arg(settingsRoot.probeTotal)
                        : settingsRoot.selectedUrl !== "" ? qsTr("已选出可用地址，复制后粘贴到宿主网络设置即可生效")
                        : settingsRoot.s.tested === true ? qsTr("本轮未找到可用地址，可稍后重新检测")
                        : qsTr("每日拉取社区镜像列表，自动开始检测")
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

    // ── 可用地址：元信息 + 排名列表 ──
    Rectangle {
        Layout.fillWidth: true
        radius: 16
        color: Theme.floating.elevated
        border.color: Theme.floatingBorder
        implicitHeight: addressBody.implicitHeight + 28

        ColumnLayout {
            id: addressBody
            anchors.fill: parent
            anchors.margins: 14
            spacing: 12

            RowLayout {
                Layout.fillWidth: true
                spacing: 8
                Label {
                    text: qsTr("可用地址（按延迟）")
                    font: Theme.font(13, Theme.semiboldWeight)
                    color: Theme.floatingText
                }
                Item {
                    Layout.fillWidth: true
                }
                Label {
                    visible: settingsRoot.mirrorCount > 0
                    text: settingsRoot.versionLabel !== "" ? qsTr("%1 个镜像 · 数据 %2").arg(settingsRoot.mirrorCount).arg(settingsRoot.versionLabel)
                        : qsTr("%1 个镜像").arg(settingsRoot.mirrorCount)
                    font: Theme.font(12, Theme.regularWeight)
                    color: Theme.floatingSecondaryText
                }
            }

            // 空态：检测中（内联 spinner）/ 无结果 / 尚未检测
            RowLayout {
                Layout.fillWidth: true
                visible: settingsRoot.ranked.length === 0
                spacing: 8

                EchoSpinner {
                    visible: settingsRoot.testing
                    Layout.preferredWidth: 14
                    Layout.preferredHeight: 14
                    color: Theme.floatingSecondaryText
                }
                Label {
                    Layout.fillWidth: true
                    text: settingsRoot.testing ? qsTr("正在探测镜像 %1/%2…").arg(settingsRoot.probeDone).arg(settingsRoot.probeTotal)
                        : settingsRoot.s.tested === true ? qsTr("未找到可用地址，请检查网络后重新检测")
                        : qsTr("尚未检测")
                    font: Theme.font(12, Theme.regularWeight)
                    color: Theme.floatingSecondaryText
                    wrapMode: Text.Wrap
                }
            }

            Repeater {
                model: settingsRoot.ranked

                delegate: ColumnLayout {
                    id: rankRow
                    required property var modelData
                    required property int index

                    Layout.fillWidth: true
                    spacing: 12

                    EchoDivider {
                        Layout.fillWidth: true
                        visible: rankRow.index > 0
                        lineColor: Theme.withAlpha(Theme.floatingText, 0.12)
                    }

                    RowLayout {
                        Layout.fillWidth: true
                        Layout.minimumWidth: 0
                        spacing: 10

                        Label {
                            text: String(rankRow.index + 1)
                            font: Theme.font(13, 700)
                            color: rankRow.index === 0 ? Theme.colors.accent : Theme.floatingSecondaryText
                        }
                        Label {
                            Layout.fillWidth: true
                            Layout.minimumWidth: 0
                            elide: Text.ElideMiddle
                            text: rankRow.modelData.url
                            textFormat: Text.PlainText
                            font: Theme.font(12, rankRow.index === 0 ? 700 : 500)
                            color: rankRow.index === 0 ? Theme.colors.accent : Theme.floatingText
                        }
                        Label {
                            text: (typeof rankRow.modelData.latencyMs === "number" ? rankRow.modelData.latencyMs : -1) + " ms"
                            font: Theme.font(12, 500)
                            color: Theme.colors.success
                        }
                        EchoIconButton {
                            glyph: "copy"
                            tooltipText: rankRow.index === 0 ? qsTr("复制推荐地址") : qsTr("复制该地址")
                            Accessible.name: qsTr("复制地址")
                            onClicked: settingsRoot.run("accelerate.copy", { url: rankRow.modelData.url })
                        }
                    }
                }
            }
        }
    }

    // ── 操作与状态 ──
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
        text: qsTr("“粘贴到设置”会复制第 1 名（若你尚未手动复制过某条地址）并直达 设置 → 网络设置，把地址粘贴进“GitHub 加速地址”后，插件市场与应用更新的 GitHub 下载即会经镜像加速，镜像失败时宿主自动回源。宿主暂未开放该设置的插件写入接口，因此需要手动粘贴一次。")
        font: Theme.font(12, Theme.regularWeight)
        color: Theme.floatingSecondaryText
        wrapMode: Text.Wrap
    }
}

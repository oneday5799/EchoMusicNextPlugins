pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import EchoMusic.Controls
import EchoMusic.PluginSdk
import EchoMusic.Theme

// 自动组队领VIP面板：替代旧插件的全屏 Vue 弹窗。
// 数据来自插件 ui.state（entry.ts 发布），操作经插件命令回流到状态机。
// EchoPluginPage 提供 required plugin/context 与 pageActive，宿主经 initialProperties 注入。
EchoPluginPage {
    id: panelRoot

    readonly property var s: plugin.ui.state
    readonly property bool joinedCodeLocked: !!s && !!s.joinedCode
    property EchoPluginOperation pending: null
    property string lastCommand: ""

    implicitWidth: 520
    implicitHeight: 620

    function run(command: string, args: var): void {
        panelRoot.lastCommand = command;
        panelRoot.pending = panelRoot.plugin.executeCommand(command, args);
    }

    function copyText(text: string): void {
        if (!text) return;
        clipboardHelper.text = text;
        clipboardHelper.selectAll();
        clipboardHelper.copy();
    }

    Component.onCompleted: panelRoot.run("panel.opened", { active: true })
    Component.onDestruction: panelRoot.run("panel.opened", { active: false })
    onPageActiveChanged: {
        if (!panelRoot.pageActive) panelRoot.run("panel.opened", { active: false })
    }

    TextEdit {
        id: clipboardHelper
        visible: false
        width: 0
        height: 0
    }

    Flickable {
        id: scroll
        anchors.fill: parent
        anchors.margins: 24
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        ScrollBar.vertical: EchoScrollBar {
            resourceActive: scroll.visible
        }

        ColumnLayout {
            id: column
            width: panelRoot.width - 48
            spacing: 14

            // ---------- 头部 ----------
            RowLayout {
                Layout.fillWidth: true
                spacing: 10
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 2
                    Label {
                        text: "自动组队领VIP"
                        font: Theme.font(17, Theme.boldWeight)
                        color: Theme.text
                    }
                    Label {
                        Layout.fillWidth: true
                        text: panelRoot.s && panelRoot.s.periodName
                              ? "活动期次：" + panelRoot.s.periodName + (panelRoot.s.periodActive ? "" : "（本期未开启）")
                              : (panelRoot.s && panelRoot.s.loggedIn ? "正在获取活动期次…" : "登录 EchoMusic 后开始组队")
                        font: Theme.font(12, Theme.regularWeight)
                        color: Theme.secondaryText
                        elide: Text.ElideRight
                    }
                    Label {
                        Layout.fillWidth: true
                        visible: panelRoot.s && panelRoot.s.periodStart && panelRoot.s.periodEnd
                        text: panelRoot.s ? "本期活动时间：" + panelRoot.s.periodStart + " ~ " + panelRoot.s.periodEnd : ""
                        font: Theme.font(11, Theme.regularWeight)
                        color: Theme.secondaryText
                        opacity: 0.8
                        elide: Text.ElideRight
                    }
                }
                EchoButton {
                    text: "刷新"
                    accent: false
                    onClicked: panelRoot.run("refresh", {})
                }
            }

            // ---------- 我创建的队伍 ----------
            Rectangle {
                Layout.fillWidth: true
                implicitHeight: createdBox.implicitHeight + 24
                radius: 12
                color: Theme.colors.card
                border.color: Theme.colors.subtleBorder
                ColumnLayout {
                    id: createdBox
                    anchors.fill: parent
                    anchors.margins: 12
                    spacing: 8
                    RowLayout {
                        Layout.fillWidth: true
                        Label {
                            text: "我创建的队伍"
                            font: Theme.font(13, Theme.semiboldWeight)
                            color: Theme.text
                        }
                        Item { Layout.fillWidth: true }
                        EchoTag {
                            visible: panelRoot.s && panelRoot.s.myCode && panelRoot.s.myVipDesc
                            text: panelRoot.s ? String(panelRoot.s.myVipDesc || "") : ""
                            tone: EchoTag.Accent
                        }
                    }
                    Label {
                        Layout.fillWidth: true
                        visible: !(panelRoot.s && panelRoot.s.myCode)
                        text: panelRoot.s && panelRoot.s.periodActive
                              ? "开启自动组队后自动创建，或手动加入他人队伍"
                              : "等待本期活动开启"
                        font: Theme.font(12, Theme.regularWeight)
                        color: Theme.secondaryText
                        wrapMode: Text.Wrap
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        visible: panelRoot.s && panelRoot.s.myCode
                        spacing: 8
                        EchoTextField {
                            Layout.fillWidth: true
                            readOnly: true
                            text: panelRoot.s ? String(panelRoot.s.myCode || "") : ""
                        }
                        EchoButton {
                            text: "复制"
                            onClicked: panelRoot.run("copy-created", {})
                        }
                    }
                    Label {
                        Layout.fillWidth: true
                        visible: panelRoot.s && panelRoot.s.myCode
                        text: panelRoot.s ? "成员 " + panelRoot.s.myMemberCount + " / " + panelRoot.s.targetMembers : ""
                        font: Theme.font(12, Theme.regularWeight)
                        color: Theme.secondaryText
                    }
                }
            }

            // ---------- 我加入的队伍 ----------
            Rectangle {
                Layout.fillWidth: true
                implicitHeight: joinedBox.implicitHeight + 24
                radius: 12
                color: Theme.colors.card
                border.color: Theme.colors.subtleBorder
                ColumnLayout {
                    id: joinedBox
                    anchors.fill: parent
                    anchors.margins: 12
                    spacing: 8
                    RowLayout {
                        Layout.fillWidth: true
                        Label {
                            text: "我加入的队伍"
                            font: Theme.font(13, Theme.semiboldWeight)
                            color: Theme.text
                        }
                        Item { Layout.fillWidth: true }
                        EchoTag {
                            visible: panelRoot.s && panelRoot.s.joined && panelRoot.s.joinedVipDesc
                            text: panelRoot.s ? String(panelRoot.s.joinedVipDesc || "") : ""
                            tone: EchoTag.Accent
                        }
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        visible: panelRoot.joinedCodeLocked
                        spacing: 8
                        EchoTextField {
                            Layout.fillWidth: true
                            readOnly: true
                            text: panelRoot.s ? String(panelRoot.s.joinedCode || "") : ""
                        }
                        EchoButton {
                            text: "复制"
                            onClicked: panelRoot.run("copy-joined", {})
                        }
                    }
                    Label {
                        Layout.fillWidth: true
                        visible: panelRoot.joinedCodeLocked
                        text: panelRoot.s ? "成员 " + panelRoot.s.joinedMemberCount + " / " + panelRoot.s.targetMembers : ""
                        font: Theme.font(12, Theme.regularWeight)
                        color: Theme.secondaryText
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        visible: !panelRoot.joinedCodeLocked
                        spacing: 8
                        EchoTextField {
                            id: manualCode
                            Layout.fillWidth: true
                            placeholderText: "输入对方组队码手动加入"
                            echoMode: TextInput.Normal
                            onAccepted: panelRoot.run("join-manual", { code: manualCode.text })
                        }
                        EchoButton {
                            text: "加入"
                            loading: panelRoot.pending && panelRoot.pending.state === 1
                            onClicked: panelRoot.run("join-manual", { code: manualCode.text })
                        }
                    }
                }
            }

            // ---------- 自动组队开关 ----------
            Rectangle {
                Layout.fillWidth: true
                implicitHeight: autoRow.implicitHeight + 20
                radius: 12
                color: Theme.colors.card
                border.color: Theme.colors.subtleBorder
                RowLayout {
                    id: autoRow
                    anchors.fill: parent
                    anchors.margins: 10
                    spacing: 10
                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 2
                        Label {
                            text: "自动组队"
                            font: Theme.font(13, Theme.semiboldWeight)
                            color: Theme.text
                        }
                        Label {
                            Layout.fillWidth: true
                            text: panelRoot.s && panelRoot.s.autoEnabled
                                  ? "已开启：自动建队、上报快照并申请组队码"
                                  : "已关闭：仅查询状态，不与码池服务器通信"
                            font: Theme.font(11, Theme.regularWeight)
                            color: Theme.secondaryText
                            wrapMode: Text.Wrap
                        }
                    }
                    EchoSwitch {
                        checked: !!(panelRoot.s && panelRoot.s.autoEnabled)
                        Accessible.name: "自动组队"
                        onToggled: panelRoot.run("set-auto", { enabled: checked })
                    }
                }
            }

            // ---------- 状态提示 ----------
            Rectangle {
                Layout.fillWidth: true
                implicitHeight: statusBox.implicitHeight + 20
                radius: 12
                color: Theme.colors.card
                border.color: Theme.colors.subtleBorder
                visible: statusBox.anyVisible
                ColumnLayout {
                    id: statusBox
                    property bool anyVisible: authLine.visible || poolLine.visible || messageLine.visible
                    anchors.fill: parent
                    anchors.margins: 10
                    spacing: 8

                    Label {
                        id: authLine
                        Layout.fillWidth: true
                        visible: panelRoot.s && panelRoot.s.authState !== "ok"
                        text: panelRoot.s && panelRoot.s.authState === "unauthorized"
                              ? "插件授权未开启：组队功能需要“请求拦截”授权（插件管理 → 授权）"
                              : "登录态同步中：播放一首歌曲后自动完成，期间无法组队"
                        font: Theme.font(12, Theme.regularWeight)
                        color: Theme.colors.warning
                        wrapMode: Text.Wrap
                    }

                    Label {
                        id: poolLine
                        Layout.fillWidth: true
                        visible: panelRoot.s && panelRoot.s.autoEnabled
                                 && (panelRoot.s.poolDisabled || panelRoot.s.poolDown)
                        text: {
                            if (!panelRoot.s) return "";
                            if (panelRoot.s.poolDisabled)
                                return "状态异常，请联系插件作者处理，或等待下期组队";
                            const minutes = Number(panelRoot.s.poolRetryMinutes || 0);
                            const tip = minutes > 0 ? "，约 " + minutes + " 分钟后重试" : "，即将重试";
                            return "码池暂时不可用，自动重试中（暂时无法自动加入他人队伍）" + tip;
                        }
                        font: Theme.font(12, Theme.regularWeight)
                        color: Theme.secondaryText
                        wrapMode: Text.Wrap
                    }

                    RowLayout {
                        id: messageLine
                        Layout.fillWidth: true
                        visible: panelRoot.s && panelRoot.s.lastMessage
                        spacing: 8
                        Label {
                            Layout.fillWidth: true
                            text: panelRoot.s ? String(panelRoot.s.lastMessage || "") : ""
                            font: Theme.font(12, Theme.regularWeight)
                            color: Theme.colors.warning
                            wrapMode: Text.Wrap
                        }
                        EchoButton {
                            visible: panelRoot.s && panelRoot.s.lastError
                            text: "复制"
                            accent: false
                            onClicked: panelRoot.run("error-detail", {})
                        }
                    }
                }
            }

            // ---------- 说明 ----------
            Label {
                Layout.fillWidth: true
                text: "关闭自动组队时与码池服务器零交流（不上报快照、不申请组队码）；手动加入的组队码由用户自行输入。"
                font: Theme.font(11, Theme.regularWeight)
                color: Theme.secondaryText
                opacity: 0.8
                wrapMode: Text.Wrap
            }
        }
    }

    // 字符串结果（copy-created / copy-joined 返回队伍码、error-detail 返回详情）进剪贴板；
    // 手动入队成功后清空输入框，与旧插件行为一致
    Connections {
        target: panelRoot.pending
        function onCompleted(): void {
            if (!panelRoot.pending || panelRoot.pending.state !== 2) return;
            const result = panelRoot.pending.result;
            if (typeof result === "string" && result.length > 0) panelRoot.copyText(result);
            if (panelRoot.lastCommand === "join-manual" && result && result.ok === true)
                manualCode.clear();
        }
    }
}

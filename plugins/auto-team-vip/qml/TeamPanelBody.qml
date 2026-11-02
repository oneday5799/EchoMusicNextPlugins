pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import EchoMusic.Controls
import EchoMusic.PluginSdk
import EchoMusic.Theme

// 面板正文：页面（TeamPanel）与主窗口弹窗（PanelDialog）共享的内容组件。
// 数据来自插件 ui.state（entry.ts 发布），操作经插件命令回流到状态机；
// 剪贴板走 ctx.clipboard.write，由调用方提供滚动与外框。
ColumnLayout {
    id: bodyRoot

    required property EchoPluginContext plugin
    readonly property var s: plugin.ui.state
    readonly property bool joinedCodeLocked: !!s && !!s.joinedCode
    // 弹窗里宿主弹层已显示标题，仅页面显示正文大标题；刷新按钮两处共用
    property bool showTitle: true
    property EchoPluginOperation pending: null
    property string lastCommand: ""

    spacing: 14

    function run(command: string, args: var): void {
        bodyRoot.lastCommand = command;
        bodyRoot.pending = bodyRoot.plugin.executeCommand(command, args);
    }

    // 页面开合上报：直接执行命令，不占用 pending/lastCommand，
    // 避免覆盖在途操作（手动加入/刷新）的完成跟踪
    function notifyPanel(active: bool): void {
        bodyRoot.plugin.executeCommand("panel.opened", { active: active });
    }

    // 复制结果即时反馈：系统剪贴板无自带提示，成功按来源给确认文案、失败提示与旧插件一致
    function copyText(text: string, successMessage: string): void {
        if (!text) return;
        const op = bodyRoot.plugin.clipboard.write(text);
        op.completed.connect(function(): void {
            if (op.state === 3) bodyRoot.plugin.toast.warning("复制失败");
            else if (successMessage !== "") bodyRoot.plugin.toast.success(successMessage);
        });
    }

    // ---------- 头部 ----------
    RowLayout {
        Layout.fillWidth: true
        spacing: 10
        ColumnLayout {
            Layout.fillWidth: true
            spacing: 2
            Label {
                visible: bodyRoot.showTitle
                text: "自动组队领VIP"
                font: Theme.font(17, Theme.boldWeight)
                color: Theme.text
            }
            Label {
                Layout.fillWidth: true
                text: bodyRoot.s && bodyRoot.s.periodName
                      ? "活动期次：" + bodyRoot.s.periodName + (bodyRoot.s.periodActive ? "" : "（本期未开启）")
                      : (bodyRoot.s && bodyRoot.s.loggedIn ? "正在获取活动期次…" : "登录 EchoMusic 后开始组队")
                font: Theme.font(12, Theme.regularWeight)
                color: Theme.secondaryText
                wrapMode: Text.Wrap
            }
            Label {
                Layout.fillWidth: true
                visible: bodyRoot.s && bodyRoot.s.periodStart && bodyRoot.s.periodEnd
                text: bodyRoot.s ? "本期活动时间：" + bodyRoot.s.periodStart + " ~ " + bodyRoot.s.periodEnd : ""
                font: Theme.font(11, Theme.regularWeight)
                color: Theme.secondaryText
                opacity: 0.8
                wrapMode: Text.Wrap
            }
        }
        EchoButton {
            text: "刷新"
            accent: false
            loading: bodyRoot.lastCommand === "refresh" && !!bodyRoot.pending
                     && bodyRoot.pending.state === 1
            onClicked: bodyRoot.run("refresh", {})
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
                    visible: bodyRoot.s && bodyRoot.s.myCode && bodyRoot.s.myVipDesc
                    text: bodyRoot.s ? String(bodyRoot.s.myVipDesc || "") : ""
                    tone: EchoTag.Accent
                }
            }
            Label {
                Layout.fillWidth: true
                visible: !(bodyRoot.s && bodyRoot.s.myCode)
                text: bodyRoot.s && bodyRoot.s.periodActive
                      ? "将自动加入可用的队伍；无队可加时会自动建队并分享组队码"
                      : "等待本期活动开启"
                font: Theme.font(12, Theme.regularWeight)
                color: Theme.secondaryText
                wrapMode: Text.Wrap
            }
            RowLayout {
                Layout.fillWidth: true
                visible: bodyRoot.s && bodyRoot.s.myCode
                spacing: 8
                EchoTextField {
                    Layout.fillWidth: true
                    readOnly: true
                    text: bodyRoot.s ? String(bodyRoot.s.myCode || "") : ""
                }
                EchoButton {
                    text: "复制"
                    onClicked: bodyRoot.run("copy-created", {})
                }
            }
            Label {
                Layout.fillWidth: true
                visible: bodyRoot.s && bodyRoot.s.myCode
                text: bodyRoot.s ? "成员 " + bodyRoot.s.myMemberCount + " / " + bodyRoot.s.targetMembers : ""
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
                    visible: bodyRoot.s && bodyRoot.s.joined && bodyRoot.s.joinedVipDesc
                    text: bodyRoot.s ? String(bodyRoot.s.joinedVipDesc || "") : ""
                    tone: EchoTag.Accent
                }
            }
            RowLayout {
                Layout.fillWidth: true
                visible: bodyRoot.joinedCodeLocked
                spacing: 8
                EchoTextField {
                    Layout.fillWidth: true
                    readOnly: true
                    text: bodyRoot.s ? String(bodyRoot.s.joinedCode || "") : ""
                }
                EchoButton {
                    text: "复制"
                    onClicked: bodyRoot.run("copy-joined", {})
                }
            }
            Label {
                Layout.fillWidth: true
                visible: bodyRoot.joinedCodeLocked
                text: bodyRoot.s ? "成员 " + bodyRoot.s.joinedMemberCount + " / " + bodyRoot.s.targetMembers : ""
                font: Theme.font(12, Theme.regularWeight)
                color: Theme.secondaryText
            }
            RowLayout {
                Layout.fillWidth: true
                visible: !bodyRoot.joinedCodeLocked
                spacing: 8
                EchoTextField {
                    id: manualCode
                    Layout.fillWidth: true
                    placeholderText: "输入对方组队码手动加入"
                    echoMode: TextInput.Normal
                    onAccepted: bodyRoot.run("join-manual", { code: manualCode.text })
                }
                EchoButton {
                    text: "加入"
                    loading: bodyRoot.lastCommand === "join-manual"
                             && !!bodyRoot.pending && bodyRoot.pending.state === 1
                    onClicked: bodyRoot.run("join-manual", { code: manualCode.text })
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
                    text: bodyRoot.s && bodyRoot.s.autoEnabled
                          ? "已开启：优先加入他人队伍，无队可加时自动建队入池"
                          : "已关闭：自动建队并展示队伍码，不与码池服务器通信"
                    font: Theme.font(11, Theme.regularWeight)
                    color: Theme.secondaryText
                    wrapMode: Text.Wrap
                }
            }
            EchoSwitch {
                checked: !!(bodyRoot.s && bodyRoot.s.autoEnabled)
                Accessible.name: "自动组队"
                onToggled: bodyRoot.run("set-auto", { enabled: checked })
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
                visible: bodyRoot.s && bodyRoot.s.authState !== "ok"
                text: bodyRoot.s && bodyRoot.s.authState === "unauthorized"
                      ? "插件授权未开启：组队功能需要“请求拦截”与“读取登录态”授权（插件管理 → 授权）"
                      : "登录态同步中：允许“读取登录态”授权或播放一首歌曲后自动完成"
                font: Theme.font(12, Theme.regularWeight)
                color: Theme.colors.warning
                wrapMode: Text.Wrap
            }

            RowLayout {
                id: poolLine
                Layout.fillWidth: true
                visible: bodyRoot.s && bodyRoot.s.autoEnabled
                         && (bodyRoot.s.poolDisabled || bodyRoot.s.poolDown)
                spacing: 8
                Label {
                    Layout.fillWidth: true
                    text: {
                        if (!bodyRoot.s) return "";
                        if (bodyRoot.s.poolDisabled)
                            return "状态异常，请联系插件作者处理，或等待下期组队";
                        const minutes = Number(bodyRoot.s.poolRetryMinutes || 0);
                        const tip = minutes > 0 ? "，约 " + minutes + " 分钟后重试" : "，即将重试";
                        return "码池暂时不可用，自动重试中（暂时无法自动加入他人队伍）" + tip;
                    }
                    font: Theme.font(12, Theme.regularWeight)
                    color: Theme.secondaryText
                    wrapMode: Text.Wrap
                }
                // 身份校验被停用是本地可恢复的：站长在码池解除绑定后，一键清除
                // 本地停用标记并立即重发快照（网络类停用走自动退避，不提供此按钮）
                EchoButton {
                    visible: bodyRoot.s && bodyRoot.s.poolDisabled
                    text: "解除停用并重试"
                    accent: false
                    loading: bodyRoot.lastCommand === "pool-retry" && !!bodyRoot.pending
                             && bodyRoot.pending.state === 1
                    onClicked: bodyRoot.run("pool-retry", {})
                }
            }

            RowLayout {
                id: messageLine
                Layout.fillWidth: true
                visible: bodyRoot.s && bodyRoot.s.lastMessage
                spacing: 8
                Label {
                    Layout.fillWidth: true
                    text: bodyRoot.s ? String(bodyRoot.s.lastMessage || "") : ""
                    font: Theme.font(12, Theme.regularWeight)
                    color: Theme.colors.warning
                    wrapMode: Text.Wrap
                }
                EchoButton {
                    visible: bodyRoot.s && bodyRoot.s.lastError
                    text: "复制"
                    accent: false
                    onClicked: bodyRoot.run("error-detail", {})
                }
            }
        }
    }

    // 字符串结果（copy-created / copy-joined 返回队伍码、error-detail 返回详情）进剪贴板；
    // 手动入队成功后清空输入框，与旧插件行为一致
    Connections {
        target: bodyRoot.pending
        function onCompleted(): void {
            if (!bodyRoot.pending) return;
            if (bodyRoot.pending.state === 3) {
                bodyRoot.plugin.toast.warning(
                    '操作失败：' + (bodyRoot.pending.errorMessage || bodyRoot.pending.errorCode));
                return;
            }
            if (bodyRoot.pending.state !== 2) return;
            const result = bodyRoot.pending.result;
            if (typeof result === "string" && result.length > 0) {
                bodyRoot.copyText(
                    result,
                    bodyRoot.lastCommand === "error-detail" ? "错误详情已复制" : "组队码已复制");
            }
            if (bodyRoot.lastCommand === "join-manual" && result && result.ok === true)
                manualCode.clear();
        }
    }
}

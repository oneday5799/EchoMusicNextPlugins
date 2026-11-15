pragma ComponentBehavior: Bound
import QtQuick
import EchoMusic.Controls
import EchoMusic.PluginSdk

// 宿主右缘歌词工具列追加的评论/分享入口（对齐旧 web 版插件的 side-tools 传送按钮）。
// 插入点选 lyricOffsetAction-0（重置偏移的常驻槽位）：位于偏移组之后、译/音/复制
// 组之前，且不受第二组"有歌词才可见"的显隐影响。
// 宿主挂载时注入 page（playback surface 视图上下文），命令通道与皮肤信息行一致。
Column {
    id: sideActions

    required property EchoPluginContext plugin
    required property EchoUiPartRef part
    required property EchoPluginViewContext page

    spacing: 8

    EchoSoftButton {
        id: commentsAction

        implicitWidth: 36
        implicitHeight: 36
        leftPadding: 8
        rightPadding: 8
        colors: EchoUiPartPalette {
            part: sideActions.part
        }
        glyphSize: 14
        glyph: "message-circle"
        text: ""
        Accessible.name: qsTr("查看评论")
        EchoToolTip {
            parent: commentsAction
            text: commentsAction.Accessible.name
            requestedVisible: commentsAction.hovered
        }
        onClicked: sideActions.page.command("comments", {
            "revision": sideActions.page.player.revision
        })
    }

    EchoSoftButton {
        id: shareAction

        implicitWidth: 36
        implicitHeight: 36
        leftPadding: 8
        rightPadding: 8
        colors: EchoUiPartPalette {
            part: sideActions.part
        }
        glyphSize: 14
        glyph: "share"
        text: ""
        Accessible.name: qsTr("分享")
        EchoToolTip {
            parent: shareAction
            text: shareAction.Accessible.name
            requestedVisible: shareAction.hovered
        }
        onClicked: sideActions.page.command("share", {
            "revision": sideActions.page.player.revision
        })
    }
}

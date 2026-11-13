pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import EchoMusic.PluginSdk
import EchoMusic.Controls
import EchoMusic.Theme

// Confirmation body for "清除插件缓存", mirroring the host 清除应用数据
// dialog: plain description, cancel and a danger confirm in a right-aligned
// footer row.
Item {
    id: dialogRoot

    required property EchoPluginContext plugin
    required property EchoPluginDialog dialog

    property bool busy: false

    readonly property string description: "此操作将移除平铺扫描列表、播放时持久化的歌曲资料与在线歌词，下次扫描或播放时重新生成，无法撤销。库配置与设置不受影响。"

    implicitHeight: body.implicitHeight

    ColumnLayout {
        id: body
        anchors.left: parent.left
        anchors.right: parent.right
        spacing: 18

        Label {
            Layout.fillWidth: true
            text: dialogRoot.description
            textFormat: Text.PlainText
            font: Theme.font(13, Theme.regularWeight)
            color: Theme.floatingText
            wrapMode: Text.Wrap
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: 12

            Item {
                Layout.fillWidth: true
            }
            EchoSoftButton {
                text: "取消"
                colors: Theme.floating
                enabled: !dialogRoot.busy
                onClicked: dialogRoot.dialog.close()
            }
            EchoSoftButton {
                objectName: "webdavClearCacheConfirm"
                text: dialogRoot.busy ? "清除中…" : "确认清除"
                danger: true
                colors: Theme.floating
                enabled: !dialogRoot.busy
                onClicked: dialogRoot.clearNow()
            }
        }
    }

    function clearNow() {
        const operation = plugin.executeCommand('flat.clear', {});
        if (!operation) {
            plugin.toast.warning("无法执行清除操作");
            dialog.close();
            return;
        }
        busy = true;
        const handler = function () {
            operation.completed.disconnect(handler);
            busy = false;
            dialog.close();
            if (operation.state === 2) {
                const result = operation.result || {};
                const flats = typeof result.flats === 'number' ? result.flats : 0;
                const enrichments = typeof result.enrichments === 'number' ? result.enrichments : 0;
                const lyrics = typeof result.lyrics === 'number' ? result.lyrics : 0;
                plugin.toast.success(`已清除 ${flats} 个库的扫描列表、${enrichments} 条歌曲资料、${lyrics} 条歌词缓存`);
            } else if (operation.state === 3) {
                plugin.toast.danger(operation.errorMessage || "清除失败");
            }
        };
        operation.completed.connect(handler);
    }
}

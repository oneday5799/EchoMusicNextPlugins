pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import EchoMusic.PluginSdk
import EchoMusic.Controls
import EchoMusic.Theme

// Plugin settings, hosted by both the registerSettings dialog and the
// browser page's settings dialog, which already scroll: this column must
// stay a plain layout without nested scrolling. Layout follows the host
// settings pages: icon + heading above a muted card, rows inside the card
// separated by hairline dividers.
// Folder add/remove/rename and the tag rows (toggle + dropdown) persist
// immediately — there is deliberately no draft/save pair to keep the grant
// ledger and the settings store in sync.
ColumnLayout {
    id: settingsRoot
    objectName: "localMusicSettings"

    required property EchoPluginContext plugin
    property var folders: []
    property bool readEmbeddedFlag: true
    // Online completion scope: "off" | "play" | "scan"; the stored value is
    // normalized by the backend, so this only ever holds a valid mode.
    property string onlineMode: "play"
    property int busy: 0
    property string errorMessage: ""
    readonly property bool saving: busy > 0
    /** Folder id currently being renamed inline. */
    property string editingId: ""
    property string editingName: ""
    /** Last settings revision seen; a change means folders were updated
     * from outside this page (e.g. storage recovered after activation). */
    property int lastSettingsRevision: -1

    spacing: 16

    function run(name, args, callback) {
        const operation = plugin.executeCommand(name, args || {});
        if (!operation) {
            // A null operation (usually deactivation) must still settle the
            // request, same contract as BrowserPage's run().
            if (callback)
                callback(null);
            return;
        }
        busy += 1;
        const handler = function () {
            operation.completed.disconnect(handler);
            busy -= 1;
            if (operation.state === 2) {
                if (callback)
                    callback(operation.result);
            } else if (operation.state === 3) {
                errorMessage = operation.errorMessage || "操作失败";
            }
        };
        operation.completed.connect(handler);
    }

    /** Host-delivered JSON arrays can cross the FFI without the JS Array
     * prototype (Array.isArray false, .map missing), so recover result
     * arrays explicitly instead of trusting the type check. */
    function asArray(value) {
        if (Array.isArray(value))
            return value;
        if (!value || typeof value !== "object")
            return [];
        if (typeof value.length === "number") {
            const rows = [];
            for (let i = 0; i < value.length; i++)
                rows.push(value[i]);
            return rows;
        }
        const keys = Object.keys(value)
            .filter(function (key) {
                return /^(0|[1-9]\d*)$/.test(key);
            })
            .map(Number)
            .sort(function (a, b) {
                return a - b;
            });
        const rows = [];
        for (let i = 0; i < keys.length; i++)
            rows.push(value[keys[i]]);
        return rows;
    }

    function loadFolders() {
        run("library.settings.get", {}, function (result) {
            folders = result ? asArray(result.folders) : [];
            readEmbeddedFlag = !result || result.readEmbedded !== false;
            onlineMode = result && typeof result.onlineMode === "string"
                         && result.onlineMode.length > 0 ? result.onlineMode : "play";
        });
    }

    function folderById(id) {
        for (let i = 0; i < folders.length; i++) {
            if (folders[i].id === id)
                return folders[i];
        }
        return null;
    }

    function addFolder() {
        errorMessage = "";
        run("folders.add", {}, function (result) {
            if (result && result.canceled)
                return;
            if (result && result.duplicate) {
                plugin.toast.info(result.message || "该文件夹已在列表中");
                return;
            }
            if (result && result.ok) {
                plugin.toast.success(`已添加「${result.name || "音乐文件夹"}」`);
                plugin.toast.info("回到「本地音乐」页面点击「扫描」建立曲库");
            }
            loadFolders();
        });
    }

    function removeFolder(id) {
        errorMessage = "";
        run("folders.remove", {
            id: id
        }, function (result) {
            if (result && result.ok)
                plugin.toast.success("已移除文件夹");
            loadFolders();
        });
    }

    function commitRename() {
        if (!editingId)
            return;
        const id = editingId;
        const name = editingName.trim();
        editingId = "";
        editingName = "";
        run("folders.rename", {
            id: id,
            name: name
        }, function () {
            loadFolders();
        });
    }

    function patchFlag(value) {
        errorMessage = "";
        const previous = readEmbeddedFlag;
        readEmbeddedFlag = value === true;
        run("library.settings.patch", {
            readEmbedded: value
        }, function (result) {
            // The switch flipped optimistically; restore the stored value
            // when the patch failed so it never lies about the state.
            if (!result)
                readEmbeddedFlag = previous;
        });
    }

    /** Same optimistic patch for the completion dropdown: the selection
     * updates at once and reverts when the backend rejects it. */
    function patchOnlineMode(value) {
        errorMessage = "";
        const previous = onlineMode;
        onlineMode = value;
        run("library.settings.patch", {
            onlineMode: value
        }, function (result) {
            if (!result)
                onlineMode = previous;
        });
    }

    /** Host-style destructive action: the danger button opens a confirmation
     * dialog; the dialog body runs the clear command itself. */
    function confirmClearCache() {
        const operation = plugin.ui.showDialog({
            component: "ClearCacheDialog.qml",
            width: 460,
            title: "确认清除缓存的封面和歌词？"
        });
        if (!operation)
            return;
        const handler = function () {
            operation.completed.disconnect(handler);
            if (operation.state === 3)
                plugin.toast.danger(operation.errorMessage || "无法打开确认对话框");
        };
        operation.completed.connect(handler);
    }

    Component.onCompleted: {
        const state = plugin.ui.state;
        if (state && typeof state.settingsRevision === "number")
            lastSettingsRevision = state.settingsRevision;
        loadFolders();
    }

    Connections {
        target: settingsRoot.plugin.ui
        function onStateChanged() {
            const state = settingsRoot.plugin.ui.state;
            const revision = state && typeof state.settingsRevision === "number"
                ? state.settingsRevision : -1;
            if (revision >= 0 && revision !== settingsRoot.lastSettingsRevision) {
                settingsRoot.lastSettingsRevision = revision;
                settingsRoot.loadFolders();
            }
        }
    }

    SettingsSection {
        Layout.fillWidth: true
        heading: "音乐文件夹"
        glyph: "folder-open"

        Repeater {
            model: settingsRoot.folders.map(function (folder) {
                return folder.id;
            })

            delegate: ColumnLayout {
                id: folderGroup
                required property int index
                required property string modelData
                Layout.fillWidth: true
                spacing: 0

                readonly property var folder: settingsRoot.folderById(modelData) || {}
                readonly property bool editing: settingsRoot.editingId === modelData

                // Hairline between consecutive folder rows; the margins put
                // it in the middle of the card column's 20px row rhythm.
                EchoDivider {
                    Layout.fillWidth: true
                    Layout.bottomMargin: 20
                    visible: folderGroup.index > 0
                    lineColor: Theme.withAlpha(Theme.floatingText, 0.12)
                }

                RowLayout {
                    Layout.fillWidth: true
                    Layout.minimumWidth: 0
                    spacing: 12

                    EchoIcon {
                        name: folderGroup.folder.available === false ? "alert-circle" : "folder-open"
                        color: folderGroup.folder.available === false ? Theme.colors.danger : Theme.accent
                        Layout.preferredWidth: 20
                        Layout.preferredHeight: 20
                    }
                    ColumnLayout {
                        Layout.fillWidth: true
                        Layout.minimumWidth: 0
                        spacing: 4

                        Label {
                            Layout.fillWidth: true
                            text: folderGroup.folder.name && folderGroup.folder.name.length > 0 ? folderGroup.folder.name : `文件夹 ${folderGroup.index + 1}`
                            textFormat: Text.PlainText
                            font: Theme.font(13, Theme.semiboldWeight)
                            color: Theme.floatingText
                            elide: Text.ElideRight
                        }
                        Label {
                            Layout.fillWidth: true
                            text: folderGroup.folder.path || "位置未知"
                            textFormat: Text.PlainText
                            font: Theme.font(12, Theme.regularWeight)
                            color: Theme.floatingSecondaryText
                            elide: Text.ElideMiddle
                        }
                    }
                    EchoTag {
                        visible: folderGroup.folder.available === false
                        text: "不可用"
                        tone: EchoTag.Neutral
                    }
                    EchoSoftButton {
                        visible: !folderGroup.editing
                        text: "重命名"
                        size: EchoControlSize.Small
                        colors: Theme.floating
                        foreground: Theme.floating.text
                        onClicked: {
                            settingsRoot.editingId = folderGroup.modelData;
                            settingsRoot.editingName = folderGroup.folder.name || "";
                        }
                    }
                    EchoIconButton {
                        glyph: "trash"
                        tooltipText: "移除此文件夹"
                        onClicked: settingsRoot.removeFolder(folderGroup.modelData)
                    }
                }
                SettingRow {
                    Layout.fillWidth: true
                    Layout.topMargin: 12
                    visible: folderGroup.editing
                    heading: "显示名称"
                    description: "留空时显示文件夹路径"

                    EchoTextField {
                        Layout.preferredWidth: 160
                        text: settingsRoot.editingName
                        placeholderText: "显示名称"
                        onTextEdited: settingsRoot.editingName = text
                        onAccepted: settingsRoot.commitRename()
                    }
                    EchoButton {
                        text: "确定"
                        accent: false
                        size: EchoControlSize.Small
                        onClicked: settingsRoot.commitRename()
                    }
                    EchoButton {
                        text: "取消"
                        accent: false
                        size: EchoControlSize.Small
                        onClicked: {
                            settingsRoot.editingId = "";
                            settingsRoot.editingName = "";
                        }
                    }
                }
            }
        }

        Label {
            Layout.fillWidth: true
            visible: settingsRoot.folders.length === 0
            text: "尚未添加音乐文件夹。"
            textFormat: Text.PlainText
            font: Theme.font(12, Theme.regularWeight)
            color: Theme.floatingSecondaryText
            wrapMode: Text.Wrap
        }

        EchoDivider {
            Layout.fillWidth: true
            visible: settingsRoot.folders.length > 0
            lineColor: Theme.withAlpha(Theme.floatingText, 0.12)
        }

        SettingRow {
            Layout.fillWidth: true
            heading: "添加文件夹"
            description: "添加多个文件夹建立曲库；改动即时保存，新增后需扫描"

            EchoSoftButton {
                text: "添加"
                glyph: "plus"
                glyphSize: 12
                colors: Theme.floating
                foreground: Theme.floating.text
                onClicked: settingsRoot.addFolder()
            }
        }
    }

    SettingsSection {
        Layout.fillWidth: true
        heading: "标签与补全"
        glyph: "tags"

        SettingRow {
            Layout.fillWidth: true
            heading: "读取内嵌封面与歌词"
            description: "从音频文件头部解析内嵌封面与歌词；关闭后仅使用文件夹图片与在线补全"

            EchoSwitch {
                checked: settingsRoot.readEmbeddedFlag
                Accessible.name: "读取内嵌封面与歌词"
                onToggled: settingsRoot.patchFlag(checked)
            }
        }

        EchoDivider {
            Layout.fillWidth: true
            lineColor: Theme.withAlpha(Theme.floatingText, 0.12)
        }

        SettingRow {
            Layout.fillWidth: true
            heading: "在线补全封面与歌词"
            description: "缺少内嵌与文件夹封面，或没有本地歌词时，从在线曲库检索补全；播放补全仅当前歌曲，扫描补全另含扫描时的专辑封面兜底"

            // Same dropdown pattern as the host settings' 深浅色模式 row:
            // an EchoSelect at 144px on the row's trailing slot.
            EchoSelect {
                id: onlineModeSelect
                colors: Theme.floating
                Layout.preferredWidth: 144
                readonly property var modes: ["off", "play", "scan"]
                model: ["关闭补全", "播放补全", "扫描补全"]
                currentIndex: {
                    const at = settingsRoot.onlineMode !== ""
                                ? onlineModeSelect.modes.indexOf(settingsRoot.onlineMode) : -1;
                    return at >= 0 ? at : onlineModeSelect.modes.indexOf("play");
                }
                Accessible.name: "在线补全封面与歌词"
                onActivated: index => settingsRoot.patchOnlineMode(onlineModeSelect.modes[index])
            }
        }

        EchoDivider {
            Layout.fillWidth: true
            lineColor: Theme.withAlpha(Theme.floatingText, 0.12)
        }

        SettingRow {
            Layout.fillWidth: true
            heading: "清除缓存的封面和歌词"
            description: "移除扫描与播放时持久化的封面图片与在线歌词，曲库与设置不受影响"

            EchoSoftButton {
                text: "立即清除"
                danger: true
                enabled: !settingsRoot.saving
                colors: Theme.floating
                onClicked: settingsRoot.confirmClearCache()
            }
        }
    }

    Label {
        Layout.fillWidth: true
        visible: settingsRoot.errorMessage.length > 0
        text: settingsRoot.errorMessage
        textFormat: Text.PlainText
        font: Theme.font(11, Theme.regularWeight)
        color: Theme.colors.danger
        wrapMode: Text.Wrap
    }
}

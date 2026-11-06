pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import EchoMusic.PluginSdk
import EchoMusic.Controls
import EchoMusic.Theme

// Plugin settings, hosted by the shared settings dialog which already
// scrolls: this column must stay a plain layout without nested scrolling.
// Folder add/remove/rename and both switches persist immediately — there is
// deliberately no draft/save pair to keep the grant ledger and the settings
// store in sync.
ColumnLayout {
    id: settingsRoot
    objectName: "localMusicSettings"

    required property EchoPluginContext plugin
    property var folders: []
    property bool readEmbeddedFlag: true
    property bool onlineFetchFlag: false
    property int busy: 0
    property string errorMessage: ""
    readonly property bool saving: busy > 0
    /** Folder id currently being renamed inline. */
    property string editingId: ""
    property string editingName: ""
    /** Last settings revision seen; a change means folders were updated
     * from outside this page (e.g. storage recovered after activation). */
    property int lastSettingsRevision: -1

    spacing: 14

    function run(name, args, callback) {
        const operation = plugin.executeCommand(name, args || {});
        if (!operation)
            return;
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
            onlineFetchFlag = !!result && result.onlineFetch === true;
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
                plugin.toast.info("回到「本地音乐」页面点击「重新扫描」建立曲库");
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

    function patchFlag(key, value) {
        errorMessage = "";
        if (key === "readEmbedded")
            readEmbeddedFlag = value === true;
        else if (key === "onlineFetch")
            onlineFetchFlag = value === true;
        const args = {};
        args[key] = value;
        run("library.settings.patch", args, null);
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

    Rectangle {
        Layout.fillWidth: true
        radius: 16
        color: Theme.floating.elevated
        border.color: Theme.floatingBorder
        implicitHeight: Math.max(80, overview.implicitHeight + 28)

        RowLayout {
            id: overview
            anchors.fill: parent
            anchors.margins: 14
            spacing: 14

            Rectangle {
                Layout.preferredWidth: 52
                Layout.preferredHeight: 52
                radius: 16
                color: "#4f7cf0"

                EchoIcon {
                    anchors.centerIn: parent
                    name: "music"
                    color: "#ffffff"
                    width: 26
                    height: 26
                }
            }

            ColumnLayout {
                Layout.fillWidth: true
                spacing: 4

                Label {
                    text: "本地音乐"
                    font: Theme.font(13, 700)
                    color: Theme.floatingText
                }
                Label {
                    Layout.fillWidth: true
                    text: "扫描本地文件夹中的音乐，读取标签、封面与歌词；歌曲与专辑两种视图。"
                    font: Theme.font(12, Theme.regularWeight)
                    color: Theme.floatingSecondaryText
                    wrapMode: Text.Wrap
                }
            }

            EchoTag {
                text: `${settingsRoot.folders.length} 个文件夹`
                tone: EchoTag.Neutral
            }
        }
    }

    SettingsSection {
        Layout.fillWidth: true
        heading: "音乐文件夹"
        subtitle: "添加多个文件夹建立曲库；移除或重命名立即生效，新增后需重新扫描"

        trailing: Component {
            EchoButton {
                text: "添加文件夹"
                glyph: "plus"
                accent: false
                onClicked: settingsRoot.addFolder()
            }
        }

        body: Component {
            ColumnLayout {
                spacing: 0

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

                        Item {
                            Layout.fillWidth: true
                            implicitHeight: 52

                            RowLayout {
                                anchors.fill: parent
                                anchors.leftMargin: 18
                                anchors.rightMargin: 18
                                spacing: 10

                                EchoIcon {
                                    name: folderGroup.folder.available === false ? "alert-circle" : "folder-open"
                                    color: folderGroup.folder.available === false ? Theme.colors.danger : Theme.accent
                                    Layout.preferredWidth: 20
                                    Layout.preferredHeight: 20
                                }
                                ColumnLayout {
                                    Layout.fillWidth: true
                                    spacing: 2

                                    Label {
                                        Layout.fillWidth: true
                                        text: folderGroup.folder.name && folderGroup.folder.name.length > 0 ? folderGroup.folder.name : `文件夹 ${folderGroup.index + 1}`
                                        font: Theme.font(13, 650)
                                        color: Theme.floatingText
                                        elide: Text.ElideRight
                                    }
                                    Label {
                                        Layout.fillWidth: true
                                        text: folderGroup.folder.path || "位置未知"
                                        font: Theme.font(11, Theme.regularWeight)
                                        color: Theme.floatingSecondaryText
                                        elide: Text.ElideMiddle
                                    }
                                }
                                EchoTag {
                                    visible: folderGroup.folder.available === false
                                    text: "不可用"
                                    tone: EchoTag.Neutral
                                }
                                EchoButton {
                                    visible: !folderGroup.editing
                                    text: "重命名"
                                    accent: false
                                    size: EchoControlSize.Small
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
                        }
                        SettingRow {
                            Layout.fillWidth: true
                            visible: folderGroup.editing
                            title: "显示名称"
                            hint: "留空时显示文件夹路径"

                            editor: Component {
                                RowLayout {
                                    spacing: 8

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
                    }
                }

                Label {
                    Layout.fillWidth: true
                    visible: settingsRoot.folders.length === 0
                    text: "尚未添加音乐文件夹。"
                    font: Theme.font(12, Theme.regularWeight)
                    color: Theme.floatingSecondaryText
                    wrapMode: Text.Wrap
                }
            }
        }
    }

    SettingsSection {
        Layout.fillWidth: true
        heading: "标签与补全"
        subtitle: "标签来自宿主元数据读取；封面依次尝试内嵌图片、文件夹图片与在线曲库"
    }

    SettingRow {
        Layout.fillWidth: true
        title: "读取内嵌封面与歌词"
        hint: "从音频文件头部解析内嵌封面与歌词；关闭后仅使用文件夹图片与在线补全"

        switchRow: true
        editor: Component {
            EchoSwitch {
                checked: settingsRoot.readEmbeddedFlag
                Accessible.name: "读取内嵌封面与歌词"
                onToggled: settingsRoot.patchFlag("readEmbedded", checked)
            }
        }
    }

    SettingRow {
        Layout.fillWidth: true
        title: "在线补全封面与歌词"
        hint: "缺少内嵌与文件夹封面，或没有本地歌词时，从在线曲库检索补全"

        switchRow: true
        editor: Component {
            EchoSwitch {
                checked: settingsRoot.onlineFetchFlag
                Accessible.name: "在线补全封面与歌词"
                onToggled: settingsRoot.patchFlag("onlineFetch", checked)
            }
        }
    }

    Label {
        Layout.fillWidth: true
        text: "开关与文件夹改动即时保存；内嵌与在线补全开关对封面整理在下次扫描时生效，歌词与播放封面按当前开关即时生效。"
        font: Theme.font(12, Theme.regularWeight)
        color: Theme.floatingSecondaryText
        wrapMode: Text.Wrap
    }

    Label {
        Layout.fillWidth: true
        visible: settingsRoot.errorMessage.length > 0
        text: settingsRoot.errorMessage
        font: Theme.font(12, Theme.regularWeight)
        color: Theme.colors.danger
        wrapMode: Text.Wrap
    }
}

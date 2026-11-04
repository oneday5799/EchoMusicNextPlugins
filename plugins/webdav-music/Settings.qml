pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import EchoMusic.PluginSdk
import EchoMusic.Controls
import EchoMusic.Theme

// Plugin settings, hosted by the shared settings dialog which already
// scrolls: this column must stay a plain layout without nested scrolling.
ColumnLayout {
    id: settingsRoot
    objectName: "webdavMusicSettings"

    required property EchoPluginContext plugin
    property var draft: null
    property int busy: 0
    property string errorMessage: ""
    readonly property bool saving: busy > 0
    // Repeater model holds library ids only and is re-synced exclusively on
    // add/remove/load; field edits replace `draft` but must never reassign
    // the model, or Qt would rebuild every delegate and drop the focused
    // text field after the first keystroke.
    property var libraryIds: []
    /** Library id -> expanded, mirroring the legacy plugin's collapsible groups. */
    property var expandedLibraries: ({})

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

    function loadDraft() {
        run("settings.get", {}, function (result) {
            draft = result || {
                libraries: [],
                activeLibraryId: null,
                coverLyricSource: "embedded"
            };
            syncLibraryIds();
        });
    }

    function syncLibraryIds() {
        const ids = draft && Array.isArray(draft.libraries) ? draft.libraries.map(function (library) {
            return library.id;
        }) : [];
        const same = libraryIds.length === ids.length && ids.every(function (id, index) {
            return id === libraryIds[index];
        });
        if (!same)
            libraryIds = ids;
    }

    function libraryById(id) {
        if (!draft || !Array.isArray(draft.libraries))
            return null;
        for (let i = 0; i < draft.libraries.length; i++) {
            if (draft.libraries[i].id === id)
                return draft.libraries[i];
        }
        return null;
    }

    function updateDraft(patch) {
        draft = Object.assign({}, draft, patch);
    }

    function updateLibrary(id, key, value) {
        if (!draft || !Array.isArray(draft.libraries))
            return;
        const libraries = [];
        let changed = false;
        for (let i = 0; i < draft.libraries.length; i++) {
            const library = draft.libraries[i];
            if (library.id !== id || library[key] === value) {
                libraries.push(library);
                continue;
            }
            const next = Object.assign({}, library);
            next[key] = value;
            libraries.push(next);
            changed = true;
        }
        if (changed)
            updateDraft({
                libraries: libraries
            });
    }

    function toggleLibraryExpanded(id) {
        const next = Object.assign({}, expandedLibraries);
        if (next[id])
            delete next[id];
        else
            next[id] = true;
        expandedLibraries = next;
    }

    function hostOf(url) {
        const text = String(url || "");
        const start = text.indexOf("://");
        const rest = start >= 0 ? text.slice(start + 3) : text;
        const cut = rest.indexOf("/");
        return (cut >= 0 ? rest.slice(0, cut) : rest).trim();
    }

    function addLibrary() {
        if (!draft)
            return;
        const libraries = Array.isArray(draft.libraries) ? draft.libraries.slice() : [];
        const id = `lib-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(36)}`;
        libraries.push({
            id: id,
            name: "",
            serverUrl: "",
            username: "",
            password: "",
            rootPath: "/",
            flatView: false
        });
        updateDraft({
            libraries: libraries,
            activeLibraryId: draft.activeLibraryId || id
        });
        expandedLibraries = Object.assign({}, expandedLibraries, {
            [id]: true
        });
        syncLibraryIds();
    }

    function removeLibrary(id) {
        if (!draft || !Array.isArray(draft.libraries))
            return;
        const removed = draft.libraries.filter(function (library) {
            return library.id === id;
        })[0];
        const libraries = draft.libraries.filter(function (library) {
            return library.id !== id;
        });
        const patch = {
            libraries: libraries
        };
        if (removed && draft.activeLibraryId === removed.id)
            patch.activeLibraryId = libraries.length > 0 ? libraries[0].id : null;
        updateDraft(patch);
        if (removed) {
            const next = Object.assign({}, expandedLibraries);
            delete next[removed.id];
            expandedLibraries = next;
        }
        syncLibraryIds();
    }

    function save() {
        errorMessage = "";
        run("settings.patch", draft, function () {
            plugin.toast.success("WebDAV 设置已保存");
            loadDraft();
        });
    }

    Component.onCompleted: loadDraft()

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
                color: "#66ccff"

                EchoIcon {
                    anchors.centerIn: parent
                    name: "cloud"
                    color: "#ffffff"
                    width: 26
                    height: 26
                }
            }

            ColumnLayout {
                Layout.fillWidth: true
                spacing: 4

                Label {
                    text: "WebDAV 音乐"
                    font: Theme.font(13, 700)
                    color: Theme.floatingText
                }
                Label {
                    Layout.fillWidth: true
                    text: "连接 WebDAV 服务器，浏览、搜索并播放网盘音乐；歌词与封面来自音频内嵌标签或酷狗资料。"
                    font: Theme.font(12, Theme.regularWeight)
                    color: Theme.floatingSecondaryText
                    wrapMode: Text.Wrap
                }
            }

            EchoTag {
                text: `${settingsRoot.libraryIds.length} 个库`
                tone: EchoTag.Neutral
            }
        }
    }

    SettingsSection {
        Layout.fillWidth: true
        heading: "音乐库"
        subtitle: "支持添加多个 WebDAV 服务器，当前库决定侧边栏页面展示的内容"

        trailing: Component {
            EchoButton {
                text: "添加音乐库"
                glyph: "plus"
                accent: false
                onClicked: settingsRoot.addLibrary()
            }
        }

        body: Component {
            ColumnLayout {
                spacing: 0

                Repeater {
                    model: settingsRoot.libraryIds

                    delegate: ColumnLayout {
                        id: libraryGroup
                        required property int index
                        required property string modelData
                        Layout.fillWidth: true
                        spacing: 0

                        // Re-read from the live draft on every change so field
                        // edits flow into headers and editors without the
                        // delegate itself being recreated.
                        readonly property var lib: settingsRoot.libraryById(modelData) || ({})
                        readonly property bool isActive: settingsRoot.draft && settingsRoot.draft.activeLibraryId === modelData
                        readonly property bool expanded: !!settingsRoot.expandedLibraries[modelData]

                        Item {
                            Layout.fillWidth: true
                            implicitHeight: 48

                            Rectangle {
                                anchors.left: parent.left
                                anchors.right: parent.right
                                anchors.top: parent.top
                                height: 1
                                color: Theme.floatingBorder
                                visible: libraryGroup.index > 0
                            }
                            Rectangle {
                                anchors.fill: parent
                                color: Theme.rowHover
                                visible: headerArea.containsMouse
                            }
                            MouseArea {
                                id: headerArea
                                anchors.fill: parent
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: settingsRoot.toggleLibraryExpanded(libraryGroup.modelData)
                            }
                            RowLayout {
                                anchors.fill: parent
                                anchors.leftMargin: 18
                                anchors.rightMargin: 18
                                spacing: 8

                                EchoIcon {
                                    name: "chevron-down"
                                    color: Theme.iconSecondary
                                    Layout.preferredWidth: 16
                                    Layout.preferredHeight: 16
                                    rotation: libraryGroup.expanded ? 0 : -90
                                    Behavior on rotation {
                                        NumberAnimation {
                                            duration: 150
                                            easing.type: Easing.OutCubic
                                        }
                                    }
                                }
                                Label {
                                    Layout.fillWidth: true
                                    text: libraryGroup.lib.name && libraryGroup.lib.name.length > 0 ? libraryGroup.lib.name : `库 ${libraryGroup.index + 1}`
                                    font: Theme.font(13, 650)
                                    color: Theme.floatingText
                                    elide: Text.ElideRight
                                }
                                Label {
                                    readonly property string host: settingsRoot.hostOf(libraryGroup.lib.serverUrl)
                                    visible: host.length > 0
                                    text: host
                                    font: Theme.font(12, Theme.regularWeight)
                                    color: Theme.floatingSecondaryText
                                    elide: Text.ElideMiddle
                                }
                                EchoTag {
                                    visible: libraryGroup.isActive
                                    text: "当前"
                                    tone: EchoTag.Accent
                                }
                                EchoButton {
                                    text: "设为当前"
                                    accent: false
                                    size: EchoControlSize.Small
                                    visible: !libraryGroup.isActive
                                    onClicked: settingsRoot.updateDraft({
                                        activeLibraryId: libraryGroup.modelData
                                    })
                                }
                                EchoIconButton {
                                    glyph: "trash"
                                    tooltipText: "删除此库"
                                    onClicked: settingsRoot.removeLibrary(libraryGroup.modelData)
                                }
                            }
                        }
                        SettingRow {
                            Layout.fillWidth: true
                            visible: libraryGroup.expanded
                            title: "服务器地址"
                            hint: "以 https:// 或 http:// 开头，例如 https://dav.example.com"

                            editor: Component {
                                EchoTextField {
                                    text: libraryGroup.lib.serverUrl || ""
                                    placeholderText: "https://dav.example.com"
                                    onTextEdited: settingsRoot.updateLibrary(libraryGroup.modelData, "serverUrl", text)
                                }
                            }
                        }
                        SettingRow {
                            Layout.fillWidth: true
                            visible: libraryGroup.expanded
                            title: "名称"
                            hint: "留空时显示服务器地址"

                            editor: Component {
                                EchoTextField {
                                    text: libraryGroup.lib.name || ""
                                    placeholderText: "显示名称"
                                    onTextEdited: settingsRoot.updateLibrary(libraryGroup.modelData, "name", text)
                                }
                            }
                        }
                        SettingRow {
                            Layout.fillWidth: true
                            visible: libraryGroup.expanded
                            title: "用户名"
                            hint: "留空则按匿名方式访问"

                            editor: Component {
                                EchoTextField {
                                    text: libraryGroup.lib.username || ""
                                    placeholderText: "可留空"
                                    onTextEdited: settingsRoot.updateLibrary(libraryGroup.modelData, "username", text)
                                }
                            }
                        }
                        SettingRow {
                            Layout.fillWidth: true
                            visible: libraryGroup.expanded
                            title: "密码"
                            hint: "仅保存在本机插件存储中"

                            editor: Component {
                                EchoTextField {
                                    echoMode: TextInput.Password
                                    text: libraryGroup.lib.password || ""
                                    placeholderText: "可留空"
                                    onTextEdited: settingsRoot.updateLibrary(libraryGroup.modelData, "password", text)
                                }
                            }
                        }
                        SettingRow {
                            Layout.fillWidth: true
                            visible: libraryGroup.expanded
                            title: "根目录"
                            hint: "从服务器的哪个目录开始浏览"

                            editor: Component {
                                EchoTextField {
                                    text: libraryGroup.lib.rootPath || "/"
                                    placeholderText: "/"
                                    onTextEdited: settingsRoot.updateLibrary(libraryGroup.modelData, "rootPath", text)
                                }
                            }
                        }
                        SettingRow {
                            Layout.fillWidth: true
                            visible: libraryGroup.expanded
                            title: "平铺视图"
                            hint: "递归扫描全部子目录，生成可搜索的整库列表"

                            switchRow: true
                            editor: Component {
                                EchoSwitch {
                                    checked: libraryGroup.lib.flatView === true
                                    Accessible.name: "平铺视图"
                                    onToggled: settingsRoot.updateLibrary(libraryGroup.modelData, "flatView", checked)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    SettingsSection {
        Layout.fillWidth: true
        heading: "歌词与封面"
        subtitle: "内嵌标签读取音频文件自带的封面与歌词；酷狗资料在线匹配封面、专辑与歌词"

        trailing: Component {
            EchoSelect {
                colors: Theme.floating
                options: [
                    {
                        value: "embedded",
                        label: "内嵌标签优先"
                    },
                    {
                        value: "kugou",
                        label: "酷狗资料优先"
                    }
                ]
                value: settingsRoot.draft ? settingsRoot.draft.coverLyricSource : "embedded"
                onValueEdited: function (nextValue) {
                    settingsRoot.updateDraft({
                        coverLyricSource: nextValue === "kugou" ? "kugou" : "embedded"
                    });
                }
            }
        }
    }

    RowLayout {
        Layout.fillWidth: true
        spacing: 12

        Label {
            Layout.fillWidth: true
            text: settingsRoot.saving ? "正在保存…" : "修改库列表与资料来源后，点击保存才会生效。"
            font: Theme.font(12, Theme.regularWeight)
            color: Theme.floatingSecondaryText
            wrapMode: Text.Wrap
        }
        EchoButton {
            text: "重置"
            accent: false
            onClicked: settingsRoot.run("settings.reset", {}, function () {
                settingsRoot.plugin.toast.success("已恢复默认设置");
                settingsRoot.loadDraft();
            })
        }
        EchoButton {
            text: "保存"
            glyph: "check"
            accent: true
            loading: settingsRoot.saving
            onClicked: settingsRoot.save()
        }
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

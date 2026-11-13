pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import EchoMusic.PluginSdk
import EchoMusic.Controls
import EchoMusic.Theme

// Plugin settings, hosted by the shared settings dialog which already
// scrolls: this column must stay a plain layout without nested scrolling.
// Layout follows local-music and the host settings pages: icon + heading
// above a muted card, rows inside the card separated by hairline dividers.
// Library fields keep the draft/save pair (text fields need a save point);
// the single-value source dropdown patches immediately like local-music's
// completion mode, with an optimistic revert on failure.
ColumnLayout {
    id: settingsRoot
    objectName: "webdavMusicSettings"

    required property EchoPluginContext plugin
    property var draft: null
    /** A settings.get reply has landed; the save button stays disabled
     * before that so a failed or in-flight load can never be saved over
     * the stored settings with an empty draft. */
    property bool loaded: false
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
    property string coverLyricSource: "embedded"
    /** Cached scan list count (flat.info of the active library), shown in
     * the cache-management section. */
    property string cachedCountLabel: ""

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
        const keys = Object.keys(value).filter(function (key) {
            return /^(0|[1-9]\d*)$/.test(key);
        }).map(Number).sort(function (a, b) {
            return a - b;
        });
        const rows = [];
        for (let j = 0; j < keys.length; j++)
            rows.push(value[keys[j]]);
        return rows;
    }

    function loadDraft() {
        run("settings.get", {}, function (result) {
            draft = result || {
                libraries: [],
                activeLibraryId: null,
                coverLyricSource: "embedded"
            };
            if (draft && draft.libraries)
                draft.libraries = asArray(draft.libraries);
            coverLyricSource = draft && draft.coverLyricSource === "kugou" ? "kugou" : "embedded";
            loaded = true;
            syncLibraryIds();
            refreshCacheInfo();
        });
    }

    /** Cached-list summary for the cache-management section: the backend
     * answers for the active library, which is what the browser page shows. */
    function refreshCacheInfo() {
        run("flat.info", {}, function (result) {
            if (!result || typeof result.count !== "number" || result.count <= 0) {
                cachedCountLabel = "";
                return;
            }
            cachedCountLabel = `当前库已缓存 ${result.count} 首的平铺列表${result.truncated === true ? "（不完整）" : ""}`;
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
        if (!draft) {
            plugin.toast.warning("设置尚未加载完成，请稍后再试");
            loadDraft();
            return;
        }
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

    /** Optimistic single-value patch (local-music's patchOnlineMode): the
     * selection updates at once and reverts when the backend rejects it. */
    function patchCoverLyricSource(value) {
        errorMessage = "";
        const previous = coverLyricSource;
        coverLyricSource = value === "kugou" ? "kugou" : "embedded";
        run("settings.patch", {
            coverLyricSource: coverLyricSource
        }, function (result) {
            if (!result || result.ok !== true)
                coverLyricSource = previous;
        });
    }

    function save() {
        errorMessage = "";
        if (!loaded || !draft) {
            errorMessage = "设置尚未加载完成，无法保存";
            plugin.toast.warning(errorMessage);
            return;
        }
        const libraries = asArray(draft.libraries);
        for (let i = 0; i < libraries.length; i++) {
            const library = libraries[i] || {};
            const label = library.name && library.name.length > 0 ? `「${library.name}」` : `第 ${i + 1} 个库`;
            if (!library.serverUrl || String(library.serverUrl).trim().length === 0) {
                errorMessage = `${label}还没有填写服务器地址，请补全后再保存`;
                plugin.toast.warning(errorMessage);
                return;
            }
        }
        run("settings.patch", draft, function (result) {
            if (!result || result.ok !== true) {
                errorMessage = (result && result.message) || "保存失败，请重试";
                return;
            }
            plugin.toast.success("WebDAV 设置已保存");
            loadDraft();
        });
    }

    /** Host-style destructive action: the danger button opens a confirmation
     * dialog; the dialog body runs the clear command itself. */
    function confirmClearCache() {
        const operation = plugin.ui.showDialog({
            component: "ClearCacheDialog.qml",
            width: 460,
            title: "确认清除插件缓存？"
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

    Component.onCompleted: loadDraft()

    SettingsSection {
        Layout.fillWidth: true
        heading: "音乐库"
        glyph: "folder-open"

        Repeater {
            model: settingsRoot.libraryIds.map(function (id) {
                return id;
            })

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

                // Hairline between consecutive library rows; the margins put
                // it in the middle of the card column's 20px row rhythm.
                EchoDivider {
                    Layout.fillWidth: true
                    Layout.bottomMargin: 20
                    visible: libraryGroup.index > 0
                    lineColor: Theme.withAlpha(Theme.floatingText, 0.12)
                }

                RowLayout {
                    Layout.fillWidth: true
                    Layout.minimumWidth: 0
                    spacing: 12

                    EchoIcon {
                        name: libraryGroup.lib.serverUrl && libraryGroup.lib.serverUrl.length > 0 ? "cloud" : "alert-circle"
                        color: libraryGroup.lib.serverUrl && libraryGroup.lib.serverUrl.length > 0 ? Theme.accent : Theme.colors.danger
                        Layout.preferredWidth: 20
                        Layout.preferredHeight: 20
                    }
                    ColumnLayout {
                        Layout.fillWidth: true
                        Layout.minimumWidth: 0
                        spacing: 4

                        Label {
                            Layout.fillWidth: true
                            text: libraryGroup.lib.name && libraryGroup.lib.name.length > 0 ? libraryGroup.lib.name : `库 ${libraryGroup.index + 1}`
                            textFormat: Text.PlainText
                            font: Theme.font(13, Theme.semiboldWeight)
                            color: Theme.floatingText
                            elide: Text.ElideRight
                        }
                        Label {
                            Layout.fillWidth: true
                            text: libraryGroup.lib.serverUrl && libraryGroup.lib.serverUrl.length > 0 ? settingsRoot.hostOf(libraryGroup.lib.serverUrl) : "尚未配置服务器地址"
                            textFormat: Text.PlainText
                            font: Theme.font(12, Theme.regularWeight)
                            color: Theme.floatingSecondaryText
                            elide: Text.ElideMiddle
                        }
                    }
                    EchoTag {
                        visible: libraryGroup.isActive
                        text: "当前"
                        tone: EchoTag.Accent
                    }
                    EchoSoftButton {
                        visible: !libraryGroup.isActive && libraryGroup.lib.serverUrl && libraryGroup.lib.serverUrl.length > 0
                        text: "设为当前"
                        size: EchoControlSize.Small
                        colors: Theme.floating
                        foreground: Theme.floating.text
                        onClicked: settingsRoot.updateDraft({
                            activeLibraryId: libraryGroup.modelData
                        })
                    }
                    EchoIconButton {
                        glyph: "chevron-down"
                        tooltipText: libraryGroup.expanded ? "收起" : "展开"
                        rotation: libraryGroup.expanded ? 0 : -90
                        Behavior on rotation {
                            NumberAnimation {
                                duration: 150
                                easing.type: Easing.OutCubic
                            }
                        }
                        onClicked: settingsRoot.toggleLibraryExpanded(libraryGroup.modelData)
                    }
                    EchoIconButton {
                        glyph: "trash"
                        tooltipText: "删除此库"
                        onClicked: settingsRoot.removeLibrary(libraryGroup.modelData)
                    }
                }

                SettingRow {
                    Layout.fillWidth: true
                    Layout.topMargin: 12
                    visible: libraryGroup.expanded
                    heading: "服务器地址"
                    description: "以 https:// 或 http:// 开头，例如 https://dav.example.com"

                    EchoTextField {
                        Layout.preferredWidth: 220
                        text: libraryGroup.lib.serverUrl || ""
                        placeholderText: "https://dav.example.com"
                        onTextEdited: settingsRoot.updateLibrary(libraryGroup.modelData, "serverUrl", text)
                    }
                }
                SettingRow {
                    Layout.fillWidth: true
                    visible: libraryGroup.expanded
                    heading: "显示名称"
                    description: "留空时显示服务器地址"

                    EchoTextField {
                        Layout.preferredWidth: 160
                        text: libraryGroup.lib.name || ""
                        placeholderText: "显示名称"
                        onTextEdited: settingsRoot.updateLibrary(libraryGroup.modelData, "name", text)
                    }
                }
                SettingRow {
                    Layout.fillWidth: true
                    visible: libraryGroup.expanded
                    heading: "用户名"
                    description: "留空则按匿名方式访问"

                    EchoTextField {
                        Layout.preferredWidth: 160
                        text: libraryGroup.lib.username || ""
                        placeholderText: "可留空"
                        onTextEdited: settingsRoot.updateLibrary(libraryGroup.modelData, "username", text)
                    }
                }
                SettingRow {
                    Layout.fillWidth: true
                    visible: libraryGroup.expanded
                    heading: "密码"
                    description: "仅保存在本机插件存储中"

                    EchoTextField {
                        Layout.preferredWidth: 160
                        echoMode: TextInput.Password
                        text: libraryGroup.lib.password || ""
                        placeholderText: "可留空"
                        onTextEdited: settingsRoot.updateLibrary(libraryGroup.modelData, "password", text)
                    }
                }
                SettingRow {
                    Layout.fillWidth: true
                    visible: libraryGroup.expanded
                    heading: "根目录"
                    description: "从服务器的哪个目录开始浏览"

                    EchoTextField {
                        Layout.preferredWidth: 160
                        text: libraryGroup.lib.rootPath || "/"
                        placeholderText: "/"
                        onTextEdited: settingsRoot.updateLibrary(libraryGroup.modelData, "rootPath", text)
                    }
                }
                SettingRow {
                    Layout.fillWidth: true
                    visible: libraryGroup.expanded
                    heading: "默认平铺视图"
                    description: "开启后进入页面默认展示整库歌曲列表（歌曲选项卡），关闭则从目录浏览开始"

                    EchoSwitch {
                        checked: libraryGroup.lib.flatView === true
                        Accessible.name: "默认平铺视图"
                        onToggled: settingsRoot.updateLibrary(libraryGroup.modelData, "flatView", checked)
                    }
                }
            }
        }

        Label {
            Layout.fillWidth: true
            visible: settingsRoot.libraryIds.length === 0
            text: "尚未添加 WebDAV 库。"
            textFormat: Text.PlainText
            font: Theme.font(12, Theme.regularWeight)
            color: Theme.floatingSecondaryText
            wrapMode: Text.Wrap
        }

        EchoDivider {
            Layout.fillWidth: true
            visible: settingsRoot.libraryIds.length > 0
            lineColor: Theme.withAlpha(Theme.floatingText, 0.12)
        }

        SettingRow {
            Layout.fillWidth: true
            heading: "添加音乐库"
            description: "支持添加多个 WebDAV 服务器；改动点击下方保存后生效"

            EchoSoftButton {
                text: "添加"
                glyph: "plus"
                glyphSize: 12
                colors: Theme.floating
                foreground: Theme.floating.text
                onClicked: settingsRoot.addLibrary()
            }
        }
    }

    SettingsSection {
        Layout.fillWidth: true
        heading: "歌词与封面"
        glyph: "tags"

        SettingRow {
            Layout.fillWidth: true
            heading: "资料来源"
            description: "内嵌标签优先时在线资料只补缺失字段；酷狗资料优先时在线匹配的封面、专辑与歌手覆盖内嵌标签"

            // Same dropdown pattern as the host settings' 深浅色模式 row:
            // an EchoSelect at 144px on the row's trailing slot.
            EchoSelect {
                colors: Theme.floating
                Layout.preferredWidth: 144
                options: [{
                        value: "embedded",
                        label: "内嵌标签优先"
                    }, {
                        value: "kugou",
                        label: "酷狗资料优先"
                    }]
                value: settingsRoot.coverLyricSource
                Accessible.name: "歌词与封面资料来源"
                onValueEdited: function (nextValue) {
                    settingsRoot.patchCoverLyricSource(nextValue === "kugou" ? "kugou" : "embedded");
                }
            }
        }
    }

    SettingsSection {
        Layout.fillWidth: true
        heading: "缓存"
        glyph: "database"

        Label {
            Layout.fillWidth: true
            visible: settingsRoot.cachedCountLabel.length > 0
            text: settingsRoot.cachedCountLabel
            textFormat: Text.PlainText
            font: Theme.font(12, Theme.regularWeight)
            color: Theme.floatingSecondaryText
            wrapMode: Text.Wrap
        }

        SettingRow {
            Layout.fillWidth: true
            heading: "清除插件缓存"
            description: "移除平铺扫描列表、播放时持久化的歌曲资料与在线歌词；库配置与设置不受影响"

            EchoSoftButton {
                text: "立即清除"
                danger: true
                enabled: !settingsRoot.saving
                colors: Theme.floating
                onClicked: settingsRoot.confirmClearCache()
            }
        }
    }

    RowLayout {
        Layout.fillWidth: true
        spacing: 12

        Label {
            Layout.fillWidth: true
            text: settingsRoot.saving ? "正在保存…" : "修改库列表后点击保存生效；资料来源改动即时保存。"
            textFormat: Text.PlainText
            font: Theme.font(12, Theme.regularWeight)
            color: Theme.floatingSecondaryText
            wrapMode: Text.Wrap
        }
        EchoButton {
            text: "重置"
            accent: false
            enabled: settingsRoot.loaded && !settingsRoot.saving
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
            enabled: settingsRoot.loaded && !settingsRoot.saving
            onClicked: settingsRoot.save()
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

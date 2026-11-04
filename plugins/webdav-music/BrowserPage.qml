pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import EchoMusic.Shell
import EchoMusic.PluginSdk
import EchoMusic.Controls
import EchoMusic.Theme

// WebDAV library browser: directory tree or flat scan list, with play /
// queue actions, batch selection and per-library settings hand-off.
Item {
    id: root

    required property EchoPluginContext plugin
    required property RouteContext context
    readonly property bool pageActive: context.active && plugin.active

    property var libraries: []
    property string activeLibraryId: ""
    property string coverLyricSource: "embedded"
    property var currentLibrary: null
    property bool flatMode: false
    property string keyword: ""

    property var browse: ({
        loading: false,
        error: "",
        path: "/",
        root: "/",
        dirs: [],
        files: [],
        cover: ""
    })
    property bool flatReady: false
    property bool flatLoading: false
    property int flatTotal: 0
    property var flatSongs: []
    property int flatOffset: 0
    readonly property int flatPageSize: 100

    property var scanState: ({})
    // Bool bindings on Qt 6.12 lose their binding (and freeze at the old
    // value) the moment the expression evaluates to undefined, so every
    // consumer reads these normalized flags instead of touching scanState
    // fields through `&&` chains.
    readonly property bool scanRunning: !!root.scanState && root.scanState.running === true
    readonly property bool scanDone: !!root.scanState && root.scanState.done === true
    readonly property bool scanAborted: !!root.scanState && root.scanState.aborted === true
    readonly property string scanError: root.scanState && typeof root.scanState.error === "string" ? root.scanState.error : ""
    readonly property string scanLabel: root.scanState && typeof root.scanState.label === "string" ? root.scanState.label : ""
    readonly property int scanCount: root.scanState && typeof root.scanState.count === "number" ? root.scanState.count : 0
    property string sortKey: "name"
    property bool selectionMode: false
    property var selectedPaths: ({})
    property int busy: 0
    property string errorMessage: ""

    readonly property bool working: busy > 0
    readonly property string currentTrackId: {
        const snapshot = plugin.player.snapshot;
        return snapshot && snapshot.hasTrack ? snapshot.track.id : "";
    }
    readonly property var pathSegments: {
        const path = browse.path || "/";
        const prefix = browse.root || "/";
        let rest = path;
        if (prefix.length > 1 && rest.indexOf(prefix) === 0)
            rest = rest.slice(prefix.length) || "/";
        return rest.split("/").filter(function (part) {
            return part.length > 0;
        });
    }
    readonly property var displayRows: {
        const filter = keyword.trim().toLowerCase();
        let rows = [];
        if (flatMode) {
            rows = flatSongs.map(function (song) {
                return {
                    kind: "file",
                    name: song.title,
                    path: song.path,
                    title: song.title,
                    artist: song.artist,
                    size: song.size,
                    ext: song.ext,
                    quality: song.quality
                };
            });
        } else {
            for (let i = 0; i < browse.dirs.length; i++)
                rows.push({
                    kind: "dir",
                    name: browse.dirs[i].name,
                    path: browse.dirs[i].path,
                    title: browse.dirs[i].name,
                    artist: "",
                    size: 0,
                    ext: "",
                    quality: ""
                });
            for (let j = 0; j < browse.files.length; j++) {
                const file = browse.files[j];
                rows.push({
                    kind: "file",
                    name: file.title,
                    path: file.path,
                    title: file.title,
                    artist: file.artist,
                    size: file.size,
                    ext: file.ext,
                    quality: file.quality
                });
            }
        }
        if (filter.length > 0)
            rows = rows.filter(function (row) {
                return row.title.toLowerCase().indexOf(filter) >= 0 || (row.artist || "").toLowerCase().indexOf(filter) >= 0;
            });
        if (sortKey !== "name")
            rows = rows.slice().sort(function (a, b) {
                if (a.kind !== b.kind)
                    return a.kind === "dir" ? -1 : 1;
                if (sortKey === "size")
                    return (b.size || 0) - (a.size || 0);
                return compareText(a.title, b.title);
            });
        return rows;
    }
    readonly property int selectedCount: Object.keys(selectedPaths).length
    readonly property int flatPageCount: Math.max(1, Math.ceil(flatTotal / flatPageSize))
    readonly property int flatPageNumber: Math.floor(flatOffset / flatPageSize) + 1

    function compareText(a, b) {
        const left = (a || "").toLowerCase();
        const right = (b || "").toLowerCase();
        if (left < right)
            return -1;
        return left > right ? 1 : 0;
    }

    function formatBytes(size) {
        if (!isFinite(size) || size < 0)
            return "";
        const units = ["B", "KB", "MB", "GB", "TB"];
        let value = size;
        let unit = 0;
        while (value >= 1024 && unit < units.length - 1) {
            value /= 1024;
            unit += 1;
        }
        const text = unit === 0 ? String(Math.round(value)) : value >= 100 ? String(Math.round(value)) : value.toFixed(1);
        return `${text} ${units[unit]}`;
    }

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
                const message = operation.errorMessage || "操作失败";
                errorMessage = message;
                plugin.toast.danger(message);
            }
        };
        operation.completed.connect(handler);
    }

    function openSettings() {
        const operation = plugin.ui.showDialog({
            component: "SettingsDialog.qml",
            width: 640,
            title: "WebDAV 音乐设置"
        });
        if (!operation)
            return;
        const handler = function () {
            operation.completed.disconnect(handler);
            if (operation.state === 3)
                plugin.toast.danger(operation.errorMessage || "无法打开插件设置");
        };
        operation.completed.connect(handler);
    }

    function libraryById(id) {
        for (let i = 0; i < libraries.length; i++) {
            if (libraries[i].id === id)
                return libraries[i];
        }
        return null;
    }

    function refreshSettings(reload) {
        run("settings.get", {}, function (result) {
            const nextLibraries = result && Array.isArray(result.libraries) ? result.libraries : [];
            libraries = nextLibraries;
            coverLyricSource = result && result.coverLyricSource === "kugou" ? "kugou" : "embedded";
            let nextId = activeLibraryId;
            if (!libraryById(nextId))
                nextId = result && typeof result.activeLibraryId === "string" ? result.activeLibraryId : "";
            activeLibraryId = nextId;
            currentLibrary = libraryById(nextId);
            flatMode = currentLibrary ? currentLibrary.flatView === true : false;
            if (reload)
                reloadCurrent();
        });
    }

    function reloadCurrent() {
        selectionMode = false;
        selectedPaths = ({});
        if (flatMode) {
            flatReload();
        } else {
            browseLoad(browse.path && browse.path.length > 0 ? browse.path : (currentLibrary && currentLibrary.rootPath ? currentLibrary.rootPath : "/"));
        }
    }

    function browseLoad(path) {
        if (!currentLibrary)
            return;
        browse = {
            loading: true,
            error: "",
            path: path,
            root: browse.root,
            dirs: [],
            files: [],
            cover: ""
        };
        run("browse.load", {
            libraryId: activeLibraryId,
            path: path
        }, function (result) {
            if (!result || result.error) {
                browse = {
                    loading: false,
                    error: result && result.message ? result.message : "加载失败",
                    path: path,
                    root: result && result.root ? result.root : browse.root,
                    dirs: [],
                    files: [],
                    cover: ""
                };
                return;
            }
            browse = {
                loading: false,
                error: "",
                path: result.path || path,
                root: result.root || "/",
                dirs: result.dirs || [],
                files: result.files || [],
                cover: result.cover || ""
            };
        });
    }

    function flatReload() {
        if (!currentLibrary)
            return;
        flatLoading = true;
        run("flat.load", {
            libraryId: activeLibraryId
        }, function (result) {
            if (!result) {
                flatLoading = false;
                return;
            }
            if (result.ready) {
                flatReady = true;
                flatLoading = false;
                flatPageLoad(0);
            } else if (result.started) {
                flatReady = false;
            } else {
                flatLoading = false;
                errorMessage = result.message || "无法开始扫描";
            }
        });
    }

    function flatPageLoad(offset) {
        if (!currentLibrary)
            return;
        flatLoading = true;
        run("flat.page", {
            libraryId: activeLibraryId,
            offset: offset,
            limit: flatPageSize,
            keyword: keyword.trim()
        }, function (result) {
            flatLoading = false;
            if (!result || !result.ready) {
                flatSongs = [];
                flatTotal = 0;
                return;
            }
            flatReady = true;
            flatTotal = result.total || 0;
            flatOffset = result.offset || offset;
            flatSongs = result.songs || [];
        });
    }

    function playRows(mode, paths, flatIndex) {
        if (!currentLibrary)
            return;
        const args = {
            libraryId: activeLibraryId,
            mode: mode
        };
        if (flatIndex !== undefined && flatIndex !== null) {
            args.flat = true;
            args.index = flatIndex;
        } else if (paths && paths.length > 0) {
            args.paths = paths;
        } else if (!flatMode && browse.path) {
            args.dir = browse.path;
            args.index = 0;
        }
        run("play", args, function (result) {
            if (result && result.ok && mode !== "now")
                plugin.toast.success(`已将 ${result.count || 0} 首加入${mode === "next" ? "播放列表" : "队列"}`);
        });
    }

    function playRowAt(index) {
        const row = displayRows[index];
        if (!row)
            return;
        if (flatMode) {
            playRows("now", null, flatOffset + index);
            return;
        }
        if (row.kind === "dir") {
            run("play", {
                libraryId: activeLibraryId,
                dir: row.path,
                mode: "now"
            }, null);
            return;
        }
        playRows("now", [row.path], null);
    }

    function rowPlayAllFromCurrentView() {
        if (flatMode) {
            playRows("now", null, 0);
            return;
        }
        if (!browse.path)
            return;
        run("play", {
            libraryId: activeLibraryId,
            dir: browse.path,
            mode: "now",
            index: 0
        }, null);
    }

    function toggleSelected(path) {
        const next = Object.assign({}, selectedPaths);
        if (next[path])
            delete next[path];
        else
            next[path] = true;
        selectedPaths = next;
    }

    function selectAllVisible() {
        const next = {};
        for (let i = 0; i < displayRows.length; i++) {
            if (displayRows[i].kind === "file")
                next[displayRows[i].path] = true;
        }
        selectedPaths = next;
    }

    function toggleFlatMode() {
        if (!currentLibrary)
            return;
        const draft = [];
        for (let i = 0; i < libraries.length; i++) {
            const library = Object.assign({}, libraries[i]);
            if (library.id === currentLibrary.id)
                library.flatView = !flatMode;
            draft.push(library);
        }
        run("settings.patch", {
            libraries: draft,
            activeLibraryId: activeLibraryId,
            coverLyricSource: coverLyricSource
        }, null);
    }

    onActiveLibraryIdChanged: reloadCurrent()
    onFlatModeChanged: reloadCurrent()

    onPageActiveChanged: if (pageActive && libraries.length === 0)
        refreshSettings(true)

    Component.onCompleted: {
        const state = plugin.ui.state;
        scanState = state && state.flatScan ? state.flatScan : {};
        const revision = state && typeof state.settingsRevision === "number" ? state.settingsRevision : 0;
        lastSettingsRevision = revision;
        refreshSettings(true);
    }

    property int lastSettingsRevision: -1

    Connections {
        target: root.plugin.ui
        function onStateChanged() {
            const state = root.plugin.ui.state;
            root.scanState = state && state.flatScan ? state.flatScan : {};
            const revision = state && typeof state.settingsRevision === "number" ? state.settingsRevision : -1;
            if (revision >= 0 && revision !== root.lastSettingsRevision) {
                root.lastSettingsRevision = revision;
                root.refreshSettings(true);
            } else if (root.scanDone && root.flatMode && !root.flatReady) {
                root.flatReload();
            }
        }
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 20
        spacing: 12

        RowLayout {
            Layout.fillWidth: true
            spacing: 12

            EchoCover {
                Layout.preferredWidth: 52
                Layout.preferredHeight: 52
                visible: !root.flatMode
                source: root.browse.cover || ""
                placeholderGlyph: "folder-open"
            }

            ColumnLayout {
                Layout.fillWidth: true
                spacing: 3

                RowLayout {
                    spacing: 8

                    Label {
                        text: "WebDAV 音乐"
                        font: Theme.font(18, Theme.semiboldWeight)
                        color: Theme.text
                    }
                    EchoTag {
                        visible: root.currentLibrary !== null
                        text: root.flatMode ? "平铺" : "目录"
                        tone: EchoTag.Neutral
                    }
                }

                Label {
                    Layout.fillWidth: true
                    text: root.flatMode ? `共 ${root.flatTotal} 首 · ${root.currentLibrary ? root.currentLibrary.name : ""}` : root.browse.loading ? "正在加载目录…" : `${root.browse.dirs.length} 个目录 · ${root.browse.files.length} 个文件`
                    font: Theme.font(12, Theme.regularWeight)
                    color: Theme.secondaryText
                    elide: Text.ElideRight
                }
            }

            EchoButton {
                text: "播放全部"
                glyph: "player-play"
                accent: true
                onClicked: root.rowPlayAllFromCurrentView()
            }
            EchoIconButton {
                glyph: "arrows-sort"
                tooltipText: "排序方式"
                onClicked: sortMenu.popup()
            }
            EchoIconButton {
                glyph: "check"
                tooltipText: root.selectionMode ? "退出批量选择" : "批量选择"
                foreground: root.selectionMode ? Theme.accent : Theme.iconMain
                onClicked: {
                    root.selectionMode = !root.selectionMode;
                    if (!root.selectionMode)
                        root.selectedPaths = ({});
                }
            }
            EchoIconButton {
                glyph: root.flatMode ? "folder-open" : "list"
                tooltipText: root.flatMode ? "切换到目录浏览" : "切换到平铺列表"
                onClicked: root.toggleFlatMode()
            }
            EchoIconButton {
                glyph: "refresh-source"
                tooltipText: root.flatMode ? "重新扫描" : "刷新目录"
                onClicked: root.flatMode ? root.run("flat.load", {
                    libraryId: root.activeLibraryId,
                    force: true
                }, function (result) {
                    if (result && result.ready)
                        root.flatPageLoad(root.flatOffset);
                }) : root.browseLoad(root.browse.path)
            }
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: 10

            EchoSelect {
                Layout.preferredWidth: 220
                visible: root.libraries.length > 0
                placeholder: "选择 WebDAV 库"
                options: root.libraries.map(function (library) {
                    return {
                        value: library.id,
                        label: library.name
                    };
                })
                value: root.activeLibraryId
                onValueEdited: function (nextValue) {
                    root.activeLibraryId = typeof nextValue === "string" ? nextValue : "";
                }
            }
            EchoButton {
                text: "添加库"
                glyph: "plus"
                accent: false
                visible: root.libraries.length === 0
                onClicked: root.openSettings()
            }
            Item {
                Layout.fillWidth: true
            }
            EchoTextField {
                Layout.preferredWidth: 260
                placeholderText: root.flatMode ? "搜索平铺列表" : "过滤当前目录"
                clearable: true
                text: root.keyword
                onTextEdited: {
                    root.keyword = text;
                    searchDebounce.restart();
                }
                onAccepted: {
                    root.keyword = text;
                    searchDebounce.stop();
                    if (root.flatMode)
                        root.flatPageLoad(0);
                }
                onCleared: {
                    root.keyword = "";
                    if (root.flatMode)
                        root.flatPageLoad(0);
                }
            }
        }

        Rectangle {
            Layout.fillWidth: true
            visible: root.scanRunning || root.scanError.length > 0 || root.scanDone || root.scanAborted
            radius: 10
            color: Theme.rowHover
            border.color: Theme.subtleBorder
            implicitHeight: Math.max(scanLabel.implicitHeight, EchoControlSize.heightFor(EchoControlSize.Standard)) + 18
            RowLayout {
                anchors.fill: parent
                anchors.margins: 9
                spacing: 10

                EchoSpinner {
                    visible: root.scanRunning
                    Layout.preferredWidth: 16
                    Layout.preferredHeight: 16
                }
                Label {
                    id: scanLabel
                    Layout.fillWidth: true
                    text: {
                        if (root.scanError.length > 0)
                            return `扫描失败：${root.scanError}`;
                        if (root.scanDone)
                            return `扫描完成，共 ${root.scanCount} 首`;
                        if (root.scanAborted)
                            return `扫描已中止，已保留 ${root.scanCount} 首`;
                        return root.scanLabel || "正在扫描…";
                    }
                    font: Theme.font(12, Theme.regularWeight)
                    color: root.scanError.length > 0 ? Theme.colors.danger : Theme.secondaryText
                    elide: Text.ElideRight
                }
                EchoButton {
                    visible: root.scanRunning
                    text: "停止"
                    accent: false
                    onClicked: root.run("flat.abort", {}, null)
                }
                EchoButton {
                    visible: (root.scanDone || root.scanAborted) && root.flatMode
                    text: "查看列表"
                    accent: false
                    onClicked: root.flatPageLoad(0)
                }
            }
        }

        RowLayout {
            Layout.fillWidth: true
            visible: !root.flatMode
            spacing: 4

            EchoIconButton {
                glyph: "arrow-left"
                tooltipText: "上一级"
                enabled: root.browse.path && root.currentLibrary && root.browse.path !== (root.browse.root || "/")
                onClicked: root.browseLoad(parentDir(root.browse.path))
            }
            Repeater {
                model: root.pathSegments

                delegate: RowLayout {
                    id: crumbRow
                    required property int index
                    required property string modelData
                    spacing: 4

                    EchoIconButton {
                        glyph: "chevron-right"
                        tooltipText: ""
                        hoverBackground: false
                        visualContentActive: false
                        Layout.preferredWidth: 14
                        Layout.preferredHeight: 14
                        enabled: false
                        visible: crumbRow.index > 0
                    }
                    Label {
                        text: crumbRow.modelData
                        font: Theme.font(12, Theme.mediumWeight)
                        color: crumbRow.index === root.pathSegments.length - 1 ? Theme.text : Theme.secondaryText
                        MouseArea {
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: root.browseLoad(crumbPath(crumbRow.index))
                        }
                    }
                }
            }
            Item {
                Layout.fillWidth: true
            }
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.fillHeight: true
            radius: 12
            color: Theme.card
            border.color: Theme.subtleBorder

            ListView {
                id: listView
                anchors.fill: parent
                anchors.margins: 6
                clip: true
                spacing: 2
                model: root.displayRows
                visible: !root.browse.loading && !root.flatLoading && root.displayRows.length > 0
                ScrollBar.vertical: EchoScrollBar {
                }

                delegate: Rectangle {
                    id: rowDelegate
                    required property int index
                    required property var modelData
                    width: listView.width
                    height: 52
                    radius: 8
                    readonly property bool current: root.currentTrackId !== "" && modelData.kind === "file" && rowKey(modelData) === root.currentTrackId
                    readonly property bool selected: root.selectedPaths[modelData.path] === true
                    color: current ? Theme.selected : selected ? Theme.rowHover : rowHoverArea.containsMouse ? Theme.rowHover : "transparent"

                    function rowKey(row) {
                        const library = root.currentLibrary;
                        if (!library)
                            return "";
                        let hash = 0;
                        const text = `${library.id}|${row.path}`;
                        for (let i = 0; i < text.length; i++)
                            hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
                        return `webdav-${(hash >>> 0).toString(36)}`;
                    }

                    RowLayout {
                        anchors.fill: parent
                        anchors.leftMargin: 10
                        anchors.rightMargin: 10
                        spacing: 10

                        EchoCheckBox {
                            visible: root.selectionMode && rowDelegate.modelData.kind === "file"
                            checked: rowDelegate.selected
                            onToggled: root.toggleSelected(rowDelegate.modelData.path)
                        }
                        EchoIconButton {
                            Layout.preferredWidth: 28
                            Layout.preferredHeight: 28
                            glyph: rowDelegate.current ? "player-pause" : "player-play"
                            tooltipText: rowDelegate.current ? "正在播放" : "立即播放"
                            foreground: rowDelegate.current ? Theme.accent : Theme.iconSecondary
                            visible: rowDelegate.modelData.kind === "file"
                            onClicked: {
                                if (rowDelegate.current) {
                                    root.plugin.player.toggle();
                                } else {
                                    root.playRowAt(rowDelegate.index);
                                }
                            }
                        }
                        Label {
                            Layout.preferredWidth: 26
                            visible: !root.selectionMode && rowDelegate.modelData.kind === "file"
                            text: String(rowDelegate.index + 1)
                            font: Theme.font(12, Theme.regularWeight)
                            color: Theme.secondaryText
                            horizontalAlignment: Text.AlignHCenter
                        }
                        EchoIcon {
                            Layout.preferredWidth: 20
                            Layout.preferredHeight: 20
                            visible: rowDelegate.modelData.kind === "dir"
                            name: "folder-open"
                            color: Theme.accent
                        }
                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 1

                            Label {
                                Layout.fillWidth: true
                                text: rowDelegate.modelData.title || rowDelegate.modelData.name
                                font: Theme.font(13, rowDelegate.current ? Theme.semiboldWeight : Theme.mediumWeight)
                                color: rowDelegate.current ? Theme.accent : Theme.text
                                elide: Text.ElideRight
                            }
                            Label {
                                Layout.fillWidth: true
                                visible: rowDelegate.modelData.kind === "file" && (rowDelegate.modelData.artist || "").length > 0
                                text: rowDelegate.modelData.artist
                                font: Theme.font(11, Theme.regularWeight)
                                color: Theme.secondaryText
                                elide: Text.ElideRight
                            }
                        }
                        EchoTag {
                            visible: rowDelegate.modelData.kind === "file" && rowDelegate.modelData.quality === "flac"
                            text: "无损"
                            tone: EchoTag.Accent
                        }
                        Label {
                            visible: rowDelegate.modelData.kind === "file" && rowDelegate.modelData.size > 0
                            text: root.formatBytes(rowDelegate.modelData.size)
                            font: Theme.font(11, Theme.regularWeight)
                            color: Theme.secondaryText
                        }
                        EchoIconButton {
                            glyph: "playlist-add"
                            tooltipText: "添加到队列"
                            visible: rowDelegate.modelData.kind === "file" && !root.selectionMode
                            onClicked: root.playRows("append", [rowDelegate.modelData.path], null)
                        }
                    }

                    MouseArea {
                        id: rowHoverArea
                        anchors.fill: parent
                        hoverEnabled: true
                        acceptedButtons: Qt.LeftButton | Qt.RightButton
                        cursorShape: Qt.PointingHandCursor
                        onClicked: function (mouse) {
                            if (mouse.button === Qt.RightButton) {
                                rowMenu.popup();
                                return;
                            }
                            if (root.selectionMode && rowDelegate.modelData.kind === "file")
                                root.toggleSelected(rowDelegate.modelData.path);
                        }
                        onDoubleClicked: function (mouse) {
                            if (mouse.button === Qt.LeftButton && !root.selectionMode)
                                root.playRowAt(rowDelegate.index);
                        }
                    }

                    EchoMenu {
                        id: rowMenu

                        EchoMenuEntry {
                            visible: rowDelegate.modelData.kind === "dir"
                            text: "播放此文件夹"
                            onTriggered: root.run("play", {
                                libraryId: root.activeLibraryId,
                                dir: rowDelegate.modelData.path,
                                mode: "now"
                            }, null)
                        }
                        EchoMenuEntry {
                            visible: rowDelegate.modelData.kind === "dir"
                            text: "下一首播放（文件夹）"
                            onTriggered: root.run("play", {
                                libraryId: root.activeLibraryId,
                                dir: rowDelegate.modelData.path,
                                mode: "next"
                            }, null)
                        }
                        EchoMenuEntry {
                            visible: rowDelegate.modelData.kind === "file"
                            text: "立即播放"
                            onTriggered: root.playRowAt(rowDelegate.index)
                        }
                        EchoMenuEntry {
                            visible: rowDelegate.modelData.kind === "file"
                            text: "下一首播放"
                            onTriggered: root.playRows("next", [rowDelegate.modelData.path], null)
                        }
                        EchoMenuEntry {
                            visible: rowDelegate.modelData.kind === "file"
                            text: "添加到队列"
                            onTriggered: root.playRows("append", [rowDelegate.modelData.path], null)
                        }
                    }
                }
            }

            EchoMenu {
                id: sortMenu

                EchoMenuEntry {
                    text: root.sortKey === "name" ? "✓ 按文件名" : "按文件名"
                    onTriggered: root.sortKey = "name"
                }
                EchoMenuEntry {
                    text: root.sortKey === "title" ? "✓ 按标题" : "按标题"
                    onTriggered: root.sortKey = "title"
                }
                EchoMenuEntry {
                    text: root.sortKey === "size" ? "✓ 按大小" : "按大小"
                    onTriggered: root.sortKey = "size"
                }
            }

            ColumnLayout {
                anchors.centerIn: parent
                visible: listView.visible === false
                spacing: 8
                width: Math.min(360, parent.width - 40)

                EchoIcon {
                    Layout.alignment: Qt.AlignHCenter
                    Layout.preferredWidth: 34
                    Layout.preferredHeight: 34
                    name: root.browse.error || root.errorMessage ? "alert-circle" : root.flatMode ? "database" : "folder-open"
                    color: Theme.iconSecondary
                }
                Label {
                    Layout.fillWidth: true
                    horizontalAlignment: Text.AlignHCenter
                    wrapMode: Text.Wrap
                    text: {
                        if (root.browse.loading || root.flatLoading)
                            return "正在加载…";
                        if (root.browse.error || root.errorMessage)
                            return root.browse.error || root.errorMessage;
                        if (root.libraries.length === 0)
                            return "还没有 WebDAV 库，点击右上角「添加库」开始";
                        if (root.flatMode && !root.flatReady)
                            return "平铺列表尚未扫描，点击「重新扫描」建立列表";
                        if (root.scanRunning)
                            return root.scanLabel || "正在扫描…";
                        return root.flatMode ? "没有匹配的歌曲" : "此目录没有音频文件";
                    }
                    font: Theme.font(12, Theme.regularWeight)
                    color: Theme.secondaryText
                }
                EchoButton {
                    Layout.alignment: Qt.AlignHCenter
                    visible: root.libraries.length === 0
                    text: "打开插件设置"
                    glyph: "settings"
                    accent: true
                    onClicked: root.openSettings()
                }
                EchoButton {
                    Layout.alignment: Qt.AlignHCenter
                    visible: root.flatMode && !root.flatReady && !root.scanRunning && root.libraries.length > 0
                    text: "开始扫描"
                    glyph: "database"
                    accent: true
                    loading: root.flatLoading
                    onClicked: root.flatReload()
                }
            }

            EchoSpinner {
                anchors.centerIn: parent
                visible: (root.browse.loading || root.flatLoading) && root.displayRows.length === 0
                width: 22
                height: 22
            }
        }

        RowLayout {
            Layout.fillWidth: true
            visible: root.flatMode && root.flatTotal > 0
            spacing: 10

            Label {
                text: `第 ${root.flatPageNumber} / ${root.flatPageCount} 页 · 共 ${root.flatTotal} 首`
                font: Theme.font(12, Theme.regularWeight)
                color: Theme.secondaryText
            }
            Item {
                Layout.fillWidth: true
            }
            EchoIconButton {
                glyph: "chevron-left"
                tooltipText: "上一页"
                enabled: root.flatOffset > 0
                onClicked: root.flatPageLoad(Math.max(0, root.flatOffset - root.flatPageSize))
            }
            EchoIconButton {
                glyph: "chevron-right"
                tooltipText: "下一页"
                enabled: root.flatOffset + root.flatPageSize < root.flatTotal
                onClicked: root.flatPageLoad(root.flatOffset + root.flatPageSize)
            }
        }

        Rectangle {
            Layout.fillWidth: true
            visible: root.selectionMode
            radius: 12
            color: Theme.elevated
            border.color: Theme.subtleBorder
            implicitHeight: 54
            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: 14
                anchors.rightMargin: 14
                spacing: 10

                Label {
                    text: `已选 ${root.selectedCount} 首`
                    font: Theme.font(13, Theme.semiboldWeight)
                    color: Theme.text
                }
                EchoButton {
                    text: "全选本页"
                    accent: false
                    onClicked: root.selectAllVisible()
                }
                Item {
                    Layout.fillWidth: true
                }
                EchoButton {
                    text: "播放选中"
                    glyph: "player-play"
                    accent: true
                    enabled: root.selectedCount > 0
                    onClicked: {
                        root.playRows("now", Object.keys(root.selectedPaths), null);
                        root.selectionMode = false;
                    }
                }
                EchoButton {
                    text: "添加到队列"
                    glyph: "playlist-add"
                    accent: false
                    enabled: root.selectedCount > 0
                    onClicked: {
                        root.playRows("append", Object.keys(root.selectedPaths), null);
                        root.selectionMode = false;
                        root.selectedPaths = ({});
                    }
                }
                EchoIconButton {
                    glyph: "x"
                    tooltipText: "退出批量选择"
                    onClicked: {
                        root.selectionMode = false;
                        root.selectedPaths = ({});
                    }
                }
            }
        }
    }

    function parentDir(path) {
        const normalized = path || "/";
        const cut = normalized.lastIndexOf("/");
        if (cut <= 0)
            return "/";
        return normalized.slice(0, cut);
    }

    function crumbPath(index) {
        const prefix = browse.root && browse.root.length > 0 ? browse.root : "/";
        let path = prefix === "/" ? "" : prefix;
        for (let i = 0; i <= index; i++)
            path += `/${pathSegments[i]}`;
        return path.length === 0 ? "/" : path;
    }

    Timer {
        id: searchDebounce
        interval: 300
        onTriggered: if (root.flatMode)
            root.flatPageLoad(0)
    }
}

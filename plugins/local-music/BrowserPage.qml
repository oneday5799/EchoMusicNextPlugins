pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import EchoMusic.Shell
import EchoMusic.PluginSdk
import EchoMusic.Controls
import EchoMusic.Theme

// Local library browser: a flat song list or an album grid over the scanned
// folders, with folder filter, search, sort and the scan/enrich progress
// banner. All data flows through the plugin command bridge.
Item {
    id: root

    required property EchoPluginContext plugin
    required property RouteContext context
    readonly property bool pageActive: context.active && plugin.active

    property var folders: []
    property string folderFilter: ""
    property string viewMode: "songs"
    /** Album name drilled into from the grid; empty shows the grid. */
    property string selectedAlbum: ""
    property string keyword: ""
    property string sortKey: "title"

    property bool libraryReady: false
    property int libraryCount: 0
    property int folderCount: 0
    property int availableFolders: 0

    property var songs: []
    property int songTotal: 0
    property int songOffset: 0
    readonly property int pageSize: 100

    property var albums: []
    property int albumTotal: 0
    property int albumOffset: 0
    readonly property int albumPageSize: 60

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

    property int busy: 0
    property string errorMessage: ""

    readonly property bool working: busy > 0
    readonly property bool albumView: root.viewMode === "albums" && root.selectedAlbum.length === 0
    readonly property string currentTrackId: {
        const snapshot = plugin.player.snapshot;
        return snapshot && snapshot.hasTrack ? snapshot.track.id : "";
    }
    readonly property string folderLabel: {
        if (root.folderFilter.length === 0)
            return "";
        for (let i = 0; i < root.folders.length; i++) {
            if (root.folders[i].id === root.folderFilter)
                return root.folders[i].name || root.folders[i].path || "";
        }
        return "";
    }
    readonly property int songPageCount: Math.max(1, Math.ceil(root.songTotal / root.pageSize))
    readonly property int songPageNumber: Math.floor(root.songOffset / root.pageSize) + 1
    readonly property int albumPageCount: Math.max(1, Math.ceil(root.albumTotal / root.albumPageSize))
    readonly property int albumPageNumber: Math.floor(root.albumOffset / root.albumPageSize) + 1

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

    function formatDuration(ms) {
        if (!isFinite(ms) || ms <= 0)
            return "";
        const total = Math.round(ms / 1000);
        const minutes = Math.floor(total / 60);
        const seconds = total % 60;
        return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
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
            title: "本地音乐设置"
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

    function refreshSettings(reload) {
        run("settings.get", {}, function (result) {
            folders = result && Array.isArray(result.folders) ? result.folders : [];
            if (folderFilter.length > 0 && !folderKnown(folderFilter))
                folderFilter = "";
            if (reload)
                reloadLibrary();
        });
    }

    function folderKnown(id) {
        for (let i = 0; i < folders.length; i++) {
            if (folders[i].id === id)
                return true;
        }
        return false;
    }

    function reloadLibrary() {
        run("library.info", {}, function (result) {
            libraryReady = !!result && result.ready === true;
            libraryCount = result && typeof result.count === "number" ? result.count : 0;
            folderCount = result && typeof result.folders === "number" ? result.folders : 0;
            availableFolders = result && typeof result.available === "number" ? result.available : 0;
            if (libraryReady) {
                if (albumView)
                    albumsLoad(0);
                else
                    pageLoad(0);
            } else {
                songs = [];
                songTotal = 0;
                albums = [];
                albumTotal = 0;
            }
        });
    }

    function viewArgs(index) {
        const args = {
            keyword: keyword.trim(),
            folderId: folderFilter,
            album: selectedAlbum,
            sort: sortKey
        };
        if (index !== undefined && index !== null) {
            args.index = index;
            args.mode = "now";
        }
        return args;
    }

    function pageLoad(offset) {
        if (!libraryReady)
            return;
        run("library.page", {
            offset: offset,
            limit: pageSize,
            keyword: keyword.trim(),
            folderId: folderFilter,
            album: selectedAlbum,
            sort: sortKey
        }, function (result) {
            if (!result || !result.ready) {
                songs = [];
                songTotal = 0;
                libraryReady = false;
                return;
            }
            songTotal = result.total || 0;
            songOffset = result.offset || offset;
            songs = result.songs || [];
        });
    }

    function albumsLoad(offset) {
        if (!libraryReady)
            return;
        run("library.albums", {
            offset: offset,
            limit: albumPageSize,
            keyword: keyword.trim(),
            folderId: folderFilter,
            sort: sortKey
        }, function (result) {
            if (!result || !result.ready) {
                albums = [];
                albumTotal = 0;
                libraryReady = false;
                return;
            }
            albumTotal = result.total || 0;
            albumOffset = result.offset || offset;
            albums = result.albums || [];
        });
    }

    function playAll() {
        if (!libraryReady)
            return;
        const args = viewArgs(0);
        args.mode = "now";
        run("play", args, null);
    }

    function playRowAt(index) {
        if (!libraryReady)
            return;
        run("play", viewArgs(index), null);
    }

    function queueRow(row, mode) {
        run("play", {
            mode: mode,
            ids: [row.id]
        }, function (result) {
            if (result && result.ok)
                plugin.toast.success(mode === "next" ? "将在下一首播放" : "已添加到队列");
        });
    }

    function startScan() {
        run("library.scan", {}, function (result) {
            if (result && result.busy) {
                plugin.toast.info(result.message || "已有扫描任务正在进行");
                return;
            }
        });
    }

    function toggleView(mode) {
        if (viewMode === mode)
            return;
        viewMode = mode;
        selectedAlbum = "";
        if (libraryReady) {
            if (mode === "albums")
                albumsLoad(0);
            else
                pageLoad(0);
        }
    }

    onSelectedAlbumChanged: if (libraryReady && viewMode === "albums")
        pageLoad(0)

    onFolderFilterChanged: {
        if (!libraryReady)
            return;
        if (albumView)
            albumsLoad(0);
        else
            pageLoad(0);
    }

    onPageActiveChanged: if (pageActive && folders.length === 0)
        refreshSettings(true)

    Component.onCompleted: {
        const state = plugin.ui.state;
        scanState = state && state.scan ? state.scan : {};
        const revision = state && typeof state.libraryRevision === "number" ? state.libraryRevision : 0;
        lastLibraryRevision = revision;
        refreshSettings(true);
    }

    property int lastLibraryRevision: -1

    Connections {
        target: root.plugin.ui
        function onStateChanged() {
            const state = root.plugin.ui.state;
            root.scanState = state && state.scan ? state.scan : {};
            const revision = state && typeof state.libraryRevision === "number" ? state.libraryRevision : -1;
            if (revision >= 0 && revision !== root.lastLibraryRevision) {
                root.lastLibraryRevision = revision;
                root.refreshSettings(true);
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

            ColumnLayout {
                Layout.fillWidth: true
                spacing: 3

                RowLayout {
                    spacing: 8

                    Label {
                        text: root.selectedAlbum.length > 0 ? root.selectedAlbum : "本地音乐"
                        font: Theme.font(18, Theme.semiboldWeight)
                        color: Theme.text
                    }
                    EchoTag {
                        visible: root.folderLabel.length > 0
                        text: root.folderLabel
                        tone: EchoTag.Neutral
                    }
                }

                Label {
                    Layout.fillWidth: true
                    text: {
                        if (root.scanRunning)
                            return root.scanLabel || "正在扫描…";
                        if (root.albumView)
                            return `共 ${root.albumTotal} 张专辑`;
                        if (root.libraryReady)
                            return `共 ${root.songTotal} 首`;
                        if (root.folderCount === 0)
                            return "添加音乐文件夹后开始扫描";
                        return "尚未扫描，点击「重新扫描」建立曲库";
                    }
                    font: Theme.font(12, Theme.regularWeight)
                    color: Theme.secondaryText
                    elide: Text.ElideRight
                }
            }

            EchoButton {
                visible: root.viewMode === "albums" && root.selectedAlbum.length > 0
                text: "返回专辑"
                glyph: "arrow-left"
                accent: false
                onClicked: root.selectedAlbum = ""
            }
            EchoButton {
                text: "播放全部"
                glyph: "player-play"
                accent: true
                enabled: root.libraryReady
                onClicked: root.playAll()
            }
            EchoIconButton {
                glyph: "arrows-sort"
                tooltipText: "排序方式"
                onClicked: sortMenu.popup()
            }
            EchoIconButton {
                glyph: "settings"
                tooltipText: "插件设置"
                onClicked: root.openSettings()
            }
            EchoIconButton {
                glyph: "refresh-source"
                tooltipText: "重新扫描"
                onClicked: root.startScan()
            }
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: 10

            EchoButton {
                text: "歌曲"
                accent: root.viewMode === "songs"
                onClicked: root.toggleView("songs")
            }
            EchoButton {
                text: "专辑"
                accent: root.viewMode === "albums"
                onClicked: root.toggleView("albums")
            }
            EchoSelect {
                Layout.preferredWidth: 200
                visible: root.folders.length > 1
                placeholder: "全部文件夹"
                options: [{
                        value: "",
                        label: "全部文件夹"
                    }].concat(root.folders.map(function (folder) {
                    return {
                        value: folder.id,
                        label: folder.name || folder.path || folder.id
                    };
                }))
                value: root.folderFilter
                onValueEdited: function (nextValue) {
                    root.folderFilter = typeof nextValue === "string" ? nextValue : "";
                }
            }
            Item {
                Layout.fillWidth: true
            }
            EchoTextField {
                Layout.preferredWidth: 260
                placeholderText: root.albumView ? "搜索专辑" : "搜索本地歌曲"
                clearable: true
                text: root.keyword
                onTextEdited: {
                    root.keyword = text;
                    searchDebounce.restart();
                }
                onAccepted: {
                    root.keyword = text;
                    searchDebounce.stop();
                    if (root.albumView)
                        root.albumsLoad(0);
                }
                onCleared: {
                    root.keyword = "";
                    if (root.albumView)
                        root.albumsLoad(0);
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
                    onClicked: root.run("library.abort", {}, null)
                }
                EchoButton {
                    visible: (root.scanDone || root.scanAborted) && !root.scanRunning
                    text: "查看列表"
                    accent: false
                    onClicked: root.reloadLibrary()
                }
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
                model: root.songs
                visible: root.libraryReady && !root.albumView && root.songs.length > 0
                ScrollBar.vertical: EchoScrollBar {
                }

                delegate: Rectangle {
                    id: rowDelegate
                    required property int index
                    required property var modelData
                    width: listView.width
                    height: 52
                    radius: 8
                    readonly property bool current: root.currentTrackId !== "" && rowDelegate.modelData.id === root.currentTrackId
                    color: current ? Theme.selected : rowHoverArea.containsMouse ? Theme.rowHover : "transparent"

                    RowLayout {
                        anchors.fill: parent
                        anchors.leftMargin: 10
                        anchors.rightMargin: 10
                        spacing: 10

                        EchoIconButton {
                            Layout.preferredWidth: 28
                            Layout.preferredHeight: 28
                            glyph: rowDelegate.current ? "player-pause" : "player-play"
                            tooltipText: rowDelegate.current ? "正在播放" : "立即播放"
                            foreground: rowDelegate.current ? Theme.accent : Theme.iconSecondary
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
                            text: String(root.songOffset + rowDelegate.index + 1)
                            font: Theme.font(12, Theme.regularWeight)
                            color: Theme.secondaryText
                            horizontalAlignment: Text.AlignHCenter
                        }
                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 1

                            Label {
                                Layout.fillWidth: true
                                text: rowDelegate.modelData.title || rowDelegate.modelData.path
                                font: Theme.font(13, rowDelegate.current ? Theme.semiboldWeight : Theme.mediumWeight)
                                color: rowDelegate.current ? Theme.accent : Theme.text
                                elide: Text.ElideRight
                            }
                            Label {
                                Layout.fillWidth: true
                                visible: (rowDelegate.modelData.artist || "").length > 0 || (rowDelegate.modelData.album || "").length > 0
                                text: {
                                    const artist = rowDelegate.modelData.artist || "";
                                    const album = rowDelegate.modelData.album || "";
                                    if (artist.length > 0 && album.length > 0)
                                        return `${artist} · ${album}`;
                                    return artist.length > 0 ? artist : album;
                                }
                                font: Theme.font(11, Theme.regularWeight)
                                color: Theme.secondaryText
                                elide: Text.ElideRight
                            }
                        }
                        EchoTag {
                            visible: rowDelegate.modelData.quality === "flac"
                            text: "无损"
                            tone: EchoTag.Accent
                        }
                        Label {
                            visible: rowDelegate.modelData.durationMs > 0
                            text: root.formatDuration(rowDelegate.modelData.durationMs)
                            font: Theme.font(11, Theme.regularWeight)
                            color: Theme.secondaryText
                        }
                        Label {
                            visible: rowDelegate.modelData.size > 0
                            text: root.formatBytes(rowDelegate.modelData.size)
                            font: Theme.font(11, Theme.regularWeight)
                            color: Theme.secondaryText
                        }
                        EchoIconButton {
                            glyph: "playlist-add"
                            tooltipText: "添加到队列"
                            onClicked: root.queueRow(rowDelegate.modelData, "append")
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
                        }
                        onDoubleClicked: function (mouse) {
                            if (mouse.button === Qt.LeftButton)
                                root.playRowAt(rowDelegate.index);
                        }
                    }

                    EchoMenu {
                        id: rowMenu

                        EchoMenuEntry {
                            text: "立即播放"
                            onTriggered: root.playRowAt(rowDelegate.index)
                        }
                        EchoMenuEntry {
                            text: "下一首播放"
                            onTriggered: root.queueRow(rowDelegate.modelData, "next")
                        }
                        EchoMenuEntry {
                            text: "添加到队列"
                            onTriggered: root.queueRow(rowDelegate.modelData, "append")
                        }
                    }
                }
            }

            GridView {
                id: gridView
                anchors.fill: parent
                anchors.margins: 12
                clip: true
                visible: root.libraryReady && root.albumView && root.albums.length > 0
                cellWidth: Math.floor(width / Math.max(1, Math.floor(width / 150)))
                cellHeight: 190
                model: root.albums
                ScrollBar.vertical: EchoScrollBar {
                }

                delegate: Item {
                    id: albumCard
                    required property int index
                    required property var modelData
                    width: gridView.cellWidth
                    height: gridView.cellHeight

                    ColumnLayout {
                        anchors.fill: parent
                        anchors.margins: 6
                        spacing: 6

                        Rectangle {
                            Layout.fillWidth: true
                            Layout.preferredHeight: width
                            radius: 10
                            color: Theme.rowHover
                            border.color: Theme.subtleBorder

                            EchoCover {
                                anchors.fill: parent
                                anchors.margins: 1
                                source: albumCard.modelData.cover || ""
                                placeholderGlyph: "music"
                            }
                            MouseArea {
                                anchors.fill: parent
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onDoubleClicked: root.playAlbum(albumCard.modelData.name)
                                onClicked: root.selectedAlbum = albumCard.modelData.name
                            }
                        }
                        Label {
                            Layout.fillWidth: true
                            text: albumCard.modelData.name
                            font: Theme.font(12, Theme.mediumWeight)
                            color: Theme.text
                            elide: Text.ElideRight
                            horizontalAlignment: Text.AlignHCenter
                        }
                        Label {
                            Layout.fillWidth: true
                            text: `${albumCard.modelData.count} 首`
                            font: Theme.font(11, Theme.regularWeight)
                            color: Theme.secondaryText
                            horizontalAlignment: Text.AlignHCenter
                        }
                    }
                }
            }

            EchoMenu {
                id: sortMenu

                EchoMenuEntry {
                    text: root.sortKey === "title" ? "✓ 按标题" : "按标题"
                    onTriggered: root.changeSort("title")
                }
                EchoMenuEntry {
                    text: root.sortKey === "artist" ? "✓ 按歌手" : "按歌手"
                    onTriggered: root.changeSort("artist")
                }
                EchoMenuEntry {
                    text: root.sortKey === "album" ? "✓ 按专辑" : "按专辑"
                    onTriggered: root.changeSort("album")
                }
                EchoMenuEntry {
                    text: root.sortKey === "name" ? "✓ 按文件名" : "按文件名"
                    onTriggered: root.changeSort("name")
                }
                EchoMenuEntry {
                    text: root.sortKey === "size" ? "✓ 按大小" : "按大小"
                    onTriggered: root.changeSort("size")
                }
            }

            ColumnLayout {
                anchors.centerIn: parent
                visible: {
                    if (root.scanRunning)
                        return false;
                    if (root.working && root.libraryReady)
                        return false;
                    if (root.libraryReady && (root.albumView ? root.albums.length > 0 : root.songs.length > 0))
                        return false;
                    return true;
                }
                spacing: 8
                width: Math.min(360, parent.width - 40)

                EchoIcon {
                    Layout.alignment: Qt.AlignHCenter
                    Layout.preferredWidth: 34
                    Layout.preferredHeight: 34
                    name: root.scanError.length > 0 || root.errorMessage.length > 0 ? "alert-circle" : root.folderCount === 0 ? "folder-open" : "database"
                    color: Theme.iconSecondary
                }
                Label {
                    Layout.fillWidth: true
                    horizontalAlignment: Text.AlignHCenter
                    wrapMode: Text.Wrap
                    text: {
                        if (root.scanRunning)
                            return root.scanLabel || "正在扫描…";
                        if (root.working)
                            return "正在加载…";
                        if (root.errorMessage.length > 0)
                            return root.errorMessage;
                        if (root.folderCount === 0)
                            return "还没有音乐文件夹，点击右上角设置添加";
                        if (!root.libraryReady)
                            return "曲库尚未扫描，点击「重新扫描」建立列表";
                        if (root.albumView)
                            return "没有匹配的专辑";
                        return "没有匹配的歌曲";
                    }
                    font: Theme.font(12, Theme.regularWeight)
                    color: Theme.secondaryText
                }
                EchoButton {
                    Layout.alignment: Qt.AlignHCenter
                    visible: root.folderCount === 0 && !root.working
                    text: "打开插件设置"
                    glyph: "settings"
                    accent: true
                    onClicked: root.openSettings()
                }
                EchoButton {
                    Layout.alignment: Qt.AlignHCenter
                    visible: root.folderCount > 0 && !root.libraryReady && !root.scanRunning && !root.working
                    text: "开始扫描"
                    glyph: "database"
                    accent: true
                    onClicked: root.startScan()
                }
            }

            EchoSpinner {
                anchors.centerIn: parent
                visible: root.working && !root.scanRunning && root.libraryReady && (root.albumView ? root.albums.length === 0 : root.songs.length === 0)
                width: 22
                height: 22
            }
        }

        RowLayout {
            Layout.fillWidth: true
            visible: root.libraryReady && root.albumView && root.albumTotal > 0
            spacing: 10

            Label {
                text: `第 ${root.albumPageNumber} / ${root.albumPageCount} 页 · 共 ${root.albumTotal} 张`
                font: Theme.font(12, Theme.regularWeight)
                color: Theme.secondaryText
            }
            Item {
                Layout.fillWidth: true
            }
            EchoIconButton {
                glyph: "chevron-left"
                tooltipText: "上一页"
                enabled: root.albumOffset > 0
                onClicked: root.albumsLoad(Math.max(0, root.albumOffset - root.albumPageSize))
            }
            EchoIconButton {
                glyph: "chevron-right"
                tooltipText: "下一页"
                enabled: root.albumOffset + root.albumPageSize < root.albumTotal
                onClicked: root.albumsLoad(root.albumOffset + root.albumPageSize)
            }
        }

        RowLayout {
            Layout.fillWidth: true
            visible: root.libraryReady && !root.albumView && root.songTotal > 0
            spacing: 10

            Label {
                text: `第 ${root.songPageNumber} / ${root.songPageCount} 页 · 共 ${root.songTotal} 首`
                font: Theme.font(12, Theme.regularWeight)
                color: Theme.secondaryText
            }
            Item {
                Layout.fillWidth: true
            }
            EchoIconButton {
                glyph: "chevron-left"
                tooltipText: "上一页"
                enabled: root.songOffset > 0
                onClicked: root.pageLoad(Math.max(0, root.songOffset - root.pageSize))
            }
            EchoIconButton {
                glyph: "chevron-right"
                tooltipText: "下一页"
                enabled: root.songOffset + root.pageSize < root.songTotal
                onClicked: root.pageLoad(root.songOffset + root.pageSize)
            }
        }
    }

    function changeSort(key) {
        if (sortKey === key)
            return;
        sortKey = key;
        if (!libraryReady)
            return;
        if (albumView)
            albumsLoad(0);
        else
            pageLoad(0);
    }

    function playAlbum(name) {
        run("play", {
            mode: "now",
            album: name,
            folderId: folderFilter,
            sort: sortKey,
            index: 0
        }, null);
    }

    Timer {
        id: searchDebounce
        interval: 300
        onTriggered: {
            if (!root.libraryReady)
                return;
            if (root.albumView)
                root.albumsLoad(0);
            else
                root.pageLoad(0);
        }
    }
}

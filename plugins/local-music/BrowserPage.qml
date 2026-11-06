pragma ComponentBehavior: Bound
import QtQuick
import QtQml.Models
import QtQuick.Controls.Basic
import QtQuick.Layouts
import EchoMusic.Shell
import EchoMusic.PluginSdk
import EchoMusic.Controls
import EchoMusic.Theme
import EchoMusic.Music

// Local library page composed from the host's own detail-page structure:
// EchoPageScrollContainer viewport with a flow header and sticky toolbar
// (EchoDetailTabs + SongListHeader), SongRow rows over the shared
// SongListGeometry, skeleton loading rows, load-more on scroll end and the
// shared EchoEnter page fade. All animations run on Theme motion tokens.
Item {
    id: root

    required property EchoPluginContext plugin
    required property RouteContext context
    readonly property bool pageActive: context.active && plugin.active

    property var folders: []
    property string folderFilter: ""
    property int viewTab: 0
    /** Album name drilled into from the grid; empty shows the grid. */
    property string selectedAlbum: ""
    property string keyword: ""
    readonly property bool albumTab: viewTab === 1
    readonly property bool albumGridActive: albumTab && selectedAlbum.length === 0
    // Host sort-header contract: Index/Title/Artist/Album/Duration = 1..5,
    // direction 1 = ascending, 2 = descending.
    property int sortField: 2
    property int sortDirection: 1
    readonly property string sortKey: ({
            1: "name",
            2: "title",
            3: "artist",
            4: "album",
            5: "duration"
        })[sortField] || "title"

    property bool libraryReady: false
    property int libraryCount: 0
    property int libraryAlbums: 0
    property int folderCount: 0

    // Cumulative rows: paging appends at the list end like the shared
    // catalogs, driven by atYEnd instead of page buttons.
    property var pageRows: []
    property int songTotal: 0
    property bool pageLoading: false
    property bool loadingMore: false
    readonly property bool hasMore: libraryReady && !albumGridActive && pageRows.length < songTotal

    property var albumRows: []
    property int albumTotal: 0
    property bool albumsLoading: false

    // Split model strategy. The album grid takes a ListModel: all its roles
    // are scalars, so appends notify incrementally instead of resetting the
    // view (a JS-array reassignment is a wholesale model reset that snaps
    // the grid back to the top on every batch). The song list keeps the JS
    // array: SongRow's artistLinks role must read back as a JS array —
    // ListModel converts object arrays into nested models whose delegates
    // lose modelData semantics, which blanked the artist line — and cover
    // delivery instead mutates rows in place and pokes the live delegates
    // through itemAtIndex, so no reset ever fires for covers.
    ListModel {
        id: albumModel
    }
    // songId -> index inside pageRows, kept in step by appendSongRows so
    // cover batches can find their row without scanning.
    property var songIndexById: ({})

    // Right-click menu target keeps the host's context-target row fill.
    property string menuSongId: ""

    property var scanState: ({})
    readonly property bool scanRunning: !!root.scanState && root.scanState.running === true
    readonly property bool scanDone: !!root.scanState && root.scanState.done === true
    readonly property bool scanAborted: !!root.scanState && root.scanState.aborted === true
    readonly property string scanError: root.scanState && typeof root.scanState.error === "string" ? root.scanState.error : ""

    property string errorMessage: ""
    readonly property int contentInset: 24

    readonly property string currentTrackId: {
        const snapshot = plugin.player.snapshot;
        return snapshot && snapshot.hasTrack ? snapshot.track.id : "";
    }
    readonly property string headerTitle: selectedAlbum.length > 0 ? selectedAlbum : "本地音乐"
    // Library-wide counts from library.info; the tabs show filtered totals.
    readonly property string songCountLabel: `${root.libraryCount} 首歌曲`
    readonly property string albumCountLabel: root.libraryAlbums > 0 ? `${root.libraryAlbums} 张专辑` : ""

    readonly property string headerCoverUrl: root.selectedAlbum.length > 0
        ? root.selectedAlbumCover()
        : root.libraryCoverUrl
    /** Themed fallback art so the header always shows a playlist cover. */
    property string libraryCoverUrl: ""

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
        const handler = function () {
            operation.completed.disconnect(handler);
            if (operation.state === 2) {
                if (callback)
                    callback(operation.result);
            } else if (operation.state === 3) {
                const message = operation.errorMessage || "操作失败";
                errorMessage = message;
                plugin.toast.danger(message);
                // Failure still settles the request so loading states and
                // epoch guards never strand a skeleton view.
                if (callback)
                    callback(null);
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

    function folderKnown(id) {
        for (let i = 0; i < folders.length; i++) {
            if (folders[i].id === id)
                return true;
        }
        return false;
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

    function refreshSettings(reload) {
        run("library.settings.get", {}, function (result) {
            if (!result)
                return;
            folders = asArray(result.folders);
            if (folderFilter.length > 0 && !folderKnown(folderFilter))
                folderFilter = "";
            if (reload)
                reloadLibrary();
        });
    }

    function reloadLibrary() {
        run("library.info", {}, function (result) {
            if (!result)
                return;
            libraryReady = result.ready === true;
            libraryCount = typeof result.count === "number" ? result.count : 0;
            libraryAlbums = typeof result.albums === "number" ? result.albums : 0;
            folderCount = typeof result.folders === "number" ? result.folders : 0;
            resetView();
        });
    }

    // Monotonic request epochs: only the newest view request may land, so a
    // late reply from a superseded sort/filter cannot append foreign rows.
    property int pageEpoch: 0
    property int albumEpoch: 0

    function resetView() {
        pageEpoch += 1;
        albumEpoch += 1;
        clearSongRows();
        clearAlbumRows();
        pageLoading = false;
        loadingMore = false;
        albumsLoading = false;
        // Keep songTotal/albumTotal across view switches: only the active
        // view reloads, and zeroing here would strand the other tab's count
        // at 0 until it is visited again. Each view's reply refreshes its
        // own total.
        if (!libraryReady)
            return;
        // Branch on the raw properties, not the albumGridActive binding:
        // reading a derived binding inside the notify cycle of its own
        // dependency (onSelectedAlbumChanged) can serve the stale cached
        // value, sending drill-ins to the album grid loader and leaving
        // the song list empty.
        if (viewTab === 1 && selectedAlbum.length === 0)
            albumsLoad();
        else
            pageLoad();
    }

    function rowModel(row) {
        return {
            title: row.title || row.path,
            artistText: row.artist || "",
            albumText: row.album || "",
            coverUrl: row.cover || "",
            durationText: formatDuration(row.durationMs),
            extraText: "",
            resourceId: row.id,
            artistLinks: row.artist ? [{
                    name: row.artist
                }] : [],
            albumId: "",
            original: false,
            privilegeTags: [],
            qualityLabel: row.quality === "flac" ? "无损" : ""
        };
    }

    /** Push rows into the song list: the JS array IS the display model, and
     * the reassignment it takes on append is a model reset — so preserve the
     * scroll position around it. forceLayout flushes the reset relayout
     * before the restore; EchoViewPoolGuard is deliberately absent from the
     * song list, because its delayed detach/reattach dance re-snaps the
     * position after any synchronous restore. */
    function appendSongRows(rows) {
        if (rows.length === 0)
            return;
        const y = songList.contentY;
        for (let i = 0; i < rows.length; i++)
            songIndexById[rows[i].resourceId] = pageRows.length + i;
        pageRows = pageRows.concat(rows);
        songList.forceLayout();
        songList.contentY = y;
    }

    function clearSongRows() {
        pageRows = [];
        songIndexById = ({});
    }

    function appendAlbumRows(rows) {
        albumRows = albumRows.concat(rows);
        albumModel.append(rows);
    }

    function clearAlbumRows() {
        albumRows = [];
        albumModel.clear();
    }

    /** Cover delivery for song rows. Delegates request their own cover as
     * they enter the view and the requests batch into small library.covers
     * calls: a whole-page batch of full-size data URLs reaches tens of MB
     * across the FFI and stalls the host, so a reply is bounded by the
     * visible window, never by the page size. */
    property var coverRequests: ({})
    property var coverMisses: ({})
    property bool coversInFlight: false
    readonly property int coverBatchSize: 16

    Timer {
        id: coverBatchTimer
        interval: 60
        onTriggered: root.requestCoverBatch()
    }

    function applyCovers(result, requestedIds) {
        const covers = result && result.covers ? result.covers : {};
        const truncated = !!(result && result.truncated);
        for (let i = 0; i < requestedIds.length; i++) {
            const id = requestedIds[i];
            if (covers[id])
                continue;
            if (truncated) {
                // The reply hit its payload cap; retry this id in a later
                // batch instead of writing it off.
                coverRequests[id] = true;
            } else {
                // No entry exists for this song; delegates stop re-requesting.
                coverMisses[id] = true;
            }
        }
        // In-place row update plus a poke at the live delegate: the model
        // array is never reassigned here, so no reset can fire mid-scroll.
        // Rows revealed later pick the cover up through normal delegate
        // creation, which reads the mutated row.
        const ids = Object.keys(covers);
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            const url = covers[id];
            const index = songIndexById[id];
            if (!url || index === undefined || !pageRows[index] || pageRows[index].coverUrl === url)
                continue;
            pageRows[index].coverUrl = url;
            const item = songList.itemAtIndex(index);
            if (item && !item.pooled)
                item.coverUrl = url;
        }
        if (Object.keys(coverRequests).length > 0 && !coverBatchTimer.running)
            coverBatchTimer.restart();
    }

    function scheduleRowCover(id, currentUrl) {
        if (!id || id.length === 0 || currentUrl.length > 0)
            return;
        if (coverMisses[id] || coverRequests[id])
            return;
        coverRequests[id] = true;
        if (!coverBatchTimer.running)
            coverBatchTimer.restart();
    }

    function requestCoverBatch() {
        const ids = Object.keys(coverRequests);
        if (ids.length === 0)
            return;
        if (coversInFlight) {
            coverBatchTimer.restart();
            return;
        }
        const batch = ids.slice(0, root.coverBatchSize);
        for (let i = 0; i < batch.length; i++)
            delete coverRequests[batch[i]];
        coversInFlight = true;
        // Hand-rolled instead of run(): a failed batch must settle quietly
        // (no toast) and leave re-requesting to the delegates when they
        // enter the view again.
        const operation = plugin.executeCommand("library.covers", {
            ids: batch
        });
        if (!operation) {
            coversInFlight = false;
            return;
        }
        const handler = function () {
            operation.completed.disconnect(handler);
            coversInFlight = false;
            if (operation.state === 2)
                applyCovers(operation.result, batch);
        };
        operation.completed.connect(handler);
    }

    function pageLoad() {
        if (!libraryReady)
            return;
        const epoch = ++pageEpoch;
        pageLoading = true;
        run("library.page", {
            offset: pageRows.length,
            limit: 100,
            keyword: keyword.trim(),
            folderId: folderFilter,
            album: selectedAlbum,
            sort: sortKey,
            sortDir: sortDirection
        }, function (result) {
            if (epoch !== pageEpoch)
                return;
            pageLoading = false;
            if (!result)
                return;
            if (!result.ready) {
                libraryReady = false;
                return;
            }
            songTotal = result.total || 0;
            appendSongRows((result.songs || []).map(rowModel));
        });
    }

    function loadMore() {
        if (!hasMore || loadingMore || pageLoading)
            return;
        const epoch = pageEpoch;
        loadingMore = true;
        run("library.page", {
            offset: pageRows.length,
            limit: 100,
            keyword: keyword.trim(),
            folderId: folderFilter,
            album: selectedAlbum,
            sort: sortKey,
            sortDir: sortDirection
        }, function (result) {
            if (epoch !== pageEpoch)
                return;
            loadingMore = false;
            if (!result || !result.ready) {
                if (result && !result.ready)
                    libraryReady = false;
                return;
            }
            songTotal = result.total || 0;
            appendSongRows((result.songs || []).map(rowModel));
        });
    }

    function albumRowsFrom(result) {
        return (result.albums || []).map(function (album) {
            return {
                title: album.name,
                artistText: "",
                extraText: `${album.count} 首`,
                coverUrl: album.cover || "",
                durationText: "",
                resourceId: album.name
            };
        });
    }

    /** Album cards carry their rep cover inline; a batch of 24 keeps the
     * FFI payload of one reply bounded instead of shipping every album's
     * artwork at once. */
    readonly property int albumBatchSize: 24

    function albumsLoad() {
        if (!libraryReady)
            return;
        const epoch = ++albumEpoch;
        albumsLoading = true;
        run("library.albums", {
            offset: albumRows.length,
            limit: root.albumBatchSize,
            keyword: keyword.trim(),
            folderId: folderFilter,
            sort: sortKey,
            sortDir: sortDirection
        }, function (result) {
            if (epoch !== albumEpoch)
                return;
            albumsLoading = false;
            if (!result)
                return;
            if (!result.ready) {
                libraryReady = false;
                return;
            }
            albumTotal = result.total || 0;
            appendAlbumRows(albumRowsFrom(result));
        });
    }

    /** Grid scroll reached the end: fetch the next album batch. Appends keep
     * the current epoch, like the song list's loadMore. */
    function albumsAppend() {
        if (!libraryReady || albumsLoading || !albumGridActive)
            return;
        if (albumRows.length >= albumTotal)
            return;
        const epoch = albumEpoch;
        albumsLoading = true;
        run("library.albums", {
            offset: albumRows.length,
            limit: root.albumBatchSize,
            keyword: keyword.trim(),
            folderId: folderFilter,
            sort: sortKey,
            sortDir: sortDirection
        }, function (result) {
            if (epoch !== albumEpoch)
                return;
            albumsLoading = false;
            if (!result || !result.ready)
                return;
            albumTotal = result.total || 0;
            appendAlbumRows(albumRowsFrom(result));
        });
    }

    function playAll() {
        if (!libraryReady)
            return;
        run("play", viewArgs(0), null);
    }

    function viewArgs(index) {
        const args = {
            mode: "now",
            keyword: keyword.trim(),
            folderId: folderFilter,
            album: selectedAlbum,
            sort: sortKey,
            sortDir: sortDirection
        };
        if (index !== undefined && index !== null)
            args.index = index;
        return args;
    }

    function playAt(index) {
        if (!libraryReady)
            return;
        run("play", viewArgs(index), null);
    }

    function queueRow(resourceId, mode) {
        run("play", {
            mode: mode,
            ids: [resourceId]
        }, function (result) {
            if (result && result.ok)
                plugin.toast.success(mode === "next" ? "将在下一首播放" : "已添加到队列");
        });
    }

    function showSongMenu(id, sceneX, sceneY) {
        menuSongId = id;
        songMenu.songId = id;
        songMenu.rowIndex = 0;
        for (let i = 0; i < pageRows.length; i++) {
            if (pageRows[i].resourceId === id) {
                songMenu.rowIndex = i;
                break;
            }
        }
        // Popups have no mapFromItem; map the scene point onto the page, the
        // popup's parent, and open there like the host menus do.
        const local = root.mapFromItem(null, sceneX, sceneY);
        songMenu.popup(local.x, local.y);
    }

    function selectedAlbumCover() {
        for (let i = 0; i < albumRows.length; i++) {
            if (albumRows[i].resourceId === selectedAlbum)
                return albumRows[i].coverUrl;
        }
        return "";
    }

    function locateCurrent() {
        if (!libraryReady || currentTrackId.length === 0)
            return;
        for (let i = 0; i < pageRows.length; i++) {
            if (pageRows[i].resourceId === currentTrackId) {
                EchoListPositioning.positionIfNeeded(songList, i, ListView.Center, viewport);
                return;
            }
        }
    }

    function startScan() {
        run("library.scan", {}, function (result) {
            if (result && result.busy)
                plugin.toast.info(result.message || "已有扫描任务正在进行");
        });
    }

    function changeSort(field) {
        if (sortField === field) {
            sortDirection = sortDirection === 2 ? 1 : 2;
        } else {
            sortField = field;
            sortDirection = 1;
        }
        resetView();
    }

    onPageActiveChanged: if (pageActive && folders.length === 0)
        refreshSettings(true)

    onSelectedAlbumChanged: if (libraryReady && albumTab)
        resetView()

    onFolderFilterChanged: if (libraryReady)
        resetView()

    Component.onCompleted: {
        if (plugin.cover) {
            try {
                libraryCoverUrl = plugin.cover.createThemedIconCoverUrl({ icon: "music" });
            } catch (error) {
                libraryCoverUrl = "";
            }
        }
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

    EchoEnter {
        target: viewport
        active: root.pageActive
    }

    EchoPageScrollContainer {
        id: viewport
        anchors.fill: parent
        pageActive: root.pageActive
        scrollView: root.albumGridActive ? albumGrid : songList
        coordinatedViews: [songList, albumGrid]
        resetViews: coordinatedViews
        stickyHeaders: [pageHeader, toolbar]

        SongListGeometry {
            id: listGeometry
            rowCount: songList.count
        }

        ListView {
            id: songList
            x: root.contentInset
            width: Math.max(0, parent.width - root.contentInset * 2)
            height: parent.height
            // Visible even when empty so the shared footer carries the
            // empty state, like CatalogSongList's footer.
            visible: !root.albumGridActive && !root.pageLoading
            topMargin: detailHeader.expandedHeight + toolbar.height + 8
            bottomMargin: 48
            // JS array model: SongRow's artistLinks needs JS-array semantics
            // (ListModels hand nested object arrays back as nested models,
            // breaking the artist row). Appends preserve the scroll position
            // in appendSongRows; the pool guard must stay off, its delayed
            // detach/reattach re-snaps the position after the restore.
            model: root.pageRows
            reuseItems: true
            cacheBuffer: 240
            boundsBehavior: Flickable.StopAtBounds
            onAtYEndChanged: if (atYEnd)
                root.loadMore()
            onMovementEnded: if (atYEnd)
                root.loadMore()
            ScrollBar.vertical: EchoPageScrollBar {
                view: songList
                container: viewport
                viewActive: songList.visible && root.pageActive
            }
            delegate: SongRow {
                id: row
                required original
                required privilegeTags
                required qualityLabel
                property bool pooled: false
                width: songList.width
                geometry: listGeometry
                showAlbum: root.selectedAlbum.length === 0
                active: resourceId.length > 0 && resourceId === root.currentTrackId
                playing: root.plugin.player.playing
                playbackLoading: root.plugin.player.loading
                playbackAvailable: root.libraryReady
                // Rows entering the view (created or reused out of the pool)
                // ask for their own cover; the batch machinery dedupes.
                Component.onCompleted: root.scheduleRowCover(resourceId, coverUrl)
                onPooledChanged: if (!pooled)
                    root.scheduleRowCover(resourceId, coverUrl)
                // No favorite ledger for local files; leaving this false
                // disables the heart instead of offering a dead toggle.
                actionsAvailable: false
                resourceActive: root.pageActive && !pooled
                contextTarget: root.menuSongId.length > 0 && resourceId === root.menuSongId
                ListView.onPooled: pooled = true
                ListView.onReused: pooled = false
                onPlayRequested: id => {
                    if (id === root.currentTrackId) {
                        root.plugin.player.toggle();
                        return;
                    }
                    root.playAt(index);
                }
                onDoubleClicked: if (!row.pendingPlay)
                    root.playAt(index)
                onCommentsRequested: id => root.plugin.toast.info("本地歌曲暂不支持评论")
                onMoreRequested: (id, sceneX, sceneY) => root.showSongMenu(id, sceneX, sceneY)
                TapHandler {
                    acceptedButtons: Qt.RightButton
                    onTapped: eventPoint => {
                        const point = row.mapToItem(null, eventPoint.position.x, eventPoint.position.y);
                        root.showSongMenu(row.resourceId, point.x, point.y);
                    }
                }
            }
            footer: Item {
                id: songFooter
                readonly property bool empty: !root.albumGridActive && !root.pageLoading && root.pageRows.length === 0
                readonly property bool more: root.loadingMore
                width: songList.width
                visible: songFooter.empty || songFooter.more
                height: songFooter.empty ? 156 : 44
                ColumnLayout {
                    anchors.centerIn: parent
                    visible: songFooter.empty
                    spacing: 8

                    EchoIcon {
                        Layout.alignment: Qt.AlignHCenter
                        Layout.preferredWidth: 34
                        Layout.preferredHeight: 34
                        name: root.scanError.length > 0 || root.errorMessage.length > 0 ? "alert-circle" : "database"
                        color: Theme.iconSecondary
                    }
                    Label {
                        Layout.alignment: Qt.AlignHCenter
                        text: root.scanError.length > 0 ? `扫描失败：${root.scanError}` : root.errorMessage.length > 0 ? root.errorMessage : root.folderCount === 0 ? "还没有音乐文件夹，点击右上角设置添加" : !root.libraryReady ? "曲库尚未扫描，点击「扫描」建立列表" : "没有匹配的歌曲"
                        font: Theme.font(12, Theme.regularWeight)
                        color: Theme.secondaryText
                    }
                    EchoSoftButton {
                        Layout.alignment: Qt.AlignHCenter
                        visible: root.folderCount === 0
                        text: "打开插件设置"
                        onClicked: root.openSettings()
                    }
                    EchoSoftButton {
                        Layout.alignment: Qt.AlignHCenter
                        visible: root.folderCount > 0 && !root.libraryReady
                        text: "开始扫描"
                        onClicked: root.startScan()
                    }
                }
                Text {
                    anchors.centerIn: parent
                    visible: songFooter.more
                    text: "正在加载更多…"
                    textFormat: Text.PlainText
                    color: Theme.secondaryText
                    font: Theme.font(12, Theme.regularWeight)
                }
            }
        }

        ContentGrid {
            id: albumGrid
            x: root.contentInset
            width: Math.max(0, parent.width - root.contentInset * 2)
            height: parent.height
            visible: root.albumGridActive
            pageActive: root.pageActive && root.albumGridActive
            pageContainer: viewport
            topMargin: detailHeader.expandedHeight + toolbar.height + 8
            bottomMargin: 48
            sourceModel: albumModel
            loading: root.albumsLoading && root.albumRows.length === 0
            hasMore: root.albumGridActive && root.albumRows.length < root.albumTotal
            loadingMore: root.albumsLoading
            onLoadMoreRequested: root.albumsAppend()
            navigationAvailable: true
            onOpenRequested: name => root.selectedAlbum = name
        }

        // Initial-load skeleton, mirroring the shared catalog loading view.
        ListView {
            id: skeletonList
            x: root.contentInset
            width: Math.max(0, parent.width - root.contentInset * 2)
            height: parent.height
            visible: root.pageLoading && root.pageRows.length === 0 && !root.albumGridActive
            interactive: false
            reuseItems: true
            cacheBuffer: 0
            model: 8
            topMargin: detailHeader.expandedHeight + toolbar.height + 8
            EchoViewPoolGuard {
                targetView: skeletonList
            }
            delegate: SongSkeletonRow {
                property bool pooled: false
                width: skeletonList.width
                geometry: listGeometry
                animate: root.pageActive && !pooled
                showAlbum: root.selectedAlbum.length === 0
                ListView.onPooled: pooled = true
                ListView.onReused: pooled = false
            }
        }

        EchoPageStickyHeader {
            id: pageHeader
            container: viewport
            flowPosition: 0
            // The shared sliver header collapses from 176 to 56 as the list
            // scrolls; the sticky toolbar rides on its animated height while
            // the flow positions below use the fixed expanded height.
            height: detailHeader.implicitHeight

            SongDetailHeader {
                id: detailHeader
                anchors.fill: parent
                scrollTop: viewport.scrollTop
                heading: root.headerTitle
                typeLabel: "LOCAL"
                // Always-visible intro plus the shared metadata count row,
                // matching the Favorites page header composition.
                subtitle: "管理本地音乐文件夹并播放本地音乐。"
                secondaryDetailsComponent: Component {
                    Flow {
                        objectName: "localLibraryMetadata"
                        spacing: 12

                        EchoButtonContent {
                            objectName: "localLibrarySongCount"
                            width: Math.min(parent.width, implicitWidth + 4)
                            height: implicitHeight
                            horizontalAlignment: Qt.AlignLeft
                            glyph: "music"
                            glyphSize: 12
                            spacing: 6
                            lineHeight: 16.5
                            text: root.songCountLabel
                            font: Theme.font(11, Theme.semiboldWeight)
                            color: Theme.secondaryText
                        }
                        Repeater {
                            model: [root.albumCountLabel].filter(value => value.length > 0)
                            delegate: EchoTextTagRow {
                                required property string modelData
                                objectName: "localLibraryMetadataField"
                                width: Math.min(parent.width, implicitWidth + 4)
                                height: implicitHeight
                                text: modelData
                                lineHeight: 16.5
                                font: Theme.font(11, Theme.semiboldWeight)
                                color: Theme.secondaryText
                            }
                        }
                    }
                }
                playable: root.libraryReady && root.songTotal > 0
                showBatchAction: false
                resourceActive: root.pageActive
                loading: root.scanRunning && !root.libraryReady
                coverComponent: Component {
                    EchoCover {
                        objectName: "localLibraryCover"
                        source: root.headerCoverUrl
                        resourceActive: root.pageActive
                        cornerRadius: Theme.mediaRadius / detailHeader.coverScale
                        placeholderGlyph: "vinyl"
                        placeholderGlyphSize: 32
                    }
                }
                // Only supply the slot while drilled in: the host loader stays
                // visible whenever a component is set, so a hidden button would
                // still reserve its width as blank space before the actions.
                leadingActions: root.selectedAlbum.length > 0 ? backActions : null
                Component {
                    id: backActions

                    EchoSoftButton {
                        text: "返回"
                        glyph: "arrow-left"
                        onClicked: root.selectedAlbum = ""
                    }
                }
                additionalActions: Component {
                    RowLayout {
                        spacing: 8

                        EchoSoftButton {
                            text: "扫描"
                            glyph: "refresh-source"
                            onClicked: root.startScan()
                        }
                        EchoSoftButton {
                            text: "设置"
                            glyph: "settings"
                            onClicked: root.openSettings()
                        }
                    }
                }
                collapsedActions: Component {
                    RowLayout {
                        spacing: 8

                        EchoIconButton {
                            glyph: "refresh-source"
                            tooltipText: "扫描"
                            onClicked: root.startScan()
                        }
                        EchoIconButton {
                            glyph: "settings"
                            tooltipText: "插件设置"
                            onClicked: root.openSettings()
                        }
                    }
                }
                onPlayRequested: root.playAll()
            }
        }

        EchoPageStickyHeader {
            id: toolbar
            container: viewport
            visible: true
            flowPosition: detailHeader.expandedHeight
            stickyTop: pageHeader.height
            height: toolbarColumn.implicitHeight

            // Shared rule: one hairline between the tab row and the sort
            // header. Like the host pages it overlays the tab row's last
            // device row instead of occupying a layout row, so the sort
            // header and its own bottom divider keep the host's exact
            // offsets. The shared control parks the line on a whole device
            // row under fractional Windows scaling.
            EchoDivider {
                objectName: "localMusicToolbarDivider"
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.leftMargin: root.contentInset
                anchors.rightMargin: root.contentInset
                y: tabsRow.height - 1
                height: 1
                lineColor: Theme.subtleBorder
            }

            ColumnLayout {
                id: toolbarColumn
                anchors.fill: parent
                spacing: 0

                RowLayout {
                    id: tabsRow
                    objectName: "localMusicToolbarRow"
                    Layout.fillWidth: true
                    Layout.preferredHeight: 56
                    Layout.leftMargin: root.contentInset
                    Layout.rightMargin: root.contentInset
                    spacing: 8

                    EchoDetailTabs {
                        labels: ["歌曲", "专辑"]
                        counts: [root.songTotal, root.albumTotal]
                        currentIndex: root.viewTab
                        onPicked: index => {
                            if (index === 1)
                                root.selectedAlbum = "";
                            root.viewTab = index;
                            root.resetView();
                        }
                    }
                    Item {
                        Layout.fillWidth: true
                    }
                    EchoSelect {
                        Layout.preferredWidth: 180
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
                    EchoTextField {
                        Layout.preferredWidth: 160
                        Layout.minimumWidth: 80
                        placeholderText: root.albumGridActive ? "搜索专辑..." : "搜索歌曲..."
                        clearable: true
                        text: root.keyword
                        onTextEdited: {
                            root.keyword = text;
                            searchDebounce.restart();
                        }
                        onAccepted: {
                            root.keyword = text;
                            searchDebounce.stop();
                            root.resetView();
                        }
                        onCleared: {
                            root.keyword = "";
                            root.resetView();
                        }
                    }
                    SongLocateButton {
                        visible: !root.albumGridActive
                        onClicked: root.locateCurrent()
                    }
                }
                SongListHeader {
                    visible: !root.albumGridActive
                    Layout.fillWidth: true
                    Layout.leftMargin: root.contentInset
                    Layout.rightMargin: root.contentInset
                    Layout.preferredHeight: root.albumGridActive ? 0 : 44
                    geometry: listGeometry
                    sortField: root.sortField
                    sortDirection: root.sortDirection
                    onSortPicked: field => root.changeSort(field)
                }
            }
        }
    }

    // The menu lives at page scope so scene coordinates from the row
    // delegate map cleanly onto it.
    EchoMenu {
        id: songMenu

        property string songId: ""
        property int rowIndex: 0

        EchoMenuEntry {
            text: "立即播放"
            onTriggered: root.playAt(songMenu.rowIndex)
        }
        EchoMenuEntry {
            text: "下一首播放"
            onTriggered: root.queueRow(songMenu.songId, "next")
        }
        EchoMenuEntry {
            text: "添加到队列"
            onTriggered: root.queueRow(songMenu.songId, "append")
        }
        onClosed: root.menuSongId = ""
    }

    Timer {
        id: searchDebounce
        interval: 300
        onTriggered: root.resetView()
    }
}

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

// WebDAV library page composed from the same host detail-page structure as
// local-music: EchoPageScrollContainer viewport with a flow header and a
// sticky toolbar (EchoDetailTabs + SongListHeader), SongRow rows over the
// shared SongListGeometry, skeleton loading rows, load-more on scroll end
// and the shared EchoEnter page fade. The 目录 tab drives the directory
// browse: a folder/file list styled after the same rows, with the header's
// back button playing the breadcrumb (album drill-in pattern).
Item {
    id: root

    required property EchoPluginContext plugin
    required property RouteContext context
    readonly property bool pageActive: context.active && plugin.active

    property var libraries: []
    property string activeLibraryId: ""
    property string coverLyricSource: "embedded"
    property var currentLibrary: null
    /** 0 = 歌曲 (flat scan list), 1 = 目录 (directory browse). */
    property int viewTab: 0
    property string keyword: ""
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

    property bool flatReady: false
    /** Library-wide flat list count from flat.load (unfiltered). */
    property int flatCount: 0
    property bool flatTruncated: false

    // Cumulative rows: paging appends at the list end like the shared
    // catalogs, driven by atYEnd instead of page buttons.
    property var pageRows: []
    property int songTotal: 0
    property bool pageLoading: false
    property bool loadingMore: false
    readonly property bool hasMore: flatReady && viewTab === 0 && pageRows.length < songTotal
    // Monotonic request epochs: only the newest view request may land.
    property int pageEpoch: 0

    // Directory browse state (tab 1).
    property var browse: ({
        loading: false,
        error: "",
        path: "",
        root: "/",
        dirs: [],
        files: []
    })
    // Guards against a stale browse response: rapid navigation fires two
    // browse.load requests and the slower (older) reply must not overwrite
    // the newer directory's rows (legacy v1.4.5 fix).
    property int browseToken: 0

    property var scanState: ({})
    readonly property bool scanRunning: !!root.scanState && root.scanState.running === true
    readonly property bool scanDone: !!root.scanState && root.scanState.done === true
    readonly property bool scanAborted: !!root.scanState && root.scanState.aborted === true
    readonly property string scanError: root.scanState && typeof root.scanState.error === "string" ? root.scanState.error : ""
    readonly property string scanLabel: root.scanState && typeof root.scanState.label === "string" ? root.scanState.label : ""

    property string errorMessage: ""
    readonly property int contentInset: 24

    // Host queue ingestion rewrites track ids to "plugin:<plugin-id>:<id>"
    // (EchoPluginPlaylist::parse) and the player snapshot hands that
    // rewritten id back; rows carry the bare song id, so strip the
    // namespace before comparing anywhere (row highlight, locate).
    function songIdOf(trackId) {
        return String(trackId || "").replace(/^plugin:[^:]+:/, "");
    }

    readonly property string currentTrackId: {
        const snapshot = plugin.player.snapshot;
        return snapshot && snapshot.hasTrack ? songIdOf(snapshot.track.id) : "";
    }
    readonly property string headerTitle: {
        if (root.viewTab === 1 && root.browse.path.length > 0 && root.browse.path !== (root.browse.root || "/")) {
            const cut = root.browse.path.lastIndexOf("/");
            const name = cut >= 0 ? root.browse.path.slice(cut + 1) : root.browse.path;
            if (name.length > 0)
                return name;
        }
        return "WebDAV 音乐";
    }
    readonly property string songCountLabel: {
        const base = `${root.flatCount} 首歌曲`;
        return root.flatTruncated ? `${base}（已达上限，结果不完整）` : base;
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
        if (!operation) {
            // A null operation (usually deactivation) must still settle the
            // request: every caller sets a loading flag before this call.
            if (callback)
                callback(null);
            return;
        }
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

    /** The sorted/filtered view query shared by pages, locate and play: the
     * backend applies the same ordering so indexes line up everywhere. */
    function viewArgs() {
        return {
            keyword: keyword.trim(),
            sort: sortKey,
            sortDir: sortDirection
        };
    }

    function refreshSettings(reload) {
        run("settings.get", {}, function (result) {
            const nextLibraries = result ? asArray(result.libraries) : [];
            libraries = nextLibraries;
            coverLyricSource = result && result.coverLyricSource === "kugou" ? "kugou" : "embedded";
            let nextId = activeLibraryId;
            if (!libraryById(nextId))
                nextId = result && typeof result.activeLibraryId === "string" ? result.activeLibraryId : "";
            activeLibraryId = nextId;
            currentLibrary = libraryById(nextId);
            // 默认平铺视图 decides the tab the page opens on (the legacy
            // flatMode semantics: on → 歌曲, off → start in 目录). Later
            // setting revisions must not yank the user between tabs mid-use.
            if (!initialTabApplied) {
                initialTabApplied = true;
                viewTab = currentLibrary && currentLibrary.flatView === true ? 0 : 1;
            }
            if (reload)
                reloadCurrent();
        });
    }

    function reloadCurrent() {
        flatReady = false;
        flatCount = 0;
        flatTruncated = false;
        if (viewTab === 0) {
            ensureFlatAndLoad();
        } else {
            browseLoad("");
        }
    }

    /** Loads (or starts) the flat scan for the active library, then pages
     * the list. Mirrors local-music's reloadLibrary + libraryReady gate. */
    function ensureFlatAndLoad() {
        if (!currentLibrary)
            return;
        run("flat.load", {
            libraryId: activeLibraryId
        }, function (result) {
            if (!result)
                return;
            if (result.ready) {
                flatReady = true;
                flatCount = typeof result.count === "number" ? result.count : 0;
                flatTruncated = result.truncated === true;
                resetView();
            } else if (result.started) {
                // The scan runs in the task center; the finished publish
                // reloads this view through onStateChanged.
                pageLoading = false;
            } else if (result.busy) {
                plugin.toast.info(result.message || "已有扫描任务正在进行");
            } else {
                errorMessage = result.message || "无法开始扫描";
            }
        });
    }

    function resetView() {
        pageEpoch += 1;
        clearSongRows();
        pageLoading = false;
        loadingMore = false;
        if (viewTab === 0) {
            // flatReady only flips true through flat.load, so a scan that
            // just finished (or a first visit with no cache) must go through
            // ensureFlatAndLoad — returning here would leave the list empty
            // behind the "not scanned" footer forever.
            if (!flatReady) {
                ensureFlatAndLoad();
                return;
            }
            pageLoad();
        } else {
            browseLoad("");
        }
    }

    function rowModel(row) {
        return {
            kind: "file",
            path: row.path,
            title: row.title || row.path,
            artistText: row.artist || "",
            albumText: row.album || "",
            coverUrl: "",
            durationText: "",
            durationMs: 0,
            extraText: "",
            resourceId: row.id,
            // Host EchoArtistLinks reads `modelData.id.length` per delegate; an
            // entry without `id` throws on every re-evaluation. WebDAV songs
            // have no domain id — an empty id keeps the button honestly
            // disabled without the throw.
            artistLinks: row.artist ? [{
                    name: row.artist,
                    id: ""
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
     * before the restore. */
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
        // The miss cache must not outlive the rows it describes: a library
        // rebuild (rescan, settings change) can produce covers for songs
        // whose earlier lookup failed transiently.
        coverRequests = ({});
        coverMisses = ({});
    }

    // ── Cover delivery for song rows ───────────────────────────────────────
    //
    // Delegates request their own cover as they enter the view and the
    // requests batch into small flat.covers calls. Covers come from the
    // persisted enrichment records, so a batch is a few KV reads — never a
    // network request. The reply also carries known durations.

    property var songIndexById: ({})
    property var coverRequests: ({})
    // ids already shipped in a batch that has not landed yet: a delegate
    // entering the view must not stack a duplicate request behind it.
    property var coverInFlightIds: ({})
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
        const durations = result && result.durations ? result.durations : {};
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
        // Both writes are diffed: a row can already hold the URL from an
        // earlier batch while its delegate sat in the reuse pool.
        const ids = Object.keys(covers);
        for (let c = 0; c < ids.length; c++) {
            const id = ids[c];
            const url = covers[id];
            const index = songIndexById[id];
            if (!url || index === undefined || !pageRows[index])
                continue;
            if (pageRows[index].coverUrl !== url)
                pageRows[index].coverUrl = url;
            const item = songList.itemAtIndex(index);
            if (item && !item.pooled && item.coverUrl !== url)
                item.coverUrl = url;
        }
        const durationIds = Object.keys(durations);
        for (let d = 0; d < durationIds.length; d++) {
            const durationId = durationIds[d];
            const ms = durations[durationId];
            const durationIndex = songIndexById[durationId];
            if (typeof ms !== "number" || ms <= 0 || durationIndex === undefined || !pageRows[durationIndex])
                continue;
            const text = formatDuration(ms);
            if (pageRows[durationIndex].durationMs !== ms) {
                pageRows[durationIndex].durationMs = ms;
                pageRows[durationIndex].durationText = text;
            }
            const durationItem = songList.itemAtIndex(durationIndex);
            if (durationItem && !durationItem.pooled && durationItem.durationText !== text)
                durationItem.durationText = text;
        }
        if (Object.keys(coverRequests).length > 0 && !coverBatchTimer.running)
            coverBatchTimer.restart();
    }

    function scheduleRowCover(id, currentUrl) {
        if (!id || id.length === 0 || currentUrl.length > 0)
            return;
        if (coverMisses[id] || coverRequests[id] || coverInFlightIds[id])
            return;
        coverRequests[id] = true;
        if (!coverBatchTimer.running)
            coverBatchTimer.restart();
    }

    /** The authoritative cover for a song id, straight off the page rows:
     * a delegate re-derives its coverUrl from this on reuse instead of
     * keeping whatever the previous row left imperatively poked. */
    function rowCoverFor(id) {
        const index = songIndexById[id];
        if (index === undefined || !pageRows[index])
            return "";
        return pageRows[index].coverUrl;
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
        for (let i = 0; i < batch.length; i++) {
            delete coverRequests[batch[i]];
            coverInFlightIds[batch[i]] = true;
        }
        coversInFlight = true;
        // Hand-rolled instead of run(): a failed batch must settle quietly
        // (no toast) and leave re-requesting to the delegates when they
        // enter the view again.
        const operation = plugin.executeCommand("flat.covers", {
            ids: batch
        });
        if (!operation) {
            for (let r = 0; r < batch.length; r++)
                delete coverInFlightIds[batch[r]];
            coversInFlight = false;
            return;
        }
        const handler = function () {
            operation.completed.disconnect(handler);
            coversInFlight = false;
            for (let f = 0; f < batch.length; f++)
                delete coverInFlightIds[batch[f]];
            if (operation.state === 2)
                applyCovers(operation.result, batch);
        };
        operation.completed.connect(handler);
    }

    // ── Flat paging ────────────────────────────────────────────────────────

    function pageLoad() {
        if (!flatReady || viewTab !== 0)
            return;
        const epoch = ++pageEpoch;
        pageLoading = true;
        const query = viewArgs();
        run("flat.page", {
            libraryId: activeLibraryId,
            offset: 0,
            limit: 100,
            keyword: query.keyword,
            sort: query.sort,
            sortDir: query.sortDir
        }, function (result) {
            if (epoch !== pageEpoch)
                return;
            pageLoading = false;
            if (!result)
                return;
            if (!result.ready) {
                flatReady = false;
                return;
            }
            songTotal = result.total || 0;
            appendSongRows(asArray(result.songs).map(rowModel));
        });
    }

    function loadMore() {
        if (!hasMore || loadingMore || pageLoading || locateLoading)
            return;
        const epoch = pageEpoch;
        loadingMore = true;
        const query = viewArgs();
        run("flat.page", {
            libraryId: activeLibraryId,
            offset: pageRows.length,
            limit: 100,
            keyword: query.keyword,
            sort: query.sort,
            sortDir: query.sortDir
        }, function (result) {
            if (epoch !== pageEpoch)
                return;
            loadingMore = false;
            if (!result || !result.ready) {
                if (result && !result.ready)
                    flatReady = false;
                return;
            }
            songTotal = result.total || 0;
            appendSongRows(asArray(result.songs).map(rowModel));
        });
    }

    // ── Directory browse (tab 1) ───────────────────────────────────────────

    readonly property var displayDirRows: {
        const filter = keyword.trim().toLowerCase();
        let rows = [];
        for (let i = 0; i < browse.dirs.length; i++)
            rows.push({
                kind: "dir",
                id: "",
                path: browse.dirs[i].path,
                title: browse.dirs[i].name,
                artistText: "",
                albumText: "",
                quality: "",
                size: 0
            });
        for (let j = 0; j < browse.files.length; j++) {
            const file = browse.files[j];
            rows.push({
                kind: "file",
                id: file.id,
                path: file.path,
                title: file.title,
                artistText: file.artist,
                albumText: file.album || "",
                quality: file.quality,
                size: file.size
            });
        }
        if (filter.length > 0)
            rows = rows.filter(function (row) {
                return row.title.toLowerCase().indexOf(filter) >= 0 || (row.artistText || "").toLowerCase().indexOf(filter) >= 0;
            });
        return rows;
    }
    readonly property bool dirHasFiles: browse.files.length > 0

    function browseLoad(path) {
        if (!currentLibrary || viewTab !== 1)
            return;
        const target = path || (currentLibrary.rootPath ? currentLibrary.rootPath : "/");
        const token = ++browseToken;
        browse = {
            loading: true,
            error: "",
            path: target,
            root: browse.root,
            dirs: [],
            files: []
        };
        run("browse.load", {
            libraryId: activeLibraryId,
            path: target
        }, function (result) {
            // A stale reply (a slower request for a directory the user has
            // already left) must not overwrite the current rows.
            if (token !== browseToken)
                return;
            if (!result || result.error) {
                browse = {
                    loading: false,
                    error: result && result.message ? result.message : "加载失败",
                    path: target,
                    root: result && result.root ? result.root : browse.root,
                    dirs: [],
                    files: []
                };
                return;
            }
            browse = {
                loading: false,
                error: "",
                path: result.path || target,
                root: result.root || "/",
                dirs: asArray(result.dirs),
                files: asArray(result.files)
            };
        });
    }

    // ── Playback actions ───────────────────────────────────────────────────

    function playAll() {
        if (viewTab === 0) {
            if (!flatReady)
                return;
            const query = viewArgs();
            run("play", {
                libraryId: activeLibraryId,
                flat: true,
                index: 0,
                mode: "now",
                all: true,
                keyword: query.keyword,
                sort: query.sort,
                sortDir: query.sortDir
            }, null);
            return;
        }
        if (!browse.path)
            return;
        run("play", {
            libraryId: activeLibraryId,
            dir: browse.path,
            mode: "now",
            index: 0,
            all: true
        }, null);
    }

    /** Plays the song at `index` of the current flat view; double-click
     * semantics follow the host 播放队列模式 (single mode plays just that
     * track, context mode the whole view). */
    function playAt(index) {
        if (!flatReady || viewTab !== 0)
            return;
        const query = viewArgs();
        run("play", {
            libraryId: activeLibraryId,
            flat: true,
            index: index,
            mode: "now",
            keyword: query.keyword,
            sort: query.sort,
            sortDir: query.sortDir
        }, null);
    }

    function playPaths(paths) {
        if (!currentLibrary)
            return;
        run("play", {
            libraryId: activeLibraryId,
            paths: paths,
            mode: "now"
        }, null);
    }

    function queueRow(path, mode) {
        run("play", {
            libraryId: activeLibraryId,
            paths: [path],
            mode: mode
        }, function (result) {
            if (result && (result.ok || result.count >= 0))
                plugin.toast.success(mode === "next" ? "将在下一首播放" : "已添加到队列");
        });
    }

    function playFolder(path) {
        run("play", {
            libraryId: activeLibraryId,
            dir: path,
            mode: "now",
            index: 0
        }, null);
    }

    function queueFolder(path, mode) {
        run("play", {
            libraryId: activeLibraryId,
            dir: path,
            mode: mode
        }, function (result) {
            if (result && (result.ok || result.count >= 0))
                plugin.toast.success(mode === "next" ? "将在下一首播放" : "已添加到队列");
        });
    }

    function showSongMenu(id, path, sceneX, sceneY) {
        menuSongId = id;
        songMenu.songId = id;
        songMenu.songPath = path;
        songMenu.rowIndex = 0;
        for (let i = 0; i < pageRows.length; i++) {
            if (pageRows[i].resourceId === id) {
                songMenu.rowIndex = i;
                // Flat rows resolve their own path here: the SongRow delegate
                // cannot carry `path` (not a SongRow property, see the
                // required-property note above).
                songMenu.songPath = pageRows[i].path;
                break;
            }
        }
        // Popups have no mapFromItem; map the scene point onto the page, the
        // popup's parent, and open there like the host menus do.
        const local = root.mapFromItem(null, sceneX, sceneY);
        songMenu.popup(local.x, local.y);
    }

    function showFolderMenu(path, sceneX, sceneY) {
        folderMenu.folderPath = path;
        const local = root.mapFromItem(null, sceneX, sceneY);
        folderMenu.popup(local.x, local.y);
    }

    // ── Locate ─────────────────────────────────────────────────────────────

    /** Locate the playing row. The fast path scans the loaded rows; songs
     * past the loaded pages ask the backend for their index in the current
     * sort/filter view and append pages until the row exists. The fetch is
     * mutually exclusive with the scroll-driven loaders — both would append
     * rows at the same offset and duplicate them. */
    property bool locateLoading: false

    function locateCurrent() {
        if (viewTab !== 0 || !flatReady || locateLoading || loadingMore || pageLoading)
            return;
        const trackId = root.currentTrackId;
        if (trackId.length === 0) {
            plugin.toast.info("当前没有播放 WebDAV 歌曲");
            return;
        }
        for (let i = 0; i < pageRows.length; i++) {
            if (pageRows[i].resourceId === trackId) {
                EchoListPositioning.positionIfNeeded(songList, i, ListView.Center, viewport);
                return;
            }
        }
        const epoch = pageEpoch;
        // Freeze the view args for the whole chain: a keyword edit mid-fill
        // must not splice rows of the new view onto the old one (the
        // debounced resetView will restart everything anyway).
        const locateArgs = viewArgs();
        locateLoading = true;
        run("flat.locate", {
            libraryId: activeLibraryId,
            id: trackId,
            keyword: locateArgs.keyword,
            sort: locateArgs.sort,
            sortDir: locateArgs.sortDir
        }, function (result) {
            if (epoch !== pageEpoch) {
                locateLoading = false;
                return;
            }
            // A null result means the command itself failed (run() already
            // toasted); only a real reply with index < 0 is "not in view".
            if (!result) {
                locateLoading = false;
                return;
            }
            const index = typeof result.index === "number" ? result.index : -1;
            if (index < 0) {
                locateLoading = false;
                plugin.toast.info("当前播放的歌曲不在平铺列表中");
                return;
            }
            locateFillTo(index, epoch, locateArgs);
        });
    }

    /** Append pages (bounded fetches, same view args as loadMore) until the
     * located row is loaded, then center it. */
    function locateFillTo(index, epoch, locateArgs) {
        if (pageRows.length > index || pageRows.length >= songTotal) {
            EchoListPositioning.positionIfNeeded(songList, Math.min(index, pageRows.length - 1), ListView.Center, viewport);
            locateLoading = false;
            return;
        }
        run("flat.page", {
            libraryId: activeLibraryId,
            offset: pageRows.length,
            limit: Math.min(500, index - pageRows.length + 100),
            keyword: locateArgs.keyword,
            sort: locateArgs.sort,
            sortDir: locateArgs.sortDir
        }, function (result) {
            if (epoch !== pageEpoch) {
                locateLoading = false;
                return;
            }
            if (!result || !result.ready) {
                locateLoading = false;
                return;
            }
            songTotal = result.total || 0;
            appendSongRows(asArray(result.songs).map(rowModel));
            locateFillTo(index, epoch, locateArgs);
        });
    }

    function startScan() {
        run("flat.load", {
            libraryId: activeLibraryId,
            force: true
        }, function (result) {
            if (result && result.busy)
                plugin.toast.info(result.message || "已有扫描任务正在进行");
        });
    }

    /** The header 扫描 button turns into 停止扫描 while the task runs, like
     * the old page's banner button; the task center action stays available
     * too. flat.abort keeps the already-scanned results. */
    function abortScan() {
        run("flat.abort", {}, null);
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

    function parentDir(path) {
        const normalized = path || "/";
        const cut = normalized.lastIndexOf("/");
        if (cut <= 0)
            return "/";
        return normalized.slice(0, cut);
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

    function crumbPath(index) {
        const prefix = browse.root && browse.root.length > 0 ? browse.root : "/";
        let path = prefix === "/" ? "" : prefix;
        for (let i = 0; i <= index; i++)
            path += `/${pathSegments[i]}`;
        return path.length === 0 ? "/" : path;
    }

    onPageActiveChanged: {
        if (!pageActive)
            return;
        if (pendingLibraryRefresh) {
            pendingLibraryRefresh = false;
            refreshSettings(true);
            return;
        }
        if (libraries.length === 0)
            refreshSettings(true);
    }

    Component.onCompleted: {
        if (plugin.cover) {
            try {
                headerCoverUrl = plugin.cover.createThemedIconCoverUrl({
                    icon: "cloud"
                });
            } catch (error) {
                headerCoverUrl = "";
            }
        }
        const state = plugin.ui.state;
        scanState = state && state.flatScan ? state.flatScan : {};
        const revision = state && typeof state.settingsRevision === "number" ? state.settingsRevision : 0;
        lastSettingsRevision = revision;
        refreshSettings(true);
    }

    property int lastSettingsRevision: -1
    // The 默认平铺视图 gate applies once, on the first settings load.
    property bool initialTabApplied: false
    // A library notification while the page sits in a background stack would
    // still rebuild every row delegate for nothing the user can see; the
    // reload waits for reactivation.
    property bool pendingLibraryRefresh: false

    // Every publish hands over a fresh state object; assigning it re-evaluates
    // every binding that reads it. Skip the write when no rendered field
    // actually moved so steady phases cost zero.
    function scanStateEquals(a, b) {
        if (a === b)
            return true;
        if (!a || !b || typeof a !== "object" || typeof b !== "object")
            return false;
        const keys = Object.keys(a);
        if (keys.length !== Object.keys(b).length)
            return false;
        for (let i = 0; i < keys.length; i++) {
            if (a[keys[i]] !== b[keys[i]])
                return false;
        }
        return true;
    }

    Connections {
        target: root.plugin.ui
        function onStateChanged() {
            const state = root.plugin.ui.state;
            const nextScan = state && state.flatScan ? state.flatScan : {};
            if (!scanStateEquals(root.scanState, nextScan)) {
                root.scanState = nextScan;
                // Scan publishes drive heavy re-renders; a page sitting in
                // the background skips the work and reloads on activation.
                if (!root.pageActive) {
                    root.pendingLibraryRefresh = true;
                } else if ((root.scanDone || root.scanAborted) && root.viewTab === 0) {
                    // A finished (or stopped, partial) scan refreshes the
                    // flat view; running publishes leave the list alone.
                    root.resetView();
                }
            }
            const revision = state && typeof state.settingsRevision === "number" ? state.settingsRevision : -1;
            if (revision >= 0 && revision !== root.lastSettingsRevision) {
                root.lastSettingsRevision = revision;
                if (root.pageActive) {
                    root.refreshSettings(true);
                } else {
                    root.pendingLibraryRefresh = true;
                }
            }
        }
    }

    /** Themed fallback art so the header always shows a playlist cover. */
    property string headerCoverUrl: ""

    EchoEnter {
        target: viewport
        active: root.pageActive
    }

    EchoPageScrollContainer {
        id: viewport
        anchors.fill: parent
        pageActive: root.pageActive
        scrollView: root.viewTab === 0 ? songList : dirList
        coordinatedViews: [songList, dirList]
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
            visible: root.viewTab === 0 && !root.pageLoading
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
                // Only names that exist on SongRow itself may be declared
                // required: the required check runs against the delegate type
                // plus the injected delegate roles (index/modelData), and an
                // unknown name fails the whole delegate component at compile
                // time ("was marked as required but does not exist") — every
                // row then refuses to render. Row fields outside the SongRow
                // contract (path, durationMs) stay on the row objects in
                // pageRows; handlers read them from there by resourceId.
                required original
                required privilegeTags
                required qualityLabel
                property bool pooled: false
                width: songList.width
                geometry: listGeometry
                // The album column stays filled: folder names are real
                // albums for WebDAV songs, and hiding the cell would leave
                // the header's album cell over an empty column.
                showAlbum: true
                active: resourceId.length > 0 && resourceId === root.currentTrackId
                playing: root.plugin.player.playing
                playbackLoading: root.plugin.player.loading
                playbackAvailable: root.flatReady
                // Rows entering the view (created or reused out of the pool)
                // ask for their own cover; the batch machinery dedupes.
                Component.onCompleted: root.scheduleRowCover(resourceId, coverUrl)
                onPooledChanged: if (!pooled)
                    root.scheduleRowCover(resourceId, coverUrl)
                // No favorite ledger for WebDAV files; leaving this false
                // disables the heart instead of offering a dead toggle.
                actionsAvailable: false
                resourceActive: root.pageActive && !pooled
                contextTarget: root.menuSongId.length > 0 && resourceId === root.menuSongId
                ListView.onPooled: pooled = true
                // A pooled delegate keeps every statically assigned property
                // from its previous row — applyCovers pokes coverUrl
                // imperatively, so reuse must re-derive it for the new row
                // or the artwork of another song bleeds through. onReused
                // runs after the model has re-bound the required properties,
                // and the onPooledChanged handler above then re-requests the
                // (now empty) cover through the deduped batch path.
                ListView.onReused: {
                    coverUrl = root.rowCoverFor(resourceId);
                    pooled = false;
                }
                onPlayRequested: id => {
                    if (id === root.currentTrackId) {
                        root.plugin.player.toggle();
                        return;
                    }
                    root.playAt(index);
                }
                onDoubleClicked: if (!row.pendingPlay)
                    root.playAt(index)
                onCommentsRequested: id => root.plugin.toast.info("WebDAV 歌曲暂不支持评论")
                onMoreRequested: (id, sceneX, sceneY) => root.showSongMenu(id, "", sceneX, sceneY)
                TapHandler {
                    acceptedButtons: Qt.RightButton
                    onTapped: eventPoint => {
                        const point = row.mapToItem(null, eventPoint.position.x, eventPoint.position.y);
                        root.showSongMenu(row.resourceId, "", point.x, point.y);
                    }
                }
            }
            footer: Item {
                id: songFooter
                readonly property bool empty: root.viewTab === 0 && !root.pageLoading && root.pageRows.length === 0
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
                        text: {
                            if (root.scanError.length > 0)
                                return `扫描失败：${root.scanError}`;
                            if (root.errorMessage.length > 0)
                                return root.errorMessage;
                            if (root.libraries.length === 0)
                                return "还没有 WebDAV 库，点击右上角设置添加";
                            if (!root.flatReady)
                                return root.scanRunning || root.scanLabel.length > 0 ? root.scanLabel : "平铺列表尚未扫描，点击「扫描」建立列表";
                            return "没有匹配的歌曲";
                        }
                        font: Theme.font(12, Theme.regularWeight)
                        color: Theme.secondaryText
                    }
                    EchoSoftButton {
                        Layout.alignment: Qt.AlignHCenter
                        visible: root.libraries.length === 0
                        text: "打开插件设置"
                        onClicked: root.openSettings()
                    }
                    EchoSoftButton {
                        Layout.alignment: Qt.AlignHCenter
                        visible: root.libraries.length > 0 && !root.flatReady && !root.scanRunning
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

        // Directory browse (目录 tab): folder rows above file rows, styled
        // after the same 60px row rhythm. Delegates stay simple — a plain
        // Item holds both variants because SongRow's required properties
        // are model-injected only at the delegate root.
        ListView {
            id: dirList
            x: root.contentInset
            width: Math.max(0, parent.width - root.contentInset * 2)
            height: parent.height
            visible: root.viewTab === 1 && !root.browse.loading
            topMargin: detailHeader.expandedHeight + toolbar.height + 8
            bottomMargin: 48
            model: root.displayDirRows
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: EchoPageScrollBar {
                view: dirList
                container: viewport
                viewActive: dirList.visible && root.pageActive
            }
            delegate: Item {
                id: dirRow
                required property int index
                required property var modelData
                readonly property bool isDir: dirRow.modelData.kind === "dir"
                readonly property bool isCurrent: !isDir && root.currentTrackId.length > 0 && dirRow.modelData.id === root.currentTrackId
                width: dirList.width
                height: 60

                // Folder row: navigates on double-click, plays the folder
                // from the hover action, context menu on right-click.
                ItemDelegate {
                    id: rowFolder
                    anchors.fill: parent
                    visible: dirRow.isDir
                    hoverEnabled: true
                    padding: 0
                    highlighted: false
                    background: Rectangle {
                        radius: Theme.controlRadius
                        color: rowFolder.hovered || rowFolder.visualFocus ? Theme.rowHover : "transparent"
                    }
                    contentItem: RowLayout {
                        spacing: 12

                        Item {
                            Layout.preferredWidth: listGeometry.indexWidth
                            Layout.minimumWidth: listGeometry.indexWidth
                            Layout.maximumWidth: listGeometry.indexWidth
                            Layout.fillHeight: true
                            EchoIcon {
                                anchors.centerIn: parent
                                name: "folder-open"
                                color: Theme.accent
                                width: 20
                                height: 20
                            }
                        }
                        EchoTextTagRow {
                            Layout.fillWidth: true
                            Layout.minimumWidth: 0
                            text: dirRow.modelData.title
                            font: Theme.spacedFont(13, Theme.semiboldWeight, -0.2)
                            color: Theme.text
                            fillTextWidth: true
                        }
                        EchoIcon {
                            name: "chevron-right"
                            color: Theme.secondaryText
                            width: 14
                            height: 14
                            Layout.rightMargin: 10
                        }
                    }
                    TapHandler {
                        acceptedButtons: Qt.RightButton
                        onTapped: eventPoint => {
                            const point = rowFolder.mapToItem(null, eventPoint.position.x, eventPoint.position.y);
                            root.showFolderMenu(dirRow.modelData.path, point.x, point.y);
                        }
                    }
                    // Single click drills in, like the host's album drill-in.
                    // Double-click is not an option here: its second click
                    // lands on the new directory's rows and would drill one
                    // level too deep (or reload the same list twice).
                    onClicked: root.browseLoad(dirRow.modelData.path)
                }

                // File row mirrors SongRow's visuals without the model
                // machinery (no covers, no artist links, no album column).
                ItemDelegate {
                    id: rowFile
                    anchors.fill: parent
                    visible: !dirRow.isDir
                    hoverEnabled: true
                    padding: 0
                    readonly property bool contextTarget: root.menuSongId.length > 0 && dirRow.modelData.id === root.menuSongId
                    background: Rectangle {
                        radius: Theme.controlRadius
                        color: rowFile.contextTarget ? Theme.colors.hover : dirRow.isCurrent ? Theme.selected : rowFile.hovered || rowFile.visualFocus ? Theme.rowHover : "transparent"
                    }
                    contentItem: RowLayout {
                        spacing: 0

                        Item {
                            Layout.preferredWidth: listGeometry.indexWidth
                            Layout.minimumWidth: listGeometry.indexWidth
                            Layout.maximumWidth: listGeometry.indexWidth
                            Layout.fillHeight: true
                            Text {
                                anchors.centerIn: parent
                                text: dirRow.index + 1
                                textFormat: Text.PlainText
                                color: Theme.secondaryText
                                font: Theme.font(12, Theme.regularWeight)
                                visible: !rowFile.hovered && !rowFile.visualFocus && !dirRow.isCurrent
                            }
                            EchoPlaybackButton {
                                anchors.centerIn: parent
                                width: 30
                                height: 30
                                padding: 8
                                playing: dirRow.isCurrent && root.plugin.player.playing
                                loading: dirRow.isCurrent && root.plugin.player.loading
                                foreground: dirRow.isCurrent || hovered ? Theme.accentText : Theme.iconMain
                                visible: rowFile.hovered || rowFile.visualFocus || dirRow.isCurrent
                                enabled: !loading
                                onClicked: {
                                    if (dirRow.isCurrent) {
                                        root.plugin.player.toggle();
                                        return;
                                    }
                                    root.playPaths([dirRow.modelData.path]);
                                }
                            }
                        }
                        RowLayout {
                            Layout.fillWidth: true
                            Layout.minimumWidth: 0
                            spacing: 12

                            EchoCover {
                                Layout.preferredWidth: 46
                                Layout.preferredHeight: 46
                                placeholderGlyph: "music"
                            }
                            ColumnLayout {
                                Layout.fillWidth: true
                                Layout.minimumWidth: 0
                                spacing: 2

                                EchoTextTagRow {
                                    Layout.fillWidth: true
                                    Layout.minimumWidth: 0
                                    text: dirRow.modelData.title
                                    font: Theme.spacedFont(13, Theme.semiboldWeight, -0.2)
                                    color: dirRow.isCurrent ? Theme.accentText : Theme.text
                                    spacing: 6
                                    Loader {
                                        active: dirRow.modelData.quality === "flac"
                                        visible: active
                                        sourceComponent: EchoTag {
                                            text: "无损"
                                            tone: EchoTag.Custom
                                            customTone: "#06B6D4"
                                        }
                                    }
                                }
                                EchoTextTagRow {
                                    Layout.fillWidth: true
                                    Layout.minimumWidth: 0
                                    visible: (dirRow.modelData.artistText || "").length > 0
                                    text: dirRow.modelData.artistText
                                    font: Theme.font(12, Theme.mediumWeight)
                                    color: dirRow.isCurrent ? Theme.accentText : Theme.secondaryText
                                }
                            }
                        }
                        Label {
                            visible: dirRow.modelData.size > 0
                            text: root.formatBytes(dirRow.modelData.size)
                            font: Theme.font(12, Theme.regularWeight)
                            color: Theme.secondaryText
                            Layout.rightMargin: 12
                        }
                    }
                    TapHandler {
                        acceptedButtons: Qt.RightButton
                        onTapped: eventPoint => {
                            const point = rowFile.mapToItem(null, eventPoint.position.x, eventPoint.position.y);
                            root.showSongMenu(dirRow.modelData.id || "", dirRow.modelData.path, point.x, point.y);
                        }
                    }
                    onDoubleClicked: if (!(dirRow.isCurrent && root.plugin.player.loading))
                        root.playPaths([dirRow.modelData.path])
                }
            }
            footer: Item {
                id: dirFooter
                readonly property bool empty: root.viewTab === 1 && !root.browse.loading && root.displayDirRows.length === 0
                width: dirList.width
                visible: dirFooter.empty
                height: 156
                ColumnLayout {
                    anchors.centerIn: parent
                    spacing: 8

                    EchoIcon {
                        Layout.alignment: Qt.AlignHCenter
                        Layout.preferredWidth: 34
                        Layout.preferredHeight: 34
                        name: root.browse.error.length > 0 ? "alert-circle" : "folder-open"
                        color: Theme.iconSecondary
                    }
                    Label {
                        Layout.alignment: Qt.AlignHCenter
                        text: root.browse.error.length > 0 ? root.browse.error : "此目录没有音频文件或子目录"
                        font: Theme.font(12, Theme.regularWeight)
                        color: Theme.secondaryText
                    }
                }
            }
        }

        // Initial-load skeleton, mirroring the shared catalog loading view;
        // the directory browse shows it while its PROPFIND is in flight.
        ListView {
            id: skeletonList
            x: root.contentInset
            width: Math.max(0, parent.width - root.contentInset * 2)
            height: parent.height
            visible: (root.viewTab === 0 && root.pageLoading && root.pageRows.length === 0) || (root.viewTab === 1 && root.browse.loading)
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
                showAlbum: true
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
                typeLabel: "WEBDAV"
                // Always-visible intro plus the shared metadata count row,
                // matching the local library header composition.
                subtitle: "浏览并播放 WebDAV 网盘中的音乐。"
                secondaryDetailsComponent: Component {
                    Flow {
                        objectName: "webdavLibraryMetadata"
                        spacing: 12

                        EchoButtonContent {
                            objectName: "webdavLibrarySongCount"
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
                            model: [root.currentLibrary && root.currentLibrary.name ? `${root.currentLibrary.name}` : "", root.viewTab === 1 ? `${root.displayDirRows.length} 项` : ""].filter(value => value.length > 0)
                            delegate: EchoTextTagRow {
                                required property string modelData
                                objectName: "webdavLibraryMetadataField"
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
                playable: root.viewTab === 0 ? root.flatReady && root.songTotal > 0 : root.dirHasFiles
                showBatchAction: false
                resourceActive: root.pageActive
                loading: root.scanRunning && !root.flatReady
                coverComponent: Component {
                    EchoCover {
                        objectName: "webdavLibraryCover"
                        source: root.headerCoverUrl
                        resourceActive: root.pageActive
                        cornerRadius: Theme.mediaRadius / detailHeader.coverScale
                        placeholderGlyph: "cloud"
                        placeholderGlyphSize: 32
                    }
                }
                // Only supply the slot while drilled in: the host loader stays
                // visible whenever a component is set, so a hidden button would
                // still reserve its width as blank space before the actions.
                leadingActions: root.viewTab === 1 && root.browse.path.length > 0 && root.browse.path !== (root.browse.root || "/") ? backActions : null
                Component {
                    id: backActions

                    EchoSoftButton {
                        text: "返回"
                        glyph: "arrow-left"
                        onClicked: root.browseLoad(root.parentDir(root.browse.path))
                    }
                }
                additionalActions: Component {
                    RowLayout {
                        spacing: 8

                        EchoSoftButton {
                            text: root.scanRunning ? "停止扫描" : "扫描"
                            glyph: root.scanRunning ? "square" : "refresh-source"
                            onClicked: root.scanRunning ? root.abortScan() : root.startScan()
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
                            glyph: root.scanRunning ? "square" : "refresh-source"
                            tooltipText: root.scanRunning ? "停止扫描" : "重新扫描"
                            onClicked: root.scanRunning ? root.abortScan() : root.startScan()
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
            // offsets.
            EchoDivider {
                objectName: "webdavToolbarDivider"
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
                    objectName: "webdavToolbarRow"
                    Layout.fillWidth: true
                    Layout.preferredHeight: 56
                    Layout.leftMargin: root.contentInset
                    Layout.rightMargin: root.contentInset
                    spacing: 8

                    EchoDetailTabs {
                        labels: ["歌曲", "目录"]
                        counts: [root.songTotal, ""]
                        currentIndex: root.viewTab
                        onPicked: index => {
                            root.viewTab = index;
                            root.resetView();
                        }
                    }
                    Item {
                        Layout.fillWidth: true
                    }
                    EchoSelect {
                        Layout.preferredWidth: 180
                        visible: root.libraries.length > 1
                        placeholder: "选择 WebDAV 库"
                        options: {
                            const rows = root.asArray(root.libraries);
                            const items = [];
                            for (let i = 0; i < rows.length; i++)
                                items.push({
                                    value: rows[i].id,
                                    label: rows[i].name || rows[i].serverUrl || rows[i].id
                                });
                            return items;
                        }
                        value: root.activeLibraryId
                        onValueEdited: function (nextValue) {
                            // Switching libraries rebuilds both views; the
                            // explicit reload keeps the change one-shot (no
                            // change-signal handler that would also fire
                            // during refreshSettings itself).
                            root.activeLibraryId = typeof nextValue === "string" ? nextValue : "";
                            root.currentLibrary = root.libraryById(root.activeLibraryId);
                            root.reloadCurrent();
                        }
                    }
                    EchoTextField {
                        Layout.preferredWidth: 160
                        Layout.minimumWidth: 80
                        placeholderText: root.viewTab === 1 ? "搜索目录..." : "搜索歌曲..."
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
                            // A pending debounce would fire right after and
                            // only waste an epoch-discarded fetch.
                            searchDebounce.stop();
                            root.resetView();
                        }
                    }
                    SongLocateButton {
                        visible: root.viewTab === 0
                        onClicked: root.locateCurrent()
                    }
                }
                SongListHeader {
                    visible: root.viewTab === 0
                    Layout.fillWidth: true
                    Layout.leftMargin: root.contentInset
                    Layout.rightMargin: root.contentInset
                    Layout.preferredHeight: root.viewTab === 0 ? 44 : 0
                    geometry: listGeometry
                    sortField: root.sortField
                    sortDirection: root.sortDirection
                    onSortPicked: field => root.changeSort(field)
                }
                // Breadcrumb row for the 目录 tab, occupying the same slot
                // as the sort header in the 歌曲 tab.
                RowLayout {
                    id: crumbRow
                    visible: root.viewTab === 1
                    Layout.fillWidth: true
                    Layout.leftMargin: root.contentInset
                    Layout.rightMargin: root.contentInset
                    Layout.preferredHeight: root.viewTab === 1 ? 44 : 0
                    spacing: 4

                    EchoIconButton {
                        glyph: "arrow-left"
                        tooltipText: "上一级"
                        enabled: root.browse.path && root.currentLibrary && root.browse.path !== (root.browse.root || "/")
                        onClicked: root.browseLoad(root.parentDir(root.browse.path))
                    }
                    Repeater {
                        model: root.pathSegments

                        delegate: RowLayout {
                            id: crumbSegment
                            required property int index
                            required property string modelData
                            spacing: 4

                            EchoIcon {
                                name: "chevron-right"
                                color: Theme.secondaryText
                                Layout.preferredWidth: 14
                                Layout.preferredHeight: 14
                                visible: crumbSegment.index > 0
                            }
                            EchoActionButton {
                                id: crumbButton
                                hoverEnabled: true
                                flat: true
                                padding: 4
                                font: Theme.font(12, crumbSegment.index === root.pathSegments.length - 1 ? Theme.mediumWeight : Theme.regularWeight)
                                contentItem: EchoTextTagRow {
                                    text: crumbSegment.modelData
                                    font: crumbButton.font
                                    color: crumbSegment.index === root.pathSegments.length - 1 ? Theme.text : Theme.secondaryText
                                }
                                background: Rectangle {
                                    color: crumbButton.hovered || crumbButton.visualFocus ? Theme.rowHover : "transparent"
                                    radius: Theme.controlRadius
                                }
                                onClicked: root.browseLoad(root.crumbPath(crumbSegment.index))
                            }
                        }
                    }
                    Item {
                        Layout.fillWidth: true
                    }
                }
            }
        }
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

    // The menus live at page scope so scene coordinates from the row
    // delegates map cleanly onto them.
    EchoMenu {
        id: songMenu

        property string songId: ""
        property string songPath: ""
        property int rowIndex: 0

        EchoMenuEntry {
            visible: root.viewTab === 0
            text: "立即播放"
            onTriggered: root.playAt(songMenu.rowIndex)
        }
        EchoMenuEntry {
            visible: root.viewTab === 1
            text: "立即播放"
            onTriggered: root.playPaths([songMenu.songPath])
        }
        EchoMenuEntry {
            text: "下一首播放"
            onTriggered: root.queueRow(songMenu.songPath, "next")
        }
        EchoMenuEntry {
            text: "添加到队列"
            onTriggered: root.queueRow(songMenu.songPath, "append")
        }
        onClosed: root.menuSongId = ""
    }

    EchoMenu {
        id: folderMenu

        property string folderPath: ""

        EchoMenuEntry {
            text: "播放此文件夹"
            onTriggered: root.playFolder(folderMenu.folderPath)
        }
        EchoMenuEntry {
            text: "下一首播放（文件夹）"
            onTriggered: root.queueFolder(folderMenu.folderPath, "next")
        }
        EchoMenuEntry {
            text: "添加到队列（文件夹）"
            onTriggered: root.queueFolder(folderMenu.folderPath, "append")
        }
    }

    Timer {
        id: searchDebounce
        interval: 300
        onTriggered: root.resetView()
    }

    // The right-click context-target row fill reads this from the delegates.
    property string menuSongId: ""
}

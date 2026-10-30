pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Effects
import QtQuick.Layouts
import EchoMusic.Controls
import EchoMusic.Theme
import EchoMusic.PluginSdk

// Apple Music 风格完整播放页皮肤。
// 左栏：封面、歌曲信息、进度与播放控制；右栏：宿主原生逐字歌词。
Item {
    id: root

    required property EchoPluginContext plugin
    required property EchoPluginViewContext page
    required property AppearanceConfiguration configuration

    readonly property var player: page.player
    readonly property bool motion: Theme.store.motionEnabled
    readonly property string coverUrl: player.coverUrl.toString()
    readonly property bool wide: width > 800
    // PlaybackService::PlayMode：ListLoop=0、SingleLoop=1、Shuffle=2、Sequential=3
    readonly property int playMode: player.snapshot.playMode
    readonly property bool cloudSource: player.snapshot.sourceKind === "cloud"
    readonly property string quality: player.snapshot.effectiveQuality || player.snapshot.quality

    // 与宿主 PlaybackService::qualities 徽标一致；宿主未向插件公开可切换列表，
    // 因此徽标只做展示，不提供切换入口
    readonly property var qualityTags: ({
            "standard": "SD",
            "higher": "HQ",
            "flac": "SQ",
            "hi_res": "HR",
            "viper_tape": "VPT",
            "viper_clear": "VPC",
            "viper_atmos": "VPA"
        })
    readonly property string qualityTag: root.cloudSource ? "CLD" : (root.qualityTags[root.quality] ?? "")

    function num(value: var, fallback: real, min: real, max: real): real {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
    }
    function formatTime(ms: real): string {
        const total = Math.max(0, Math.floor(ms / 1000));
        const minutes = Math.floor(total / 60);
        const seconds = total % 60;
        return minutes + ":" + (seconds < 10 ? "0" : "") + seconds;
    }
    function openDetail(name: string, resourceId: string): void {
        if (!name || !resourceId)
            return;
        root.plugin.executeCommand("open-detail", {
            "name": name,
            "resourceId": resourceId
        });
    }

    // 皮肤设置与换肤抽屉的设置组件共享同一 configuration 句柄
    readonly property var s: ({
            "enhanceContrast": root.configuration.values.enhanceContrast === true,
            "fontScale": root.num(root.configuration.values.fontScale, 100, 50, 200),
            "fontWeight": root.num(root.configuration.values.fontWeight, 850, 300, 900),
            "alignPosition": root.num(root.configuration.values.alignPosition, 48, 0, 100)
        })

    // Apple Music 观感固定为深色封面背景上的白色文字，不随主题翻转
    readonly property ThemeColors am: ThemeColors {
        text: "#ffffff"
        tone: "#ffffff"
        secondaryText: "#ccffffff"
        elevated: "#26ffffff"
        card: "#1fffffff"
        border: "#33ffffff"
        accent: root.plugin.accent
        accentText: "#ffffff"
    }

    readonly property font lyricFont: {
        const base = Theme.store.lyricBaseFont;
        base.pixelSize = Math.max(12, Math.round(base.pixelSize * root.s.fontScale / 100));
        base.weight = Math.round(root.s.fontWeight);
        return base;
    }

    implicitWidth: 960
    implicitHeight: 640

    // 无封面时的基础底色，与宿主封面占位观感一致
    Rectangle {
        anchors.fill: parent
        gradient: Gradient {
            GradientStop {
                position: 0
                color: "#20242c"
            }
            GradientStop {
                position: 1
                color: "#12151b"
            }
        }
    }

    // 封面模糊背景：GPU 模糊一次成型，封面变化才重新采样
    Image {
        id: backdrop
        anchors.fill: parent
        anchors.margins: -60
        source: root.coverUrl
        fillMode: Image.PreserveAspectCrop
        cache: false
        asynchronous: true
        visible: false
    }
    MultiEffect {
        anchors.fill: backdrop
        source: backdrop
        blurEnabled: true
        blurMax: 64
        blur: 1
        saturation: 0.2
        brightness: -0.35
        autoPaddingEnabled: false
        visible: backdrop.status === Image.Ready
    }
    Rectangle {
        anchors.fill: parent
        color: "#40000000"
        visible: backdrop.status === Image.Ready
    }

    // ===== 左栏 =====
    Item {
        id: leftPanel
        anchors.left: parent.left
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        width: root.wide ? Math.max(320, parent.width * 0.42) : parent.width

        Item {
            id: leftContent
            anchors.fill: parent
            anchors.leftMargin: root.wide ? 96 : 24
            anchors.rightMargin: root.wide ? 96 : 24
            anchors.topMargin: 24
            anchors.bottomMargin: 28

            // 旧版 CSS 为封面 100% 宽 + 96px 下边距；在矮窗口下按剩余高度收缩
            readonly property real coverSize: root.wide ? Math.min(width, Math.max(160, height * 0.46)) : Math.min(260, width * 0.7)
            readonly property real coverGap: root.wide ? Math.min(96, Math.max(16, height * 0.1)) : 16

            ColumnLayout {
                anchors.verticalCenter: parent.verticalCenter
                width: parent.width
                spacing: 0

                Item {
                    id: coverWrap
                    Layout.alignment: Qt.AlignHCenter
                    Layout.preferredWidth: leftContent.coverSize
                    Layout.preferredHeight: leftContent.coverSize
                    Layout.bottomMargin: leftContent.coverGap

                    Rectangle {
                        id: shadowSource
                        anchors.fill: parent
                        radius: 14
                        color: "#000000"
                        visible: false
                    }
                    MultiEffect {
                        anchors.fill: parent
                        anchors.margins: -26
                        source: shadowSource
                        shadowEnabled: true
                        shadowBlur: 0.6
                        shadowColor: "#73000000"
                        shadowVerticalOffset: 12
                        autoPaddingEnabled: false
                        visible: root.coverUrl !== ""
                    }
                    EchoCover {
                        anchors.fill: parent
                        source: root.player.coverUrl
                        cornerRadius: 14
                        colors: root.am
                        // 播放时放大、暂停时缩小的呼吸感（旧版 0.75 ↔ 1 的关键帧动画）
                        scale: !root.motion || root.player.playing ? 1 : 0.75
                        Behavior on scale {
                            enabled: root.motion
                            NumberAnimation {
                                duration: 480
                                easing.type: Easing.OutBack
                                easing.overshoot: 1.1
                            }
                        }
                    }
                }

                // 歌曲信息 + 操作按钮
                Item {
                    Layout.fillWidth: true
                    Layout.preferredHeight: 66
                    Layout.bottomMargin: 16

                    ColumnLayout {
                        id: infoText
                        anchors.left: parent.left
                        anchors.right: actions.left
                        anchors.rightMargin: 8
                        anchors.verticalCenter: parent.verticalCenter
                        spacing: 2

                        Label {
                            id: titleLabel
                            Layout.fillWidth: true
                            text: root.player.title.length > 0 ? root.player.title : qsTr("未知歌曲")
                            font: Theme.font(22, 700)
                            color: root.am.text
                            elide: Text.ElideRight
                            opacity: albumArea.enabled && albumArea.containsMouse ? 0.85 : 1
                            Behavior on opacity {
                                enabled: root.motion
                                NumberAnimation {
                                    duration: 150
                                }
                            }
                            // 专辑可跳转详情时整行可点
                            MouseArea {
                                id: albumArea
                                anchors.fill: parent
                                hoverEnabled: true
                                enabled: root.player.snapshot.track.albumId.length > 0
                                cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                                onClicked: root.openDetail("album-detail", root.player.snapshot.track.albumId)
                            }
                        }
                        EchoArtistLinks {
                            id: artistLinks
                            Layout.fillWidth: true
                            visible: root.player.snapshot.track.artistLinks.length > 0
                            artists: root.player.snapshot.track.artistLinks
                            font: Theme.font(22, 700)
                            color: "#ccffffff"
                            hoverColor: root.am.text
                            onArtistRequested: id => root.openDetail("artist-detail", id)
                        }
                        Label {
                            Layout.fillWidth: true
                            visible: !artistLinks.visible
                            text: root.player.artist.length > 0 ? root.player.artist : qsTr("未知歌手")
                            font: Theme.font(22, 700)
                            color: "#ccffffff"
                            elide: Text.ElideRight
                        }
                    }
                    Row {
                        id: actions
                        anchors.right: parent.right
                        anchors.verticalCenter: parent.verticalCenter
                        spacing: 8

                        AmActionButton {
                            glyph: root.player.snapshot.favorite ? "heart-filled" : "heart"
                            label: qsTr("收藏")
                            active: root.player.snapshot.favorite
                            enabled: root.page.active && root.player.hasTrack
                            onClicked: root.page.command("favorite", {
                                "revision": root.player.revision
                            })
                        }
                        AmActionButton {
                            glyph: "message-circle"
                            label: qsTr("查看评论")
                            enabled: root.page.active
                            onClicked: root.page.command("comments", {
                                "revision": root.player.revision
                            })
                        }
                        AmActionButton {
                            glyph: "share"
                            label: qsTr("分享")
                            enabled: root.page.active
                            onClicked: root.page.command("share", {
                                "revision": root.player.revision
                            })
                        }
                        AmActionButton {
                            glyph: "list"
                            label: qsTr("更多外观")
                            onClicked: root.plugin.ui.lyricsPage.openSkins()
                        }
                    }
                }

                // 进度条 + 时间 + 音质徽标
                Item {
                    id: progressSection
                    Layout.fillWidth: true
                    Layout.preferredHeight: 46
                    Layout.bottomMargin: 6

                    readonly property real durationMs: root.player.durationMs
                    readonly property real fraction: durationMs > 0 ? Math.min(1, Math.max(0, root.player.positionMs / durationMs)) : 0
                    property real dragFraction: 0
                    property bool dragging: false
                    readonly property real shownFraction: dragging ? dragFraction : fraction
                    property string dragRevision: ""

                    Rectangle {
                        id: track
                        anchors.left: parent.left
                        anchors.right: parent.right
                        anchors.verticalCenter: parent.verticalCenter
                        height: progressArea.containsMouse || progressSection.dragging ? 18 : 12
                        radius: height / 2
                        color: "#33ffffff"

                        Behavior on height {
                            enabled: root.motion
                            NumberAnimation {
                                duration: 220
                                easing.type: Easing.OutCubic
                            }
                        }
                        Rectangle {
                            id: fill
                            anchors.left: parent.left
                            anchors.verticalCenter: parent.verticalCenter
                            width: Math.max(height, track.width * progressSection.shownFraction)
                            height: parent.height
                            radius: height / 2
                            color: "#ffffff"
                        }
                    }
                    MouseArea {
                        id: progressArea
                        anchors.fill: track
                        anchors.margins: -8
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        enabled: root.page.active && root.player.hasTrack && progressSection.durationMs > 0

                        function fractionAt(x: real): real {
                            // MouseArea 上下左右各扩 8px 命中区，换算回轨道坐标
                            return Math.min(1, Math.max(0, (x - anchors.margins) / track.width));
                        }
                        onPressed: mouse => {
                            progressSection.dragging = true;
                            progressSection.dragRevision = root.player.revision;
                            progressSection.dragFraction = fractionAt(mouse.x);
                        }
                        onPositionChanged: mouse => {
                            if (progressSection.dragging)
                                progressSection.dragFraction = fractionAt(mouse.x);
                        }
                        onReleased: mouse => {
                            const fraction = fractionAt(mouse.x);
                            progressSection.dragging = false;
                            root.page.command("seek", {
                                "value": Math.round(fraction * progressSection.durationMs),
                                "revision": progressSection.dragRevision
                            });
                        }
                        onCanceled: progressSection.dragging = false
                    }
                    RowLayout {
                        anchors.left: parent.left
                        anchors.right: parent.right
                        anchors.top: track.bottom
                        anchors.topMargin: 8
                        spacing: 8

                        Label {
                            text: root.formatTime(progressSection.dragging ? progressSection.shownFraction * progressSection.durationMs : root.player.positionMs)
                            font: Theme.font(12, Theme.mediumWeight)
                            color: "#80ffffff"
                        }
                        Item {
                            Layout.fillWidth: true
                            Layout.alignment: Qt.AlignHCenter
                            implicitHeight: qualityBadge.height
                            Rectangle {
                                id: qualityBadge
                                anchors.centerIn: parent
                                visible: root.qualityTag.length > 0
                                radius: 4
                                color: "#26ffffff"
                                width: qualityText.implicitWidth + 16
                                height: 20
                                Label {
                                    id: qualityText
                                    anchors.centerIn: parent
                                    text: root.qualityTag
                                    font: Theme.font(11, 600)
                                    color: "#ccffffff"
                                }
                            }
                        }
                        Label {
                            text: "-" + root.formatTime(Math.max(0, progressSection.durationMs - root.player.positionMs))
                            font: Theme.font(12, Theme.mediumWeight)
                            color: "#80ffffff"
                        }
                    }
                }

                // 播放控制：随机 | 上一首/播放/下一首 | 列表循环
                Item {
                    Layout.fillWidth: true
                    Layout.preferredHeight: 72

                    EchoIconButton {
                        anchors.left: parent.left
                        anchors.verticalCenter: parent.verticalCenter
                        glyph: "arrows-shuffle"
                        text: qsTr("随机播放")
                        colors: root.am
                        foreground: root.playMode === 2 ? "#ffffff" : "#80ffffff"
                        enabled: root.page.active && root.player.hasTrack
                        implicitWidth: 48
                        implicitHeight: 48
                        onClicked: root.page.command("mode", {
                            "value": 2
                        })
                    }
                    EchoIconButton {
                        anchors.right: parent.right
                        anchors.verticalCenter: parent.verticalCenter
                        glyph: "repeat"
                        text: qsTr("列表循环")
                        colors: root.am
                        foreground: root.playMode === 0 ? "#ffffff" : "#80ffffff"
                        enabled: root.page.active && root.player.hasTrack
                        implicitWidth: 48
                        implicitHeight: 48
                        onClicked: root.page.command("mode", {
                            "value": 0
                        })
                    }
                    Row {
                        anchors.centerIn: parent
                        spacing: 16

                        AmTransportButton {
                            glyph: "player-skip-back"
                            label: qsTr("上一首")
                            iconSize: 34
                            enabled: root.page.active && root.player.hasTrack
                            onClicked: root.page.command("previous")
                        }
                        AmTransportButton {
                            glyph: root.player.playing ? "pause" : "play"
                            label: root.player.playing ? qsTr("暂停") : qsTr("播放")
                            iconSize: 36
                            foreground: "#ffffff"
                            enabled: root.page.active && root.player.hasTrack
                            onClicked: root.page.command("toggle")
                        }
                        AmTransportButton {
                            glyph: "player-skip-forward"
                            label: qsTr("下一首")
                            iconSize: 34
                            enabled: root.page.active && root.player.hasTrack
                            onClicked: root.page.command("next")
                        }
                    }
                }
            }
        }
    }

    // ===== 右栏歌词 =====
    Item {
        id: rightPanel
        anchors.left: leftPanel.right
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        anchors.rightMargin: 40
        anchors.topMargin: 24
        anchors.bottomMargin: 24
        visible: root.wide

        // 对齐位置：把歌词视图中心从 50% 移到设置值；收缩限制在 35% 内保证可用
        readonly property real alignOffset: height * (2 * root.s.alignPosition / 100 - 1)
        readonly property real topInset: alignOffset > 0 ? Math.min(alignOffset, height * 0.35) : 0
        readonly property real bottomInset: alignOffset < 0 ? Math.min(-alignOffset, height * 0.35) : 0

        EchoPluginLyricsView {
            page: root.page
            anchors.fill: parent
            anchors.topMargin: rightPanel.topInset
            anchors.bottomMargin: rightPanel.bottomInset
            baseFont: root.lyricFont
            playedColor: "#ffffff"
            unplayedColor: root.s.enhanceContrast ? "#ffffffff" : "#ebffffff"
        }

        // 上下渐隐，对应旧版 mask-image 12%/88% 边缘遮罩
        layer.enabled: true
        layer.effect: MultiEffect {
            maskEnabled: true
            maskSource: ShaderEffectSource {
                sourceItem: Rectangle {
                    width: Math.max(1, rightPanel.width)
                    height: Math.max(1, rightPanel.height)
                    gradient: Gradient {
                        orientation: Gradient.Vertical
                        GradientStop {
                            position: 0
                            color: "#00ffffff"
                        }
                        GradientStop {
                            position: 0.12
                            color: "#ffffffff"
                        }
                        GradientStop {
                            position: 0.88
                            color: "#ffffffff"
                        }
                        GradientStop {
                            position: 1
                            color: "#00ffffff"
                        }
                    }
                }
            }
        }
    }

    // 圆形操作按钮（收藏/评论/分享/更多），对应旧版 38px 圆形按钮
    component AmActionButton: AbstractButton {
        id: actionButton
        property string glyph
        property string label
        property bool active: false

        implicitWidth: 38
        implicitHeight: 38
        hoverEnabled: true
        Accessible.name: label
        background: Rectangle {
            radius: width / 2
            color: actionButton.enabled && (actionButton.hovered || actionButton.active) ? "#40ffffff" : "#26ffffff"
            Behavior on color {
                enabled: root.motion
                ColorAnimation {
                    duration: 150
                }
            }
        }
        contentItem: Item {
            EchoIcon {
                anchors.centerIn: parent
                width: 18
                height: 18
                name: actionButton.glyph
                color: actionButton.active ? "#ffffff" : "#ccffffff"
            }
        }
    }

    // 播放控制圆钮，对应旧版 72px 大按钮的按压缩放
    component AmTransportButton: AbstractButton {
        id: transportButton
        property string glyph
        property string label
        property real iconSize: 34
        property color foreground: "#c0ffffff"

        implicitWidth: 72
        implicitHeight: 72
        hoverEnabled: true
        Accessible.name: label
        scale: pressed ? 0.86 : 1
        Behavior on scale {
            enabled: root.motion
            NumberAnimation {
                duration: 140
                easing.type: Easing.OutCubic
            }
        }
        background: Rectangle {
            radius: width / 2
            color: transportButton.enabled && transportButton.hovered ? "#26ffffff" : "transparent"
            Behavior on color {
                enabled: root.motion
                ColorAnimation {
                    duration: 150
                }
            }
        }
        contentItem: Item {
            EchoIcon {
                anchors.centerIn: parent
                width: transportButton.iconSize
                height: transportButton.iconSize
                name: transportButton.glyph
                color: transportButton.foreground
            }
        }
    }
}

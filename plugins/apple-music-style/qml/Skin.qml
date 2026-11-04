pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Effects
import QtQuick.Layouts
import EchoMusic.Controls
import EchoMusic.Playback
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
            "enableBlur": root.configuration.values.enableBlur !== false,
            "enableScale": root.configuration.values.enableScale !== false,
            "enableSpring": root.configuration.values.enableSpring !== false,
            "fadeWidth": root.num(root.configuration.values.fadeWidth, 50, 0, 100),
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

    // 旧版 AMLL 字号：clamp(24px, 4.2vh × 缩放, 52px)，vh 取整个页面高度
    readonly property real lyricFontSize: Math.min(52, Math.max(24, root.height * 0.042 * root.s.fontScale / 100))
    // 旧版 AMLL 字号：clamp(24px, 4.2vh × 缩放, 52px)，vh 取整个页面高度。
    // 字体必须经宿主 styledFont 构建：宿主引擎里对 QFont 属性读取的副本
    // 直接赋 pixelSize/weight 不生效，会静默回落到 13px/400 的宿主默认字号
    readonly property font lyricFont: Theme.store.styledFont(Theme.store.lyricBaseFont, Math.round(root.lyricFontSize), Math.round(root.s.fontWeight), 0, false, false)
    // 副歌词字号为最大(10, 字号×0.5)，粗细上限 650，与旧版一致
    readonly property font secondaryLyricFont: Theme.store.styledFont(Theme.store.lyricBaseFont, Math.max(10, root.lyricFontSize * 0.5), Math.min(650, Math.round(root.s.fontWeight)), 0, false, false)

    implicitWidth: 960
    implicitHeight: 640

    // ===== 背景：直接复用宿主"封面歌词"模式的模糊封面背景 =====
    // 渲染器即宿主 EchoMusic.Playback 的 PlaybackBlurredBackground（与内建
    // 封面歌词页同一 fluid 着色器、同一封面交叉淡化管线）；包裹逻辑对照
    // 宿主 PlaybackBackground：底色 lyricBackground(封面主色) 500ms 渐变、
    // 磨砂/透明度材质、模糊未就绪或无封面时只显示底色四边形。
    readonly property bool hostFrosted: Theme.store.windowFrosted
    readonly property real hostMaterialOpacity: 1 - Theme.store.transparency / 100
    readonly property color hostCoverColor: root.player.snapshot.coverColor ?? "#20242c"
    readonly property color hostBaseColor: Theme.store.lyricBackground(root.hostCoverColor)
    property color hostDisplayedBaseColor: root.hostBaseColor
    Behavior on hostDisplayedBaseColor {
        ColorAnimation {
            duration: Theme.store.motionEnabled ? 500 : 0
        }
    }
    readonly property bool hostBlurActive: root.visible && root.coverUrl.toString().length > 0 && !root.hostFrosted && root.hostMaterialOpacity > 0
    // 背景律动取宿主歌词设置 backgroundRhythm（settings.host 授权后经 read/observe 同步）
    property bool hostRhythm: false
    readonly property bool hostRhythmActive: root.hostBlurActive && root.hostRhythm && root.motion
    property real hostPhase: 0
    Component.onCompleted: {
        const read = root.plugin.settings.read('lyrics');
        const applyRead = () => {
            if (read.state === 2)
                root.hostRhythm = read.result.backgroundRhythm === true;
        };
        read.completed.connect(applyRead);
        applyRead();
        root.plugin.settings.observe('apple-music-style-background-rhythm', 'lyrics', values => {
            root.hostRhythm = values.backgroundRhythm === true;
        });
    }

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
    // 与宿主一致：只显示一个最终背景四边形，避免叠加 alpha 累积
    Rectangle {
        anchors.fill: parent
        visible: !(bgLoader.item && bgLoader.item.ready)
        color: root.hostFrosted ? Qt.rgba(0, 0, 0, 0.55) : Theme.withAlpha(root.hostDisplayedBaseColor, root.hostMaterialOpacity)
    }
    Loader {
        id: bgLoader
        anchors.fill: parent
        active: root.hostBlurActive
        sourceComponent: PlaybackBlurredBackground {
            anchors.fill: parent
            coverSource: root.player.coverUrl
            rhythm: root.hostRhythmActive
            phase: root.hostPhase
            baseColor: root.hostDisplayedBaseColor
            backgroundOpacity: root.hostMaterialOpacity
        }
    }
    // 与宿主 PlaybackBackground 一致：律动相位按 30fps 上限推进
    FrameAnimation {
        running: root.hostRhythmActive && bgLoader.item && bgLoader.item.ready && root.player.playing && Theme.store.motionEnabled
        property real accumulated: 0
        onRunningChanged: accumulated = 0
        onTriggered: {
            accumulated += Math.min(frameTime, 0.1);
            if (accumulated >= 1 / 30) {
                const remainder = accumulated % (1 / 30);
                root.hostPhase += accumulated - remainder;
                accumulated = remainder;
            }
        }
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

                    // 封面直接叠在封面模糊背景上：MultiEffect 阴影会把纯黑
                    // 源矩形一并画出，暂停缩小时露出一圈黑底，故不使用阴影
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

                // 进度条 + 时间 + 音质徽标：布局对照旧插件——轨道盒固定 12px（--bar-h），
                // 可见条在盒的竖直中线上放大（悬停/拖动 1.5 倍 = 18px），不推动下方时间行；
                // 高度过渡 0.5s ease；停留 ≥100ms 后离开播放 0.5s 弹簧回落
                // （旧 amms-progress-spring：18 → 6 → 12），悬停重新进入则冻结当前高度过渡放大
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
                    property real hoverStart: 0
                    // 可见条高度：悬停/拖动 18px，静息 12px；轨道盒高度不变
                    property real barHeight: progressArea.containsMouse || progressSection.dragging ? 18 : 12
                    Behavior on barHeight {
                        enabled: root.motion && !springSeq.running
                        NumberAnimation {
                            duration: 500
                            easing.type: Easing.BezierSpline
                            easing.bezierCurve: [0.25, 0.1, 0.25, 1, 1, 1]
                        }
                    }
                    function springSettle(): void {
                        // 旧 handleProgressMouseLeave：停留 ≥100ms 后离开才播放弹簧
                        if (!progressArea.containsMouse && !progressSection.dragging && Date.now() - hoverStart >= 100)
                            springSeq.restart();
                    }
                    SequentialAnimation {
                        id: springSeq
                        // 关键帧对照旧版：0% 18px → 60% 6px → 100% 12px（0.5s ease）
                        NumberAnimation {
                            target: progressSection
                            property: "barHeight"
                            from: 18
                            to: 6
                            duration: 300
                            easing.type: Easing.BezierSpline
                            easing.bezierCurve: [0.25, 0.1, 0.25, 1, 1, 1]
                        }
                        NumberAnimation {
                            target: progressSection
                            property: "barHeight"
                            to: 12
                            duration: 200
                            easing.type: Easing.BezierSpline
                            easing.bezierCurve: [0.25, 0.1, 0.25, 1, 1, 1]
                        }
                    }

                    Item {
                        id: track
                        // 轨道盒顶对齐（旧版流式布局：信息块 16px 间距后紧跟轨道），
                        // 12 + 14 + 时间行恰好占满 46px 段高，时间行不再侵入按钮悬停区
                        anchors.top: parent.top
                        anchors.left: parent.left
                        anchors.right: parent.right
                        height: 12

                        Rectangle {
                            id: bar
                            anchors.left: parent.left
                            anchors.right: parent.right
                            anchors.verticalCenter: parent.verticalCenter
                            height: progressSection.barHeight
                            radius: height / 2
                            color: "#33ffffff"
                        }
                        Rectangle {
                            id: fill
                            anchors.left: parent.left
                            anchors.verticalCenter: parent.verticalCenter
                            width: Math.max(progressSection.barHeight, track.width * progressSection.shownFraction)
                            height: progressSection.barHeight
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
                        onContainsMouseChanged: {
                            // 重新进入时打断弹簧：Behavior 从当前高度过渡到悬停态（旧版冻结 --fill-h）
                            if (containsMouse)
                                progressSection.hoverStart = Date.now();
                            else
                                progressSection.springSettle();
                        }

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
                            progressSection.springSettle();
                        }
                        onCanceled: {
                            progressSection.dragging = false;
                            progressSection.springSettle();
                        }
                    }
                    RowLayout {
                        anchors.left: parent.left
                        anchors.right: parent.right
                        anchors.top: track.bottom
                        anchors.topMargin: 14
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
                // 布局与尺寸逐项对照旧插件（.amms-playback-controls）：两侧 48px 模式钮
                // 外扩 13px（margin 0 -13px），中央 72px 钮组间距 16px
                Item {
                    Layout.fillWidth: true
                    Layout.preferredHeight: 72

                    AmCtrlButton {
                        anchors.left: parent.left
                        anchors.leftMargin: -13
                        anchors.verticalCenter: parent.verticalCenter
                        box: 48
                        glyphSize: 22
                        alpha: root.playMode === 2 ? 1 : 0.5
                        asset: "icons/shuffle.svg"
                        label: qsTr("随机播放")
                        enabled: root.page.active && root.player.hasTrack
                        onClicked: root.page.command("mode", {
                            "value": 2
                        })
                    }
                    AmCtrlButton {
                        anchors.right: parent.right
                        anchors.rightMargin: -13
                        anchors.verticalCenter: parent.verticalCenter
                        box: 48
                        glyphSize: 22
                        alpha: root.playMode === 0 ? 1 : 0.5
                        asset: "icons/loop.svg"
                        label: qsTr("列表循环")
                        enabled: root.page.active && root.player.hasTrack
                        onClicked: root.page.command("mode", {
                            "value": 0
                        })
                    }
                    Row {
                        anchors.centerIn: parent
                        spacing: 16

                        AmCtrlButton {
                            box: 72
                            glyphSize: 42
                            alpha: 0.75
                            asset: "icons/skip.svg"
                            label: qsTr("上一首")
                            enabled: root.page.active && root.player.hasTrack
                            onClicked: root.page.command("previous")
                        }
                        AmCtrlButton {
                            box: 72
                            glyphSize: 36
                            alpha: 1
                            asset: root.player.playing ? "icons/pause.svg" : "icons/play.svg"
                            label: root.player.playing ? qsTr("暂停") : qsTr("播放")
                            enabled: root.page.active && root.player.hasTrack
                            onClicked: root.page.command("toggle")
                        }
                        AmCtrlButton {
                            box: 72
                            glyphSize: 42
                            alpha: 0.75
                            asset: "icons/skip.svg"
                            mirror: true
                            label: qsTr("下一首")
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

        // AMLL 风格歌词流：时间轴/弹簧滚动/逐词扫掠与间奏点在插件侧实现
        LyricFlow {
            id: lyrics
            page: root.page
            anchors.fill: parent
            fontSize: root.lyricFontSize
            baseFont: root.lyricFont
            secondaryFont: root.secondaryLyricFont
            // 演唱行 #fff，未唱行 rgba(255,255,255,0.92)，与旧版一致
            // 演唱行 #fff；未唱部分对照宿主 LyricColors 默认 20% 白（AMLL 明暗比），
            // 扫掠前沿才有可感知的明暗对比
            textColor: "#ffffff"
            unplayedColor: Qt.rgba(1, 1, 1, 0.2)
            focusPosition: root.s.alignPosition / 100
            wordFade: root.s.fadeWidth / 100
            blurEnabled: root.s.enableBlur
            scaleEnabled: root.s.enableScale
            springEnabled: root.s.enableSpring
            // 副歌词透明度：普通 0.56，增强对比度 0.72
            sublineOpacity: root.s.enhanceContrast ? 0.72 : 0.56
            lineWidthAspect: 0.86
            pageHeight: root.height
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

    // 播放控制圆钮，样式逐项对照旧插件 .amms-ctrl-btn（style.css）：
    // 48/72px 圆钮；悬停 15% 白圆底（background 0.18s 过渡）；图标为旧版内联 SVG
    // 打包资产（白色，透明度着色：常态 0.75、随机/循环 0.5、激活与播放钮全白）；
    // 按压时序 = 旧版 pressing/holding/releasing 关键帧——压下 0.2s 缩至 0.8，
    // 长按 0.3s 回弹 0.9，释放 0.3s 弹至 1.1 再回 1（释放期间忽略新按压）。
    component AmCtrlButton: AbstractButton {
        id: ctrl
        property string label
        property string asset
        property real box: 72
        property real glyphSize: 36
        property real alpha: 0.75
        property bool mirror: false

        implicitWidth: box
        implicitHeight: box
        hoverEnabled: true
        Accessible.name: label
        transformOrigin: Item.Center
        function endPress(): void {
            holdTimer.stop();
            if (!pressAnim.running && scale > 0.999)
                return;
            pressAnim.stop();
            releaseStep1.from = scale;
            releaseSeq.start();
        }
        onPressed: {
            // 释放弹回期间忽略新按压（旧版 btnReleasing 守卫）
            if (releaseSeq.running)
                return;
            releaseSeq.stop();
            pressAnim.from = scale;
            pressAnim.to = 0.8;
            pressAnim.restart();
            holdTimer.restart();
        }
        onReleased: endPress()
        onCanceled: endPress()

        Timer {
            id: holdTimer
            interval: 200
            onTriggered: {
                pressAnim.stop();
                holdAnim.from = ctrl.scale;
                holdAnim.to = 0.9;
                holdAnim.restart();
            }
        }
        NumberAnimation {
            id: pressAnim
            target: ctrl
            property: "scale"
            duration: 200
            easing.type: Easing.BezierSpline
            easing.bezierCurve: [0.25, 0.1, 0.25, 1, 1, 1]
        }
        NumberAnimation {
            id: holdAnim
            target: ctrl
            property: "scale"
            duration: 300
            easing.type: Easing.BezierSpline
            easing.bezierCurve: [0.25, 0.1, 0.25, 1, 1, 1]
        }
        SequentialAnimation {
            id: releaseSeq
            NumberAnimation {
                id: releaseStep1
                target: ctrl
                property: "scale"
                to: 1.1
                duration: 200
                easing.type: Easing.BezierSpline
                easing.bezierCurve: [0.25, 0.1, 0.25, 1, 1, 1]
            }
            NumberAnimation {
                target: ctrl
                property: "scale"
                to: 1
                duration: 100
                easing.type: Easing.BezierSpline
                easing.bezierCurve: [0.25, 0.1, 0.25, 1, 1, 1]
            }
        }
        background: Rectangle {
            radius: width / 2
            color: ctrl.enabled && ctrl.hovered ? "#26ffffff" : "transparent"
            Behavior on color {
                ColorAnimation {
                    duration: 180
                }
            }
        }
        contentItem: Item {
            Image {
                anchors.centerIn: parent
                width: ctrl.glyphSize
                height: ctrl.glyphSize
                source: ctrl.asset
                sourceSize: Qt.size(ctrl.glyphSize, ctrl.glyphSize)
                fillMode: Image.PreserveAspectFit
                mirror: ctrl.mirror
                opacity: ctrl.enabled ? ctrl.alpha : ctrl.alpha * 0.6
                smooth: true
            }
        }
    }
}

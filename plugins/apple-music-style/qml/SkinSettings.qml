pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import EchoMusic.Controls
import EchoMusic.Theme
import EchoMusic.PluginSdk

// 换肤抽屉中的皮肤设置；与皮肤页面共享同一 AppearanceConfiguration 句柄。
ColumnLayout {
    id: settingsRoot

    required property EchoPluginContext plugin
    required property EchoPluginViewContext page
    required property AppearanceConfiguration configuration

    function num(value: var, fallback: real, min: real, max: real): real {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
    }
    function patch(key: string, value: var): void {
        const next = {};
        next[key] = value;
        settingsRoot.configuration.patch(next);
    }

    // 与官方频谱设置一致：拖动中只更新本地值，松手/键盘提交一次
    component SettingSlider: RowLayout {
        id: sliderRow

        property string title
        property string hint
        property string suffix: ""
        property real current: 0
        property real from: 0
        property real to: 100
        signal committed(real nextValue)

        Layout.fillWidth: true
        spacing: 4

        ColumnLayout {
            Layout.fillWidth: true
            spacing: 4

            RowLayout {
                Layout.fillWidth: true

                Label {
                    text: sliderRow.title
                    font: Theme.font(13, 700)
                    color: Theme.floating.text
                }
                Item {
                    Layout.fillWidth: true
                }
                Label {
                    text: Math.round(slider.value) + sliderRow.suffix
                    font: Theme.font(12, Theme.regularWeight)
                    color: Theme.floating.secondaryText
                }
            }
            EchoSlider {
                id: slider
                Layout.fillWidth: true
                from: sliderRow.from
                to: sliderRow.to
                stepSize: 1
                value: sliderRow.current
                colors: Theme.floating
                Accessible.name: sliderRow.title
                onPressedChanged: if (!pressed)
                    sliderRow.committed(value)
                Keys.onReleased: event => {
                    sliderRow.committed(value);
                    event.accepted = true;
                }
            }
            Label {
                Layout.fillWidth: true
                text: sliderRow.hint
                font: Theme.font(12, Theme.regularWeight)
                color: Theme.floating.secondaryText
                wrapMode: Text.Wrap
            }
        }
    }

    spacing: 14

    // 增强对比度设置已移除（2026-11-15）：多种实现方案均无法达到预期观感，
    // AMLL 基线的明暗比本身已足够
    RowLayout {
        Layout.fillWidth: true
        spacing: 14

        ColumnLayout {
            Layout.fillWidth: true
            spacing: 4

            Label {
                text: qsTr("非活动行模糊")
                font: Theme.font(13, 700)
                color: Theme.floating.text
            }
            Label {
                Layout.fillWidth: true
                text: qsTr("未播放的歌词行随距离增加模糊，聚焦当前行。")
                font: Theme.font(12, Theme.regularWeight)
                color: Theme.floating.secondaryText
                wrapMode: Text.Wrap
            }
        }
        EchoSwitch {
            checked: settingsRoot.configuration.values.enableBlur !== false
            Accessible.name: qsTr("非活动行模糊")
            onToggled: settingsRoot.patch("enableBlur", checked)
        }
    }

    RowLayout {
        Layout.fillWidth: true
        spacing: 14

        ColumnLayout {
            Layout.fillWidth: true
            spacing: 4

            Label {
                text: qsTr("非活动行缩小")
                font: Theme.font(13, 700)
                color: Theme.floating.text
            }
            Label {
                Layout.fillWidth: true
                text: qsTr("未播放的歌词行略微缩小，逐词上浮动效随之启停。")
                font: Theme.font(12, Theme.regularWeight)
                color: Theme.floating.secondaryText
                wrapMode: Text.Wrap
            }
        }
        EchoSwitch {
            checked: settingsRoot.configuration.values.enableScale !== false
            Accessible.name: qsTr("非活动行缩小")
            onToggled: settingsRoot.patch("enableScale", checked)
        }
    }

    RowLayout {
        Layout.fillWidth: true
        spacing: 14

        ColumnLayout {
            Layout.fillWidth: true
            spacing: 4

            Label {
                text: qsTr("弹簧滚动")
                font: Theme.font(13, 700)
                color: Theme.floating.text
            }
            Label {
                Layout.fillWidth: true
                text: qsTr("歌词行按行间时间差以弹簧动效依次滚动到位。")
                font: Theme.font(12, Theme.regularWeight)
                color: Theme.floating.secondaryText
                wrapMode: Text.Wrap
            }
        }
        EchoSwitch {
            checked: settingsRoot.configuration.values.enableSpring !== false
            Accessible.name: qsTr("弹簧滚动")
            onToggled: settingsRoot.patch("enableSpring", checked)
        }
    }

    SettingSlider {
        Layout.fillWidth: true
        title: qsTr("字体缩放")
        hint: qsTr("调整歌词字体大小。")
        suffix: "%"
        from: 50
        to: 200
        current: settingsRoot.num(settingsRoot.configuration.values.fontScale, 100, 50, 200)
        onCommitted: nextValue => settingsRoot.patch("fontScale", nextValue)
    }

    SettingSlider {
        Layout.fillWidth: true
        title: qsTr("字体粗细")
        hint: qsTr("数值越高，歌词笔画越粗。")
        from: 300
        to: 900
        current: settingsRoot.num(settingsRoot.configuration.values.fontWeight, 850, 300, 900)
        onCommitted: nextValue => settingsRoot.patch("fontWeight", nextValue)
    }

    SettingSlider {
        Layout.fillWidth: true
        title: qsTr("逐词渐变宽度")
        hint: qsTr("逐词亮起边缘的柔化宽度，0 为硬边。")
        suffix: "%"
        from: 0
        to: 100
        current: settingsRoot.num(settingsRoot.configuration.values.fadeWidth, 50, 0, 100)
        onCommitted: nextValue => settingsRoot.patch("fadeWidth", nextValue)
    }

    SettingSlider {
        Layout.fillWidth: true
        title: qsTr("对齐位置")
        hint: qsTr("当前歌词行在页面高度中的位置。")
        suffix: "%"
        from: 0
        to: 100
        current: settingsRoot.num(settingsRoot.configuration.values.alignPosition, 35, 0, 100)
        onCommitted: nextValue => settingsRoot.patch("alignPosition", nextValue)
    }

    // 重置入口与错误提示由宿主皮肤抽屉统一渲染（LyricSkinDrawer 底部
    // EchoSoftButton「恢复默认」/ errorMessage Label，调用同一 configuration
    // 句柄），此处不再重复提供——否则抽屉里会出现两个重置按钮（2026-11-15 实测）。
}

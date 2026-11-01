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

    Label {
        Layout.fillWidth: true
        text: qsTr("调整歌词外观。设置保存在当前皮肤配置中。")
        font: Theme.font(12, Theme.regularWeight)
        color: Theme.floating.secondaryText
        wrapMode: Text.Wrap
    }

    // 增强对比度
    RowLayout {
        Layout.fillWidth: true
        spacing: 14

        ColumnLayout {
            Layout.fillWidth: true
            spacing: 4

            Label {
                text: qsTr("增强对比度")
                font: Theme.font(13, 700)
                color: Theme.floating.text
            }
            Label {
                Layout.fillWidth: true
                text: qsTr("保留层次感，同时提高封面背景上的文字可读性。")
                font: Theme.font(12, Theme.regularWeight)
                color: Theme.floating.secondaryText
                wrapMode: Text.Wrap
            }
        }
        EchoSwitch {
            checked: settingsRoot.configuration.values.enhanceContrast === true
            Accessible.name: qsTr("增强对比度")
            onToggled: settingsRoot.patch("enhanceContrast", checked)
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
        title: qsTr("对齐位置")
        hint: qsTr("当前歌词行在页面高度中的位置。")
        suffix: "%"
        from: 0
        to: 100
        current: settingsRoot.num(settingsRoot.configuration.values.alignPosition, 48, 0, 100)
        onCommitted: nextValue => settingsRoot.patch("alignPosition", nextValue)
    }

    RowLayout {
        Layout.fillWidth: true
        spacing: 16

        Label {
            Layout.fillWidth: true
            text: settingsRoot.configuration.busy ? qsTr("正在保存设置…") : qsTr("恢复歌词外观的初始设置。")
            font: Theme.font(12, Theme.regularWeight)
            color: Theme.floating.secondaryText
            wrapMode: Text.Wrap
        }
        EchoButton {
            text: qsTr("恢复默认")
            colors: Theme.floating
            onClicked: settingsRoot.configuration.reset()
        }
    }

    Label {
        Layout.fillWidth: true
        visible: settingsRoot.configuration.errorMessage.length > 0
        text: settingsRoot.configuration.errorMessage
        wrapMode: Text.Wrap
        color: Theme.colors.danger
        font: Theme.font(12, Theme.regularWeight)
    }
}

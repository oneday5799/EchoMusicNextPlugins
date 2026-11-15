var __defProp = Object.defineProperty;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __propIsEnum = Object.prototype.propertyIsEnumerable;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __spreadValues = (a, b) => {
  for (var prop in b || (b = {}))
    if (__hasOwnProp.call(b, prop))
      __defNormalProp(a, prop, b[prop]);
  if (__getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(b)) {
      if (__propIsEnum.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    }
  return a;
};

// plugins/apple-music-style/src/entry.ts
import { awaitOperation } from "echo:plugin-sdk";

// plugins/apple-music-style/src/config.ts
var SKIN_ID = "apple-music";
var DEFAULT_SETTINGS = {
  fontScale: 100,
  fontWeight: 850,
  enableBlur: true,
  enableScale: true,
  enableSpring: true,
  // AMLL wordFadeWidth 默认 0.5；本皮肤默认 0.3：0.6 字宽的线性软边在慢音节
  // 尾字上让整个字 60% 处于渐变中间态（拖长音时驻留十几秒），读作一条宽灰带
  // （2026-11-16 实机逐点测量确认渲染=设计=AMLL，属形态调校；用户确认收窄）。
  // 设置面板可调回 0..100 全域
  fadeWidth: 30,
  alignPosition: 35
};
var NUMBER_SETTINGS = {
  fontScale: [50, 200],
  fontWeight: [300, 900],
  fadeWidth: [0, 100],
  alignPosition: [0, 100]
};
var BOOLEAN_SETTINGS = ["enableBlur", "enableScale", "enableSpring"];
function validateSettings(values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    return { errors: ["皮肤设置必须是 JSON 对象"] };
  }
  const errors = [];
  for (const key of BOOLEAN_SETTINGS) {
    if (values[key] !== void 0 && typeof values[key] !== "boolean") {
      errors.push(`${key} 必须是布尔值`);
    }
  }
  for (const key of Object.keys(NUMBER_SETTINGS)) {
    const [min, max] = NUMBER_SETTINGS[key];
    const value = values[key];
    if (value === void 0) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      errors.push(`${key} 必须是 ${min}..${max} 之间的数值`);
    }
  }
  return errors.length === 0 ? true : { errors };
}

// plugins/apple-music-style/src/entry.ts
function activate(ctx) {
  const skin = ctx.ui.lyricsPage.registerSkin({
    id: SKIN_ID,
    title: "Apple Music Style",
    description: "双栏布局：左侧封面与播放控制，右侧插件自绘的 AMLL 风格逐字歌词。",
    component: "qml/Skin.qml",
    titlebar: "host",
    tools: "host",
    preview: "preview.jpg",
    settingsComponent: "qml/SkinSettings.qml",
    defaults: __spreadValues({}, DEFAULT_SETTINGS),
    validate: validateSettings
  });
  if (!skin) throw new Error(ctx.ui.lyricsPage.errorMessage);
  const sideActions = ctx.ui.parts.contribute(
    "side-actions",
    { key: "lyricOffsetAction-0", surface: "playback" },
    {
      operation: "insert",
      position: "after",
      component: "qml/SideActions.qml",
      layout: { preferredWidth: 36, preferredHeight: 80 }
    }
  );
  if (!sideActions) throw new Error(ctx.ui.parts.errorMessage);
  const detailRoutes = ["album-detail", "artist-detail"];
  ctx.registerCommand("open-detail", (args) => {
    var _a, _b;
    const route = String((_a = args == null ? void 0 : args.name) != null ? _a : "");
    const resourceId = String((_b = args == null ? void 0 : args.resourceId) != null ? _b : "");
    if (!detailRoutes.includes(route) || !resourceId) return null;
    return awaitOperation(ctx.ui.navigation.navigate({ name: route, resourceId })).then(() => true);
  });
}
function deactivate() {
}
export {
  DEFAULT_SETTINGS,
  SKIN_ID,
  activate,
  deactivate,
  validateSettings
};

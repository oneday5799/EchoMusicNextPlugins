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
  enhanceContrast: false,
  fontScale: 100,
  fontWeight: 850,
  alignPosition: 48
};
var NUMBER_SETTINGS = {
  fontScale: [50, 200],
  fontWeight: [300, 900],
  alignPosition: [0, 100]
};
function validateSettings(values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    return { errors: ["皮肤设置必须是 JSON 对象"] };
  }
  const errors = [];
  if (values.enhanceContrast !== void 0 && typeof values.enhanceContrast !== "boolean") {
    errors.push("增强对比度必须是布尔值");
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
    title: "Apple Music 风格",
    description: "双栏布局：左侧封面与播放控制，右侧宿主原生逐字歌词。",
    component: "qml/Skin.qml",
    titlebar: "host",
    tools: "host",
    preview: "preview.jpg",
    settingsComponent: "qml/SkinSettings.qml",
    defaults: __spreadValues({}, DEFAULT_SETTINGS),
    validate: validateSettings
  });
  if (!skin) throw new Error(ctx.ui.lyricsPage.errorMessage);
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

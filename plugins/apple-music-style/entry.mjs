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
  enableBlur: true,
  enableScale: true,
  enableSpring: true,
  fadeWidth: 50,
  alignPosition: 48
};
var NUMBER_SETTINGS = {
  fontScale: [50, 200],
  fontWeight: [300, 900],
  fadeWidth: [0, 100],
  alignPosition: [0, 100]
};
var BOOLEAN_SETTINGS = ["enhanceContrast", "enableBlur", "enableScale", "enableSpring"];
function validateSettings(values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    return { errors: ["\u76AE\u80A4\u8BBE\u7F6E\u5FC5\u987B\u662F JSON \u5BF9\u8C61"] };
  }
  const errors = [];
  for (const key of BOOLEAN_SETTINGS) {
    if (values[key] !== void 0 && typeof values[key] !== "boolean") {
      errors.push(`${key} \u5FC5\u987B\u662F\u5E03\u5C14\u503C`);
    }
  }
  for (const key of Object.keys(NUMBER_SETTINGS)) {
    const [min, max] = NUMBER_SETTINGS[key];
    const value = values[key];
    if (value === void 0) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      errors.push(`${key} \u5FC5\u987B\u662F ${min}..${max} \u4E4B\u95F4\u7684\u6570\u503C`);
    }
  }
  return errors.length === 0 ? true : { errors };
}

// plugins/apple-music-style/src/entry.ts
function activate(ctx) {
  const skin = ctx.ui.lyricsPage.registerSkin({
    id: SKIN_ID,
    title: "Apple Music \u98CE\u683C",
    description: "\u53CC\u680F\u5E03\u5C40\uFF1A\u5DE6\u4FA7\u5C01\u9762\u4E0E\u64AD\u653E\u63A7\u5236\uFF0C\u53F3\u4FA7\u5BBF\u4E3B\u539F\u751F\u9010\u5B57\u6B4C\u8BCD\u3002",
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

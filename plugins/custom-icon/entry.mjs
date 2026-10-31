var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

// plugins/custom-icon/src/entry.ts
import {
  awaitOperation
} from "echo:plugin-sdk";

// plugins/custom-icon/src/config.ts
var ICON_TARGETS = ["window", "tray", "desktop", "taskbar"];
var TARGET_LABELS = {
  window: "窗口图标",
  tray: "托盘图标",
  desktop: "桌面快捷方式图标",
  taskbar: "固定任务栏图标"
};
var DEFAULT_SETTINGS = { icons: {} };
var MAX_ICON_BYTES = 4 * 1024 * 1024;
var MAX_ICON_EDGE = 2048;
var IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "ico", "webp", "bmp", "gif"];
function isIconTarget(value) {
  return typeof value === "string" && ICON_TARGETS.includes(value);
}
function iconExtension(name) {
  const fileName = String(name || "").split(/[\\/]/).pop() || "";
  const dot = fileName.lastIndexOf(".");
  if (dot < 0 || dot === fileName.length - 1) return "png";
  const ext = fileName.slice(dot + 1).toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext) ? ext : "png";
}
function normalizeEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value;
  const path = typeof record.path === "string" ? record.path : "";
  if (!path || path.includes("..") || path.startsWith("/")) return null;
  return { path, name: typeof record.name === "string" ? record.name : path };
}
function normalizeIconSettings(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const icons = {};
  const rawIcons = source.icons;
  if (rawIcons && typeof rawIcons === "object" && !Array.isArray(rawIcons)) {
    const records = rawIcons;
    for (const target of ICON_TARGETS) {
      const entry = normalizeEntry(records[target]);
      if (entry) icons[target] = entry;
    }
  }
  return { icons };
}
function applicableTargets(settings, platform) {
  return ICON_TARGETS.filter((target) => {
    if (!settings.icons[target]) return false;
    if (target === "desktop") return platform.desktop;
    if (target === "taskbar") return platform.taskbar;
    return true;
  });
}

// plugins/custom-icon/src/entry.ts
var STORAGE_KEY = "settings";
var ICON_PRIORITY = 20;
var PRIVATE_DIR = "icons";
function stateView(ctx, settings, mediaLeases, applyError) {
  var _a, _b;
  const targets = {};
  for (const target of ICON_TARGETS) {
    const entry = settings.icons[target];
    if (!entry) continue;
    targets[target] = {
      name: entry.name,
      preview: (_b = (_a = mediaLeases.get(target)) == null ? void 0 : _a.url.toString()) != null ? _b : ""
    };
  }
  const pendingAuthorization = !ctx.permissions.granted("appIcons") && Object.keys(settings.icons).length > 0;
  return { targets, error: applyError, pendingAuthorization };
}
function activate(ctx) {
  let disposed = false;
  let settings = normalizeIconSettings(DEFAULT_SETTINGS);
  let dataRef = null;
  const iconLeases = /* @__PURE__ */ new Map();
  let applyError = "";
  const mediaLeases = /* @__PURE__ */ new Map();
  let writes = Promise.resolve();
  let applying = Promise.resolve();
  const privateRef = (path) => {
    if (!dataRef) throw new Error("私有目录未就绪");
    return { grantId: dataRef.grantId, revision: dataRef.revision, path };
  };
  const save = () => {
    const snapshot = settings;
    const next = writes.then(() => awaitOperation(ctx.io.writeValue(STORAGE_KEY, snapshot))).then(() => void 0);
    writes = next.catch(() => void 0);
    return next;
  };
  const closeMediaLeases = (target) => {
    var _a;
    const keys = target ? [target] : [...mediaLeases.keys()];
    for (const key of keys) {
      (_a = mediaLeases.get(key)) == null ? void 0 : _a.dispose();
      mediaLeases.delete(key);
    }
  };
  const refreshMediaLease = (target) => __async(null, null, function* () {
    var _a;
    closeMediaLeases(target);
    const entry = settings.icons[target];
    if (!entry || !dataRef || !ctx.active || disposed) return;
    const lease = yield awaitOperation(
      ctx.files.openMedia(privateRef(entry.path), { lifetime: "scope" })
    );
    if (disposed || ((_a = settings.icons[target]) == null ? void 0 : _a.path) !== entry.path) {
      lease.dispose();
      return;
    }
    const previous = mediaLeases.get(target);
    if (previous) previous.dispose();
    mediaLeases.set(target, lease);
  });
  const publish = () => {
    if (!ctx.active || disposed) return;
    ctx.ui.setState(
      stateView(ctx, settings, mediaLeases, applyError)
    );
  };
  const withdrawIcons = () => {
    for (const lease of iconLeases.values()) lease.dispose();
    iconLeases.clear();
  };
  const readTargetBytes = (target) => __async(null, null, function* () {
    const entry = settings.icons[target];
    if (!entry) throw new Error(`${TARGET_LABELS[target]}未选择图片`);
    const data = yield awaitOperation(
      ctx.files.readBytes(privateRef(entry.path), { maxBytes: MAX_ICON_BYTES })
    );
    if (data.truncated) throw new Error(`${TARGET_LABELS[target]}超过 4 MiB，无法应用`);
    return data.bytes;
  });
  const submitTarget = (target) => __async(null, null, function* () {
    var _a;
    const platform = {
      desktop: ctx.appIcons.snapshot.desktop,
      taskbar: ctx.appIcons.snapshot.taskbar
    };
    if (!applicableTargets(settings, platform).includes(target)) {
      (_a = iconLeases.get(target)) == null ? void 0 : _a.dispose();
      iconLeases.delete(target);
      return;
    }
    const definition = {};
    definition[target] = yield readTargetBytes(target);
    iconLeases.set(
      target,
      yield awaitOperation(ctx.appIcons.set(target, definition, ICON_PRIORITY))
    );
  });
  const applyTarget = (target) => {
    const run = applying.then(() => submitTarget(target));
    applying = run.then(
      () => {
        applyError = "";
      },
      (error) => {
        applyError = error instanceof Error ? error.message : String(error);
      }
    );
    return run;
  };
  const applyIcons = () => {
    const run = applying.then(() => __async(null, null, function* () {
      applyError = "";
      const platform = {
        desktop: ctx.appIcons.snapshot.desktop,
        taskbar: ctx.appIcons.snapshot.taskbar
      };
      const targets = applicableTargets(settings, platform);
      for (const target of targets) {
        yield submitTarget(target);
      }
      ctx.setTimer("apply-diagnostic", 1200, false, () => {
        var _a, _b;
        const snapshot = ctx.appIcons.snapshot;
        void ctx.io.writeValue(
          "lastApply",
          JSON.parse(
            JSON.stringify({
              at: (/* @__PURE__ */ new Date()).toISOString(),
              targets,
              snapshotError: (_a = snapshot.error) != null ? _a : "",
              contributions: (_b = snapshot.contributions) != null ? _b : []
            })
          )
        );
      });
    }));
    applying = run.then(
      () => void 0,
      (error) => {
        applyError = error instanceof Error ? error.message : String(error);
      }
    );
    return run;
  };
  let retriesLeft = 0;
  const retryTick = () => {
    if (disposed || !ctx.active || retriesLeft-- <= 0) return;
    if (!applyError && !ctx.appIcons.snapshot.error) {
      publish();
      return;
    }
    void applyIcons().then(
      () => {
        publish();
        ctx.setTimer("apply-retry", 800, false, retryTick);
      },
      () => {
        publish();
        ctx.setTimer("apply-retry", 800, false, retryTick);
      }
    );
  };
  const startApplyRetries = () => {
    retriesLeft = 3;
    ctx.setTimer("apply-retry", 800, false, retryTick);
  };
  const restoreShortcutDefaults = () => __async(null, null, function* () {
    try {
      if (ctx.appIcons.snapshot.desktop)
        yield awaitOperation(ctx.appIcons.restoreDefaultDesktopIcon());
    } catch (e) {
    }
    try {
      if (ctx.appIcons.snapshot.taskbar)
        yield awaitOperation(ctx.appIcons.restoreDefaultTaskbarIcon());
    } catch (e) {
    }
  });
  const deleteStored = (target) => __async(null, null, function* () {
    const entry = settings.icons[target];
    if (!entry || !dataRef) return;
    try {
      yield awaitOperation(ctx.files.deleteFile(privateRef(entry.path)));
    } catch (e) {
    }
  });
  ctx.registerCommand(
    "icons.state",
    () => stateView(ctx, settings, mediaLeases, applyError)
  );
  ctx.registerCommand("icons.apply", () => {
    return (() => __async(null, null, function* () {
      if (Object.keys(settings.icons).length === 0) return { ok: false, error: "尚未选择任何图标" };
      yield applyIcons();
      publish();
      startApplyRetries();
      if (applyError) return { ok: false, error: applyError };
      return { ok: true };
    }))();
  });
  ctx.registerCommand("icons.pick", (args) => {
    const target = args == null ? void 0 : args.target;
    if (!isIconTarget(target)) return Promise.resolve({ ok: false, error: "未知图标目标" });
    return (() => __async(null, null, function* () {
      var _a, _b, _c, _d, _e;
      if (!dataRef) return { ok: false, error: "私有目录未就绪" };
      const selection = yield awaitOperation(
        ctx.files.requestFiles({
          purpose: `选择${TARGET_LABELS[target]}`,
          access: "read",
          multiple: false,
          filters: [{ name: "图片", extensions: [...IMAGE_EXTENSIONS] }]
        })
      );
      const grant = (_a = selection.files) == null ? void 0 : _a[0];
      if (selection.canceled || !grant) return { ok: false, canceled: true };
      const data = yield awaitOperation(
        ctx.files.readBytes(grant.file, { maxBytes: MAX_ICON_BYTES })
      );
      if (data.truncated)
        return {
          ok: false,
          error: `图片超过 ${Math.floor(MAX_ICON_BYTES / 1024 / 1024)} MiB 限制`
        };
      const metadata = yield awaitOperation(ctx.files.metadata(grant.file));
      const width = (_b = metadata.width) != null ? _b : 0;
      const height = (_c = metadata.height) != null ? _c : 0;
      if (width > MAX_ICON_EDGE || height > MAX_ICON_EDGE)
        return {
          ok: false,
          error: `图片尺寸 ${width}×${height} 超过 ${MAX_ICON_EDGE}×${MAX_ICON_EDGE} 限制`
        };
      const path = `${PRIVATE_DIR}/${target}.${iconExtension(grant.name || grant.displayPath)}`;
      yield deleteStored(target);
      yield awaitOperation(
        ctx.files.writeBytes(privateRef(path), data.bytes, { conflict: "replace" })
      );
      settings.icons[target] = { path, name: grant.name || path };
      yield save();
      yield applyTarget(target);
      yield refreshMediaLease(target);
      publish();
      startApplyRetries();
      return { ok: true, target, name: (_e = (_d = settings.icons[target]) == null ? void 0 : _d.name) != null ? _e : "" };
    }))();
  });
  ctx.registerCommand("icons.clear", (args) => {
    const target = args == null ? void 0 : args.target;
    if (!isIconTarget(target)) return Promise.resolve({ ok: false, error: "未知图标目标" });
    return (() => __async(null, null, function* () {
      if (!settings.icons[target]) return { ok: false, error: "该目标未设置图标" };
      yield deleteStored(target);
      delete settings.icons[target];
      yield save();
      yield applyTarget(target);
      closeMediaLeases(target);
      publish();
      startApplyRetries();
      return { ok: true, target };
    }))();
  });
  ctx.registerCommand(
    "icons.reset",
    () => (() => __async(null, null, function* () {
      for (const target of ICON_TARGETS) yield deleteStored(target);
      settings = normalizeIconSettings(DEFAULT_SETTINGS);
      yield save();
      withdrawIcons();
      yield restoreShortcutDefaults();
      closeMediaLeases();
      publish();
      return { ok: true };
    }))()
  );
  const onSessionInvalidated = () => {
    if (disposed) return;
    void applying.then(() => __async(null, null, function* () {
      for (const target of [...mediaLeases.keys()]) yield refreshMediaLease(target);
      yield applyIcons();
      publish();
    })).catch(() => void 0);
  };
  ctx.sessionInvalidated.connect(onSessionInvalidated);
  ctx.onDispose(() => {
    disposed = true;
    ctx.sessionInvalidated.disconnect(onSessionInvalidated);
    closeMediaLeases();
    withdrawIcons();
    dataRef = null;
  });
  ctx.ui.registerSettings("qml/Settings.qml");
  return (() => __async(null, null, function* () {
    const stored = yield awaitOperation(ctx.io.readValue(STORAGE_KEY));
    settings = normalizeIconSettings(stored);
    const grant = yield awaitOperation(ctx.files.privateDirectory("data"));
    dataRef = grant.file;
    try {
      yield awaitOperation(ctx.files.mkdir(privateRef(PRIVATE_DIR), { recursive: true }));
    } catch (e) {
    }
    for (const target of ICON_TARGETS) {
      try {
        yield refreshMediaLease(target);
      } catch (e) {
      }
    }
    if (ctx.permissions.granted("appIcons")) {
      yield applyIcons().catch(() => void 0);
      publish();
      startApplyRetries();
    }
    publish();
  }))();
}
function deactivate() {
}
export {
  activate,
  deactivate
};

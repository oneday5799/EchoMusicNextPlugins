import {
  awaitOperation,
  type AppIconDefinition,
  type EchoPluginContext,
  type EchoPluginMediaLease,
  type EchoPluginRegistration,
  type FileReference,
  type JsonValue,
} from 'echo:plugin-sdk';
import {
  applicableTargets,
  DEFAULT_SETTINGS,
  ICON_TARGETS,
  IMAGE_EXTENSIONS,
  iconExtension,
  isIconTarget,
  MAX_ICON_BYTES,
  MAX_ICON_EDGE,
  normalizeIconSettings,
  TARGET_LABELS,
  type IconSettings,
  type IconTarget,
} from './config';

const STORAGE_KEY = 'settings';
const ICON_PRIORITY = 20;
const PRIVATE_DIR = 'icons';

type TargetView = { name: string; preview: string };
type PublishedState = {
  targets: Record<string, TargetView>;
  error: string;
  pendingAuthorization: boolean;
};

function stateView(
  ctx: EchoPluginContext,
  settings: IconSettings,
  mediaLeases: Map<IconTarget, EchoPluginMediaLease>,
  applyError: string,
): PublishedState {
  const targets: Record<string, TargetView> = {};
  for (const target of ICON_TARGETS) {
    const entry = settings.icons[target];
    if (!entry) continue;
    targets[target] = {
      name: entry.name,
      preview: mediaLeases.get(target)?.url.toString() ?? '',
    };
  }
  // 已存图标但尚未授予 appIcons 时置位：激活不等待授权（避免 5 秒超时），
  // 由设置页的「应用图标」按钮或下一次选择图片完成首次授权与应用。
  const pendingAuthorization =
    !ctx.permissions.granted('appIcons') && Object.keys(settings.icons).length > 0;
  return { targets, error: applyError, pendingAuthorization };
}

export function activate(ctx: EchoPluginContext) {
  let disposed = false;
  let settings: IconSettings = normalizeIconSettings(DEFAULT_SETTINGS);
  let dataRef: FileReference | null = null;
  const iconLeases = new Map<IconTarget, EchoPluginRegistration>();
  let applyError = '';
  const mediaLeases = new Map<IconTarget, EchoPluginMediaLease>();
  let writes: Promise<unknown> = Promise.resolve();
  let applying: Promise<void> = Promise.resolve();

  const privateRef = (path: string): FileReference => {
    if (!dataRef) throw new Error('私有目录未就绪');
    return { grantId: dataRef.grantId, revision: dataRef.revision, path };
  };

  const save = (): Promise<void> => {
    const snapshot = settings;
    const next = writes
      .then(() => awaitOperation(ctx.io.writeValue(STORAGE_KEY, snapshot as unknown as JsonValue)))
      .then(() => undefined);
    writes = next.catch(() => undefined);
    return next;
  };

  const closeMediaLeases = (target?: IconTarget): void => {
    const keys = target ? [target] : [...mediaLeases.keys()];
    for (const key of keys) {
      mediaLeases.get(key)?.dispose();
      mediaLeases.delete(key);
    }
  };

  const refreshMediaLease = async (target: IconTarget): Promise<void> => {
    closeMediaLeases(target);
    const entry = settings.icons[target];
    if (!entry || !dataRef || !ctx.active || disposed) return;
    const lease = await awaitOperation(
      ctx.files.openMedia(privateRef(entry.path), { lifetime: 'scope' }),
    );
    if (disposed || settings.icons[target]?.path !== entry.path) {
      lease.dispose();
      return;
    }
    const previous = mediaLeases.get(target);
    if (previous) previous.dispose();
    mediaLeases.set(target, lease);
  };

  const publish = (): void => {
    if (!ctx.active || disposed) return;
    ctx.ui.setState(
      stateView(ctx, settings, mediaLeases, applyError) as unknown as Record<string, JsonValue>,
    );
  };

  const withdrawIcons = (): void => {
    for (const lease of iconLeases.values()) lease.dispose();
    iconLeases.clear();
  };

  // 按目标增量应用：每个目标一条独立贡献（贡献 id 即目标名）。
  // pick/clear 只重新 set 受影响的目标——同 id 原位替换，未变化的目标
  // 不回退、不重写 .lnk、不触发全局刷新，因此不会闪烁；激活、「应用
  // 图标」与失败重试才遍历全部目标。
  const readTargetBytes = async (target: IconTarget): Promise<ArrayBuffer> => {
    const entry = settings.icons[target];
    if (!entry) throw new Error(`${TARGET_LABELS[target]}未选择图片`);
    const data = await awaitOperation(
      ctx.files.readBytes(privateRef(entry.path), { maxBytes: MAX_ICON_BYTES }),
    );
    if (data.truncated) throw new Error(`${TARGET_LABELS[target]}超过 4 MiB，无法应用`);
    return data.bytes;
  };

  const submitTarget = async (target: IconTarget): Promise<void> => {
    const platform = {
      desktop: ctx.appIcons.snapshot.desktop,
      taskbar: ctx.appIcons.snapshot.taskbar,
    };
    if (!applicableTargets(settings, platform).includes(target)) {
      iconLeases.get(target)?.dispose();
      iconLeases.delete(target);
      return;
    }
    const definition: AppIconDefinition = {};
    definition[target] = await readTargetBytes(target);
    iconLeases.set(
      target,
      await awaitOperation(ctx.appIcons.set(target, definition, ICON_PRIORITY)),
    );
  };

  const applyTarget = (target: IconTarget): Promise<void> => {
    const run = applying.then(() => submitTarget(target));
    applying = run.then(
      () => {
        applyError = '';
      },
      (error: unknown) => {
        applyError = error instanceof Error ? error.message : String(error);
      },
    );
    return run;
  };

  // 全量应用（激活、「应用图标」、失败重试）。
  const applyIcons = (): Promise<void> => {
    const run = applying.then(async () => {
      applyError = '';
      const platform = {
        desktop: ctx.appIcons.snapshot.desktop,
        taskbar: ctx.appIcons.snapshot.taskbar,
      };
      const targets = applicableTargets(settings, platform);
      for (const target of targets) {
        await submitTarget(target);
      }
      // 延后一拍记录宿主快捷方式后台事务的结果，便于诊断"应用了但不生效"。
      ctx.setTimer('apply-diagnostic', 1200, false, () => {
        const snapshot = ctx.appIcons.snapshot;
        void ctx.io.writeValue(
          'lastApply',
          JSON.parse(
            JSON.stringify({
              at: new Date().toISOString(),
              targets,
              snapshotError: snapshot.error ?? '',
              contributions: snapshot.contributions ?? [],
            }),
          ) as unknown as JsonValue,
        );
      });
    });
    applying = run.then(
      () => undefined,
      (error: unknown) => {
        applyError = error instanceof Error ? error.message : String(error);
      },
    );
    return run;
  };

  // 快捷方式枚举在桌面整理工具/同步服务的开机整理窗口内可能瞬态返回空
  // （实测 Qt 6.12 QDir 名称过滤会拿到空列表），而宿主对失败结果不重试、
  // 错误粘滞。这里在应用后做有限次自动重试，重新提交 shortcuts 贡献强制
  // 快捷方式工作器重跑。
  let retriesLeft = 0;
  const retryTick = (): void => {
    if (disposed || !ctx.active || retriesLeft-- <= 0) return;
    if (!applyError && !ctx.appIcons.snapshot.error) {
      publish();
      return;
    }
    void applyIcons().then(
      () => {
        publish();
        ctx.setTimer('apply-retry', 800, false, retryTick);
      },
      () => {
        publish();
        ctx.setTimer('apply-retry', 800, false, retryTick);
      },
    );
  };
  const startApplyRetries = (): void => {
    retriesLeft = 3;
    ctx.setTimer('apply-retry', 800, false, retryTick);
  };

  const restoreShortcutDefaults = async (): Promise<void> => {
    // 快捷方式恢复是后台事务；平台不支持或其他插件占位时返回错误，直接忽略。
    try {
      if (ctx.appIcons.snapshot.desktop)
        await awaitOperation(ctx.appIcons.restoreDefaultDesktopIcon());
    } catch {}
    try {
      if (ctx.appIcons.snapshot.taskbar)
        await awaitOperation(ctx.appIcons.restoreDefaultTaskbarIcon());
    } catch {}
  };

  const deleteStored = async (target: IconTarget): Promise<void> => {
    const entry = settings.icons[target];
    if (!entry || !dataRef) return;
    try {
      await awaitOperation(ctx.files.deleteFile(privateRef(entry.path)));
    } catch {}
  };

  ctx.registerCommand('icons.state', (): JsonValue =>
    stateView(ctx, settings, mediaLeases, applyError),
  );

  // 恢复入口：已存图标但授权未完成时由设置页触发；set() 在此发起授权确认，
  // 用户应答后同一操作继续完成解码与应用。
  ctx.registerCommand('icons.apply', (): Promise<JsonValue> => {
    return (async (): Promise<JsonValue> => {
      if (Object.keys(settings.icons).length === 0) return { ok: false, error: '尚未选择任何图标' };
      await applyIcons();
      publish();
      startApplyRetries();
      if (applyError) return { ok: false, error: applyError };
      return { ok: true };
    })();
  });

  ctx.registerCommand('icons.pick', (args): Promise<JsonValue> => {
    const target = args?.target;
    if (!isIconTarget(target)) return Promise.resolve({ ok: false, error: '未知图标目标' });
    return (async (): Promise<JsonValue> => {
      if (!dataRef) return { ok: false, error: '私有目录未就绪' };
      const selection = await awaitOperation(
        ctx.files.requestFiles({
          purpose: `选择${TARGET_LABELS[target]}`,
          access: 'read',
          multiple: false,
          filters: [{ name: '图片', extensions: [...IMAGE_EXTENSIONS] }],
        }),
      );
      const grant = selection.files?.[0];
      if (selection.canceled || !grant) return { ok: false, canceled: true };
      const data = await awaitOperation(
        ctx.files.readBytes(grant.file, { maxBytes: MAX_ICON_BYTES }),
      );
      if (data.truncated)
        return {
          ok: false,
          error: `图片超过 ${Math.floor(MAX_ICON_BYTES / 1024 / 1024)} MiB 限制`,
        };
      const metadata = await awaitOperation(ctx.files.metadata(grant.file));
      const width = metadata.width ?? 0;
      const height = metadata.height ?? 0;
      if (width > MAX_ICON_EDGE || height > MAX_ICON_EDGE)
        return {
          ok: false,
          error: `图片尺寸 ${width}×${height} 超过 ${MAX_ICON_EDGE}×${MAX_ICON_EDGE} 限制`,
        };
      const path = `${PRIVATE_DIR}/${target}.${iconExtension(grant.name || grant.displayPath)}`;
      await deleteStored(target);
      await awaitOperation(
        ctx.files.writeBytes(privateRef(path), data.bytes, { conflict: 'replace' }),
      );
      settings.icons[target] = { path, name: grant.name || path };
      await save();
      await applyTarget(target);
      await refreshMediaLease(target);
      publish();
      startApplyRetries();
      return { ok: true, target, name: settings.icons[target]?.name ?? '' };
    })();
  });

  ctx.registerCommand('icons.clear', (args): Promise<JsonValue> => {
    const target = args?.target;
    if (!isIconTarget(target)) return Promise.resolve({ ok: false, error: '未知图标目标' });
    return (async (): Promise<JsonValue> => {
      if (!settings.icons[target]) return { ok: false, error: '该目标未设置图标' };
      await deleteStored(target);
      delete settings.icons[target];
      await save();
      // 增量撤下：submitTarget 发现该目标已无配置，会 dispose 对应贡献，
      // 宿主随即恢复该快捷方式的默认图标。全量 applyIcons 不会撤下
      // 已移除目标的贡献，用它会导致清除无效。
      await applyTarget(target);
      closeMediaLeases(target);
      publish();
      startApplyRetries();
      return { ok: true, target };
    })();
  });

  ctx.registerCommand('icons.reset', (): Promise<JsonValue> =>
    (async () => {
      for (const target of ICON_TARGETS) await deleteStored(target);
      settings = normalizeIconSettings(DEFAULT_SETTINGS);
      await save();
      withdrawIcons();
      await restoreShortcutDefaults();
      closeMediaLeases();
      publish();
      return { ok: true };
    })(),
  );

  // 账号切换撤下运行时贡献；新会话重新提交并刷新媒体租约。
  const onSessionInvalidated = (): void => {
    if (disposed) return;
    void applying
      .then(async () => {
        for (const target of [...mediaLeases.keys()]) await refreshMediaLease(target);
        await applyIcons();
        publish();
      })
      .catch(() => undefined);
  };
  ctx.sessionInvalidated.connect(onSessionInvalidated);

  ctx.onDispose(() => {
    disposed = true;
    ctx.sessionInvalidated.disconnect(onSessionInvalidated);
    closeMediaLeases();
    withdrawIcons();
    dataRef = null;
  });

  ctx.ui.registerSettings('qml/Settings.qml');

  return (async () => {
    const stored = await awaitOperation(ctx.io.readValue(STORAGE_KEY));
    settings = normalizeIconSettings(stored);
    const grant = await awaitOperation(ctx.files.privateDirectory('data'));
    dataRef = grant.file;
    try {
      await awaitOperation(ctx.files.mkdir(privateRef(PRIVATE_DIR), { recursive: true }));
    } catch {}
    for (const target of ICON_TARGETS) {
      try {
        await refreshMediaLease(target);
      } catch {}
    }
    // 已授权才在激活期应用；未授权时激活立即完成，不等待授权确认
    // （授权对话框超出 5 秒生命周期会判激活失败并回收插件）。
    // 首次授权改由用户交互触发：选择图片或设置页的「应用图标」。
    if (ctx.permissions.granted('appIcons')) {
      // 单个损坏的图标文件不应让插件激活失败；错误经 applying 链记入 applyError。
      await applyIcons().catch(() => undefined);
      publish();
      startApplyRetries();
    }
    publish();
  })();
}

export function deactivate() {
  // 清理由 onDispose 注册的回调完成。
}

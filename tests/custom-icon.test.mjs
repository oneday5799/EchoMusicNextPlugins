import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applicableTargets,
  DEFAULT_SETTINGS,
  iconExtension,
  isIconTarget,
  MAX_ICON_BYTES,
  normalizeIconSettings,
} from '../plugins/custom-icon/src/config.ts';

// ---------- 设置规范化 ----------

test('normalizeIconSettings keeps defaults for missing or invalid storage', () => {
  assert.deepEqual(normalizeIconSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeIconSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeIconSettings('settings'), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeIconSettings([]), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeIconSettings({}), { icons: {} });
  assert.deepEqual(normalizeIconSettings({ enabled: false }), { icons: {} });
});

test('normalizeIconSettings keeps valid entries and rejects malformed ones', () => {
  const settings = normalizeIconSettings({
    icons: {
      tray: { path: 'icons/tray.png', name: '托盘.png' },
      window: { name: '缺少路径' },
      desktop: 'icons/desktop.png',
      taskbar: { path: '../escape.png', name: 'escape' },
      unknown: { path: 'icons/x.png', name: 'x' },
    },
  });
  assert.deepEqual(settings.icons.tray, { path: 'icons/tray.png', name: '托盘.png' });
  assert.equal(settings.icons.window, undefined);
  assert.equal(settings.icons.desktop, undefined);
  assert.equal(settings.icons.taskbar, undefined);
  assert.equal(Object.keys(settings.icons).length, 1);
});

test('normalizeIconSettings ignores non-object icon maps', () => {
  assert.deepEqual(normalizeIconSettings({ icons: 'icons' }), { icons: {} });
  assert.deepEqual(normalizeIconSettings({ icons: [] }), { icons: {} });
});

// ---------- 扩展名 ----------

test('iconExtension extracts known image extensions case-insensitively', () => {
  assert.equal(iconExtension('托盘.PNG'), 'png');
  assert.equal(iconExtension('C:\\Users\\me\\icon.Ico'), 'ico');
  assert.equal(iconExtension('cover.webp'), 'webp');
  assert.equal(iconExtension('deep/nested/photo.jpeg'), 'jpeg');
});

test('iconExtension falls back to png for unknown or missing extensions', () => {
  assert.equal(iconExtension('icon.svg'), 'png');
  assert.equal(iconExtension('noext'), 'png');
  assert.equal(iconExtension('trailing.'), 'png');
  assert.equal(iconExtension(''), 'png');
});

// ---------- 目标过滤 ----------

test('isIconTarget only accepts the four app icon targets', () => {
  for (const target of ['window', 'tray', 'desktop', 'taskbar']) {
    assert.equal(isIconTarget(target), true);
  }
  assert.equal(isIconTarget('mini'), false);
  assert.equal(isIconTarget(1), false);
  assert.equal(isIconTarget(undefined), false);
});

test('applicableTargets only reports targets with stored entries', () => {
  const settings = normalizeIconSettings({
    icons: {
      window: { path: 'icons/window.png', name: 'w.png' },
      tray: { path: 'icons/tray.png', name: 't.png' },
    },
  });
  assert.deepEqual(applicableTargets(settings, { desktop: true, taskbar: true }), [
    'window',
    'tray',
  ]);
  assert.deepEqual(applicableTargets(DEFAULT_SETTINGS, { desktop: true, taskbar: true }), []);
});

test('applicableTargets skips shortcut targets the platform cannot write', () => {
  const settings = normalizeIconSettings({
    icons: {
      window: { path: 'icons/window.png', name: 'w.png' },
      desktop: { path: 'icons/desktop.png', name: 'd.png' },
      taskbar: { path: 'icons/taskbar.png', name: 'tb.png' },
    },
  });
  assert.deepEqual(applicableTargets(settings, { desktop: false, taskbar: true }), [
    'window',
    'taskbar',
  ]);
  assert.deepEqual(applicableTargets(settings, { desktop: false, taskbar: false }), ['window']);
  assert.deepEqual(applicableTargets(settings, { desktop: true, taskbar: true }), [
    'window',
    'desktop',
    'taskbar',
  ]);
});

// ---------- 常量 ----------

test('icon limits match the host app.icons contract', () => {
  assert.equal(MAX_ICON_BYTES, 4 * 1024 * 1024);
});

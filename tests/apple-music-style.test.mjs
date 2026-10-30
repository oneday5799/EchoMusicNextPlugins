import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SETTINGS,
  SKIN_ID,
  clamp,
  normalizeSettings,
  qualityLabel,
  qualityTag,
  validateSettings,
} from '../plugins/apple-music-style/src/config.ts';

test('skin settings defaults mirror the ported plugin', () => {
  assert.equal(SKIN_ID, 'apple-music');
  assert.deepEqual(DEFAULT_SETTINGS, {
    enhanceContrast: false,
    fontScale: 100,
    fontWeight: 850,
    alignPosition: 48,
  });
});

test('skin settings validation accepts the default set and full ranges', () => {
  assert.equal(validateSettings(DEFAULT_SETTINGS), true);
  assert.equal(validateSettings({}), true);
  assert.equal(validateSettings({ fontScale: 50, fontWeight: 300, alignPosition: 0 }), true);
  assert.equal(
    validateSettings({
      fontScale: 200,
      fontWeight: 900,
      alignPosition: 100,
      enhanceContrast: true,
    }),
    true,
  );
});

test('skin settings validation rejects wrong types and out-of-range values', () => {
  assert.ok(validateSettings('no').errors);
  assert.ok(validateSettings([]).errors);
  assert.ok(validateSettings({ fontScale: '150' }).errors);
  assert.ok(validateSettings({ fontScale: 49 }).errors);
  assert.ok(validateSettings({ fontScale: 201 }).errors);
  assert.ok(validateSettings({ fontWeight: 299 }).errors);
  assert.ok(validateSettings({ fontWeight: 901 }).errors);
  assert.ok(validateSettings({ alignPosition: -1 }).errors);
  assert.ok(validateSettings({ alignPosition: 101 }).errors);
  assert.ok(validateSettings({ enhanceContrast: 1 }).errors);
});

test('skin settings normalization clamps and fills defaults', () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({ enhanceContrast: 1 }).enhanceContrast, false);
  assert.deepEqual(normalizeSettings({ fontScale: 999 }), { ...DEFAULT_SETTINGS, fontScale: 200 });
  assert.deepEqual(normalizeSettings({ fontWeight: -5 }), { ...DEFAULT_SETTINGS, fontWeight: 300 });
  assert.deepEqual(normalizeSettings({ alignPosition: 33 }), {
    ...DEFAULT_SETTINGS,
    alignPosition: 33,
  });
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-5, 0, 3), 0);
});

test('quality badges mirror host quality keys and cloud sources', () => {
  for (const [quality, tag] of [
    ['standard', 'SD'],
    ['higher', 'HQ'],
    ['flac', 'SQ'],
    ['hi_res', 'HR'],
    ['viper_tape', 'VPT'],
    ['viper_clear', 'VPC'],
    ['viper_atmos', 'VPA'],
  ])
    assert.equal(qualityTag(quality, false), tag);
  assert.equal(qualityTag('cloud', true), 'CLD');
  assert.equal(qualityTag('unknown', false), '');
  assert.equal(qualityLabel('flac', false), '无损');
  assert.equal(qualityLabel('anything', true), '云盘');
  assert.equal(qualityLabel('unknown', false), '');
});

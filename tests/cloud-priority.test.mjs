import assert from 'node:assert/strict';
import test from 'node:test';
import { createController, switchable, trackKey } from '../plugins/cloud-priority/src/entry.ts';

const SWITCH_DELAYS_MS = [500, 700, 1500, 3000, 6000];
const RESOLVE_POLL_MS = 1000;
const MAX_RESOLVE_POLLS = 30;

function mockHost(overrides = {}) {
  const snapshot = {
    hasTrack: true,
    loading: false,
    playing: true,
    sourceKind: 'catalog',
    track: { id: 'catalog:1', hash: 'HASH' },
    ...overrides,
  };
  const timers = [];
  let switches = 0;
  const host = {
    snapshot: () => snapshot,
    switchToCloud: () => {
      switches += 1;
    },
    setTimer: (delayMs, callback) => {
      for (const timer of timers) timer.disposed = true; // same-id replacement
      const registration = {
        delayMs,
        callback,
        disposed: false,
        dispose() {
          this.disposed = true;
        },
      };
      timers.push(registration);
      return registration;
    },
  };
  return {
    host,
    snapshot,
    switches: () => switches,
    pending: () => timers.filter((timer) => !timer.disposed).at(-1) ?? null,
    tick() {
      const timer = this.pending();
      assert.ok(timer, 'expected a pending timer');
      timer.callback();
      timer.disposed = true;
    },
  };
}

function snapshot(overrides = {}) {
  return {
    hasTrack: true,
    loading: false,
    sourceKind: 'catalog',
    track: { id: 'catalog:1', hash: 'ABC' },
    ...overrides,
  };
}

test('cloud priority only switches a resolved catalog track', () => {
  assert.equal(switchable(snapshot()), true);
  assert.equal(switchable(snapshot({ loading: true })), false);
  assert.equal(switchable(snapshot({ hasTrack: false })), false);
  for (const sourceKind of ['cloud', 'local', 'mv', 'plugin'])
    assert.equal(switchable(snapshot({ sourceKind })), false);
});

test('cloud priority identifies a track by ID and falls back to its hash', () => {
  assert.equal(trackKey(snapshot()), 'catalog:1');
  assert.equal(trackKey(snapshot({ track: { id: '', hash: 'ABC' } })), 'ABC');
});

test('the first switch waits out the stabilization window on a timer', () => {
  const m = mockHost();
  const controller = createController(m.host);
  controller.observe();
  assert.equal(m.switches(), 0);
  assert.equal(m.pending()?.delayMs, SWITCH_DELAYS_MS[0]);
  for (let i = 0; i < 3; i += 1) controller.observe();
  assert.equal(m.switches(), 0);
  assert.equal(m.pending()?.delayMs, SWITCH_DELAYS_MS[0]);
  m.tick();
  assert.equal(m.switches(), 1);
  assert.equal(m.pending()?.delayMs, SWITCH_DELAYS_MS[1]);
});

test('ignored switches retry only from the timer chain, never from player events', () => {
  const m = mockHost();
  const controller = createController(m.host);
  controller.observe();
  m.tick();
  assert.equal(m.switches(), 1);
  controller.observe();
  controller.observe();
  assert.equal(m.switches(), 1);
  for (let attempt = 1; attempt < SWITCH_DELAYS_MS.length; attempt += 1) {
    assert.equal(m.pending()?.delayMs, SWITCH_DELAYS_MS[attempt]);
    m.tick();
    assert.equal(m.switches(), attempt + 1);
  }
  assert.equal(m.pending(), null);
  controller.observe();
  assert.equal(m.switches(), SWITCH_DELAYS_MS.length);
});

test('a request that triggered a reload is never repeated', () => {
  const m = mockHost();
  const controller = createController(m.host);
  controller.observe();
  m.tick();
  assert.equal(m.switches(), 1);
  m.snapshot.loading = true;
  controller.observe();
  m.snapshot.loading = false;
  controller.observe();
  assert.equal(m.switches(), 1);
  assert.equal(m.pending(), null);
  controller.observe();
  assert.equal(m.switches(), 1);
});

test('reaching the cloud source stops the cycle', () => {
  const m = mockHost();
  const controller = createController(m.host);
  controller.observe();
  m.tick();
  assert.equal(m.switches(), 1);
  m.snapshot.sourceKind = 'cloud';
  controller.observe();
  assert.equal(m.switches(), 1);
  assert.equal(m.pending(), null);
});

test('tracks resolved to other sources are left alone', () => {
  for (const sourceKind of ['local', 'mv', 'plugin']) {
    const m = mockHost({ sourceKind });
    const controller = createController(m.host);
    controller.observe();
    assert.equal(m.switches(), 0);
    assert.equal(m.pending(), null);
  }
  const m = mockHost();
  const controller = createController(m.host);
  controller.observe();
  m.tick();
  assert.equal(m.switches(), 1);
  m.snapshot.sourceKind = 'mv';
  m.tick();
  assert.equal(m.switches(), 1);
  assert.equal(m.pending(), null);
});

test('switching tracks restarts the cycle with a fresh budget', () => {
  const m = mockHost();
  const controller = createController(m.host);
  controller.observe();
  m.tick();
  m.tick();
  assert.equal(m.switches(), 2);
  m.snapshot.track = { id: 'catalog:2', hash: 'HASH2' };
  controller.observe();
  assert.equal(m.pending()?.delayMs, SWITCH_DELAYS_MS[0]);
  for (let attempt = 0; attempt < SWITCH_DELAYS_MS.length; attempt += 1) {
    assert.equal(m.pending()?.delayMs, SWITCH_DELAYS_MS[attempt]);
    m.tick();
  }
  assert.equal(m.switches(), 2 + SWITCH_DELAYS_MS.length);
  assert.equal(m.pending(), null);
});

test('losing the track or an unidentifiable track resets watching', () => {
  const m = mockHost();
  const controller = createController(m.host);
  controller.observe();
  assert.equal(m.switches(), 0);
  assert.equal(m.pending()?.delayMs, SWITCH_DELAYS_MS[0]);
  m.tick();
  assert.equal(m.switches(), 1);
  m.snapshot.hasTrack = false;
  controller.observe();
  assert.equal(m.pending(), null);
  m.snapshot.hasTrack = true;
  controller.observe();
  assert.equal(m.pending()?.delayMs, SWITCH_DELAYS_MS[0]);
  m.tick();
  assert.equal(m.switches(), 2);

  const bare = mockHost({ track: { id: '', hash: '' } });
  const bareController = createController(bare.host);
  bareController.observe();
  assert.equal(bare.switches(), 0);
  assert.equal(bare.pending(), null);
});

test('a resolving track polls without consuming budget, then switches after stabilization', () => {
  const m = mockHost({ loading: true });
  const controller = createController(m.host);
  controller.observe();
  assert.equal(m.switches(), 0);
  assert.equal(m.pending()?.delayMs, RESOLVE_POLL_MS);
  for (let i = 0; i < 10; i += 1) m.tick();
  assert.equal(m.switches(), 0);
  assert.equal(m.pending()?.delayMs, RESOLVE_POLL_MS);
  m.snapshot.loading = false;
  controller.observe();
  assert.equal(m.pending()?.delayMs, SWITCH_DELAYS_MS[0]);
  for (let attempt = 0; attempt < SWITCH_DELAYS_MS.length; attempt += 1) {
    assert.equal(m.pending()?.delayMs, SWITCH_DELAYS_MS[attempt]);
    m.tick();
  }
  assert.equal(m.switches(), SWITCH_DELAYS_MS.length);
  assert.equal(m.pending(), null);
});

test('the resolve poll backstop gives up instead of running forever', () => {
  const m = mockHost({ loading: true });
  const controller = createController(m.host);
  controller.observe();
  for (let i = 0; i < MAX_RESOLVE_POLLS; i += 1) m.tick();
  assert.equal(m.pending(), null);
  assert.equal(m.switches(), 0);
  m.snapshot.loading = false;
  controller.observe();
  assert.equal(m.pending()?.delayMs, SWITCH_DELAYS_MS[0]);
  m.tick();
  assert.equal(m.switches(), 1);
});

test('apply issues one standalone switch on a switchable track', () => {
  const m = mockHost({ sourceKind: 'mv' });
  const controller = createController(m.host);
  controller.observe();
  assert.equal(m.switches(), 0);
  assert.equal(controller.apply(), 'mv');
  assert.equal(m.switches(), 0);
  m.snapshot.sourceKind = 'catalog';
  assert.equal(controller.apply(), 'catalog');
  assert.equal(m.switches(), 1);
  assert.equal(m.pending(), null);
});

test('a stabilization window consumed by a reload re-arms instead of stalling', () => {
  const m = mockHost({ loading: true });
  const controller = createController(m.host);
  controller.observe();
  for (let i = 0; i < MAX_RESOLVE_POLLS; i += 1) m.tick(); // poll budget spent
  assert.equal(m.pending(), null);
  m.snapshot.loading = false;
  controller.observe(); // arm the stabilization window
  assert.equal(m.pending()?.delayMs, SWITCH_DELAYS_MS[0]);
  m.snapshot.loading = true; // the host re-resolves before it fires
  m.tick(); // the window fires during the reload
  assert.equal(m.pending(), null); // poll budget is gone
  m.snapshot.loading = false;
  controller.observe(); // must re-arm instead of stalling without a timer
  assert.equal(m.pending()?.delayMs, SWITCH_DELAYS_MS[0]);
  m.tick();
  assert.equal(m.switches(), 1);
});

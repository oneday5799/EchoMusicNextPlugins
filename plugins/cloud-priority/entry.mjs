// plugins/cloud-priority/src/entry.ts
var RETRY_DELAYS_MS = [700, 1500, 3e3, 6e3, 1e4];
var RESOLVE_POLL_MS = 1e3;
var MAX_RESOLVE_POLLS = 30;
function trackKey(snapshot) {
  return snapshot.track.id || snapshot.track.hash;
}
function switchable(snapshot) {
  return snapshot.hasTrack && !snapshot.loading && snapshot.sourceKind === "catalog";
}
function createController(host) {
  let watchedTrack = "";
  let requested = false;
  let reloaded = false;
  let attempt = 0;
  let polls = MAX_RESOLVE_POLLS;
  let timer = null;
  function disposeTimer() {
    if (timer) {
      timer.dispose();
      timer = null;
    }
  }
  function schedule(delayMs) {
    disposeTimer();
    timer = host.setTimer("cycle", delayMs, false, () => {
      timer = null;
      evaluate(true);
    });
  }
  function freshCycle(key) {
    disposeTimer();
    watchedTrack = key;
    requested = false;
    reloaded = false;
    attempt = 0;
    polls = MAX_RESOLVE_POLLS;
  }
  function evaluate(viaTick) {
    const snapshot = host.snapshot();
    if (!snapshot.hasTrack) {
      freshCycle("");
      return;
    }
    const key = trackKey(snapshot);
    if (!key) {
      freshCycle("");
      return;
    }
    if (key !== watchedTrack) freshCycle(key);
    if (snapshot.sourceKind === "cloud") {
      disposeTimer();
      return;
    }
    if (requested) {
      if (snapshot.loading) {
        reloaded = true;
        return;
      }
      if (reloaded || !switchable(snapshot)) {
        disposeTimer();
        return;
      }
      if (viaTick && attempt < RETRY_DELAYS_MS.length) {
        attempt += 1;
        host.switchToCloud();
      }
      if (attempt >= RETRY_DELAYS_MS.length) {
        disposeTimer();
        return;
      }
      if (!timer) schedule(RETRY_DELAYS_MS[attempt]);
      return;
    }
    if (switchable(snapshot)) {
      requested = true;
      host.switchToCloud();
      schedule(RETRY_DELAYS_MS[0]);
      return;
    }
    if (!snapshot.loading && snapshot.sourceKind !== "catalog") {
      disposeTimer();
      return;
    }
    if (!timer && polls > 0) {
      polls -= 1;
      schedule(RESOLVE_POLL_MS);
    }
  }
  function apply() {
    const snapshot = host.snapshot();
    if (switchable(snapshot)) host.switchToCloud();
    return snapshot.sourceKind;
  }
  return { observe: () => evaluate(false), apply };
}
function activate(ctx) {
  const controller = createController({
    snapshot: () => ctx.player.snapshot,
    switchToCloud: () => {
      ctx.player.control("quality", { value: "cloud" });
    },
    setTimer: (id, intervalMs, repeat, callback) => ctx.setTimer(id, intervalMs, repeat, callback)
  });
  controller.observe();
  ctx.onPlayerChanged("cloud-priority", () => controller.observe());
  ctx.registerCommand("apply", () => ({ sourceKind: controller.apply() }));
  ctx.registerCommand("status", () => ({ sourceKind: ctx.player.snapshot.sourceKind }));
}
export {
  activate,
  createController,
  switchable,
  trackKey
};

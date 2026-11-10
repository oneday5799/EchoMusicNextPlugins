import type { EchoPluginContext, EchoPluginRegistration, PlaybackSnapshot } from 'echo:plugin-sdk';

// The host clears `loading` only when the engine has opened the resolved
// source, and `playing` is reported even later. A switch issued in the same
// breath as `source-switched` computes `m_seamless` as false and takes the
// non-seamless reload path — aborting the stream that just opened — while a
// manual switch, made on a playing stream, reuses the seamless hand-off. The
// first attempt therefore waits out a stabilization window so it lands the
// same way a manual switch does; ignored attempts retry down the chain.
//
// One switch cycle per track: once a request has actually triggered a reload,
// the cycle stops even if the host fell back to catalog. Re-attempting after
// that fallback would stack a second cloud load on a recoverable failure and
// can turn it into a terminal "decode failed, skipping track" outcome.
const SWITCH_DELAYS_MS = [500, 700, 1500, 3000, 6000];
// Watching is event-driven; the poll is only a backstop for missed player
// events while a track is still resolving, bounded so it cannot run forever.
const RESOLVE_POLL_MS = 1000;
const MAX_RESOLVE_POLLS = 30;

export function trackKey(snapshot: PlaybackSnapshot): string {
  return snapshot.track.id || snapshot.track.hash;
}

export function switchable(snapshot: PlaybackSnapshot): boolean {
  return snapshot.hasTrack && !snapshot.loading && snapshot.sourceKind === 'catalog';
}

export interface ControllerHost {
  snapshot(): PlaybackSnapshot;
  switchToCloud(): void;
  /** One-shot cycle timer; scheduling a new one replaces the pending one. */
  setTimer(delayMs: number, callback: () => void): EchoPluginRegistration | null;
}

export function createController(host: ControllerHost) {
  let watchedTrack = '';
  let requested = false;
  let reloaded = false;
  let attempt = 0;
  let polls = MAX_RESOLVE_POLLS;
  let stabilizing = false;
  let timer: EchoPluginRegistration | null = null;

  function disposeTimer(): void {
    if (timer) {
      timer.dispose();
      timer = null;
    }
  }

  function schedule(delayMs: number): void {
    // The host replaces a timer scheduled under the same cycle id, so the
    // pending registration only needs explicit disposal when the cycle stops.
    timer = host.setTimer(delayMs, () => {
      timer = null;
      evaluate(true);
    });
  }

  function freshCycle(key: string): void {
    disposeTimer();
    watchedTrack = key;
    requested = false;
    reloaded = false;
    attempt = 0;
    polls = MAX_RESOLVE_POLLS;
    stabilizing = false;
  }

  function evaluate(viaTick: boolean): void {
    const snapshot = host.snapshot();
    if (!snapshot.hasTrack) {
      freshCycle('');
      return;
    }
    const key = trackKey(snapshot);
    if (!key) {
      freshCycle('');
      return;
    }
    if (key !== watchedTrack) freshCycle(key);
    if (snapshot.sourceKind === 'cloud') {
      disposeTimer();
      return;
    }
    if (requested) {
      if (snapshot.loading) {
        // The host is reloading after our request; the settle event closes the
        // cycle, so pause the chain instead of stacking another switch.
        reloaded = true;
        return;
      }
      if (reloaded || !switchable(snapshot)) {
        disposeTimer();
        return;
      }
    }
    if (switchable(snapshot)) {
      if (requested) {
        // An ignored switch retries only from the timer chain; player events
        // never stack another switch on top of a pending retry.
        if (!viaTick) return;
        attempt += 1;
        if (attempt > SWITCH_DELAYS_MS.length) {
          disposeTimer();
          return;
        }
        host.switchToCloud();
        if (attempt < SWITCH_DELAYS_MS.length) schedule(SWITCH_DELAYS_MS[attempt]);
        else disposeTimer();
        return;
      }
      if (!stabilizing) {
        // First sight of the opened source: replace any resolve poll with a
        // stabilization window, so the switch lands on a playing stream the
        // same way a manual source change does.
        stabilizing = true;
        schedule(SWITCH_DELAYS_MS[0]);
        return;
      }
      if (!viaTick) {
        // Keep waiting; player events never switch. Re-arm if the window was
        // consumed by a reload while the poll budget was already spent, so the
        // cycle can never end up without a pending timer.
        if (!timer) schedule(SWITCH_DELAYS_MS[0]);
        return;
      }
      // Stabilization elapsed: switch exactly like a manual source change.
      stabilizing = false;
      requested = true;
      attempt = 1;
      host.switchToCloud();
      schedule(SWITCH_DELAYS_MS[1]);
      return;
    }
    if (!snapshot.loading && snapshot.sourceKind !== 'catalog') {
      disposeTimer();
      return;
    }
    if (!timer && polls > 0) {
      polls -= 1;
      schedule(RESOLVE_POLL_MS);
    }
  }

  function apply(): string {
    const snapshot = host.snapshot();
    if (switchable(snapshot)) host.switchToCloud();
    return snapshot.sourceKind;
  }

  return { observe: () => evaluate(false), apply };
}

export function activate(ctx: EchoPluginContext) {
  const controller = createController({
    snapshot: () => ctx.player.snapshot,
    switchToCloud: () => {
      ctx.player.control('quality', { value: 'cloud' });
    },
    setTimer: (delayMs, callback) => ctx.setTimer('cycle', delayMs, false, callback),
  });
  controller.observe();
  ctx.onPlayerChanged('cloud-priority', () => controller.observe());
  ctx.registerCommand('apply', () => ({ sourceKind: controller.apply() }));
  ctx.registerCommand('status', () => {
    const snapshot = ctx.player.snapshot;
    return {
      sourceKind: snapshot.sourceKind,
      noticeCode: snapshot.sourceNoticeCode,
      errorMessage: snapshot.errorMessage,
    };
  });
}

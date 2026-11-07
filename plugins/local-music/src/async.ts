// Small async helpers shared by the file-driven modules. Cancellation is
// driven through the host timer API because the QML JS engine has no
// setTimeout reachable from plugin code.

import type { EchoPluginContext, EchoPluginOperation } from 'echo:plugin-sdk';

let timerSequence = 0;

/** Cancels the operation after the budget expires; returns a disarm function. */
export function cancelOperationAfter(
  context: EchoPluginContext,
  operation: EchoPluginOperation<unknown>,
  timeoutMs: number,
): () => void {
  timerSequence += 1;
  const timer = context.setTimer(
    `local-music-cancel-${timerSequence}`,
    Math.max(0, timeoutMs),
    false,
    () => {
      try {
        operation.cancel();
      } catch (error) {
        // The operation already reached a terminal state.
      }
    },
  );
  if (!timer) return () => undefined;
  return () => {
    try {
      timer.dispose();
    } catch (error) {
      // Registration already drained during deactivation.
    }
  };
}

/** Resolves after at least one host timer tick, i.e. after the event loop
 * got a chance to process posted events (completion events, window update
 * requests). Used to hand the main thread back to rendering between
 * CPU-heavy synchronous work items. */
export function delay(context: EchoPluginContext, ms: number): Promise<void> {
  return new Promise((resolve) => {
    timerSequence += 1;
    const timer = context.setTimer(
      `local-music-delay-${timerSequence}`,
      Math.max(0, ms),
      false,
      () => resolve(),
    );
    if (!timer) resolve();
  });
}

export interface WorkPacer {
  run<T>(work: () => T): Promise<T>;
}

/** Serializes CPU-heavy synchronous work across concurrent workers. Each
 * queued block runs alone, after a host-timer yield, so the event loop can
 * process rendering between blocks. Plain promise chaining is not enough:
 * multiple FFI completions dispatch inside one event-loop pass, and their
 * continuations would then run back-to-back for the duration of the whole
 * run, starving the compositor. A slot whose timer expired while another
 * block was still running re-arms itself, so every block is preceded by a
 * real render gap even when several slots piled up behind a long block. */
export function createWorkPacer(context: EchoPluginContext, gapMs: number): WorkPacer {
  let tail: Promise<unknown> = Promise.resolve();
  let sequence = 0;
  let lastEnd = 0;
  return {
    run<T>(work: () => T): Promise<T> {
      const result = tail.then(
        () =>
          new Promise<T>((resolve) => {
            const runWork = () => {
              try {
                resolve(work());
              } finally {
                lastEnd = Date.now();
              }
            };
            const arm = (ms: number) => {
              const timer = context.setTimer(
                `local-music-pace-${(sequence += 1)}`,
                Math.max(0, ms),
                false,
                fire,
              );
              if (!timer) runWork();
            };
            const fire = () => {
              const rest = gapMs - (Date.now() - lastEnd);
              if (rest > 0) {
                // A long block just finished inside this gap; hand the loop
                // one more pass before starting the next block.
                arm(rest);
                return;
              }
              runWork();
            };
            arm(gapMs);
          }),
      );
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

/** Resolves with the promise value, or null once the budget lapses. */
export function raceTimeout<T>(
  context: EchoPluginContext,
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false;
    const finish = (value: T | null) => {
      if (settled) return;
      settled = true;
      if (timer) {
        try {
          timer.dispose();
        } catch (error) {
          // Ignore dispose races during deactivation.
        }
      }
      resolve(value);
    };
    timerSequence += 1;
    const timer = context.setTimer(
      `local-music-race-${timerSequence}`,
      Math.max(0, timeoutMs),
      false,
      () => finish(null),
    );
    promise.then(
      (value) => finish(value),
      () => finish(null),
    );
  });
}

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

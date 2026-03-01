import { CancellationToken, Disposable } from "vscode";

/**
 * Helper to convert a VS Code CancellationToken to a standard AbortSignal.
 */
export function toAbortSignal(token: CancellationToken): {
  signal: AbortSignal;
  disposable: Disposable;
} {
  const controller = new AbortController();

  // If already cancelled, abort immediately
  if (token.isCancellationRequested) {
    controller.abort();
    return {
      signal: controller.signal,
      disposable: { dispose: () => { } },
    };
  }

  // Otherwise, listen for the cancellation event
  const disposable = token.onCancellationRequested(() => {
    controller.abort();
    disposable.dispose(); // Clean up the listener
  });

  return { signal: controller.signal, disposable: disposable };
}

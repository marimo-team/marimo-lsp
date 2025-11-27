"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tokenFromSignal = tokenFromSignal;
/**
 * Creates a cancellation token from VS Code from a web-standard AbortSignal
 */
function tokenFromSignal(signal) {
    return {
        get isCancellationRequested() {
            return signal.aborted;
        },
        onCancellationRequested(listener, thisArgs, disposables) {
            const handler = () => listener.call(thisArgs, undefined);
            signal.addEventListener("abort", handler);
            const disposable = {
                dispose: () => signal.removeEventListener("abort", handler),
            };
            if (disposables) {
                disposables.push(disposable);
            }
            return disposable;
        },
    };
}

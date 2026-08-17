interface ClickCaptureEvent {
  readonly target: EventTarget | null;
  composedPath(): EventTarget[];
  stopPropagation(): void;
}

// ErrorBanner does not expose a semantic hook, so match its danger + clickable
// style combination. The selector is scoped to CellOutput by the capture
// handler and the corresponding renderer CSS rule.
const ERROR_BANNER_SELECTOR = ".cursor-pointer.shadow-error";

/**
 * Prevent marimo's ErrorBanner from opening a viewport-level AlertDialog in an
 * embedded cell output. Its fixed backdrop spans VS Code's shared renderer
 * surface and can leave the dialog itself inaccessible.
 *
 * TODO(marimo-team/marimo-lsp#764): Remove this interception once marimo's
 * ErrorBanner has embedded-safe error details that do not require a viewport
 * dialog.
 */
export function suppressEmbeddedErrorDialog(event: ClickCaptureEvent): void {
  // Plugins render in their own shadow roots. Outside that boundary, target is
  // retargeted to the custom-element host; composedPath preserves the banner.
  const clickedErrorBanner = event
    .composedPath()
    .some(
      (target) =>
        target instanceof Element && target.matches(ERROR_BANNER_SELECTOR),
    );

  if (clickedErrorBanner) {
    event.stopPropagation();
  }
}

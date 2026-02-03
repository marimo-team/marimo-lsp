Separate language server install from startup

Previously, starting the ty and ruff language servers used `uv tool run`
which conflated package installation with server startup. This made it
difficult to diagnose failures: was it a network/TLS issue during
download, or did the server process itself crash?

This change introduces a two-phase approach:

1. **Install phase**: Uses a new `ensureLanguageServerBinaryInstalled`
   method that installs the language server binary to the extension's
   global storage directory. This phase includes automatic retry logic
   with different strategies (default → native-tls → offline) to handle
   common installation failures like corporate proxy TLS issues or
   transient network problems.

2. **Start phase**: Launches the pre-installed binary, making server
   startup errors clearly distinguishable from installation issues.

The refactor also improves status tracking. Language servers now report
granular states (`Starting`, `Disabled`, `Running`, `Failed`) rather
than conflating "failed to start" with "disabled by config". The health
status is tracked via a `Ref` that updates as the server progresses
through its lifecycle.

Other changes:
- Renamed `NamespacedLanguageClient.ts` → `createManagedLanguageClient.ts`
  and converted to a factory function that handles installation
- Added `LanguageServerInstallError` with detailed attempt tracking
- Binaries are now installed to `globalStorageUri/libs/` for persistence
- `singleStrategy` test helper for exercising individual install strategies

There's some remaining duplication between `TyLanguageServer.ts` and
`RuffLanguageServer.ts` around the install/start/status-update flow that
could be extracted into a shared factory. Leaving that for a follow-up
PR since there are only two servers.

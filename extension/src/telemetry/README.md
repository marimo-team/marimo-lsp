# ty availability and usage

All usage events share a random `activation_id`, renewed each time the extension
activates. Use distinct activation IDs with `notebook_opened` and
`development = false` as the denominator. This event includes an already-active
notebook restored at startup; it means a marimo notebook editor was active,
not merely that VS Code launched. Join events by activation ID, not user ID:
one user can have several windows and activations.

| Event                          | Properties                                                                                                | Meaning                                                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `ty_status`                    | `state`: `starting`, `ready`, `missing`, `failed`, `disabled`                                             | Startup or restart state. `ready` includes binary `source` and server `version`.                                                               |
| `ty_prompt`                    | `action`: `shown`, `install`, `update`, `dismiss`, `dont_show_again`, `suppressed`; `extension_installed` | Warning shown, chosen action, closed warning, or a saved suppression. `update` opens the extension page; it does not prove an update occurred. |
| `ty_install_started`           | `attempt_id`, `install_activation_id`                                                                     | The warning's install command is about to run.                                                                                                 |
| `ty_install_finished`          | Same IDs; `outcome`: `succeeded`, `failed`                                                                | VS Code's install command returned successfully or failed. Success does not prove ty started.                                                  |
| `ty_install_activation_result` | Same IDs; `outcome`: `ready`, `missing`, `failed`, `disabled`                                             | First terminal startup state on a later activation in the same workspace. Its common `activation_id` identifies that later activation.         |
| `ty_feature_used`              | `feature`: `completion`, `hover`, `navigation`, `diagnostics`                                             | First successful response in each category per activation, including across server restarts.                                                   |

`missing` means resolution found no compatible binary. `failed` means the startup
cycle failed for another reason; normal cancellation is excluded. `disabled`
means marimo's managed language features are disabled by configuration, so an
external language server may still serve Python features. These are startup
observations, not continuous monitoring of process health.

Feature events for completion, hover, and navigation mean a request completed
successfully, including an empty result. They do not prove a suggestion was
accepted or that content was useful. Navigation covers definition, type
definition, declaration, and references. Diagnostics are recorded separately
when pushed diagnostics reach VS Code's collection, including an empty list
that clears errors. This does not measure pull diagnostics, which the client
does not currently request. No request text, response content, paths, notebook
IDs, or raw errors are added to these events.

Suggested PostHog views:

1. **Availability:** eligible activations with any `ready` / all eligible
   activations. Also show the latest terminal startup state per activation to
   expose restart failures; leave unfinished startup as unknown.
2. **Feature coverage:** eligible activations with each feature / all eligible
   activations, and / activations with `ready`. Show interactive categories
   separately from automatic diagnostics. No feature event means no observed
   successful request, not proof of failure or opt-out.
3. **Unavailable breakdown:** for activations without `ready`, group by terminal
   startup state. For `missing`, split prompt outcomes, including suppressed,
   dismissed, install, and update. Don't Show Again suppresses the warning;
   it does not disable ty. Old saved dismissals cannot reveal whether the user
   explicitly dismissed or installed under the previous behavior.
4. **Installation funnel:** join by `attempt_id`: started → command succeeded →
   later activation ready. Report command failures separately from successful
   installs followed by missing/failed startup or disabled managed features.
   A missing later result is incomplete, not an install failure. Restrict the
   originating activation to the notebook cohort and allow a follow-up window
   across reporting periods. Installs performed outside this warning are not
   attributed to this funnel.

Only the pending install IDs survive reload, in workspace storage. A failed
command clears them; the first later terminal startup state consumes them.
Interrupted commands may have no finish event; do not infer command success
from a later startup result. There is no requirement to reload immediately.

The new ty events and their persisted install tracking respect marimo telemetry
consent and VS Code's usage telemetry gate. Development/test extension hosts
and `MARIMO_REPLAY_TY_PROMPT=1` emit no new ty events or install markers. Their
existing usage events carry `development = true`, so exclude them from the
denominator too. Dashboards must use events with the new activation properties;
historical events cannot be joined this way.

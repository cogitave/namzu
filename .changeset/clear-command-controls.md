---
"@namzu/cli": major
"@namzu/sdk": major
---

Make interactive command selection and reporting reflect the active session.

The CLI now opens a goal menu for `/goal` and the delegated-agent view for
`/agents`. Use `/goal status` for a goal report and `/agents available` for
the configured roster. `/status`, `/cost`, `/context`
and `/mcp` show concise reports; use the `details` variants or `/mcp tools`
for expanded diagnostics. Usage is labeled as current or latest run usage.
Searchable help, skill, branch and commit menus treat typed digits as search
text; use arrows and Enter to select. Esc cancels previous-prompt editing.

`/settings` shows effective model, reasoning and permission settings. Changing
a model preserves fallbacks and subagent preferences and saves only after
successful activation. `/tasks` reads the current or latest run's real store,
with no task state carried across conversation switches.

Resume hints include the working directory and the actual Node executable and
CLI entrypoint, preventing a checkout build from handing its UUID session to
an older global installation. Embedded hosts can supply their own launch
command; otherwise their hint uses `namzu`.

The SDK goal command reserves `status` for inspection and `set` for explicit
creation. To create an objective literally named `status`, use `/goal set status`.
The previous bare `/goal status` created that objective. Goal reports now use
`enabled`/`paused` and `Automatic turns` instead of `armed`/`disarmed` and
`Rounds admitted`; consumers parsing human-readable reports must update.

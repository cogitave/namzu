---
'@namzu/sdk': minor
'@namzu/cli': minor
---

Hooks are no longer only commands. In the `hooks` config an entry may now be `{ type: http, url, headers?, allowedEnvVars? }` (the event is posted as JSON and a 2xx body is the answer; private and link-local addresses are refused), `{ type: prompt, prompt }` (the small model judges a condition; `{"ok": false}` refuses the action), or a command with `args` (run without a shell) or `async: true` (started and not waited for). Every kind takes `onFailure: block` to refuse the action when the hook itself fails (cannot start, times out, exits other than 0 or 2, prints unreadable JSON); the default `continue` is the old behaviour. In `@namzu/sdk`, `ShellHooksConfig` entries are now `ShellHookHandler` (a union that still includes `ShellHookEntry`, so existing entries keep working), `attachShellHooks` takes a `judge` option to answer `prompt` hooks, and `shellHookVerdict` takes the wider entry type. Code that reads `.command` from a config entry must narrow on `type` first. Nothing to change to keep working.

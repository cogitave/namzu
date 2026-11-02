---
'@namzu/sdk': minor
'@namzu/computer-use': major
---

`computer_use` now says what it knows about each action instead of reporting a call that returned as "done", and works from a window's controls first.

What changes for the model: an action reports `done, verified` only when the host read the state back, `sent, not confirmed` when the input went out and nothing could check it (look before repeating, because repeating can act twice), and a failure marked "Not delivered" when nothing reached the target (safe to try again). `data.steps[]` carries `delivery` (`delivered_verified`, `delivered_unverified`, `not_delivered`) and `retrySafety` (`safe`, `unsafe`). A new `wait_for` action (element, text or window condition, bounded) replaces fixed waits and returns the window's controls with fresh refs. The tool text leads with `list_windows`, `ui_snapshot`, `ui_act`; the first coordinate click in a captured window gets a reminder, not a refusal.

What changes for a host: `UiActResult` gains optional `delivery`, `retrySafety` and `readBack`; `executeWindow` may return a `WindowInputResult`; a display `{ type: 'ok' }` may carry `delivery`, `retrySafety` and `detail`. All are additive and optional, so an existing host keeps working and keeps the plain `done`. `ComputerUseHost.executeWindow` is now declared as returning `Promise<void | WindowInputResult>`; a wrapper that annotates it as `Promise<void>` and discards the result still compiles, but one that forwards it should use the wider type.

What changes in the Windows backend (`@namzu/computer-use`): `set_value`, `toggle` and `select` read the control back and are verified or not delivered by what the window then shows; `set_value` on a field with no settable value is "not delivered" and no longer types into it as a fallback; a click that leaves another window in front, and window input the driver could not confirm, are "sent, not confirmed" instead of done; a refused background input is "not delivered" with what to do next. Refs of a window stay valid after a read-back. If your own tooling parsed the old "typed into the empty field" detail or relied on those cases counting as success, read `delivery` instead.

This is `major` for `@namzu/computer-use` because an outcome a caller could rely on changes: the `set_value` fallback to typing is gone, former successes become failures or unconfirmed results, and a driver error the backend cannot classify is now reported as "sent, not confirmed" and unsafe to repeat rather than "not delivered". To keep the old behaviour, read `ok` only and ignore `delivery`; nothing restores the typing fallback.

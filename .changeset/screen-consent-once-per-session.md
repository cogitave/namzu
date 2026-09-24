---
"@namzu/sdk": minor
"@namzu/cli": major
---

The interactive CLI now asks once per session before the model first sees your screen, and `strict` mode no longer lets a screenshot run on its own — that second part is why this is a major release for `@namzu/cli`. In `prompt`, `accept-edits` and `plan` mode the first `computer_use` call that would send the screen to the provider — a screenshot, a zoom, the list of open windows, a window's controls, or an action that returns a screenshot — opens a "Share your screen" box naming the provider; after a yes, later screenshots in that session run without asking, and clicks, typing and `ui_act` are still reviewed as before. A mode switch keeps the answer; a new session (`/new`, `/clear`, `/model`) asks again. `auto` never asks. **`strict` now refuses a screenshot unless a rule allows it**: to keep screenshots running in `strict`, add `permissions: { computer_use: 'allow' }` (which also allows clicks) or a narrower rule for the actions you want.

Approving a `ui_act` call shows the control by name (`Press Button "Beş" (e30)`), and `ui_snapshot` as the window it reads.

**`@namzu/sdk`**

- `ToolDefinition.capturesScreen?(input)` and `defineTool({ capturesScreen })` declare which calls send the operator's screen to the model provider. `computer_use` declares its observations and every action followed by a screenshot.
- `createReviewHandler` / `createReviewPolicy` take `screenConsent: { sessions: Set<string> }` and an optional `capturesScreen(name, input)` predicate (default: the tool's declaration from `registry`). With them, the first such batch in a session is put to `prompt` with the new `ToolReviewRequest.screenConsent: true`; `strict` refuses it unless a rule allowed it, `auto` does not ask, and without a `prompt` it is refused with the new `SCREEN_CONSENT_UNATTENDED_REFUSAL`. A no is `SCREEN_CONSENT_DECLINED_FEEDBACK`. New type `ScreenConsentRecord`. Without `screenConsent` nothing changes.

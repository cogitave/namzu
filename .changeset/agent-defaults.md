---
'@namzu/browser': major
'@namzu/sdk': minor
'@namzu/cli': major
---

Three defaults changed, and a page dialog can now be answered either way.

`browser.signInDetection` now defaults to `page` (it was `address`), in the CLI setting and in `PlaywrightBrowserHost` / the classifier when the option is left out. A page at a `/login`-style address no longer stops the turn by itself: the model is told once that it cannot type a password or code and carries on with every other step. CAPTCHAs, bot blocks, HTTP authentication, the known sign-in hosts and `signInAddresses` still stop the turn, and credential fields are still never typed. To keep the old behaviour set `browser.signInDetection: address` (a host built directly passes `signInDetection: 'address'`; `isSignInAddress`, `classifyHumanRequired` and `signInNotice` now take the address behaviour only with that option).

The `pick` decision point now defaults to `on` when a `decision` model is configured and the point is not named (it was `off`), so `ui_do` is offered and acts only when the decision model is sure (confidence 0.85, a 0.4 lead). The connect flow also writes `pick: on` instead of `pick: shadow`. To keep the old behaviour set `decision.points.pick: off` (or `shadow`). The other points keep `off`, and nothing changes without a decision model.

`browser_act dialog` can now accept a held page dialog: `accept: true` answers an alert or a confirm and answers a prompt with `promptText` (empty when omitted). The Playwright host used to refuse every accept. A prompt whose message asks for a password, passcode or one-time code refuses `promptText` and says nothing was typed; a second dialog while one is held is still dismissed. `@namzu/browser` exports `asksForCredential`, and the tool description in `@namzu/sdk` says the model may accept or dismiss.

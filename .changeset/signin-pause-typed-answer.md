---
'@namzu/cli': minor
'@namzu/browser': minor
'@namzu/sdk': patch
---

A reply the browser paused for a sign-in is no longer a dead end in the terminal. A message you type while it waits now continues it, with your words passed to the model as yours to answer first (before, it was refused and the pause was lost, so Enter did nothing). Esc stops it even with a draft in the box, slash commands such as `/help` leave the pause alone, and Enter on an empty box continues a paused reply whose pause had dropped off the screen, or says why there is nothing to continue. The notices now name Enter, a typed message and Esc, and say the browser is namzu's own profile, not Brave, Chrome or Edge. A mistyped command names the nearest one (`/abondon` suggests `/abandon`).

With a visible browser window, namzu now looks at the open page every 3 seconds while the pause waits and continues by itself once the page stops asking for you (two looks in a row, at most twice before you act, for up to 10 minutes). It only reads the page: no navigation, typing, clicks, cookies or storage. New `peekHumanRequired()` on `PlaywrightBrowserHost` in `@namzu/browser`. To keep the old behaviour of waiting for Enter, set `browser.signInWatch: false`.

`@namzu/sdk`: the text of a `browser_human_required` refusal gains one sentence telling the model the browser is namzu's own profile; nothing else changes.

---
'@namzu/cli': minor
---

In the Desktop app, the agent's browser can now work in a tab of the app's Browser pane. When the app says it can host one (`namzu/browser-pane` at `initialize`), `namzu acp --desktop` drives that tab with the same browser code and asks the app for it with `namzu/browser/pane/open`, `/cdp` and `/close`; the app sends page events back as `namzu/browser/pane/event` and `/state`, which the engine now lists among its methods. If the app does not offer it, cannot open a tab, or the browser is set to run without a window (`browser.headless: always`), the engine opens its own browser as before, with one line saying why. A paused sign-in reports `window: 'pane'` and no terminal login command. The Desktop contract number does not change: an older app is never asked and keeps its card text, and an older engine is never sent a tab event. `/browser` in the terminal names the pane when that is where the browser runs.

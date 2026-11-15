---
'@namzu/cli': minor
---

Web tasks in the terminal read better: after each click or typed value the model is told what changed on the page (or that nothing did), a dropdown's chosen value is visible to it, and it can read less of a big page with `snapshot` views and find. The new read-only `value` action is allowed under the same site rule as the other looking calls (`snapshot`, `screenshot`, `scroll`, `wait_for`). One thing is looser: browser screenshots now hide only password and one-time-code fields, so other input text on a page is visible to the model in an image. Opening a page also returns what is on it, so the model needs one request fewer per page visit; the browser-automation skill says so.

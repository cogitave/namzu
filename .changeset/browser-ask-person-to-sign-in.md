---
'@namzu/browser': minor
---

A host with a person in the conversation can now ask for a different note when a page shows a password or code field but does not stop the turn: `BrowserHostOptions.askPersonToSignIn` (and a fourth `askPerson` argument to `signInNotice`). With it on and a browser window available, the note tells the model to ask the person to sign in in the browser window and wait, and does not name a terminal command; without it, or with no window, the note is unchanged. Nothing changes for a host that does not set it.

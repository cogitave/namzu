---
'@namzu/cli': patch
---

Under `namzu acp --desktop`, a permission request for a `computer_use` call now says which application the call works on and why it still needs a person (`computer: { app, consequence }`), and the host sends one `namzu/session/computer-frame` notification per call that returned a screenshot (a small PNG, the application and the click point). A client that does not know them ignores them; nothing the model is given changes.

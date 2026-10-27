---
"@namzu/cli": minor
---

`namzu resident` is deprecated and will be removed in the next major release. Every action (`add`, `status`, `run`, `start`, `learn` and the rest) now prints one line saying so, and still does what it did. Use `namzu schedule` for recurring work, `/goal` for work that spans turns and background agents in the terminal app. `namzu learn` and `namzu learning` are not affected.

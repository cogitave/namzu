---
"@namzu/sandbox": patch
"@namzu/desktop": patch
---

Setting up a Pal computer on Windows now names the step Windows is actually working on. While Windows asks for permission and turns Windows features on, the row reads "Turning on Windows features…" instead of "Installing Linux support…"; the next step is shown only once the elevated script reaches it. `runWslcSetup` announces just the first elevated step before the elevated call and reports every elevated step, in order, when the call ends, so a progress listener sees each step start and finish once.

A setup step that Windows could not finish now has a Details line that says which step stopped and with which exit code ("Turning on Windows features stopped with exit code 1."), or that it did not finish when Windows gave no code, instead of repeating the main sentence. The `detail` text of a `failed` result from an elevated step changes accordingly; match on `code`, `step` and `exitCode` rather than on the text.

Namzu Desktop no longer shows the same failure twice. A failed or administrator-needed setup is toasted only when the Pal computer row that already shows it is not on screen.

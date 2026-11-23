---
"@namzu/cli": minor
---

Auto mode now asks you when its safety check cannot be completed, instead of refusing the call and stopping the turn. The terminal says why in a few words (`no credential for the check model`, `provider returned 400`, `timed out after 60 s`) and puts the same question `prompt` mode would; your answer decides, and the mode stays as it is. The cause is written to the log. With nobody to ask (`namzu exec`, a scheduled run) the call is still refused, now with the cause in the reason, and three answers in a row still stop the turn.

A turn stopped by a refusal or by a check that gave no verdict now ends with one line of what was done and what is left (`Stopped before the task was finished · changed 6 files so far · 2 calls not run · send a message to carry on`). The line under a turn names the newest result of each check, so a command that failed and later passed (also as a background job) is not drawn as failed.

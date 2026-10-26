---
'@namzu/sdk': major
---

Request layout. The blocks that belong to a turn (recalled memory and evidence, `context` prompt contributions, `PrepareStepResult.context`) now sit just before the operator's new message while that message is what the model is about to answer, so the request is the last thing it reads. Once the turn has called a tool, they follow the history as before, so a caching driver still keeps the tool loop cached. Where this context sits in the request is a changed default, so this is a major: a host or test that read the last request message for it should now find the `step-context` message just before the operator's new message (the last message of the request is the operator's own). Nothing else to do on upgrade.

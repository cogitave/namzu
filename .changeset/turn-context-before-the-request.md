---
'@namzu/sdk': patch
---

Request layout. The blocks that belong to a turn (recalled memory and evidence, `context` prompt contributions, `PrepareStepResult.context`) now sit just before the operator's new message while that message is what the model is about to answer, so the request is the last thing it reads. Once the turn has called a tool, they follow the history as before, so a caching driver still keeps the tool loop cached. A host or test that read the last request message for this context should look for the step-context message instead. Nothing to do on upgrade otherwise.

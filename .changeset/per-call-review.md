---
'@namzu/sdk': minor
---

A turn can now ask about one tool call at a time while the batch runs. Set `perCallReview` on `query()` or an agent config (a `PerCallReviewConfig`; `{}` is enough) and the turn walks the model's calls in order. Calls that are safe to run side by side start together and each opens its own one-call `tool_review` request, which carries `perCall: true`; an unsafe call waits for every earlier call to finish, then asks, then runs; an approved call starts at once. Nothing changes unless you set it: without the option every request, answer and event is the batch shape it was.

`reject_tools` and the prompt's `reject` answer gain an optional `endTurn: true`. A refusal that carries it answers every call of the batch (what runs is cancelled, what has not started is refused unasked) and stops the turn with the stop reason `cancelled`; without it a refusal refuses only the call or batch it was given for, as before. A prompt receives `perCall` and a `signal` that aborts when its question stops being open, and `onRulesChanged` and `covers` let a host re-check the questions still open, which only ever approves. Each open question is parked on its own, and a second process resumes one with `resumeFromCheckpoint` and `pendingDecision`: the decision applies to the calls that park named, calls that had run are not run again, and nothing else is run.

To use it, pass `perCallReview` and keep your `resumeHandler`; answer each one-call request, give your prompt the `signal` so it can close a question that was answered elsewhere, and send `endTurn: true` with a plain No if you want it to stop the turn.

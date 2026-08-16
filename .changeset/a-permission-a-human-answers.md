---
'@namzu/sdk': minor
'@namzu/cli': minor
---

The agent-client bridge can now ask a human, read the editor's unsaved buffers, and resume a session. NZ-PEER-07 refused any session whose client could not answer a permission request, which was honest and left the bridge unusable for the case it exists for.

**The direction the bridge did not have.** A notification is fire-and-forget; a permission prompt is a question the run cannot proceed past. The server now issues JSON-RPC *requests* — `session/request_permission`, `fs/read_text_file`, `fs/write_text_file` — parks the promise by id, and resolves it when the client's response frame arrives. A response frame used to be ignored, which was right when nothing was ever out on the wire and would now leave a run parked with nobody coming.

**Three ways the permission exchange fails silently, each closed and each mutation-checked:**

- Auto-approving instead of asking. `toResumeDecision` maps the outcome to the kernel's own `HITLResumeDecision`, and a denial becomes `reject_tools` with the client's feedback — a `continue` there would run the calls the human just refused. A bare denial gets a default sentence, because an empty `reject_tools` feedback reads to the model as a tool that failed for no reason and it retries.
- An "approve all" that never takes. `approve_tools` with nothing remembered is indistinguishable from a plain approve, so `approve_all` carries the grant keys and a plain approve carries none — consent is not transferable.
- An "approve all" that leaks. The latch lives on the SESSION record: a second session from the same process asks again. Hoisting it to the server, or to a module-level variable, would make one person's "stop asking me" cover the next session this process serves — possibly a different repository, editor window, or human.

An answer the agent cannot parse is treated as a refusal, never as consent.

**`clientBackedSandbox` makes the editor's buffers the filesystem.** A user with unsaved changes had the agent read disk, see a version nobody is looking at, and patch *that*. A client declaring the `fs` capability answers reads and writes instead. It is a decorator over the existing `Sandbox` — a client-backed object implementing only the file methods would take `bash` away from a session that had it — and it is a `Proxy` rather than a spread, so a member added to `Sandbox` later still reaches the real one. A failed client read rejects rather than falling back to disk: stale text is the exact thing the capability exists to stop.

**`session/load` resumes.** The prior turns come from the gateway's session store, never from the bridge, and the resumed session answers with the SAME id — a client that asked to resume `ses_x` and got `ses_y` back has to rewrite everything keyed by the old one. A gateway with no store refuses rather than returning an empty history, which a client cannot tell apart from a session that really had no turns. Resuming carries the same permission requirement as creating, because a refusal on `session/new` that `session/load` walks around is not a refusal.

---
'@namzu/ollama': minor
'@namzu/lmstudio': minor
---

Both local drivers now speak tools, and say so.

Each declared `supportsTools: false` and meant it: neither read `params.tools`,
so no schema ever reached the model and the runtime stripped the tool surface
before every run. The declaration was honest, which is why nothing broke
loudly — it was simply a capability neither driver had, on wires that have
carried tools all along.

**Both drivers**

- Tool schemas are sent, calls are surfaced with an id, a name and JSON
  arguments, and each call closes as it arrives rather than at end-of-stream —
  so a first call can start executing while a second is still being generated.
- The assistant turn that made a call is replayed as a call, not as prose. It
  used to be dropped, which left the model reading an answer to a question it
  had no record of asking.
- The finish reason is `tool_calls` when a call was made.

**Local daemon driver**

- A tool result is bound to its call by tool NAME on that wire, not by call id;
  the name is resolved from the assistant turn that made the call.
- Image attachments are carried as image bytes instead of a text placeholder,
  and an image inside a tool result is carried too. A media type the daemon
  cannot decode would fail the whole request, so an unrecognised format is
  named in the text rather than sent as bytes.
- Reasoning is requested only when the caller asks for it, streamed as
  reasoning rather than answer text, and replayed back on the next turn.
- `supportsTools`, `supportsFunctionCalling` and `supportsVision` are now
  `true`.

**Local desktop driver**

- The conversation is mapped onto the backend's native part structure: the
  assistant's calls and each result are first-class parts, replacing the
  `[tool-result]` marker that folded results into a user turn.
- Tool names round-trip untouched. The backend rewrites them by default, and
  since the runtime owns the loop nothing maps a rewritten name back — a
  rewritten name would come home unresolvable.
- Arguments are taken from the backend's parsed object rather than stitched
  from raw fragments, which the backend warns are not guaranteed to be JSON.
- A call that fails to parse is reported rather than swallowed: silence there
  is indistinguishable from a model that chose not to call anything.
- Reasoning fragments are routed to reasoning, and the `<think>` tags
  themselves stay out of the answer.
- New `client` config option: pass an already-connected backend client instead
  of dialing a new one. The underlying SDK opens its websocket in the
  constructor, so several providers against one server would otherwise open a
  connection each with no handle on their lifetime.
- `supportsTools` and `supportsFunctionCalling` are now `true`. `supportsVision`
  stays `false` — an image would have to be uploaded and referenced by handle
  first, and this driver does not make that round-trip.

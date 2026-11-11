---
'@namzu/ag-ui': major
---

`@namzu/ag-ui` now speaks AG-UI protocol 1.0 (`@ag-ui/core`, `@ag-ui/encoder` and `@ag-ui/client` 1.0.4, which use the `zod` you install instead of bundling a zod 3 copy). Upgrade if you want zod 3 out of your dependency tree; stay on 4.0.0 if a client you control still sends protocol 0.x content.

What breaks:

- A message with a 0.x `binary` content part (`{ type: "binary", mimeType, data }`) is no longer accepted. The HTTP endpoint answers 422 `Invalid AG-UI RunAgentInput.`, and `toNamzuMessages` throws `AGUIRequestError` (422, `INVALID_MESSAGE_HISTORY`) naming the replacement. Clients on `@ag-ui/client` 0.x that attach files must upgrade to 1.x, or send an `image` or `document` part with `source: { type: "data", value: <base64>, mimeType }`.
- The `AGUIMessage` and `RunAgentInput` types are `@ag-ui/core` 1.0's: user content parts are `text | image | audio | video | document` (no `binary`; sources are `data | url | file`), a `tool` message's content is `string | parts`, and `tools` and `context` are required on the type though a request may omit them. TypeScript code that switches on `part.type === "binary"` or assumes a tool message's content is a string no longer compiles.
- A frontend tool result sent as media parts is refused with `AGUI_RESUME_INVALID`; text, or text-only parts, still reach the tool as text.
- `input` handed to your `createQuery` keeps fields the protocol does not define on the request, its messages, tools and context (they used to be dropped); read only the fields you know.
- If your application also depends on `@ag-ui/client` or `@ag-ui/core` directly, move them to 1.0.4 as well; 0.x and 1.x should not be mixed in one application. The `zod` peer range of this package (`^4.1.0`) is unchanged.

`toNamzuMessages` also now carries a tool message's inline image and document parts into the SDK's tool result blocks (it refused every parts-shaped tool message before); URL and file-handle sources and audio/video are still refused. Nothing else in the exported API changed.

New request limits, and one new refusal. A request inside `maxRequestBytes` used to be able to make validation allocate over 1 GB (one issue object per element of a body like `[1,1,1,...]`) before your `createQuery` ran. The adapter now counts each collection first and answers 422 with code `REQUEST_LIMIT_EXCEEDED` (message names the collection and the option, no request data) when one is over its limit, and validates messages one at a time. New `AGUIAdapterOptions`, all positive integers:

| Option | Default |
| --- | --- |
| `maxMessages` | 20,000 |
| `maxPartsPerMessage` | 1,000 |
| `maxToolCallsPerMessage` | 1,000 |
| `maxTools` | 2,000 |
| `maxContextEntries` | 1,000 |
| `maxResumeEntries` | 1,000 |

A client that legitimately sends more than a default (for example a history of over 20,000 messages) now gets 422 where it got through before; pass a higher value for that option to accept it. A limit option passed as `null` (a JavaScript caller; the types already forbid it) used to be read as unset and is now refused at construction with a `RangeError`, for the new options and for `maxRequestBytes`, `maxEventBytes`, `maxPendingEvents` and `interrupts.ttlMs` alike. A request within the limits reaches your `createQuery` with exactly the same `input` as before.

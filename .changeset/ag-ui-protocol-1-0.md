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

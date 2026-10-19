---
"@namzu/sdk": major
"@namzu/cli": minor
---

`web_fetch` now works like the reference terminal's WebFetch, which changes its input and its default output.

What breaks, and what to do:

- `prompt` is required. A caller that sent only `url` now gets an input error; send the question you want answered from the page. `offset` (optional) reads on through a page too long for one call.
- The default output changed. It used to be the response body as text. It is now the answer to `prompt` when the host supplies `context.web.extract` (a `WebContentExtractor`, a new optional member of `ToolContext.web`), and otherwise the page as markdown, in both cases cut at 100 000 characters per call; a non-2xx status reports the status instead of its body, and an HTML page is converted to markdown with `turndown` (a new dependency, loaded on first use). A host that needs the raw body can fetch through `context.web.fetch` itself.
- A redirect to another host is no longer followed. `web_fetch` asks the provider for `redirects: 'same-host'` (new optional `WebFetchRequest.redirects`, default `'follow'` as before), and the tool returns a notice with the target for the model to fetch deliberately. A custom provider that ignores the field still follows every redirect.
- Fetched pages are cached for 15 minutes per URL, per fetch provider. URLs longer than 2000 characters, with credentials, or with a host that has no dot are refused before any request.

In the CLI, `web_fetch` (with `web.fetch: true`) answers the prompt with the small model (see `smallModel`), reads up to 10 MiB per page, and counts that request on the turn's token ledger; if the small model cannot answer, the model gets the page as markdown.

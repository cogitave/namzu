---
'@namzu/sdk': minor
'@namzu/anthropic': minor
---

Tool-loading economics: honor prompt caching in the Anthropic provider and
make deferred-tool discovery ranked and bounded.

`@namzu/anthropic`:

- `cacheControl` on `ChatCompletionParams` is now honored (it was silently
  dropped; `cache_read_input_tokens` was always 0). The provider emits up to
  three `cache_control: {type:'ephemeral'}` breakpoints per request: the
  tools-array tail, the last `'cache'`-tagged system block, and the last
  message block (render order tools → system → messages).
- System messages are sent as a block array preserving `SystemMessage.cacheHint`
  segment boundaries instead of being joined into one string. The OAuth
  Claude Code identity block stays first.
- `toolChoice: 'none'` now maps to Anthropic's first-class
  `tool_choice: {type:'none'}` instead of `{type:'auto'}`, and `tool_choice`
  is only sent alongside a `tools` param.
- `parallelToolCalls: false` now maps to `disable_parallel_tool_use: true`
  on the `tool_choice` (previously unmapped).

`@namzu/sdk`:

- The runtime keeps the tools param byte-stable on forced-final iterations
  (resource-limit finalization) and forbids tool use via `toolChoice: 'none'`
  instead of omitting `tools` — omitting busted the whole prompt-cache prefix
  and risked a 400 with `tool_use`/`tool_result` blocks in history.
- `ToolRegistry.toPromptSection()` lists active tools name-only (their
  descriptions and schemas already ride the runtime tools param every
  request) and gives deferred tools a first-sentence hint (≤100 chars) so the
  model can discover what a deferred name does before searching.
- `ToolRegistry.searchDeferred()` is now a ranked weighted search (exact
  name 12, name substring 8, description 5, argument names 3 — the
  `ToolCatalog.searchTools` weights) with generic CRUD verbs (`list`,
  `read`, `create`, `update`, `get`, `find`, `delete`, `search`) added to the
  stop-token set. `search_tools` activates only the top-5 ranked matches and
  reports up to 5 near-misses as name+hint WITHOUT activating them, so a
  retrieval miss becomes a cheap re-query instead of a dead end. The
  `search_tools` input wire shape (`{query}`) is unchanged.

# Beautiful UI visual reference

The [public gallery](https://www.beautifului.dev/) was inspected in a fresh
Chromium context at 1280 × 900. Ten captured interaction states and computed
styles are in [observations.json](observations.json). The gallery's default theme
is dark even with the browser's light color preference. These are prototype
examples, not verified agent executions.

| Example | Observed presentation | Namzu decision |
| --- | --- | --- |
| [Expanded search](thinking-search-expanded.png) | One action heading; subordinate query, then titled domain links beneath a thin rail. | Use a meaningful action name. Retain the actual query in details. Show only supplied sources, never infer links from a result count. |
| [Tool chips](tool-chips-expanded.png) | One quiet group summary, flat action rows, subordinate contextual chips. | Remove the redundant action-group header and repeated routine completion badges; retain visible failures and waits. |
| [Answer sources](answer-sources-expanded.png) | Compact source-count disclosure after the answer; opened rows carry names/domains. | Keep actual answer citations clickable. A count-only provider receipt cannot produce equivalent source cards. |
| [Task rows](task-rows.png) | Planned tasks have meaningful titles and explicit completion/failure badges. | Preserve task statuses; do not conflate planned tasks with routine transcript steps. |
| [Chat](chat-flavors.png) | Primary prose and brief contextual work labels. | Keep the answer prominent and avoid repeating technical status beside every action. |

Search rows measure 24 px in this gallery, with 13 px headings and 12.5 px query
text. Namzu retains 32 px interactive rows and its own tokens. The gallery's
disclosure animates grid height and opacity over 400 ms, chevron rotation over
300 ms, and the rail over 500 ms. These measured durations are reference facts,
not instructions to copy all gallery entrance animations into a conversation.
Namzu's existing controlled height motion and reduced-motion behavior are tested
separately in the [renderer proof](../artifacts/renderer-proof.json).

The inspected references do not establish Namzu's contextual message-clock
policy. Quiet hover/focus clocks are a product decision that preserves exact
recorded times and keeps them accessible. No reference implementation is copied
into the product.

To recapture public states: `node research/transcript-search-timing-20261007/beautifului-reference.mjs`.

---
'@namzu/sdk': patch
---

The `browser` tool's `cursor` field tells the model it is only the `nextCursor` a previous snapshot returned, to be left out for the top of the page, and never a URL. A model passed the page's address as the cursor and got a refusal before it could read the page.

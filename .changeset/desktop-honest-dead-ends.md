---
'@namzu/desktop': patch
'@namzu/cli': patch
---

Namzu Desktop no longer shows things that lead nowhere. The rail drops the disabled Spaces, Scheduled and Plugins buttons until they exist (Plugins is still in the composer's + menu). A conversation that ended because Namzu was closed now offers "Ask Namzu to continue", which sends a new message (a turn cut off by closing cannot be resumed) and says what its actions finished. Settings, Tools lists the project's tool servers instead of "Not set": where each is defined and whether it is connected, waiting for your approval or failed, with a button that approves a waiting `.mcp.json` the way `namzu mcp approve` does. The search box also finds text inside replies and tool output and shows an excerpt. The engine gains three host methods for this (`namzu/conversations/search`, `namzu/mcp/servers`, `namzu/mcp/approve`); nothing existing changes, and an older engine simply shows no list and no text search.

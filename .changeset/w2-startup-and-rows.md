---
'@namzu/cli': minor
---

The interactive session no longer waits for tool servers before the composer is ready. They connect in parallel in the background (child-process servers three at a time, remote ones twenty), each one is reported in plain words when it connects or fails ("It did not answer in time." instead of the deadline in milliseconds), and its tools join at the next turn; a message sent before a server has connected does not have its tools yet. Headless runs (`exec`, JSON output, scheduled jobs, the agent protocol server) are unchanged and still wait. A reply paused by a lost connection now keeps one pause line across failed tries, the resume list keeps `ctrl+r rename` in a narrow terminal, `/doctor` names a waiting update and its command, and a command or skill refused for extra text says so without the placeholder name or the full path.

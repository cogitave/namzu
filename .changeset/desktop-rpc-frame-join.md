---
"@namzu/desktop": patch
---

Large runtime messages such as images no longer slow the window, because a message is joined once when its line ends instead of searched on every chunk.

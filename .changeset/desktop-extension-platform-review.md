---
'@namzu/desktop': patch
---

An extension's page can no longer paint over Namzu's own strip, title or buttons, and it closes with its window. The page is cut to the part of the dialog you can see and hidden while one of Namzu's own dialogs or notices lies over it. Closing a page while it is still opening, closing the window, or reloading the screen leaves nothing on top. Each page has its own network rules, and a page that declared no network can no longer reach one through video calling.

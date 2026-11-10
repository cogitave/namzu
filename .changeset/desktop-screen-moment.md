---
'@namzu/cli': patch
'@namzu/computer-use': patch
'@namzu/desktop': patch
---

Desktop now asks, with a card, when an application needs your keyboard and mouse for a moment (Allow now or Not now, every time, never covered by "Allow for this conversation"); before, that case waited for a still moment without asking. When the pinned cua-driver is not cached the helper is downloaded as before, now with a one-time notice, and older cua-driver version folders in the cache are removed afterwards.

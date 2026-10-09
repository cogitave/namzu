---
'@namzu/desktop': minor
---

Namzu Desktop is now an installed Windows app that keeps itself up to date. Download the installer once, run it (no administrator prompt; Windows may show an "unknown publisher" warning because the installer is not signed yet, so choose More info, then Run anyway), and your conversations, drafts and settings carry over from the development app. From then on Namzu checks for a new version in the background, downloads it, and only restarts when you choose Restart, never while a reply, a permission request or a terminal is in use. Settings ▸ Updates shows "Up to date" or "Update available" and lets you turn automatic downloads off.

Since 0.1.0 you also get: real terminal tabs for the Namzu CLI, Codex and Claude Code beside your conversations (open from the composer or the + menu, with the composer's text sent as the first message); updates for Codex, Claude Code and the Namzu command line from Settings ▸ Updates, run in a visible terminal tab and only when you click; a compact sidebar with one surface per row and a tab-strip menu for new conversations, terminals and windows; faster engine start-up (Codex starts once instead of per chat); local Turkish speech bundled with its own Python; and many smaller fixes to terminals, focus and settings wording.

If you installed Namzu Desktop before this version, that copy cannot update itself: install this version once by hand and later versions arrive on their own.

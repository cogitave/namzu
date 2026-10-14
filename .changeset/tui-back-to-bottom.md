---
'@namzu/cli': minor
---

Scroll back through the conversation without leaving Namzu. Press PgUp at the message box and a view of the whole conversation opens above it, one page up; PgUp and PgDn page, the arrow keys move a row, Home goes to the start. While you are reading older text, one quiet line above the message box says `↓ Back to bottom · esc` (shorter on a narrow terminal), and starts with `New activity ·` if the reply keeps arriving while you are scrolled up. Press End or Esc, or scroll down to the last page, and the view closes with the session exactly as you left it. Your terminal's own scrollback is untouched and nothing changes unless you press PgUp.

This release also brings existing users the `@namzu/sdk` 50.1.0 and `@namzu/zen` 4.0.1 tool-schema fix. The CLI did not publish a new version with it, so `namzu upgrade` had nothing to install; this version does. If a free Zen model refused a request that included the edit tool, upgrading fixes it and you need to do nothing else.

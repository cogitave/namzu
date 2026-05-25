---
'@namzu/cli': patch
---

**Clean-screen takeover + a gradient NAMZU splash on launch.**

namzu now clears the terminal (screen + scrollback) when it starts, so it opens on a fresh canvas instead of below leftover shell output — the clean "takeover" feel of claude-code / gemini-cli. It stays in the normal screen buffer, so native scrollback still works as the conversation grows.

The startup banner is now an ASCII "NAMZU" wordmark rendered as a vertical teal→violet gradient, with a tagline, version, and connected provider beneath it. On narrow terminals (< 48 cols) it falls back to a compact `▲ namzu` mark.

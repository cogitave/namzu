---
"@namzu/cli": patch
---

When startup fails to load state or construct a session, show a clear stopped screen instead of an unusable message composer. Esc or one Ctrl+C now exits that screen. The original error stays visible, and invalid identity files remain untouched.

Installations with a prefixed tenant ID must back up and move their old identity.json aside before starting the UUID-only CLI fresh. This creates a new installation identity; existing conversations stay on disk and are not imported. Provider preferences and credentials can be kept.

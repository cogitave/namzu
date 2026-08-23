---
'@namzu/cli': patch
'@namzu/anthropic': patch
---

Repair Claude subscription sign-in by matching the current registered browser request, letting the provider picker accept its returned authorization code, and preserving the subscription-routing identity on model requests. Print the TUI banner once during boot and keep the permanent idle key legend out of the footer while preserving state-specific interaction hints.

---
"@namzu/cli": major
---

Web search now defaults to automatic search routing for conversation models, instead of being disabled. A supported native driver is preferred for a single-provider session; other routes use Exa under the normal network-tool permission policy. Neither Exa nor public Zen requires OpenCode installation. The public endpoint has free-tier limits. Set `web.search: off` to retain the old disabled behavior; set `web.backend: native` to use the existing provider-hosted search route instead.

Add `/config` as an entry to session settings and `/config sources` for configuration provenance. `/status` now presents a compact, wrapping session card including the search backend. `/setup` separates optional CLI installation from account access, offers confirmed npm installation with cancellation, and rechecks installation before connecting.

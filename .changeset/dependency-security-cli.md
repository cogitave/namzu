---
'@namzu/cli': patch
---

Raises the minimum of four runtime dependencies to releases that carry security fixes: `minimatch` to 11.0.1 (GHSA-g3hv-75wg-m249, ReDoS), `sharp` to 0.35.5 (GHSA-f88m-g3jw-g9cj, GHSA-rgj7-g3m4-5g8c, GHSA-wq5f-xc86-pv6w), `undici` to 7.30.1 (cache poisoning, TLS bypass and renegotiation, content-encoding DoS) and `@modelcontextprotocol/client` to 2.3.0 (GHSA-6qxp-vccf-f47h, GHSA-6prh-2h8m-c8cw). MCP clients no longer follow a same-origin redirect with a saved sign-in token; point the server entry at the final URL if a redirect is expected. Nothing else changes for the operator.

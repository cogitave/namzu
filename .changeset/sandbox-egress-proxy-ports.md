---
"@namzu/sandbox": minor
---

The docker and runsc egress proxy now enforces the `ports` of an egress
profile, on the port it actually dials: an upgraded `http://host/` and a
`CONNECT` with no port are checked on 443. A host may use the union of the
ports of every rule that matches it. The same check is available on
`EgressProxy` as `allowedPorts`, and `egressPortsForRules(profile.hosts)`
builds that option from a profile's rules with the same union rule.

**Rebuild `egressProxyImage` from `packages/sandbox/egress-proxy/Dockerfile`
before using `ports`.** A profile with ports sends the proxy a new
configuration variable, `NAMZU_EGRESS_PROXY_CONFIG_V2`, and the backend first
reads the image's `ai.namzu.egress-proxy.config` label with
`docker image inspect`, refusing an image that does not declare version 2 (or
that is not on the daemon: `docker image inspect` does not pull). Profiles
without ports, and every policy without a profile, need nothing: the proxy
gets the same configuration and argv as before.

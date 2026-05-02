---
'@namzu/sdk': minor
---

feat(sdk): default sandboxed verification gate preset + expanded brick-pattern denylist

Ship `defaultSandboxedGateConfig()` and `defaultSandboxedShellGateConfig()` from `@namzu/sdk` so
hosts running an agent inside an isolated workspace don't have to hand-roll a `VerificationRule[]`
just to keep in-sandbox file mutation from triggering a review prompt on every call. The first
preset auto-allows read-only tools and `category: 'filesystem' | 'analysis' | 'custom'`; the
second extends auto-allow to `category: 'shell'` for hosts with real OS-level isolation. Both
keep the dangerous-patterns hard-deny in place.

`DANGEROUS_PATTERNS` (consumed by the `deny_dangerous_patterns` rule) gains entries for `sudo`,
`su -`, world-writable `chmod 777 /`, `curl|sh` / `wget|sh` exfil-then-exec pipes, outbound
`ssh user@host`, and raw dynamic `eval`. The list is still high-signal, not exhaustive — the
README in `verification/presets.ts` is explicit that the sandbox itself is the safety boundary
and the patterns only catch blatant attempts.

---
'@namzu/cli': major
---

Refuse explicit invalid values for known configuration keys instead of silently substituting a default, lower-precedence value, or disabled feature.

`loadConfig` and `loadConfigWithProvenance` now validate user, project and managed files, every declared profile body, and explicit `NAMZU_FORMAT` / `NAMZU_QUIET` values. A semantic failure throws the exported `ConfigValueError`, which names the source and exact setting path. The CLI maps it to `EX_CONFIG` (78); an invalid `--format` is rejected as command-line usage (64) before the command runs. Unknown keys remain non-strict and permission/MCP entries retain their existing per-entry diagnostics.

Profile selection now uses own-property semantics, so inherited object names such as `toString`, `constructor`, and `__proto__` are not treated as declared profiles. A literal own profile with any of those names remains selectable.

**What breaks:** callers that previously received a fallback config from a known invalid file, profile, or environment value now receive `ConfigValueError`; scripts passing an unsupported `--format` no longer run in text mode. Fix the named value or remove it, and unset an environment variable rather than setting it to an empty string when no override is intended.

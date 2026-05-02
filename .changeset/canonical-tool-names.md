---
'@namzu/sdk': major
---

feat(sdk)!: rename builtin tools to Claude Code canonical names

**Breaking change.** Builtin tool names now mirror Claude Code's canonical
tool table verbatim (per `code.claude.com/docs/en/tools-reference`):

- `bash` → `Bash`
- `edit` → `Edit`
- `glob` → `Glob`
- `grep` → `Grep`
- `read_file` → `Read`
- `write_file` → `Write`

`LsTool` and `SearchToolsTool` are still exported but **removed from the
default `getBuiltinTools()` set**. Claude Code's training distribution
does not include `LS` (directory listing is `Bash` + `Glob`) and has no
`search_tools` analogue at all. Including them in the defaults gave the
model two tools that looked right but degraded alignment. Hosts that
genuinely want either can register them explicitly.

Why this is breaking and worth it: Namzu is a peer to Claude Code's
native agentic surface, not a wrapper around the Anthropic Beta Agents
API. Mirroring the canonical names verbatim means Claude's pretrained
agentic instincts apply for free — no system-prompt argument needed to
explain what `Read` or `Bash` does. Idiosyncratic snake_case names threw
that alignment away on every call.

**Migration:** consumers that hard-code tool-name strings in their
prompt overlays, friendly-label maps, or per-tool deny rules need to
update them to the new PascalCase names. The runtime registry contracts
(register / get / has) are unchanged; only the literal string names of
the builtin tools moved.

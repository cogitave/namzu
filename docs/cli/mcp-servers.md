---
type: Reference
title: Tool servers
description: The mcpServers config key — how the CLI declares an external MCP tool server by command or by URL, what environment the child gets, how long each server has to connect, and what happens when one does not.
resource: packages/cli/src/integrations/mcp/servers.ts
tags: [cli, config, mcp, tools]
status: stable
generated: { by: process:claude-code, at: 2026-09-16T00:00:00Z }
---

# Tool servers

An external tool server is declared under `mcpServers` in `namzu.config.json`, one entry per server, keyed by the name its tools will carry (`mcp__<name>__<tool>`). Every server is connected before the first turn. Its tools, prompts and resources enter live toolsets that update after a supported `list_changed` notification or reconnect. A server that does not work is named with a reason rather than silently absent.

## One entry

```json
{
  "mcpServers": {
    "tickets": {
      "command": "/usr/bin/python",
      "args": ["tickets_server.py"],
      "cwd": "/srv/tickets",
      "env": { "TICKETS_MODE": "readonly" },
      "inheritEnv": ["TICKETS_TOKEN"],
      "connectTimeoutMs": 20000
    },
    "search": {
      "url": "https://search.example.com/mcp",
      "headers": { "X-API-Key": "…" }
    }
  }
}
```

| Key | Transport | Meaning |
| --- | --- | --- |
| `command`, `args` | stdio | The executable to run and its arguments. The child speaks JSON-RPC over its stdin and stdout. |
| `cwd` | stdio | The child's working directory. Defaults to the agent's. |
| `env` | stdio | Variables set for the child. Written into the config file, so not for secrets — unless a value is a `${VAR}` reference (below). |
| `inheritEnv` | stdio | Names of variables copied from the operator's own environment. The child gets process plumbing plus what is named, never the whole environment — a server that needs one token is granted that token, and a reviewer can see which. |
| `url`, `headers` | HTTP | The server's endpoint and the headers every request carries. Redirects are refused: a credentialed body is never replayed to a location the config did not name. A header value may also be a `${VAR}` reference (below). |
| `connectTimeoutMs` | both | How long this server has to connect, hand shake and list its tools. Default 10,000 ms. Must be a positive number; anything else is refused with a reason. |
| `eraProbeTimeoutMs` | both | How long this server's era probe — see below — waits for an answer, in milliseconds. Defaults to the SDK's own `2000`, clamped to `connectTimeoutMs`. Must be a positive number; anything else is refused with a reason. |
| `allow`, `deny` | both | Lists of server-reported tool, prompt or resource names, before the `mcp__` prefix. `deny` wins over `allow`; malformed lists fail that server by name. |
| `maxRetries` | both | Nonnegative integer retry budget for calls the SDK classifies as safe to repeat. Unset leaves the SDK default. |
| `requireApproval` | both | `true` asks for approval on every tool this server contributes, including prompts and resources. Default `false`. |
| `readOnlyHintTrusted` | both | `true` lets this server's read-only annotations count as trusted for review exemptions. Default `false`. Set only for a server whose claims the operator trusts. |

An entry names a command or a URL, never both. One that names both is refused rather than guessed at, because picking either would run something the operator did not mean to run.

## `${VAR}` in `env` and `headers` values

An `env` or `headers` value may reference the operator's own environment with a bare `${VAR_NAME}`:

```json
{
  "mcpServers": {
    "search": {
      "url": "https://search.example.com/mcp",
      "headers": { "Authorization": "Bearer ${SEARCH_API_TOKEN}" }
    }
  }
}
```

This is deliberately narrower than the `${VAR}`/`${VAR:-default}` interpolation some other MCP clients' configs use (several desktop and editor MCP clients accept both forms anywhere in their config): namzu recognizes only a bare `${VAR_NAME}` (identifier characters — letters, digits, underscore), only inside `env` and `headers` values, and never a `:-default` fallback. `command`, `args`, `url` and `cwd` are passed through literally — there is no secret use case for interpolating those, and it would only widen the surface for an accidental literal `${` to break. A config copied from another tool that relies on `${VAR:-default}` or interpolates outside `env`/`headers` is **not** automatically compatible: those forms are passed through as literal text, unexpanded, rather than silently misinterpreted.

A `${VAR_NAME}` reference to a variable that is not set in the operator's environment fails that one server with a named reason (`references ${VAR_NAME}, which is not set in the operator's environment`) through the same per-server failure reporting every other bad entry uses — never a silent empty string. That is the whole point of not supporting `:-default`: a secret header sent empty is worse than a server that refuses to start.

`inheritEnv` stays the primary idiom for "grant this named variable to the child process under its own name" — it is a flat, reviewable allowlist. `${VAR_NAME}` is for the config *value* itself: renaming an operator's variable into whatever key or header name a server expects, and — since `inheritEnv` only reaches a stdio child's process environment — the only secret-safe option `headers` has ever had.

## The connect deadline

The default of ten seconds exists for a wedged server: a process that spawns, opens its pipe and never speaks would otherwise hold the whole session open before the first turn, with no error and no failure, just a namzu that does not start. The client's own per-request timeout cannot cover that case.

A server whose first spawn is genuinely slow is a different thing. A Python SDK server cold-boots in fifteen to twenty seconds on some machines, and under that default it is a working server the CLI refuses, so a headless `namzu exec` that depends on it stops before its first model call with `server "name" did not answer within 10000ms`. `connectTimeoutMs` raises the bound for that server alone; the others keep the deadline that protects the session. The value is named in the failure, so a deadline that is still too short says so.

### The era probe

Before it offers the legacy `initialize` handshake, `connect()` asks the server `server/discover` to see whether it speaks the modern MCP era instead. First contact with a given origin (HTTP) or resolved command (stdio) pays one extra round trip for this — cached afterward, so it is spent once per server identity, not once per session. Against a server that answers, modern or legacy, that round trip is the only cost. Against a legacy stdio server old enough to stay silent on a method it has never heard of, the probe instead waits out its own timeout once before falling back — `eraProbeTimeoutMs`, above, which is what to lower for a server known to be that old, so the probe gives up sooner and leaves more of `connectTimeoutMs` for the handshake that will actually answer.

## When a server does not work

Each failure becomes an entry with a reason: the command could not be spawned, the spec named neither a command nor a URL, the handshake did not answer in time, `connectTimeoutMs` or `eraProbeTimeoutMs` was not a positive number. What is done about it differs by surface. A person in the interactive session sees the line and fixes the config. A headless `exec` has nobody to read it, so it refuses to start rather than let the model work without tools it was promised — the hazard this module exists to prevent is the operator who watches the agent struggle and concludes the model is bad at the task.

A stdio server is a child process. The session owns its shutdown: closing the session closes every connected server, bounded at two seconds each, so a one-shot `namzu exec` leaves nothing behind.

`/mcp tools` shows the current names and any instructions the server supplied during initialization. Instructions are server-authored text, displayed as such; they do not change the host's authorization rules. The two resource tools are deferred until discovered by name. Closing the session stops reconnect attempts before disconnecting transports.

---
type: Reference
title: Tool servers
description: The mcpServers config key — how the CLI declares an external MCP tool server by command or by URL, what environment the child gets, how long each server has to connect, and what happens when one does not.
resource: packages/cli/src/integrations/mcp/servers.ts
tags: [cli, config, mcp, tools]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-05T00:00:00Z }
---

# Tool servers

An external tool server is declared under `mcpServers` in `namzu.config.json`, one entry per server, keyed by the name its tools will carry (`mcp_<name>_<tool>`). Every server is connected before the first turn, its tools are listed once and adapted into the session's roster, and a server that does not work is named with a reason rather than silently absent.

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
| `env` | stdio | Variables set for the child. Written into the config file, so not for secrets. |
| `inheritEnv` | stdio | Names of variables copied from the operator's own environment. The child gets process plumbing plus what is named, never the whole environment — a server that needs one token is granted that token, and a reviewer can see which. |
| `url`, `headers` | HTTP | The server's endpoint and the headers every request carries. Redirects are refused: a credentialed body is never replayed to a location the config did not name. |
| `connectTimeoutMs` | both | How long this server has to connect, hand shake and list its tools. Default 10,000 ms. Must be a positive number; anything else is refused with a reason. |

An entry names a command or a URL, never both. One that names both is refused rather than guessed at, because picking either would run something the operator did not mean to run.

## The connect deadline

The default of ten seconds exists for a wedged server: a process that spawns, opens its pipe and never speaks would otherwise hold the whole session open before the first turn, with no error and no failure, just a namzu that does not start. The client's own per-request timeout cannot cover that case.

A server whose first spawn is genuinely slow is a different thing. A Python SDK server cold-boots in fifteen to twenty seconds on some machines, and under that default it is a working server the CLI refuses, so a headless run that depends on it stops before its first model call with `server "name" did not answer within 10000ms`. `connectTimeoutMs` raises the bound for that server alone; the others keep the deadline that protects the session. The value is named in the failure, so a deadline that is still too short says so.

## When a server does not work

Each failure becomes an entry with a reason: the command could not be spawned, the spec named neither a command nor a URL, the handshake did not answer in time, `connectTimeoutMs` was not a positive number. What is done about it differs by surface. A person in the interactive session sees the line and fixes the config. A headless `run` has nobody to read it, so it refuses to start rather than let the model work without tools it was promised — the hazard this module exists to prevent is the operator who watches the agent struggle and concludes the model is bad at the task.

A stdio server is a child process. The session owns its shutdown: closing the session closes every connected server, bounded at two seconds each, so a one-shot run leaves nothing behind.

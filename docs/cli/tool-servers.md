---
title: External tool servers
description: Declare tool servers in namzu.config.json and their tools join the agent's roster, prefixed with the server's name.
last_updated: 2026-08-06
status: current
related_packages: ["@namzu/cli", "@namzu/sdk"]
---

# External tool servers

namzu can connect to tool servers you declare, and their tools join the roster the agent works with — alongside `bash`, `read`, `edit` and the rest. That is how namzu reaches anything it does not ship: your issue tracker, an internal search index, a deployment API.

```json
{
  "mcpServers": {
    "tickets": { "command": "node", "args": ["./tools/tickets-server.js"] },
    "search":  { "url": "https://tools.example.internal/mcp" }
  }
}
```

Put this in `namzu.config.json` — project-level in the working directory, or user-level in your home directory. Both are read; the project one wins.

## An entry

Each key is the server's name. Tools arrive prefixed with it, so `create` from `tickets` becomes `mcp_tickets_create` — two servers offering the same tool name do not collide, and the transcript says where a call went.

An entry names **either** a command **or** a URL, never both.

| Field | For | Meaning |
| --- | --- | --- |
| `command` | a local server | The executable to run. |
| `args` | a local server | Its arguments. |
| `env` | a local server | Literal environment variables for the child. |
| `inheritEnv` | a local server | Names of variables from **your** environment the child may have. |
| `cwd` | a local server | Its working directory. Defaults to the agent's. |
| `url` | a remote server | The endpoint to connect to. |
| `headers` | a remote server | Extra headers, for authentication. |

An entry naming both, or neither, is refused **by name** rather than skipped — picking one for you would run something you did not ask to run.

### What a local server is handed

A local server gets process plumbing — `PATH`, the home and temp directories, the locale, and the platform equivalents — plus exactly what you name in `env` and `inheritEnv`. It does **not** get the rest of your environment.

That is a change. It used to receive every variable the namzu process held, so a server needing one token was handed every credential on the machine, and nothing in the config recorded it. If a server stops authenticating after an upgrade, this is why, and the fix is to say what it may have:

```json
{
  "mcpServers": {
    "issues": {
      "command": "some-mcp-server",
      "inheritEnv": ["GITHUB_TOKEN"]
    }
  }
}
```

Use `inheritEnv` rather than `env` for anything secret: `env` puts the literal value in a config file you probably commit, while `inheritEnv` names a variable and leaves the value in your environment. A name you have not set is simply absent for the child — the server sees no variable rather than an empty one, and the spawn still succeeds.

A server declared by a **plugin** cannot use `inheritEnv`. A plugin naming the host variables its server receives would be granting itself a credential, which is the operator's call — declare that server under `mcpServers` instead.

## When a server does not come up

namzu tells you which server, and why. That is the whole hazard this feature carries: an operator declares a server, watches the agent work without its tools, and concludes the model is bad at the task.

- **In the TUI** — a line under the connect banner for each server, connected or not:

  ```
  Tool server tickets · 4 tools
  Tool server search is not available: server "search" did not answer within 10000ms
  ```

  The session continues. You are here, you can read the line and fix the config.

- **In `namzu run` and `namzu run-stream`** — the run **refuses**, naming the server and the reason. Nobody is watching a headless run, and a script that quietly does half the job is worse than one that stops. `run` exits `1`; `run-stream` emits the reason as an `error` event.

Each server gets ten seconds to start, hand shake and list its tools. A server that starts and never answers is reported rather than held on to — otherwise one wedged server keeps namzu from starting at all, with no error and no failure.

One server failing does not take the working ones with it. They connect, they are listed, and the failure is named beside them.

## Lifetime

A local server is a child process. namzu shuts every server down when the session ends — when a one-shot finishes, and when you switch providers in the TUI and a new session replaces the old one.

## Trust

Servers are declared in a config file inside a folder, and `command` runs an executable. A folder namzu works in has to be trusted first — see [The folder has to be trusted](./headless.md#the-folder-has-to-be-trusted). The same decision covers both: a project config that can start a process and a project build script that can start one are not different questions.

## Permissions

A bridged tool is an ordinary tool to the permission layer, under its prefixed name. So a `[permissions]` table can name it:

```json
{
  "permissions": {
    "mcp_tickets_close": "ask",
    "mcp_search_query": "allow"
  }
}
```

See [Tools & permission](./tools.md). A server's own declaration of whether a tool is read-only or destructive is carried through, so the safety gate and the permission prompt see what the server said about it.

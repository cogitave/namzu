---
type: Reference
title: Tool servers
description: Configure, connect, and authorize external MCP tool servers by command or URL.
resource: packages/cli/src/integrations/mcp/servers.ts
tags: [cli, config, mcp, tools]
status: stable
generated: { by: process:claude-code, at: 2026-09-16T00:00:00Z }
---

# Tool servers

An external tool server is declared under `mcpServers` in `namzu.config.json`, one entry per server, keyed by the name its tools will carry (`mcp__<name>__<tool>`). Every server is connected before the first turn. Its tools, prompts and resources enter live toolsets that update after a supported `list_changed` notification or reconnect. A server that does not work is named with a reason rather than silently absent.

## Manage your own servers from the CLI

`namzu mcp list` and `namzu mcp get <name>` show servers saved in `~/.namzu/config.yaml`. `namzu mcp add` saves a server, `namzu mcp remove <name>` removes only that entry, and both take `-s, --scope user|project` (default `user`). The command preserves unrelated YAML settings and refuses to replace an existing server. New names start with a letter and use letters, digits, underscores or hyphens, up to 64 characters. `get` and `remove` also accept an exact existing name outside that rule, such as `github.com`.

| Form | Saves |
|---|---|
| `namzu mcp add <name> --url <url>` | an HTTP server |
| `namzu mcp add -t http <name> <url>` | the same, with the address after the name |
| `namzu mcp add <name> -- <command> [arguments...]` | a local command (`-t stdio` is the default) |
| `namzu mcp add json <name> '<json>'` | whatever one `mcpServers` entry says |

Flags: `-s, --scope user|project`; `-t, --transport stdio|http` (`sse` is refused: servers that need Server-Sent Events are not supported); `-e, --env NAME=value` for a command server, repeated (`NAME=${OTHER}` reads the value from your environment when the server starts, and a value written literally is saved in the file as written); `-H, --header 'NAME: value'` for an HTTP server, repeated.

**Scope.** `user` writes `~/.namzu/config.yaml`. `project` writes `.mcp.json` in the current folder, keeping every other key in that file. A server written there does not start until you run `namzu mcp approve <name>`, exactly like one a teammate committed, and the command says so. `remove -s project` takes an entry out of `.mcp.json`.

**`add json`.** The JSON is one object with the shape of one entry in the config file: `command`, `args`, `env`, `inheritEnv`, `cwd` for a local command, or `url` and `headers` for an HTTP server, plus the optional timeouts and `allow`/`deny` lists. A `type` key of `stdio` or `http` is read and not saved. The entry is checked with the checks a session applies when it starts the server (one of command and url, field types, timeout ranges), and with the same rules as the flags: no credentials in the address, header values only as `${ENV_VAR}` or `Bearer ${ENV_VAR}`, credentials and URL queries only over HTTPS or to this computer. Nothing is saved when a check fails. `json` is the JSON form only when exactly two arguments follow it and the second is a JSON object; otherwise it is an ordinary server name, so `namzu mcp add json node server.js` saves a server called `json`.

`--env NAME` (without a value) and `--header NAME=VALUE` are retired: they print `` `--env NAME` is now `--env NAME=${NAME}` `` or `` `--header NAME=VALUE` is now `--header 'NAME: VALUE'` `` and exit 64 without saving anything.

### Sign in to an HTTP server

Run `namzu mcp login <name>` to authorize a configured HTTP server. This command resolves the active server entry, including project, profile, and managed overrides. It opens the authorization page in a browser and waits for a callback on a temporary loopback port. Use `--no-browser` to print the page URL without opening it; after authorization, paste the complete callback URL into the terminal if the browser cannot reach that loopback port. `--timeout <seconds>` changes the five-minute wait, up to one hour. The page URL is shown even when a browser launch was attempted, so a headless or remote terminal can complete the same flow.

Namzu checks the callback's one-time state before exchanging its code, and the MCP client checks the authorization server's issuer and uses PKCE. Bearer and refresh tokens, client registration, and pending callback state are stored in private files under `~/.namzu/mcp-oauth/`, keyed by the **complete configured server URL**. A token for one path or query is not reused for another URL on the same host. `namzu mcp logout <name>` removes the saved credential for the server URL currently selected by config. These two commands do not edit the server declaration. An HTTP server with a configured `Authorization` header already has an explicit credential; remove that header before OAuth login. Stdio servers do not use this flow.

Ordinary tool calls attach or refresh a previously saved credential without opening a browser. If a new browser authorization is needed, the server fails with a reason directing you to `namzu mcp login <name>`; an HTTP 401 or 403 does not trigger a legacy protocol handshake. A configured `Authorization` header takes precedence over any saved OAuth credential. Keep `~/.namzu` private: the OAuth files contain reusable secrets. Changing a server URL does not transfer its old credential; sign in again for the new URL.

A stdio server is always started with `NAMZU_STARTED_BY_SESSION=1` in its environment, whatever `env` says, so a program it runs cannot pass for a person at a terminal (`namzu send` refuses it). For a local command, repeat `--env NAME='${NAME}'` before `--` to hand the server that variable under its own name (or write `inheritEnv` through `add json`). For HTTP, repeat `--header 'Authorization: Bearer ${VARIABLE}'` or `--header 'X-API-Key: ${VARIABLE}'` to read a header value from the operator's environment when the server connects; quote it so the shell passes the reference to Namzu. Literal header values are refused by this command so secrets do not get written into the config file. Credentialed headers and URL queries require HTTPS, except for a loopback endpoint. URL queries are still saved as written in `config.yaml`; every user-config write replaces that file with owner-only permissions, including when it previously had broader permissions. `list` and `get` show only an HTTP server's origin, omitting its path, query and fragment because tokenized endpoint paths may contain secrets. They also hide header values, environment values and command arguments; `--format json` gives the same redacted fields as structured output.

`list` and `get` read the **user** file; `add` and `remove` change the user file or, with `--scope project`, `.mcp.json`. A project's `namzu.config.json`, selected profile or managed config can override that file under the normal config precedence. `login` and `logout` use the effective entry but do not edit any config file.

Tool names used to start `mcp_<name>_<tool>`. At startup the CLI logs one warning for each configured permission rule still using that form, with the old rule in `namzu.permission.tool_name`. Headless JSON mode emits this warning as a structured stderr log record. Update it to the corresponding `mcp__<name>__<tool>` name; the old rule will not match the new tool.

### Serve Namzu's tools to another program

`namzu mcp serve` runs Namzu's built-in tools (`read`, `write`, `edit`, `glob`, `grep` and `bash`) as a tool server on standard input and output, so another program that speaks MCP can use them: it sends `initialize`, `tools/list` and `tools/call`, one JSON message per line. Nothing but protocol goes to standard output. The working directory is the folder the command runs in, which must be trusted (`--trust` accepts it for this run only). Tools that need a running conversation (`job`, `wait_for_job`, `verify_outputs`) are not served.

Your permission rules apply to every call, as they do in a conversation: layers from the user, project, local and managed files, and the dangerous-command floor.

- A `deny` rule always wins. A tool a rule refuses by name is not listed.
- A call a rule allows (or that only reads) runs.
- A call that would need your approval is **refused**, because there is nobody on this channel to ask. The reply is an error result that names the rule to add, for example `--allowed-tools "bash(git status *)"` or `permissions.write = "allow"`.
- A rule that says `ask` is refused the same way in every mode.

The launch flags are the ones the other launches take: `--allowed-tools <list>` and `--disallowed-tools <list>` add allow and deny rules for this run (a deny still wins), `--add-dir <path>` lets the file tools reach another folder (repeatable), and `--permission-mode <mode>` decides what is left. With no mode, nothing that needs approval runs. `accept-edits` approves `edit` and `write`; `bypass` approves every call no rule asked about; `plan` runs only tools that read; `auto` and `strict` approve nothing here (there is no classifier model on this channel). A mode never reopens a `deny`.

```sh
namzu mcp serve --allowed-tools "read glob grep bash(git status *)"
```

### Test the effective server

Run `namzu mcp test <name>` to check the server a new session would actually use.
It resolves the selected profile, project and managed overrides, connects only
that named server, lists its available tools, then closes the connection. It
makes no model request and does not invoke any server tool. For an HTTP server
with OAuth, the test reuses a saved grant or tells you to run
`namzu mcp login <name>`; it never opens an authorization page itself. A stdio
test starts the configured command. The working directory must already be
trusted; `--trust` accepts it for this test only, without recording permanent
trust.

The result reports `connected` or `unavailable`, transport (`stdio` or `http`),
and `toolCount`: the number of admitted server tools and prompts. It reports
deferred resource helper definitions separately as `resourceHelperCount`; two
helpers do not establish that the server published any resources. A connected
server with zero server tools or prompts succeeds and carries a warning. A
connection, discovery or configuration failure
returns a nonzero exit code with a named, bounded reason. `--format json` and
`--format yaml` expose the same fields. Neither output includes the endpoint URL,
command arguments, header values, environment values or untrusted server error
body. A failure that cannot be classified safely asks you to inspect the server
logs instead of printing its raw error.
The HTTP 401 hint uses the literal `<name>` placeholder; supply the server
name as an argument rather than copying a configured name into a shell command.

```sh
namzu mcp test tickets
namzu --profile work --format json mcp test tickets --trust
```

## Share servers with the project

A `.mcp.json` at the root of a project declares servers for everyone who works in it:

```json
{ "mcpServers": { "tickets": { "command": "node", "args": ["tickets.js"] } } }
```

It is read exactly when `namzu.config.json` is, which is after you have trusted the folder, and trusting a folder is not approving what a file in it launches. A server from `.mcp.json` starts only after you approve that server in that folder. The trust screen lists the servers the file declares, each with the command it runs or the address it reaches (never its environment values or headers), and accepting it approves exactly the entries shown: a file rewritten while the screen was open leaves the changed entry waiting; for a folder you already trust, or a server added or changed later, Namzu says at start that servers are waiting and does not start them until `namzu mcp approve [name...]` (all waiting servers when no name is given) records your answer. An approval is tied to the whole entry, so a changed command, argument, environment variable or URL asks again. Answers are kept in `mcp-approvals.json` in the Namzu home directory; a file there that cannot be read approves nothing and is never replaced, until `namzu mcp approve --new-list` starts a new list, keeping the old file in `backups/mcp-approvals.json.corrupted.<epoch ms>` (see [Session storage](session-storage.md#state-files-several-processes-change)). `namzu mcp remove` also cuts the removed server, and the headers and environment it held, out of every recovery copy of `config.yaml`. `namzu exec` starts only approved servers too, and prints one line on stderr naming the servers that are waiting (a `notice` event with `--json`); `--trust` trusts the folder for one run but does not approve its servers, so approve them first or name the file with `--mcp-config`, which you choose yourself and needs no approval. A server that `namzu.config.json` also names keeps the config entry; the rest are added. A `type` key (`stdio`, `http`) is accepted and ignored, because the entry's `command` or `url` already says which it is; servers that need Server-Sent Events are not supported. A file that is not valid JSON stops the start with its name. `${VAR:-default}` and variables outside `env` and `headers` are not expanded, as in the config.

`mcpServers` is replaced as a whole by the highest layer that sets it, not merged by name: a project's `.mcp.json` (or `namzu.config.json`) table hides servers you declared in `~/.namzu/config.yaml`. Repeat a server in the project file if you want it there too.

For one run, `namzu exec --mcp-config <file>` (also with `--json`) adds the servers in that file, which has the same shape. The option repeats; a later file wins over an earlier one and over the config for a server of the same name. A missing or unreadable file stops the run with a usage error naming it. A value that starts with `{` is the JSON itself, and `--strict-mcp-config` uses only the servers given this way. The interactive `namzu` and `namzu resume` take both options too ([Launch flags](launch-flags.md#--mcp-config-and---strict-mcp-config)).

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
| `connectTimeoutMs` | both | How long this server has to connect, hand shake and list its tools. Default 10,000 ms. Must be a positive number no greater than 2,147,483,647 ms, Node's maximum timer delay; anything else is refused with a reason. |
| `requestTimeoutMs` | both | Deadline for each MCP round trip, including prompt/resource discovery and reads. Unset preserves the SDK's 30,000 ms default. Must be finite and positive, no greater than 2,147,483,647 ms; invalid values fail this server by name. Independent of the startup `connectTimeoutMs`. |
| `eraProbeTimeoutMs` | both | How long this server's era probe — see below — waits for an answer, in milliseconds. Defaults to the SDK's own `2000`, clamped to `connectTimeoutMs`. Must be a positive number; anything else is refused with a reason. |
| `resetTimeoutOnProgress` | both | `true` makes `requestTimeoutMs` an idle deadline for a tool call whose server reports progress: each progress report whose value rose restarts it for that call, so a server that works for a minute and reports throughout is not cut off at `requestTimeoutMs`. Default `false`, which keeps one fixed deadline per request. Only tool calls are extended; every other request keeps the fixed deadline. Anything but `true` or `false` fails this server by name. |
| `maxTotalTimeoutMs` | both | The most a progress-extended call may take in total, in milliseconds, counted from when the call was issued. Progress never extends it. A positive whole number, no greater than 2,147,483,647 and not below this server's `requestTimeoutMs`; anything else fails this server by name. Validated even when `resetTimeoutOnProgress` is off, but used only with it. Default ten times the request deadline, 300,000 ms (5 minutes) at the default 30,000 ms. A call that stops reporting fails after `requestTimeoutMs` of silence ("timed out after N ms with no progress"); one that never stops fails at the cap ("timed out at its total limit of N ms"). Either way the server is sent a cancellation. With `resetTimeoutOnProgress` on, the server's tools also carry a turn deadline of this cap plus 5 seconds, so the 120-second default tool deadline does not cut the call first. |
| `allow`, `deny` | both | Lists of server-reported tool, prompt or resource names, before the `mcp__` prefix. `deny` wins over `allow`; malformed lists fail that server by name. |
| `maxRetries` | both | Nonnegative integer retry budget for calls the SDK classifies as safe to repeat. Unset leaves the SDK default. |
| `requireApproval` | both | `true` asks for approval on every tool this server contributes, including prompts and resources. Default `false`. |
| `readOnlyHintTrusted` | both | `true` lets this server's read-only annotations count as trusted for review exemptions. Default `false`. Set only for a server whose claims the operator trusts. |
| `alwaysLoad` | both | `true` sends this server's tools to the model in full on every request. Default `false`: the model sees each tool's name and loads the full definition with `search_tools` before it calls one (see below). Set it for a small server whose tools nearly every turn uses. Anything but `true` or `false` fails this server by name. |
| `skills` | both | `true` offers the skills this server publishes (see [Skills from a server](#skills-from-a-server)). Default `false`: off for every server until you set it. Anything but `true` or `false` fails this server by name. |
| `instructions` | both | `true` includes this server's initialization instructions as labelled, untrusted request context for the model. Default `false`. They never become operator or system instructions. |

An entry names a command or a URL, never both. One that names both is refused rather than guessed at, because picking either would run something the operator did not mean to run.

## Permissions by server source

The CLI assigns every server a source id, `mcp:<name>`. A `[permissions.sources]` table can decide all calls from a server, including its tools, prompts and resource tools, without following individual tool names:

```json
{
  "permissions": {
    "sources": {
      "mcp:github": "ask",
      "mcp:untrusted-*": "deny"
    }
  }
}
```

Each value is `allow`, `ask` or `deny`. `*` matches any characters in a source id, including `/` for plugin-owned servers such as `plugin:acme/mcp:db`. Source denials run first. A tool-specific denial still wins over a source `ask`; otherwise `ask` runs before tool-name allowances. Source allowances run after tool-name rules. An unreadable source entry is reported as a permission diagnostic. The source id comes from the host's toolset, not from server-authored metadata.

## Skills from a server

A server can publish skills: instructions the model reads when a task matches, the same idea as [a skill in a folder](skills.md), but kept on the server. **This is off for every server.** A server's skills are text the server wrote, so each one is opted in by name:

```json
{
  "mcpServers": {
    "tickets": { "command": "node", "args": ["tickets-server.js"], "skills": true }
  }
}
```

What a server must offer: it must declare the `io.modelcontextprotocol/skills` extension, speak the 2026-07-28 revision, answer `skills/list` (paged with a cursor) with one entry per skill, and serve each `SKILL.md` through `resources/read`. An entry names the `SKILL.md` address (`.../<name>/SKILL.md`, the last folder being the skill's name), its frontmatter (`name` equal to that folder, and a `description`), and a list of its files with each file's size and `sha256:` digest. A server that does not declare the extension, a connection on an older revision, or a server that answers "method not found" simply offers no skills: nothing is asked of it, nothing is reported as wrong. Namzu declares the extension on a request only when the server is opted in and the server declared it.

What you see: each skill is `server:skill` (`tickets:triage`) in the model's list of skills, in the `/` menu (type `/tickets:`) and through the `skill` tool, listed after your own skills under the same size limit and with the same 1,536-character description cap, so a long server list cannot push your skills out. A skill's text is read from the server only when it is used, checked against the size and digest the server listed and against the listed `name` and `description`, and handed to the model labelled as the server's text. A body that no longer matches is refused ("invoke the skill again" when the server changed it after listing, and the list is read again).

What is never taken from a server's skill: `allowed-tools`, `hooks`, `shell`, `model`, `agent`, `effort`, `background`, `paths`, `context` and `invocation` in its frontmatter are ignored, however they are spelled. Only the description and the author's `when_to_use`, `license` and `compatibility` are kept. A server's skill cannot pre-approve a tool, attach a hook, choose a model or run as another agent, and its body is never run as commands: it is only read. A tool it names stays under your permission rules.

Names. Two skills on one server with the same name get their directory path (`tickets:team/review`, then `tickets:tickets/team/review`); a name nothing can make unique is dropped. A server never takes a name another skill holds: a skill of yours with the same full name wins and the server's is left out, with a line in the log. A server whose name holds `$`, `:`, a quote, an angle bracket or a control or hidden character gets no skills (its tools still work); rename it. A listing is capped at 100 skills per server, 20 pages, 512 KiB of listing, 512 files and 16 MiB per skill and 1 MiB for `SKILL.md`; entries past a cap, with a bad name or address, a `$` in the address, a file list that does not include `SKILL.md`, or `"dynamic"` file lists (nothing to check a body against) are skipped. One line says how many were not loaded and the reason codes; the log has the rest.

Permissions. The server's own `deny` list refuses a skill by its name (`audit`, `tickets:audit` or its address), as it does a tool. A server with `requireApproval` offers no skills, as it offers no prompts or resources to a mention: there is nothing to ask before the text reaches the model. A rule on the `skill` tool decides a skill by its full name: `Skill(tickets:triage)` or `Skill(tickets:*)` in `permissions.deny`, or `skill = { "tickets:*" = "deny" }` in a table.

Refresh. The list is read when the server connects, again on every reconnect, and when the server sends a prompts or resources `list_changed` notification (a server that announces neither is read at connect and reconnect only). A refresh that fails keeps the previous list.

Switches. Two keys turn the feature off whatever a server says. `disableMcpSkills: true` in your own config file, or in the organisation's managed file, makes no server's skills asked for or offered. A project file cannot set it (it is ignored, with a note), and once it is on no later layer turns it off. Settings lists it as "Turn off tool server skills".

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

The default of ten seconds exists for a wedged server: a process that spawns, opens its pipe and never speaks would otherwise hold the whole session open before the first turn, with no error and no failure, just a namzu that does not start. The client's own per-request timeout cannot cover that case. The deadline covers connection and tool discovery together. If an in-flight handshake or discovery settles after the deadline, the CLI closes its late connection and toolsets instead of leaving an unreported server running.

A server whose first spawn is genuinely slow is a different thing. A Python SDK server cold-boots in fifteen to twenty seconds on some machines, and under that default it is a working server the CLI refuses, so a headless `namzu exec` that depends on it stops before its first model call with `server "name" did not answer within 10000ms`. `connectTimeoutMs` raises the bound for that server alone; the others keep the deadline that protects the session. The value is named in the failure, so a deadline that is still too short says so.

### The era probe

Before it offers the legacy `initialize` handshake, `connect()` asks the server `server/discover` to see whether it speaks the modern MCP era instead. First contact with a given origin (HTTP) or resolved command (stdio) pays one extra round trip for this — cached afterward, so it is spent once per server identity, not once per session. Against a server that answers, modern or legacy, that round trip is the only cost. Against a legacy stdio server old enough to stay silent on a method it has never heard of, the probe instead waits out its own timeout once before falling back — `eraProbeTimeoutMs`, above, which is what to lower for a server known to be that old, so the probe gives up sooner and leaves more of `connectTimeoutMs` for the handshake that will actually answer.

## Writing and connecting servers

If you write a server, put what a tool is for in the first sentence of its description: the model sees each tool's name and the first sentence of its description (see Tool search), and decides from that alone whether to load the rest. Report progress during long work, and set `resetTimeoutOnProgress` for the server so work that is visibly advancing is not cut off by a deadline sized for a silent one.

If you connect a server, its own instructions (for example the order to call its tools in) are read only when `instructions: true` is set for it. They are server-authored text and untrusted, so they are off by default; see `instructions` in the table above.

## Tool search

A server's tools are not sent to the model in full. The model sees each tool's name (and, as labelled untrusted text, the first sentence of its description) and loads the full definition with `search_tools` before it calls one. A server therefore costs the context nothing until the model uses it, however many tools it has. The case this exists for is a server with 207 tools, which come to about 792,000 characters: more than a 200,000-token window holds, so before tool search the first message failed with "This conversation is too long for the model", which no compaction could fix.

Two ways to keep a server's tools inline instead: set `alwaysLoad: true` on its entry (above), which suits a small server the model uses in nearly every turn; or start the session with `toolLoading: 'eager'` for the built-in tools, which does not change MCP servers.

The model loads tools with `search_tools` in three forms: `select:name1,name2` loads exactly those tools (an MCP tool by its full name `mcp__server__tool` or by its short name `tool`, which loads that tool from every server that has one), plain keywords rank the tools whose *name* has the word far above those whose description has it, and `+word` requires a word in the result. A query that is exactly one tool's name loads that tool and no other match, plus any companions it declares.

Once the model has loaded a tool, it stays loaded for the rest of the conversation, **including after compaction**: the compaction summary carries the list of loaded tools (`revealedTools`), and the message after it names them. A server's resource tools (`list_resources`, `read_resource`) are deferred in the same way.

A server that connects, or adds tools, after a turn has begun is announced in the conversation by name: one entry, `Recorded context ... tools-changed`, lists the new tools and how to load them, and names a tool that went away. Its descriptions are not repeated there.

> **Upgrading.** Before this, a server's tools were deferred only when all servers' definitions together reached 10% of the turn's context window, and sent in full otherwise. That size rule is gone. To keep the old behaviour for a server, set `alwaysLoad: true` on it.

## When servers connect

The interactive session does not wait for tool servers. The composer is ready at once, and the servers are reached in the background, in parallel: servers that start a child process three at a time, remote ones twenty at a time, each still bounded by its own `connectTimeoutMs`. A server that does not answer costs the others nothing. Each server gets one line when it settles: `Tool server tickets · 4 tools`, or `Tool server docs is not available. It did not answer in time.`. Its tools join the session at the next turn; a message sent before then simply does not have them yet. `/mcp` shows `name: connecting…` for a server still being reached. Closing the session while a server is still connecting stops it and its child process; a server that finishes connecting after the session closed is closed too, and its tools are never mounted. `/mcp` starts with `Tool servers: 2 connected` and adds `, 1 unavailable` or `, 1 connecting` only when there is one; a server with one tool shows `1 tool`.

A headless run (`namzu exec`, `--output-format json`, a scheduled job, the agent protocol server) still waits for every server before its first model call, because nobody is there to read a line that arrives later.

## When a server asks you for input

A server that speaks the earlier protocol revision can ask you to fill in a
short form (a name, a number, a yes or no, one or several choices). In an
interactive session each field appears as a question on the same card the
model's own questions use, led by the server's name and what it asks for, and
a field marked optional says so. A value that does not fit the field (a
number outside its range, a text that is not an email, a missing required
answer) is asked again with the reason. Skipping the card tells the server you
declined; closing the turn tells it you cancelled. A form with more than eight
fields, or one with nested objects, is declined without showing anything.
Headless runs (`exec`) never tell servers they may ask, and a request from a
server in the newer revision is not answered. Asking you to open a link is not
supported.

## When a server does not work

Each failure becomes an entry with a reason: the command could not be spawned, the spec named neither a command nor a URL, the handshake did not answer in time, `connectTimeoutMs` or `eraProbeTimeoutMs` was not a positive number, or a known field such as `args`, `env`, `inheritEnv` or `headers` had the wrong shape. A malformed entry cannot stop a different configured server from connecting or prevent an earlier connection from being closed. What is done about a failure differs by surface. A person in the interactive session sees the line, in plain words (a timeout reads "It did not answer in time."), and fixes the config. A headless `exec` has nobody to read it, so it refuses to start rather than let the model work without tools it was promised — the hazard this module exists to prevent is the operator who watches the agent struggle and concludes the model is bad at the task.

A stdio server is a child process. The session owns its shutdown: closing the session closes every connected server, bounded at two seconds each, so a one-shot `namzu exec` leaves nothing behind.

`/mcp tools` shows the current names and any instructions the server supplied during initialization. It also shows names added or removed after discovery, changed tool definitions held at their earlier version, and current allow/deny refusals for tools, prompts and resources. Instructions are server-authored text, displayed as such; they do not change the host's authorization rules. With `instructions: true`, the current text reaches the model inside an untrusted envelope tagged with the server name, sent as a hidden reminder the first time and again only for a server whose text changed (a server that stops supplying text is reported as no longer applying), not in every request. A disconnected server contributes nothing until it reconnects. The two resource tools are deferred until discovered by name. Closing the session stops reconnect attempts before disconnecting transports.


## Select a prompt or attach a resource

In an idle interactive session, `/mcp prompts [server]` lists admitted prompts
and their required/optional arguments. Run one explicitly with
`/mcp prompt <server> <name> [argument=value ...]`. Arguments are strings;
missing required values, undeclared names, duplicate names and tokens without
`=` are refused before `prompts/get`. Values may contain `=` but not whitespace:
these commands use the existing whitespace-separated slash arguments, not shell
quoting. The prompt is fetched only for that invocation; it does not become a
new system prompt or change the tool catalogue.

`/mcp resources [server]` lists the same published resources the `@` picker uses.
`/mcp resource <server> <uri>` attaches the text of one listed resource. It cannot
fetch an arbitrary URL, unlisted URI, resource template, image or binary blob.
The existing `@server:uri` picker/mention path uses the same resource registry
and permission boundary. Background picker discovery cannot ask for approval;
use the explicit listing command when discovery needs review.

Discovery and reads check the session's live source, tool-name and exact-input
permission rules. Discovery uses `mcp__<server>__list_resources` and
`mcp__<server>__list_prompts` (a person-facing discovery permission name, not a
new model tool). Prompt fetch uses the existing `mcp_prompt_<server>_<name>`
name; resource reads use `mcp__<server>__read_resource` with `{ uri }`. Explicit
denials are not bypassed by a user-invoked command, and an ask still requires the
approval screen even in bypass mode. No reviewer means refusal. Server-specific
allow/deny lists also apply. As with mentions, a server with `requireApproval:
true` is omitted from direct prompt/resource attachment; use its reviewed model
tools instead. A disconnected server contributes nothing.

Server-authored roles remain labels inside untrusted text, never conversation
roles. Fetched text is attached as host context beside the operator's command;
it is not reparsed as a slash command, file mention or composer trigger. Explicit resource attachments and prompt message bodies have a 30,000-character
aggregate body budget before the provenance envelope is rendered. A message's
`@` resource attachments together, including their framing, fit within 30,000
characters and the shared 240,000-character inline context ceiling with file
attachments; at most 32 resource reads are attempted. Unsupported prompt media is
represented by a note, not fetched or attached. Truncation does not cut the
closing provenance delimiter. Framing identifies the source; it is not a claim
that prompt injection has been prevented. Server errors are withheld rather
than printing arbitrary remote error bodies.

## Bounded MCP results

CLI-mounted MCP tools keep their live definitions, source, approval flags and
existing deferral behavior. Each carries a 30,000-character cap for what the
model is shown (`maxOutputChars` on the tool). The trigger is the length of the
result's text: a result whose text is 30,000 characters or fewer, with
structured and rich fields that also fit, is passed on as it is. A result over it
is not cut and forgotten: the complete text, which the connector has already
framed once as untrusted server output (and which is framed here only if it was
not), is saved in the session's own `tool-results` folder (readable by its owner
only, removed with the session) after the turn's result screens have run. The
model is shown the first and last parts of the text, within the 30,000
characters, plus the file's path, and opens any slice of it with `read` (`offset`
and `limit`). Both the preview and the file carry the untrusted framing. A
session with no folder to write to (an in-memory one) shows the head-and-tail
preview alone, and a failed write says so in the preview instead of naming a
file. Secondary fields (structured data and rich media) of an oversized result
are still omitted so they cannot carry the payload through a second channel, and
a line before the text says so. Error text is separately bounded to 1,000
characters. Success or failure is preserved.

The file holds whatever the result screens leave. A value a screen redacts is not
in the file; a secret no screen recognises is, in clear, readable by the owner of
the session folder. There is no per-server setting that keeps a server's output
out of the file, so a server whose results can carry secrets the screens do not
cover should not be mounted.

These are bounds at the CLI result/attachment boundary, not transport byte or
server-memory limits: a response has already been decoded by the SDK when the
CLI applies them. `requestTimeoutMs` bounds each round trip, not the sum of a
paged listing, retries, or a whole composed prompt selection. Elicitation hooks
and URL-based elicitation are outside these prompt/resource commands.

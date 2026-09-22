---
type: Reference
title: Tool-result screens
description: The toolResultScreens config key — which screens judge a tool result, the empty list that turns the default off, and the per-screen passthroughTools exception.
resource: packages/cli/src/config/tool-result-screens.ts
tags: [cli, config, tools, security]
status: stable
generated: { by: process:claude-code, at: 2026-09-18T00:00:00Z }
---

# Tool-result screens

A tool result is judged before the model reads it. The kernel installs one
screen by default — a result framed as untrusted that restates the request is
refused — and `toolResultScreens` is how an operator says otherwise.

```json
{ "toolResultScreens": ["injection", "correspondence"] }
```

## Three answers, not two

| Key | What runs |
| --- | --- |
| absent | The kernel's default: the correspondence screen, scoped to results framed as untrusted. |
| `[]` | No screens at all. This is the off switch. |
| `["correspondence"]`, `["injection"]`, both | Exactly those screens, in the order written. |

Absent and `[]` are different answers on purpose. A screen can refuse a result,
so an unconfigured session and one whose operator turned screening off must not
mean the same thing — collapsing them would make the key's absence silently mean
the opposite of what a reader of the file expects.

The names are `correspondence` and `injection`; an unknown one is refused as an
invalid config value rather than ignored, because a screen that is silently not
installed is worse than one that was never asked for.

## The per-tool exception

The correspondence screen refuses a result that IS the request, which is a true
signal and also a description of what a normaliser, a validator, a search that
repeats its query when it found nothing, and a redirect-stub fetch legitimately
return. An entry may be written as an object carrying that screen's options, so
the exception lives in the same file as the screen:

```json
{
  "toolResultScreens": [
    "injection",
    { "name": "correspondence", "passthroughTools": ["mcp_weather-co_lookup", "exa:web_search_exa"] }
  ]
}
```

The option sits with the screen because it is the screen's: a second screen's
options are a second entry, and an options object can never be attached to a
screen that was not installed — the entry that carries it is the entry that
installs it. An option the named screen does not read (`passthroughTools` on
`injection`) is refused rather than carried, for the same reason an unknown
screen name is: a value that parses, installs and changes nothing reads to an
operator as a control that is in force.

**A tool answers to several names, and each registration shape has its own
set.** `mcp_weather-co_lookup` (a server connected directly) also answers to
`weather-co:lookup` and the server's own `lookup`;
`myplugin__mcp__weather__lookup` (a server a plugin contributes) answers to
`weather:lookup` and `lookup`, but NOT to `mcp_weather_lookup`. The rule is
implemented once, as `passthroughToolNames` in the SDK.

**A name that matches no tool is said out loud.** The session reports it on
`configNotices`, which the TUI, `exec` in either mode and the resident step all
print:

```
toolResultScreens: "mcp_weather_co_lookup" names no tool this session mounts, so it exempts nothing.
```

Without that line the failure is silent in the worst way: the config parses,
the screen installs, the operator believes a tool is exempt, and the refusal
they were trying to stop comes back with nothing to explain it.

## Where it takes effect

Every registry this CLI builds for a session: the interactive session and its
sub-agents, headless `exec` in either mode, ACP, and the resident step. It is
configured at registry construction rather than per turn, so all of them get it
from one place — and the interactive session reaches it the same way the others
do, through the `TuiContext` the App holds.

A registry the CLI built with a screen list is authoritative for its own
results. The kernel's default applies where nothing was configured, which is
what an absent key leaves in place. A sub-agent is a fresh child session with its own
registry, and this CLI builds that registry with the same screens.

## What the default refuses, and what it does not

The correspondence screen refuses a result that IS the request — a server or a
tool answering a call with the text of the call. It deliberately leaves alone:

- **This process's own unframed tools.** `web_fetch` returns a page body, and a
  page whose body is the URL it was fetched from is a true result from a
  working tool. The scope is the untrusted FRAME rather than who mounted the
  tool, so a host tool that frames its own result — the CLI's own remote Exa
  search does — is judged, and one that frames nothing is not.
- **An empty result**, a **failed call**, and a result that is not a string.
- **A tool the operator named** in `passthroughTools`, which is the exception
  above. Refusing the rest is the point: a screen that is switched off protects
  nothing, which is why a working exception exists rather than the alternative.

See [tool-result screening](../sdk/tool-result-screening.md) for the screens
themselves.

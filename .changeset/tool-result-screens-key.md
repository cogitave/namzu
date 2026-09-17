---
"@namzu/cli": major
---

Tool results are screened by default, and `toolResultScreens` is how an operator changes that — including a per-tool exception

A stream that connects a tool server can have a result refused before the model reads it: an answer that IS the request — the tool handed back the call instead of an answer to it — fails the call with the reason in place of the output. On a project that connects servers whose tools echo their arguments, that is a visible change to a run, which is why this is a major and not a minor.

**Keep the old behaviour with one key:**

```json
{ "toolResultScreens": [] }
```

The key has three answers rather than two. Absent runs the kernel's default; `[]` runs nothing; `["injection"]`, `["correspondence"]` or both run exactly those, in the order written. Absent and `[]` are kept apart on purpose — a screen can refuse a result, so an unconfigured run and a run whose operator turned screening off must not mean the same thing. An unknown screen name is refused as an invalid config value rather than ignored, so a typo cannot silently leave a screen uninstalled.

**The screen stays on by default, and the per-tool exception is a config key.** A legitimate tool answering more broadly than asked is normal — a normaliser, a validator, a search that repeats its query when it found nothing, a fetch whose page body is its own URL — and a screen that refuses those gets switched off, at which point it protects nothing. So an entry in the list may be an object carrying that screen's options, and the exception lives beside the screen:

```json
{
  "toolResultScreens": [
    { "name": "correspondence", "passthroughTools": ["mcp_weather-co_lookup"] }
  ]
}
```

`passthroughTools` names the tools exempt from the correspondence screen, and a tool answers to more than one name — the registered `mcp_weather-co_lookup`, the server's own `lookup`, and `weather-co:lookup` all work; a plugin-contributed `myplugin__mcp__weather__lookup` answers to `lookup` and `weather:lookup` but NOT to `mcp_weather_lookup`. A name that matches no tool this session mounts is reported on launch — `toolResultScreens: "x" names no tool this session mounts, so it exempts nothing` — rather than silently exempting nothing. An option the named screen does not read is refused at load, like every other value in that file.

**What the default does not touch.** This process's own tools that frame nothing: `web_fetch` returns a page body, and a page whose body is the URL it was fetched from is a true result from a working tool, so the correspondence screen judges results carrying the untrusted frame. An empty result, a failed call, and a result that is not a string are left alone as well. The CLI has no key for the screen's own `scope`; a host that wants its unframed tools judged writes SDK code.

**The key now reaches the interactive session.** It reached the headless surfaces — `run`, `run-stream`, `drain`, ACP, the resident step — and was dropped on the way to the TUI, which is the surface most operators use: the App's `TuiContext` did not carry it and `hydrateSession` did not pass it. Every surface named above now applies the operator's answer, and a test drives `runCli` and the App to prove the two hops rather than asserting them.

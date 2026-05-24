---
'@namzu/cli': minor
---

**M3 polish — clawtool-backed onboarding + TUI visual treatment** (`ses_005-credentials-and-tui-polish`)

`namzu` (no args) now starts the right way: it asks **clawtool** what's available instead of demanding a manual provider profile, and the screen actually looks like a product.

**Credentials-first onboarding (no login flow, ever).** First run:

1. Probe `GET /v1/agents` against the local clawtool daemon (auto-spawned via M1's `ensureDaemon`).
2. Render an inline **picker** listing every agent instance clawtool knows about — `claude`, `codex`, `gemini`, `opencode`, `aider`, `hermes`, etc. — each with a `callable` / `bridge-missing` badge.
3. User picks a **default** (handles the direct turn) and ticks any others to keep **active** (for subagent dispatch).
4. Selection persists to `~/.namzu/preferences.json` (mode 0600 — instance names only, **no credentials**; clawtool owns those).
5. Subsequent turns dispatch via `POST /v1/send_message {instance, prompt}` and stream the NDJSON reply into the transcript.

Picker keybindings: ↑/↓ navigate, `space` toggle active, `d` set default (must be `callable`), `enter` accept, `esc` cancel. `bridge-missing` rows show with a hint pointing the user at `clawtool agents claim <instance>`.

**Why this replaces the M3 direct-API path:** clawtool already runs every credential / OAuth / bridge flow on this machine. Detecting env vars + OAuth files in TS would duplicate that and silently diverge. namzu becomes the UX layer over clawtool's authoritative registry. M2's `~/.namzu/providers.json` stays as an escape hatch for raw-API setups but is no longer the front door.

**TUI visual treatment:**

- Banner: `▲ namzu <version> · <provider>` on every render — clear identity moment without giant FIGlet.
- Bordered panels (`borderStyle: 'round'`) around the transcript and composer. Composer border switches to focus color when idle + ready.
- Message bubbles get role glyphs: `▸ you`, `◆ namzu`, `⚠ system` (not just colored labels — glyphs read faster scanning back).
- Streaming spinner: braille frames `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` in front of the pending assistant bubble while `thinking`. 80ms cadence.
- StatusBar: `cwd · provider · model │ state │ hint` with `│` dividers and a state glyph (`● idle`, `◐ thinking`, `◑ tool`, `◓ approve?`).
- Composer prompt glyph: `›` when idle, `…` when disabled.
- Picker: bordered overlay with `[ ]`/`[x]` toggles + `( )`/`(•)` radio + per-row status badge + dim help footer.

**Internals** (`packages/cli/src/integrations/clawtool/`):

- `agents.ts` — `listAgents({callableOnly?})` calls `GET /v1/agents`, returns the typed registry.
- `dispatch.ts` — `sendMessage({instance, prompt, signal?})` POSTs `/v1/send_message`, streams NDJSON via `response.body.getReader()`, normalizes per-family frames (text deltas, Anthropic `content_block_delta`, OpenAI `choices[0].delta.content`, plain-text passthrough) into a small `{kind: 'delta'|'done'|'error'}` event union. Tool-call / tool-result frames are silently dropped here; surfacing them is ses_006.
- `preferences.ts` — `~/.namzu/preferences.json` v1 atomic store with `default + active` invariants. Mode 0600 file / 0700 dir, `crypto.randomBytes`-suffixed temp.
- `daemon.ts` — `ensureDaemon` now honors explicit empty-string token (no-auth daemon) in the fast path; only `undefined` triggers discovery.

`packages/cli/src/tui/`:

- `Picker.tsx` — new; the first-run interactive list.
- `App.tsx` — replaced the M3 Phase-C provider hydration with `probeAgentSession()` (preferences + `/v1/agents`); renders `<Picker>` when first-run, `<Transcript>` + `<Composer>` after.
- `agent.ts` — replaced direct `provider.chatStream()` with the clawtool dispatch path. The `Message[]` parameter is gone; the TUI just hands `send(text)` a string per turn.
- `Transcript.tsx`, `StatusBar.tsx`, `Composer.tsx` — visual polish per the section above.

**Tests**: 20 new unit cases (preferences round-trip + invariants; agents wire shape + Bearer omission for no-auth; dispatch NDJSON parsing across Anthropic / OpenAI / plain-text / error / HTTP-error shapes). Total **150/150** (was 130). React components remain unit-test-free; live smoke against a real clawtool daemon validated the picker → dispatch round-trip.

**Removed**: direct `@namzu/anthropic` provider construction from the TUI agent session (still a workspace dep, kept available for the M2 escape hatch). The M3 Phase-C "TUI chat against a real provider" surface stays — the path is just different now.

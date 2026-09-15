# Zen model-matrix smoke, through the real CLI

Measured 2026-09-15/16 on branch `integration/phase-a`, head `6551d154` (dist
already built; not rebuilt for this run). Reproducer:
`node research/provider-matrix/zen-model-matrix-cli.mjs`. Raw per-model data
is [zen-model-matrix-results.json](zen-model-matrix-results.json).

## What ran

Every model `@namzu/zen`'s `getZenModels('zen')` catalogues (59 models — the
table `--provider zen` resolves against; `getZenModels('go')`, reached only
through `--provider zen-go`, was out of scope and not run) was driven through
the real built binary, one process per model:

```
node packages/cli/dist/bin.js --format json run --trust \
  --provider zen --model <id> --effort low --token-budget 20000 \
  "Create a file named hello.txt containing the word hello, then say done"
```

Each call ran in its own fresh `mkdtemp` working directory (so the file check
can't see a previous model's leftovers) inside one isolated `mkdtemp`
`NAMZU_HOME` shared for the whole run — never the operator's real `~/.namzu`.
Models ran sequentially with a 1.5s pause between them; a `rate_limited`
result would have been retried once after a 60s backoff, and three in a row
would have stopped the run early (`status: "partial"`). Neither triggered:
**the run completed all 59 models, status `completed`.**

Outcome counts:

| Outcome | Count |
|---|---:|
| `no_credential` | 53 |
| `effort_unsupported` | 5 |
| `ok` | 1 |

## Credential: read-only reuse, honestly none to reuse

Zen's API key is not part of Namzu's own `~/.namzu/credentials.json` (that
file only ever holds the Claude/Codex subscription pair — see
`packages/cli/src/integrations/providers/credential-store.ts`). A Zen key
comes from `OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY` in the environment, or
from the co-installed `opencode` CLI's own
`$XDG_DATA_HOME/opencode/auth.json` (default
`~/.local/share/opencode/auth.json`), read by
`packages/cli/src/integrations/providers/harness-credentials.ts`. The
reproducer checks both, read-only, and would copy the auth file byte-for-byte
into this run's isolated `XDG_DATA_HOME` rather than pointing the run at the
real one.

On this machine **neither existed**: no `OPENCODE_API_KEY` /
`OPENCODE_ZEN_API_KEY`, and no `~/.local/share/opencode/auth.json` (the
`opencode` binary itself is installed at `~/.opencode/bin/opencode` 1.18.30,
but has no stored auth). This matches the owner's own Namzu preferences
(`~/.namzu/preferences.json`), whose configured Zen model is
`muse-spark-1.3-contributor-free` — the free, anonymous-access tier. The
owner's own Zen account, reused exactly as configured, **is** anonymous
access; there was nothing else to copy in read-only. This is recorded in
`zen-model-matrix-results.json` under `credential`, not assumed.

## The central finding: `--effort low`, applied uniformly, gates almost the whole matrix locally

This is the fact that explains 58 of the 59 rows, and it is worth stating up
front rather than only in the table.

`ZenProvider` refuses two things **before any network call**, both in
`packages/providers/zen/src/client.ts` / `options.ts`:

1. **No credential + a model that isn't in the driver's explicit anonymous
   allow-list** → an immediate boot-time refusal: `"No credential found for
   Zen with the selected model. Choose muse-spark-1.3-contributor-free for
   public access. Set one of: OPENCODE_API_KEY, OPENCODE_ZEN_API_KEY — or
   pass --provider with one that is configured."` Exit 1, ~510–570ms
   (process boot + discovery only — no request left the process). This hit
   all **53** non-anonymous models.
2. **`--effort low` on a model whose `effortLevels` doesn't list `"low"`** →
   `"Error: zen — the provider rejected the request as invalid: The selected
   model does not advertise this reasoning effort level."` Exit 1,
   ~720–760ms. Of the 6 catalogued models with `supportsAnonymousAccess:
   true`, 5 (`big-pickle`, `mimo-v2.5-free`, `ling-3.0-flash-fin-free`,
   `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`) declare
   `effortLevels: []` and hit this gate. Only
   `muse-spark-1.3-contributor-free` declares `"low"` among its
   `effortLevels`.

Net effect: **with the exact command line specified, only 1 of the 59
catalogued models — `muse-spark-1.3-contributor-free` — ever reaches the
network.** It did, and it worked (`outcome: "ok"`, tool `write` called,
`hello.txt` created containing `hello`, answer `"done"`, exit 0, 6.69s,
17,567 tokens against the 20,000 budget). That is a genuine, real,
end-to-end pass of the default toolset through the live CLI — but it is one
model, not 59. This is not a bug in the harness or the driver: it is the
documented, tested, correct behavior of two independent local gates,
compounded by running every model with the identical flags. **It means this
particular smoke, as specified, verifies the credential gate and the
effort-level gate very thoroughly (59/59, zero anomalies, see below) and
verifies live request/response/tool-call plumbing for exactly one model.**
A matrix that wants live coverage of the other 58 needs a real Zen API key
and, for several models, a `--effort` value drawn from that model's own
`effortLevels` rather than a fixed `low`.

## The two owner-reported failures — status on this build

Commit `6551d154` ("fix(zen): classify upstream failures for big-pickle
correctly"), already the head of this branch, fixed exactly two
classification bugs in `ZenProvider`'s `failure()`:

1. **A transport failure with no HTTP response at all (e.g. `ECONNREFUSED`)
   was fabricating a `502` and getting classified `provider.unavailable`**
   ("the provider is failing on its own side — resume once it recovers")
   instead of `provider.network` ("could not be reached — check
   reachability"). **Fixed.** Verified by re-running
   `packages/providers/zen/src/__tests__/error-taxonomy.test.ts` on this
   exact build: all 7 tests pass, including test (d), the dedicated
   `ECONNREFUSED` regression guard, against a real refused loopback
   connection through the real `@ai-sdk/openai-compatible` client.
2. **A client-side abort/timeout (`DOMException`, which `fetch` rejects
   `AbortSignal` timeouts with) lost its real reason and fell back to the
   generic "The model stream failed."**, because the old fingerprinting read
   only own properties and `DOMException.message`/`.name` are prototype
   accessors. **Fixed.** Same test file, same green run — this was the
   specific shape the fix's own commit message says was reported for
   `big-pickle`.

Both are fixed in this build, confirmed by executing the regression suite
(`pnpm --filter @namzu/zen test -- error-taxonomy`, 7/7 passing) rather than
by reading the diff alone. One honest caveat: **this matrix run did not
itself reproduce either failure path live.** `big-pickle` never reached the
network in this run — as above, the uniform `--effort low` tripped its
*local* `effortLevels: []` gate first, before any transport could fail or
time out. So this run's live evidence is silent on those two paths (neither
confirms nor contradicts the fix); the confirmation above comes from the
committed regression tests exercising the real transport/timeout shapes
directly, on this same commit.

## New findings for the owner (not fixed here — out of scope for this step)

- **Coverage gap, not a bug**: as described above, 53/59 models are
  unreachable from this environment without a real Zen API key, and a
  further 5/59 are unreachable with a uniform `--effort low` because their
  catalogued `effortLevels` is empty. If a real coverage run is wanted, it
  needs (a) a funded/contributor Zen credential and (b) per-model effort
  selection (or omitting `--effort` for models with `effortLevels: []`).
- **No anomalies inside either local-gate group**: all 53 `no_credential`
  rows carry byte-identical error text and a tight 504–569ms latency band;
  all 5 `effort_unsupported` rows carry byte-identical error text and a
  tight 722–761ms band. Nothing here suggests a per-model regression in
  either gate.
- **No new failures observed** in the one model that did go live
  (`muse-spark-1.3-contributor-free`): tool call, file write, and answer all
  landed correctly, well inside the 20,000-token budget, in exit code 0.

## Full per-model table

Columns: whether the model is on the driver's anonymous allow-list;
whether its catalogued `effortLevels` includes `"low"` (the value this
command always passes); the outcome; process exit code; wall latency; whether
a `tool-start` event was observed; whether `hello.txt` existed afterward in
that call's own working directory; reported total tokens (`ok` rows only);
and the first line of the error, where there was one.

| # | Model id | Anon? | effortLevels includes low | Outcome | Exit | Latency (ms) | Tool called | File exists | Tokens | First error line |
|---:|---|:---:|:---:|---|---:|---:|:---:|:---:|---:|---|
| 1 | gpt-6-astra | no | yes | no_credential | 1 | 557 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 2 | gpt-5.6-sol | no | yes | no_credential | 1 | 551 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 3 | gpt-5.6-terra | no | yes | no_credential | 1 | 536 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 4 | gpt-5.6-luna | no | yes | no_credential | 1 | 569 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 5 | gpt-5.5 | no | yes | no_credential | 1 | 530 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 6 | gpt-5.5-pro | no | no | no_credential | 1 | 517 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 7 | gpt-5.4 | no | yes | no_credential | 1 | 518 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 8 | gpt-5.4-pro | no | no | no_credential | 1 | 538 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 9 | gpt-5.4-mini | no | yes | no_credential | 1 | 516 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 10 | gpt-5.4-nano | no | yes | no_credential | 1 | 514 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 11 | gpt-5.3-codex | no | yes | no_credential | 1 | 535 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 12 | gpt-5.3-codex-spark | no | yes | no_credential | 1 | 518 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 13 | gpt-5.2 | no | yes | no_credential | 1 | 557 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 14 | gpt-5.1 | no | yes | no_credential | 1 | 548 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 15 | gpt-5 | no | no | no_credential | 1 | 552 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 16 | gpt-5-nano | no | no | no_credential | 1 | 555 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 17 | claude-fable-5-1 | no | yes | no_credential | 1 | 534 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 18 | claude-fable-5 | no | yes | no_credential | 1 | 533 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 19 | claude-opus-5 | no | yes | no_credential | 1 | 565 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 20 | claude-opus-4-8 | no | yes | no_credential | 1 | 557 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 21 | claude-opus-4-7 | no | yes | no_credential | 1 | 534 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 22 | claude-opus-4-6 | no | yes | no_credential | 1 | 562 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 23 | claude-opus-4-5 | no | yes | no_credential | 1 | 536 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 24 | claude-sonnet-5 | no | yes | no_credential | 1 | 530 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 25 | claude-sonnet-4-6 | no | yes | no_credential | 1 | 538 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 26 | claude-sonnet-4-5 | no | no | no_credential | 1 | 512 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 27 | claude-haiku-4-5 | no | no | no_credential | 1 | 523 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 28 | gemini-3.8-flash | no | yes | no_credential | 1 | 545 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 29 | gemini-3.7-flash | no | yes | no_credential | 1 | 514 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 30 | gemini-3.6-flash | no | yes | no_credential | 1 | 509 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 31 | gemini-3.5-flash | no | yes | no_credential | 1 | 543 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 32 | gemini-3.5-flash-lite | no | yes | no_credential | 1 | 525 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 33 | gemini-3.1-pro | no | yes | no_credential | 1 | 525 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 34 | gemini-3-flash | no | yes | no_credential | 1 | 538 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 35 | grok-4.6 | no | yes | no_credential | 1 | 513 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 36 | grok-4.5 | no | yes | no_credential | 1 | 512 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 37 | grok-build-0.1 | no | no | no_credential | 1 | 555 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 38 | muse-spark-1.3 | no | yes | no_credential | 1 | 517 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 39 | muse-spark-1.2 | no | no | no_credential | 1 | 521 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 40 | qwen3.6-plus | no | no | no_credential | 1 | 549 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 41 | qwen3.5-plus | no | no | no_credential | 1 | 514 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 42 | deepseek-v4-pro | no | no | no_credential | 1 | 529 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 43 | deepseek-v4-flash | no | yes | no_credential | 1 | 530 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 44 | deepseek-v4-flash-vision-exp | no | yes | no_credential | 1 | 523 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 45 | minimax-m3 | no | no | no_credential | 1 | 516 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 46 | minimax-m2.7 | no | no | no_credential | 1 | 553 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 47 | glm-5.3-flash | no | yes | no_credential | 1 | 525 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 48 | glm-5.3 | no | yes | no_credential | 1 | 504 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 49 | glm-5.2 | no | no | no_credential | 1 | 536 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 50 | glm-5.1 | no | no | no_credential | 1 | 522 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 51 | kimi-k2.6 | no | no | no_credential | 1 | 525 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 52 | kimi-k2.7-code | no | no | no_credential | 1 | 547 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 53 | kimi-k3 | no | no | no_credential | 1 | 521 | false | false | — | No credential found for Zen with the selected model. Choose muse-spark-1.3-contributor-fre |
| 54 | big-pickle | yes | no | effort_unsupported | 1 | 722 | false | false | — | Error: zen — the provider rejected the request as invalid: The selected model does not adv |
| 55 | mimo-v2.5-free | yes | no | effort_unsupported | 1 | 761 | false | false | — | Error: zen — the provider rejected the request as invalid: The selected model does not adv |
| 56 | ling-3.0-flash-fin-free | yes | no | effort_unsupported | 1 | 733 | false | false | — | Error: zen — the provider rejected the request as invalid: The selected model does not adv |
| 57 | nemotron-3-ultra-free | yes | no | effort_unsupported | 1 | 751 | false | false | — | Error: zen — the provider rejected the request as invalid: The selected model does not adv |
| 58 | nemotron-3.5-lightning-free | yes | no | effort_unsupported | 1 | 727 | false | false | — | Error: zen — the provider rejected the request as invalid: The selected model does not adv |
| 59 | muse-spark-1.3-contributor-free | yes | yes | ok | 0 | 6690 | true | true | 17567 | — |

(`no_credential` rows: full text is "No credential found for Zen with the
selected model. Choose muse-spark-1.3-contributor-free for public access.
Set one of: OPENCODE_API_KEY, OPENCODE_ZEN_API_KEY — or pass --provider with
one that is configured." `effort_unsupported` rows: full text is "Error: zen
— the provider rejected the request as invalid: The selected model does not
advertise this reasoning effort level." Both truncated above only for table
width; verbatim, per-row text is in the JSON.)

## Reproduction

```bash
node research/provider-matrix/zen-model-matrix-cli.mjs            # full 59-model matrix
node research/provider-matrix/zen-model-matrix-cli.mjs --only <id1,id2>   # a subset, for spot checks
node research/provider-matrix/zen-model-matrix-cli.mjs --limit 3          # first N, for a quick smoke
```

`pnpm install && pnpm -r build` must have already run in the worktree; the
script never rebuilds `dist` itself.

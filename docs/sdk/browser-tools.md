---
type: Reference
title: Browser tools
description: The browser and browser_act tools over a BrowserHost, the canonical URL and origin the gate sees, snapshot framing, structural host errors, and the scheduled-job browser grant.
resource: packages/sdk/src/tools/builtins/browser.ts
tags: [sdk, browser, tools, permissions]
status: draft
generated: { by: human:bahadirarda, at: 2026-09-23T00:00:00Z }
---

# Browser tools

`createBrowserTools(host)` returns two tools over a `BrowserHost`: `browser`, which opens and reads pages, and `browser_act`, which changes them. The SDK owns the model-facing contract, the input canonicalisation and the result framing. A host package owns the engine. Nothing in `@namzu/sdk` drives a browser.

```ts
import {
  type BrowserHost,
  type BrowserPageInfo,
  toolset,
  createBrowserTools,
} from '@namzu/sdk'

const page: BrowserPageInfo = {
  origin: 'https://example.com',
  url: 'https://example.com/',
  title: 'Example',
  tab: 't1',
}

const host: BrowserHost = {
  id: 'my-browser',
  capabilities: { engine: 'local-chromium', headless: true, screenshot: true, upload: false },
  async observe(action) {
    if (action.action === 'snapshot') return { snapshot: { page, text: '- link "More" [ref=e1]' } }
    return { page }
  },
  async act(action) {
    // The contract: compare with the live page BEFORE acting.
    if (action.origin !== page.origin) {
      throw {
        code: 'browser_origin_mismatch',
        expected: action.origin,
        actual: page.origin,
        message: 'page moved',
      }
    }
    return { page }
  },
}

const tools = toolset('browser', createBrowserTools(host))
```

## The two tools

| Tool | Action | Arguments | Read-only |
| --- | --- | --- | --- |
| `browser` | `navigate` | `url`; returns the page's snapshot | no |
| | `back`, `forward`, `reload` | return the page's snapshot | no |
| | `snapshot` | `ref?`, `cursor?`, `view?` (`full`, `interactive`, `reading`, `delta`), `query?`, `role?` | yes |
| | `value` | `ref` | yes |
| | `screenshot` | `ref?`, `fullPage?` | yes |
| | `scroll` | `direction`, `ref?`, `amount?` | yes |
| | `wait_for` | `text?`, `textGone?`, `timeMs?` (at most 30000), `stable?` (one of the four) | yes |
| | `tabs` | `op`: `list`, `select`, `close` (with `tab`), `new` (with `url?`) | `new` is not |
| `browser_act` | `click` | a target (`ref`, or `text`, or `role` with `name`), `doubleClick?` | no |
| | `type` | `ref`, `text`, `submit?`, `keys?`, `clear?`, `append?` | no |
| | `fill_form` | `fields: [{ ref, value }]`, 1 to 20 | no |
| | `select` | `ref`, `values` | no |
| | `press` | `key`, `ref?` | no |
| | `hover` | a target, as for `click` | no, and not destructive |
| | `upload` | `ref`, `path` | no |
| | `dialog` | `accept`, `promptText?` | no |

### Reaching the element

`click` and `hover` take exactly one target form. `ref` is an element of the latest snapshot. `text` is the element's visible text, and `role` with `name` is an ARIA role and its accessible name, for what the snapshot gave no ref (a menu that opens on hover, a control the tree leaves out). A `text` or `role`/`name` target is looked up in the page's main frame among visible elements, as Playwright's own text and role locators do (a substring, case-insensitive; when several match, the exact matches decide). Zero or several matches refuse with `browser_target_unclear`: nothing was done, and the result lists up to eight candidates as role and name. Elements inside another frame are reached by their `f<N>e<M>` refs, not by role or text.

Where a click or hover lands depends on the element. A control (a link, button, field, an element with a control role, a tab stop, an `onclick` or `cursor: pointer`) is hit in its middle, as before. A container is not: the aim goes to its first visible control, else to the box of its own first text, because the middle of a wide section is often empty. A hover menu that opens on `:hover` of a section is opened this way from the section's ref.

`press` without `ref` sends one of Escape, Enter, Tab, Shift+Tab, PageDown, PageUp, Home, End or Space (any case) to the focused element. Before sending, the host reads the focus in every frame, through open shadow roots, and refuses when the focus is on a password or one-time-code field or on a field of a form that holds one (for Enter). A focus on a component whose inside cannot be read (a closed shadow root) refuses Enter and Space only. Any other key needs a `ref`.

`type` sets the value by default (replacing what the field holds). `keys: true` sends real key presses, one every 20 ms, for inputs that react to key events (suggestion lists, key handlers). `append: true` keeps the text and adds after it, `clear: true` empties first (the default; with empty `text` it only clears), and the two do not combine.

Every `browser_act` call carries a required `origin` and an optional `snapshot: true` that returns the page after the action. Not offered: running JavaScript, downloads, cookies and storage, network interception, coordinate clicks, drag and drop, the console.

Both tools are `category: 'network'` with `permissions: ['network_access']`, and neither is concurrency-safe. The network category matters in two places. The shipped presets do not allow a network call by category, except the fully isolated one, which trusts the sandbox's egress to confine it. A browser runs outside the sandbox, so a host must not pair the browser tools with that preset. And `isReviewExempt` never exempts a network tool, so an observe call is reviewed in `prompt` mode unless a rule allows it. `isBrowserCallReadOnly(input)` is the classification the table shows.

The provider-facing schemas are flat objects, one per tool, with `action` as an enum and every field listed, the same shape as `computer_use` and for the same reason: some wires reject a root `anyOf`. The runtime schemas are discriminated unions, so a call missing a field its action needs is refused with a hint before the host is called.

## One spelling per address

`url` and `origin` are canonicalised by the input schema. `ToolManager.prepareExecution` hands the authorization gate and reviewer the schema's output, not the model's text, so a rule is tested against the address the browser loads. `runtime/query/__tests__/browser-site-rules.test.ts` drives the real kernel and gate: `HTTPS://GitHub.com.:443/search?q=a&type=code` is allowed by a rule for `^https://github\.com(?:[/?#]|$)` and the host receives `https://github.com/search?q=a&type=code`.

`canonicalizeBrowserUrl(raw)` returns `{ ok, url, origin }` or `{ ok: false, reason }`:

- The form is the WHATWG serialisation: lowercase scheme and host, punycode for an internationalised host, no default port, percent-encoded host bytes decoded, every IPv4 spelling read as dotted-quad. Trailing dots on the host are removed.
- Only `http:`, `https:` and `about:blank` are accepted by this function, and the host applies it to every address it loads. `file:`, `chrome:`, `devtools:`, `view-source:`, `javascript:`, `data:`, `blob:` and the rest are refused.
- An address with a user name or password is refused. `https://github.com@evil.example/` reads as GitHub to a person.
- Cloud metadata endpoints are refused in every spelling the parser folds into them: `169.254.169.254` (also as `2852039166`, `0xA9FEA9FE`, octal, the short forms and full-width digits), `100.100.100.200`, `fd00:ec2::254`, the IPv6 embeddings of those IPv4 addresses (mapped, compatible, SIIT, NAT64 and 6to4), `metadata.google.internal`, `metadata` and `metadata.goog`.

The metadata check is a floor, not the site policy. A private or loopback address is left to the site rules. A DNS name that resolves to a metadata address (`169.254.169.254.nip.io`) cannot be seen here. The host checks where a navigation actually landed.

`canonicalizeBrowserOrigin(raw)` gives the `scheme://host[:port]` form `browser_act` takes, accepting a trailing `/` and refusing a path, query or fragment. `canonicalizeBrowserSitePattern(raw)` canonicalises a site key an operator or a job writes: `https://github.com`, `https://*.example.com` (one or more labels), `http://localhost:*` (any port). It refuses a bare `*`, a wildcard anywhere else in the host, a wildcard before an IP address, a path and a metadata host. IPv6 hosts cannot be written as site keys. `isCloudMetadataHost(host)` is the floor on its own, for a host checking a landing page.

The tool declares `urlArgument: 'url'` (a new `ToolDefinition` field). An `argument_pattern` rule on a declared URL argument tests the value whole. Without it, the rule reads every argument as a possible command line, and `&`, `;` or `|` in a query string cut the value into segments that an `allow` must all match. See [The review policy](review-policy.md#rules-that-ask).

## Pages the agent wrote

A page the agent wrote opens by its path, so it can look at its own work. `navigate` and `tabs new` take a plain relative or absolute path, a Windows path (`C:\site\index.html`, `C:/site/index.html`) or a `file:` URL (`file:///home/a/site/index.html`, `file:///C:/site/index.html`, `file://localhost/...`). An address with another scheme is a web address, as before.

The browser is never given a `file:` address, because a `file:` page is its own origin: the site rules and the origin check mean nothing for it, and nothing stops it reaching other local files. The tool serves the page instead:

- The path is resolved to a real file inside the session's work folder, a folder added to the session, or Namzu's scratch folder. Links are followed first, so a link that leaves those folders is outside, and `..` is gone before the comparison.
- One read-only server per folder, owned by the tool set, listens on `127.0.0.1` on a random port and answers only under a random token (`http://127.0.0.1:<port>/<token>/site/index.html`). It answers `GET` and `HEAD` for its own `Host` only, resolves every request to a real path inside the folder, and never lists a directory (a folder with an `index.html` serves that page). The page has a real `http:` origin, so relative CSS, images and scripts load, and screenshots, reading and clicking work as on any page. A path that starts with `/` in the page's own HTML is outside the token and is not served.
- Refused, with the reason and what is allowed: a path outside those folders, a link that leaves them, a `.git` folder, a secret file (`.env*` apart from `.env.example`, `.ssh`, `.aws`, `.gnupg`, `.namzu`, `*.pem`, `*.key`, `id_rsa`, `.npmrc`, `credentials.json` and similar), anything the session's read rules deny (`ToolContext.readDenied`, checked for every file the page asks for, not only the first), a file that is missing, a folder with no `index.html`, a network share, and a Windows path on another platform. The same checks run again for each request the server receives, so a link inside the folder that points at a secret file is refused too.
- The server does not keep the process alive. `closeBrowserLocalPages(host)` stops it, the interactive session does that when its browser closes, and a later local page starts a new one with a new token.

The input schema leaves a local path as written, so the gate sees what the model wrote and a rule for web addresses does not match it. The host sees only the `http:` address, and its site rules (`http://127.0.0.1:*`) apply to it like any other. The review that applies to `navigate` still applies.

## What the model reads

A snapshot result starts with a header the tool writes from the host's page info:

```
Page: https://shop.example.com — "Your cart" (tab t1)
```

The origin is re-canonicalised, and a value that is not an origin is shown as `unknown`. The title is page-controlled, so it is quoted, flattened to one line, cut at 120 characters, has hidden characters shown as `<U+XXXX>` and has the envelope's delimiter defanged. Below the header, the snapshot text is wrapped with `wrapUntrusted` (`kind="web-page"`, `origin` attribute). A closing tag inside the page is defanged, and the frame marks provenance but does not refuse anything. At most `BROWSER_SNAPSHOT_MAX_CHARS` (20000) characters come back per call. `capabilities.snapshotMaxChars` can lower it. A host that pages returns `nextCursor`, and the tool tells the model to pass it back. A host that does not page is cut, and the tool says so. `formatBrowserPageHeader(page)` is exported for a host that shows the same line elsewhere.

**Reading less.** A full tree of a big page is the costliest thing a call returns, so `snapshot` has narrower shapes. `view: "delta"` returns only the lines added (`+`) and removed (`-`) since the last snapshot of that tab (a control whose value changed is one line out and one in), or the whole page with a note when there is no earlier one. `view: "interactive"` lists only what a call can act on, one line each, with the address of a link and the nearest named ancestor. `view: "reading"` is the page's text with headings as `#` lines and no refs. `query` and `role` find elements by name or text (case-insensitive) and by ARIA role, at most `BROWSER_FIND_MAX_MATCHES` (20), each with its ref and context (a match with no ref of its own, such as a table cell, is listed with its text and the nearest ref above it), and a note counts the matches: this reaches content a long page or a closed menu keeps out of the tree's way. `value` reads one control's current value and state without a snapshot (a field's text, the chosen option and every option of a select, `checked`, `disabled`, and the like); a password or one-time-code field says its value is hidden.

**What an action did.** Every `browser_act` result starts with `Effect:`, computed by the host from the page's tree before and after the action. The host's sentence (outside the envelope) is `the page address changed`, `N lines appeared and M went`, `a new tab opened (it is not the active tab)` or `no visible change`. When nothing visible changed but the page sent requests, the sentence says so (`no visible change on the page; it sent 1 request.`) and the method and path of the first three (`POST /api/record`, no query string, no fragment, then `(and N more)`) come inside the same envelope, since the site chooses the path; only `fetch`, `xhr` and document requests count, never images, scripts, beacons or other resources. A visible change keeps its sentence and names no requests. A page that was still changing when the wait ended says so. The page's own lines that appeared or went (the first ten, and the first five that went), and the old and new address, come inside a `kind="web-page-change"` envelope, because they are page text. With `snapshot: true` only the sentence is kept, since the whole page follows. `BrowserResult.effect` carries the same as data (`BrowserEffect`, with the optional `requests` and `requestCount` present only for the no-visible-change case); a host that cannot compute it leaves it out and the line is absent. `value` results are framed as `kind="web-page-value"`.

A screenshot comes back as a text block (the header) and an image block. The Namzu Playwright host masks password and one-time-code fields, in every frame and in element screenshots (an ordinary input stays readable, since a search box the model cannot read cannot be checked); closed shadow roots and text rendered elsewhere may remain visible. Another host must provide its own protection. `tabs list` lists each tab's header, with `*` on the active one. A `message` the host returns is shown outside the envelope, so it must be the host's own words, never page text.

## Repeated calls that change nothing

`createBrowserTools` returns tools that share one stall guard, which forgets everything when a new turn starts. Calls that can change what the page shows (`browser_act`, and `browser` `navigate`, `back`, `forward`, `reload` and `tabs` other than `list`) are keyed by tool and every argument. A call is a repeat when the previous identical call changed nothing and nothing changed since: the address and tab, the tab set, and the last whole-page snapshot (a `snapshot` of the full view without `ref`, `cursor`, `query` or `role`, the page a `navigate`, `back`, `forward` or `reload` returned, or `snapshot: true` on an act; a `delta`, `interactive` or `reading` view is not the page) are as the host reported them. The third repeat's result starts with a note, the fifth is refused with `data.code: 'browser_repeated_no_change'` and the last host message or page address, and the host is not called. Twelve counted calls in a row with no change to address, tab set or whole-page snapshot add a second note. Looking and moving the view (`snapshot`, `screenshot`, `wait_for`, `value`, `scroll`, `tabs list`) is never counted, because a scroll's progress is a position the host does not report or refused. The guard reads no clock.

## The host contract

```ts sketch
interface BrowserHost {
  readonly id: string
  readonly capabilities: BrowserCapabilities
  observe(action: BrowserObserveAction, options?: { signal?: AbortSignal }): Promise<BrowserResult>
  act(action: BrowserActAction, options?: { signal?: AbortSignal }): Promise<BrowserResult>
  describeRef?(ref: string): BrowserRefDescription | undefined // sync, from the last snapshot
  session?(): BrowserSessionInfo // sync: { profile?, origin? }
  initialize?(): Promise<void>
  dispose?(): Promise<void>
}
```

- `act` compares `action.origin` with the live origin of the page it is about to act on, immediately before acting, and throws a `browser_origin_mismatch` shape without acting when they differ, unless the site rules put both origins at the level that needs no review (`act`): then it acts on the live page and reports `The page is now at X, not Y` in the result's `message`. That is what binds an approval of "click Place order on shop.example.com" to that site after a redirect.
- `capabilities.unavailableReason` keeps both tools mounted, says why in their descriptions and refuses every call with it. `screenshot: false`, `upload: false` and `supportedActions` remove actions from the model schema and refuse them before the host is called.
- `upload` paths are resolved by the tool against the turn's roots, following links, as the file tools resolve them (`pathArgument: 'path'`, so a path outside the roots becomes a review where the host enables that). The host receives the resolved absolute path.

The host refuses by throwing a value with one of these shapes. The tool recognises them by shape (`browserHostErrorOf`), so the host and the SDK need not share a class. Anything else becomes an ordinary `browser failed: …` result.

| `code` | Fields | What the model is told |
| --- | --- | --- |
| `browser_origin_mismatch` | `expected`, `actual` | Nothing was done; take a snapshot. |
| `browser_stale_ref` | `ref` | The ref is from an older snapshot; take a new one. |
| `browser_human_required` | `reason` (`sign-in`, `two-factor`, `captcha`, `bot-block`, `http-auth`, `credential-field`), `origin`, `profile?`, `loginCommand?` | Stop and tell the user; never sign in, solve it or type a password or code. The result's `data.handoff` is `{ kind: 'human-required', reason, detail: { origin, profile?, loginCommand? } }`, and its [`handoff`](tool-handoff.md) (`reason` in words, `detail` with `tool: 'browser'`, `cause` and the same fields) pauses the turn before the next model call. |
| `browser_outcome_unknown` | `action`, `outcome: 'unknown'`, `retrySafety: 'unsafe'` | The host's message; do not replay. |
| `browser_no_effect` | `action`, `outcome: 'unchanged'`, `retrySafety: 'once-after-snapshot'` | The action stopped before it touched the page (covered, hidden, disabled, still moving, or a timeout whose log never reached the input step). Nothing changed; one retry after a fresh snapshot is safe. |
| `browser_target_unclear` | `wanted`, `matches`, `candidates: [{ role, name }]` | A text or role/name target matched none or several; nothing was done; name one candidate more exactly or use a ref. |
| `browser_site_denied` | `origin` | Not allowed by the site rules; do not retry. |

Each shape also carries a non-empty `message`.

For `http-auth`, the tool says "HTTP authentication challenge" rather than assuming the response opened a browser password dialog. A 401 or 407 without a matching challenge header is an ordinary failed tool result from `@namzu/browser`, with its HTTP status and no human handoff.

## Labels a person approves

`presentCall` resolves refs through `host.describeRef` and names the origin and profile: `Click button "Place order" · https://shop.example.com · profile work`, `Type "shoes" into textbox "Search" and submit · …`, `Open https://github.com/ · profile work`. An unknown ref is shown as `element e9`. Typed text and page-controlled names have hidden characters made visible. A `describeRef` or `session` that throws is ignored.

## The scheduled-job grant

`ScheduleJobDraft.permissions.browser` (`ScheduleBrowserGrant`) is the shape a `schedule` tool proposal carries: `{ profile, sites: { '<site>': 'read' | 'ask' | 'act' }, headed? }`. `read` opens and reads a site, `ask` parks each change for the operator, and `act` changes pages without asking. Unlisted sites are denied, and there is no `*` key. The tool:

- refuses the block unless the host sets `ScheduleToolHost.browserGrants: true`, so a host that cannot store the grant never confirms a job the model believes can browse;
- canonicalises every site key with `canonicalizeBrowserSitePattern`, and refuses an empty map, `*` and one site named twice at different levels;
- counts the grant as network access, so it is refused beside a shell on the host, like `web_fetch`;
- accepts a browser grant as a permission set on its own (a preset, rules or a browser grant is required).

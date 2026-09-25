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
| `browser` | `navigate` | `url` | no |
| | `back`, `forward`, `reload` | | no |
| | `snapshot` | `ref?`, `cursor?` | yes |
| | `screenshot` | `ref?`, `fullPage?` | yes |
| | `scroll` | `direction`, `ref?`, `amount?` | yes |
| | `wait_for` | `text?`, `textGone?`, `timeMs?` (at most 30000; one of the three) | yes |
| | `tabs` | `op`: `list`, `select`, `close` (with `tab`), `new` (with `url?`) | `new` is not |
| `browser_act` | `click` | `ref`, `doubleClick?` | no |
| | `type` | `ref`, `text`, `submit?` | no |
| | `fill_form` | `fields: [{ ref, value }]`, 1 to 20 | no |
| | `select` | `ref`, `values` | no |
| | `press` | `key`, `ref?` | no |
| | `hover` | `ref` | no, and not destructive |
| | `upload` | `ref`, `path` | no |
| | `dialog` | `accept`, `promptText?` | no |

Every `browser_act` call carries a required `origin` and an optional `snapshot: true` that returns the page after the action. Not offered: running JavaScript, downloads, cookies and storage, network interception, coordinate clicks, drag and drop, the console.

Both tools are `category: 'network'` with `permissions: ['network_access']`, and neither is concurrency-safe. The network category matters in two places. The shipped presets do not allow a network call by category, except the fully isolated one, which trusts the sandbox's egress to confine it. A browser runs outside the sandbox, so a host must not pair the browser tools with that preset. And `isReviewExempt` never exempts a network tool, so an observe call is reviewed in `prompt` mode unless a rule allows it. `isBrowserCallReadOnly(input)` is the classification the table shows.

The provider-facing schemas are flat objects, one per tool, with `action` as an enum and every field listed, the same shape as `computer_use` and for the same reason: some wires reject a root `anyOf`. The runtime schemas are discriminated unions, so a call missing a field its action needs is refused with a hint before the host is called.

## One spelling per address

`url` and `origin` are canonicalised by the input schema. `ToolManager.prepareExecution` hands the authorization gate and reviewer the schema's output, not the model's text, so a rule is tested against the address the browser loads. `runtime/query/__tests__/browser-site-rules.test.ts` drives the real kernel and gate: `HTTPS://GitHub.com.:443/search?q=a&type=code` is allowed by a rule for `^https://github\.com(?:[/?#]|$)` and the host receives `https://github.com/search?q=a&type=code`.

`canonicalizeBrowserUrl(raw)` returns `{ ok, url, origin }` or `{ ok: false, reason }`:

- The form is the WHATWG serialisation: lowercase scheme and host, punycode for an internationalised host, no default port, percent-encoded host bytes decoded, every IPv4 spelling read as dotted-quad. Trailing dots on the host are removed.
- Only `http:`, `https:` and `about:blank` are accepted. `file:`, `chrome:`, `devtools:`, `view-source:`, `javascript:`, `data:`, `blob:` and the rest are refused.
- An address with a user name or password is refused. `https://github.com@evil.example/` reads as GitHub to a person.
- Cloud metadata endpoints are refused in every spelling the parser folds into them: `169.254.169.254` (also as `2852039166`, `0xA9FEA9FE`, octal, the short forms and full-width digits), `100.100.100.200`, `fd00:ec2::254`, the IPv6 embeddings of those IPv4 addresses (mapped, compatible, SIIT, NAT64 and 6to4), `metadata.google.internal`, `metadata` and `metadata.goog`.

The metadata check is a floor, not the site policy. A private or loopback address is left to the site rules. A DNS name that resolves to a metadata address (`169.254.169.254.nip.io`) cannot be seen here. The host checks where a navigation actually landed.

`canonicalizeBrowserOrigin(raw)` gives the `scheme://host[:port]` form `browser_act` takes, accepting a trailing `/` and refusing a path, query or fragment. `canonicalizeBrowserSitePattern(raw)` canonicalises a site key an operator or a job writes: `https://github.com`, `https://*.example.com` (one or more labels), `http://localhost:*` (any port). It refuses a bare `*`, a wildcard anywhere else in the host, a wildcard before an IP address, a path and a metadata host. IPv6 hosts cannot be written as site keys. `isCloudMetadataHost(host)` is the floor on its own, for a host checking a landing page.

The tool declares `urlArgument: 'url'` (a new `ToolDefinition` field). An `argument_pattern` rule on a declared URL argument tests the value whole. Without it, the rule reads every argument as a possible command line, and `&`, `;` or `|` in a query string cut the value into segments that an `allow` must all match. See [The review policy](review-policy.md#rules-that-ask).

## What the model reads

A snapshot result starts with a header the tool writes from the host's page info:

```
Page: https://shop.example.com — "Your cart" (tab t1)
```

The origin is re-canonicalised, and a value that is not an origin is shown as `unknown`. The title is page-controlled, so it is quoted, flattened to one line, cut at 120 characters, has hidden characters shown as `<U+XXXX>` and has the envelope's delimiter defanged. Below the header, the snapshot text is wrapped with `wrapUntrusted` (`kind="web-page"`, `origin` attribute). A closing tag inside the page is defanged, and the frame marks provenance but does not refuse anything. At most `BROWSER_SNAPSHOT_MAX_CHARS` (20000) characters come back per call. `capabilities.snapshotMaxChars` can lower it. A host that pages returns `nextCursor`, and the tool tells the model to pass it back. A host that does not page is cut, and the tool says so. `formatBrowserPageHeader(page)` is exported for a host that shows the same line elsewhere.

A screenshot comes back as a text block (the header) and an image block. `tabs list` lists each tab's header, with `*` on the active one. A `message` the host returns is shown outside the envelope, so it must be the host's own words, never page text.

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

- `act` compares `action.origin` with the live origin of the page it is about to act on, immediately before acting, and throws a `browser_origin_mismatch` shape without acting when they differ. That is what binds an approval of "click Place order on shop.example.com" to that site after a redirect.
- `capabilities.unavailableReason` keeps both tools mounted, says why in their descriptions and refuses every call with it. `screenshot: false`, `upload: false` and `supportedActions` remove actions from the model schema and refuse them before the host is called.
- `upload` paths are resolved by the tool against the turn's roots, following links, as the file tools resolve them (`pathArgument: 'path'`, so a path outside the roots becomes a review where the host enables that). The host receives the resolved absolute path.

The host refuses by throwing a value with one of these shapes. The tool recognises them by shape (`browserHostErrorOf`), so the host and the SDK need not share a class. Anything else becomes an ordinary `browser failed: …` result.

| `code` | Fields | What the model is told |
| --- | --- | --- |
| `browser_origin_mismatch` | `expected`, `actual` | Nothing was done; take a snapshot. |
| `browser_stale_ref` | `ref` | The ref is from an older snapshot; take a new one. |
| `browser_human_required` | `reason` (`sign-in`, `two-factor`, `captcha`, `bot-block`, `http-auth`, `credential-field`), `origin`, `profile?`, `loginCommand?` | Stop and tell the user; never sign in, solve it or type a password or code. The result's `data.handoff` is `{ kind: 'human-required', reason, detail: { origin, profile?, loginCommand? } }`, and its [`handoff`](tool-handoff.md) (`reason` in words, `detail` with `tool: 'browser'`, `cause` and the same fields) pauses the turn before the next model call. |
| `browser_outcome_unknown` | `action`, `outcome: 'unknown'`, `retrySafety: 'unsafe'` | The host's message; do not replay. |
| `browser_site_denied` | `origin` | Not allowed by the site rules; do not retry. |

Each shape also carries a non-empty `message`.

## Labels a person approves

`presentCall` resolves refs through `host.describeRef` and names the origin and profile: `Click button "Place order" · https://shop.example.com · profile work`, `Type "shoes" into textbox "Search" and submit · …`, `Open https://github.com/ · profile work`. An unknown ref is shown as `element e9`. Typed text and page-controlled names have hidden characters made visible. A `describeRef` or `session` that throws is ignored.

## The scheduled-job grant

`ScheduleJobDraft.permissions.browser` (`ScheduleBrowserGrant`) is the shape a `schedule` tool proposal carries: `{ profile, sites: { '<site>': 'read' | 'ask' | 'act' }, headed? }`. `read` opens and reads a site, `ask` parks each change for the operator, and `act` changes pages without asking. Unlisted sites are denied, and there is no `*` key. The tool:

- refuses the block unless the host sets `ScheduleToolHost.browserGrants: true`, so a host that cannot store the grant never confirms a job the model believes can browse;
- canonicalises every site key with `canonicalizeBrowserSitePattern`, and refuses an empty map, `*` and one site named twice at different levels;
- counts the grant as network access, so it is refused beside a shell on the host, like `web_fetch`;
- accepts a browser grant as a permission set on its own (a preset, rules or a browser grant is required).

---
type: Reference
title: The web tools
description: web_fetch and web_search, the guarded fetch provider, what web_fetch takes (url, prompt, offset), how a page becomes markdown, the content extractor seam, the fifteen-minute page cache, redirects to another host, and what a host that wired nothing gets.
resource: packages/sdk/src/tools/builtins/web.ts
tags: [sdk, tools, web, network]
status: stable
---

# The web tools

Two tools reach the web, and both declare `category: 'network'`. The presets
route that category to review, and only the `unattended` preset, which requires
the sandbox to enforce network isolation, auto-approves it.

`web_search` ships no backend: a host supplies a `WebSearchProvider`. `web_fetch`
ships a guarded provider, `GuardedFetchProvider`, and this page is about what the
tool does with a page once the guard has let it through. The tool was changed to
follow the WebFetch rules set out here.

## What `web_fetch` takes

| Field | |
| --- | --- |
| `url` | An absolute http(s) URL. |
| `prompt` | **Required.** What the caller wants from the page. |
| `offset` | Optional. Character position in the page text to start reading from, for a page too long for one call. |

A URL longer than 2000 characters, one with a user name or password, and one
whose host has no dot (`localhost`, `intranet`) are refused before any request.
The last message points to a shell command such as `curl` for a local server.
The guard's own refusals (a non-web scheme, an address inside the host, a host
the config blocks) are unchanged, and apply to every redirect hop.

"An address inside the host" means (`isPrivateAddress`, shared with the
[monitor tool's WebSocket source](monitor-tool.md#websocket-source)): IPv4
loopback `127/8`, private `10/8`, `172.16/12` and `192.168/16`, link-local
`169.254/16` (cloud metadata), "this network" `0/8`, shared address space
(CGNAT) `100.64/10`, benchmarking `198.18/15`, IETF protocol assignments
`192.0.0/24`, multicast and reserved `224/4` and up; IPv6 loopback and `::`,
IPv4-compatible `::/96`, link-local `fe80::/10`, site-local `fec0::/10`,
unique-local `fc00::/7`, multicast `ff00::/8`, and the IPv6 forms that carry an
IPv4 address: mapped `::ffff:a.b.c.d`, translated `::ffff:0:a.b.c.d`, NAT64
`64:ff9b::/96` and 6to4 `2002::/16`, each refused when the IPv4 address inside
it is one of the above (a public one passes: that is what the prefixes are
for), plus the local-use NAT64 prefix `64:ff9b:1::/48`, which is refused whole
because its embedded address has no fixed position.

## What it returns

1. The request asks for `Accept: text/markdown, text/html, */*`.
2. A page whose content type is `text/html` becomes markdown with
   [turndown](https://github.com/mixmark-io/turndown); `style`, `script`,
   `noscript` and `iframe` elements are dropped, and at most 1 MiB of HTML is
   converted (a marker ends a longer page). Anything else is left as it is.
3. **The prompt is answered from the page by a small model**, when the host
   supplied a `WebContentExtractor` as `context.web.extract`. At most 100 000
   characters are sent; the answer says which characters it covered and the
   `offset` that reads on. The instruction tells the model the page is untrusted
   data it must not obey, and holds quotes to 125 characters.
4. With no extractor, or when the extractor cannot answer (it throws, or returns
   nothing), the **page itself** is returned as markdown, cut the same way. The
   fetch never fails because a model did.

A response that is not 2xx reports `The server returned HTTP <status> <text>`
without its body. An `offset` past the end of the page says how long the page is.

## Pages are cached for fifteen minutes

A fetched page is kept for 15 minutes under the URL that was asked for, up to
50 MiB of page text (least recently used leaves first). A second question about
the same URL, and a read-on with `offset`, do not fetch again. The cache belongs to
the fetch provider object, so one turn's or one host's pages are not another's.
Errors, redirects and non-2xx responses are not kept. The result's `data.cached`
says whether a page came from the cache.

## A redirect to another host is handed back

`web_fetch` asks the provider for `redirects: 'same-host'`. A redirect that
stays on the same site (same scheme, with `http:` to `https:` allowed, same port,
the same host up to a leading `www.`, no credentials) is followed, with every hop
checked by the guard as before. Any other redirect is **not followed**: the tool
returns a `REDIRECT DETECTED` notice with the original URL, the target the server
named, its status, and the call to make to go there (`url`, `prompt` and `offset`
repeated). The target is server-supplied and unverified, so the notice says to
fetch it only if it is plainly where the page now lives. The target is still
checked against the guard's rules before it is offered. A page that moved to
another host is not the page that was asked for, and following it silently let a
page redirect a model anywhere.

`WebFetchRequest.redirects` is `'follow'` (the default, unchanged) or
`'same-host'`; `WebFetchResult.redirect` carries a redirect that was not followed.
A provider that does not know the field follows every redirect, as before.

## What the host supplies

```ts sketch
context.web = {
  fetch: new GuardedFetchProvider({ maxBytes: 10 * 1024 * 1024 }),
  extract: {
    async extract({ instruction, body, signal, sessionId, turnId }) {
      // Run `body` under `instruction` on a small model and return the text,
      // or return undefined when you cannot.
    },
  },
}
```

`GuardedFetchProvider` still reads at most 2 MiB by default; the CLI web tool reads
10 MiB and sets `maxBytes` to that. The tool builds the instruction and
the user message, so every host asks the model the same way.

## What changed for an existing host

This is a breaking change to `web_fetch`, in `@namzu/sdk` 52:

- `prompt` is **required** in the tool's input. A model or script that called it
  with `url` alone now gets an input error.
- The default output changed. It used to be the response body as text; it is now
  the answer to `prompt` (with an extractor) or the page as markdown (without),
  cut at 100 000 characters per call, and a non-2xx status reports the status
  instead of its body.
- A redirect to another host is no longer followed.

A host that wants the old text can fetch through `context.web.fetch` itself or
register its own tool. Hosts that already supplied only `fetch` keep working and
get markdown.

The package now depends on `turndown`, loaded the first time an HTML page is
converted.

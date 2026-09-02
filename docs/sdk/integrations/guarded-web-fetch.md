---
title: Guard model-authored web fetches
description: Configure the SDK web-fetch provider with SSRF refusal, one cancellation and deadline boundary, bounded redirects, and streaming response limits.
type: Guide
status: stable
resource: packages/sdk/src/connector/web/guarded-fetch.ts
tags: [sdk, integrations, security]
generated: { by: human:bahadirarda, at: 2026-08-19T00:00:00Z }
---

# Guard model-authored web fetches

`GuardedFetchProvider` is the shipped backend for the `web_fetch` tool. It
checks a model-authored URL before sending it, then keeps DNS resolution,
fetch, redirects, and response-body reads inside one operation-owned deadline.

## Configure the provider

```ts
import { GuardedFetchProvider } from '@namzu/sdk'

const webFetch = new GuardedFetchProvider({
  timeoutMs: 15_000,
  maxBytes: 1024 * 1024,
  maxRedirects: 3,
  blockedHosts: ['internal.example.com'],
})

const result = await webFetch.fetch({
  url: 'https://www.example.com/',
  signal: AbortSignal.timeout(10_000),
})

console.log(result.status, result.body)
```

Pass this provider as `web.fetch` when constructing a query or agent session.
The shipped `web_fetch` tool forwards the run-owned signal, so stopping the run
also stops the provider's private transport without aborting the caller's
controller.

## Defaults and admission

| Setting | Default | Contract |
| --- | ---: | --- |
| `timeoutMs` | 30,000 ms | one clock across DNS, every fetch hop, and the final body |
| `maxBytes` | 2 MiB | actual response bytes retained from the stream |
| `maxRedirects` | 5 | redirects followed after the initial request |

`timeoutMs` and `maxBytes` must be positive platform-range integers.
`maxRedirects` must be a non-negative safe integer. Invalid values are refused
when the provider is constructed, before DNS or network work starts.

## Network refusal boundary

The provider accepts only HTTP and HTTPS. It resolves every hostname before
the request and refuses loopback, link-local, private, multicast, reserved,
and IPv4-mapped private addresses. `blockedHosts` adds deployment-specific
names. Every redirect target is parsed, resolved, and checked again before it
is followed; a spent redirect budget causes no DNS lookup for the next target.
Authorization, cookie, host, and proxy-authorization headers supplied by the
model are stripped.

`allowPrivateAddresses: true` explicitly disables the private-address check.
Use it only when the host deliberately grants access to an internal network;
it is not a test-only spelling of the default.

The platform `fetch` API cannot pin a connection to the address returned by a
separate DNS lookup. A deployment that must eliminate the lookup-to-connect
DNS-rebinding window should inject a `fetch` implementation that pins the
validated address. A custom `resolve(hostname, signal)` receives the same
private operation signal as fetch and body reads.

## Body and cancellation semantics

The byte cap is enforced from stream chunks, not trusted from
`Content-Length`. The provider retains at most `maxBytes`, cancels the reader
after the first excess byte, and marks the result `truncated: true`. A body
whose length is exactly the cap remains untruncated after EOF is observed. If
the cap cuts through a UTF-8 code point, the incomplete suffix is dropped
instead of introducing a replacement character that was not in the response.

A pre-cancelled request starts no resolver or fetch work. Later cancellation
and the provider deadline race resolver, fetch, and reader promises even when
an injected implementation ignores its signal. The first cancellation cause
is preserved, and no value fulfilled beside that cancellation is published as
success. Redirect response bodies and overflowed final bodies are cancelled on
the paths that stop consuming them.

## Related

- [Connectors and MCP](./connectors-and-mcp.md)
- [Built-in tools](../tools/built-in.md)

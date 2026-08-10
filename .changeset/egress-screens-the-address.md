---
'@namzu/sandbox': major
---

The egress boundary now decides by resolved address, not only by hostname

`EgressProxy` allowed or refused on the client-supplied **name**, and nothing
in the package resolved or inspected an address. An allowlisted name whose DNS
the caller controls — or that simply has an inward-pointing record — resolved
to loopback, to the private network the sandbox host sits on, or to the
link-local address cloud metadata services answer on, and the proxy connected.

On the plain-HTTP path the brokered credential is stamped onto the outbound
headers **before** the request goes out, so the credential-brokering design
that is the proxy's whole reason for existing was the delivery mechanism: the
token reached whatever the name resolved to. `BrokeredCredential.host` exists
to stop exactly that, and it could not while its scope was a name.

Both paths now screen the address. Refused, whatever the allowlist says:
loopback, private (`10/8`, `172.16/12`, `192.168/16`), link-local
(`169.254.0.0/16` — the metadata block), shared address space
(`100.64.0.0/10`), unspecified, multicast and reserved on v4; `::1`,
`fc00::/7`, `fe80::/10` and `ff00::/8` on v6; and a v4 address wearing a v6
spelling in any of its forms, since a v4-only screen is a known way through
this kind of filter.

**This denies configurations that worked before, which is why it is major.**
A sandbox whose allowlist names a host on a private network — a registry, an
artifact cache, a service on the host's own LAN — starts getting `403` with a
reason naming the address kind. That is the intended behaviour, and the remedy
is per host:

```ts
createSandboxProvider({
  backend: {
    tier: 'container',
    image: 'namzu/sandbox:latest',
    allowInwardFor: ['.internal.example', 'registry.corp'],
  },
  layout,
})
```

Matched by the allowlist's own rules, so `.internal.example` covers
subdomains. There is deliberately no switch that turns the screen off: one
would hand every other allowlisted name the same reach, which is the hole the
screen exists to close. `EgressProxyOptions.allowInwardFor` is the same knob
when constructing `EgressProxy` directly.

One limit stated rather than implied: on the `CONNECT` path this bounds where
the tunnel terminates and nothing more. The bytes inside it are opaque to the
proxy, including the name the caller puts in its own TLS handshake, so a
tunnel to an allowlisted host is not a guarantee that only allowlisted traffic
crosses it.

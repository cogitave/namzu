---
'@namzu/sandbox': patch
---

The package description no longer claims an authentication this proxy does not have

`package.json#description` described the container tier as an "HTTP worker + JWT-authenticated egress proxy". The egress proxy has no inbound authentication of any kind — no token, no JWT, no check. The only occurrence of `proxy-authorization` in `src/egress/proxy.ts` is in the list of hop-by-hop headers it deletes, so the header a client would authenticate with is explicitly stripped.

This mattered more than an ordinary comment would, because a package description is the text on the registry page — where somebody decides whether this package is safe to depend on, before they have any source to read.

The description now says what the proxy actually is: loopback-bound, deciding by resolved address rather than by hostname, and brokering outbound credentials so a token never enters the sandbox. Those are the controls it has, and they are the ones worth knowing about.

No behaviour changes.

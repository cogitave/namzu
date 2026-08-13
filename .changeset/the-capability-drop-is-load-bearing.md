---
'@namzu/sandbox': patch
---

Record why the capability drop is load-bearing for egress denial

Comment only; no behaviour change.

`deny-all` is now enforced by the container's network being `--internal`, and it was worth measuring what that is actually worth. A container on such a network has no default route — but `ip route add default via <sibling>` is refused with `Operation not permitted` under docker's **default** capability set, before `--cap-drop=ALL` is applied at all. `NET_ADMIN` is what would lift that.

So the internal network removes the route and the capability drop removes the ability to put one back. Both are needed, and `HARDENING_ARGS` previously justified the drop only on unrelated grounds (`CAP_DAC_OVERRIDE` walking past read-only binds) — a rationale that would survive softening the flag, while this one would not.

Also recorded: given `NET_ADMIN` and a manually installed route, a dual-homed sibling *does* forward the packet (`net.ipv4.ip_forward` is `1` inside a container). No connection establishes because nothing masquerades the internal subnet, but the docblock says plainly that this is not a security property — one-way egress is enough for exfiltration, and what was measured is a failed handshake, not a dropped packet.

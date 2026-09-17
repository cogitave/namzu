---
"@namzu/sandbox": major
---

**A `container:docker` sandbox with an egress allowlist now needs an internal
network, a proxy image, and `container-network` reachability. Take this version
if you use one; otherwise nothing you install changes shape.**

The allowlist tier used to be enforced by `HTTP_PROXY` and nothing else. The
proxy ran in the process that created the sandbox, on the host's loopback, and
the sandbox kept ordinary bridge networking with full outbound reachability —
`--add-host namzu-egress:host-gateway` was the only thing pointing traffic at
it. Anything inside the container that opened a socket directly reached the
network with the allowlist unconsulted. It is now a sibling container on an
`--internal` network the sandbox is also on, which has no route off it: the
sandbox's traffic reaches the internet only through that container, and
everything else a host attaches to that network is a container on the sandbox's
own subnet.

**What a host using `EgressPolicy` of `static` or `resolver` must now do**, all
three refused at `create()` rather than downgraded:

1. `network` must be an `--internal` network: `docker network create
   --internal <name>`. The network's `Internal` flag is read back from the
   daemon; the name is never trusted.
2. `hostReachability` must be `'container-network'`. A published host port
   needs a route out and an internal network has none — the refusal names the
   mode to move to. **A host-side consumer (the CLI, direct dev) that reached
   the worker on `127.0.0.1:<port>` under an allowlist policy must move to a
   consumer on the internal network.**
3. `egressProxyImage` must name the proxy image:

   ```bash
   pnpm --filter @namzu/sandbox build
   docker build -f packages/sandbox/egress-proxy/Dockerfile -t <tag> packages/sandbox
   ```

   It is a second image because the sandbox image is a string this backend
   cannot read, and the bind-mount alternative breaks on the remote-daemon
   deployment `container-network` exists for.

`HTTP_PROXY` and friends are still set and now direct traffic rather than
permit it: a tool that honours them goes through the boundary, one that ignores
them fails `Network unreachable` instead of bypassing the policy.

**Four behaviour changes to know about, all of them consequences of the
boundary existing:**

- A `resolver` policy is resolved at `create()` and at each
  `setNetworkPolicy()`, not per request. A resolver that rotates between those
  moments is not picked up until the next one.
- `setNetworkPolicy()` replaces the proxy container rather than swapping the
  allowlist in place. The window between the two has no proxy in it and fails
  **closed** — no request is permitted that the new policy would refuse.
- `brokeredCredentials` are passed to the proxy container's environment. They
  still never enter the sandbox; they are now readable by anything with access
  to the docker daemon, which should be treated as credential access. (On the
  way there the value goes through the `docker` CLI child's ENVIRONMENT, not its
  argv — an argv is world-readable in `/proc/<pid>/cmdline` on Linux.) Note also
  that `createSandboxProvider` has never forwarded `brokeredCredentials` at all;
  that pre-existing gap is unchanged.
- `egressProxyUpstreamNetwork` (default `bridge`) is where the proxy reaches
  the internet. Anything else attached to that network can reach the proxy and
  use it, so name a dedicated one on a shared daemon. `'none'`, and the internal
  network itself, are refused: either leaves the proxy with no route out.
- Everything else on the SANDBOX's internal network is reachable from the
  sandbox — a second sandbox, a second sandbox's proxy. That is a property of
  the network rather than of this tier; give each sandbox its own internal
  network when they should not see one another.

`deny-all` and `allow-all` are unaffected beyond the internal network
`deny-all` already required. `EgressProxy` gains two optional options
(`bindHost`, `selfNames`) and the container entrypoint sets them; the class is
otherwise unchanged.

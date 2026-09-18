---
'@namzu/sandbox': minor
---

`createSandboxProvider` now forwards `brokeredCredentials`, and
`ContainerBackendConfig` carries the field.

What this makes possible is the thing the container tier's egress boundary was
built for. A host can now name credentials the sandbox never holds: the sandbox
carries a placeholder, and the real value is stamped onto outbound requests at
the egress proxy, so a prompt injection that exfiltrates the sandbox's
environment does not carry the token with it. Until now the field could only be
read from `DockerBackendInternalConfig`, which is not part of this package's
public surface, so brokering was reachable only by calling `buildDockerBackend`
directly — not by building a provider the documented way.

Nothing existing changes behaviour. The field is optional and unset by default,
and it is forwarded in the guarded style its neighbours use, so a config that
does not set it produces a backend config with no such key at all rather than
one with an explicit `undefined`; `egressProxyContainerConfig` reads either as
"no credentials to stamp". A provider built without the field starts exactly the
proxy container it started before. The one caller whose behaviour does change is
the one that was passing the field through a type cast: it now takes effect.

**Set it where it can be honoured, and not elsewhere.** The field is on
`ContainerBackendConfig` — the docker and gVisor (`runsc`) tier — because that
is the only tier with an egress proxy to stamp a credential at. The microVM tier
hands its allowlist to its guest orchestrator and the kubernetes tier writes
`NetworkPolicy`/`CiliumNetworkPolicy`; neither has a proxy, so the field is not
on their configs. Within the container tier it is applied only where a proxy is
actually started, which is a `static` or `resolver` policy with an
`egressProxyImage`: `deny-all` and `allow-all` run no proxy, and credentials set
beside either are never applied.

Each entry names one host (`host`, matched by the allowlist's own rules so
`.internal.example` covers subdomains), the header to set, and the value. The
value leaves this process on its way to the proxy container, so anything with
access to the docker daemon can read it — treat daemon access as credential
access. See `docs/sdk/sandbox-egress.md`.

---
'@namzu/sdk': major
---

The `bash` builtin no longer hands a command the credential-shaped half of the
host environment.

**What changed.** On the non-sandboxed path the tool spawned with
`{ ...process.env, ...context.env }`, so the model's command inherited every
variable the Namzu process held — including the ones Namzu reads its own
provider credentials from. A command that prints its environment (`env`,
`printenv`, a Makefile echoing its config, a build script dumping state on
failure) returned those keys as tool output, and tool output is appended to the
durable transcript, persisted by the session store, and re-sent to the model
provider as history on every later turn of the run. The sandboxed path was
never affected — it passed `context.env` alone — so this was specifically the
default configuration's problem.

The inherited half is now filtered: variables whose names look like credentials
(`*KEY*`, `*SECRET*`, `*TOKEN*`, `*PASSWORD*`, `*CREDENTIAL*`, `*PRIVATE*`,
`*COOKIE*`, `*SIGNATURE*`, and a short exact list for the shapes no pattern
catches, such as `GOOGLE_APPLICATION_CREDENTIALS` and `KUBECONFIG`) are dropped
before the spawn. When a command fails, the names of the withheld variables —
names only, never values — are appended to its output so an authentication
error points somewhere.

**What a caller does to keep the old behaviour for a specific variable.** Pass
it explicitly. `RunConfig.env` flows to `ToolContext.env`, which is applied
after the scrub and is not filtered: a host that means a command to have a
credential names it and it arrives. The asymmetry is the design — inheritance
is implicit and nobody chose it, an explicit entry is a decision someone made.
There is no flag to restore blanket inheritance.

**What this is not.** A denylist on key names is not a boundary. It cannot see
a secret whose name does not look like one — a password in a `DATABASE_URL`
userinfo, a pre-signed URL in `ARTIFACT_URL`. The boundary is the sandbox,
where the inherited set is a seven-key allowlist. The host path takes the
weaker control deliberately, because the same agent is expected to run
`pnpm test`, `make` and `docker build`, and an allowlist there would withhold
most of what a build needs.

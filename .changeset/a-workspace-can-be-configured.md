---
'@namzu/sdk': minor
---

A workspace can be configured, listed, and reconfigured.

Every Project in existence ran at delegation depth 4 and width 8. The config was
hardcoded identically in both stores, `CreateProjectParams` was
`{tenantId, name}`, and there was no way to write one afterwards — so a tenant
with several workspaces could not give them different limits, which is most of
what having several workspaces is for.

`CreateProjectParams` gains `config`, and `SessionStore` gains `updateProject`
and `listProjects`.

**Only the fields something reads are settable.** `ProjectConfig` declares
eight; five enforcement sites read two of them. The other six have zero
production readers — `maxInterventionDepth` included, whose three apparent hits
are all comments describing a wiring that does not exist. Exposing those would
make a dead field *easier to set*: a host would configure a retention policy,
get no error, and believe retention was on. `ProjectConfigInput` is therefore
exactly `maxDelegationDepth` and `maxDelegationWidth`, and a field joins it in
the same change that gives it a reader.

**Both new store methods are optional.** Widening a store interface is invisible
to callers and fatal to implementors: a host with its own `SessionStore` should
not stop compiling because the SDK grew a method. Both stores here implement
them; callers check.

Two decisions worth naming. An update is applied **per field**, so a caller
raising the width is not silently resetting the depth — including when a key is
present but `undefined`, which is the shape a caller building an update object
programmatically produces. And `listProjects` **omits** another tenant's
projects rather than refusing: a listing is a question about what you own, and
refusing would confirm that somebody else's project is there. Writing to one
still throws.

Verified live against a real run, not only in tests: a workspace created with
`maxDelegationWidth: 1` refuses the second concurrent delegation with
`Delegation capacity exceeded: width 2/1`, and the same workspace at width 5
runs all four.

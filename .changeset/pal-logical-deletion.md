---
"@namzu/sdk": minor
"@namzu/cli": minor
---

Add `DiskPalStore.delete(id, expectedRevision)` and the desktop host's
`namzu/pals/delete` metadata endpoint. Deletion uses a terminal immutable revision,
hides the current Pal, and refuses future updates and execution admission while
preserving historical profiles, journals, host files, and guest data volumes.
Hosts must stop active work and confirm computer cleanup before deleting its
identity. Existing custom `PalStore` implementations require no new method.
Readers from older releases do not understand terminal deleted profiles and
should not be used to read a registry after deletion has been published.

Add the desktop host's `namzu/conversations/archive` endpoint. It performs a
scoped, writer-gated soft removal while retaining the durable conversation and
files. Successful retries return `archived: true`; a physically absent strict
journal returns `archived: false, missing: true`, never claiming that an absent
conversation was archived. Hosts may discard only their own known unsent local
projection from this missing receipt. Existing terminal archive commands are
unchanged.

Release a connection's exact idle native-engine writer before desktop archival,
reserving the conversation until the operation settles. Active or unresolved
work is refused and a failed native close retains cleanup authority for retry.
The runtime reservation method is optional for existing embeddings.

Keep a Pal's approved stored control-path spelling when Windows native path
resolution changes only its case, after verifying the same physical directory.
Physical project identity remains canonical, while existing Pal profile revisions
and journal ownership paths remain unchanged. Different directory objects and
non-case aliases are refused.

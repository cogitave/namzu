# Native delivery and verification limits

## Current compiled app

The final Desktop build was installed and opened in the Windows app, process
16492. The [read-only payload comparison](artifacts/installed-css-comparison-e6f7d3e2-53d2-40cf-b1d0-88d3f1359ef6.json)
finds **730 of 730 files byte-identical** to the local build, including main,
preload, renderer JavaScript, CSS and HTML. It performs no app or file mutation.

Final source fingerprints:

- App: `b0949cfc8699d7e9503bcdf715079270cb780702ca12dce9b15b362719960a35`.
- Transcript CSS: `df4b65b57e95eceeaf32074fb22798b9de1aeaab2f135b5db383684135d99b93`.

The final source passed workspace typecheck, lint and tests (**20,152 passed**,
116 skipped), the Desktop build and the documentation check. Lint retained
12 existing CLI warnings. [HOVER_PROOF.md](HOVER_PROOF.md) records the 28
fixed-geometry renderer variants and the separate successful actual Windows
CSS hover measurement. [PENDING_SCROLL_PROOF.md](PENDING_SCROLL_PROOF.md)
records five actual App reader cases and the final disclosure-persistence rerun.

## Latest activation receipt remains failed

The guarded full activation installed the complete build, gracefully closed the
old process and opened the new app. It then **failed verification** because its
ownership comparison required ten never-prompted, empty SDK runtime aliases to
retain their runtime IDs across restart. Those empty runtime IDs regenerated;
the two authored owners retained their IDs. The original private failed receipt
remains unchanged, SHA-256
`6b79f91a1a06d76b3b4bd8efd8e560556832de78a6e3e967a03ee0da29d60c28`.

A separate stricter empty-alias verifier was prepared and independently tested
(5 passing pure tests), but **was not executed**. The user had changed the
active tab and window placement. Attempts to restore the older reader view
refused at ownership checks before any scroll assignment. No older workspace
layout or reader position was subsequently imposed on the user.

## Bounded final read-only observation

The [sanitized final observer receipt](artifacts/native-authored-final-readonly.json)
passed for the two previously authored SDK histories: **13 messages** retain
exact IDs, roles, body hashes, order and journal timestamps, and both original
whole-journal byte hashes stayed unchanged before and after the observation.
The user's current workspace layout also stayed unchanged during this read.
The observer used only workspace and existing-conversation reads, with zero
provider requests, UI actions or restart actions. Raw message bodies and the
original private snapshot are not included in this research directory.

This bounded result and the exact installed build do not turn the original
activation receipt into a pass or establish preservation of the entire old
presentation. Earlier activation, delivery and failed fixture receipts remain
available unchanged; their results are scoped to their recorded source and run.

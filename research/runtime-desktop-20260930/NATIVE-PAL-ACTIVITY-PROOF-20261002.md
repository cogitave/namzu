# Native Windows Pal activity observation — 2026-10-02

The production SDK activity source passed eight checks under native Windows
Node 22.20.0 with an inherited WSL UNC working directory. The
[sanitized receipt](artifacts/pal-native-activity-20261002.json) records exact
built-module and harness SHA-256 values without Pal IDs, private paths, prompts,
message bodies, tool arguments/results or credentials.

## Actual evidence

The source observed the two completed, original journals produced by the
successful native Pal messaging and real local computer proof. Their first
records were checked against the fixture's existing installation tenant,
project identity and workspace, and each immutable pinned Pal profile revision.
The read port uses the actual SDK `DiskLogMedium`. It does not initialize CLI
sessions, create an index, claim a writer or invoke a computer or model.

| Original journal | Pages | Projected facts | History records scanned |
| --- | ---: | ---: | ---: |
| First Pal | 21 | 60 | 144 |
| Second Pal | 16 | 50 | 111 |

Every page was limited to seven original history records and 128 KiB of total
requested journal bytes, including root and cursor anchors. Concatenated page
facts matched a separate bounded original-journal pass. Fact IDs remained unique
and stable, and only the closed metadata fields were present. Known private
prompt, peer-message, command, file-content and PNG payload markers were absent.

Four new native Windows processes resumed exact cursor outputs privately saved
by the trusted host: the first-page cursor and completed-tail cursor of each
journal. The resumed next page matched the original next page; a completed-tail
cursor remained unchanged and yielded no additional facts.

Denied current observation consent opened no journal and returned no page.
Revocation at the actual final size-read boundary suppressed the entire pending
page. A cursor from the other Pal was rejected before opening its journal.
SHA-256 values of all original journal bytes and pinned profile files were
unchanged afterward.

## Reproduction

Use a new built Windows consumer snapshot prepared by
[prepare-windows-consumer.mjs](prepare-windows-consumer.mjs), with its existing
native dependency junctions. Copy the completed production SDK `dist` into its
SDK package directory and copy
[windows-pal-activity-proof.mjs](windows-pal-activity-proof.mjs) into the snapshot.
The successful run refreshed only SDK build output in the separately owned
appearance snapshot. The original messaging snapshot and journal files were
not changed.

Execute the harness with native Windows Node, passing the native path to that
appearance snapshot and the existing private `pal-messaging-*` fixture home.
The harness creates a separate `pal-activity-*` output directory under the
appearance snapshot. Trusted cursor payloads stay in this private output;
only the sanitized receipt is copied into the repository.

## Limits

- This is a built native SDK consumer proof, not an npm registry installation.
- The source observes completed original journals; a concurrent writer is not
  exercised.
- The required host observation consent callback is explicitly controlled by
  this fixture. No CLI or desktop activity subscription is claimed.
- Cursors are verified prior outputs privately stored by the host. Raw model
  or renderer anchors are not accepted. The previously consumed prefix is not
  rescanned, and `scopeHash` is not an authenticity signature.
- No writer, model inference, guest startup, engine installation, external
  message or user window was invoked by this observation proof.

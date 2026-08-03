---
'@namzu/sdk': minor
---

Refuse a file mutation computed against a body that has since moved, and stop writing over symlinks.

Two gaps the restored mutation lock does not cover, both standard practice in file-editing agents and both absent here.

**Drift between the read and the write.** The lock serializes this runtime's own writers. It cannot see a person editing in an editor, another process, or a second agent run — and an edit computed against a body that has since changed is a lost update whichever of those did the moving. Worse, it was actively misreported: an `old_string` that no longer matched came back as *"not found in file — make sure the string matches exactly"*, which tells the agent its input was wrong when the file changed underneath it, so it retries the same edit against the same moved file.

`FileReadTracker.recordRead` now optionally takes the body it read and fingerprints it, and `edit` compares that against what is actually on disk before mutating. A mismatch is refused with a message that says what happened, that nothing was written, and to read the file again. A successful edit re-fingerprints, so a second edit in the same turn is not mistaken for someone else's drift. Both the extra parameter and the new `fingerprint()` accessor are optional, so a host that only needs the read-before-overwrite guard keeps its existing implementation and its existing behaviour.

**Writing over a symlink instead of through it.** `rename` replaces whatever sits at the destination, so committing onto a link path swapped the link for a regular file — the link gone, and every other path that pointed through it left reading stale content. The atomic writer resolves the destination first, so the link survives and its target is updated. A path that does not exist yet resolves to itself.

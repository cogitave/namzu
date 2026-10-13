---
'@namzu/sandbox': minor
---

Add `reconcileKubernetesWorkspaceClosure` for observing a retained physical workspace target after a host restart. It performs only control-plane reads, refuses replacement or incomplete resource evidence, and distinguishes live, stopping, suspended and fully deleted resources. The caller must retain lifecycle exclusion and persist the original identity and epoch before dispatch; the observer never authorizes a by-name mutation.

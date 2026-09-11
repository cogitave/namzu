---
"@namzu/sandbox": major
---

Require container workers and Firecracker guests to publish the exact remote-execution protocol during readiness, refuse missing or mismatched peers before command admission, remove identity-less legacy execution, and export the Firecracker guest protocol version for host warm-pool admission checks. Rebuild worker images, standby-pool profiles, and microVM goldens from the same release before deploying the matching host.

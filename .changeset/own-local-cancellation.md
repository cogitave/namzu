---
'@namzu/sdk': patch
---

Keep local sandbox cancellation under the run's ownership until shared process output closes. The confined Linux tier now admits a command only after tracking its inner PID namespace, cancelling during wrapper startup or after wrapper exit terminates the complete process tree, and a later deadline no longer misreports a caller cancellation as a timeout.

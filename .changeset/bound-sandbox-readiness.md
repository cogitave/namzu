---
'@namzu/sandbox': major
---

Make `readyTimeoutMs` a real worker-readiness deadline across the Docker,
standby-container, and microVM backends. In-flight health requests, IP polling,
connect retries, handshakes, framed reads, and retry delays now fit inside the
remaining total budget. A readiness failure attempts remote teardown for at
most one additional second, aborting HTTP transports and killing a held Docker
cleanup child before returning the original readiness error.

Docker and userspace-kernel container configs now expose and forward
`readyTimeoutMs` and `readyPollIntervalMs`, with defaults of 30 seconds and 100
milliseconds. Standby-container readiness now shares one timeout across IP
publication and worker health instead of granting each phase a fresh full
budget.

This is a major change because zero, negative, fractional, non-finite, and
platform-timer-overflow readiness values previously type-checked and reached
backend work. They now fail during provider construction. Migrate those values
to positive safe-integer milliseconds no greater than `2_147_483_647`.

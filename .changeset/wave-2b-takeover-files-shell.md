---
"@namzu/sdk": major
---

File reads now enforce a 32 MiB text input ceiling even with a window or `allow_large`, notebooks enforce a 1 MiB UTF-8 text/encoded-image output budget, and PDF pictures enforce a 24 MiB encoded output budget. Reads use bounded range IO rather than trusting a file's initial size; sandbox adapters must honor offset/length range requests. Extract smaller files or selected notebook cells with shell tooling, or request fewer PDF pages when a budget is exceeded.

Protected-path writes now require a person even in `bypass` and `classify`; unattended calls are refused rather than silently approved. Keep such writes out of unattended tasks or supply an explicit per-call reviewer. Shell path checks resolve relative operands against the carried bash directory while preserving the original session roots. Hosts may use `effectiveBashWorkingDirectory` to apply the same directory to their own checks.

Grep adds `before_context`, `after_context` and `only_matching` in content mode, retaining the existing symmetric `context_lines` and default file-list behavior. Search file reads are bounded against files that grow after discovery.

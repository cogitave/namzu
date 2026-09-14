---
"@namzu/cli": major
---

Default CLI main runs and built-in delegated agents to unlimited token usage,
iterations and run duration. Previously main runs defaulted to 50 iterations,
children to 40, and both to a one-hour deadline. To keep bounded execution, set
positive `limits.maxIterations` and `limits.timeoutMs` in your configuration;
explicit values apply to both the main run and built-in children. SDK embedding
defaults and file-defined specialist iteration settings remain unchanged.

Add Run limits to `/config`: edit tokens, model turns and duration, or remove all
three caps. Changes apply to new turns and their children for the current TUI
session; running work retains its captured limits and usage ledger. Resuming a paused
CLI run reloads its own saved limits instead of replacing them with launch defaults. Persistent
limits still come from the configuration files. Usage accounting, cancellation,
permissions and provider quotas continue to apply in unlimited mode.

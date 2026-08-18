---
'@namzu/cli': minor
---

Add `/debug-config`, a values-free view of the winning source for every resolved configuration key.

The command identifies defaults, user and project files, selected profiles, environment variables, the managed file, and exact `--format` or `--quiet` overrides. It retains the selected profile even when higher-precedence layers replace all of that profile's values.

Dynamic source metadata is credential-redacted and emitted only as quoted printable ASCII with visible escapes for control, bidirectional-formatting and non-ASCII code points.

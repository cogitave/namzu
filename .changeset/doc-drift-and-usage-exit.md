---
'@namzu/cli': minor
---

A bad flag is a usage error, not a broken CLI

`namzu doctor` answered 70 — sysexits `EX_SOFTWARE`, "the program itself failed" — when the caller mistyped a flag. That tells an operator to file a bug for their own typo, and it disagreed with every sibling command. It now answers 64, `EX_USAGE`, and the code is part of the documented contract.

Six published pages were also corrected against the source rather than reworded: `provider.chat()` was removed from the provider interface and is now shown as the streaming call aggregated; the built-in tool names are documented as registered (lowercase) rather than as an older capitalization that made the copy-pasteable `activate` example throw; the tool count matches what `getBuiltinTools()` returns, including the one tool no page had ever mentioned; a deleted store symbol is replaced by the one that exists; a retrieval field is named as it is declared; and two config fields documented as unavailable on the reactive agent are shown as what they are — present and forwarded.

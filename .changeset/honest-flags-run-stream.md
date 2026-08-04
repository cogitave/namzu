---
'@namzu/cli': minor
---

run-stream honours --cwd, and stops reading unknown flags aloud to the model

`run-stream` and `history` both advertise `--cwd <path>` in their own help
text. Neither ever parsed it. Worse than ignored: the parser folded every
argument it did not recognise into `rest`, and `rest.join(' ')` is the
**prompt** — so the invocation our help teaches,

```
namzu run-stream --cwd /projects/foo "summarise this"
```

sent the model a prompt reading `--cwd /projects/foo summarise this` while
silently using the process's own directory. For `history` the same omission
meant a host asking about a session in another checkout was told `[]`, which
is indistinguishable from a session that exists and has no messages.

`--cwd` is now parsed and actually used — it selects the `.namzu` store the
session is read from and the directory skills are discovered in.

**Behaviour change worth reading before you upgrade.** An unrecognised
`--flag` is now refused with an error event instead of becoming prompt text.
This is what makes a typo — `--modell gpt-4o` — a message rather than
something the model is asked to interpret. If you deliberately send a prompt
that begins with a dash, put `--` in front of it:

```
namzu run-stream -- --force should be added to the docs
```

Everything after `--` is prompt, verbatim. A single leading `-` was never
treated as an option and still is not.

Classified `minor` rather than `major` because this package is `0.x`, where
[SemVer §4](https://semver.org/#spec-item-4) states the public API should not
be considered stable and anything may change. On a `1.x` package the refusal
would owe a major.

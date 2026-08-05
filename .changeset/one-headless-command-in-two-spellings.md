---
'@namzu/cli': minor
---

`namzu run` takes the options `run-stream` takes, instead of reading them out to the model

The two headless one-shots are the same command with different output — `run`
prints the reply for a shell, `run-stream` emits one JSON event per line for a
host UI — and they accepted different input. `run` parsed nothing at all and
joined every argument into the prompt, so

```
namzu run --cwd /projects/foo "fix the failing test"
```

sent the model a prompt beginning `--cwd /projects/foo` and ran in this
directory anyway. That is the defect fixed in `run-stream` one release ago,
still live in its sibling.

`run` now accepts `--cwd`, `--provider`, `--model`, `--skills` and `--`, parsed
by the same function `run-stream` uses, so the two cannot drift again.

**What breaks.** `run` refuses an option it does not recognise instead of
treating it as prompt text:

- `namzu run --temperature 0.5 "hello"` used to run, with `--temperature 0.5` as
  the first three words of the prompt, and exit 0. It now prints
  `unknown option(s): --temperature` and exits **64**.
- A prompt that genuinely starts with a dash needs `--` in front of it:
  `namzu run -- --force means what?`. A single leading `-` was never an option
  and still is not.

To keep the old behaviour for a prompt containing flag-shaped text, put `--`
before it. There is no way to get back the old reading of an unrecognised
`--flag` as prompt text, and that is the point of the change.

Classified minor, not major: SemVer §4 puts 0.x outside the stable-API
guarantee, and this matches how the same narrowing was classified for
`run-stream`.

`--yolo` / `--dangerously-skip-permissions` are accepted on both commands and do
nothing there, which is now stated in `--help` rather than left to be inferred:
a headless turn has nobody to ask for approval, so it never prompts, so there is
no prompt to skip. The safety gate that refuses catastrophic shell commands is
unaffected and cannot be bypassed by either flag.

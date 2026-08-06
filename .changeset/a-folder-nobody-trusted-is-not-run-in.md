---
'@namzu/cli': major
---

`namzu run` and `namzu run-stream` refuse a folder nobody has trusted

**This breaks every headless run in a folder you have not opened namzu in.**
Migration is one of two things, and both are below.

namzu's trusted-folder store says in its own header that a folder must be
trusted "before namzu reads, runs commands in, or edits files in" it. That was
true of the interactive TUI and false of everything else: the trust check had
exactly one caller. So

```bash
git clone <someone else's repository> && cd <it>
namzu run "what does this do?"
```

read that repository's files, ran commands in it, and executed its code — with
tools auto-approved, because a headless run has nobody to ask. Nothing asked
you whether you trusted it, because there was no way to ask.

Both one-shots now check first, before a session is constructed and before
anything in the directory is read.

**What to do**

- Run `namzu` in the folder once and accept the trust prompt. That is
  remembered, covers every subfolder, and is a one-time thing per project.
- Or pass `--trust`, which accepts the folder **for that run only**. It does
  not write anything down — one reflexive use must not change your machine's
  state forever. For CI this is the intended form: it lives in the job
  definition, where a human reviewed it.

`--yolo` / `--dangerously-skip-permissions` do **not** imply `--trust`, and
neither does `--permission-mode`. Those say which tool calls may run inside a
folder; trust says whether the folder may be worked in at all. Letting an
existing flag satisfy a new gate is a gate satisfied by accident.

**How a refusal looks**

`namzu run` prints the folder and both ways forward, and exits **77**
(sysexits `EX_NOPERM`). Its own code, because a caller has to tell "you have
not trusted this folder" — fixable by a human decision — from `64` (your
arguments are wrong) and `1` (the run failed). `namzu run-stream` emits the
same explanation as an `{"kind":"error"}` event and then `{"kind":"done"}`, and
also exits 77: it is the one case where that command exits non-zero, because
its usual "errors are in-band, exit 0" contract is about a run that started and
failed, which a host may retry, and this is a refusal to start, which retrying
cannot fix.

**What this does not do.** It is not a sandbox. It does not protect a folder
you trusted that later turns hostile — a pull can bring in anything, and trust
is a statement about a location rather than its current contents. It does not
constrain anything inside a trusted folder, where your `permissions` rules and
the safety gate remain the only controls. It raises the floor from "nobody was
asked" to "somebody decided", which is the part that was missing.

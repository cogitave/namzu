---
name: run-skill-generator
description: Write or refresh the project skill that knows how to build, start and drive one app, so later sessions can run it without rediscovering how. Use when the person types /run-skill-generator, or asks for a run skill for this project. Not for running the app once (use /run) and not for a skill about something else (use skill-creator).
invocation: operator
argument-hint: '[which app, or what to improve]'
---

# Writing the run skill for an app

The result is a project skill, `run-<unit>`, that lets a future session build,
start and **drive** one app from a clean machine. A driver (a script that
starts the app and lets you act on it) is what makes it work; the `SKILL.md`
is its short manual. A skill that only repeats the README is worth nothing:
you write it only after you have run the app yourself, here, in this session.

$ARGUMENTS

## Done means all four

1. You launched the app on this machine and used it. For a window, you took a
   screenshot and looked at it.
2. The harness is saved next to the skill: a driver script, a wrapper around
   `tmux` or a pseudo-terminal, a smoke test, or the exact browser steps.
3. The `SKILL.md` names that harness as the way an agent runs the app, before
   the way a person does.
4. Every code block in the `SKILL.md` is a command you ran in this session and
   saw work. Nothing is copied from the README unrun.

If the first is missing, stop and say so: without it you would be paraphrasing
the README.

## Steps

1. **Look for an existing run skill** in `.namzu/skills` and `.agents/skills`,
   from the current folder up to the checkout root, reading each description
   (the probe in the `run` skill). If one exists, refine it: check each claim,
   fix what is wrong, keep its name, run its driver again. Do not rewrite a skill
   that mostly works.
2. **Decide the unit.** A unit is one deployable thing: an app, a service, a
   library. A repository with one project gets one skill. A repository holding
   several (`apps/`, `packages/`, `services/`) gets one per app, next to that
   app; if you cannot tell which one is meant, ask. An app with several programs
   is still one skill with a section per program. The folder name is the skill
   name, lowercase with dashes, and must equal `name:` in the front matter.
3. **Find out how it runs, and doubt every claim.** Read the README, the
   scripts, the Dockerfile, the Makefile, the CI workflows (often the most
   accurate) and the contributing guide. Then test what they say:
   - "Only on another operating system": try it here anyway. A crash for a
     missing shared library is fixed by installing it, and you note the line.
   - "Needs a GPU": try software rendering.
   - "Needs a paid plan or a flag": read where the check is, and patch it for the
     local run only; write the patch down.
   - "Run `npm start`": that is the way for a person. Look for the way a program
     can drive.
4. **Run it and build the harness, writing `NOTES.md` as you go.** Keep a line
   per obstacle: the error, the fix, the command that worked. It becomes the
   Gotchas and Troubleshooting sections. Install and build; start the real app
   (a window under a virtual display, a server in the background, a terminal
   app in a pseudo-terminal); build the handle to act on it, **at the layer
   changes actually touch** (look at recent merged pull requests: if most touch
   internals, direct calls are the main entry and the full launch is secondary).
   Do one real user flow from start to finish and look at the result. Run the
   tests once as a sanity check. Stop the app cleanly.
5. **Write the skill.** Put it in `<unit>/.namzu/skills/run-<unit>/SKILL.md`,
   or in `<unit>/.agents/skills/run-<unit>/` when the person wants other coding
   agents to read it too. Save it as the person's saved skills are saved: where
   the `save_skill` tool is among your tools, use it, so the person sees the
   whole file and where it goes and confirms. Without it, show the file and
   its path and write it only once they say yes. A driver goes in the same
   folder; when the project's own tests want it, offer to move it to `scripts/`
   or `e2e/` and point the skill at the new place.
6. **Check it cold.** In a fresh shell, from inside the unit, follow the
   `SKILL.md` line by line with no improvising. Every gap you hit is a defect
   in the skill: fix it and run it again.

## The shape of the skill

Front matter: `name: run-<unit>` and a `description` that holds the words
someone would type (run, start, build, test, screenshot) and what the app is:
"Build, run and drive <unit>. Use when asked to start it, run its tests, build
it, take a screenshot of its screen, or use the running app. Not for ...".

Body, in this order, short:
1. One paragraph naming the handle (the driver) and the paths it writes.
2. A line saying paths are relative to the unit, and that a session should
   start inside the unit, because project skills are read from the folders
   above the working folder and not from those below it.
3. **Prerequisites**: the exact install line that worked.
4. **Setup**: environment variables, the scratch home, accounts that are safe.
5. **Build**, with any patch you needed.
6. **Run, the agent way**, first: the driver, its commands in a table if it
   takes commands, where screenshots and logs land (absolute paths).
7. **Run, the person's way**, second, briefly.
8. **Test**, with the result you saw.
9. **Gotchas** and **Troubleshooting**: only what you actually hit.

## Drivers worth writing, by kind of app

- **Command line tool**: usually no driver; two or three real invocations
  with their exit codes, and the stdin form. Keep the skill short and leave
  the flags to `--help`.
- **Server**: `smoke.sh`: start in the background into a log, poll readiness
  in a bounded loop, one request to the route that matters, then stop by the
  pid holding the port. Document the port, how to change it, what "ready"
  looks like, and any service it depends on.
- **Terminal app**: a wrapper that starts it at a fixed size in `tmux` or a
  pseudo-terminal, waits for a marker, sends keys, prints the screen. Give the
  keys the app understands as a table. When there are more than two wait loops,
  make a `wait_for` helper.
- **Desktop window**: a driver that reads commands from standard input and
  keeps the window open between them (launch, screenshot, click by text, type,
  press a key, evaluate, list windows, quit), run inside `tmux` so the slow
  start happens once. Points that cost hours: the first window may be a splash
  screen; the real interface may be a separate view; rich text boxes need
  focus and real key presses, not a set-value call; the app may take the
  standard input, so open it by file descriptor; use `--no-sandbox` in a
  container; patch a feature gate for the local run and document it.
- **Web app**: the dev server command and port, how to stop it, how to sign in
  with a test account, and one representative path through the `browser` tool.
  Warn about pages that never go idle and about the first slow compile.
- **Library**: the build, the tests and a short program that imports the
  public export and prints something observable; development against
  installed mode; any code generation step.

## Leave out

Anything you did not run; platform sections you could not try (say they exist
and were not tried); every option the tool has; architecture; generic advice
("check your network"). Be suspicious of these signs that the wrong thing is
about to be saved: no screenshot of a window app; an interactive app with no
driver; text that reads like the README; "not supported here" written without
trying; everything worked the first time (probably only the tests ran).

## Never

- Write the skill before you have run the app.
- Point a run at the person's real home, accounts or live services; use a
  scratch copy and test accounts, and say which.
- Save the skill or move files without the person's confirmation.
- Do anything that cannot be undone (delete data, push, install system
  packages, spend money) without asking first.

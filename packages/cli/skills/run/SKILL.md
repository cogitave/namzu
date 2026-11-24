---
name: run
description: Start the project's app and use it, to see a change working in the real thing. Use when asked to run, start or screenshot the app, "does it work?" or "try it", or before you tell the person a change works. Not for the test suite alone, and not for edits to docs or comments.
invocation: both
argument-hint: '[what to try]'
---

# Running the app

Running means launching the real app and using it the way a person would: the
command line tool at its command, the server at its port, the window on a
screen. The test suite does not count, and neither does importing a module and
printing something. Your job is to see the change working, or to see that it
does not.

$ARGUMENTS

## Steps

1. **Say what should be true.** One sentence: what does the change make true
   that was not true before? ("`export --json` prints one object per line.")
   Everything below is measured against it.
2. **Look for the project's own run skill first.** Your skill list may already
   show one. To be sure, list the descriptions of the project skills from the
   current folder up to the checkout root (the folder holding `.git`). Only
   `.agents/skills` is read from the folders above the working folder;
   `.namzu/skills` is read from the working folder alone:

   ```sh
   d=$PWD; while :; do
     for f in "$d"/.agents/skills/*/SKILL.md; do
       [ -f "$f" ] && { printf '%s\n  ' "$f"; grep -m1 '^description:' "$f"; }
     done
     [ -e "$d/.git" ] || [ "$d" = / ] && break; d=$(dirname "$d")
   done
   for f in "$PWD"/.namzu/skills/*/SKILL.md; do
     [ -f "$f" ] && { printf '%s\n  ' "$f"; grep -m1 '^description:' "$f"; }
   done
   ```

   Judge by the description, not the name: people call these skills different
   things. If one is about starting or driving this app, load it with the
   `skill` tool (if the tool does not know the name, read that `SKILL.md` with
   the read tool) and **follow it as written**: do not paraphrase it and do not
   skip a patch it asks for. If several fit and none is clearly the one (a
   repository holding many apps), ask which. If it fails on something that has
   nothing to do with your task, say it is out of date and offer
   `/run-skill-generator` to refresh it.
3. **No project skill: match the project to a pattern below.** Read the
   README, the scripts (`package.json`, a Makefile, a task runner) and the CI
   workflow, which is often more accurate than the README. The command meant
   for a person at a keyboard (`npm start`) often never returns or needs a
   display; look for the build and the entry point a program can drive.
4. **Keep the app away from the person's own data.** Give it a scratch home
   (`HOME=$NAMZU_SCRATCH/home`, and the app's own data folder variable if it
   has one), a scratch port, and test accounts only. Never point a run at a
   real account, a live service or a production database.
5. **Drive it, do not just launch it.** Starting only proves the entry point
   resolves. Go on until something a person would look at is on the screen:
   type a representative command and read its exit code and output; request the
   route the change touches and read the body; press a navigation key and
   read the screen; click and take a screenshot, then **look at it**. A blank
   frame means the launch failed.
6. **Probe around the change.** Try at least one thing next to it that could
   have broken: an input at the edge, the same flow without the new option,
   the neighbouring command or screen. The change can work and still cost
   something nearby.
7. **Run the project's own check, plainly.** Its test, lint or build command
   as a command of its own, with nothing after it that could hide how it ended
   (no pipe into `tail`, no `;` or `||` with a second command, no background
   run). The turn's record reads the exit status, and a hidden status is
   recorded as inconclusive. Skip this only when the project has no such
   check, and say so.
8. **Report one verdict, with what you saw.** *It works*: what you ran and
   what came back. *It does not*: what came back instead and where it differs
   from step 1. *It could not be exercised*: exactly where you stopped (no
   display, no credentials, a service that is not here) and what a person
   would have to do. Do not round an unclear result up. If the fallback needed
   installs, environment variables, a patch or a driver you wrote by hand, say
   so and recommend `/run-skill-generator`, so that work is kept for the next
   run; if it just worked, do not. When you describe or write such a skill,
   keep the exact commands, ports and paths that worked and never swap them for
   placeholders (`<port>`); point the person to `/run-skill-generator` for the
   saved version.

## Patterns by kind of project

**Command line tool.** Build it if it needs building, then call the real
binary: two or three invocations with the inputs the change affects. Read the
exit code (`echo $?` as its own step) and both output streams; try the stdin
form if the tool takes input. Prefer the built file in the checkout over a
global install of an older version.

**Server or API.** The lifecycle is the hard part.
- Start it in the background with its output going to a log file in the scratch
  folder, using the `bash` tool's background option so the turn is not stuck.
- Wait for readiness with a bounded poll of a health route or the port, never a
  fixed sleep: `for i in $(seq 1 60); do curl -fsS localhost:PORT/health && break; sleep 0.5; done`.
- Hit the route the change touches with `curl` and read the body.
- Record the pid when you start it (`$!` of the real server command, or of the
  node child, not of an `npm run dev` wrapper) and kill that pid. If you only
  have the port, find the listener with `ss -ltnp 'sport = :PORT'` (`lsof` is
  often not installed) or stop it with `fuser -k PORT/tcp`. Then confirm the
  port is closed. Never `pkill -f` with a broad pattern: it can match your own
  command line.
- If launch, poll and request take more than a few lines, put them in a small
  script in the scratch folder.

**Terminal app (a screen, keys, no flags to drive it).** Run it inside a
pseudo-terminal you control, so you can send keys and read the screen as text:
- With `tmux`: `tmux -L probe new-session -d -s app -x 100 -y 30 './app'`, wait
  for a marker with `timeout 20 bash -c 'until tmux -L probe capture-pane -p -t app | grep -q MARKER; do sleep 0.2; done'`,
  press keys with `tmux -L probe send-keys -t app 'text' Enter`, read with
  `capture-pane -p` (`-J` joins wrapped lines, `-e` keeps colours), quit with the
  app's own key, then `kill-session`. Use a socket name (`-L`) of your own so
  you never touch the person's sessions.
- Without `tmux`: a small Node script with `node-pty` to start the program in a
  fixed size terminal, and `@xterm/headless` to feed it the output and read the
  screen back as lines. Type slowly (a character at a time, short waits): a
  program in raw mode can lose a paste. Wait for a marker, never for a time.
- Always a fixed size, always a scratch home, always read the final screen
  once more before you say what it showed.

**Desktop window (Electron or another GUI).** A window cannot be seen headless,
so you need a driver: on Linux a virtual display (`xvfb-run -a`), the app
started through its automation hook (for Electron, Playwright's `_electron`),
and in containers `--no-sandbox`. Build the app first; the human start script
often waits forever. Prefer the project's own end-to-end harness if it has one
(look in `e2e/`, `tests/e2e`, or a `test:e2e` script): it already knows the
window, the splash screen and the right view. Click through the page by text
or role rather than by coordinates when views overlap. Take a screenshot at
the end, open it, and describe what is on it. Native extras (keychain,
notifications) usually do nothing in a container, which is fine. If the person
has a real display and asks for the app on it, computer use can drive the
visible window instead.

**Web app in a browser.** Start the dev server as above, then drive it with the
`browser` tool: navigate, snapshot, act, wait for a specific element, take a
screenshot. A page that never goes idle (live updates, long polls) needs a
wait for an element, not for "idle". The first load may compile for ten
seconds. Check the page's own error output before you declare success. Use a
local address only; a sign-in page is the person's to complete.

**Library or SDK.** Build it, then write a short program in the scratch folder
that imports the public export (the package name, not an internal path), calls
the changed function with realistic input and prints something observable.
Say whether you ran the development copy or an installed one.

## Showing the person

If they cannot open files on this machine, give them screenshots with
`present_file` instead of describing them.

## Never

- Edit, add or delete project source or tests while running. Write only scratch
  files and a driver in the scratch folder; if a fix seems needed, report it.
  The generator is the only path that saves files into the project, after a yes.
- Report a run you did not do, or call a launch a success because it did not
  crash.
- Weaken, skip or delete a test to get a pass, or call a check passing when you
  did not see its output end.
- Step outside what the person's permissions allow, or do anything that cannot
  be undone (delete data, push, install, spend money, touch a live service),
  without asking first; use a scratch copy and test accounts.
- Leave the app, a server or a virtual display running afterwards.

## Example report

> **Verdict: it works.** The change makes `export --json` print one object per
> line. I built the CLI and ran `node dist/bin.js export --json` on the sample
> folder with a scratch home: three lines, each a complete object, exit code 0.
> Without `--json` the old table still prints. `pnpm test` ran on its own and
> ended with 142 passed, 0 failed.

> **Verdict: could not be exercised.** The fix is in the upload retry. Trying it
> needs the staging bucket and its key, which are not set here. The server
> starts and answers its health route, but the retry path needs a real upload. A person
> with the key should run the sample upload and drop the connection once.

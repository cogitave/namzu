---
name: pr
description: Open a pull request for the current branch, with a description written from the actual changes. Use when the person types /pr or asks to open, create or raise a pull request. Not for committing (use commit) and not for reviewing a change.
invocation: operator
argument-hint: '[base branch, or what to stress]'
---

# Opening a pull request

Typing `/pr` is the person's request to push this branch and open a pull
request for it, and nothing beyond that. This works in a Git repository with
a remote; the pull request itself needs the GitHub command line, `gh`.

$ARGUMENTS

## Steps

1. **Check where you are.** `git rev-parse --is-inside-work-tree`, the branch
   name, `git remote -v`, and `gh auth status`. Without a repository, a remote
   or `gh`, say which is missing and stop; if only `gh` is missing, push is
   still possible and you give the person the compare address instead.
2. **Do not open a pull request from the default branch.** If you are on
   `main`, `master` or the branch the pull request would target, say so. Offer a
   branch name made from the change and make it only after the person agrees.
3. **Find the base** (the person's choice, else the repository's default
   branch) and read what the pull request will hold: `git log base..HEAD
   --oneline` and `git diff base...HEAD --stat`, then the diff itself where the
   stat is not enough. If uncommitted changes exist, say they are not in it and
   offer `commit`.
4. **Read the repository's rules** (its instructions file, a pull request
   template under `.github/`, a contributing guide) and follow them: title
   format, sections, labels, what must pass first.
5. **Write the title and body from the changes**: a title in the style of the
   log, then what changed and why in plain words, how it was checked (only
   what was really run), and anything a reviewer must know: a migration, a
   setting, a risk. If the `attribution` setting holds text
   (`namzu config get attribution`), end the body with it.
6. **Push the branch** with `git push -u origin <branch>` as its own command,
   then `gh pr create --base <base> --title ... --body ...` (pass a long body
   through `--body-file` from the scratch folder). Open it as a draft when the
   person asked for one, or when checks or work are still open.
7. **Report the address** of the pull request and nothing else of length.

## Never

- Push to the default branch, force-push, or push anything other than this
  branch.
- Put a claim in the body that was not checked, or a secret anywhere.
- Merge, approve, close or comment on someone else's pull request.
- Open a pull request on a repository the person did not name or work in.

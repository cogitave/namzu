---
name: security-review
description: Review the pending changes on this branch for security problems and write one report; changes nothing. Use when the person types /security-review, or asks for a security check of a change before it goes out. Not for style or general bugs (use review-changes) and not for scanning a whole codebase.
invocation: operator
argument-hint: '[base branch or files]'
---

# Security review of a change

Report only. You change no file and run nothing that has an effect.

$ARGUMENTS

## Steps

1. **Fix the scope.** The branch against its base (`git diff base...HEAD` plus
   uncommitted work), or what the person names. Say which, and how many files.
2. **Read what the change touches, whole**: each changed function, what feeds
   it (is the input from a person, a file, the network, another program?) and
   where its output goes.
3. **Look for the kinds of flaw that matter, only where the change can cause
   them:**
   - input reaching a shell command, a file path, a query, a template or an
     address without being checked or escaped (injection, path traversal,
     request forgery);
   - missing or wrong checks of who may do this (authentication, access to
     another person's data, a check done on the client only);
   - secrets in code, logs or errors; weak or home-made cryptography; random
     numbers where unguessable ones are needed;
   - unsafe handling of untrusted data: unpacking, deserialising, evaluating,
     redirecting, or showing it in a page without escaping;
   - permissions made wider, safeguards switched off, new network exposure,
     a dependency added or changed that nobody has looked at.
4. **Write the way it fails for each suspicion**: who can do what, with what
   input, to get what harm. Follow the code to check it. Drop what you cannot
   make concrete; do not report style, theory or "best practice" noise.
5. **Rate each finding** high (exploitable now, serious harm), medium (needs
   conditions) or low (hardening), and give a fix in one or two lines.
6. **Your reply is the report, and nothing else**: the scope, then findings
   most serious first (file and line, rating, what is wrong, the failing case,
   the fix), then what you did not read. If nothing survived, say so plainly.

## Never

- Edit files, run the code under review, or touch a live service.
- Include a working exploit against someone else's system; describe the flaw.
- Report a finding you did not check.
- Print a secret you found; say where it is.

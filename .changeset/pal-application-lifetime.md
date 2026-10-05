---
"@namzu/sandbox": major
"@namzu/cli": major
---

Change the local Pal provider's default foreground ownership from strict command
lifetime to computer lifetime. Rebuild the shipped local-computer image from this
release to use the new default. To retain the previous behavior and continue using
an existing strict image, set `normalExitPolicy: 'strict'` when calling
`createLocalVirtualComputerProvider`. A successful
foreground launcher can leave Blender or another application open without retiring
the entire computer; the application remains owned by that guest allocation until
the computer stops. An authenticated execution-reservation acknowledgment prevents
an upgraded host from silently admitting this policy against an older image.

Generic workers and registered background jobs retain strict process ownership.
Failed launchers and timed-out or cancelled commands cannot transfer live descendants;
if termination cannot be confirmed, the worker retires the allocation.
A completed launcher does not claim its surviving application has terminated.

CLI Pal computers use the same new default. Set
`NAMZU_PAL_COMPUTER_NORMAL_EXIT_POLICY=strict` before starting the CLI or desktop
host to retain their previous command lifetime and use an older strict image.

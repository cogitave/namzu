---
"@namzu/sdk": minor
"@namzu/cli": patch
---

On WSL the Windows profile's same-computer secret is now trusted only by the Linux user the Windows drive mount maps the file to (its owner id must equal the current user's); another Linux user of the same distro uses the native secret in their own home and is asked like any other machine. `ResolveSecretDeps` gains optional `fileOwner` and `uid`; a host that does not supply them gets the native copy instead of the Windows one. Before, any Linux user of the distro joined without an Allow; the old behaviour has no setting to bring it back, because it let one user admit another; each user is asked once.

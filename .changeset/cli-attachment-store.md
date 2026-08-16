---
'@namzu/cli': minor
---

Attachments persist content-addressed, over a real `@namzu/files` driver.

`@namzu/files` shipped six drivers and had no consumer in this repo — a package the estate could import and nothing here could point at. This is the pointing: the local driver, wired to the attachment seam the SDK added, in the one host that actually attaches things.

Addressed by content **and media type**, not by content alone. The same bytes declared `image/png` once and `application/pdf` later are two different claims about what they are, and the SDK's resolver refuses a ref whose stored media type disagrees with the message. Keying on bytes alone would make the second `put` return the first ref, and every message using it would then be refused — a dedup that manufactures the exact mismatch the check exists to catch.

The media type is stored in a sibling file rather than inferred, because the resolver's check needs the store to be able to *report* what it holds: a store that could only echo back what a caller claimed could never catch a mismatch. A ref with bytes and no media type resolves to nothing rather than to a guess.

`/skills` is now declined from the kernel rather than colliding with it. The kernel's version lists what a registry holds; this host's discovers skills from disk, marks which are active, and shows a refused one with its reason. Both are correct for their audience. `HOST_OWNED_COMMAND_NAMES` names each such case in writing — deliberately a list of exceptions rather than a precedence rule, since first-wins or last-wins would make an *accidental* collision silent, which is what the collision error exists to prevent.

---
'@namzu/sdk': major
---

Removes `ToolCatalogSurface` and `ToolsetPolicy.surfaces`.

Both were deprecated in 3.2.0 and shipped deprecated again in 3.3.0, so the
window SemVer asks for — at least one minor release in which working code
compiles and warns — has been served twice. The deprecation said "slated for
removal in the next major"; this is that major, and letting it pass would move
the promise to 5.0.0.

Nothing produced or read either one. No code constructed a member of the
union, and `surfaces` was the only field carrying it and was never consulted,
so there is no runtime behaviour to change and no working code to migrate:
setting it did nothing before and the field is gone now. Under this repo's
release rule that is the case where a removal may go straight to major, and it
is being said here as that rule asks.

It was also the wrong axis. Which tools a run may use is already expressible
four ways, all per-run and dynamic where this was fixed at definition:
`allowedTools` on the query, `ToolAvailability` (`active` / `deferred` /
`suspended`) with mid-run activation, `runtimeToolOverrides`, and capability
negotiation stripping tools a driver cannot carry. If you set `surfaces`,
`allowedTools` is the replacement — it says the same thing per run.

`SharedRunWorkspace` is unchanged and stays exported without an SDK-side
caller. That is deliberate and now documented on the class: its config asks for
a host filesystem root and the path an agent will see, which is a deployment
shape the kernel does not own. `runtimeRoot` and the paths `refs()` derives
from it are the contract.

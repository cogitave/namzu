---
'@namzu/sdk': minor
---

A web connector seam: a guarded fetch provider, and no bundled search vendor.

Two providers, separated on purpose. **Fetching a URL is a capability this kernel can implement** — the rules are about the network and the same everywhere, so a wrong answer is a defect rather than a preference. **Searching is not.** Every search backend has its own account, its own terms, its own result shape and its own opinion about what a result is, and picking one here would make that choice for every consumer while adding a dependency nobody asked for. `WebSearchProvider` is declared and ships with no implementation; that asymmetry is the design, not an omission.

`GuardedFetchProvider` exists because a URL a model chose is untrusted input reaching the network stack, and the network the agent runs on is not the network the model is thinking about. `http://169.254.169.254/` is a cloud metadata endpoint holding credentials; `http://localhost:6379/` is whatever the host runs on 6379; `file:///etc/passwd` is not even the network.

What it does, and why each one:

- **Refuses before sending.** A response already fetched is a request that already happened, and against a metadata endpoint the request *is* the exfiltration.
- **Resolves the hostname and checks the addresses**, not just the name. A name whose A record points inside is something anyone can set up on a domain they own. A resolution that fails, or returns nothing, is **refused** — treating either as "no private addresses found" is fail-open.
- **Re-checks every redirect hop**, with `redirect: 'manual'`. Checking once and letting the platform follow is the classic version of this bug: a permitted page answers `302 → the metadata endpoint` and the guard never sees it. Relative `Location` headers are resolved against the current URL, or the URL checked would not be the URL followed.
- **Strips `authorization`, `cookie`, `host` and `proxy-authorization`** from caller-supplied headers, case-insensitively. A tool argument is model-authored, and those turn "fetch this page" into "fetch this page as me".
- **Reports truncation** rather than returning a cut page as whole, and reports the whole redirect chain so a citation can name where content came from.

`allowPrivateAddresses` exists for the one legitimate case — a fixture on `127.0.0.1` — and defaults off, so it is a decision a host makes rather than inherits. The residual DNS-rebinding gap is stated in the source: closing it needs a `fetch` that pins the address it checked, which the platform gives no way to do, so a host that needs it supplies its own.

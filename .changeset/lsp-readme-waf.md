---
'@namzu/lsp': patch
---

Stop the README from making the package unpublishable.

A paragraph documenting the tool's path-containment boundary named a traversal path literally. npm's registry sits behind a WAF whose managed rules match path-traversal signatures in a request body, and `npm publish` sends the README as part of that body — so every publish of this package was rejected with a generic `403 Forbidden` about permissions, from CI and from a maintainer's machine alike. The prose is the payload; the text now describes traversal without spelling one, and says so in place so nobody puts it back.

This is why `@namzu/lsp` has no released versions before `0.2.0` despite being in the repository since 2026-08-16.

---
"@namzu/sdk": major
"@namzu/cli": major
"@namzu/sandbox": major
---

Make glob scope explicit and bound filesystem discovery while it runs. Bare `*` and `*.ts` now search only the selected directory; use `**/*` or `**/*.ts` to recurse. Wildcard searches exclude hidden entries by default; set `include_hidden: true` to retain searches that previously included them inside a sandbox. Glob returns regular files only and skips symlink entries during enumeration; authorized local root aliases remain supported. Its execution deadline changes from the generic 120 seconds to 15 seconds, so large searches should use a narrower directory or pattern.

Glob now uses the optional `Sandbox.walkFiles` capability instead of collecting a complete recursive `listFiles` inventory. Custom sandbox adapters must implement `walkFiles` to support builtin glob; unsupported adapters receive an explicit failure without a host fallback. Local, Docker, ACI and Firecracker adapters implement bounded incremental enumeration. `SandboxWalkFilesOptions` and `walkFilesViaExec` are exported for adapter authors. The sandbox package now requires the matching SDK major through its peer dependency because it imports this new runtime helper.

Result and traversal limits produce explicit incomplete-search metadata and preserve available matches. Patterns are limited to 4,096 characters and 256 brace expansions, with consistent hidden-file matching in grouped alternatives. Sandbox search paths are resolved once, fixing duplicated absolute paths in glob, grep and ls. Runtime guidance permits direct reads of known paths, and the CLI tool label now shows both the glob pattern and directory.

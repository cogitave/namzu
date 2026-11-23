---
'@namzu/sdk': minor
---

New: `PresentFileTool` (`present_file`) hands finished files to the person. Each path must be a regular, readable file inside the work folder, an added directory or the scratch folder; folders, missing files, paths outside and links that lead out are refused with a reason, and the good paths are shared. The result reports a new tool fact, `{ kind: 'shared', files, caption? }`, so `ToolFacts` gains a member: a host that switches over `facts.kind` with no default branch should handle `'shared'` (or fall through) to keep compiling. The tool is not in `getBuiltinTools()`; mount it where the person can open the files. `PresentedFile` is exported as a type.

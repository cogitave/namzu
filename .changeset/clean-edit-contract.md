---
"@namzu/sdk": major
"@namzu/cli": patch
---

Replace the built-in filesystem mutation contracts with one strict canonical
shape per tool: `edit` accepts `path`, `old_string`, `new_string`, and optional
`replace_all`; `write` accepts `path` and `content`. Remove line insertion and
legacy aliases, serialize same-process mutations by resolved path, and document
replay-safe marker advancement for bounded long-document writes. Local writes
commit through same-directory temp files and atomic rename; sandbox
implementations are required to provide the same atomic replacement contract.

---
"@namzu/cli": minor
---

The permission prompt is the box an operator already knows from other coding agents: a title naming the operation (`Bash command`, `Edit file src/x.ts`, `Start 4 agents`), the operation in its plainest form — the command without quotes, the change as a coloured diff — one question, and three numbered answers with a cursor on `Yes`. `↑↓` move the cursor, `Enter` confirms the highlighted answer, `1`–`3` answer directly; `y`, `a`, `n`, `esc`, `ctrl+c` and `d` (exact input) keep working. **Enter now confirms**, where it previously did nothing: the settle window that already guards `y` and `a` guards it too, so an Enter in flight when the prompt appears still decides nothing. Paging a long operation moved to `PgUp`/`PgDn`/`Home`/`End`.

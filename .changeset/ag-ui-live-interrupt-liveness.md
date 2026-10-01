---
"@namzu/ag-ui": patch
---

Keep questions and frontend tool calls answerable when live tool-start,
progress or question-park events arrive around the interrupt boundary. The
adapter now expires a wait on evidence that its own call or turn ended,
rather than on any unread native event. Buffered events retain their order on
resume, and existing client-answer deadlines and cancellation remain in effect.

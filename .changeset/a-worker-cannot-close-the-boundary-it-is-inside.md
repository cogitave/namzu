---
'@namzu/sdk': major
---

A delegate's output is framed as untrusted material on every path the model reads it, and it can no longer end the frame early

Blocking `create_task` and `wait_for_task` wrap a worker's text in the
`<namzu-untrusted>` envelope. Two other paths carried the same bytes and did
not: the completion notification injected into the transcript, and
`agent_task_list`'s rendered output. So whether a worker's words arrived as
material or as the parent's own reasoning depended on how the model happened to
fetch them — and the two unframed paths are the ones reached when a wait was
abandoned, which is when a run is already off its expected course.

Worse, the notification's own delimiter was forgeable. Measured: worker output
containing `</task-notification>` produced two closing tags in one message, with
attacker-controlled text sitting outside the first — reading as ordinary
transcript rather than as a delegate's material.

**What changed on the wire the model sees.**

- The notification now nests a `<namzu-untrusted kind="agent-result">` block
  inside `<task-notification>`. Kernel metadata (`task_id`, `agent`, `state`,
  `duration_ms`) stays OUTSIDE it — framing this kernel's own statements as
  untrusted would tell the model to discount the only part of the message it
  can rely on — and so does the truncation notice, which is an instruction
  about how to fetch the rest.
- `agent_task_list` wraps each finished task's output the same way, with the
  same `agent` and `task` attributes the blocking path uses.
- Both delimiters are defanged inside worker text, case-insensitively. The
  replacements (`task_notification`, `namzu_untrusted`) share no substring with
  the tokens they replace — a replacement that still contains the token is found
  again by a second pass or by any looser matcher downstream.
- A truncated notification is about 600 characters longer than before. The cost
  is fixed, not proportional to the output.

`data.result` on both tools is unchanged, so a host reading results
programmatically is unaffected. If you match on the model-facing text of either
tool, expect the envelope.

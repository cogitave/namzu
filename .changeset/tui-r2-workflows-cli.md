---
'@namzu/cli': minor
---

Workflows: the word "workflow" in a message no longer offers the workflow tool silently. It is now a `workflow` composer trigger with the same matching rules as `hypermode`: a tag appears under the message box, Alt+W drops it, and a question that only mentions workflows suggests it instead of arming it. `composerTriggers.builtin.workflow` accepts `arm` (default), `suggest` or `off`; `/workflow <task>` is unchanged. The Turkish phrase "iş akışı" no longer offers the tool by itself; use `/workflow` or the word `workflow`. Also: the detail shows the script's last `log()` lines, a phase whose agents were all skipped shows `✘`, the footer counts `1 workflow` instead of an agent, `/workflows` gets its own footer (`enter to view · x to stop · esc to close`) and a `N running, M finished` subtitle, a script failure reads as one plain sentence, and each workflow agent's prompt states its step is the assigned job.

The workflow completion line now writes durations with the same formatter as the rail (`2m5s`, not `2m 5s`), and the tool description tells the model that `parallel()` and `pipeline()` never reject and that failed entries are `null`. The bare word "workflow" offers the tool only from the composer trigger or `/workflow`; queued and steered sends to a running child do not carry it, since a child does not start workflows.

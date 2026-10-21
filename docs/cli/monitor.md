---
type: Reference
title: Monitors in the CLI
description: How the CLI mounts the monitor tool, how a monitor's events wake an idle terminal session, what a single-shot run does while a monitor is still watching, what ACP and Desktop do with events, and how monitors are counted and listed.
resource: packages/cli/src/integrations/monitors/inbox.ts
tags: [cli, jobs, monitor, background]
status: stable
generated: { by: claude-code/sonnet-5.5, at: 2026-10-21T00:00:00Z }
---

# Monitors in the CLI

The SDK's [monitor tool](../sdk/monitor-tool.md) turns each stdout line of a long-running command into an event the model reads while it keeps working. This page is what the CLI does around it: where it is mounted, who listens for events between turns, and how a monitor looks to the person.

# Mounting

Every session that has a job registry offers `monitor` **deferred**, as it does `code_analysis`: the model finds it with `search_tools`, and its schema is not sent on turns that never watch anything. That covers the terminal, `exec`, `exec --json`, ACP and Desktop (which runs through ACP). Setting `NAMZU_DISABLE_BACKGROUND_TASKS` removes it, as it removes background `bash`. There is no separate switch. A sub-agent does not get it; a Pal conversation does not either, because a Pal has no host that wakes on events. A single-shot run lowers the longest watch to 10 minutes (`monitorTimeoutCapMs`), since it waits for its monitors before it exits.

# What waits for the next turn

The kernel puts an event on the next tool result of a running turn and says which events it delivered. Anything else, an event that arrives between turns or after a turn's last tool result, would be lost, so the session keeps it in a ledger (`createMonitorInbox`), filled for the session's whole life from the job registry. The ledger holds the kernel's own system-event text (`formatMonitorEvent`, `formatMonitorEnd` from `@namzu/sdk`, not a copy), with the watched command's output inside the untrusted frame, and an event leaves it exactly once: when the kernel acknowledges it, or when a host takes it. An acknowledgement that arrives before the event is remembered, so subscription order does not matter.

The ledger hands over whole events only, bounded by the kernel's own `capMonitorNotifications`. If more is waiting than one notification may hold (100,000 characters), the middle events are dropped and the text says `[N monitor events omitted — output exceeded the notification limit]`, exactly as an in-turn delivery does; everything pending is handed over together.

# Each host

| Host | What a monitor event does |
| --- | --- |
| Terminal | An idle session starts a turn by itself, as it does for a workflow that ended; the model reads the events and answers without the person typing. A running turn gets them on its next tool result. Events that arrive while a person's message is queued ride with that message. |
| `exec`, `exec --json` | After the main turn, while the session still owns a running monitor, the run waits for it to speak or end (the registry tells it; nothing polls), gives the model what arrived as one message, and lets it reply. It does this once per arrival, at most eight times with the workflow reports, and exits when no monitor is left. The printed answer is the last reply's. |
| ACP and Desktop | ACP starts no turn of its own, so events that arrive between prompts wait and ride with the next prompt as context. A monitor started in a turn still reaches that turn's tool results. |

A stop the person asked for is reported with the next turn but starts none.

# What the person sees

- There is no transcript row per event; a chatty log would drown the conversation.
- When a monitor ends, one quiet row says how, in the words the model was told (`Monitor "<description>" stream ended`, `... stopped`, `... script failed (exit N)`), or that it ran out of time or printed too much.
- The footer counts monitors apart from shells in the same item (`2 shells · 1 monitor`).
- `/jobs` lists a monitor as `Monitoring: <description>` with its state, and `x` stops it. The detail screen says what it watches and shows the output the monitor retained, stderr included, which is not an event.
- Desktop shows the same label on the job row, with a stop button and the same quiet style as any other job.

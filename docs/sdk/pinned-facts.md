---
type: Reference
title: Pinned facts
description: How a tool puts a fact into the run's working memory by key, so it is in front of the model every iteration and survives compaction — the ToolResult field, the MCP resource type, the budget, and how it differs from the extractor and the memory store.
resource: packages/sdk/src/compaction/manager.ts
tags: [sdk, compaction, memory, tools, mcp]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-05T00:00:00Z }
---

# Pinned facts

The working-memory slot is the one message compaction never drops: the run's task, plan, decisions, failures and discoveries, extracted from tool calls by rules and rendered at the top of the history every iteration. Until now only the extractor wrote to it, and the extractor guesses from tool names. A tool that *knows* something — what its controls do, where the piece is, which moves have already failed — could only say so in its output, where the next compaction pass could evict it and the model could forget it.

A pin is a fact a tool states, by key.

## From a tool

`ToolResult.workingState` is a list of `{ key, text }`. The executor pins each into the run's working state under the tool's name; a later pin under the same key replaces the earlier one, and an empty text unpins. Pins render as their own section, `## Pinned by tools`, in the working-memory slot, and travel with the state through checkpoints.

## From an MCP server

A server pins by returning a `resource` content block whose `mimeType` is `application/vnd.namzu.working-state+json` (`WORKING_STATE_MIME`) and whose `text` is a JSON array of `{ key, text }`. The block is not shown to the model as text; malformed JSON is ignored. Everything else in the result is handled as before.

## Budget

At most 40 pins, each at most 600 characters; past the budget the oldest pin is dropped and the section says how many were. A pin is a fact, not a document: a tool that wants to hand the model a page writes a file and pins its path.

## What it is not

- Not the extractor: rule-based guesses from tool names stay as they were, and a pin never replaces them.
- Not the memory store: `save_memory` is durable across runs and searched on demand; a pin lives for the run and is always in view.
- Not `assistantNotes`: those are the model's; pins are the tool's.

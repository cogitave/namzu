---
'@namzu/cli': minor
---

Two new switches, both on by default, so nothing changes until you turn one off (your own or managed config only; a project file cannot set them). `memory.fromConversations: false` stops memory being written from conversations: nothing is promoted when a turn ends or at compaction and `compaction.consolidate` writes no record; memory you save yourself and recall are unchanged. `memory.searchPastConversations` controls the new deferred tool `search_past_conversations`, which finds excerpts in this project's earlier, unarchived conversations through the session index (never another project, a Pal or a child session; tool output is not quoted). With it on, the tool listing gains one name line, and excerpts from past conversations are sent to the model when it searches. To keep the listing as it was, set `memory.searchPastConversations: false`; the prompt and tool list are then identical to before.

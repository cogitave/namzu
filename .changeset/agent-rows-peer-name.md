---
'@namzu/cli': minor
---

In `namzu workspaces`, each agent row now shows its workspace and tab on the first line and the session's name on the second, and the name is what the session's terminal calls its conversation: the one you gave it with `/rename`, else the one the small model wrote. The same name is the terminal's title in the live peer record, so `list_sessions` and the header of a message from it use it too, and two terminals in one folder no longer look alike. A session with no name keeps its `session N` label, and a record with no name is still titled by its folder.

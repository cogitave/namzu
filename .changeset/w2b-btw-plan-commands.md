---
'@namzu/cli': minor
---

New slash commands. `/btw <question>` asks a quick side question while the main work goes on: the small model answers from the recent conversation without tools, and the question and answer are shown once without being added to the conversation. `/plan [description]` switches the conversation to plan mode, and a description is sent as the next message. Built-in commands win over user commands of the same name, so a user command file named `btw` or `plan` no longer runs; rename the file to keep using it.

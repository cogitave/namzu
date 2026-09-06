---
"@namzu/cli": minor
---

Add `/help <command>` to read usage and availability without running the command. `/help /permissions` also works. Bare `/help` keeps its command picker. Local commands explain their supported arguments, kernel commands retain their registered hints, and custom commands show their full source path and whether arguments are accepted without expanding the saved prompt. Help uses the same command precedence as execution.

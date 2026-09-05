---
"@namzu/cli": minor
---

A tool server may be given its own connect deadline. `mcpServers.<name>.connectTimeoutMs` bounds how long that server has to connect, hand shake and list its tools; the default stays 10,000 ms. The default is sized for a wedged server, and a server whose first spawn is genuinely slow — a Python SDK server cold-boots in 15-20s on some machines — was a working server the CLI refused, stopping a headless run before its first turn with `did not answer within 10000ms`. A value that is not a positive number is refused with a reason rather than silently defaulted.

---
'@namzu/cli': patch
---

When Desktop asks for the settings and your user config.yaml is not valid YAML, the error now names the file, line and column ("<file> isn't valid YAML (line 2, column 5).") instead of the parser's raw text. The command line's own wording is unchanged. The Web search, Mouse, Sign-in detection and allowed plugin scopes descriptions now start with a capital letter.

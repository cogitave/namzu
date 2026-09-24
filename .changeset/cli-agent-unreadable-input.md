---
'@namzu/cli': patch
---

A cut-off or malformed `Agent` call is no longer answered with advice about writing files. The tool declares `prompt` as its one long argument, so a call cut off by the output limit is told to keep `prompt` under 12000 characters. Either kind is told to put long material in a file and name it in the prompt.

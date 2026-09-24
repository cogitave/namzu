---
'@namzu/cli': patch
---

A cut-off or malformed `Agent` call is no longer answered with advice about writing files. The tool declares `prompt` as its one long argument, so a call whose prompt filled the response when the output limit cut it off is told to keep `prompt` under 12000 characters and to put long material in a file and name it in the prompt. A malformed call is told only to send valid JSON.

---
'@namzu/cli': patch
---

A cut-off or malformed `Agent` call is no longer answered with advice about writing files. The tool declares `prompt` as its one long argument, so a call whose prompt filled the response when the output limit cut it off is told to keep `prompt` under half of what arrived, or under 12000 characters when that is less, and to put long material in a file and name it in the prompt. A call cut off by a stream that ended is told 12000 characters. When most of the response went to reasoning, or to what came before the call, the call is told that instead, with no budget. A malformed call is told to send valid JSON and how to write a newline, tab, quote or backslash inside the `prompt` string, with nothing about files or size.

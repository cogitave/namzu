---
"@namzu/sdk": patch
---

`computer_use` clicks and drags with the left button when a call leaves `button` out, instead of refusing the call (a model asked to click the Start button sent no button and spent a round trip on the refusal). Its description now tells the model to batch the steps it can predict but to look before typing into a window a step should have opened, and, on Windows, that a shell command is the surest way to start a program (Start-menu search on a non-English Windows turned an English program name into a web search in the browser).

With a host that lists windows (the Windows cua-driver backend), `type_text` and `key` are refused while a terminal is in front: in a real session a key chord that did not open the Run dialog sent "notepad" and ENTER into the user's own terminal and submitted what they were typing. A call that types into a terminal on purpose now fails with that reason; bring the target window to the front first, or run the command through a shell tool. With a host that reads controls, the first screenshot says so. No change is needed on your side.

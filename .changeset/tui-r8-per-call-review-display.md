---
'@namzu/cli': patch
---

When you answer No to a tool call and the turn stops, the conversation now ends with one dim "Interrupted · What should Namzu do instead?" row (Ctrl+C at a question leaves the same row), lists the stopped calls in the order the model made them, and draws the declined call's dot in the error colour. The No option reads "No, and tell Namzu what to do differently (esc)" again, and `tab say why` stays on the hint line in narrow terminals. A connector tool call reads `slack · post(hello)` with a few words of the request instead of its raw input, and its result shows what the server said without the wrapper text meant for the model.

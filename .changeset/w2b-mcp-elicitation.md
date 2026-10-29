---
'@namzu/sdk': minor
'@namzu/cli': minor
---

A tool server on the earlier protocol revision can now ask you for a short form, and Namzu answers it. New optional `MCPClientConfig.onElicitation` (with the types `MCPElicitationRequest` and `MCPElicitationResult`) makes an `MCPClient` declare form-mode elicitation on its handshake and hand each `elicitation/create` request to your handler; without it nothing is declared and requests are refused as before. In the CLI, interactive sessions show each form field on the question card, check the answers against the field's limits and ask again when one does not fit; headless runs never tell servers they may ask. A request to open a link (URL mode) and the newer revision's input requests are still not answered. Nothing to change to keep working; a server that used to be refused may now show a card.

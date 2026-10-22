---
'@namzu/cli': minor
---

External tool servers no longer fill the model's context before the first message. When the connected servers' tool definitions (name, description and input schema) come to 10% of the turn model's context window or more, they are offered by name and the first sentence of their description, and the model loads a tool's full definition with `search_tools` before it calls it. This is the reference client's automatic tool search with the same threshold, measured at 2.5 characters per token. A large server such as REA (207 tools, about 792,000 characters) used to make every message fail on a 200,000-token model with "This conversation is too long for the model". That failure is gone.

What changes for you: below the threshold, nothing. Above it, the model makes one `search_tools` call the first time it uses a server's tool, and that tool stays loaded for the rest of the conversation. The decision is made per turn, so switching to a smaller model can defer tools a larger one carried. To keep a server's tools loaded up front, keep their definitions under the threshold, for example with the server's `allow` list.

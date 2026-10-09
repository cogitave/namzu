---
"@namzu/desktop": patch
---

A reply that stops on a provider error such as a 502 is no longer a dead end. Without a token limit (the Desktop default) Try again sends it as a new request in the same conversation. If the conversation cannot repeat it, Continue without this reply closes the stopped reply and puts your message and its files back in the message box, not sent; if even that fails, Copy to a new conversation carries them to a new one. Details names the provider's answer once ("502 Bad Gateway") and says how many requests have unknown usage, with no receipt wording.

Also: Send is visibly disabled with "Connect a provider to send" when nothing is connected, and Send or Enter lead to the Connect a provider card; the Zen row says "Free models. Needs a free Zen key." with Add key and Get a free key (Namzu counts a provider only once a key is saved); the engine error notice sits below the tab strip instead of over it.

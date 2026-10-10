---
"@namzu/desktop": patch
---

After a reply stops on a provider failure (a rate limit, a 5xx, a rejected key), changing the model and sending a message now works. Before, the Send button stayed disabled with no word why, and Try again repeated the reply on the model that had just failed. Sending a new message closes the stopped reply (the same durable close as Continue without this reply) and runs on the model you chose; Try again runs on the chosen model and reads "Try again with *model*" when it differs; the transcript keeps "You continued without this reply." under the stopped reply. A reply waiting for your approval is still not closed by sending.

On a slow machine the first message of a conversation could also leave a raw "SupersededConversationSettingsError" banner and a model button that read "Not available"; the list is now read again once the model change is done.

The browser's own harmless "ResizeObserver loop" note is no longer recorded as a renderer failure in the desktop log.

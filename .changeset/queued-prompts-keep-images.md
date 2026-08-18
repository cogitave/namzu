---
'@namzu/cli': patch
---

Preserve pasted images when a prompt is submitted while another turn is running.

All model-bound prompts now enter one FIFO queue, and the queue carries the
complete text-and-image submission into both the provider request and durable
conversation. This also prevents a new idle-edge submission from bypassing an
older queued prompt while the queue-drain effect is being scheduled. Switching
conversations discards pending prompts even when the old turn settled behind
the picker before the queue pump could start them.

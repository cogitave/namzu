---
'@namzu/cli': major
---

Which stored memories go with a message is now chosen by the small model, not by shared words alone. Up to 16 candidates are shown to it (titles and descriptions, no bodies) and it picks up to three, or none; the `Used N memories` row shows why each was chosen. Where no small model is available (the side route would be the conversation's own model) or it does not answer within two seconds, recall falls back to the words, and a memory must now share two words of your message, not one, to be added. Set `memory.select: off` in your own config (a project file, or a profile in one, cannot set it) to keep the earlier behaviour exactly. With it on, the small model sees your message and memory titles, on your own provider.

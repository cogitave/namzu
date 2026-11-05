---
'@namzu/computer-use': patch
---

On Windows, the agent's cursor and the frame around the window it is working in look and move like part of a modern app. The cursor is a smooth green arrow with a soft shadow that stays the same size on a 150 % or 200 % display; it fades in the first time it appears and glides to each spot along a gentle curve, a little longer for a longer trip. A click makes it dip and send out a round ripple, and typing sends out a smaller, softer one. The frame is a smooth rounded outline with a soft glow inside it that breathes slowly while the agent is active and fades out with the cursor, in place of the old dotted square edge. It also stops redrawing when nothing is moving. Nothing changes in how you turn it off (`presence: false` or `NAMZU_COMPUTER_USE_PRESENCE=off`) or in what the model sees: the overlay is still left out of every screenshot.

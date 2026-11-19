---
'@namzu/cli': minor
---

Typing `!` as the first character of an empty message box now shows a shell state while you type, not only after Enter. Both rules of the box and a bold `!` mark take Namzu's green (the blue accent in the colour-blind themes, the terminal's own green in the 16-colour themes), the placeholder goes away, and a hint row under the box says the line runs as a shell command. Backspace on the empty line or Esc leaves it. A pasted line that begins with `!` enters it too, and a shell line recalled from history comes back in shell mode. A line is still sent as `!` plus the command, so nothing changes in how it runs. A `!` typed after other text stays an ordinary character.

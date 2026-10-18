---
'@namzu/cli': patch
---

A message typed in Namzu Desktop while a reply is running now reaches that reply at its next model request, as the terminal does. Before, the desktop host reported live input as unavailable for the whole of every turn, so each such message silently waited for the reply to finish. Nothing to change on your side.

---
'@namzu/desktop': patch
---

Messages typed while Namzu is replying now wait in a tray joined to the top of the message box, one row per message in the order they will be used, instead of a "queued" list above the box. A row sent into the running reply says "Sending to this reply" and leaves the tray the moment the model receives it; one held back says "After this reply". Each row has Send now (stops the reply and runs it at once), Edit and Remove. Edit opens the message in place and keeps its position: Enter saves, Shift+Enter adds a line, Esc cancels. Press the up arrow in an empty box to edit the newest waiting message, and Tab to hold what you typed for after the reply. The "Queue message" text button is now an icon.

---
'@namzu/cli': minor
---

Image, document and pasted-text markers in the input box (`[Image #1]`) are now one unit and look like objects. The cursor steps over a marker in one key and never rests inside it; Backspace, Delete, Ctrl+W, Ctrl+K, Ctrl+U, word jumps and undo take all of it or none, so an edit can no longer break a marker and silently send the message without its image. A marker is drawn in the theme's system-text colour (its brackets still show it with colour off); text that only looks like one, with no attachment behind it, stays ordinary text.

Image and document numbers now run through the whole conversation and continue after a resume, where they used to restart whenever the draft was empty. The sent message keeps each marker where you put it, in the row and in the text the model receives (a message that is only an image now reaches the model as its marker, such as `[Image #1]`, beside the image; it used to be empty text), so "compare [Image #1] with [Image #2]" is no longer sent as "compare  with ". Under the message, one quiet row per attachment shows its marker, file name and size in place of "N attachments", and where the terminal takes hyperlinks that row opens a copy of the file. A resumed conversation draws the same rows.

The copies are written to `attachments/` inside the conversation's own folder under your Namzu home, named by a hash of the bytes, so the same image attached twice is one file and deleting the conversation deletes them. Nothing changes for the model's image blocks or for how a long paste is held and sent.

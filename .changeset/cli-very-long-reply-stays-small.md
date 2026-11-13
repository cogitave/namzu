---
'@namzu/cli': patch
---

A very long reply no longer ends the program. A reply of about 130 KB (a code block of 2,000 lines) on the default screen made the process grow to several gigabytes and stop with "JavaScript heap out of memory"; the cause was that the screen was drawn with React's development build, which keeps a copy of the props of everything it draws (a reply's text among them) for ever, so memory and work grew with the square of the reply. The program now runs the production build. A reply of 1 MB, of code or of prose, finishes on the default screen and in the fullscreen view (`tui.fullscreen`); in the fullscreen view a long reply of many paragraphs was also laid out again block by block at every piece and no longer is. What is drawn is unchanged, with syntax colour on or off. Nothing to switch off, no setting added and no limit introduced.

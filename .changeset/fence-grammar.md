---
'@namzu/cli': patch
---

A code block in a reply is recognised the way models write it. Before, a block opened with a language such as `c++`, `objective-c` or `f#`, with a title or attributes after the language, with tildes (`~~~`), with four or more backticks, or indented under a list item or inside a quote was drawn as prose, with the fence lines on screen and the code wrapped like a sentence, while `/copy` already offered it as code. Now all of these are code blocks, drawn at the indentation they were written at (under their list item), in the default screen and in fullscreen, while the reply is written and once it is finished. Nothing is drawn beside the code. A reply that used none of these forms looks the same. There is no setting for this: the old drawing was a misreading, and the text of the reply is not changed.

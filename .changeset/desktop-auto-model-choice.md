---
'@namzu/desktop': patch
---

The composer's model picker can offer **Auto**, which picks a model for each task. It appears only when your Namzu config has a `routing` block and a `decision` model, and Desktop remembers the choice per conversation. Choosing a model by hand turns Auto off for that conversation. Pals and external engines never offer it. Without a `routing` block nothing changes.

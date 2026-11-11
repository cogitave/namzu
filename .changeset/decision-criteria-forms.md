---
'@namzu/cli': patch
---

A decision model that answered 400 on its connection test (for example `questions.q.criteria: expected object, received string`) now connects, and decision points that pass guidance (routing, memory, notifications, skills) work on it. A yes/no question's guidance is now sent in the object form the services publish; a model that still refuses it is asked once more with the guidance written into the question, and Namzu remembers that for the session. A model that refuses both reads "the model does not work with Namzu's questions" followed by one line of path and message instead of the raw error. `@namzu/decision` is private and ships inside this package, so only `@namzu/cli` is named.

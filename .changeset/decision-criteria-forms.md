---
'@namzu/cli': patch
---

A decision model that answers 400 to the plain-sentence `criteria` of a yes/no question (for example `questions.q.criteria: expected object, received string`) now works: Namzu asks again in the object form and then with the sentence folded into the question, remembers what worked for the session, and the connection test and every decision point (routing, memory, notifications, skills) get their answers. A model that refuses even that reads "the model does not work with Namzu's questions" followed by one line of path and message instead of the raw error. Models that take the sentence are unchanged. `@namzu/decision` is private and ships inside this package, so only `@namzu/cli` is named.

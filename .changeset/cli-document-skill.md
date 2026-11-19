---
'@namzu/cli': patch
---

A new built-in skill, `document`, writes a document, report, brief or plan as one Markdown file in the project: a title, a date line, short sections, lists and tables where they help, and a file name taken from the title. The reply links the file once and ends with the assumptions it made and the questions still open. Word, PDF, slide and spreadsheet files are not made yet; the skill says so and writes Markdown. To turn it off, set `skills.builtin: false` or add `document` to `skills.disabled`; a skill of the same name in your own folder replaces it.

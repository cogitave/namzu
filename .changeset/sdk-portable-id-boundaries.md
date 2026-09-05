---
"@namzu/sdk": major
---

Checked `as*Id` constructors and deprecated `parse*Id` functions now accept a canonical UUID or the expected legacy prefix followed by a nonempty suffix containing only ASCII letters, digits, underscores or hyphens. Prefix-only ids and suffixes containing path separators, periods, colons, whitespace or Unicode now throw. `DiskSessionStore` also validates caller-supplied project, session and sub-session identifiers, including `CreateSessionParams.id`, before resolving them.

Factory-generated ids and safe custom ids retain their existing values. Applications using other custom ids must replace them and update every referring record before upgrading. Existing message-feedback records with unsafe custom ids are also rejected without rewriting their files; export those records using the previous SDK and remap references together, or retain the previous SDK for that data. Do not sanitize ids independently: distinct ids can collapse to the same value.

User questions and tool pauses without a durable recorder now receive separately generated checkpoint ids. Provider-issued tool-use ids and pause names still identify the question verbatim; hosts should correlate answers using `questionId` rather than deriving it from the fallback checkpoint id.

---
"@namzu/sdk": minor
"@namzu/cli": patch
---

Automatic conversation recall now labels selected passages and visible-source
references with their producer kind. Prior assistant statements are identified
as claims rather than proof of observed file state or successful actions.

Within the existing candidate and context limits, selection keeps the best
lexical match first and then considers matching records from other producer
kinds before repeating a kind. This prevents repeated model claims from taking
every slot when a tool record is available. Derived summaries remain last.
Archive bytes, explicit search/read tools and access boundaries are unchanged;
these labels and ranking do not establish truth or independent corroboration.

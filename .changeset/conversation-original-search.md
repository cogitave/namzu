---
"@namzu/cli": major
---

New `search_conversation` calls now exclude successful outputs of `search_conversation` and `read_conversation` by default. Previously, explicit searches included them and could find their own earlier results as repeated evidence.

To keep the previous unfiltered behavior or inspect retrieval outputs themselves, pass `includeRetrievalResults: true` on a new search. Omit the option when continuing a cursor: its source filter is preserved, and incompatible changes are rejected. Failed retrievals and records with unknown tool names or success status remain searchable. Exact reads of known authorized records remain available. SDK evidence-source defaults are unchanged.

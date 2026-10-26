---
"@namzu/cli": patch
---

`read_conversation` no longer answers every failure with the same sentence. An offset inside a multi-byte character reads from that character, an offset past the end returns an empty complete page with `totalChars`, a record with no character index reads from the start, and an expired cursor restarts from the `seq`/`part` address; the page's new `note` says which. Other failures now name the cause and the next step (the highest retained `seq`, the parts that hold text, search again after a changed log, repeat the original offset with a cursor). Ownership and integrity checks are unchanged. Nothing to do on upgrade.

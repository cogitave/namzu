---
"@namzu/sdk": patch
---

Compare actual error/output/content fingerprints before refusing identical failed calls. Different errors restart the streak, and a successful potentially mutating execution allows a new check after repair. Denied calls and unrelated reads cannot reset the guard. Repetition advice no longer claims an unobserved future result is certain.

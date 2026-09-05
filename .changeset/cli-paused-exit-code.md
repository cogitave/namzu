---
"@namzu/cli": minor
---

`namzu run` exits 75 when the provider paused the run, and no longer 1. A pause — a rate limit, an outage — keeps a checkpoint and is answered by waiting; a failure is not, and the two shared exit code 1, so a wrapper could neither back off on the one nor stop retrying the other. 75 is `EX_TEMPFAIL`, the sysexits convention for "try again later". A wrapper that treated every non-zero code as final keeps working; one that tested `$? -eq 1` for a pause has to test 75.

---
'@namzu/cli': patch
---

A scheduled run is told the time it started, in the job's time zone with its UTC offset (`It is now Wednesday, 23 September 2026 at 21:04 GMT+03:00 (Europe/Istanbul)`). It had only the date; a job that wrote the time into a post, with no shell to ask, wrote the time in UTC.

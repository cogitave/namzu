---
'@namzu/cli': patch
---

The permission prompt for `npm test 2>&1 | tail -20` and similar lines now offers "Yes, and don't ask again" for the meaningful command (`npm test *`), and that saved rule covers the same line later instead of asking again. A line that writes a file, pipes into a shell or runs another program is still asked about.

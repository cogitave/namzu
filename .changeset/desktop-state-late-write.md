---
'@namzu/desktop': patch
---

A window that writes just after a clean quit no longer makes the next start look like a crash, so a quit with a late resize or panel change still restores everything. The context panel and ring now say a reopened conversation's size is out of date when Namzu shortened it after the last count, instead of calling it "From the last reply".

---
"@namzu/sdk": patch
"@namzu/cli": patch
---

The stored-memory lock (`operation.lock`) was never removed automatically, so a process that died while holding it, or between creating it and writing its owner record (a full disk, a kill), left a file that made every later start report the memory index as not loaded until someone deleted it by hand. The lock is now broken at the next acquire when its owner is provably gone: the recorded pid no longer exists on this machine, or the file is empty or unreadable and older than five seconds. A lock whose owner is alive, or was written on another host, is still waited for and never broken. Owner records now include the host name, and a failed write of the record removes the lock file. When the owner is alive the error now reads "Another Namzu process (pid N) is using the stored memory. Close it, or wait for it to finish."; its code and details are unchanged. Nothing to do.

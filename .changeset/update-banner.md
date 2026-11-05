---
'@namzu/cli': patch
---

The footer now says so while an update installs in the background (`Updating to 45.9.0…`) and, once it is installed, shows it with a green check: `✓ Updated to 45.9.0 · restart to use it`. Before, nothing showed while it worked and the finished line was dim. If another terminal is doing the install, the line clears instead of staying.

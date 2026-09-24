---
"@namzu/cli": patch
---

Under WSL, `namzu login` now opens the sign-in page in the Windows browser. It launches Windows PowerShell by absolute path, under the drive mount root set in `/etc/wsl.conf` (`[automount] root`, `/mnt/` by default), and the address is passed as data, never as script text. It used to call `xdg-open`, which under WSL usually opened nothing, so you had to copy the URL. When interop is off or PowerShell is missing, it still falls back to `xdg-open`. Nothing to change on your side.

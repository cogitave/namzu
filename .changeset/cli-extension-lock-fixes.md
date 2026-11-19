---
'@namzu/cli': patch
---

The administrator lock of an extension now counts a try and sets its wait before the password is hashed, so starting many `namzu extension` commands at once no longer gets each of them judged. An update that adds `management` to an extension that is already on is refused at acknowledgement unless an administrator password is given (`--admin-password-stdin`, or the new `admin` field of `namzu/extensions/acknowledge`); before, it kept running with nobody holding the key. Nothing changes for an extension that does not declare `management`.

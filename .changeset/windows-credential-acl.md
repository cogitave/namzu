---
"@namzu/cli": patch
---

Fix Windows startup rejecting private CLI state directories whose ACL includes
the operating system's SYSTEM account (`SY`). The current user must still have
access; grants to other users or groups remain refused. This fixes a local
state-permission failure that could appear after selecting a discovered Claude
session, without requiring another provider sign-in.

Claude session discovery now honors `CLAUDE_CONFIG_DIR`, including directories
with spaces. An explicitly selected profile cannot silently fall back to the
default Claude profile, the paired Windows home, or the default macOS Keychain.
Custom macOS Keychain entries remain unsupported.

---
"@namzu/cli": patch
---

Fix Windows startup failing on nested private state directories. Current-user
access now propagates to new child directories and files instead of leaving
Windows to assign its default ACL. Protecting a named private directory removes
an existing Administrators grant, including after an earlier failed startup;
it does not accept that group or unrelated accounts as private.

Existing descendant files with explicit grants are not recursively migrated.
POSIX permissions and credential-file ACL validation are unchanged.

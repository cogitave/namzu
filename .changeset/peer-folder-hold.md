---
"@namzu/cli": minor
---

Mail from an agent in another terminal whose session runs in a different folder than the receiving one is now held for the person at the receiving terminal (allow once or deny; the sender is told it was held and why), as a permission-mode mismatch already is. Listing every session and messaging across folders still work, and a person's own message, same-folder mail and mail from another machine on your Namzu network follow their earlier rules. Mail you want delivered without a prompt must come from a session in the receiver's folder.

---
'@namzu/cli': patch
---

Sending the prompt you edited after Restore conversation in the rewind dialog (or after `/fork`) no longer fails with a message about a cached message id the log never recorded. The screen now continues from the fork's own saved history. If the saved conversation and the screen's copy ever disagree again, Namzu rebuilds the copy from the saved conversation and sends once more, and a second refusal reads as plain words with "Send your message again." A call whose arguments do not fit its tool now reads `Invalid tool parameters` on its row, with the full text on the Ctrl+O screen.

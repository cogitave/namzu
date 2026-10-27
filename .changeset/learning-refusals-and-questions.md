---
"@namzu/cli": patch
"@namzu/sdk": minor
---

Learning by itself no longer counts a refused tool call as a failure: the answer to a call you declined, to a call that went with the turn your No ended, and to a call whose question went unanswered records nothing, because those are your choices, not a tool that broke. The background learning cycle also stays still while any question about a tool call waits on you, and goes on once it closes. The guidance a project learned now opens with "Namzu learned" instead of claiming you confirmed it, since the background cycle activates it without a prompt; a stored memory still wins where the two disagree. `@namzu/sdk` adds `isReviewRefusalResult(output)`, which says whether a tool result answers a call the review did not let run, so a host that counts failures can leave those out. Nothing to change on upgrade.

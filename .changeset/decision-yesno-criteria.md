---
'@namzu/decision': minor
'@namzu/cli': patch
---

A yes/no decision question can now carry a `criteria` sentence (what makes the answer yes), through the new optional `criteria` field of the options argument of `DecisionModel.yesno`. The HTTP driver sends it; the Azure driver does not send it until that is verified against the service, so its request is unchanged. The model-facing `decide` tool takes an optional `criteria` for a yes/no call. Namzu's own yes/no questions (notify, memory, skill, model routing, the connection test) now send one, so hosted decision models that refuse a yes/no question without criteria can be used. Nothing to change on your side; a custom service that rejects unknown fields on a yes/no question would now need to accept `criteria`.

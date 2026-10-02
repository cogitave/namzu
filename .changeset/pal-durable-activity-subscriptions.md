---
"@namzu/sdk": minor
"@namzu/cli": minor
---

Add durable subscriptions for closed Pal activity metadata from an exact owned original conversation. Observation, disclosure, recipient receipt and idle wake have independent current permission checks. Custom publication authorizers must also implement the final accept phase requiring current observation, disclosure and receipt together. Accepted facts enter the shared Pal inbox before cursor progress; retries preserve identity and verified observation trails suppress feedback.

The CLI adds finite pal subscribe, subscription, activity and unsubscribe commands. Publication performs no inference or guest startup; explicit dispatch still requires current wake/tool authorization. Original turn intake and exact recorded delivery receipts are required for causality, and unknown evidence or exhausted journal read budgets reject without advancing progress.

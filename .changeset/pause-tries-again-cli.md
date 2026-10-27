---
'@namzu/cli': minor
---

A reply that paused because Namzu could not reach the provider, or the provider was having trouble, now tries again by itself: after 15 seconds, then 30 seconds, 1, 2 and 5 minutes, and every 5 minutes after that, until it goes through or you stop it. Enter still tries at once and Esc still stops the reply; the hint line under the composer counts down to the next try. Pauses that need a person (a rejected key, a rate limit, a tool waiting for you) still wait for you.

The pause reads "Paused. Namzu could not reach OpenAI. It tries again on its own. Press Enter to try now, or Esc to stop." The queued-work rows under it say what is waiting: "Something finished in the background" (it is reported after the reply) and "Waiting for the paused reply to continue, then these run". A certificate that does not check out is named as that, not as a lost connection.

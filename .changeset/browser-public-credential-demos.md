---
'@namzu/browser': major
---

Visible password or one-time-code fields on an ordinary public page no longer trigger a whole-page sign-in or second-factor handoff. Component galleries and settings pages can now be read and navigated. Actions targeting credential controls, submission of forms containing them, and all untargeted keys are refused; unrelated controls remain usable. Page-created dialogs can be dismissed but not accepted by the agent. Screenshots mask input and textarea pixels that Playwright can locate, including child frames, but closed shadow roots and text drawn elsewhere may remain visible; snapshots still hide detected credential values. A recognized sign-in or second-factor address, HTTP authentication challenge, CAPTCHA, bot wall, or a bare HTTP 401 page with a credential field still triggers a handoff. If your application relied on a field alone to hand off a sign-in page at an unusual address, add that address to `signInAddresses`.

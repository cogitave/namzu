---
'@namzu/desktop': minor
---

Namzu Desktop's corners, shadows and stacking now follow one scale, and the interface moves with a little more care.

- Corners use five sizes, shadows four levels of elevation, and layers a named order, so a toast always shows above an open dialog and a tooltip above the dialog it explains.
- A message you send settles in with a short spring; the replies keep their fade, and restored history and reopened tabs do not animate. The actions under a message appear after a short pause on hover and leave at once, and show immediately for the keyboard.
- Panels such as the task list, job details and folder access open and close smoothly instead of jumping.
- Loading placeholders appear only after half a second and then fade in, so a fast load no longer flashes a skeleton.
- With reduced motion (the system setting) none of this moves: things appear at once.

---
'@namzu/lmstudio': minor
---

Images reach the model.

`attachments` were dropped outright, so a user who attached a screenshot got
a turn about nothing. `supportsVision: false` said as much, which made it
honest and still useless.

An image cannot be inlined on this wire — it is uploaded to the backend and
the message references the handle that comes back. That makes the mapping
asynchronous, so the upload happens ahead of it and the message mapping
stays a pure function of what it is handed.

- A media type the backend cannot decode is named in the text rather than
  uploaded and found undecodable half a turn later.
- An upload that fails leaves a note saying the image could not be sent,
  and the turn continues. Losing sight of one image is recoverable; the run
  dying over it is not — and "there was an image you cannot see" is a
  different situation from there having been no image, so the model is told
  which one it is.
- Several attachments on one message are carried in order.

An image inside a **tool result** stays a text placeholder. A tool message
on this wire may hold result parts and nothing else, so there is nowhere to
reference a handle from; moving it into a separate user turn would put words
in the user's mouth to make a picture fit.

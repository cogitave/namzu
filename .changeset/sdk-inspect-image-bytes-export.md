---
"@namzu/sdk": minor
---

Export `inspectImageBytes` (the check-and-fit step `view_image` runs on image bytes) so a host tool that makes an image can hand a model the same bounded pixels. The `shared` tool fact gains an optional `generatedImage: { prompt }` marking the one file as an image the agent made; a host that ignores it still draws an ordinary shared file.

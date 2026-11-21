---
'@namzu/openrouter': patch
'@namzu/deepseek': patch
---

A pasted image now reaches an OpenRouter model that reads images; before, every OpenRouter model was told "image omitted" and answered that it could not see the picture. A model whose listing shows it takes text only still gets the notice. Choosing a text-only DeepSeek model with an image in the conversation now shows that notice instead of failing the request.

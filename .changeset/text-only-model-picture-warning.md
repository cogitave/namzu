---
'@namzu/sdk': patch
'@namzu/cli': patch
---

A picture attached to a model that reads text only now tells you so. When the provider reads images but the chosen model does not (its listing says text only, for example some OpenRouter or local models), the picture was left out of the request with no word to you. Now the run emits the usual `capability_warning`, with the `model` field set, and the terminal says "This model can't see images, so it won't see the picture you attached. Pick a model that reads images with /model to include it."

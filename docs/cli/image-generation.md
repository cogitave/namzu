---
type: Reference
title: Image generation
description: The generate_image tool, which creates and edits images with the person's subscription plan whichever model leads the conversation, when it is offered, where the files go, and the imageGeneration setting.
resource: packages/cli/src/integrations/images/generate-image.ts
tags: [cli, tools, images, config, openai]
status: stable
generated: { by: claude-code/sonnet-5.5, at: 2026-11-24T00:00:00Z }
---

# Image generation

Namzu can create and edit images with the person's subscription plan. The tool is `generate_image`, and it does not depend on the model leading the conversation: a DeepSeek, OpenRouter, Anthropic or local model can call it as well as an OpenAI one. The request goes to OpenAI under the person's plan, and the tool's description says so to the model.

## When it is offered

All of these hold, read for every request, so signing in or switching the setting applies to the next step of an open conversation:

- A subscription sign-in is connected (the one Namzu uses for the OpenAI subscription provider).
- The plan is not Free. A token that names no plan is allowed and the service answers for it.
- `imageGeneration.enabled` is not `false`. The default is on; a project file can only turn it off, never back on.

An OpenAI API key alone does **not** enable it: the image route belongs to the subscription. When any condition fails the tool is absent from what the model is offered. It is never an error for the model to read.

## What the model passes

| Argument | Meaning |
|---|---|
| `prompt` (required) | What to draw, or how to change the images given. |
| `transparent_background` | Ask for a transparent background. Default `false` (opaque). |
| `referenced_image_paths` | Up to 5 existing images to edit, read under the same rules as `view_image` and `present_file`. |
| `num_last_images_to_include` | 1 to 5: edit the newest images of the conversation. Never together with `referenced_image_paths`. |

With neither selector a new image is made (`images/generations`); with one, an edit (`images/edits`). The image model is fixed. Generation takes a few minutes; the request stops with the turn (Esc) and times out after ten minutes.

## Where the files go

`<Namzu home>/generated_images/<session id>/<call id>.png` (or `.gif` if the service returned one), with the ids reduced to letters, digits, `_` and `-`. An existing file is never overwritten, a folder that is a link is refused, and an image larger than 32 MiB is not kept. While the tool is offered, that session's folder is one of the folders the session's file tools may read, so the model can `view_image`, `read` or `present_file` it and copy it elsewhere. The model is told the saved path, to copy the file instead of moving it, and that the image is already shown to the person.

A model that reads images also receives the picture, fitted to the same bound as `view_image`; a text-only model gets the text. What is stored in the conversation is the path and the prompt in the tool's result and its `shared` fact, with `generatedImage.prompt` marking it.

## What the person sees

- **Terminal:** a `Generated image` heading, the prompt, and `Saved to <path>`, after the answer text. A failure reads `Image generation failed` with the reason; a spent quota says when it resets. A resumed conversation draws the same rows from the saved result.
- **Desktop:** an image card under the reply with the picture, the prompt, and Open, Show in folder, Copy (as a picture) and Save a copy ([Desktop](desktop.md#a-file-the-agent-hands-over)).

## Permissions

It is asked about like `web_search`: a network tool that sends the prompt, and any referenced image, to OpenAI. It is never on the auto mode's safe list. Hooks see its name and arguments.

## The setting

```json
{ "imageGeneration": { "enabled": false } }
```

Settings shows it as **Image generation** under Tools. It is not read from the environment.

# @namzu/google

## 0.2.0

### Minor Changes

- 7785cb4: Add Google model access with a native SDK provider and CLI model selection. Reuse an existing Gemini CLI Google sign-in from this device, including the paired Windows home under WSL, without requiring a new API key. Explicit Gemini or Google API keys remain an alternative and take precedence when configured. Borrowed sign-ins are refreshed in memory without rewriting their owner file; Google account access retains the Code Assist route rather than being sent to the API-key endpoint.

Initial native Gemini API and existing Gemini CLI OAuth transport.

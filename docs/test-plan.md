# Test Plan

## Initial release gate

Treat the following as the `0.1.x` release-smoke set:

- Scenario 5: backend model listing
- Scenario 6: OpenAI-compatible text chat with thinking preservation
- Scenario 7: LM Studio Native REST chat continuation
- Scenario 10: raw storage persistence
- Scenario 12: tool forwarding off for upstream suppression
- Scenario 14: reasoning mode via settings
- Scenario 15: multi-endpoint manager and active switching
- Scenario 16: theme-aware manager UI
- Scenario 17: first-time setup entry point

Accepted release limitation:

- Scenario 13 may leave Copilot-side `totalTools` and `toolTokens` unchanged even when the bridge advertises a lower limit, because that budget appears to be decided before provider request construction.

## Probe objective

Confirm whether a hidden `LanguageModelDataPart` emitted on one assistant turn is returned to the provider in later `LanguageModelChatRequestMessage` values.

## Backend objective

Confirm that backend models appear dynamically from the selected endpoint type and that a selected backend model can answer while the provider still carries hidden reasoning in a DataPart. `OpenAI-compatible` is the generic default; `LM Studio` is the recommended LM Studio path; `LM Studio Native` is the optional native `/api/v1/chat` path.

## Manual scenarios

### Scenario 1: Same-session round-trip

1. Start the Extension Development Host.
2. In `GHCC Custom Provider: Manage Provider`, open `Common Settings` and turn on `Show Probe model` in `Diagnostics`.
3. Select the `GHCC Custom Provider Probe` model.
4. Send `first probe turn`.
5. Send `second probe turn` in the same chat.
6. Inspect the `GHCC Custom Provider` output channel.

Expected outcome:

- first turn: no previous hidden state detected
- second turn: the provider logs at least one inbound DataPart with the configured probe MIME type

### Scenario 2: New chat reset

1. Open a new chat session.
2. Send a single message.
3. Inspect the output channel.

Expected outcome:

- no previous hidden state is detected on the first turn of the new chat

### Scenario 3: Window reload

1. In the same Extension Development Host, complete two turns so the probe state is known to round-trip in-session.
2. Reload the window.
3. Continue the same visible transcript if VS Code restores it.
4. Inspect the output channel.

Expected outcome:

- record whether hidden DataParts survive window reload separately from same-session round-trip

### Scenario 4: Extension host restart

1. Stop the development host.
2. Start it again.
3. Reopen the same chat transcript if available.
4. Inspect whether any previous hidden state is still visible to the provider.

Expected outcome:

- record whether restart behavior differs from reload behavior

### Scenario 5: Backend model listing

1. Save `http://127.0.0.1:1234` as the backend base URL.
2. Leave endpoint type on `OpenAI-compatible` and reopen the chat model picker.
3. Confirm that LM Studio models such as `qwen3.6-27b` and `qwen3.6-35b-a3b` appear under GHCC Custom Provider.
4. Switch endpoint type to `LM Studio` and reopen the model picker again.
5. Confirm that the same chat-capable models still appear.

Expected outcome:

- if `Show Probe model` is enabled, the probe model remains available
- embedding-only models are filtered out of the chat model list
- LM Studio mode can expose richer context length, vision, and tool-use metadata than the OpenAI-compatible model-list path
- if the LM Studio metadata marks a model as tool-use capable, the picker keeps that model tool-capable and chat requests still use OpenAI-compatible tool forwarding

### Scenario 6: OpenAI-compatible text chat with thinking preservation

1. Select endpoint type `OpenAI-compatible`.
2. Set `Preserve thinking` to `On`.
3. Optionally set `Reasoning effort` or custom JSON such as `{ "chat_template_kwargs": { "preserve_thinking": true } }` if the backend expects nested fields.
4. Select `qwen3.6-35b`.
5. Send a short prompt that produces reasoning.
6. Send a follow-up question that depends on the prior hidden reasoning trace.
7. Open the output channel.

Expected outcome:

- the request log shows override keys including `preserve_thinking`
- the backend response completes without transport errors
- a hidden backend state DataPart is emitted after the assistant response
- if the next request does not return the hidden DataPart, `providerMemoryLookup.hit` and `usedProviderMemoryFallback` should still allow reasoning replay within the same extension host session
- if the backend ignores assistant `reasoning_content`, the request log should show `usedSyntheticReasoningReplay=true` and one extra system message in the payload summary

### Scenario 7: LM Studio Native REST chat continuation

1. Switch endpoint type to `LM Studio Native`.
2. Select a backend model.
3. Send a first prompt and wait for the response.
4. Send a follow-up question in the same chat.
5. Open the output channel.

Expected outcome:

- the first response produces a hidden backend state DataPart with a stored `response_id`
- the second request reuses that `response_id` when the model is unchanged
- text streams through `/api/v1/chat`
- tool-capable LM Studio models remain selectable in Copilot Chat even though the bridge suppresses outgoing tool definitions for the native endpoint
- if `Preserve thinking` is `On` and prior hidden reasoning is available, the request log can show `usedSyntheticReasoningReplay=true` and a `systemPromptLength` in the payload summary
- the provider warns only if LM Studio omits `response_id`

### Scenario 8: Model metadata overrides

1. In the manager panel, add a `modelOverrides` entry such as:

	 ```json
	 {
		 "qwen3.6-35b-a3b": {
			 "displayName": "Qwen 35B A3B Override",
			 "imageInput": "on",
			 "maxInputTokens": 262144,
			 "maxOutputTokens": 8192
		 }
	 }
	 ```

2. Save raw settings.
3. Reopen the model picker.
4. Inspect the model information in chat.

Expected outcome:

- the overridden display name appears
- vision and token metadata reflect the override instead of pure upstream heuristics

### Scenario 9: Backend text chat

1. Select endpoint type `OpenAI-compatible`.
2. Select `qwen3.6-27b`.
3. Send a short prompt.
4. Confirm that text streams into chat.
5. Open the output channel and verify that the backend response completed without transport errors.

Expected outcome:

- the model answers through LM Studio
- a hidden reasoning DataPart is emitted if `reasoning_content` is returned upstream

### Scenario 10: Raw storage persistence

1. Save settings from the manager panel with a non-default endpoint type, request override, and model override.
2. Run `GHCC Custom Provider: Open Raw Settings`.
3. Confirm that the values were written to the raw storage file, including the registered `endpoints` array, `activeEndpointIds`, and `activeEndpointId`, and that settings.json was not touched by the extension.
4. Store an API key for the selected endpoint and confirm the manager reports that the key is stored without displaying the secret itself.

### Scenario 11: Persisted fallback across reload

1. In the manager panel, enable `Persist fallback cache across window reload and extension host restart`.
2. Leave `TTL minutes` at a non-trivial value such as `720`.
3. Run the OpenAI-compatible hidden-thinking scenario once so a backend hidden state is emitted.
4. Reload the window or restart the Extension Development Host.
5. Continue the same visible chat transcript with a follow-up turn that depends on the prior hidden reasoning.
6. Open the output channel.

Expected outcome:

- the provider logs that persisted conversation-state entries were restored during activation or first use
- `providerMemoryLookup.hit` can still succeed even if the inbound transcript only contains `cache_control` DataParts
- `providerMemoryLookup.hit` can still succeed even if the inbound transcript omits prior assistant turns and only preserves visible user-side prefixes
- the fallback state expires automatically after the configured TTL or when the persisted entry limit is exceeded

### Scenario 12: Tool forwarding off for upstream suppression

1. In the manager panel, set `Tool exposure` to `Off`.
2. Save settings and reopen the chat model picker so model capabilities are refreshed.
3. Select the same backend model again.
4. Send a short prompt and inspect both the GHCC Custom Provider log and the Copilot Chat log.

Expected outcome:

- the refreshed picker no longer shows the model as tool-capable while the setting is `Off`
- the backend request log shows `tools=0`
- the provider can log that incoming VS Code tool definitions were suppressed when the profile disables upstream tool forwarding
- the model remains usable in normal Copilot Chat after switching the setting to `Off`

### Scenario 13: Advertised tool limit

1. In the manager panel, leave `Tool forwarding` on `Auto`.
2. Use an endpoint or model override that explicitly advertises tool support, then set `Advertised tool limit` to `1`.
3. Save settings and reopen the chat model picker so model capabilities refresh.
4. Select the backend model again and send a short prompt.
5. Inspect the Copilot Chat log and GHCC Custom Provider log.

Expected outcome:

- the backend request log should show either `tools=1` or a bridge log line explaining that the incoming tool list was limited to `1`
- the model remains usable in chat
- if VS Code honors the advertised capability limit before request construction, Copilot-side tool budget should drop noticeably compared to the earlier `58`-tool case

### Scenario 14: Reasoning mode via settings

1. Open `GHCC Custom Provider: Manage Provider`.
2. For the active OpenAI-compatible endpoint, set `Send tools to endpoint` to `Off`.
3. Reopen the chat model picker.
4. Confirm that each backend model appears only once.
5. Use the model in a non-agent chat flow and inspect the resulting behavior.

Expected outcome:

- the model picker no longer duplicates tool-capable OpenAI-compatible models
- the selected model remains visible and usable without a separate `(Reasoning)` alias
- the refreshed picker no longer shows the model as tool-capable, and the backend request suppresses forwarded tool definitions while the endpoint setting stays `Off`
- if Copilot treats non-agent flows differently, the endpoint-level no-tools setting becomes the cleanest reasoning-first operating mode

### Scenario 15: Multi-endpoint manager and active switching

1. Open `GHCC Custom Provider: Manage Provider`.
2. Add a second endpoint.
3. Configure the first endpoint as `OpenAI-compatible` and the second as `LM Studio`.
4. Save settings.
5. Reopen the manager and confirm both endpoints are still listed.
6. Enable the second endpoint.
7. Reopen the model picker and inspect the listed backend models.
8. Enable the first endpoint as well and inspect the model picker again.

Expected outcome:

- the manager persists multiple registered endpoints in raw storage
- every enabled endpoint contributes models to discovery at the same time
- endpoint-specific API key status is shown per selected endpoint
- selecting a model from a specific enabled endpoint routes requests to that endpoint without requiring settings.json edits

### Scenario 16: Theme-aware manager UI

1. Open `GHCC Custom Provider: Manage Provider`.
2. Switch VS Code between a light theme and a dark theme.
3. If available, also switch to a high-contrast theme.
4. Reopen the manager if needed.

Expected outcome:

- the manager uses VS Code theme colors for background, text, inputs, buttons, and borders
- text remains readable in light, dark, and high-contrast themes
- no hardcoded color palette remains visible in normal interaction states

### Scenario 17: First-time setup entry point

1. Start the Extension Development Host with no stored `provider-settings.json`, or clear the base URL from every enabled endpoint in the manager.
2. Keep `Show Probe model` off in `Common Settings > Diagnostics`.
3. Open the chat model picker and inspect the GHCC Custom Provider entries.
4. Select the GHCC Custom Provider setup entry and send a chat message.
5. Configure a valid endpoint URL and API key if required, then reopen the model picker.

Expected outcome:

- a GHCC Custom Provider setup entry appears instead of the provider silently disappearing from the model picker, and its label explains whether setup is required, the connection failed, or no models were found
- using the setup entry opens the manager without requiring the user to know the command palette path
- after endpoint configuration succeeds, backend models appear normally

## Logging fields to watch

- request summary
- total inbound data parts
- matching hidden-state data parts
- previous probe id
- next probe id
- decode errors

## Persistence checks

1. Save settings from the manager panel.
2. Run `GHCC Custom Provider: Open Raw Settings`.
3. Confirm that the values were written to the raw storage file and that settings.json was not touched by the extension.
4. Store an API key with `GHCC Custom Provider: Set API Key` and confirm the manager reports that the key is stored without displaying the secret itself.

## Exit criteria for the next phase

- provider registration works reliably in the development host
- the probe model is selectable in chat
- the output channel shows structured transcript diagnostics
- DataPart behavior is understood well enough to choose between transcript-only hidden state and a hybrid fallback strategy
- request overrides are verified on the wire for the selected backend type
- model metadata overrides behave predictably when upstream metadata is incomplete
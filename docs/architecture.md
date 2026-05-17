# Architecture Notes

## Product posture

The initial release keeps `OpenAI-compatible` as the default operating mode.

That choice is intentional. The extension is meant to bridge Copilot Chat to a broad set of third-party or self-hosted endpoints that already speak OpenAI-style APIs. LM Studio support is provided as a hybrid strategy plus an explicit native REST strategy, not as the defining center of the project.

In practice this means:

- the default settings and recommended validation path use `OpenAI-compatible (Chat Completions API)`
- `OpenAI-compatible (Responses API)` is available as an optional `/v1/responses` transport for OpenAI Responses API and Open Responses-compatible providers
- LM Studio has two hybrid endpoint strategies: native model discovery with `/v1/chat/completions` chat, and native model discovery with `/v1/responses` chat when the target explicitly supports Responses
- LM Studio Native is retained as an explicit secondary path when `response_id`-based `/api/v1/chat` continuation is useful
- endpoint-specific fallbacks are acceptable when they preserve the broader endpoint-agnostic architecture

## Scope of the current build

The current codebase now covers the initial release slice:

- extension activation
- provider registration
- dynamic backend model enumeration
- backend chat forwarding for OpenAI-compatible Chat Completions endpoints
- backend chat forwarding for OpenAI-compatible Responses endpoints
- backend chat forwarding for LM Studio hybrid Chat Completions, LM Studio hybrid Responses, and LM Studio Native endpoints
- transcript introspection
- hidden state emission through `LanguageModelDataPart`
- raw JSON storage plus SecretStorage persistence
- request override injection and per-model metadata overrides

Validated release outcomes now include:

- OpenAI-compatible hidden-reasoning continuity through transcript state, provider-memory fallback, and synthetic replay
- LM Studio hybrid model metadata discovery with OpenAI-compatible Chat Completions or Responses chat forwarding
- LM Studio Native hidden-number continuity through `previous_response_id`, provider-memory fallback, and synthetic `system_prompt` replay
- usable model selection even in Copilot modes that still expect tool-capable advertised models

## Modules

### `src/extension.ts`

Owns activation, output channel creation, provider registration, and command wiring.

### `src/commands/manageProvider.ts`

Owns the management panel. The panel edits raw-storage settings for:

- multiple registered endpoints plus multi-endpoint enablement
- per-endpoint base URL, default model, and endpoint type
- per-endpoint API key actions backed by SecretStorage
- request overrides such as `preserve_thinking`, `reasoning_effort`, and LM Studio `reasoning`
- per-model capability and token overrides
- probe settings and raw storage inspection

The current manager UI is rendered as a theme-aware webview that follows VS Code color tokens so it stays visually aligned with the active editor theme.

The panel now separates endpoint-scoped settings from bridge-wide settings. Connection details, endpoint capabilities, request overrides, and per-model overrides stay attached to the selected endpoint, while diagnostics, conversation-state cache behavior, and manager-language preferences are opened through a separate common-settings view from the left sidebar. Non-secret edits are auto-saved to raw storage when a field change is committed, and endpoint deletion requires an explicit confirmation step before the stored configuration is changed.

### `src/config/settings.ts`

Holds extension constants, the stored settings schema, defaults, sanitization logic, and the legacy settings import logic.

### `src/config/storage.ts`

Owns raw storage persistence and secret handling. Non-secret values are written into a JSON file under extension storage, while endpoint-specific API keys are written into SecretStorage. This mirrors the persistence split used in the reference Ollama Proxy implementation and avoids extension-driven writes to settings.json.

### `src/provider/chatProvider.ts`

Implements the `LanguageModelChatProvider` surface. It can serve an optional probe model for diagnostics, fetches backend models through the catalog, builds endpoint-specific request payloads, forwards backend chat requests, and emits hidden-state payloads for both the probe flow and backend reasoning flow.

### `src/provider/modelCatalog.ts`

Owns dynamic model discovery. It returns the probe model when diagnostics expose it, plus backend models from every enabled endpoint, filters out obvious non-chat models such as embeddings, and maps them into `LanguageModelChatInformation` values. Model capability and token metadata can be overridden from raw storage when upstream metadata is incomplete.

### `src/provider/messageMapping.ts`

Converts VS Code request messages into endpoint-specific request bodies. The Chat Completions path handles text, image inputs, tool results, assistant tool calls, and hidden reasoning state extracted from prior `LanguageModelDataPart` values. The Responses API path maps messages, function-call items, function-call outputs, and image input parts to the `/v1/responses` item model. LM Studio hybrid endpoints use LM Studio native model discovery, then choose either the Chat Completions mapping or the Responses mapping according to the selected endpoint type. The LM Studio Native path extracts only the latest user turn and the latest stored backend `response_id`, because `/api/v1/chat` is stateful and does not take arbitrary assistant history.

### `src/provider/upstreamClient.ts`

Owns backend endpoint abstraction. The current implementations are:

- OpenAI-compatible Chat Completions transport: `/v1/models` and `/v1/chat/completions`
- OpenAI-compatible Responses transport: `/v1/models` and `/v1/responses`
- LM Studio hybrid Chat Completions transport: `/api/v1/models` for discovery, with `/api/v0/models` fallback for older installs, and `/v1/chat/completions` for chat
- LM Studio hybrid Responses transport: `/api/v1/models` for discovery, with `/api/v0/models` fallback for older installs, and `/v1/responses` for chat
- LM Studio Native transport: `/api/v1/models`, `/api/v1/chat`, with `/api/v0/models` fallback for older installs

The Chat Completions path accumulates `reasoning_content` and reconstructs tool calls from SSE deltas. The Responses API path parses Responses streaming events, accumulates text deltas, function calls, reasoning summaries when exposed, and the response id. The LM Studio Native path parses event-based SSE, captures streamed reasoning and message deltas, and stores `response_id` for next-turn continuation.

### `src/provider/hiddenState.ts`

Defines the hidden-state payload schema and the logic for encoding, decoding, and observing `LanguageModelDataPart` payloads inside inbound messages.

## Current hidden-state strategy

The current implementation uses transcript-carried hidden state for two different backend concerns:

1. probe validation state for confirming whether `LanguageModelDataPart` round-trips through later turns
2. backend reasoning state, which carries upstream `reasoning_content`
3. LM Studio Native state, which also carries the previous `response_id`

For Chat Completions backends, including LM Studio hybrid Chat Completions, the provider emits a hidden DataPart that carries upstream `reasoning_content`. The next turn mapping reads that DataPart back and places the recovered reasoning into the assistant message history sent upstream.

For LM Studio Native, the provider emits the same hidden DataPart but also stores the latest `response_id`. The next turn mapping reuses that `response_id` when the selected model still matches, allowing LM Studio to continue the server-side chat thread without resending full assistant history. When `preserveThinking` is enabled and prior hidden reasoning is available, the bridge can also inject a synthetic `system_prompt` replay as a compatibility fallback for cases where `previous_response_id` alone does not preserve the model's hidden chain of thought reliably.

Because some Copilot Chat paths return only `cache_control` DataParts instead of the provider-emitted hidden payload, and may also omit prior assistant turns entirely, the provider now also keeps an in-memory fallback keyed by hashes of visible transcript prefixes. It stores both the visible incoming prefix and the completed prefix after the assistant response, then reuses the newest matching prefix on the next turn when transcript-carried hidden state is missing.

For Chat Completions backends, the provider also has a compatibility fallback for preserved thinking. If `preserve_thinking` is explicitly enabled and a prior reasoning trace is available, the provider injects a synthetic system message immediately before the current user turn. This is a backend workaround for servers that emit `reasoning_content` but ignore assistant-side `reasoning_content` on the next request. Responses API transports default to `store: false` for privacy and portability. When `Preserve thinking` is on, the bridge requests `reasoning.encrypted_content`, stores returned reasoning items in hidden state, and prepends those reasoning items to the next `/v1/responses` input. If a compatible backend exposes only textual reasoning summaries, the bridge falls back to a synthetic system replay item. Users who want stateful Responses continuation can opt in with the `Store Responses state` setting, after which the bridge can also carry `previous_response_id` in hidden state. For compatibility, `Store Responses state: Auto` still treats legacy custom request JSON `{ "store": true }` as an opt-in.

The provider-memory fallback can now also persist across window reload and extension host restart when the raw settings enable it. Persisted entries are stored in extension storage, pruned by TTL, and capped by a configurable entry limit so the fallback stays bounded.

Backend profiles now also expose a global `toolExposure` policy. In practice, Copilot Chat tool and agent flows expect the selected model to advertise tool support, so `Auto` keeps endpoint metadata and conservative model-family inference enabled. `On` forces tool capability on, while `Off` is only an explicit escape hatch for endpoints that cannot accept tool-shaped requests.

The recommended LM Studio profile now gets tool and vision metadata from LM Studio's native model-list API but sends chat through OpenAI-compatible chat completions, so VS Code custom tool definitions can be forwarded normally. LM Studio can also be paired with the Responses transport when the target explicitly supports `/v1/responses`. LM Studio Native remains available for `/api/v1/chat` continuation. Even though `/api/v1/chat` does not accept VS Code custom tool definitions, the bridge can still advertise a tool-capable native profile to Copilot when the model metadata indicates tool-use capability or the user explicitly forces tool exposure on. The native request path continues to suppress outgoing tool definitions, so this is purely a picker and compatibility advertisement layer.

Profiles can also set an `advertisedToolLimit`. This value is applied to the model capability advertised back to VS Code when the selected model supports tools, and the bridge also caps the forwarded tool list to the same count as a defensive fallback. The intent is to reduce Copilot-side tool attachment without making the model unavailable.

Because Copilot-side agent budgeting still appears to happen before the provider sees the request, the model picker now stays at one entry per upstream model and reasoning-first no-tools behavior is selected from endpoint settings by setting `toolExposure` to `off` instead of introducing duplicate picker aliases.

## Persistence strategy

- raw non-secret settings file: `provider-settings.json` under global extension storage, shared across windows for the same VS Code user profile and extension host kind
- raw file shape: multiple `endpoints` plus `activeEndpointIds` and `activeEndpointId`, with `backend` preserved as the primary enabled-endpoint alias for runtime consumers
- secret value: SecretStorage entries keyed per endpoint id
- legacy configuration values under `ghccCustomProvider.*`: import source only, not the write target
- model metadata overrides: stored in the raw settings JSON as a map keyed by model id
- request overrides: stored in the raw settings JSON and merged into endpoint-specific request payloads

## Known external constraint

Copilot-side tool budgeting still appears to happen before the provider request is built. Because of that, capping forwarded tools is not enough to reliably lower `totalTools` or `toolTokens` for the current chat request.

## Post-v0.1 next steps

1. Expand Responses API validation across OpenAI and Open Responses-compatible providers.
2. Revisit transcript fingerprinting if tool-heavy conversations need stronger matching guarantees.
3. Expand model metadata overrides if specific upstreams need additional fields beyond tools, vision, and token limits.
4. Add explicit cache inspection or cache clear controls if persisted fallback data needs tighter operator control.

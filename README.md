# GHCC Custom Provider

English README. A Japanese version is also included as [README.ja.md](README.ja.md).

GHCC Custom Provider connects GitHub Copilot Chat to OpenAI-compatible endpoints and LM Studio through Visual Studio Code's Language Model Chat Provider API. It is designed for self-hosted or third-party backends that already expose chat-capable APIs. It is not an Ollama-compatible proxy and it is not a drop-in replacement for older proxy-based setups.

> Status: Current release 0.1.2. `OpenAI-compatible` is the broad default. Use `LM Studio` for LM Studio servers when you want native model metadata with OpenAI-compatible chat behavior. Use `LM Studio Native` only when you specifically want LM Studio's native chat behavior.

## Features

- Register backend chat models in the VS Code model picker.
- Manage multiple endpoints and expose models from any enabled combination through a single panel.
- Support `OpenAI-compatible`, `LM Studio`, and `LM Studio Native` endpoint types.
- Control tool forwarding, tool limits, request options, and per-model overrides.
- Optionally keep conversation continuity data across turns and reloads.
- Test connections, inspect logs, and enable an optional diagnostic Probe model.
- Store API keys in VS Code SecretStorage and non-secret settings in extension storage.

## Requirements

- Visual Studio Code 1.118 or later.
- A VS Code chat experience that supports language model providers.
- A reachable upstream endpoint and, if required, an API key.

## Installation

- Install from the [Visual Studio Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ezomarten.ghcc-custom-provider).
- For offline installs or pinned validation builds, install a provided `.vsix` package.

## Quick Start

1. Open the chat model picker and choose the GHCC Custom Provider setup entry, or run `GHCC Custom Provider: Manage Provider` from the Command Palette.
2. Add an endpoint name and Base URL.
3. Choose `OpenAI-compatible` for most providers, `LM Studio` for LM Studio's richer model metadata plus OpenAI-compatible chat, or `LM Studio Native` for LM Studio's native chat API.
4. Set an API key if your endpoint requires one.
5. Run `Test connection`.
6. Select one of the discovered models in chat and start chatting.

If no models are available, the setup entry in the model picker explains whether setup is missing, the connection failed, or the endpoint returned no chat models.
From the extension entry in the Extensions view, the `Settings` action now opens `Manage Provider` instead of the legacy settings UI.

## Configuration Highlights

- `Send tools to endpoint`: Set this to `Off` for reasoning-first or local models that should not receive VS Code tool definitions.
- `Tool limit`: Optionally advertise and forward fewer tools to reduce tool volume.
- `Preserved thinking limit`: Caps hidden thinking stored or replayed as `reasoning_content`. Blank uses `64000` characters. Set `0` to keep continuation IDs such as LM Studio Native response IDs while dropping reasoning text. `-1` removes the cap, which is not recommended.
- `Synthetic replay limit`: Caps hidden thinking injected into synthetic system replay prompts. Blank uses `12000` characters. Set `0` to disable synthetic replay. `-1` removes the cap, which is not recommended.
- `Model Picker`: Backend models can be shown in the model picker by default. Even when this is turned off, the setup entry stays visible while no enabled endpoint is available so the manager is still easy to reopen.
- `Common Settings`: Turn on the Probe model, debug logging, or conversation memory persistence when troubleshooting.
- `Model Overrides`: Use simple default overrides for tool support, image support, and token limits across all models, or keep using advanced JSON for per-model tuning.

## Commands

- `GHCC Custom Provider: Manage Provider`
- `GHCC Custom Provider: Show Logs`

Additional maintenance commands are available for API keys and raw settings when needed.

## Privacy and Storage

- API keys are stored in VS Code SecretStorage.
- Non-secret settings are stored in the extension's storage area instead of `settings.json`.
- Requests are sent only to the endpoint that you configure.
- The extension does not add its own telemetry to chat requests.
- Diagnostic logs avoid API keys, raw chat content, and backend conversation ids.

## Notes and Limitations

- `OpenAI-compatible` is the recommended and best-tested default path for generic providers.
- `LM Studio` uses LM Studio's native model-list API for richer metadata such as context length, vision, and tool-use capability, then sends chat requests through the OpenAI-compatible chat-completions API so Copilot tool and agent flows can work normally.
- `LM Studio Native` keeps LM Studio-specific `/api/v1/chat` continuation behavior, but VS Code custom tool definitions are not forwarded on that endpoint type.
- If a backend finishes a turn without visible assistant text or tool calls, the provider now raises an explicit error instead of letting Copilot Chat fall through to `Sorry, no response was returned.` This usually means the model emitted reasoning-only output on that turn.
- Copilot may decide tool budgeting before the provider request is built. If a local model struggles with tools, set `Send tools to endpoint` to `Off`.
- Some conversation-continuity behavior depends on VS Code and Copilot transcript behavior and may vary across versions.

## Documentation

- Architecture notes: [docs/architecture.md](docs/architecture.md)
- Manual test plan: [docs/test-plan.md](docs/test-plan.md)
- Release and packaging notes: [docs/release.md](docs/release.md)

## License

MIT
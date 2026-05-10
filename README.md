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
- In remote windows such as Dev Containers or Remote SSH, this extension must run in the same remote extension host as GitHub Copilot Chat. Check the running extensions list and confirm that `GHCC Custom Provider` appears on the container or remote side.

### Dev Containers / Remote windows

- Non-secret settings are stored under the running extension host's `globalStorageUri`. API keys are stored in that same extension host's SecretStorage. Because of that, settings from a locally installed copy and settings from a container-installed copy are not shared automatically.
- Configured non-secret settings are also mirrored into a VS Code synced `globalState` key. When the container-installed copy has no settings file, or only an unconfigured settings file, it tries to import that synced mirror automatically. Manual migration is still needed if VS Code Settings Sync is disabled or the synced value has not arrived yet.
- After changing settings on the host side, use `Import Synced Settings` from `Common Settings` to re-import the synced non-secret settings into the current extension host.
- Each endpoint can read its API key from either `VS Code SecretStorage` or an `Environment variable`. SecretStorage is recommended but is scoped per extension host. Environment variables are convenient for Dev Containers and automation, but you must manage secure injection into that environment. In Dev Containers, environment variables may need to be passed through `remoteEnv` or `containerEnv` in `devcontainer.json` before the extension host can see them.
- If an endpoint uses an environment variable but that variable is not visible to the current extension host, the chat flow offers to store a fallback key in this container's SecretStorage. That fallback is used only by this extension host.
- As an advanced opt-in migration aid, visible API keys can be encrypted with a passphrase and stored in VS Code Settings Sync-backed `globalState`, then decrypted into another extension host's SecretStorage. Use `Export Encrypted API Keys` and `Import Encrypted API Keys` from the manager. The passphrase is never stored; if it is lost, the synced encrypted API keys cannot be recovered.
- If LM Studio or another backend is listening on the host OS, `127.0.0.1` from inside the container points to the container itself. The default `Auto` mode rewrites `localhost` and `127.0.0.1` to `host.docker.internal` at request time when the extension is running in a Docker-container remote. Turn `Container localhost rewrite` to `Off` when the backend actually runs inside the container.
- To install this extension automatically for a specific Dev Container, add it to that repository's `devcontainer.json` under `customizations.vscode.extensions`. An extension's own `package.json` cannot force-install that same extension into arbitrary user containers.

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
- `Preserved thinking limit`: Caps hidden thinking stored or replayed as `reasoning_content`; when truncated, the tail is kept because it is usually closest to the final conclusion. Blank uses `64000` characters. Set `0` to keep continuation IDs such as LM Studio Native response IDs while dropping reasoning text. `-1` removes the cap, which is not recommended.
- `Synthetic replay limit`: Caps hidden thinking injected into synthetic system replay prompts; when truncated, the beginning and end are kept with the middle omitted. Blank uses `12000` characters. Set `0` to disable synthetic replay. `-1` removes the cap, which is not recommended.
- `Model Picker`: Backend models can be shown in the model picker by default. Even when this is turned off, the setup entry stays visible while no enabled endpoint is available so the manager is still easy to reopen.
- `Common Settings`: Turn on the Probe model, debug logging, or conversation memory persistence when troubleshooting.
- `Model Overrides`: Use simple default overrides for tool support, image support, and token limits across all models, or keep using advanced JSON for per-model tuning.
- `API key source`: Choose SecretStorage or an environment variable per endpoint. Environment variables are useful when reusing the same endpoint definitions across Remote/Dev Container hosts.
- `Import Synced Settings`: Re-imports the non-secret endpoint settings mirrored through VS Code Settings Sync into the current extension host.
- `Export/Import Encrypted API Keys`: Moves passphrase-encrypted API keys through VS Code Settings Sync and imports them into the destination extension host's SecretStorage.

## Commands

- `GHCC Custom Provider: Manage Provider`
- `GHCC Custom Provider: Show Logs`

Additional maintenance commands are available for API keys and raw settings when needed.

## Privacy and Storage

- API keys are stored in VS Code SecretStorage.
- Non-secret endpoint settings are stored in the extension's global storage area instead of `settings.json`, so they are shared across windows for the same VS Code user profile.
- Requests are sent only to the endpoint that you configure.
- The extension does not add its own telemetry to chat requests.
- Diagnostic logs avoid API keys, raw chat content, and backend conversation ids.

## Notes and Limitations

- If backend models appear in a Dev Container but chat requests produce no response and the `GHCC Custom Provider` log does not show `Language model chat response requested`, the extension host location is likely mismatched. Install or enable the extension on the container side, reload the window, and confirm the log shows `extensionKind=workspace` and a non-empty `remoteName`.
- If host-side endpoints disappear after installing the extension into a container, this is expected because storage and SecretStorage are scoped per extension host. Move non-secret raw settings and register API keys again in the container.
- The synced non-secret settings mirror never includes SecretStorage values. If API keys are missing after sync, switch the endpoint's `API key source` to an environment variable or register the key in that extension host's SecretStorage.
- When using an environment variable as the API key source, the variable must be visible in the current extension host's `process.env`. In Dev Containers, configure `remoteEnv` or `containerEnv`, then restart the container or VS Code window.
- Encrypted API key sync is an opt-in migration aid. The encrypted payload is stored in Settings Sync, so use a strong passphrase and avoid it on shared or unmanaged profiles.
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
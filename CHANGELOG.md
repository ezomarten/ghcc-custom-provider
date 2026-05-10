# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Add an [Unreleased] section only while unpublished changes exist. Remove it again when shipping a release if nothing remains unreleased.

## [0.1.4] - 2026-05-11

### Added
- Added per-endpoint API key source selection so each endpoint can use either VS Code SecretStorage or a named environment variable.
- Added manager actions to import synced non-secret settings and to export or import passphrase-encrypted API keys across extension hosts.

### Changed
- The extension now prefers the workspace extension host in remote windows and logs activation and request diagnostics that make extension-host mismatches easier to diagnose.
- Added automatic runtime localhost rewriting for Docker-container remotes and expanded the manager UI for remote/container-specific endpoint configuration.

### Fixed
- Restored chat responses in Dev Containers by aligning the provider with the remote extension host used by Copilot Chat.
- When an environment-variable API key is not visible in the current extension host, chat can now prompt to store a local SecretStorage fallback instead of failing silently.

## [0.1.3] - 2026-05-07

### Changed
- Store endpoint settings in global extension storage so they are shared across windows for the same VS Code user profile, with one-time migration from the previous workspace-scoped raw settings file.
- Clarified that preserved hidden reasoning keeps the tail when capped, while synthetic replay keeps the beginning and end.

## [0.1.2] - 2026-05-07

### Added
- Added separate per-endpoint limits for preserved hidden reasoning and synthetic replay prompts in Manage Provider.
- Added an advanced `-1` option to remove either preserved-thinking cap when needed.

### Changed
- Split preserved hidden reasoning and synthetic replay prompt limits into separate settings with explicit defaults of 64000 and 12000 characters.
- Shortened the user-facing help text for preserved-thinking controls and aligned README guidance with the new settings.

### Fixed
- Avoided conflating stored `reasoning_content` replay limits with synthetic system replay prompt limits.

## [0.1.1] - 2026-05-07

### Added
- Localized the extension-context `Settings` label for English and Japanese VS Code UI.

### Changed
- Opening `Settings` from the extension entry in the Extensions view now opens `Manage Provider`.
- Removed the legacy import-only settings contribution from the extension manifest so the obsolete settings editor is no longer shown for this extension.

### Fixed
- Avoided sending users from the Marketplace and Extensions view into an outdated legacy settings screen.

## [0.1.0] - 2026-05-06

### Added
- Initial public release of GHCC Custom Provider.
- Dynamic backend model discovery for OpenAI-compatible, LM Studio, and LM Studio Native endpoints.
- Endpoint manager UI with raw-storage persistence, SecretStorage API keys, connection testing, and model overrides.

### Changed
- Published the extension under the ezomarten publisher and the `ghcc-custom-provider` package name.

### Fixed
- None.
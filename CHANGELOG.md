# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Move shipped changes into a dated version heading and keep [Unreleased]
for work that has not been published yet.

## [Unreleased]

### Added
- None yet.

### Changed
- None yet.

### Fixed
- None yet.

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
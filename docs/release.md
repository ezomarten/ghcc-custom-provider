# Release and Packaging Notes

This document is for maintainers and release operators. The public README stays focused on installation and everyday use.

## Package a VSIX

From the repository root:

```powershell
.\build.ps1
```

This runs dependency installation, audit, TypeScript checking, the extension build, VSIX packaging, an archive listing check, and moves the generated `.vsix` file into `build/`.

On Windows Command Prompt you can use:

```bat
build.bat
```

On bash-compatible shells you can use:

```bash
./build.sh
```

## Install a Local Build

```powershell
code --install-extension .\build\ghcc-custom-provider-0.1.4.vsix
```

For offline sharing or review builds, distribute only the generated `.vsix` file. Do not share local settings files, logs, `.env` files, or API keys.

## Release Checklist

```powershell
.\build.ps1
```

Before packaging a public release, move any `Unreleased` entries in `CHANGELOG.md` under the release version and date. Do not keep an empty `Unreleased` section in a shipped release. Add `Unreleased` back only after new unpublished work begins.

Keep the `name`, `publisher`, `repository`, `homepage`, and `bugs` fields in `package.json` aligned with the live GitHub repository and Marketplace identity.

Review the packaged file list before publishing. The repository build scripts already run `npx vsce ls --tree` as part of the packaging flow.

## Package Contents

The VSIX is intended to include:

- `README.md`
- `LICENSE`
- `package.json`
- compiled `dist/`
- `docs/`

The VSIX excludes development-only content such as `src/`, `.vscode/`, `node_modules/`, local `.env*` files, generated `.vsix` files, and build artifacts.

## Security and Privacy Notes

- The extension has no runtime npm dependencies.
- Development dependencies are locked in `package-lock.json` and installed with `npm ci`.
- `.npmrc` disables install-time package scripts by default.
- API keys are stored in VS Code SecretStorage.
- Non-secret settings are stored separately in extension storage.
- Requests are sent only to the configured upstream endpoint.
- Diagnostic logs avoid API keys, raw chat content, and backend conversation ids.

## Testing

For manual validation scenarios, including Probe model checks and endpoint-specific flows, see [test-plan.md](test-plan.md).
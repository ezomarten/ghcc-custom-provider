# Release and Packaging Notes

This document is for maintainers and release operators. The public README stays focused on installation and everyday use.

## Package a VSIX

From the repository root:

```powershell
npm ci
npm run package
```

This runs TypeScript checking, builds `dist/`, and creates a `.vsix` package such as `ghcc-custom-provider-0.1.1.vsix`.

## Install a Local Build

```powershell
code --install-extension .\ghcc-custom-provider-0.1.1.vsix
```

For offline sharing or review builds, distribute only the generated `.vsix` file. Do not share local settings files, logs, `.env` files, or API keys.

## Release Checklist

```powershell
npm ci
npm audit --audit-level=moderate
npm run check
npm run build
npx vsce ls
npm run package
```

Before packaging a public release, rename the `Unreleased` section in `CHANGELOG.md` to the release version and date, then create a new empty `Unreleased` section with `Added`, `Changed`, and `Fixed` headings for future work.

Keep the `name`, `publisher`, `repository`, `homepage`, and `bugs` fields in `package.json` aligned with the live GitHub repository and Marketplace identity.

Review the packaged file list before publishing.

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
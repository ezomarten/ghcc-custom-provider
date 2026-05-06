import { Buffer } from 'node:buffer';

import * as vscode from 'vscode';

import {
  BACKEND_API_KEY_SECRET_KEY,
  BACKEND_API_KEY_SECRET_PREFIX,
  BackendEndpointSettings,
  BridgeSettingsViewState,
  BridgeStoredSettings,
  CONFIG_SECTION,
  SETTINGS_STORAGE_FILE_NAME,
  assertUniqueEndpointNames,
  cloneDefaultBridgeSettings,
  getActiveEndpointIds,
  getEndpointById,
  getPrimaryActiveEndpoint,
  isEndpointActive,
  readLegacySettingsFromConfiguration,
  sanitizeStoredSettings,
} from './settings';

interface StoredSettingsFileData {
  fileUri: vscode.Uri | null;
  exists: boolean;
  settings: BridgeStoredSettings;
}

interface LoadedSettings extends StoredSettingsFileData {
  source: BridgeSettingsViewState['source'];
}

export type LanguageModelRefreshKind = 'none' | 'presentation' | 'connection';

export interface BridgeSettingsChangeEvent {
  readonly previousSettings: BridgeStoredSettings;
  readonly settings: BridgeStoredSettings;
  readonly languageModelRefreshKind: LanguageModelRefreshKind;
  readonly modelRefreshEndpointIds: readonly string[];
  readonly connectionStatusResetEndpointIds: readonly string[];
}

export class BridgeSettingsStore {
  private migratePromise: Promise<void> | undefined;
  private readonly changeEmitter = new vscode.EventEmitter<BridgeSettingsChangeEvent>();

  readonly onDidChange = this.changeEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel: vscode.LogOutputChannel,
  ) {}

  async initialize(): Promise<void> {
    await this.migrateLegacyConfigurationIfNeeded();
  }

  async getSettings(): Promise<BridgeStoredSettings> {
    const loaded = await this.loadSettings();
    return sanitizeStoredSettings(loaded.settings);
  }

  async getViewState(): Promise<BridgeSettingsViewState> {
    const loaded = await this.loadSettings();
    const storedApiKeyEndpointIds = await this.getStoredApiKeyEndpointIds(loaded.settings);

    return {
      settings: loaded.settings,
      hasStoredApiKey: storedApiKeyEndpointIds.some((endpointId) => isEndpointActive(loaded.settings, endpointId)),
      storedApiKeyEndpointIds,
      storageExists: loaded.exists,
      storageFileUri: loaded.fileUri,
      source: loaded.source,
    };
  }

  async saveSettings(nextSettings: BridgeStoredSettings): Promise<vscode.Uri> {
    const previousSettings = await this.getSettings();
    const sanitized = sanitizeStoredSettings(nextSettings);
    assertUniqueEndpointNames(sanitized.endpoints);
    const fileUri = await writeSettingsToStorageFile(this.context, sanitized);
    this.outputChannel.info(`Saved GHCC Custom Provider settings to ${fileUri.fsPath}.`);
    this.changeEmitter.fire(createSettingsSavedChangeEvent(previousSettings, sanitized));
    return fileUri;
  }

  async getApiKey(endpointId?: string): Promise<string | undefined> {
    if (endpointId) {
      const endpointApiKey = await this.context.secrets.get(getEndpointApiKeySecretKey(endpointId));
      if (endpointApiKey?.trim()) {
        return endpointApiKey.trim();
      }
    }

    return (await this.context.secrets.get(BACKEND_API_KEY_SECRET_KEY)) ?? undefined;
  }

  async openRawSettings(): Promise<void> {
    const loaded = await this.loadSettings();
    const fileUri = loaded.exists && loaded.fileUri
      ? loaded.fileUri
      : await writeSettingsToStorageFile(this.context, loaded.settings);

    const document = await vscode.workspace.openTextDocument(fileUri);
    await vscode.window.showTextDocument(document, {
      preview: false,
      preserveFocus: false,
      viewColumn: vscode.ViewColumn.Beside,
    });
  }

  async promptForApiKey(endpointId?: string, endpointName?: string): Promise<boolean> {
    const target = await this.resolveApiKeyTarget(endpointId, endpointName);
    const apiKey = await vscode.window.showInputBox({
      prompt: `Enter the upstream API key for ${target.endpointName}`,
      password: true,
      ignoreFocusOut: true,
    });

    if (apiKey === undefined) {
      return false;
    }

    if (!apiKey.trim()) {
      void vscode.window.showWarningMessage('The API key was empty and was not changed.');
      return false;
    }

    await this.context.secrets.store(getEndpointApiKeySecretKey(target.endpointId), apiKey.trim());
    const settings = await this.getSettings();
    this.outputChannel.info(`Stored GHCC Custom Provider API key in secret storage for ${target.endpointName}.`);
    this.changeEmitter.fire(createApiKeyChangedEvent(settings, target.endpointId, target.isActive));
    return true;
  }

  async clearApiKey(endpointId?: string, endpointName?: string): Promise<boolean> {
    const target = await this.resolveApiKeyTarget(endpointId, endpointName);
    const confirmation = await vscode.window.showWarningMessage(
      `Clear the stored API key for ${target.endpointName}?`,
      { modal: true },
      'Clear',
    );

    if (confirmation !== 'Clear') {
      return false;
    }

    await this.context.secrets.delete(getEndpointApiKeySecretKey(target.endpointId));
    if (target.isActive) {
      await this.context.secrets.delete(BACKEND_API_KEY_SECRET_KEY);
    }

    const settings = await this.getSettings();
    this.outputChannel.info(`Cleared GHCC Custom Provider API key from secret storage for ${target.endpointName}.`);
    this.changeEmitter.fire(createApiKeyChangedEvent(settings, target.endpointId, target.isActive));
    return true;
  }

  async isStorageDocument(document: vscode.TextDocument): Promise<boolean> {
    const fileUri = getSettingsStorageFileUri(this.context);
    return Boolean(fileUri && document.uri.toString() === fileUri.toString());
  }

  private async loadSettings(): Promise<LoadedSettings> {
    await this.migrateLegacyConfigurationIfNeeded();

    const fileData = await readSettingsFromStorageFile(this.context, this.outputChannel);
    if (fileData.exists) {
      return {
        ...fileData,
        source: 'storage',
      };
    }

    return {
      ...fileData,
      settings: cloneDefaultBridgeSettings(),
      source: 'defaults',
    };
  }

  private async migrateLegacyConfigurationIfNeeded(): Promise<void> {
    if (!this.migratePromise) {
      this.migratePromise = this.performLegacyMigration();
    }

    await this.migratePromise;
  }

  private async performLegacyMigration(): Promise<void> {
    const existing = await readSettingsFromStorageFile(this.context, this.outputChannel);
    if (existing.exists) {
      return;
    }

    const legacy = readLegacySettingsFromConfiguration();
    if (!legacy.isConfigured) {
      return;
    }

    const fileUri = await writeSettingsToStorageFile(this.context, legacy.settings);
    this.outputChannel.info(
      `Imported legacy ${CONFIG_SECTION} settings into raw storage at ${fileUri.fsPath}. Future edits will no longer rely on settings.json writes.`,
    );
  }

  private async getStoredApiKeyEndpointIds(settings: BridgeStoredSettings): Promise<string[]> {
    const legacyApiKey = await this.context.secrets.get(BACKEND_API_KEY_SECRET_KEY);
    const storedIds: string[] = [];

    for (const endpoint of settings.endpoints) {
      const endpointApiKey = await this.context.secrets.get(getEndpointApiKeySecretKey(endpoint.id));
      if (endpointApiKey?.trim() || (legacyApiKey?.trim() && isEndpointActive(settings, endpoint.id))) {
        storedIds.push(endpoint.id);
      }
    }

    return storedIds;
  }

  private async resolveApiKeyTarget(
    endpointId?: string,
    endpointName?: string,
  ): Promise<{ endpointId: string; endpointName: string; isActive: boolean }> {
    const settings = await this.getSettings();
    const normalizedEndpointId = endpointId?.trim();
    if (normalizedEndpointId) {
      const savedTarget = settings.endpoints.find((endpoint) => endpoint.id === normalizedEndpointId);
      if (savedTarget) {
        return {
          endpointId: savedTarget.id,
          endpointName: endpointName?.trim() || savedTarget.name || savedTarget.baseUrl || savedTarget.id,
          isActive: isEndpointActive(settings, savedTarget.id),
        };
      }

      return {
        endpointId: normalizedEndpointId,
        endpointName: endpointName?.trim() || normalizedEndpointId,
        isActive: false,
      };
    }

    const target = getPrimaryActiveEndpoint(settings)
      ?? settings.endpoints[0]
      ?? settings.backend;

    return {
      endpointId: target.id,
      endpointName: endpointName?.trim() || target.name || target.baseUrl || target.id,
      isActive: Boolean(target.id) && isEndpointActive(settings, target.id),
    };
  }
}

function getEndpointApiKeySecretKey(endpointId: string): string {
  return `${BACKEND_API_KEY_SECRET_PREFIX}${endpointId}`;
}

function createSettingsSavedChangeEvent(
  previousSettings: BridgeStoredSettings,
  settings: BridgeStoredSettings,
): BridgeSettingsChangeEvent {
  const modelRefreshEndpointIds = collectModelRefreshEndpointIds(previousSettings, settings);
  return {
    previousSettings,
    settings,
    languageModelRefreshKind: determineLanguageModelRefreshKind(previousSettings, settings, modelRefreshEndpointIds),
    modelRefreshEndpointIds,
    connectionStatusResetEndpointIds: collectConnectionStatusResetEndpointIds(previousSettings, settings),
  };
}

function createApiKeyChangedEvent(
  settings: BridgeStoredSettings,
  endpointId: string,
  isActive: boolean,
): BridgeSettingsChangeEvent {
  return {
    previousSettings: settings,
    settings,
    languageModelRefreshKind: isActive ? 'connection' : 'none',
    modelRefreshEndpointIds: isActive ? [endpointId] : [],
    connectionStatusResetEndpointIds: [endpointId],
  };
}

function determineLanguageModelRefreshKind(
  previousSettings: BridgeStoredSettings,
  settings: BridgeStoredSettings,
  modelRefreshEndpointIds: readonly string[],
): LanguageModelRefreshKind {
  const previousActiveEndpointIds = getActiveEndpointIds(previousSettings);
  const activeEndpointIds = getActiveEndpointIds(settings);

  if (modelRefreshEndpointIds.length > 0) {
    return 'connection';
  }

  if (!areSameOrderedEndpointIds(previousActiveEndpointIds, activeEndpointIds)) {
    return 'presentation';
  }

  if (previousSettings.modelPicker.showModelsByDefault !== settings.modelPicker.showModelsByDefault) {
    return 'presentation';
  }

  if (previousSettings.probe.showModel !== settings.probe.showModel) {
    return 'presentation';
  }

  const relevantEndpointIds = new Set([...previousActiveEndpointIds, ...activeEndpointIds]);
  for (const endpointId of relevantEndpointIds) {
    const previousEndpoint = getEndpointById(previousSettings, endpointId);
    const nextEndpoint = getEndpointById(settings, endpointId);
    if (hasEndpointModelPresentationChanged(previousEndpoint, nextEndpoint)) {
      return 'presentation';
    }
  }

  return 'none';
}

function collectModelRefreshEndpointIds(
  previousSettings: BridgeStoredSettings,
  settings: BridgeStoredSettings,
): string[] {
  const previousActiveEndpointIds = new Set(getActiveEndpointIds(previousSettings));
  const endpointIds: string[] = [];

  for (const endpointId of getActiveEndpointIds(settings)) {
    const previousEndpoint = getEndpointById(previousSettings, endpointId);
    const nextEndpoint = getEndpointById(settings, endpointId);
    if (!previousActiveEndpointIds.has(endpointId) || hasEndpointConnectionChanged(previousEndpoint, nextEndpoint)) {
      endpointIds.push(endpointId);
    }
  }

  return endpointIds;
}

function collectConnectionStatusResetEndpointIds(
  previousSettings: BridgeStoredSettings,
  settings: BridgeStoredSettings,
): string[] {
  const previousEndpoints = new Map(previousSettings.endpoints.map((endpoint) => [endpoint.id, endpoint]));
  const nextEndpoints = new Map(settings.endpoints.map((endpoint) => [endpoint.id, endpoint]));
  const endpointIds = new Set<string>();

  for (const [endpointId, previousEndpoint] of previousEndpoints.entries()) {
    const nextEndpoint = nextEndpoints.get(endpointId);
    if (!nextEndpoint || hasEndpointConnectionChanged(previousEndpoint, nextEndpoint)) {
      endpointIds.add(endpointId);
    }
  }

  return [...endpointIds];
}

function hasEndpointConnectionChanged(
  previousEndpoint: BackendEndpointSettings | undefined,
  nextEndpoint: BackendEndpointSettings | undefined,
): boolean {
  if (!previousEndpoint || !nextEndpoint) {
    return previousEndpoint !== nextEndpoint;
  }

  return previousEndpoint.endpointType !== nextEndpoint.endpointType || previousEndpoint.baseUrl !== nextEndpoint.baseUrl;
}

function hasEndpointModelPresentationChanged(
  previousEndpoint: BackendEndpointSettings | undefined,
  nextEndpoint: BackendEndpointSettings | undefined,
): boolean {
  if (!previousEndpoint || !nextEndpoint) {
    return previousEndpoint !== nextEndpoint;
  }

  return previousEndpoint.name !== nextEndpoint.name
    || previousEndpoint.defaultModel !== nextEndpoint.defaultModel
    || previousEndpoint.toolExposure !== nextEndpoint.toolExposure
    || previousEndpoint.advertisedToolLimit !== nextEndpoint.advertisedToolLimit
    || JSON.stringify(previousEndpoint.modelOverrides) !== JSON.stringify(nextEndpoint.modelOverrides);
}

function areSameOrderedEndpointIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((endpointId, index) => endpointId === right[index]);
}

function getSettingsStorageBaseUri(context: vscode.ExtensionContext): vscode.Uri | null {
  return (vscode.workspace.workspaceFolders?.length ? context.storageUri : context.globalStorageUri) ?? null;
}

function getSettingsStorageFileUri(context: vscode.ExtensionContext): vscode.Uri | null {
  const baseUri = getSettingsStorageBaseUri(context);
  return baseUri ? vscode.Uri.joinPath(baseUri, SETTINGS_STORAGE_FILE_NAME) : null;
}

async function ensureStorageDirectory(context: vscode.ExtensionContext): Promise<vscode.Uri | null> {
  const baseUri = getSettingsStorageBaseUri(context);
  if (!baseUri) {
    return null;
  }

  try {
    await vscode.workspace.fs.stat(baseUri);
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }

    await vscode.workspace.fs.createDirectory(baseUri);
  }

  return baseUri;
}

async function readSettingsFromStorageFile(
  context: vscode.ExtensionContext,
  outputChannel?: vscode.LogOutputChannel,
): Promise<StoredSettingsFileData> {
  const fileUri = getSettingsStorageFileUri(context);
  if (!fileUri) {
    return {
      fileUri: null,
      exists: false,
      settings: cloneDefaultBridgeSettings(),
    };
  }

  try {
    const raw = await vscode.workspace.fs.readFile(fileUri);
    const parsed = JSON.parse(Buffer.from(raw).toString('utf8'));

    return {
      fileUri,
      exists: true,
      settings: sanitizeStoredSettings(parsed),
    };
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return {
        fileUri,
        exists: false,
        settings: cloneDefaultBridgeSettings(),
      };
    }

    if (error instanceof SyntaxError) {
      outputChannel?.warn(
        `Failed to parse GHCC Custom Provider settings at ${fileUri.fsPath}. Falling back to defaults so the manager can open: ${error.message}`,
      );
      return {
        fileUri,
        exists: true,
        settings: cloneDefaultBridgeSettings(),
      };
    }

    throw error;
  }
}

async function writeSettingsToStorageFile(
  context: vscode.ExtensionContext,
  settings: BridgeStoredSettings,
): Promise<vscode.Uri> {
  const baseUri = await ensureStorageDirectory(context);
  if (!baseUri) {
    throw new Error('Raw settings storage is not available in the current VS Code environment.');
  }

  const fileUri = vscode.Uri.joinPath(baseUri, SETTINGS_STORAGE_FILE_NAME);
  const content = `${JSON.stringify(settings, null, 2)}\n`;
  await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf8'));
  return fileUri;
}

function isFileNotFoundError(error: unknown): boolean {
  return Boolean((error as { code?: unknown } | undefined)?.code === 'FileNotFound' || /file not found/i.test(String((error as { message?: unknown } | undefined)?.message ?? '')));
}
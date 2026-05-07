import * as vscode from 'vscode';

export const EXTENSION_ID = 'ezomarten.ghcc-custom-provider';
export const CONFIG_SECTION = 'ghccCustomProvider';
export const PROVIDER_VENDOR = 'ezomarten-ghccCustomProvider';
export const MANAGEMENT_COMMAND = 'ghccCustomProvider.manage';
export const OPEN_EXTENSION_SETTINGS_COMMAND = 'ghccCustomProvider.openExtensionSettings';
export const SHOW_LOGS_COMMAND = 'ghccCustomProvider.showLogs';
export const OPEN_RAW_SETTINGS_COMMAND = 'ghccCustomProvider.openRawSettings';
export const SET_API_KEY_COMMAND = 'ghccCustomProvider.setApiKey';
export const CLEAR_API_KEY_COMMAND = 'ghccCustomProvider.clearApiKey';
export const HIDDEN_STATE_MIME = 'application/vnd.ezomarten.ghcc-custom-provider-bridge.hidden-state+json';
export const SETTINGS_STORAGE_FILE_NAME = 'provider-settings.json';
export const CONVERSATION_STATE_STORAGE_FILE_NAME = 'conversation-state-cache.json';
export const BACKEND_API_KEY_SECRET_KEY = 'ghccCustomProvider.backendApiKey';
export const BACKEND_API_KEY_SECRET_PREFIX = 'ghccCustomProvider.backendApiKey:';

const ENDPOINT_TYPES = new Set<BackendEndpointType>(['openai-compatible', 'lm-studio', 'lm-studio-rest']);
const TOGGLE_MODES = new Set<SettingToggleMode>(['auto', 'on', 'off']);
const LM_STUDIO_REASONING_MODES = new Set<LmStudioReasoningMode>(['auto', 'off', 'low', 'medium', 'high', 'on']);
const MANAGER_LANGUAGE_MODES = new Set<ManagerLanguageMode>(['auto', 'en', 'ja']);
const DEFAULT_ENDPOINT_ID = 'primary-endpoint';
const DEFAULT_ENDPOINT_NAME = 'Primary Endpoint';
const MAX_IDENTIFIER_LENGTH = 80;
const MAX_NAME_LENGTH = 120;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_MIME_TYPE_LENGTH = 200;
const MAX_CONTEXT_LENGTH = 10_000_000;
const MAX_OUTPUT_TOKENS = 1_000_000;
const MAX_ADVERTISED_TOOL_LIMIT = 512;
const MAX_PRESERVED_THINKING_CHARS = 1_000_000;
const MAX_CONVERSATION_TTL_MINUTES = 525_600;
const MAX_CONVERSATION_ENTRIES = 5_000;
const LEGACY_REASONING_MODEL_SUFFIX = '::reasoning';

export type BackendEndpointType = 'openai-compatible' | 'lm-studio' | 'lm-studio-rest';
export type SettingToggleMode = 'auto' | 'on' | 'off';
export type LmStudioReasoningMode = 'auto' | 'off' | 'low' | 'medium' | 'high' | 'on';
export type ManagerLanguageMode = 'auto' | 'en' | 'ja';

export interface BackendRequestOverrides {
  reasoningEffort: string;
  lmStudioReasoning: LmStudioReasoningMode;
  enableThinking: SettingToggleMode;
  preserveThinking: SettingToggleMode;
  preservedThinkingMaxChars?: number;
  syntheticReasoningReplayMaxChars?: number;
  contextLength?: number;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  presencePenalty?: number;
  repeatPenalty?: number;
  customBody: Record<string, unknown>;
}

export interface ModelMetadataOverride {
  displayName: string;
  family: string;
  detail: string;
  toolCalling: SettingToggleMode;
  imageInput: SettingToggleMode;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export interface BackendEndpointSettings {
  id: string;
  name: string;
  endpointType: BackendEndpointType;
  baseUrl: string;
  defaultModel: string;
  toolExposure: SettingToggleMode;
  advertisedToolLimit?: number;
  requestOverrides: BackendRequestOverrides;
  modelOverrides: Record<string, ModelMetadataOverride>;
}

export type BackendSettings = BackendEndpointSettings;

export interface ProbeSettings {
  showModel: boolean;
  debugLogging: boolean;
  emitHiddenState: boolean;
  hiddenStateMimeType: string;
}

export interface ModelPickerSettings {
  showModelsByDefault: boolean;
}

export interface ConversationStateSettings {
  persistAcrossReload: boolean;
  ttlMinutes: number;
  maxEntries: number;
}

export interface ManagerSettings {
  language: ManagerLanguageMode;
}

export interface BridgeStoredSettings {
  activeEndpointIds: string[];
  activeEndpointId: string;
  endpoints: BackendEndpointSettings[];
  backend: BackendEndpointSettings;
  probe: ProbeSettings;
  modelPicker: ModelPickerSettings;
  conversationState: ConversationStateSettings;
  manager: ManagerSettings;
}

export interface BridgeSettingsViewState {
  settings: BridgeStoredSettings;
  hasStoredApiKey: boolean;
  storedApiKeyEndpointIds: string[];
  storageExists: boolean;
  storageFileUri: vscode.Uri | null;
  storageRevision: string | null;
  storageReadError?: string;
  source: 'storage' | 'defaults' | 'legacy-configuration';
}

export const DEFAULT_BRIDGE_SETTINGS: BridgeStoredSettings = createDefaultBridgeSettings();

export function createDefaultBackendEndpointSettings(
  id: string = DEFAULT_ENDPOINT_ID,
  name: string = DEFAULT_ENDPOINT_NAME,
): BackendEndpointSettings {
  return {
    id,
    name,
    endpointType: 'openai-compatible',
    baseUrl: '',
    defaultModel: '',
    toolExposure: 'auto',
    advertisedToolLimit: undefined,
    requestOverrides: {
      reasoningEffort: '',
      lmStudioReasoning: 'auto',
      enableThinking: 'auto',
      preserveThinking: 'auto',
      preservedThinkingMaxChars: undefined,
      syntheticReasoningReplayMaxChars: undefined,
      contextLength: undefined,
      maxTokens: undefined,
      temperature: undefined,
      topP: undefined,
      topK: undefined,
      minP: undefined,
      presencePenalty: undefined,
      repeatPenalty: undefined,
      customBody: {},
    },
    modelOverrides: {},
  };
}

export function cloneDefaultBridgeSettings(): BridgeStoredSettings {
  return sanitizeStoredSettings(DEFAULT_BRIDGE_SETTINGS);
}

export function cloneBackendEndpointSettings(endpoint: BackendEndpointSettings): BackendEndpointSettings {
  return {
    ...endpoint,
    requestOverrides: cloneRequestOverrides(endpoint.requestOverrides),
    modelOverrides: cloneModelOverrides(endpoint.modelOverrides),
  };
}

export function getEndpointById(
  settings: Pick<BridgeStoredSettings, 'endpoints'>,
  endpointId: string,
): BackendEndpointSettings | undefined {
  return settings.endpoints.find((endpoint) => endpoint.id === endpointId);
}

export function getActiveEndpointIds(
  settings: Pick<BridgeStoredSettings, 'activeEndpointIds' | 'activeEndpointId' | 'endpoints'>,
): string[] {
  const endpointIds = new Set(settings.endpoints.map((endpoint) => endpoint.id));
  const seen = new Set<string>();
  const resolvedIds: string[] = [];

  for (const endpointId of settings.activeEndpointIds || []) {
    const normalizedEndpointId = typeof endpointId === 'string' ? endpointId.trim() : '';
    if (!normalizedEndpointId || !endpointIds.has(normalizedEndpointId) || seen.has(normalizedEndpointId)) {
      continue;
    }

    seen.add(normalizedEndpointId);
    resolvedIds.push(normalizedEndpointId);
  }

  if (resolvedIds.length > 0) {
    return resolvedIds;
  }

  const fallbackEndpointId = settings.activeEndpointId.trim();
  if (fallbackEndpointId && endpointIds.has(fallbackEndpointId)) {
    return [fallbackEndpointId];
  }

  return [];
}

export function getActiveEndpoints(
  settings: Pick<BridgeStoredSettings, 'activeEndpointIds' | 'activeEndpointId' | 'endpoints'>,
): BackendEndpointSettings[] {
  return getActiveEndpointIds(settings)
    .map((endpointId) => getEndpointById(settings, endpointId))
    .filter((endpoint): endpoint is BackendEndpointSettings => Boolean(endpoint));
}

export function getPrimaryActiveEndpoint(
  settings: Pick<BridgeStoredSettings, 'activeEndpointIds' | 'activeEndpointId' | 'endpoints'>,
): BackendEndpointSettings | undefined {
  return getActiveEndpoints(settings)[0];
}

export function isEndpointActive(
  settings: Pick<BridgeStoredSettings, 'activeEndpointIds' | 'activeEndpointId' | 'endpoints'>,
  endpointId: string,
): boolean {
  return getActiveEndpointIds(settings).includes(endpointId);
}

export function sanitizeStoredSettings(raw: unknown): BridgeStoredSettings {
  const defaultEndpoint = createDefaultBackendEndpointSettings();
  const disabledBackend = createDefaultBackendEndpointSettings('', '');
  const settings: BridgeStoredSettings = {
    activeEndpointIds: [defaultEndpoint.id],
    activeEndpointId: defaultEndpoint.id,
    endpoints: [cloneBackendEndpointSettings(defaultEndpoint)],
    backend: cloneBackendEndpointSettings(defaultEndpoint),
    probe: {
      showModel: false,
      debugLogging: false,
      emitHiddenState: false,
      hiddenStateMimeType: HIDDEN_STATE_MIME,
    },
    modelPicker: {
      showModelsByDefault: true,
    },
    conversationState: {
      persistAcrossReload: false,
      ttlMinutes: 720,
      maxEntries: 200,
    },
    manager: {
      language: 'auto',
    },
  };

  if (!raw || typeof raw !== 'object') {
    return settings;
  }

  const candidate = raw as {
    activeEndpointIds?: unknown;
    activeEndpointId?: unknown;
    endpoints?: unknown;
    backend?: Partial<BackendEndpointSettings> & {
      requestOverrides?: unknown;
      modelOverrides?: unknown;
    };
    probe?: Partial<{
      showModel: boolean;
      debugLogging: boolean;
      emitHiddenState: boolean;
      hiddenStateMimeType: string;
    }>;
    modelPicker?: Partial<ModelPickerSettings>;
    conversationState?: Partial<ConversationStateSettings>;
    manager?: Partial<ManagerSettings>;
  };

  const sanitizedEndpoints = sanitizeEndpointList(candidate.endpoints);
  if (sanitizedEndpoints.length > 0) {
    settings.endpoints = sanitizedEndpoints;
  } else if (candidate.backend) {
    settings.endpoints = [sanitizeBackendEndpointCandidate(candidate.backend, DEFAULT_ENDPOINT_ID, DEFAULT_ENDPOINT_NAME)];
  }

  const rawActiveEndpointId = typeof candidate.activeEndpointId === 'string'
    ? candidate.activeEndpointId
    : undefined;
  const hasExplicitActiveEndpointId = rawActiveEndpointId !== undefined;
  const requestedActiveEndpointId = rawActiveEndpointId?.trim();
  let activeEndpointIds = sanitizeActiveEndpointIds(candidate.activeEndpointIds, settings.endpoints);
  if (activeEndpointIds.length === 0 && !Array.isArray(candidate.activeEndpointIds)) {
    if (requestedActiveEndpointId && getEndpointById(settings, requestedActiveEndpointId)) {
      activeEndpointIds = [requestedActiveEndpointId];
    } else if (!hasExplicitActiveEndpointId && settings.endpoints[0]) {
      activeEndpointIds = [settings.endpoints[0].id];
    }
  }

  settings.activeEndpointIds = activeEndpointIds;

  const activeEndpoint = getPrimaryActiveEndpoint(settings);
  settings.activeEndpointId = activeEndpoint?.id ?? '';
  settings.backend = cloneBackendEndpointSettings(activeEndpoint ?? disabledBackend);

  if (candidate.probe) {
    if (typeof candidate.probe.showModel === 'boolean') {
      settings.probe.showModel = candidate.probe.showModel;
    }

    if (typeof candidate.probe.debugLogging === 'boolean') {
      settings.probe.debugLogging = candidate.probe.debugLogging;
    }

    if (typeof candidate.probe.emitHiddenState === 'boolean') {
      settings.probe.emitHiddenState = candidate.probe.emitHiddenState;
    }

    if (typeof candidate.probe.hiddenStateMimeType === 'string') {
      const mimeType = candidate.probe.hiddenStateMimeType.trim();
      settings.probe.hiddenStateMimeType = sanitizeLimitedString(mimeType, MAX_MIME_TYPE_LENGTH) || HIDDEN_STATE_MIME;
    }
  }

  if (candidate.modelPicker) {
    if (typeof candidate.modelPicker.showModelsByDefault === 'boolean') {
      settings.modelPicker.showModelsByDefault = candidate.modelPicker.showModelsByDefault;
    }
  }

  if (candidate.conversationState) {
    if (typeof candidate.conversationState.persistAcrossReload === 'boolean') {
      settings.conversationState.persistAcrossReload = candidate.conversationState.persistAcrossReload;
    }

    settings.conversationState.ttlMinutes =
      parseOptionalInteger(candidate.conversationState.ttlMinutes, MAX_CONVERSATION_TTL_MINUTES) ?? settings.conversationState.ttlMinutes;
    settings.conversationState.maxEntries =
      parseOptionalInteger(candidate.conversationState.maxEntries, MAX_CONVERSATION_ENTRIES) ?? settings.conversationState.maxEntries;
  }

  if (candidate.manager) {
    settings.manager.language = normalizeManagerLanguageMode(candidate.manager.language);
  }

  return settings;
}

export function readLegacySettingsFromConfiguration(): { settings: BridgeStoredSettings; isConfigured: boolean } {
  const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const baseUrl = getSettingState<string>(configuration, 'backend.baseUrl', '');
  const defaultModel = getSettingState<string>(configuration, 'backend.defaultModel', '');
  const debugLogging = getSettingState<boolean>(configuration, 'debugLogging', false);
  const emitHiddenState = getSettingState<boolean>(configuration, 'hiddenStateProbe.enabled', false);
  const hiddenStateMimeType = getSettingState<string>(configuration, 'hiddenStateProbe.mimeType', HIDDEN_STATE_MIME);

  return {
    settings: sanitizeStoredSettings({
      activeEndpointIds: [DEFAULT_ENDPOINT_ID],
      activeEndpointId: DEFAULT_ENDPOINT_ID,
      endpoints: [
        {
          id: DEFAULT_ENDPOINT_ID,
          name: DEFAULT_ENDPOINT_NAME,
          endpointType: 'openai-compatible',
          baseUrl: baseUrl.value,
          defaultModel: normalizeStoredModelId(defaultModel.value),
          toolExposure: 'auto',
          advertisedToolLimit: undefined,
          requestOverrides: createDefaultBackendEndpointSettings().requestOverrides,
          modelOverrides: {},
        },
      ],
      probe: {
        debugLogging: debugLogging.value,
        emitHiddenState: emitHiddenState.value,
        hiddenStateMimeType: hiddenStateMimeType.value,
      },
    }),
    isConfigured: baseUrl.isConfigured || defaultModel.isConfigured || debugLogging.isConfigured || emitHiddenState.isConfigured || hiddenStateMimeType.isConfigured,
  };
}

export function sanitizeRequestOverrides(raw: unknown): BackendRequestOverrides {
  const source = isPlainObject(raw) ? raw : {};

  return {
    reasoningEffort: typeof source.reasoningEffort === 'string' ? source.reasoningEffort.trim() : '',
    lmStudioReasoning: normalizeLmStudioReasoningMode(source.lmStudioReasoning),
    enableThinking: normalizeToggleMode(source.enableThinking),
    preserveThinking: normalizeToggleMode(source.preserveThinking),
    preservedThinkingMaxChars: parseOptionalThinkingCharLimit(source.preservedThinkingMaxChars, MAX_PRESERVED_THINKING_CHARS),
    syntheticReasoningReplayMaxChars: parseOptionalThinkingCharLimit(source.syntheticReasoningReplayMaxChars, MAX_PRESERVED_THINKING_CHARS),
    contextLength: parseOptionalInteger(source.contextLength, MAX_CONTEXT_LENGTH),
    maxTokens: parseOptionalInteger(source.maxTokens, MAX_OUTPUT_TOKENS),
    temperature: parseOptionalNumber(source.temperature),
    topP: parseOptionalNumber(source.topP),
    topK: parseOptionalInteger(source.topK, MAX_CONTEXT_LENGTH),
    minP: parseOptionalNumber(source.minP),
    presencePenalty: parseOptionalNumber(source.presencePenalty),
    repeatPenalty: parseOptionalNumber(source.repeatPenalty),
    customBody: parseOptionalObject(source.customBody),
  };
}

export function sanitizeModelOverrides(raw: unknown): Record<string, ModelMetadataOverride> {
  if (!isPlainObject(raw)) {
    return {};
  }

  const sanitizedEntries = Object.entries(raw)
    .map(([modelId, value]) => {
      const normalizedId = modelId.trim();
      if (!normalizedId || !isPlainObject(value)) {
        return undefined;
      }

      const override: ModelMetadataOverride = {
        displayName: typeof value.displayName === 'string' ? value.displayName.trim() : '',
        family: typeof value.family === 'string' ? value.family.trim() : '',
        detail: typeof value.detail === 'string' ? value.detail.trim() : '',
        toolCalling: normalizeToggleMode(value.toolCalling),
        imageInput: normalizeToggleMode(value.imageInput),
        maxInputTokens: parseOptionalInteger(value.maxInputTokens, MAX_CONTEXT_LENGTH),
        maxOutputTokens: parseOptionalInteger(value.maxOutputTokens, MAX_OUTPUT_TOKENS),
      };

      return [normalizedId, override] as const;
    })
    .filter((entry): entry is readonly [string, ModelMetadataOverride] => Boolean(entry));

  return Object.fromEntries(sanitizedEntries);
}

export function assertUniqueEndpointNames(
  endpoints: readonly Pick<BackendEndpointSettings, 'name'>[],
): void {
  const seenNames = new Map<string, string>();

  for (const endpoint of endpoints) {
    const endpointName = sanitizeLimitedString(endpoint.name || '', MAX_NAME_LENGTH);
    const normalizedName = endpointName.toLowerCase();
    if (!normalizedName) {
      continue;
    }

    if (seenNames.has(normalizedName)) {
      throw new Error(`Endpoint names must be unique. "${endpointName}" is already in use.`);
    }

    seenNames.set(normalizedName, endpointName);
  }
}

function createDefaultBridgeSettings(): BridgeStoredSettings {
  const endpoint = createDefaultBackendEndpointSettings();
  return {
    activeEndpointIds: [endpoint.id],
    activeEndpointId: endpoint.id,
    endpoints: [cloneBackendEndpointSettings(endpoint)],
    backend: cloneBackendEndpointSettings(endpoint),
    probe: {
      showModel: false,
      debugLogging: false,
      emitHiddenState: false,
      hiddenStateMimeType: HIDDEN_STATE_MIME,
    },
    modelPicker: {
      showModelsByDefault: true,
    },
    conversationState: {
      persistAcrossReload: false,
      ttlMinutes: 720,
      maxEntries: 200,
    },
    manager: {
      language: 'auto',
    },
  };
}

function sanitizeEndpointList(raw: unknown): BackendEndpointSettings[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const usedIds = new Set<string>();
  return raw
    .map((candidate, index) => sanitizeBackendEndpointCandidate(candidate, `endpoint-${index + 1}`, `Endpoint ${index + 1}`))
    .map((endpoint, index) => withUniqueEndpointId(endpoint, usedIds, index));
}

function sanitizeActiveEndpointIds(
  raw: unknown,
  endpoints: readonly BackendEndpointSettings[],
): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const availableIds = new Set(endpoints.map((endpoint) => endpoint.id));
  const seenIds = new Set<string>();
  const activeEndpointIds: string[] = [];

  for (const value of raw) {
    const endpointId = typeof value === 'string' ? value.trim() : '';
    if (!endpointId || !availableIds.has(endpointId) || seenIds.has(endpointId)) {
      continue;
    }

    seenIds.add(endpointId);
    activeEndpointIds.push(endpointId);
  }

  return activeEndpointIds;
}

function sanitizeBackendEndpointCandidate(
  raw: unknown,
  fallbackId: string,
  fallbackName: string,
): BackendEndpointSettings {
  const source = isPlainObject(raw) ? raw : {};
  const endpoint = createDefaultBackendEndpointSettings(fallbackId, fallbackName);

  endpoint.id = normalizeIdentifier(typeof source.id === 'string' ? source.id : fallbackId, fallbackId);
  endpoint.name = typeof source.name === 'string' && source.name.trim()
    ? sanitizeLimitedString(source.name, MAX_NAME_LENGTH)
    : fallbackName;
  endpoint.endpointType = normalizeEndpointType(source.endpointType);
  endpoint.baseUrl = typeof source.baseUrl === 'string' ? normalizeBaseUrl(source.baseUrl) : '';
  endpoint.defaultModel = typeof source.defaultModel === 'string' ? normalizeStoredModelId(source.defaultModel) : '';
  endpoint.toolExposure = normalizeToggleMode(source.toolExposure);
  endpoint.advertisedToolLimit = parseOptionalInteger(source.advertisedToolLimit, MAX_ADVERTISED_TOOL_LIMIT);
  endpoint.requestOverrides = sanitizeRequestOverrides(source.requestOverrides);
  endpoint.modelOverrides = sanitizeModelOverrides(source.modelOverrides);

  return endpoint;
}

function withUniqueEndpointId(
  endpoint: BackendEndpointSettings,
  usedIds: Set<string>,
  index: number,
): BackendEndpointSettings {
  const baseId = endpoint.id || `endpoint-${index + 1}`;
  let nextId = baseId;
  let suffix = 2;

  while (usedIds.has(nextId)) {
    nextId = `${baseId}-${suffix}`;
    suffix += 1;
  }

  usedIds.add(nextId);

  return {
    ...endpoint,
    id: nextId,
  };
}

function cloneRequestOverrides(overrides: BackendRequestOverrides): BackendRequestOverrides {
  return {
    ...overrides,
    customBody: clonePlainObject(overrides.customBody),
  };
}

function normalizeStoredModelId(value: string): string {
  const trimmed = value.trim();
  const normalized = trimmed.endsWith(LEGACY_REASONING_MODEL_SUFFIX)
    ? trimmed.slice(0, -LEGACY_REASONING_MODEL_SUFFIX.length)
    : trimmed;
  return sanitizeLimitedString(normalized, MAX_MODEL_ID_LENGTH);
}

function cloneModelOverrides(overrides: Record<string, ModelMetadataOverride>): Record<string, ModelMetadataOverride> {
  return Object.fromEntries(
    Object.entries(overrides).map(([modelId, override]) => [
      modelId,
      {
        ...override,
      },
    ]),
  );
}

function clonePlainObject(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function normalizeIdentifier(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_IDENTIFIER_LENGTH)
    .replace(/-+$/g, '');
  return normalized || fallback;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }

    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function sanitizeLimitedString(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
}

function normalizeEndpointType(value: unknown): BackendEndpointType {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return ENDPOINT_TYPES.has(normalized as BackendEndpointType)
    ? normalized as BackendEndpointType
    : 'openai-compatible';
}

function normalizeToggleMode(value: unknown): SettingToggleMode {
  if (typeof value === 'boolean') {
    return value ? 'on' : 'off';
  }

  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : 'auto';
  return TOGGLE_MODES.has(normalized as SettingToggleMode) ? normalized as SettingToggleMode : 'auto';
}

function normalizeLmStudioReasoningMode(value: unknown): LmStudioReasoningMode {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : 'auto';
  return LM_STUDIO_REASONING_MODES.has(normalized as LmStudioReasoningMode)
    ? normalized as LmStudioReasoningMode
    : 'auto';
}

function normalizeManagerLanguageMode(value: unknown): ManagerLanguageMode {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : 'auto';
  return MANAGER_LANGUAGE_MODES.has(normalized as ManagerLanguageMode)
    ? normalized as ManagerLanguageMode
    : 'auto';
}

function parseOptionalInteger(value: unknown, maxValue = Number.MAX_SAFE_INTEGER): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return Math.min(value, maxValue);
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return Math.min(parsed, maxValue);
    }
  }

  return undefined;
}

function parseOptionalThinkingCharLimit(value: unknown, maxValue = Number.MAX_SAFE_INTEGER): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value === -1) {
    return -1;
  }

  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return Math.min(value, maxValue);
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed === -1) {
      return -1;
    }

    if (Number.isInteger(parsed) && parsed >= 0) {
      return Math.min(parsed, maxValue);
    }
  }

  return undefined;
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function parseOptionalObject(value: unknown): Record<string, unknown> {
  if (isPlainObject(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return isPlainObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  return {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function getSettingState<T>(configuration: vscode.WorkspaceConfiguration, key: string, defaultValue: T): { value: T; isConfigured: boolean } {
  const inspected = configuration.inspect<T>(key);
  const value = inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue ?? defaultValue;

  return {
    value,
    isConfigured: Boolean(
      inspected && (
        inspected.workspaceFolderValue !== undefined ||
        inspected.workspaceValue !== undefined ||
        inspected.globalValue !== undefined
      )
    ),
  };
}

export function getChatEndpointType(endpointType: BackendEndpointType): BackendEndpointType {
  return endpointType === 'lm-studio' ? 'openai-compatible' : endpointType;
}

export function getModelDiscoveryEndpointType(endpointType: BackendEndpointType): BackendEndpointType {
  return endpointType === 'lm-studio' ? 'lm-studio-rest' : endpointType;
}

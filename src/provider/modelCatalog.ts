import * as vscode from 'vscode';

import {
  BackendEndpointSettings,
  BridgeStoredSettings,
  ModelMetadataOverride,
  getActiveEndpoints,
  getModelDiscoveryEndpointType,
  getRuntimeEndpointBaseUrl,
} from '../config/settings';
import { EndpointModelCacheStore } from './endpointModelCache';
import { UpstreamConnectionSettings, UpstreamModelInfo, createBackendEndpointClient } from './upstreamClient';

export interface BridgeChatModel extends vscode.LanguageModelChatInformation {
  readonly source: 'probe' | 'backend' | 'setup';
  readonly setupReason?: SetupModelReason;
  readonly upstreamId?: string;
  readonly endpointId?: string;
  readonly endpointName?: string;
  readonly isUserSelectable?: boolean;
}

interface ModelCatalogListOptions {
  readonly includeSetupModel?: boolean;
}

export type SetupModelReason = 'available' | 'disabled' | 'not-configured' | 'not-tested' | 'connection-error' | 'no-models';

interface SetupModelContext {
  readonly reason: SetupModelReason;
  readonly endpointLabel?: string;
  readonly errorMessage?: string;
}

interface EndpointCatalogResult {
  readonly models: BridgeChatModel[];
  readonly setupContext?: SetupModelContext;
}

const FALLBACK_MAX_INPUT_TOKENS = 32768;
const FALLBACK_MAX_OUTPUT_TOKENS = 4096;

const PROBE_MODEL: BridgeChatModel = {
  id: 'ghcc-custom-provider-bridge-probe',
  name: 'GHCC Custom Provider Probe',
  family: 'ghcc-custom-provider-bridge-probe',
  version: '0.1.0',
  maxInputTokens: FALLBACK_MAX_INPUT_TOKENS,
  maxOutputTokens: FALLBACK_MAX_OUTPUT_TOKENS,
  capabilities: {
    toolCalling: false,
    imageInput: false,
  },
  detail: 'Diagnostic model for checking whether hidden chat data survives between turns.',
  tooltip: 'Troubleshooting only. Use this to inspect whether hidden chat data is returned on later turns.',
  isUserSelectable: true,
  source: 'probe',
};

const SETUP_MODEL_ID = 'ghcc-custom-provider-bridge-setup';

export class ModelCatalog {
  constructor(private readonly modelCacheStore: EndpointModelCacheStore) {}

  async listModels(
    settings: BridgeStoredSettings,
    _token: vscode.CancellationToken,
    options: ModelCatalogListOptions = {},
  ): Promise<BridgeChatModel[]> {
    const models: BridgeChatModel[] = settings.probe.showModel ? [PROBE_MODEL] : [];
    const activeEndpoints = getActiveEndpoints(settings);
    if (activeEndpoints.length === 0) {
      return appendSetupModel(models, options, { reason: 'disabled' });
    }

    const backendModels: BridgeChatModel[] = [];
    const endpointContexts: SetupModelContext[] = [];

    for (const endpoint of activeEndpoints) {
      const result = this.listEndpointModels(endpoint, settings.modelPicker.showModelsByDefault);
      backendModels.push(...result.models);
      if (result.setupContext) {
        endpointContexts.push(result.setupContext);
      }
    }

    const availableModels = [...models, ...disambiguateDuplicateModelNames(backendModels)];
    return appendSetupModel(availableModels, options, selectSetupModelContext(endpointContexts, backendModels.length > 0));
  }

  getProbeModel(): BridgeChatModel {
    return PROBE_MODEL;
  }

  private listEndpointModels(endpoint: BackendEndpointSettings, showModelsByDefault: boolean): EndpointCatalogResult {
    const connection = buildConnection(endpoint);
    if (!connection) {
      return {
        models: [],
        setupContext: {
          reason: 'not-configured',
          endpointLabel: buildModelDetail(endpoint),
        },
      };
    }

    const normalizedBaseUrl = connection.baseUrl.replace(/\/$/, '');
    const endpointLabel = normalizedBaseUrl || buildModelDetail(endpoint);
    const cachedEntry = this.modelCacheStore.get(endpoint.id, connection.endpointType, connection.baseUrl);
    if (!cachedEntry) {
      return {
        models: [],
        setupContext: {
          reason: 'not-tested',
          endpointLabel,
        },
      };
    }

    if (cachedEntry.kind === 'error') {
      return {
        models: [],
        setupContext: {
          reason: 'connection-error',
          endpointLabel,
          errorMessage: cachedEntry.detail,
        },
      };
    }

    const endpointModels = cachedEntry.chatModels.flatMap((model) => mapUpstreamModelToBridgeModels(model, endpoint, showModelsByDefault));
    return {
      models: this.sortBackendModels(endpointModels, endpoint.defaultModel),
      setupContext: endpointModels.length === 0
        ? {
          reason: 'no-models',
          endpointLabel,
        }
        : undefined,
    };
  }

  private sortBackendModels(models: BridgeChatModel[], preferredModelId: string): BridgeChatModel[] {
    const preferred = normalizeLegacyPreferredModelId(preferredModelId);
    return [...models].sort((left, right) => {
      if (preferred) {
        if ((left.upstreamId || left.id) === preferred && (right.upstreamId || right.id) !== preferred) {
          return -1;
        }

        if ((right.upstreamId || right.id) === preferred && (left.upstreamId || left.id) !== preferred) {
          return 1;
        }
      }

      return left.name.localeCompare(right.name);
    });
  }
}

function buildConnection(endpoint: BackendEndpointSettings): UpstreamConnectionSettings | undefined {
  const baseUrl = getRuntimeEndpointBaseUrl(endpoint).trim();
  if (!baseUrl) {
    return undefined;
  }

  return {
    endpointType: endpoint.endpointType,
    baseUrl,
  };
}

export async function fetchBackendChatModels(
  connection: UpstreamConnectionSettings,
  outputChannel: vscode.LogOutputChannel,
  token: vscode.CancellationToken,
): Promise<UpstreamModelInfo[]> {
  const discoveryEndpointType = getModelDiscoveryEndpointType(connection.endpointType);
  const upstreamClient = createBackendEndpointClient(discoveryEndpointType, outputChannel);
  const upstreamModels = await upstreamClient.listModels({
    ...connection,
    endpointType: discoveryEndpointType,
  }, token);
  return upstreamModels.filter((model) => isChatModel(model));
}

function isChatModel(model: UpstreamModelInfo): boolean {
  const kind = model.kind?.toLowerCase() ?? '';
  if (kind.includes('embed') || kind.includes('rerank')) {
    return false;
  }

  const normalized = model.id.toLowerCase();
  return !normalized.includes('embedding') && !normalized.includes('embed') && !normalized.includes('rerank');
}

function mapUpstreamModelToBridgeModels(
  model: UpstreamModelInfo,
  endpoint: BackendEndpointSettings,
  showModelsByDefault: boolean,
): BridgeChatModel[] {
  const override = resolveModelOverride(endpoint, model.id);
  const maxInputTokens = override.maxInputTokens ?? model.contextLength ?? model.maxModelLen ?? FALLBACK_MAX_INPUT_TOKENS;
  const capabilities = inferCapabilities(model, endpoint, override);
  const name = override.displayName || model.displayName || model.id;
  const endpointLabel = buildModelDetail(endpoint);

  return [{
    id: createScopedModelId(endpoint.id, model.id),
    name,
    family: override.family || inferFamily(model.id),
    version: 'backend',
    maxInputTokens,
    maxOutputTokens: override.maxOutputTokens ?? Math.min(FALLBACK_MAX_OUTPUT_TOKENS, Math.max(2048, Math.floor(maxInputTokens / 4))),
    capabilities,
    detail: override.detail || endpointLabel,
    tooltip: buildModelTooltip(name, endpointLabel),
    isUserSelectable: showModelsByDefault,
    source: 'backend',
    upstreamId: model.id,
    endpointId: endpoint.id,
    endpointName: endpoint.name,
  }];
}

function inferFamily(modelId: string): string {
  const normalized = modelId.toLowerCase();
  if (normalized.startsWith('qwen')) {
    return 'qwen';
  }

  if (normalized.startsWith('llama')) {
    return 'llama';
  }

  if (normalized.startsWith('mistral') || normalized.startsWith('mixtral')) {
    return 'mistral';
  }

  return modelId.split(/[-:]/, 1)[0] || 'backend';
}

function inferCapabilities(
  model: UpstreamModelInfo,
  endpoint: BackendEndpointSettings,
  override: ModelMetadataOverride,
): vscode.LanguageModelChatCapabilities {
  const normalized = model.id.toLowerCase();
  const supportedFeatures = model.supportedFeatures ?? [];
  const inputModalities = model.inputModalities ?? [];

  const inferredImageInput =
    model.endpointCapabilities?.imageInput ??
    (inputModalities.includes('image') || /qwen|vision|vl|llava|pixtral|gemma3|minicpm-v/.test(normalized));

  const imageInput = override.imageInput === 'on'
    ? true
    : override.imageInput === 'off'
      ? false
      : inferredImageInput;

  const explicitToolCalling = override.toolCalling === 'on'
    ? 128
    : override.toolCalling === 'off'
      ? false
      : undefined;

  const configuredToolExposure = endpoint.toolExposure === 'on'
    ? 128
    : endpoint.toolExposure === 'off'
      ? false
      : undefined;

  const inferredToolCalling =
    (model.endpointCapabilities?.toolCalling ?? (supportedFeatures.includes('tools') || /qwen|llama|mistral|deepseek|gemma/.test(normalized)))
      ? 128
      : false;

  const toolCalling = applyAdvertisedToolLimit(
    explicitToolCalling ?? configuredToolExposure ?? inferredToolCalling,
    endpoint.advertisedToolLimit,
  );

  return {
    imageInput,
    toolCalling,
  };
}

function buildModelDetail(endpoint: BackendEndpointSettings): string {
  const endpointName = endpoint.name.trim();
  if (endpointName) {
    return endpointName;
  }

  const baseUrl = endpoint.baseUrl.trim();
  if (baseUrl) {
    return baseUrl;
  }

  switch (endpoint.endpointType) {
    case 'lm-studio':
      return 'LM Studio';
    case 'lm-studio-rest':
      return 'LM Studio Native';
    default:
      return 'OpenAI-compatible';
  }
}

function buildModelTooltip(name: string, endpointLabel: string): string {
  return `${name} from ${endpointLabel}.`;
}

function normalizeLegacyPreferredModelId(modelId: string): string {
  const trimmed = modelId.trim();
  return trimmed.endsWith('::reasoning') ? trimmed.slice(0, -'::reasoning'.length) : trimmed;
}

function resolveModelOverride(endpoint: BackendEndpointSettings, modelId: string): ModelMetadataOverride {
  const wildcardOverride = endpoint.modelOverrides['*'];
  const exactOverride = endpoint.modelOverrides[modelId];

  return {
    displayName: exactOverride?.displayName || wildcardOverride?.displayName || '',
    family: exactOverride?.family || wildcardOverride?.family || '',
    detail: exactOverride?.detail || wildcardOverride?.detail || '',
    toolCalling: exactOverride?.toolCalling || wildcardOverride?.toolCalling || 'auto',
    imageInput: exactOverride?.imageInput || wildcardOverride?.imageInput || 'auto',
    maxInputTokens: exactOverride?.maxInputTokens ?? wildcardOverride?.maxInputTokens,
    maxOutputTokens: exactOverride?.maxOutputTokens ?? wildcardOverride?.maxOutputTokens,
  };
}

function selectSetupModelContext(
  contexts: readonly SetupModelContext[],
  hasAvailableModels: boolean,
): SetupModelContext {
  if (hasAvailableModels) {
    return { reason: 'available' };
  }

  const priority: SetupModelReason[] = ['connection-error', 'not-tested', 'not-configured', 'no-models', 'disabled', 'available'];
  for (const reason of priority) {
    const context = contexts.find((candidate) => candidate.reason === reason);
    if (context) {
      return context;
    }
  }

  return { reason: 'available' };
}

function createScopedModelId(endpointId: string, upstreamModelId: string): string {
  return `endpoint:${encodeURIComponent(endpointId)}:model:${encodeURIComponent(upstreamModelId)}`;
}

function disambiguateDuplicateModelNames(models: readonly BridgeChatModel[]): BridgeChatModel[] {
  const nameCounts = new Map<string, number>();
  for (const model of models) {
    const normalizedName = normalizeModelNameForComparison(model.name);
    nameCounts.set(normalizedName, (nameCounts.get(normalizedName) ?? 0) + 1);
  }

  return models.map((model) => {
    const normalizedName = normalizeModelNameForComparison(model.name);
    if ((nameCounts.get(normalizedName) ?? 0) < 2) {
      return model;
    }

    const endpointLabel = (model.endpointName || model.detail || model.endpointId || '').trim();
    if (!endpointLabel || model.name.endsWith(` @ ${endpointLabel}`)) {
      return model;
    }

    return {
      ...model,
      name: `${model.name} @ ${endpointLabel}`,
    };
  });
}

function normalizeModelNameForComparison(name: string): string {
  return name.trim().toLowerCase();
}

function applyAdvertisedToolLimit(toolCalling: boolean | number | undefined, limit: number | undefined): boolean | number | undefined {
  if (limit === undefined) {
    return toolCalling;
  }

  if (!toolCalling) {
    return toolCalling;
  }

  if (toolCalling === true) {
    return limit;
  }

  return Math.max(1, Math.min(toolCalling, limit));
}

function appendSetupModel(
  models: BridgeChatModel[],
  options: ModelCatalogListOptions,
  context: SetupModelContext,
): BridgeChatModel[] {
  if (options.includeSetupModel === false) {
    return models;
  }

  const filteredModels = models.filter((model) => model.id !== SETUP_MODEL_ID);
  return [...filteredModels, createSetupModel(context)];
}

function createSetupModel(context: SetupModelContext): BridgeChatModel {
  const japanese = isJapaneseLocale();
  const endpointLabel = context.endpointLabel || (japanese ? '現在のエンドポイント' : 'the current endpoint');
  const errorMessage = truncateUiText(context.errorMessage || (japanese ? '不明なエラー' : 'Unknown error'));

  switch (context.reason) {
    case 'available':
      return {
        id: SETUP_MODEL_ID,
        name: japanese
          ? '(GHCC Custom Provider)会話して設定画面を開く'
          : '(GHCC Custom Provider)Open Settings by Chatting',
        family: 'ghcc-custom-provider-bridge-setup',
        version: '0.1.0',
        maxInputTokens: 4096,
        maxOutputTokens: 1024,
        capabilities: {
          toolCalling: true,
          imageInput: false,
        },
        detail: 'GHCC Custom Provider',
        tooltip: japanese
          ? 'この項目を選んでメッセージを送ると、GHCC Custom Provider の設定画面を開きます。'
          : 'Select this entry and send a chat message to open the GHCC Custom Provider manager.',
        isUserSelectable: true,
        setupReason: context.reason,
        source: 'setup',
      };
    case 'disabled':
      return {
        id: SETUP_MODEL_ID,
        name: japanese
          ? '(GHCC Custom Provider)会話して設定画面を開く（エラー：接続先が無効です）'
          : '(GHCC Custom Provider)Open Settings by Chatting (Error: Endpoint Disabled)',
        family: 'ghcc-custom-provider-bridge-setup',
        version: '0.1.0',
        maxInputTokens: 4096,
        maxOutputTokens: 1024,
        capabilities: {
          toolCalling: true,
          imageInput: false,
        },
        detail: 'GHCC Custom Provider',
        tooltip: japanese
          ? '現在有効な接続先がありません。設定画面を開いて 1 つ以上の接続先を有効化してください。'
          : 'No endpoint is currently enabled. Open settings to enable one or more connections.',
        isUserSelectable: true,
        setupReason: context.reason,
        source: 'setup',
      };
    case 'not-configured':
      return {
        id: SETUP_MODEL_ID,
        name: japanese
          ? '(GHCC Custom Provider)会話して設定画面を開く（エラー：設定が必要です）'
          : '(GHCC Custom Provider)Open Settings by Chatting (Error: Configuration Required)',
        family: 'ghcc-custom-provider-bridge-setup',
        version: '0.1.0',
        maxInputTokens: 4096,
        maxOutputTokens: 1024,
        capabilities: {
          toolCalling: true,
          imageInput: false,
        },
        detail: 'GHCC Custom Provider',
        tooltip: japanese
          ? 'エンドポイントが未設定です。設定画面を開いて接続先を追加してください。'
          : 'No endpoint is configured. Open settings to add a connection.',
        isUserSelectable: true,
        setupReason: context.reason,
        source: 'setup',
      };
    case 'not-tested':
      return {
        id: SETUP_MODEL_ID,
        name: japanese
          ? '(GHCC Custom Provider)会話して設定画面を開く（エラー：接続テストが必要です）'
          : '(GHCC Custom Provider)Open Settings by Chatting (Error: Connection Test Required)',
        family: 'ghcc-custom-provider-bridge-setup',
        version: '0.1.0',
        maxInputTokens: 4096,
        maxOutputTokens: 1024,
        capabilities: {
          toolCalling: true,
          imageInput: false,
        },
        detail: 'GHCC Custom Provider',
        tooltip: japanese
          ? `${endpointLabel} のモデル一覧はまだ取得していません。設定画面で 接続テスト を実行してください。`
          : `The model list for ${endpointLabel} has not been fetched yet. Run Test connection in the manager.`,
        isUserSelectable: true,
        setupReason: context.reason,
        source: 'setup',
      };
    case 'connection-error':
      return {
        id: SETUP_MODEL_ID,
        name: japanese
          ? '(GHCC Custom Provider)会話して設定画面を開く（エラー：接続エラーです）'
          : '(GHCC Custom Provider)Open Settings by Chatting (Error: Connection Error)',
        family: 'ghcc-custom-provider-bridge-setup',
        version: '0.1.0',
        maxInputTokens: 4096,
        maxOutputTokens: 1024,
        capabilities: {
          toolCalling: true,
          imageInput: false,
        },
        detail: 'GHCC Custom Provider',
        tooltip: japanese
          ? `${endpointLabel} に接続できません。設定画面で URL や API キーを確認してください。直近のエラー: ${errorMessage}`
          : `Could not connect to ${endpointLabel}. Open settings to check the URL and API key. Latest error: ${errorMessage}`,
        isUserSelectable: true,
        setupReason: context.reason,
        source: 'setup',
      };
    case 'no-models':
      return {
        id: SETUP_MODEL_ID,
        name: japanese
          ? '(GHCC Custom Provider)会話して設定画面を開く（エラー：モデルが見つかりません）'
          : '(GHCC Custom Provider)Open Settings by Chatting (Error: No Models Found)',
        family: 'ghcc-custom-provider-bridge-setup',
        version: '0.1.0',
        maxInputTokens: 4096,
        maxOutputTokens: 1024,
        capabilities: {
          toolCalling: true,
          imageInput: false,
        },
        detail: 'GHCC Custom Provider',
        tooltip: japanese
          ? `${endpointLabel} から利用可能なチャットモデルを取得できませんでした。設定画面で接続先やバックエンド状態を確認してください。`
          : `No chat models were listed from ${endpointLabel}. Open settings to check the endpoint and backend state.`,
        isUserSelectable: true,
        setupReason: context.reason,
        source: 'setup',
      };
  }
}

function isJapaneseLocale(): boolean {
  return vscode.env.language.toLowerCase().startsWith('ja');
}

function truncateUiText(value: string, limit: number = 160): string {
  const trimmed = value.trim();
  if (trimmed.length <= limit) {
    return trimmed;
  }

  return `${trimmed.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}
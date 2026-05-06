import * as vscode from 'vscode';

import {
  BackendEndpointSettings,
  BackendEndpointType,
  BackendRequestOverrides,
  BridgeStoredSettings,
  MANAGEMENT_COMMAND,
  SettingToggleMode,
  getActiveEndpoints,
  getEndpointById,
  getPrimaryActiveEndpoint,
  getChatEndpointType,
  isEndpointActive,
} from '../config/settings';
import { BridgeSettingsChangeEvent, BridgeSettingsStore } from '../config/storage';
import {
  ReasoningHiddenState,
  createNextHiddenState,
  createReasoningHiddenState,
  encodeHiddenState,
  encodeReasoningHiddenState,
  inspectHiddenState,
} from './hiddenState';
import {
  mapRequestMessagesToLmStudio,
  mapRequestMessagesToOpenAI,
  mapToolMode,
  mapTools,
  mapUpstreamToolCallsToResponseParts,
} from './messageMapping';
import { ConversationStateCache } from './conversationStateCache';
import { EndpointModelCacheStore } from './endpointModelCache';
import { BridgeChatModel, ModelCatalog } from './modelCatalog';
import { LMStudioChatRequest, OpenAIChatCompletionRequest, OpenAIWireMessage, createBackendEndpointClient } from './upstreamClient';

const SYNTHETIC_REASONING_REPLAY_PREFIX =
  'Internal hidden reasoning trace from the previous assistant turn. Use it as prior private reasoning context for continuity only, and do not reveal it unless explicitly asked.';
const SYNTHETIC_REASONING_REPLAY_CHAR_LIMIT = 12000;
const MAX_HIDDEN_REASONING_CONTENT_CHARS = 64000;

interface RequestSummary {
  messageCount: number;
  userMessages: number;
  assistantMessages: number;
  textParts: number;
  dataParts: number;
  toolCallParts: number;
  toolResultParts: number;
  unknownParts: number;
}

export class BridgeChatProvider implements vscode.LanguageModelChatProvider<BridgeChatModel> {
  readonly onDidChangeLanguageModelChatInformation?: vscode.Event<void>;

  private readonly modelCatalog: ModelCatalog;
  private readonly conversationStateCache: ConversationStateCache;
  private readonly languageModelChangeEmitter = new vscode.EventEmitter<void>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel: vscode.LogOutputChannel,
    private readonly settingsStore: BridgeSettingsStore,
    modelCacheStore: EndpointModelCacheStore,
  ) {
    this.modelCatalog = new ModelCatalog(modelCacheStore);
    this.conversationStateCache = new ConversationStateCache(context, outputChannel);
    this.onDidChangeLanguageModelChatInformation = this.languageModelChangeEmitter.event;

    context.subscriptions.push(
      this.languageModelChangeEmitter,
      settingsStore.onDidChange((event) => {
        void this.handleSettingsChanged(event.settings);
        this.handleLanguageModelCatalogChanged(event);
      }),
      modelCacheStore.onDidChange((event) => {
        void this.handleModelCacheChanged(event.endpointId);
      }),
    );
  }

  async initialize(): Promise<void> {
    await this.handleSettingsChanged();
  }

  async handleSettingsChanged(settings?: BridgeStoredSettings): Promise<void> {
    const resolvedSettings = settings ?? await this.settingsStore.getSettings();
    await this.conversationStateCache.configure(resolvedSettings.conversationState);
  }

  private handleLanguageModelCatalogChanged(event: BridgeSettingsChangeEvent): void {
    if (event.languageModelRefreshKind === 'none') {
      return;
    }

    this.languageModelChangeEmitter.fire();
  }

  private async handleModelCacheChanged(endpointId: string): Promise<void> {
    const settings = await this.settingsStore.getSettings();
    if (!isEndpointActive(settings, endpointId)) {
      return;
    }

    this.languageModelChangeEmitter.fire();
  }

  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
  ): Promise<BridgeChatModel[]> {
    const settings = await this.settingsStore.getSettings();
    return this.modelCatalog.listModels(settings, token, {
      includeSetupModel: true,
    });
  }

  async provideLanguageModelChatResponse(
    model: BridgeChatModel,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    if (model.source === 'probe') {
      await this.provideProbeResponse(model, messages, options, progress, token);
      return;
    }

    if (model.source === 'setup') {
      await this.provideSetupResponse(model, progress, token);
      return;
    }

    await this.provideBackendResponse(model, messages, options, progress, token);
  }

  async provideTokenCount(
    _model: BridgeChatModel,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    const flattenedText = typeof text === 'string' ? text : extractTextFromMessage(text);
    return estimateTokenCount(flattenedText);
  }

  private async provideProbeResponse(
    model: BridgeChatModel,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const storedSettings = await this.settingsStore.getSettings();
    const probeSettings = storedSettings.probe;
    const backendSettings = storedSettings.backend;
    const requestSummary = summarizeMessages(messages);
    const hiddenStateObservation = inspectHiddenState(messages, probeSettings.hiddenStateMimeType);
    const lastUserText = truncateText(extractLastUserText(messages), 160);

    this.outputChannel.info(
      `Probe request received for ${model.id}. messages=${requestSummary.messageCount}, user=${requestSummary.userMessages}, assistant=${requestSummary.assistantMessages}`,
    );

    if (probeSettings.debugLogging) {
      this.outputChannel.debug(
        `Probe request summary: ${JSON.stringify(
          {
            requestSummary,
            hiddenStateObservation,
            toolsRequested: options.tools?.length ?? 0,
            toolMode: options.toolMode,
          },
          null,
          2,
        )}`,
      );
    }

    if (token.isCancellationRequested) {
      return;
    }

    const nextHiddenState = createNextHiddenState(hiddenStateObservation.latestState, lastUserText);
    const responseLines = [
      'GHCC Custom Provider probe response.',
      `Model: ${model.name}`,
      `Last user text: ${lastUserText || '<empty>'}`,
      hiddenStateObservation.latestState
        ? `Previous hidden state: found (${hiddenStateObservation.latestState.probeId}, turn ${hiddenStateObservation.latestState.turnNumber})`
        : 'Previous hidden state: not found',
      `Inbound data parts: ${hiddenStateObservation.totalDataParts}`,
      `Matching probe data parts: ${hiddenStateObservation.matchingStateCount}`,
      hiddenStateObservation.decodeErrors.length > 0
        ? `Decode errors: ${hiddenStateObservation.decodeErrors.length}`
        : 'Decode errors: 0',
      backendSettings.baseUrl
        ? `Reserved backend base URL: ${backendSettings.baseUrl}`
        : 'Reserved backend base URL: <not configured>',
      probeSettings.emitHiddenState
        ? `Emitting next hidden state: ${nextHiddenState.probeId}`
        : 'Hidden-state emission is disabled by configuration.',
      'Open the GHCC Custom Provider output channel for full transcript diagnostics.',
    ];

    progress.report(new vscode.LanguageModelTextPart(responseLines.join('\n')));

    if (probeSettings.emitHiddenState) {
      progress.report(encodeHiddenState(nextHiddenState, probeSettings.hiddenStateMimeType));
      this.outputChannel.info(`Probe response emitted hidden state ${nextHiddenState.probeId}.`);
    } else {
      this.outputChannel.warn('Probe response skipped hidden-state emission because ghccCustomProvider.hiddenStateProbe.enabled is false.');
    }
  }

  private async provideSetupResponse(
    model: BridgeChatModel,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    if (token.isCancellationRequested) {
      return;
    }

    const settings = await this.settingsStore.getSettings();
    const hasEnabledEndpoint = getActiveEndpoints(settings).length > 0;
    const isErrorSetupEntry = model.setupReason !== undefined && model.setupReason !== 'available';
    const message = vscode.env.language.toLowerCase().startsWith('ja')
      ? hasEnabledEndpoint
        ? isErrorSetupEntry
          ? 'GHCC Custom Provider の設定画面を開きます。エンドポイント URL や API キーを確認したあと、もう一度言語モデル一覧を開いてください。'
          : 'GHCC Custom Provider の設定画面を開きます。設定を変更したあとは、もう一度言語モデル一覧を開いてください。'
        : 'GHCC Custom Provider の設定画面を開きます。現在有効な接続先がありません。1 つ以上の接続先を有効化したあと、もう一度言語モデル一覧を開いてください。'
      : hasEnabledEndpoint
        ? isErrorSetupEntry
          ? 'Opening the GHCC Custom Provider manager. After checking the endpoint URL and API key, reopen the language model picker.'
          : 'Opening the GHCC Custom Provider manager. After changing settings, reopen the language model picker.'
        : 'Opening the GHCC Custom Provider manager. No endpoint is currently enabled. Enable one or more endpoints, then reopen the language model picker.';

    progress.report(new vscode.LanguageModelTextPart(
      message,
    ));

    await vscode.commands.executeCommand(MANAGEMENT_COMMAND);
  }

  private async provideBackendResponse(
    model: BridgeChatModel,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }

    const settings = await this.settingsStore.getSettings();
    if (getActiveEndpoints(settings).length === 0) {
      throw new Error('No endpoint is currently enabled. Open GHCC Custom Provider: Manage Provider and enable one or more endpoints.');
    }

    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }

    const endpoint = resolveRuntimeEndpoint(settings, model);
    if (!endpoint) {
      throw new Error('The selected model is no longer available from an enabled endpoint. Reopen the model picker and select it again.');
    }

    await this.conversationStateCache.configure(settings.conversationState);
    const apiKey = await this.settingsStore.getApiKey(endpoint.id);
    const requestSummary = summarizeMessages(messages);
    const hiddenStateObservation = inspectHiddenState(messages, settings.probe.hiddenStateMimeType);
    const requestedModelId = model.id;
    const upstreamModelId = model.upstreamId || model.id;

    if (!endpoint.baseUrl) {
      throw new Error('Backend base URL is not configured. Save it in GHCC Custom Provider: Manage Provider.');
    }

    const providerMemoryLookup = this.conversationStateCache.lookup(
      messages,
      requestedModelId,
      endpoint.endpointType,
      settings.probe.hiddenStateMimeType,
    );

    const chatEndpointType = getChatEndpointType(endpoint.endpointType);
    const upstreamClient = createBackendEndpointClient(chatEndpointType, this.outputChannel);
    const backendPayload = buildBackendPayload(
      chatEndpointType,
      model,
      messages,
      options,
      settings.probe.hiddenStateMimeType,
      endpoint.toolExposure,
      endpoint.requestOverrides,
      this.outputChannel,
      providerMemoryLookup.state,
    );

    this.outputChannel.info(
      `Backend request for ${upstreamModelId} via ${endpoint.endpointType} (${endpoint.id}). chatTransport=${chatEndpointType}, messages=${requestSummary.messageCount}, mapped=${backendPayload.mappedMessageCount}, tools=${backendPayload.toolCount}, toolExposure=${endpoint.toolExposure}, modelTools=${formatToolCapability(model.capabilities.toolCalling)}, overrides=${backendPayload.requestOverrideKeys.join(', ') || 'none'}`,
    );

    if (settings.probe.debugLogging) {
      this.outputChannel.debug(
        `Backend request summary: ${JSON.stringify(
          {
            requestSummary,
            hiddenStateObservation: {
              totalDataParts: hiddenStateObservation.totalDataParts,
              matchingMimeTypeCount: hiddenStateObservation.matchingMimeTypeCount,
              probeStateCount: hiddenStateObservation.matchingStateCount,
              reasoningStateCount: hiddenStateObservation.reasoningStateCount,
              decodeErrors: hiddenStateObservation.decodeErrors.slice(0, 5),
              partDiagnostics: hiddenStateObservation.partDiagnostics.slice(0, 10),
            },
            providerMemoryLookup: {
              hit: Boolean(providerMemoryLookup.state),
              transcriptKey: providerMemoryLookup.transcriptKey?.slice(0, 12),
              reasoningLength: providerMemoryLookup.state?.reasoningContent.trim().length ?? 0,
              responseIdPresent: Boolean(providerMemoryLookup.state?.responseId?.trim()),
            },
            endpointType: endpoint.endpointType,
            endpointId: endpoint.id,
            chatEndpointType,
            mappedMessageCount: backendPayload.mappedMessageCount,
            toolCount: backendPayload.toolCount,
            requestOverrideKeys: backendPayload.requestOverrideKeys,
            replayedReasoningLength: backendPayload.replayedReasoningLength ?? 0,
            syntheticReasoningReplayLength: backendPayload.syntheticReasoningReplayLength ?? 0,
            usedFallbackAssistantAttachment: backendPayload.usedFallbackAssistantAttachment ?? false,
            usedSyntheticReasoningReplay: backendPayload.usedSyntheticReasoningReplay ?? false,
            usedProviderMemoryFallback: backendPayload.usedProviderMemoryFallback ?? false,
            payloadSummary: summarizeBackendPayload(backendPayload.payload),
          },
          null,
          2,
        )}`,
      );
    }

    const result = await upstreamClient.streamChatCompletion(
      {
        endpointType: chatEndpointType,
        baseUrl: endpoint.baseUrl,
        apiKey,
      },
      backendPayload.payload,
      token,
      (textDelta) => {
        progress.report(new vscode.LanguageModelTextPart(textDelta));
      },
    );

    const hiddenReasoningContent = limitPreservedReasoningContent(
      result.reasoningContent,
      endpoint.requestOverrides,
      this.outputChannel,
      `${upstreamModelId} @ ${endpoint.id}`,
    );
    if (!hasVisibleAssistantOutput(result.content, result.toolCalls)) {
      this.outputChannel.warn(
        `Backend response for ${upstreamModelId} (${endpoint.id}) completed without visible assistant output. finishReason=${result.finishReason ?? 'unknown'}, reasoningLength=${hiddenReasoningContent.trim().length}, toolCalls=${result.toolCalls.length}`,
      );
      throw new Error(buildEmptyAssistantOutputErrorMessage(chatEndpointType, result.finishReason, hiddenReasoningContent));
    }

    if (hiddenReasoningContent.trim() || result.responseId?.trim()) {
      const hiddenState = createReasoningHiddenState(requestedModelId, hiddenReasoningContent, {
        endpointType: endpoint.endpointType,
        responseId: result.responseId,
      });
      const providerMemoryKey = await this.conversationStateCache.remember(
        messages,
        hiddenState,
        result.content,
        result.toolCalls,
        settings.probe.hiddenStateMimeType,
      );
      progress.report(encodeReasoningHiddenState(hiddenState, settings.probe.hiddenStateMimeType));
      this.outputChannel.info(
        `Emitted backend hidden state for ${requestedModelId}.${result.responseId ? ' responseIdPresent=true' : ''}${providerMemoryKey ? ` cacheKey=${providerMemoryKey.slice(0, 12)}` : ''}`,
      );
    }

    if (chatEndpointType === 'lm-studio-rest' && !result.responseId) {
      this.outputChannel.warn('LM Studio native chat response did not include a response_id. Multi-turn stateful continuation may not work on the next turn.');
    }

    const toolCallParts = mapUpstreamToolCallsToResponseParts(result.toolCalls);
    for (const toolCallPart of toolCallParts) {
      progress.report(toolCallPart);
    }

    this.outputChannel.info(
      `Backend response completed for ${upstreamModelId} (${endpoint.id}). finishReason=${result.finishReason ?? 'unknown'}, textLength=${result.content.length}, toolCalls=${result.toolCalls.length}`,
    );
  }
}

function resolveRuntimeEndpoint(settings: BridgeStoredSettings, model: BridgeChatModel): BackendEndpointSettings | undefined {
  if (model.endpointId) {
    const endpoint = getEndpointById(settings, model.endpointId);
    if (endpoint && isEndpointActive(settings, endpoint.id)) {
      return endpoint;
    }
  }

  return getPrimaryActiveEndpoint(settings);
}

interface BackendPayloadBuildResult {
  payload: Record<string, unknown>;
  mappedMessageCount: number;
  toolCount: number;
  requestOverrideKeys: string[];
  replayedReasoningLength?: number;
  syntheticReasoningReplayLength?: number;
  usedFallbackAssistantAttachment?: boolean;
  usedSyntheticReasoningReplay?: boolean;
  usedProviderMemoryFallback?: boolean;
}

const LM_STUDIO_UNSUPPORTED_CUSTOM_BODY_KEYS = new Set([
  'chat_template_kwargs',
  'reasoning_effort',
  'enable_thinking',
  'preserve_thinking',
]);

const OPENAI_COMPATIBLE_RESERVED_CUSTOM_BODY_KEYS = new Set([
  'model',
  'messages',
  'stream',
  'tools',
  'tool_choice',
]);

const LM_STUDIO_RESERVED_CUSTOM_BODY_KEYS = new Set([
  ...OPENAI_COMPATIBLE_RESERVED_CUSTOM_BODY_KEYS,
  ...LM_STUDIO_UNSUPPORTED_CUSTOM_BODY_KEYS,
  'input',
  'previous_response_id',
  'store',
]);

const UNSAFE_CUSTOM_BODY_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function buildBackendPayload(
  endpointType: BackendEndpointType,
  model: BridgeChatModel,
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  hiddenStateMimeType: string,
  toolExposure: SettingToggleMode,
  requestOverrides: BackendRequestOverrides,
  outputChannel: vscode.LogOutputChannel,
  providerMemoryState?: ReasoningHiddenState,
): BackendPayloadBuildResult {
  if (endpointType === 'lm-studio-rest') {
    if (options.tools?.length) {
      outputChannel.warn('LM Studio native /api/v1/chat does not accept VS Code custom tool definitions. The bridge will keep suppressing outgoing tool definitions for this endpoint type.');
    }

    const mapped = mapRequestMessagesToLmStudio(messages, hiddenStateMimeType);
    const requestedModelId = model.id;
    const upstreamModelId = model.upstreamId || model.id;
    const effectiveState = mapped.latestBackendState ?? providerMemoryState;
    const canReusePreviousResponse = Boolean(
      effectiveState?.responseId &&
      effectiveState.modelId === requestedModelId &&
      (!effectiveState.endpointType || effectiveState.endpointType === 'lm-studio-rest'),
    );

    if (effectiveState?.responseId && !canReusePreviousResponse) {
      outputChannel.info(
        `Ignoring stored LM Studio response_id because it belongs to ${effectiveState.modelId} instead of ${requestedModelId}.`,
      );
    }

    const payload = applyLmStudioRequestOverrides(
      {
        model: upstreamModelId,
        input: mapped.input,
        stream: true,
        store: true,
        previous_response_id: canReusePreviousResponse ? effectiveState?.responseId : undefined,
      },
      requestOverrides,
      outputChannel,
    );
    const syntheticReasoningReplay = attachSyntheticReasoningReplayPromptToLmStudioPayload(
      payload,
      effectiveState?.reasoningContent,
      requestOverrides,
      outputChannel,
    );
    const requestOverrideKeys = getConfiguredRequestOverrideKeys(endpointType, requestOverrides);
    if (syntheticReasoningReplay.usedSyntheticReasoningReplay && !requestOverrideKeys.includes('system_prompt')) {
      requestOverrideKeys.push('system_prompt');
    }

    return {
      payload,
      mappedMessageCount: 1,
      toolCount: 0,
      requestOverrideKeys,
      replayedReasoningLength: syntheticReasoningReplay.replayedReasoningLength,
      syntheticReasoningReplayLength: syntheticReasoningReplay.syntheticReasoningReplayLength,
      usedFallbackAssistantAttachment: false,
      usedSyntheticReasoningReplay: syntheticReasoningReplay.usedSyntheticReasoningReplay,
      usedProviderMemoryFallback: !mapped.latestBackendState && Boolean(providerMemoryState),
    };
  }

  const openAIMessages = mapRequestMessagesToOpenAI(messages, hiddenStateMimeType);
  limitOpenAIMessageReasoningContents(openAIMessages.messages, requestOverrides, outputChannel, `${model.id} request transcript`);
  openAIMessages.replayedReasoningLength = findLastAssistantReasoningLength(openAIMessages.messages);
  let usedProviderMemoryFallback = false;
  if (!openAIMessages.latestBackendState?.reasoningContent.trim() && providerMemoryState?.reasoningContent.trim()) {
    const providerMemoryReasoning = limitPreservedReasoningContent(
      providerMemoryState.reasoningContent,
      requestOverrides,
      outputChannel,
      `${model.id} provider memory`,
    );
    const replayResult = attachReasoningStateToOpenAIMessages(openAIMessages.messages, providerMemoryReasoning);
    openAIMessages.replayedReasoningLength = replayResult.replayedReasoningLength;
    openAIMessages.usedFallbackAssistantAttachment ||= replayResult.usedFallbackAssistantAttachment;
    usedProviderMemoryFallback = replayResult.replayedReasoningLength > 0;
  }

  const syntheticReasoningReplay = attachSyntheticReasoningReplayMessage(openAIMessages.messages, requestOverrides);

  const shouldForwardTools = toolExposure !== 'off' && supportsToolCalling(model);
  if (!shouldForwardTools && options.tools?.length) {
    const reason = toolExposure === 'off'
      ? 'backend tool forwarding is disabled for this profile'
      : 'the selected model does not advertise tool support';
    outputChannel.info(
      `Suppressing ${options.tools.length} VS Code tool definition(s) for ${model.id} because ${reason}.`,
    );
  }

  let effectiveTools = shouldForwardTools ? options.tools : undefined;
  const advertisedToolLimit = getAdvertisedToolLimit(model);
  if (effectiveTools?.length && advertisedToolLimit !== undefined && effectiveTools.length > advertisedToolLimit) {
    outputChannel.info(
      `Limiting ${effectiveTools.length} VS Code tool definition(s) to ${advertisedToolLimit} for ${model.id} because the model advertises a maximum tool count of ${advertisedToolLimit}.`,
    );
    effectiveTools = effectiveTools.slice(0, advertisedToolLimit);
  }

  const tools = mapTools(effectiveTools);
  const toolChoice = mapToolMode(options.toolMode, effectiveTools);
  const payload = applyOpenAICompatibleRequestOverrides(
    {
      model: model.upstreamId || model.id,
      messages: openAIMessages.messages,
      stream: true,
      tools,
      tool_choice: toolChoice,
    },
    requestOverrides,
    outputChannel,
  );

  return {
    payload,
    mappedMessageCount: openAIMessages.messages.length,
    toolCount: tools?.length ?? 0,
    requestOverrideKeys: getConfiguredRequestOverrideKeys(endpointType, requestOverrides),
    replayedReasoningLength: openAIMessages.replayedReasoningLength,
    syntheticReasoningReplayLength: syntheticReasoningReplay.syntheticReasoningReplayLength,
    usedFallbackAssistantAttachment: openAIMessages.usedFallbackAssistantAttachment,
    usedSyntheticReasoningReplay: syntheticReasoningReplay.usedSyntheticReasoningReplay,
    usedProviderMemoryFallback,
  };
}

function supportsToolCalling(model: BridgeChatModel): boolean {
  return Boolean(model.capabilities.toolCalling);
}

function getAdvertisedToolLimit(model: BridgeChatModel): number | undefined {
  return typeof model.capabilities.toolCalling === 'number' && model.capabilities.toolCalling > 0
    ? model.capabilities.toolCalling
    : undefined;
}

function formatToolCapability(toolCalling: vscode.LanguageModelChatCapabilities['toolCalling']): string {
  if (typeof toolCalling === 'number') {
    return String(toolCalling);
  }

  return toolCalling ? 'true' : 'false';
}

function applyOpenAICompatibleRequestOverrides(
  payload: OpenAIChatCompletionRequest,
  requestOverrides: BackendRequestOverrides,
  outputChannel?: vscode.LogOutputChannel,
): Record<string, unknown> {
  const nextPayload: Record<string, unknown> = {
    ...payload,
  };

  if (requestOverrides.reasoningEffort) {
    nextPayload.reasoning_effort = requestOverrides.reasoningEffort;
  }

  const enableThinking = toOptionalBoolean(requestOverrides.enableThinking);
  if (enableThinking !== undefined) {
    nextPayload.enable_thinking = enableThinking;
  }

  const preserveThinking = toOptionalBoolean(requestOverrides.preserveThinking);
  if (preserveThinking !== undefined) {
    nextPayload.preserve_thinking = preserveThinking;
  }

  if (requestOverrides.contextLength !== undefined) {
    nextPayload.context_length = requestOverrides.contextLength;
  }

  if (requestOverrides.maxTokens !== undefined) {
    nextPayload.max_tokens = requestOverrides.maxTokens;
  }

  if (requestOverrides.temperature !== undefined) {
    nextPayload.temperature = requestOverrides.temperature;
  }

  if (requestOverrides.topP !== undefined) {
    nextPayload.top_p = requestOverrides.topP;
  }

  if (requestOverrides.topK !== undefined) {
    nextPayload.top_k = requestOverrides.topK;
  }

  if (requestOverrides.minP !== undefined) {
    nextPayload.min_p = requestOverrides.minP;
  }

  if (requestOverrides.presencePenalty !== undefined) {
    nextPayload.presence_penalty = requestOverrides.presencePenalty;
  }

  if (requestOverrides.repeatPenalty !== undefined) {
    nextPayload.repeat_penalty = requestOverrides.repeatPenalty;
  }

  const filteredCustomBody = filterCustomBodyForEndpoint(requestOverrides.customBody, OPENAI_COMPATIBLE_RESERVED_CUSTOM_BODY_KEYS);
  logStrippedCustomBodyKeys('OpenAI-compatible', requestOverrides.customBody, filteredCustomBody, outputChannel);
  return deepMergeObjects(nextPayload, filteredCustomBody);
}

function applyLmStudioRequestOverrides(
  payload: LMStudioChatRequest,
  requestOverrides: BackendRequestOverrides,
  outputChannel?: vscode.LogOutputChannel,
): Record<string, unknown> {
  const nextPayload: Record<string, unknown> = {
    ...payload,
  };

  if (requestOverrides.lmStudioReasoning !== 'auto') {
    nextPayload.reasoning = requestOverrides.lmStudioReasoning;
  }

  if (requestOverrides.contextLength !== undefined) {
    nextPayload.context_length = requestOverrides.contextLength;
  }

  if (requestOverrides.maxTokens !== undefined) {
    nextPayload.max_output_tokens = requestOverrides.maxTokens;
  }

  if (requestOverrides.temperature !== undefined) {
    nextPayload.temperature = requestOverrides.temperature;
  }

  if (requestOverrides.topP !== undefined) {
    nextPayload.top_p = requestOverrides.topP;
  }

  if (requestOverrides.topK !== undefined) {
    nextPayload.top_k = requestOverrides.topK;
  }

  if (requestOverrides.minP !== undefined) {
    nextPayload.min_p = requestOverrides.minP;
  }

  if (requestOverrides.repeatPenalty !== undefined) {
    nextPayload.repeat_penalty = requestOverrides.repeatPenalty;
  }

  const filteredCustomBody = filterCustomBodyForEndpoint(requestOverrides.customBody, LM_STUDIO_RESERVED_CUSTOM_BODY_KEYS);
  logStrippedCustomBodyKeys('LM Studio', requestOverrides.customBody, filteredCustomBody, outputChannel);

  return deepMergeObjects(nextPayload, filteredCustomBody);
}

function attachSyntheticReasoningReplayPromptToLmStudioPayload(
  payload: Record<string, unknown>,
  reasoningContent: string | undefined,
  requestOverrides: BackendRequestOverrides,
  outputChannel: vscode.LogOutputChannel,
): { replayedReasoningLength: number; syntheticReasoningReplayLength: number; usedSyntheticReasoningReplay: boolean } {
  if (requestOverrides.preserveThinking !== 'on') {
    return {
      replayedReasoningLength: 0,
      syntheticReasoningReplayLength: 0,
      usedSyntheticReasoningReplay: false,
    };
  }

  const normalizedReasoning = limitPreservedReasoningContent(
    reasoningContent ?? '',
    requestOverrides,
    outputChannel,
    'LM Studio synthetic reasoning replay',
  ).trim();
  if (!normalizedReasoning) {
    return {
      replayedReasoningLength: 0,
      syntheticReasoningReplayLength: 0,
      usedSyntheticReasoningReplay: false,
    };
  }

  const replayContent = buildSyntheticReasoningReplayContent(normalizedReasoning, getSyntheticReasoningReplayMaxChars(requestOverrides));
  if (!replayContent.trim()) {
    return {
      replayedReasoningLength: normalizedReasoning.length,
      syntheticReasoningReplayLength: 0,
      usedSyntheticReasoningReplay: false,
    };
  }

  const existingSystemPrompt = typeof payload.system_prompt === 'string' ? payload.system_prompt.trim() : '';
  payload.system_prompt = existingSystemPrompt ? `${existingSystemPrompt}\n\n${replayContent}` : replayContent;

  return {
    replayedReasoningLength: normalizedReasoning.length,
    syntheticReasoningReplayLength: replayContent.length,
    usedSyntheticReasoningReplay: true,
  };
}

function attachReasoningStateToOpenAIMessages(
  messages: OpenAIWireMessage[],
  reasoningContent: string,
): { replayedReasoningLength: number; usedFallbackAssistantAttachment: boolean } {
  const normalizedReasoning = reasoningContent.trim();
  if (!normalizedReasoning) {
    return {
      replayedReasoningLength: 0,
      usedFallbackAssistantAttachment: false,
    };
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') {
      continue;
    }

    if (!message.reasoning_content?.trim()) {
      message.reasoning_content = normalizedReasoning;
    }

    return {
      replayedReasoningLength: normalizedReasoning.length,
      usedFallbackAssistantAttachment: true,
    };
  }

  messages.push({
    role: 'assistant',
    content: null,
    reasoning_content: normalizedReasoning,
  });

  return {
    replayedReasoningLength: normalizedReasoning.length,
    usedFallbackAssistantAttachment: true,
  };
}

function attachSyntheticReasoningReplayMessage(
  messages: OpenAIWireMessage[],
  requestOverrides: BackendRequestOverrides,
): { syntheticReasoningReplayLength: number; usedSyntheticReasoningReplay: boolean } {
  if (requestOverrides.preserveThinking !== 'on') {
    return {
      syntheticReasoningReplayLength: 0,
      usedSyntheticReasoningReplay: false,
    };
  }

  const normalizedReasoning = findLatestAssistantReasoningContent(messages);
  if (!normalizedReasoning) {
    return {
      syntheticReasoningReplayLength: 0,
      usedSyntheticReasoningReplay: false,
    };
  }

  const replayContent = buildSyntheticReasoningReplayContent(normalizedReasoning, getSyntheticReasoningReplayMaxChars(requestOverrides));
  if (!replayContent.trim()) {
    return {
      syntheticReasoningReplayLength: 0,
      usedSyntheticReasoningReplay: false,
    };
  }

  prependSystemReplayMessage(messages, replayContent);

  return {
    syntheticReasoningReplayLength: replayContent.length,
    usedSyntheticReasoningReplay: true,
  };
}

function prependSystemReplayMessage(messages: OpenAIWireMessage[], replayContent: string): void {
  const normalizedReplayContent = replayContent.trim();
  if (!normalizedReplayContent) {
    return;
  }

  const leadingSystemMessages: Array<{ role: 'system'; content: string }> = [];
  const remainingMessages: OpenAIWireMessage[] = [];
  let stillCollectingLeadingSystemMessages = true;

  for (const message of messages) {
    if (stillCollectingLeadingSystemMessages && message.role === 'system') {
      leadingSystemMessages.push(message);
      continue;
    }

    stillCollectingLeadingSystemMessages = false;
    remainingMessages.push(message);
  }

  if (leadingSystemMessages.length > 0) {
    const primarySystemMessage = leadingSystemMessages[0];
    const existingContent = primarySystemMessage.content.trim();
    primarySystemMessage.content = existingContent
      ? `${existingContent}\n\n${normalizedReplayContent}`
      : normalizedReplayContent;
    messages.splice(0, messages.length, ...leadingSystemMessages, ...remainingMessages);
    return;
  }

  messages.unshift({
    role: 'system',
    content: normalizedReplayContent,
  });
}

function findLatestAssistantReasoningContent(messages: readonly OpenAIWireMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!hasAssistantReasoningContent(message)) {
      continue;
    }

    return message.reasoning_content.trim();
  }

  return '';
}

function buildSyntheticReasoningReplayContent(reasoningContent: string, charLimit: number): string {
  const trimmedReasoning = reasoningContent.trim();
  if (charLimit <= 0) {
    return '';
  }

  if (trimmedReasoning.length <= charLimit) {
    return `${SYNTHETIC_REASONING_REPLAY_PREFIX}\n${trimmedReasoning}`;
  }

  const truncationMarker = '\n[... truncated reasoning replay ...]\n';
  const remainingLength = Math.max(0, charLimit - truncationMarker.length);
  const headLength = Math.floor(remainingLength / 2);
  const tailLength = remainingLength - headLength;
  const tail = tailLength > 0 ? trimmedReasoning.slice(-tailLength) : '';
  return `${SYNTHETIC_REASONING_REPLAY_PREFIX}\n${trimmedReasoning.slice(0, headLength)}${truncationMarker}${tail}`;
}

function getConfiguredRequestOverrideKeys(
  endpointType: BackendEndpointType,
  requestOverrides: BackendRequestOverrides,
): string[] {
  const keys: string[] = [];

  if (endpointType === 'openai-compatible' && requestOverrides.reasoningEffort) {
    keys.push('reasoning_effort');
  }

  if (endpointType === 'lm-studio-rest' && requestOverrides.lmStudioReasoning !== 'auto') {
    keys.push('reasoning');
  }

  if (endpointType === 'openai-compatible' && requestOverrides.enableThinking !== 'auto') {
    keys.push('enable_thinking');
  }

  if (endpointType === 'openai-compatible' && requestOverrides.preserveThinking !== 'auto') {
    keys.push('preserve_thinking');
  }

  if (requestOverrides.preservedThinkingMaxChars !== undefined) {
    keys.push('preserved_thinking_max_chars');
  }

  if (requestOverrides.syntheticReasoningReplayMaxChars !== undefined) {
    keys.push('synthetic_reasoning_replay_max_chars');
  }

  if (requestOverrides.contextLength !== undefined) {
    keys.push('context_length');
  }

  if (requestOverrides.maxTokens !== undefined) {
    keys.push(endpointType === 'lm-studio-rest' ? 'max_output_tokens' : 'max_tokens');
  }

  if (requestOverrides.temperature !== undefined) {
    keys.push('temperature');
  }

  if (requestOverrides.topP !== undefined) {
    keys.push('top_p');
  }

  if (requestOverrides.topK !== undefined) {
    keys.push('top_k');
  }

  if (requestOverrides.minP !== undefined) {
    keys.push('min_p');
  }

  if (endpointType === 'openai-compatible' && requestOverrides.presencePenalty !== undefined) {
    keys.push('presence_penalty');
  }

  if (requestOverrides.repeatPenalty !== undefined) {
    keys.push('repeat_penalty');
  }

  const customBodyKeys = endpointType === 'lm-studio-rest'
    ? Object.keys(filterCustomBodyForEndpoint(requestOverrides.customBody, LM_STUDIO_RESERVED_CUSTOM_BODY_KEYS))
    : Object.keys(filterCustomBodyForEndpoint(requestOverrides.customBody, OPENAI_COMPATIBLE_RESERVED_CUSTOM_BODY_KEYS));

  for (const key of customBodyKeys) {
    if (!keys.includes(key)) {
      keys.push(key);
    }
  }

  return keys;
}

function filterCustomBodyForEndpoint(customBody: Record<string, unknown>, reservedKeys: ReadonlySet<string>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(customBody)) {
    if (isReservedOrUnsafeCustomBodyKey(key, reservedKeys)) {
      continue;
    }

    filtered[key] = value;
  }

  return filtered;
}

function logStrippedCustomBodyKeys(
  endpointLabel: string,
  customBody: Record<string, unknown>,
  filteredCustomBody: Record<string, unknown>,
  outputChannel: vscode.LogOutputChannel | undefined,
): void {
  if (!outputChannel) {
    return;
  }

  const strippedKeys = getStrippedCustomBodyKeys(customBody, filteredCustomBody);
  if (strippedKeys.length > 0) {
    outputChannel.info(`Ignoring reserved ${endpointLabel} custom body key(s): ${strippedKeys.join(', ')}.`);
  }
}

function getStrippedCustomBodyKeys(customBody: Record<string, unknown>, filteredCustomBody: Record<string, unknown>): string[] {
  return Object.keys(customBody)
    .filter((key) => !(key in filteredCustomBody))
    .sort((left, right) => left.localeCompare(right));
}

function isReservedOrUnsafeCustomBodyKey(key: string, reservedKeys: ReadonlySet<string>): boolean {
  return reservedKeys.has(key) || UNSAFE_CUSTOM_BODY_KEYS.has(key);
}

function toOptionalBoolean(mode: BackendRequestOverrides['enableThinking']): boolean | undefined {
  if (mode === 'on') {
    return true;
  }

  if (mode === 'off') {
    return false;
  }

  return undefined;
}

function deepMergeObjects(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {
    ...base,
  };

  for (const [key, value] of Object.entries(override)) {
    if (UNSAFE_CUSTOM_BODY_KEYS.has(key)) {
      continue;
    }

    const current = result[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      result[key] = deepMergeObjects(current, value);
      continue;
    }

    result[key] = value;
  }

  return result;
}

function limitOpenAIMessageReasoningContents(
  messages: OpenAIWireMessage[],
  requestOverrides: BackendRequestOverrides,
  outputChannel: vscode.LogOutputChannel,
  label: string,
): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant' || typeof message.reasoning_content !== 'string') {
      continue;
    }

    const limited = limitPreservedReasoningContent(message.reasoning_content, requestOverrides, outputChannel, label);
    if (limited.trim()) {
      message.reasoning_content = limited;
    } else {
      delete message.reasoning_content;
      if (!hasOpenAIAssistantMessagePayload(message)) {
        messages.splice(index, 1);
      }
    }
  }
}

function hasOpenAIAssistantMessagePayload(message: { content: string | null; tool_calls?: readonly unknown[]; reasoning_content?: string }): boolean {
  return Boolean(message.content?.trim() || message.tool_calls?.length || message.reasoning_content?.trim());
}

function limitPreservedReasoningContent(
  value: string,
  requestOverrides: BackendRequestOverrides,
  outputChannel: vscode.LogOutputChannel,
  label: string,
): string {
  const maxChars = getPreservedThinkingMaxChars(requestOverrides);
  if (value.length <= maxChars) {
    return value;
  }

  outputChannel.warn(
    `Truncated preserved thinking for ${label} from ${value.length} to ${maxChars} characters.`,
  );
  return maxChars > 0 ? value.slice(-maxChars) : '';
}

function getPreservedThinkingMaxChars(requestOverrides: BackendRequestOverrides): number {
  if (requestOverrides.preservedThinkingMaxChars === -1) {
    return Number.POSITIVE_INFINITY;
  }

  return requestOverrides.preservedThinkingMaxChars ?? MAX_HIDDEN_REASONING_CONTENT_CHARS;
}

function getSyntheticReasoningReplayMaxChars(requestOverrides: BackendRequestOverrides): number {
  if (requestOverrides.syntheticReasoningReplayMaxChars === -1) {
    return Number.POSITIVE_INFINITY;
  }

  return requestOverrides.syntheticReasoningReplayMaxChars ?? SYNTHETIC_REASONING_REPLAY_CHAR_LIMIT;
}

function hasVisibleAssistantOutput(content: string, toolCalls: readonly unknown[]): boolean {
  return content.trim().length > 0 || toolCalls.length > 0;
}

function buildEmptyAssistantOutputErrorMessage(
  endpointType: BackendEndpointType,
  finishReason: string | undefined,
  reasoningContent: string,
): string {
  const normalizedFinishReason = finishReason?.trim() || 'unknown';
  const reasoningOnly = reasoningContent.trim().length > 0;
  const endpointLabel = endpointType === 'lm-studio-rest' ? 'LM Studio Native' : 'OpenAI-compatible';
  const detail = reasoningOnly
    ? 'The backend returned hidden reasoning_content but no visible assistant text after the last tool or chat turn.'
    : 'The backend ended the turn without visible assistant text or tool calls.';
  return `${endpointLabel} backend returned an empty assistant response (finish_reason=${normalizedFinishReason}). ${detail} Copilot Chat requires visible text or tool calls for each completed assistant turn. Try turning Preserve thinking off for this endpoint, reducing tool use, or switching LM Studio endpoints if this model only completes reliably on one path.`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function summarizeBackendPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    keys: Object.keys(payload).sort(),
  };

  if (Array.isArray(payload.messages)) {
    summary.messageCount = payload.messages.length;
    summary.assistantMessages = payload.messages.filter(isAssistantPayloadMessage).length;
    summary.assistantMessagesWithReasoning = payload.messages.filter(hasAssistantReasoningContent).length;
    summary.systemMessages = payload.messages.filter(isSystemPayloadMessage).length;
    summary.lastAssistantReasoningLength = findLastAssistantReasoningLength(payload.messages);
  }

  if (typeof payload.previous_response_id === 'string' && payload.previous_response_id.trim()) {
    summary.previousResponseIdPresent = true;
  }

  if (typeof payload.system_prompt === 'string' && payload.system_prompt.trim()) {
    summary.systemPromptLength = payload.system_prompt.length;
  }

  if (isPlainObject(payload.chat_template_kwargs)) {
    summary.chatTemplateKwargsKeys = Object.keys(payload.chat_template_kwargs).sort();
  }

  return summary;
}

function isAssistantPayloadMessage(message: unknown): message is { role: 'assistant'; reasoning_content?: unknown } {
  return Boolean(message && typeof message === 'object' && (message as { role?: unknown }).role === 'assistant');
}

function isSystemPayloadMessage(message: unknown): message is { role: 'system'; content?: unknown } {
  return Boolean(message && typeof message === 'object' && (message as { role?: unknown }).role === 'system');
}

function hasAssistantReasoningContent(message: unknown): message is { role: 'assistant'; reasoning_content: string } {
  return isAssistantPayloadMessage(message) && typeof message.reasoning_content === 'string' && message.reasoning_content.trim().length > 0;
}

function findLastAssistantReasoningLength(messages: readonly unknown[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!hasAssistantReasoningContent(message)) {
      continue;
    }

    return (message as { reasoning_content: string }).reasoning_content.trim().length;
  }

  return 0;
}

function summarizeMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): RequestSummary {
  const summary: RequestSummary = {
    messageCount: messages.length,
    userMessages: 0,
    assistantMessages: 0,
    textParts: 0,
    dataParts: 0,
    toolCallParts: 0,
    toolResultParts: 0,
    unknownParts: 0,
  };

  for (const message of messages) {
    if (message.role === vscode.LanguageModelChatMessageRole.User) {
      summary.userMessages += 1;
    }

    if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
      summary.assistantMessages += 1;
    }

    for (const part of message.content) {
      if (isTextPart(part)) {
        summary.textParts += 1;
      } else if (isDataPart(part)) {
        summary.dataParts += 1;
      } else if (isToolCallPart(part)) {
        summary.toolCallParts += 1;
      } else if (isToolResultPart(part)) {
        summary.toolResultParts += 1;
      } else {
        summary.unknownParts += 1;
      }
    }
  }

  return summary;
}

function extractLastUserText(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== vscode.LanguageModelChatMessageRole.User) {
      continue;
    }

    return extractTextFromMessage(message);
  }

  return '';
}

function extractTextFromMessage(message: vscode.LanguageModelChatRequestMessage): string {
  const parts: string[] = [];

  for (const part of message.content) {
    if (isTextPart(part)) {
      parts.push(part.value);
    }
  }

  return parts.join('\n').trim();
}

function estimateTokenCount(text: string): number {
  if (!text) {
    return 0;
  }

  return Math.max(1, Math.ceil(text.length / 4));
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3)}...`;
}

function isTextPart(part: unknown): part is { value: string } {
  return Boolean(part && typeof part === 'object' && typeof (part as { value?: unknown }).value === 'string');
}

function isDataPart(part: unknown): part is { data: unknown; mimeType: string } {
  return Boolean(part && typeof part === 'object' && typeof (part as { mimeType?: unknown }).mimeType === 'string');
}

function isToolCallPart(part: unknown): part is { callId: string; name: string; input: object } {
  if (!part || typeof part !== 'object') {
    return false;
  }

  const candidate = part as { callId?: unknown; name?: unknown; input?: unknown };
  return (
    typeof candidate.callId === 'string' &&
    typeof candidate.name === 'string' &&
    Boolean(candidate.input && typeof candidate.input === 'object')
  );
}

function isToolResultPart(part: unknown): part is { callId: string; content: readonly unknown[] } {
  if (!part || typeof part !== 'object') {
    return false;
  }

  const candidate = part as { callId?: unknown; content?: unknown };
  return typeof candidate.callId === 'string' && Array.isArray(candidate.content);
}
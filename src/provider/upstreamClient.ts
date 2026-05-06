import * as vscode from 'vscode';

import { BackendEndpointType, LmStudioReasoningMode } from '../config/settings';

export interface UpstreamConnectionSettings {
  endpointType: BackendEndpointType;
  baseUrl: string;
  apiKey?: string;
}

export interface UpstreamModelInfo {
  endpointType: BackendEndpointType;
  id: string;
  kind?: string;
  displayName?: string;
  object?: string;
  ownedBy?: string;
  contextLength?: number;
  maxModelLen?: number;
  inputModalities?: string[];
  outputModalities?: string[];
  supportedFeatures?: string[];
  endpointCapabilities?: {
    imageInput?: boolean;
    toolCalling?: boolean;
  };
}

export interface OpenAITextContentPart {
  type: 'text';
  text: string;
}

export interface OpenAIImageContentPart {
  type: 'image_url';
  image_url: {
    url: string;
  };
}

export type OpenAIInputContentPart = OpenAITextContentPart | OpenAIImageContentPart;

export interface OpenAIWireToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: object;
  };
}

export interface OpenAIWireToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: object;
  };
}

export interface OpenAIWireAssistantMessage {
  role: 'assistant';
  content: string | null;
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

export interface OpenAIWireUserMessage {
  role: 'user';
  content: string | OpenAIInputContentPart[];
}

export interface OpenAIWireSystemMessage {
  role: 'system';
  content: string;
}

export interface OpenAIWireToolMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

export type OpenAIWireMessage = OpenAIWireAssistantMessage | OpenAIWireUserMessage | OpenAIWireSystemMessage | OpenAIWireToolMessage;

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIWireMessage[];
  stream: boolean;
  tools?: OpenAIWireToolDefinition[];
  tool_choice?: 'auto' | 'required';
  [key: string]: unknown;
}

export interface LMStudioChatMessageInput {
  type: 'text';
  content: string;
}

export interface LMStudioChatImageInput {
  type: 'image';
  data_url: string;
}

export type LMStudioChatInputPart = LMStudioChatMessageInput | LMStudioChatImageInput;

export interface LMStudioChatRequest {
  model: string;
  input: string | LMStudioChatInputPart[];
  stream: boolean;
  previous_response_id?: string;
  system_prompt?: string;
  reasoning?: Exclude<LmStudioReasoningMode, 'auto'>;
  context_length?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  repeat_penalty?: number;
  max_output_tokens?: number;
  store?: boolean;
  [key: string]: unknown;
}

export interface UpstreamChatCompletionResult {
  endpointType: BackendEndpointType;
  id?: string;
  responseId?: string;
  model: string;
  created?: number;
  content: string;
  reasoningContent: string;
  toolCalls: OpenAIWireToolCall[];
  finishReason?: string;
}

interface OpenAIChunkToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAIAccumulatedToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface BackendEndpointClient {
  readonly endpointType: BackendEndpointType;
  listModels(
    connection: UpstreamConnectionSettings,
    token: vscode.CancellationToken,
  ): Promise<UpstreamModelInfo[]>;
  streamChatCompletion(
    connection: UpstreamConnectionSettings,
    payload: Record<string, unknown>,
    token: vscode.CancellationToken,
    onTextDelta?: (value: string) => void,
  ): Promise<UpstreamChatCompletionResult>;
}

interface OpenedUpstreamResponse {
  readonly response: Response;
  readonly disposeCancellation: () => void;
}

export function createBackendEndpointClient(
  endpointType: BackendEndpointType,
  outputChannel: vscode.LogOutputChannel,
): BackendEndpointClient {
  if (endpointType === 'lm-studio-rest') {
    return new LmStudioRestUpstreamClient(outputChannel);
  }

  return new OpenAICompatibleUpstreamClient(outputChannel);
}

abstract class BaseUpstreamClient implements BackendEndpointClient {
  abstract readonly endpointType: BackendEndpointType;

  constructor(protected readonly outputChannel: vscode.LogOutputChannel) {}

  abstract listModels(
    connection: UpstreamConnectionSettings,
    token: vscode.CancellationToken,
  ): Promise<UpstreamModelInfo[]>;

  abstract streamChatCompletion(
    connection: UpstreamConnectionSettings,
    payload: Record<string, unknown>,
    token: vscode.CancellationToken,
    onTextDelta?: (value: string) => void,
  ): Promise<UpstreamChatCompletionResult>;

  protected async fetchJson<T>(
    connection: UpstreamConnectionSettings,
    pathname: string,
    token: vscode.CancellationToken,
    init: RequestInit,
  ): Promise<T> {
    const opened = await this.openFetch(connection, pathname, token, init);
    try {
      return await opened.response.json() as T;
    } catch (error) {
      if (token.isCancellationRequested || isCancellationError(error)) {
        throw new vscode.CancellationError();
      }

      if (isLikelyTransportError(error)) {
        throw createUpstreamTransportError(error, 'response');
      }

      throw error;
    } finally {
      opened.disposeCancellation();
    }
  }

  protected async fetch(
    connection: UpstreamConnectionSettings,
    pathname: string,
    token: vscode.CancellationToken,
    init: RequestInit,
  ): Promise<Response> {
    const opened = await this.openFetch(connection, pathname, token, init);
    try {
      return opened.response;
    } finally {
      opened.disposeCancellation();
    }
  }

  protected async openFetch(
    connection: UpstreamConnectionSettings,
    pathname: string,
    token: vscode.CancellationToken,
    init: RequestInit,
  ): Promise<OpenedUpstreamResponse> {
    const abortController = new AbortController();
    const cancellationDisposable = token.onCancellationRequested(() => abortController.abort());
    let responseOpened = false;

    try {
      const headers = new Headers(init.headers);
      if (connection.apiKey?.trim()) {
        headers.set('Authorization', `Bearer ${connection.apiKey.trim()}`);
      }

      const normalizedBaseUrl = normalizeHttpBaseUrl(connection.baseUrl);
      const response = await fetch(`${normalizedBaseUrl}${pathname}`, {
        ...init,
        headers,
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        this.outputChannel.warn(
          `Upstream request to ${pathname} failed with ${response.status}. headers=${summarizeUpstreamResponseHeaders(response.headers)}`,
        );
        throw new Error(`Upstream request failed with ${response.status}: ${summarizeUpstreamErrorBody(errorBody) || response.statusText}`);
      }

      responseOpened = true;
      return {
        response,
        disposeCancellation: () => cancellationDisposable.dispose(),
      };
    } catch (error) {
      if (abortController.signal.aborted || token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      if (isLikelyTransportError(error)) {
        throw createUpstreamTransportError(error, 'request');
      }

      throw error;
    } finally {
      if (!responseOpened) {
        cancellationDisposable.dispose();
      }
    }
  }
}

function isCancellationError(error: unknown): boolean {
  return error instanceof vscode.CancellationError || (error instanceof Error && error.name === 'AbortError');
}

function isLikelyTransportError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && /fetch failed|terminated|socket|network|connection/i.test(error.message));
}

function createUpstreamTransportError(error: unknown, phase: 'request' | 'response' | 'stream'): Error {
  const detail = sanitizeUpstreamDiagnosticText(error instanceof Error ? error.message : String(error)) || 'unknown network error';
  if (phase === 'request') {
    return new Error(`Upstream request could not be sent: ${detail}. Check the endpoint URL, server availability, proxy/TLS settings, and network connectivity.`);
  }

  if (phase === 'response') {
    return new Error(`Upstream response body could not be read: ${detail}. The backend or network connection closed before the response completed.`);
  }

  return new Error(`Upstream response stream ended unexpectedly: ${detail}. The backend or network connection closed before the response completed.`);
}

function normalizeHttpBaseUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl.trim());
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Backend base URL must use http or https.');
  }

  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/+$/, '');
}

function summarizeUpstreamErrorBody(body: string): string {
  return sanitizeUpstreamDiagnosticText(body);
}

function summarizeUpstreamResponseHeaders(headers: Headers): string {
  const safeHeaderNames = [
    'content-type',
    'retry-after',
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
    'cf-ray',
    'server',
    'date',
  ];
  const summary: Record<string, string> = {};

  for (const name of safeHeaderNames) {
    const value = headers.get(name);
    if (value) {
      summary[name] = sanitizeUpstreamDiagnosticText(value);
    }
  }

  return Object.keys(summary).length > 0 ? JSON.stringify(summary) : '{}';
}

export function sanitizeUpstreamDiagnosticText(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  return redactSensitiveText(normalized).slice(0, 1000);
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/("(?:api[_-]?key|authorization|token|access[_-]?token|secret)"\s*:\s*")[^"]+(")/gi, '$1[redacted]$2')
    .replace(/\bsk-[A-Za-z0-9*._~+/=-]{8,}\b/g, '[redacted]')
    .replace(/(invalid [a-z ]*token provided:\s*)([^\s",}]+)/gi, '$1[redacted]');
}

class OpenAICompatibleUpstreamClient extends BaseUpstreamClient {
  readonly endpointType = 'openai-compatible' as const;

  async listModels(
    connection: UpstreamConnectionSettings,
    token: vscode.CancellationToken,
  ): Promise<UpstreamModelInfo[]> {
    const response = await this.fetchJson<{ data?: unknown[] }>(connection, '/v1/models', token, { method: 'GET' });
    const models = Array.isArray(response.data) ? response.data : [];

    return models
      .map((rawModel) => normalizeOpenAIModelInfo(rawModel))
      .filter((model): model is UpstreamModelInfo => Boolean(model));
  }

  async streamChatCompletion(
    connection: UpstreamConnectionSettings,
    payload: Record<string, unknown>,
    token: vscode.CancellationToken,
    onTextDelta?: (value: string) => void,
  ): Promise<UpstreamChatCompletionResult> {
    const opened = await this.openFetch(connection, '/v1/chat/completions', token, {
      method: 'POST',
      headers: {
        'Accept': 'text/event-stream',
        'Content-Type': 'application/json',
        'User-Agent': 'GHCC-Custom-Provider/0.1 VSCode-LanguageModelChatProvider',
      },
      body: JSON.stringify(payload as OpenAIChatCompletionRequest),
    });
    const response = opened.response;

    try {
      if (!response.body) {
        throw new Error('The upstream chat completion response did not include a response body.');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      const payloadModel = typeof payload.model === 'string' ? payload.model : '';
      const state: {
        id?: string;
        model: string;
        created?: number;
        content: string;
        reasoningContent: string;
        toolCalls: OpenAIAccumulatedToolCall[];
        finishReason?: string;
      } = {
        model: payloadModel,
        content: '',
        reasoningContent: '',
        toolCalls: [],
        finishReason: undefined,
      };

      const processLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) {
          return;
        }

        const jsonString = trimmed.slice(5).trim();
        if (jsonString === '[DONE]') {
          return;
        }

        try {
          const payloadChunk = JSON.parse(jsonString) as {
            id?: string;
            model?: string;
            created?: number;
            choices?: Array<{
              finish_reason?: string | null;
              delta?: {
                content?: string;
                reasoning_content?: string;
                tool_calls?: OpenAIChunkToolCallDelta[];
              };
            }>;
          };

          const choice = payloadChunk.choices?.[0];
          const delta = choice?.delta ?? {};

          state.id ??= payloadChunk.id;
          state.created ??= payloadChunk.created;
          state.model = payloadChunk.model || state.model;

          if (typeof delta.content === 'string') {
            state.content += delta.content;
            onTextDelta?.(delta.content);
          }

          if (typeof delta.reasoning_content === 'string') {
            state.reasoningContent += delta.reasoning_content;
          }

          if (Array.isArray(delta.tool_calls)) {
            accumulateOpenAIToolCalls(state.toolCalls, delta.tool_calls);
          }

          if (typeof choice?.finish_reason === 'string') {
            state.finishReason = choice.finish_reason;
          }
        } catch {
          this.outputChannel.debug(`Ignoring malformed upstream SSE line: ${line.slice(0, 160)}`);
        }
      };

      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          processLine(line);
        }
      }

      buffer += decoder.decode();
      if (buffer.trim()) {
        processLine(buffer);
      }

      return {
        endpointType: this.endpointType,
        id: state.id,
        model: state.model,
        created: state.created,
        content: state.content,
        reasoningContent: state.reasoningContent,
        toolCalls: finalizeOpenAIToolCalls(state.toolCalls),
        finishReason: state.finishReason,
      };
    } catch (error) {
      if (token.isCancellationRequested || isCancellationError(error)) {
        throw new vscode.CancellationError();
      }

      if (isLikelyTransportError(error)) {
        throw createUpstreamTransportError(error, 'stream');
      }

      throw error;
    } finally {
      opened.disposeCancellation();
    }
  }
}

class LmStudioRestUpstreamClient extends BaseUpstreamClient {
  readonly endpointType = 'lm-studio-rest' as const;

  async listModels(
    connection: UpstreamConnectionSettings,
    token: vscode.CancellationToken,
  ): Promise<UpstreamModelInfo[]> {
    try {
      const response = await this.fetchJson<{ models?: unknown[] }>(connection, '/api/v1/models', token, { method: 'GET' });
      const models = Array.isArray(response.models) ? response.models : [];

      return models
        .map((rawModel) => normalizeLmStudioV1ModelInfo(rawModel))
        .filter((model): model is UpstreamModelInfo => Boolean(model));
    } catch (error) {
      if (isCancellationError(error)) {
        throw error;
      }

      this.outputChannel.debug(
        `Falling back to LM Studio v0 model listing after /api/v1/models failed: ${error instanceof Error ? error.message : String(error)}`,
      );

      const response = await this.fetchJson<{ data?: unknown[] }>(connection, '/api/v0/models', token, { method: 'GET' });
      const models = Array.isArray(response.data) ? response.data : [];

      return models
        .map((rawModel) => normalizeLmStudioV0ModelInfo(rawModel))
        .filter((model): model is UpstreamModelInfo => Boolean(model));
    }
  }

  async streamChatCompletion(
    connection: UpstreamConnectionSettings,
    payload: Record<string, unknown>,
    token: vscode.CancellationToken,
    onTextDelta?: (value: string) => void,
  ): Promise<UpstreamChatCompletionResult> {
    const opened = await this.openFetch(connection, '/api/v1/chat', token, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload as LMStudioChatRequest),
    });
    const response = opened.response;

    try {
      if (!response.body) {
        throw new Error('The LM Studio chat response did not include a response body.');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let streamError: string | undefined;
      const payloadModel = typeof payload.model === 'string' ? payload.model : '';
      const state: {
        model: string;
        content: string;
        reasoningContent: string;
        toolCalls: OpenAIWireToolCall[];
        responseId?: string;
        finishReason?: string;
      } = {
        model: payloadModel,
        content: '',
        reasoningContent: '',
        toolCalls: [],
      };

      const processEventBlock = (eventBlock: string): void => {
        const normalizedBlock = eventBlock.replace(/\r/g, '');
        if (!normalizedBlock.trim()) {
          return;
        }

        let eventType = '';
        const dataLines: string[] = [];

        for (const line of normalizedBlock.split('\n')) {
          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
            continue;
          }

          if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trim());
          }
        }

        const dataText = dataLines.join('\n').trim();
        if (!dataText) {
          return;
        }

        try {
          const eventPayload = JSON.parse(dataText) as Record<string, unknown>;

          switch (eventType) {
            case 'chat.start':
              if (typeof eventPayload.model_instance_id === 'string') {
                state.model = eventPayload.model_instance_id;
              }
              break;
            case 'message.delta':
              if (typeof eventPayload.content === 'string') {
                state.content += eventPayload.content;
                onTextDelta?.(eventPayload.content);
              }
              break;
            case 'reasoning.delta':
              if (typeof eventPayload.content === 'string') {
                state.reasoningContent += eventPayload.content;
              }
              break;
            case 'error':
              streamError = extractLmStudioErrorMessage(eventPayload);
              break;
            case 'chat.end':
              applyLmStudioChatEnd(state, eventPayload);
              state.finishReason = streamError ? 'error' : 'stop';
              break;
            default:
              break;
          }
        } catch {
          this.outputChannel.debug(`Ignoring malformed LM Studio SSE block: ${normalizedBlock.slice(0, 240)}`);
        }
      };

      for await (const chunk of response.body) {
        buffer = normalizeSseEventBuffer(buffer + decoder.decode(chunk, { stream: true }));
        let boundaryIndex = buffer.indexOf('\n\n');

        while (boundaryIndex >= 0) {
          const eventBlock = buffer.slice(0, boundaryIndex);
          buffer = buffer.slice(boundaryIndex + 2);
          processEventBlock(eventBlock);
          boundaryIndex = buffer.indexOf('\n\n');
        }
      }

      buffer = normalizeSseEventBuffer(buffer + decoder.decode(), true);
      if (buffer.trim()) {
        processEventBlock(buffer);
      }

      if (streamError && (state.content || state.reasoningContent || state.toolCalls.length > 0 || state.responseId)) {
        this.outputChannel.warn(`LM Studio stream returned an error after partial output: ${sanitizeUpstreamDiagnosticText(streamError)}`);
      }

      if (streamError && !state.content && !state.reasoningContent && state.toolCalls.length === 0 && !state.responseId) {
        throw new Error(streamError);
      }

      return {
        endpointType: this.endpointType,
        model: state.model,
        content: state.content,
        reasoningContent: state.reasoningContent,
        toolCalls: state.toolCalls,
        responseId: state.responseId,
        finishReason: state.finishReason ?? (streamError ? 'error' : 'stop'),
      };
    } catch (error) {
      if (token.isCancellationRequested || isCancellationError(error)) {
        throw new vscode.CancellationError();
      }

      if (isLikelyTransportError(error)) {
        throw createUpstreamTransportError(error, 'stream');
      }

      throw error;
    } finally {
      opened.disposeCancellation();
    }
  }
}

function normalizeSseEventBuffer(value: string, final = false): string {
  const normalized = value.replace(/\r\n/g, '\n');
  return final ? normalized.replace(/\r/g, '\n') : normalized;
}

function normalizeOpenAIModelInfo(rawModel: unknown): UpstreamModelInfo | undefined {
  if (!rawModel || typeof rawModel !== 'object') {
    return undefined;
  }

  const candidate = rawModel as {
    id?: unknown;
    object?: unknown;
    owned_by?: unknown;
    context_length?: unknown;
    max_model_len?: unknown;
    input_modalities?: unknown;
    output_modalities?: unknown;
    supported_features?: unknown;
  };

  if (typeof candidate.id !== 'string' || !candidate.id.trim()) {
    return undefined;
  }

  return {
    endpointType: 'openai-compatible',
    id: candidate.id.trim(),
    kind: typeof candidate.object === 'string' ? candidate.object : undefined,
    object: typeof candidate.object === 'string' ? candidate.object : undefined,
    ownedBy: typeof candidate.owned_by === 'string' ? candidate.owned_by : undefined,
    contextLength: parseOptionalInteger(candidate.context_length),
    maxModelLen: parseOptionalInteger(candidate.max_model_len),
    inputModalities: normalizeStringArray(candidate.input_modalities),
    outputModalities: normalizeStringArray(candidate.output_modalities),
    supportedFeatures: normalizeStringArray(candidate.supported_features),
  };
}

function normalizeLmStudioV1ModelInfo(rawModel: unknown): UpstreamModelInfo | undefined {
  if (!rawModel || typeof rawModel !== 'object') {
    return undefined;
  }

  const candidate = rawModel as {
    key?: unknown;
    type?: unknown;
    publisher?: unknown;
    display_name?: unknown;
    max_context_length?: unknown;
    capabilities?: {
      vision?: unknown;
      trained_for_tool_use?: unknown;
    } | unknown;
  };

  if (typeof candidate.key !== 'string' || !candidate.key.trim()) {
    return undefined;
  }

  const capabilities = candidate.capabilities && typeof candidate.capabilities === 'object'
    ? candidate.capabilities as { vision?: unknown; trained_for_tool_use?: unknown }
    : undefined;

  return {
    endpointType: 'lm-studio-rest',
    id: candidate.key.trim(),
    kind: typeof candidate.type === 'string' ? candidate.type : undefined,
    displayName: typeof candidate.display_name === 'string' ? candidate.display_name.trim() : undefined,
    ownedBy: typeof candidate.publisher === 'string' ? candidate.publisher : undefined,
    contextLength: parseOptionalInteger(candidate.max_context_length),
    endpointCapabilities: {
      imageInput: capabilities?.vision === true,
      toolCalling: capabilities?.trained_for_tool_use === true,
    },
  };
}

function normalizeLmStudioV0ModelInfo(rawModel: unknown): UpstreamModelInfo | undefined {
  if (!rawModel || typeof rawModel !== 'object') {
    return undefined;
  }

  const candidate = rawModel as {
    id?: unknown;
    type?: unknown;
    object?: unknown;
    publisher?: unknown;
    max_context_length?: unknown;
    capabilities?: unknown;
  };

  if (typeof candidate.id !== 'string' || !candidate.id.trim()) {
    return undefined;
  }

  const capabilities = normalizeStringArray(candidate.capabilities) ?? [];

  return {
    endpointType: 'lm-studio-rest',
    id: candidate.id.trim(),
    kind: typeof candidate.type === 'string' ? candidate.type : undefined,
    object: typeof candidate.object === 'string' ? candidate.object : undefined,
    ownedBy: typeof candidate.publisher === 'string' ? candidate.publisher : undefined,
    contextLength: parseOptionalInteger(candidate.max_context_length),
    supportedFeatures: capabilities,
    endpointCapabilities: {
      imageInput: candidate.type === 'vlm',
      toolCalling: capabilities.includes('tool_use'),
    },
  };
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function parseOptionalInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function accumulateOpenAIToolCalls(target: OpenAIAccumulatedToolCall[], deltaToolCalls: OpenAIChunkToolCallDelta[] = []): void {
  for (const deltaToolCall of deltaToolCalls) {
    const index = deltaToolCall.index ?? target.length;

    if (!target[index]) {
      target[index] = {
        id: '',
        type: 'function',
        function: {
          name: '',
          arguments: '',
        },
      };
    }

    const current = target[index];
    if (typeof deltaToolCall.id === 'string') {
      current.id = deltaToolCall.id;
    }

    if (deltaToolCall.type === 'function') {
      current.type = 'function';
    }

    if (typeof deltaToolCall.function?.name === 'string') {
      current.function.name += deltaToolCall.function.name;
    }

    if (typeof deltaToolCall.function?.arguments === 'string') {
      current.function.arguments += deltaToolCall.function.arguments;
    }
  }
}

function finalizeOpenAIToolCalls(toolCalls: OpenAIAccumulatedToolCall[]): OpenAIWireToolCall[] {
  return toolCalls
    .filter(Boolean)
    .map((toolCall, index) => ({
      id: toolCall.id || `tool-call-${index + 1}`,
      type: 'function' as const,
      function: {
        name: toolCall.function.name,
        arguments: parseToolArguments(toolCall.function.arguments),
      },
    }))
    .filter((toolCall) => Boolean(toolCall.function.name));
}

function parseToolArguments(argumentsValue: string): object {
  if (!argumentsValue.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(argumentsValue);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function extractLmStudioErrorMessage(eventPayload: Record<string, unknown>): string {
  const errorValue = eventPayload.error;
  if (!errorValue || typeof errorValue !== 'object') {
    return 'LM Studio stream returned an unspecified error event.';
  }

  const candidate = errorValue as {
    message?: unknown;
    type?: unknown;
  };

  const message = typeof candidate.message === 'string' ? candidate.message.trim() : '';
  const type = typeof candidate.type === 'string' ? candidate.type.trim() : '';

  if (message && type) {
    return `${type}: ${message}`;
  }

  return message || type || 'LM Studio stream returned an unspecified error event.';
}

function applyLmStudioChatEnd(
  state: {
    model: string;
    content: string;
    reasoningContent: string;
    toolCalls: OpenAIWireToolCall[];
    responseId?: string;
  },
  eventPayload: Record<string, unknown>,
): void {
  const result = eventPayload.result;
  if (!result || typeof result !== 'object') {
    return;
  }

  const candidate = result as {
    model_instance_id?: unknown;
    response_id?: unknown;
    output?: unknown;
  };

  if (typeof candidate.model_instance_id === 'string' && candidate.model_instance_id.trim()) {
    state.model = candidate.model_instance_id.trim();
  }

  if (typeof candidate.response_id === 'string' && candidate.response_id.trim()) {
    state.responseId = candidate.response_id.trim();
  }

  if (!Array.isArray(candidate.output)) {
    return;
  }

  const messageContent = candidate.output
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return undefined;
      }

      const outputItem = item as { type?: unknown; content?: unknown };
      return outputItem.type === 'message' && typeof outputItem.content === 'string'
        ? outputItem.content
        : undefined;
    })
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
    .join('\n')
    .trim();

  if (messageContent.length > state.content.length) {
    state.content = messageContent;
  }

  const reasoningContent = candidate.output
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return undefined;
      }

      const outputItem = item as { type?: unknown; content?: unknown };
      return outputItem.type === 'reasoning' && typeof outputItem.content === 'string'
        ? outputItem.content
        : undefined;
    })
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
    .join('\n')
    .trim();

  if (reasoningContent.length > state.reasoningContent.length) {
    state.reasoningContent = reasoningContent;
  }

  const toolCalls = candidate.output
    .map((item, index) => normalizeLmStudioToolCall(item, index))
    .filter((item): item is OpenAIWireToolCall => Boolean(item));

  if (toolCalls.length > 0) {
    state.toolCalls = toolCalls;
  }
}

function normalizeLmStudioToolCall(item: unknown, index: number): OpenAIWireToolCall | undefined {
  if (!item || typeof item !== 'object') {
    return undefined;
  }

  const candidate = item as {
    type?: unknown;
    tool?: unknown;
    arguments?: unknown;
  };

  if (candidate.type !== 'tool_call' || typeof candidate.tool !== 'string' || !candidate.tool.trim()) {
    return undefined;
  }

  const argumentsValue = candidate.arguments && typeof candidate.arguments === 'object'
    ? candidate.arguments as object
    : {};

  return {
    id: `tool-call-${index + 1}`,
    type: 'function',
    function: {
      name: candidate.tool.trim(),
      arguments: argumentsValue,
    },
  };
}
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import * as vscode from 'vscode';

import {
  BackendEndpointType,
  CONVERSATION_STATE_STORAGE_FILE_NAME,
  ConversationStateSettings,
} from '../config/settings';
import { ReasoningHiddenState } from './hiddenState';
import { OpenAIWireToolCall } from './upstreamClient';

interface NormalizedTranscriptMessage {
  role: 'user' | 'assistant' | 'other';
  parts: string[];
}

interface StoredConversationState extends ReasoningHiddenState {
  transcriptKey: string;
  updatedAt: number;
}

interface PersistedConversationStateFile {
  schemaVersion: 1;
  entries: StoredConversationState[];
}

export interface ConversationStateLookupResult {
  state?: ReasoningHiddenState;
  transcriptKey?: string;
}

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_TTL_MINUTES = 720;
const dataPartTextDecoder = new TextDecoder();

export class ConversationStateCache {
  private readonly entries = new Map<string, StoredConversationState>();
  private readonly storageFileUri: vscode.Uri | null;
  private persistenceEnabled = false;
  private maxEntries = DEFAULT_MAX_ENTRIES;
  private ttlMs = DEFAULT_TTL_MINUTES * 60_000;
  private configKey = '';
  private hasLoadedPersistedEntries = false;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel: vscode.LogOutputChannel,
  ) {
    this.storageFileUri = getConversationStateStorageFileUri(context);
  }

  async configure(settings: ConversationStateSettings): Promise<void> {
    const nextMaxEntries = clampPositiveInteger(settings.maxEntries, DEFAULT_MAX_ENTRIES);
    const nextTtlMinutes = clampPositiveInteger(settings.ttlMinutes, DEFAULT_TTL_MINUTES);
    const nextPersistenceEnabled = Boolean(settings.persistAcrossReload);
    const nextConfigKey = `${nextPersistenceEnabled}:${nextMaxEntries}:${nextTtlMinutes}`;
    const configChanged = this.configKey !== nextConfigKey;

    this.maxEntries = nextMaxEntries;
    this.ttlMs = nextTtlMinutes * 60_000;
    this.pruneExpiredEntries();
    this.enforceLimit();

    if (!configChanged) {
      return;
    }

    this.configKey = nextConfigKey;
    this.persistenceEnabled = nextPersistenceEnabled;

    if (!this.persistenceEnabled) {
      this.hasLoadedPersistedEntries = false;
      await this.clearPersistedEntries();
      return;
    }

    if (!this.storageFileUri) {
      this.persistenceEnabled = false;
      this.outputChannel.warn('Conversation-state persistence is enabled but extension storage is unavailable. Falling back to in-memory cache only.');
      return;
    }

    await this.loadPersistedEntries();
    await this.persistEntries();
  }

  lookup(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    modelId: string,
    endpointType: BackendEndpointType,
    hiddenStateMimeType: string,
  ): ConversationStateLookupResult {
    this.pruneExpiredEntries();
    const candidateKeys = buildRecoverablePrefixKeys(messages, hiddenStateMimeType);

    for (let index = candidateKeys.length - 1; index >= 0; index -= 1) {
      const transcriptKey = candidateKeys[index];
      const entry = this.entries.get(transcriptKey);
      if (!entry) {
        continue;
      }

      if (entry.modelId !== modelId) {
        continue;
      }

      if (entry.endpointType && entry.endpointType !== endpointType) {
        continue;
      }

      this.touch(entry);
      return {
        state: {
          kind: entry.kind,
          schemaVersion: entry.schemaVersion,
          modelId: entry.modelId,
          createdAt: entry.createdAt,
          reasoningContent: entry.reasoningContent,
          endpointType: entry.endpointType,
          responseId: entry.responseId,
          responsesReasoningItems: entry.responsesReasoningItems,
        },
        transcriptKey,
      };
    }

    return {
      transcriptKey: candidateKeys.at(-1),
    };
  }

  async remember(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    hiddenState: ReasoningHiddenState,
    assistantText: string,
    toolCalls: OpenAIWireToolCall[],
    hiddenStateMimeType: string,
  ): Promise<string | undefined> {
    this.pruneExpiredEntries();
    const normalizedMessages = normalizeIncomingMessages(messages, hiddenStateMimeType);
    const assistantMessage = normalizeAssistantResponse(assistantText, toolCalls);
    const transcriptKeys = new Set<string>();
    if (normalizedMessages.length > 0) {
      transcriptKeys.add(computeTranscriptKey(normalizedMessages));
    }

    if (assistantMessage) {
      normalizedMessages.push(assistantMessage);
      transcriptKeys.add(computeTranscriptKey(normalizedMessages));
    }

    if (transcriptKeys.size === 0) {
      return undefined;
    }

    const updatedAt = Date.now();
    for (const transcriptKey of transcriptKeys) {
      this.entries.set(transcriptKey, {
        ...hiddenState,
        transcriptKey,
        updatedAt,
      });
    }

    this.enforceLimit();
    await this.persistEntries();
    return Array.from(transcriptKeys).at(-1);
  }

  private touch(entry: StoredConversationState): void {
    this.entries.delete(entry.transcriptKey);
    this.entries.set(entry.transcriptKey, {
      ...entry,
      updatedAt: Date.now(),
    });
  }

  private async loadPersistedEntries(): Promise<void> {
    if (!this.storageFileUri || this.hasLoadedPersistedEntries) {
      return;
    }

    const persistedEntries = await readPersistedEntries(this.storageFileUri, this.outputChannel);
    const currentEntries = Array.from(this.entries.values());
    this.entries.clear();

    const mergedEntries = [...persistedEntries, ...currentEntries]
      .filter((entry) => !this.isExpiredEntry(entry))
      .sort((left, right) => left.updatedAt - right.updatedAt);

    for (const entry of mergedEntries) {
      this.entries.set(entry.transcriptKey, entry);
    }

    this.enforceLimit();
    this.hasLoadedPersistedEntries = true;

    if (persistedEntries.length > 0) {
      this.outputChannel.info(`Restored ${persistedEntries.length} persisted conversation-state entr${persistedEntries.length === 1 ? 'y' : 'ies'}.`);
    }
  }

  private async persistEntries(): Promise<void> {
    if (!this.persistenceEnabled || !this.storageFileUri) {
      return;
    }

    const storageFileUri = this.storageFileUri;
    const snapshot = Array.from(this.entries.values()).sort((left, right) => left.updatedAt - right.updatedAt);
    this.persistQueue = this.persistQueue
      .then(async () => {
        await ensureStorageDirectory(this.context);
        const payload: PersistedConversationStateFile = {
          schemaVersion: 1,
          entries: snapshot,
        };
        const content = `${JSON.stringify(payload, null, 2)}\n`;
        await vscode.workspace.fs.writeFile(storageFileUri, Buffer.from(content, 'utf8'));
      })
      .catch((error) => {
        this.outputChannel.warn(
          `Failed to persist conversation-state cache: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

    await this.persistQueue;
  }

  private async clearPersistedEntries(): Promise<void> {
    if (!this.storageFileUri) {
      return;
    }

    const storageFileUri = this.storageFileUri;
    this.persistQueue = this.persistQueue
      .then(async () => {
        try {
          await vscode.workspace.fs.delete(storageFileUri);
          this.outputChannel.info('Cleared persisted conversation-state cache because disk persistence is disabled.');
        } catch (error) {
          if (!isFileNotFoundError(error)) {
            throw error;
          }
        }
      })
      .catch((error) => {
        this.outputChannel.warn(
          `Failed to clear persisted conversation-state cache: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

    await this.persistQueue;
  }

  private pruneExpiredEntries(): void {
    for (const [transcriptKey, entry] of this.entries.entries()) {
      if (this.isExpiredEntry(entry)) {
        this.entries.delete(transcriptKey);
      }
    }
  }

  private isExpiredEntry(entry: StoredConversationState): boolean {
    return entry.updatedAt < Date.now() - this.ttlMs;
  }

  private enforceLimit(): void {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) {
        return;
      }

      this.entries.delete(oldestKey);
    }
  }
}

function buildRecoverablePrefixKeys(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  hiddenStateMimeType: string,
): string[] {
  const normalizedMessages: NormalizedTranscriptMessage[] = [];
  const keys: string[] = [];

  for (const message of messages) {
    const normalizedMessage = normalizeIncomingMessage(message, hiddenStateMimeType);
    if (!normalizedMessage) {
      continue;
    }

    normalizedMessages.push(normalizedMessage);
    if (normalizedMessage.role === 'assistant' || normalizedMessage.role === 'user') {
      keys.push(computeTranscriptKey(normalizedMessages));
    }
  }

  return keys;
}

function normalizeIncomingMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  hiddenStateMimeType: string,
): NormalizedTranscriptMessage[] {
  const normalizedMessages: NormalizedTranscriptMessage[] = [];

  for (const message of messages) {
    const normalizedMessage = normalizeIncomingMessage(message, hiddenStateMimeType);
    if (normalizedMessage) {
      normalizedMessages.push(normalizedMessage);
    }
  }

  return normalizedMessages;
}

function normalizeIncomingMessage(
  message: vscode.LanguageModelChatRequestMessage,
  hiddenStateMimeType: string,
): NormalizedTranscriptMessage | undefined {
  const parts: string[] = [];

  for (const part of message.content) {
    if (isTextPart(part)) {
      const value = normalizeText(part.value);
      if (value) {
        parts.push(`text:${value}`);
      }
      continue;
    }

    if (isToolCallPart(part)) {
      parts.push(`toolcall:${part.name}:${stableStringify(part.input ?? {})}`);
      continue;
    }

    if (isToolResultPart(part)) {
      const resultText = normalizeToolResult(part.content);
      if (resultText) {
        parts.push(`toolresult:${part.callId}:${resultText}`);
      }
      continue;
    }

    if (isDataPart(part)) {
      if (part.mimeType === hiddenStateMimeType || part.mimeType === 'cache_control') {
        continue;
      }

      if (part.mimeType.startsWith('image/')) {
        parts.push(`image:${part.mimeType}:${part.data.byteLength}`);
        continue;
      }

      if (part.mimeType.startsWith('text/') || part.mimeType.includes('json')) {
        const textValue = normalizeText(decodeDataPartText(part));
        if (textValue) {
          parts.push(`data:${part.mimeType}:${textValue}`);
        }
      }
    }
  }

  if (parts.length === 0) {
    return undefined;
  }

  return {
    role: normalizeRole(message.role),
    parts,
  };
}

function normalizeAssistantResponse(
  assistantText: string,
  toolCalls: OpenAIWireToolCall[],
): NormalizedTranscriptMessage | undefined {
  const parts: string[] = [];
  const normalizedText = normalizeText(assistantText);
  if (normalizedText) {
    parts.push(`text:${normalizedText}`);
  }

  for (const toolCall of toolCalls) {
    parts.push(`toolcall:${toolCall.function.name}:${stableStringify(toolCall.function.arguments)}`);
  }

  if (parts.length === 0) {
    return undefined;
  }

  return {
    role: 'assistant',
    parts,
  };
}

function computeTranscriptKey(messages: readonly NormalizedTranscriptMessage[]): string {
  return createHash('sha256').update(stableStringify(messages)).digest('hex');
}

function clampPositiveInteger(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeRole(role: vscode.LanguageModelChatMessageRole): 'user' | 'assistant' | 'other' {
  if (role === vscode.LanguageModelChatMessageRole.User) {
    return 'user';
  }

  if (role === vscode.LanguageModelChatMessageRole.Assistant) {
    return 'assistant';
  }

  return 'other';
}

function normalizeToolResult(content: readonly unknown[]): string {
  const parts = content
    .map((part) => {
      if (isTextPart(part)) {
        return normalizeText(part.value);
      }

      if (isDataPart(part)) {
        if (part.mimeType.startsWith('image/')) {
          return `image:${part.mimeType}:${part.data.byteLength}`;
        }

        if (part.mimeType.startsWith('text/') || part.mimeType.includes('json')) {
          return normalizeText(decodeDataPartText(part));
        }
      }

      if (typeof part === 'string') {
        return normalizeText(part);
      }

      return normalizeText(stableStringify(part));
    })
    .filter((value): value is string => Boolean(value));

  return parts.join('\n');
}

function decodeDataPartText(part: { data: Uint8Array; mimeType: string }): string {
  return dataPartTextDecoder.decode(part.data);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stableStringify(value: unknown, seen: WeakSet<object> = new WeakSet<object>()): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (seen.has(value)) {
    return JSON.stringify('[Circular]');
  }

  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableStringify(item, seen)).join(',')}]`;
    }

    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item, seen)}`).join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

function isTextPart(part: unknown): part is { value: string } {
  return Boolean(part && typeof part === 'object' && typeof (part as { value?: unknown }).value === 'string');
}

function isToolCallPart(part: unknown): part is { callId: string; name: string; input: object } {
  if (!part || typeof part !== 'object') {
    return false;
  }

  const candidate = part as { callId?: unknown; name?: unknown; input?: unknown };
  return typeof candidate.callId === 'string' && typeof candidate.name === 'string' && Boolean(candidate.input && typeof candidate.input === 'object');
}

function isToolResultPart(part: unknown): part is { callId: string; content: readonly unknown[] } {
  if (!part || typeof part !== 'object') {
    return false;
  }

  const candidate = part as { callId?: unknown; content?: unknown };
  return typeof candidate.callId === 'string' && Array.isArray(candidate.content);
}

function isDataPart(part: unknown): part is { data: Uint8Array; mimeType: string } {
  if (!part || typeof part !== 'object') {
    return false;
  }

  const candidate = part as { data?: unknown; mimeType?: unknown };
  return candidate.data instanceof Uint8Array && typeof candidate.mimeType === 'string';
}

function getConversationStateStorageBaseUri(context: vscode.ExtensionContext): vscode.Uri | null {
  return (vscode.workspace.workspaceFolders?.length ? context.storageUri : context.globalStorageUri) ?? null;
}

function getConversationStateStorageFileUri(context: vscode.ExtensionContext): vscode.Uri | null {
  const baseUri = getConversationStateStorageBaseUri(context);
  return baseUri ? vscode.Uri.joinPath(baseUri, CONVERSATION_STATE_STORAGE_FILE_NAME) : null;
}

async function ensureStorageDirectory(context: vscode.ExtensionContext): Promise<void> {
  const baseUri = getConversationStateStorageBaseUri(context);
  if (!baseUri) {
    return;
  }

  try {
    await vscode.workspace.fs.stat(baseUri);
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }

    await vscode.workspace.fs.createDirectory(baseUri);
  }
}

async function readPersistedEntries(fileUri: vscode.Uri, outputChannel: vscode.LogOutputChannel): Promise<StoredConversationState[]> {
  try {
    const raw = await vscode.workspace.fs.readFile(fileUri);
    const parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as PersistedConversationStateFile | undefined;
    if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) {
      return [];
    }

    return parsed.entries.filter(isStoredConversationState);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return [];
    }

    if (error instanceof SyntaxError) {
      outputChannel.warn(
        `Failed to parse persisted conversation-state cache at ${fileUri.fsPath}. Starting with an empty cache: ${error.message}`,
      );
      return [];
    }

    throw error;
  }
}

function isStoredConversationState(value: unknown): value is StoredConversationState {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<StoredConversationState>;
  return (
    candidate.kind === 'backend-reasoning-state' &&
    candidate.schemaVersion === 1 &&
    typeof candidate.modelId === 'string' &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.reasoningContent === 'string' &&
    typeof candidate.transcriptKey === 'string' &&
    typeof candidate.updatedAt === 'number' &&
    Number.isFinite(candidate.updatedAt) &&
    (candidate.endpointType === undefined || candidate.endpointType === 'openai-compatible' || candidate.endpointType === 'responses-api' || candidate.endpointType === 'lm-studio' || candidate.endpointType === 'lm-studio-responses' || candidate.endpointType === 'lm-studio-rest') &&
    (candidate.responseId === undefined || typeof candidate.responseId === 'string') &&
    (candidate.responsesReasoningItems === undefined || Array.isArray(candidate.responsesReasoningItems))
  );
}

function isFileNotFoundError(error: unknown): boolean {
  return Boolean(
    (error as { code?: unknown } | undefined)?.code === 'FileNotFound' ||
    /file not found/i.test(String((error as { message?: unknown } | undefined)?.message ?? '')),
  );
}
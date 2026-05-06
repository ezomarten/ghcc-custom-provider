import * as vscode from 'vscode';

import { BackendEndpointType } from '../config/settings';
import { UpstreamModelInfo } from './upstreamClient';

const MODEL_CACHE_STATE_KEY = 'ghccCustomProvider.endpointModelCache.v1';

export type EndpointModelCacheEntry = EndpointModelCacheSuccessEntry | EndpointModelCacheErrorEntry;

export interface EndpointModelCacheSuccessEntry {
  readonly kind: 'success';
  readonly checkedAt: number;
  readonly endpointType: BackendEndpointType;
  readonly baseUrl: string;
  readonly chatModels: readonly UpstreamModelInfo[];
}

export interface EndpointModelCacheErrorEntry {
  readonly kind: 'error';
  readonly checkedAt: number;
  readonly endpointType: BackendEndpointType;
  readonly baseUrl: string;
  readonly detail: string;
}

export interface EndpointModelCacheChangeEvent {
  readonly endpointId: string;
  readonly entry: EndpointModelCacheEntry | null;
}

export class EndpointModelCacheStore {
  private readonly entries = new Map<string, EndpointModelCacheEntry>();
  private readonly changeEmitter = new vscode.EventEmitter<EndpointModelCacheChangeEvent>();

  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async initialize(): Promise<void> {
    const persisted = this.context.workspaceState.get<unknown>(MODEL_CACHE_STATE_KEY);
    this.entries.clear();

    for (const [endpointId, entry] of sanitizePersistedEntries(persisted)) {
      this.entries.set(endpointId, entry);
    }
  }

  get(endpointId: string, endpointType: BackendEndpointType, baseUrl: string): EndpointModelCacheEntry | undefined {
    const entry = this.entries.get(endpointId);
    if (!entry || entry.endpointType !== endpointType || normalizeBaseUrl(entry.baseUrl) !== normalizeBaseUrl(baseUrl)) {
      return undefined;
    }

    return cloneEntry(entry);
  }

  async setSuccess(
    endpointId: string,
    endpointType: BackendEndpointType,
    baseUrl: string,
    chatModels: readonly UpstreamModelInfo[],
  ): Promise<void> {
    await this.update(endpointId, {
      kind: 'success',
      checkedAt: Date.now(),
      endpointType,
      baseUrl: normalizeBaseUrl(baseUrl),
      chatModels: chatModels.map(cloneModelInfo),
    });
  }

  async setError(endpointId: string, endpointType: BackendEndpointType, baseUrl: string, detail: string): Promise<void> {
    await this.update(endpointId, {
      kind: 'error',
      checkedAt: Date.now(),
      endpointType,
      baseUrl: normalizeBaseUrl(baseUrl),
      detail,
    }, { persist: false });
  }

  async clear(endpointId: string): Promise<void> {
    if (!this.entries.delete(endpointId)) {
      return;
    }

    await this.persistSuccessEntries();

    this.changeEmitter.fire({
      endpointId,
      entry: null,
    });
  }

  private async update(endpointId: string, entry: EndpointModelCacheEntry, options: { persist?: boolean } = {}): Promise<void> {
    const clonedEntry = cloneEntry(entry);
    this.entries.set(endpointId, clonedEntry);
    if (options.persist !== false) {
      await this.persistSuccessEntries();
    }

    this.changeEmitter.fire({
      endpointId,
      entry: cloneEntry(clonedEntry),
    });
  }

  private async persistSuccessEntries(): Promise<void> {
    const entries = [...this.entries.entries()]
      .filter((entry): entry is [string, EndpointModelCacheSuccessEntry] => entry[1].kind === 'success')
      .map(([endpointId, entry]) => [endpointId, cloneEntry(entry)] as const);

    await this.context.workspaceState.update(MODEL_CACHE_STATE_KEY, Object.fromEntries(entries));
  }
}

function cloneEntry(entry: EndpointModelCacheEntry): EndpointModelCacheEntry {
  if (entry.kind === 'error') {
    return { ...entry };
  }

  return {
    ...entry,
    chatModels: entry.chatModels.map(cloneModelInfo),
  };
}

function cloneModelInfo(model: UpstreamModelInfo): UpstreamModelInfo {
  return {
    ...model,
    inputModalities: model.inputModalities ? [...model.inputModalities] : undefined,
    outputModalities: model.outputModalities ? [...model.outputModalities] : undefined,
    supportedFeatures: model.supportedFeatures ? [...model.supportedFeatures] : undefined,
    endpointCapabilities: model.endpointCapabilities ? { ...model.endpointCapabilities } : undefined,
  };
}

function sanitizePersistedEntries(raw: unknown): Array<readonly [string, EndpointModelCacheSuccessEntry]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return [];
  }

  return Object.entries(raw)
    .map(([endpointId, value]) => sanitizePersistedEntry(endpointId, value))
    .filter((entry): entry is readonly [string, EndpointModelCacheSuccessEntry] => Boolean(entry));
}

function sanitizePersistedEntry(endpointId: string, raw: unknown): readonly [string, EndpointModelCacheSuccessEntry] | undefined {
  if (!endpointId.trim() || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }

  const source = raw as Partial<EndpointModelCacheSuccessEntry>;
  if (source.kind !== 'success' || !isEndpointType(source.endpointType) || typeof source.baseUrl !== 'string' || !Array.isArray(source.chatModels)) {
    return undefined;
  }

  const chatModels = source.chatModels
    .map((model) => sanitizeModelInfo(model))
    .filter((model): model is UpstreamModelInfo => Boolean(model));

  return [endpointId, {
    kind: 'success',
    checkedAt: typeof source.checkedAt === 'number' && Number.isFinite(source.checkedAt) ? source.checkedAt : 0,
    endpointType: source.endpointType,
    baseUrl: normalizeBaseUrl(source.baseUrl),
    chatModels,
  }];
}

function sanitizeModelInfo(raw: unknown): UpstreamModelInfo | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }

  const source = raw as Partial<UpstreamModelInfo>;
  if (!isEndpointType(source.endpointType) || typeof source.id !== 'string' || !source.id.trim()) {
    return undefined;
  }

  return cloneModelInfo({
    endpointType: source.endpointType,
    id: source.id.trim(),
    kind: typeof source.kind === 'string' ? source.kind : undefined,
    displayName: typeof source.displayName === 'string' ? source.displayName : undefined,
    object: typeof source.object === 'string' ? source.object : undefined,
    ownedBy: typeof source.ownedBy === 'string' ? source.ownedBy : undefined,
    contextLength: typeof source.contextLength === 'number' && Number.isFinite(source.contextLength) ? source.contextLength : undefined,
    maxModelLen: typeof source.maxModelLen === 'number' && Number.isFinite(source.maxModelLen) ? source.maxModelLen : undefined,
    inputModalities: sanitizeStringArray(source.inputModalities),
    outputModalities: sanitizeStringArray(source.outputModalities),
    supportedFeatures: sanitizeStringArray(source.supportedFeatures),
    endpointCapabilities: source.endpointCapabilities && typeof source.endpointCapabilities === 'object' && !Array.isArray(source.endpointCapabilities)
      ? {
        imageInput: typeof source.endpointCapabilities.imageInput === 'boolean' ? source.endpointCapabilities.imageInput : undefined,
        toolCalling: typeof source.endpointCapabilities.toolCalling === 'boolean' ? source.endpointCapabilities.toolCalling : undefined,
      }
      : undefined,
  });
}

function sanitizeStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const values = raw.filter((value): value is string => typeof value === 'string');
  return values.length > 0 ? values : undefined;
}

function isEndpointType(value: unknown): value is BackendEndpointType {
  return value === 'openai-compatible' || value === 'lm-studio' || value === 'lm-studio-rest';
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}
import { randomUUID } from 'node:crypto';

import * as vscode from 'vscode';

import { BackendEndpointType } from '../config/settings';
import { HIDDEN_STATE_MIME } from '../config/settings';

const decoder = new TextDecoder();

export interface ProbeHiddenState {
  kind: 'probe-hidden-state';
  schemaVersion: 1;
  probeId: string;
  turnNumber: number;
  createdAt: string;
  previousProbeId?: string;
  lastUserText: string;
}

export interface ReasoningHiddenState {
  kind: 'backend-reasoning-state';
  schemaVersion: 1;
  modelId: string;
  createdAt: string;
  reasoningContent: string;
  endpointType?: BackendEndpointType;
  responseId?: string;
  responsesReasoningItems?: ResponsesReasoningStateItem[];
}

export interface ResponsesReasoningStateItem {
  type: 'reasoning';
  id?: string;
  encrypted_content?: string;
  summary?: unknown[];
  content?: unknown[];
}

export type BridgeHiddenState = ProbeHiddenState | ReasoningHiddenState;

export interface HiddenStateObservation {
  latestState?: ProbeHiddenState;
  latestReasoningState?: ReasoningHiddenState;
  matchingStateCount: number;
  matchingMimeTypeCount: number;
  reasoningStateCount: number;
  totalDataParts: number;
  decodeErrors: string[];
  partDiagnostics: string[];
}

interface DataPartLike {
  data: Uint8Array;
  mimeType: string;
}

export function createNextHiddenState(previousState: ProbeHiddenState | undefined, lastUserText: string): ProbeHiddenState {
  return {
    kind: 'probe-hidden-state',
    schemaVersion: 1,
    probeId: randomUUID(),
    turnNumber: previousState ? previousState.turnNumber + 1 : 1,
    createdAt: new Date().toISOString(),
    previousProbeId: previousState?.probeId,
    lastUserText,
  };
}

export function encodeHiddenState(
  state: ProbeHiddenState,
  mimeType: string = HIDDEN_STATE_MIME,
): vscode.LanguageModelDataPart {
  return vscode.LanguageModelDataPart.json(state, mimeType);
}

export function createReasoningHiddenState(
  modelId: string,
  reasoningContent: string,
  options?: {
    endpointType?: BackendEndpointType;
    responseId?: string;
    responsesReasoningItems?: ResponsesReasoningStateItem[];
  },
): ReasoningHiddenState {
  return {
    kind: 'backend-reasoning-state',
    schemaVersion: 1,
    modelId,
    createdAt: new Date().toISOString(),
    reasoningContent,
    endpointType: options?.endpointType,
    responseId: options?.responseId?.trim() || undefined,
    responsesReasoningItems: normalizeResponsesReasoningStateItems(options?.responsesReasoningItems),
  };
}

export function encodeReasoningHiddenState(
  state: ReasoningHiddenState,
  mimeType: string = HIDDEN_STATE_MIME,
): vscode.LanguageModelDataPart {
  return vscode.LanguageModelDataPart.json(state, mimeType);
}

export function inspectHiddenState(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  expectedMimeType: string,
): HiddenStateObservation {
  let latestState: ProbeHiddenState | undefined;
  let latestReasoningState: ReasoningHiddenState | undefined;
  let matchingStateCount = 0;
  let matchingMimeTypeCount = 0;
  let reasoningStateCount = 0;
  let totalDataParts = 0;
  const decodeErrors: string[] = [];
  const partDiagnostics: string[] = [];

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    for (let partIndex = 0; partIndex < message.content.length; partIndex += 1) {
      const part = message.content[partIndex];
      const dataPart = asDataPart(part);
      if (!dataPart) {
        continue;
      }

      totalDataParts += 1;
      partDiagnostics.push(describeDataPart(message.role, messageIndex, partIndex, part, dataPart));

      if (dataPart.mimeType !== expectedMimeType) {
        continue;
      }

      matchingMimeTypeCount += 1;

      const decodedState = decodeHiddenStatePart(dataPart);
      if (decodedState.ok) {
        if (decodedState.value.kind === 'probe-hidden-state') {
          latestState = decodedState.value;
          matchingStateCount += 1;
        } else {
          latestReasoningState = decodedState.value;
          reasoningStateCount += 1;
        }
      } else {
        decodeErrors.push(decodedState.error);
      }
    }
  }

  return {
    latestState,
    latestReasoningState,
    matchingStateCount,
    matchingMimeTypeCount,
    reasoningStateCount,
    totalDataParts,
    decodeErrors,
    partDiagnostics,
  };
}

export function extractLatestReasoningHiddenStateFromParts(
  parts: readonly unknown[],
  expectedMimeType: string,
): ReasoningHiddenState | undefined {
  let latestState: ReasoningHiddenState | undefined;

  for (const part of parts) {
    const dataPart = asDataPart(part);
    if (!dataPart || dataPart.mimeType !== expectedMimeType) {
      continue;
    }

    const decodedState = decodeHiddenStatePart(dataPart);
    if (decodedState.ok && decodedState.value.kind === 'backend-reasoning-state') {
      latestState = decodedState.value;
    }
  }

  return latestState;
}

export function extractLatestReasoningHiddenStateFromMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  expectedMimeType: string,
): ReasoningHiddenState | undefined {
  return inspectHiddenState(messages, expectedMimeType).latestReasoningState;
}

export function isHiddenStateMimeType(part: { mimeType: string }, expectedMimeType: string): boolean {
  return part.mimeType === expectedMimeType;
}

function decodeHiddenStatePart(dataPart: DataPartLike): { ok: true; value: BridgeHiddenState } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(decoder.decode(dataPart.data));
    if (!isBridgeHiddenState(parsed)) {
      return {
        ok: false,
        error: 'Hidden-state DataPart did not match the expected schema.',
      };
    }

    return {
      ok: true,
      value: parsed,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function asDataPart(part: unknown): DataPartLike | undefined {
  if (!part || typeof part !== 'object') {
    return undefined;
  }

  const candidate = part as {
    data?: unknown;
    value?: unknown;
    mimeType?: unknown;
  };

  if (typeof candidate.mimeType !== 'string') {
    return undefined;
  }

  const data = toUint8Array(candidate.data) ?? toUint8Array(candidate.value) ?? serializeStructuredValue(candidate.data ?? candidate.value);
  if (!data) {
    return undefined;
  }

  return {
    data,
    mimeType: candidate.mimeType,
  };
}

function toUint8Array(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  if (Array.isArray(value) && value.every((item) => typeof item === 'number' && item >= 0 && item <= 255)) {
    return Uint8Array.from(value);
  }

  if (isBufferLikeObject(value)) {
    return Uint8Array.from(value.data);
  }

  if (isNumberIndexedObject(value)) {
    const orderedEntries = Object.entries(value)
      .filter(([key, item]) => /^\d+$/.test(key) && typeof item === 'number' && item >= 0 && item <= 255)
      .sort((left, right) => Number(left[0]) - Number(right[0]));

    if (orderedEntries.length > 0) {
      return Uint8Array.from(orderedEntries.map(([, item]) => item as number));
    }
  }

  return undefined;
}

function serializeStructuredValue(value: unknown): Uint8Array | undefined {
  if (typeof value === 'string') {
    return new TextEncoder().encode(value);
  }

  if (value && typeof value === 'object') {
    try {
      return new TextEncoder().encode(JSON.stringify(value));
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function isBufferLikeObject(value: unknown): value is { type: 'Buffer'; data: number[] } {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as { type?: unknown; data?: unknown };
  return candidate.type === 'Buffer' && Array.isArray(candidate.data) && candidate.data.every((item) => typeof item === 'number');
}

function isNumberIndexedObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function describeDataPart(
  role: vscode.LanguageModelChatMessageRole,
  messageIndex: number,
  partIndex: number,
  rawPart: unknown,
  normalizedPart: DataPartLike,
): string {
  const candidate = rawPart as { data?: unknown; value?: unknown; mimeType?: unknown };
  const rawData = candidate.data ?? candidate.value;
  return [
    `role=${String(role)}`,
    `message=${messageIndex}`,
    `part=${partIndex}`,
    `mime=${normalizedPart.mimeType}`,
    `rawKind=${describeValueKind(rawData)}`,
    `bytes=${normalizedPart.data.byteLength}`,
  ].join(' ');
}

function describeValueKind(value: unknown): string {
  if (value instanceof Uint8Array) {
    return 'Uint8Array';
  }

  if (value instanceof ArrayBuffer) {
    return 'ArrayBuffer';
  }

  if (ArrayBuffer.isView(value)) {
    return value.constructor.name;
  }

  if (Array.isArray(value)) {
    return 'number[]';
  }

  if (isBufferLikeObject(value)) {
    return 'BufferLikeObject';
  }

  if (value && typeof value === 'object') {
    return `object:${Object.keys(value).slice(0, 4).join(',')}`;
  }

  return typeof value;
}

function isProbeHiddenState(value: unknown): value is ProbeHiddenState {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<ProbeHiddenState>;
  return (
    candidate.kind === 'probe-hidden-state' &&
    candidate.schemaVersion === 1 &&
    typeof candidate.probeId === 'string' &&
    typeof candidate.turnNumber === 'number' &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.lastUserText === 'string'
  );
}

function isReasoningHiddenState(value: unknown): value is ReasoningHiddenState {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<ReasoningHiddenState>;
  return (
    candidate.kind === 'backend-reasoning-state' &&
    candidate.schemaVersion === 1 &&
    typeof candidate.modelId === 'string' &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.reasoningContent === 'string' &&
    (candidate.responsesReasoningItems === undefined || Array.isArray(candidate.responsesReasoningItems))
  );
}

function normalizeResponsesReasoningStateItems(value: unknown): ResponsesReasoningStateItem[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value
    .map((item) => normalizeResponsesReasoningStateItem(item))
    .filter((item): item is ResponsesReasoningStateItem => Boolean(item));

  return items.length > 0 ? items : undefined;
}

function normalizeResponsesReasoningStateItem(value: unknown): ResponsesReasoningStateItem | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const candidate = value as {
    type?: unknown;
    id?: unknown;
    encrypted_content?: unknown;
    summary?: unknown;
    content?: unknown;
  };
  if (candidate.type !== 'reasoning') {
    return undefined;
  }

  const normalized: ResponsesReasoningStateItem = { type: 'reasoning' };
  if (typeof candidate.id === 'string' && candidate.id.trim()) {
    normalized.id = candidate.id.trim();
  }
  if (typeof candidate.encrypted_content === 'string' && candidate.encrypted_content.trim()) {
    normalized.encrypted_content = candidate.encrypted_content;
  }
  if (Array.isArray(candidate.summary)) {
    normalized.summary = candidate.summary;
  }
  if (Array.isArray(candidate.content)) {
    normalized.content = candidate.content;
  }

  return normalized.encrypted_content || normalized.id || normalized.summary?.length || normalized.content?.length
    ? normalized
    : undefined;
}

function isBridgeHiddenState(value: unknown): value is BridgeHiddenState {
  return isProbeHiddenState(value) || isReasoningHiddenState(value);
}
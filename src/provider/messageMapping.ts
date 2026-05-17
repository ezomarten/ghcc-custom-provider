import { Buffer } from 'node:buffer';

import * as vscode from 'vscode';

import {
  ReasoningHiddenState,
  extractLatestReasoningHiddenStateFromMessages,
  extractLatestReasoningHiddenStateFromParts,
  isHiddenStateMimeType,
} from './hiddenState';
import {
  LMStudioChatInputPart,
  OpenAIChatCompletionRequest,
  OpenAIInputContentPart,
  OpenAIWireAssistantMessage,
  OpenAIWireMessage,
  OpenAIWireToolCall,
  OpenAIWireToolDefinition,
  ResponsesInputContentPart,
  ResponsesInputItem,
  ResponsesRequest,
  ResponsesWireToolDefinition,
} from './upstreamClient';

const dataPartTextDecoder = new TextDecoder();

export interface MessageMappingResult {
  messages: OpenAIWireMessage[];
  latestBackendState?: ReasoningHiddenState;
  replayedReasoningLength: number;
  usedFallbackAssistantAttachment: boolean;
}

export interface LmStudioMessageMappingResult {
  input: string | LMStudioChatInputPart[];
  latestBackendState?: ReasoningHiddenState;
}

export interface ResponsesMessageMappingResult {
  input: ResponsesInputItem[];
  latestBackendState?: ReasoningHiddenState;
  mappedItemCount: number;
}

export function mapRequestMessagesToOpenAI(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  hiddenStateMimeType: string,
): MessageMappingResult {
  const converted: OpenAIWireMessage[] = [];
  const latestBackendState = extractLatestReasoningHiddenStateFromMessages(messages, hiddenStateMimeType);
  let usedFallbackAssistantAttachment = false;

  for (const message of messages) {
    if (message.role === vscode.LanguageModelChatMessageRole.User) {
      converted.push(...mapUserMessage(message, hiddenStateMimeType));
      continue;
    }

    if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
      const assistantMessage = mapAssistantMessage(message, hiddenStateMimeType);
      if (assistantMessage) {
        converted.push(assistantMessage);
      }
    }
  }

  if (latestBackendState?.reasoningContent.trim()) {
    let attached = false;

    for (let index = converted.length - 1; index >= 0; index -= 1) {
      const message = converted[index];
      if (message.role !== 'assistant') {
        continue;
      }

      if (!message.reasoning_content?.trim()) {
        message.reasoning_content = latestBackendState.reasoningContent;
        usedFallbackAssistantAttachment = true;
      }

      attached = true;
      break;
    }

    if (!attached) {
      converted.push({
        role: 'assistant',
        content: null,
        reasoning_content: latestBackendState.reasoningContent,
      });
      usedFallbackAssistantAttachment = true;
    }
  }

  return {
    messages: converted,
    latestBackendState,
    replayedReasoningLength: findLatestAssistantReasoningLength(converted),
    usedFallbackAssistantAttachment,
  };
}

export function mapRequestMessagesToLmStudio(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  hiddenStateMimeType: string,
): LmStudioMessageMappingResult {
  const latestUserMessage = findLatestUserMessage(messages);
  const latestBackendState = extractLatestReasoningHiddenStateFromMessages(messages, hiddenStateMimeType);

  if (!latestUserMessage) {
    return {
      input: '',
      latestBackendState,
    };
  }

  return {
    input: mapUserMessageToLmStudioInput(latestUserMessage, hiddenStateMimeType),
    latestBackendState,
  };
}

export function mapTools(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): OpenAIWireToolDefinition[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

export function mapToolMode(
  toolMode: vscode.LanguageModelChatToolMode,
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): OpenAIChatCompletionRequest['tool_choice'] {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto';
}

export function mapUpstreamToolCallsToResponseParts(toolCalls: OpenAIWireToolCall[]): vscode.LanguageModelToolCallPart[] {
  return toolCalls.map((toolCall, index) => new vscode.LanguageModelToolCallPart(
    toolCall.id || `tool-call-${index + 1}`,
    toolCall.function.name,
    toolCall.function.arguments,
  ));
}

function mapUserMessage(
  message: vscode.LanguageModelChatRequestMessage,
  hiddenStateMimeType: string,
): OpenAIWireMessage[] {
  const converted: OpenAIWireMessage[] = [];
  const visibleContentParts: OpenAIInputContentPart[] = [];

  for (const part of message.content) {
    if (isTextPart(part)) {
      visibleContentParts.push({ type: 'text', text: part.value });
      continue;
    }

    if (isToolResultPart(part)) {
      if (visibleContentParts.length > 0) {
        converted.push({
          role: 'user',
          content: normalizeUserContent(visibleContentParts),
        });
        visibleContentParts.length = 0;
      }

      converted.push({
        role: 'tool',
        tool_call_id: part.callId,
        content: serializeToolResultContent(part.content),
      });
      continue;
    }

    if (isDataPart(part)) {
      if (isHiddenStateMimeType(part, hiddenStateMimeType) || part.mimeType === 'cache_control') {
        continue;
      }

      if (part.mimeType.startsWith('image/')) {
        visibleContentParts.push({
          type: 'image_url',
          image_url: {
            url: dataPartToDataUrl(part),
          },
        });
        continue;
      }

      const textValue = decodeDataPartText(part);
      if (textValue) {
        visibleContentParts.push({ type: 'text', text: textValue });
      }
    }
  }

  if (visibleContentParts.length > 0) {
    converted.push({
      role: 'user',
      content: normalizeUserContent(visibleContentParts),
    });
  }

  return converted;
}

function mapAssistantMessage(
  message: vscode.LanguageModelChatRequestMessage,
  hiddenStateMimeType: string,
): OpenAIWireAssistantMessage | undefined {
  const contentParts: string[] = [];
  const toolCalls: NonNullable<OpenAIWireAssistantMessage['tool_calls']> = [];
  const reasoningState = extractLatestReasoningHiddenStateFromParts(message.content, hiddenStateMimeType);

  for (const part of message.content) {
    if (isTextPart(part)) {
      contentParts.push(part.value);
      continue;
    }

    if (isToolCallPart(part)) {
      toolCalls.push({
        id: part.callId,
        type: 'function',
        function: {
          name: part.name,
          arguments: JSON.stringify(part.input ?? {}),
        },
      });
    }
  }

  const content = contentParts.join('\n').trim();
  if (!content && toolCalls.length === 0 && !reasoningState?.reasoningContent) {
    return undefined;
  }

  return {
    role: 'assistant',
    content: content || null,
    reasoning_content: reasoningState?.reasoningContent,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

function mapUserMessageToLmStudioInput(
  message: vscode.LanguageModelChatRequestMessage,
  hiddenStateMimeType: string,
): string | LMStudioChatInputPart[] {
  const converted: LMStudioChatInputPart[] = [];

  for (const part of message.content) {
    if (isTextPart(part)) {
      converted.push({
        type: 'text',
        content: part.value,
      });
      continue;
    }

    if (isToolResultPart(part)) {
      continue;
    }

    if (isDataPart(part)) {
      if (isHiddenStateMimeType(part, hiddenStateMimeType) || part.mimeType === 'cache_control') {
        continue;
      }

      if (part.mimeType.startsWith('image/')) {
        converted.push({
          type: 'image',
          data_url: dataPartToDataUrl(part),
        });
        continue;
      }

      const textValue = decodeDataPartText(part);
      if (textValue) {
        converted.push({
          type: 'text',
          content: textValue,
        });
      }
    }
  }

  if (converted.length === 1 && converted[0].type === 'text') {
    return converted[0].content;
  }

  return converted;
}

function mapUserMessageToResponsesInput(
  message: vscode.LanguageModelChatRequestMessage,
  hiddenStateMimeType: string,
): ResponsesInputItem[] {
  const converted: ResponsesInputItem[] = [];
  const visibleContentParts: ResponsesInputContentPart[] = [];

  for (const part of message.content) {
    if (isTextPart(part)) {
      visibleContentParts.push({ type: 'input_text', text: part.value });
      continue;
    }

    if (isToolResultPart(part)) {
      if (visibleContentParts.length > 0) {
        converted.push({
          role: 'user',
          content: normalizeResponsesUserContent(visibleContentParts),
        });
        visibleContentParts.length = 0;
      }

      converted.push({
        type: 'function_call_output',
        call_id: part.callId,
        output: serializeToolResultContent(part.content),
      });
      continue;
    }

    if (isDataPart(part)) {
      if (isHiddenStateMimeType(part, hiddenStateMimeType) || part.mimeType === 'cache_control') {
        continue;
      }

      if (part.mimeType.startsWith('image/')) {
        visibleContentParts.push({
          type: 'input_image',
          image_url: dataPartToDataUrl(part),
        });
        continue;
      }

      const textValue = decodeDataPartText(part);
      if (textValue) {
        visibleContentParts.push({ type: 'input_text', text: textValue });
      }
    }
  }

  if (visibleContentParts.length > 0) {
    converted.push({
      role: 'user',
      content: normalizeResponsesUserContent(visibleContentParts),
    });
  }

  return converted;
}

function mapAssistantMessageToResponsesInput(
  message: vscode.LanguageModelChatRequestMessage,
): ResponsesInputItem[] {
  const converted: ResponsesInputItem[] = [];
  const contentParts: string[] = [];

  for (const part of message.content) {
    if (isTextPart(part)) {
      contentParts.push(part.value);
      continue;
    }

    if (isToolCallPart(part)) {
      converted.push({
        type: 'function_call',
        call_id: part.callId,
        name: part.name,
        arguments: JSON.stringify(part.input ?? {}),
      });
    }
  }

  const content = contentParts.join('\n').trim();
  if (content) {
    converted.unshift({
      role: 'assistant',
      content,
    });
  }

  return converted;
}

function findLatestUserMessage(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): vscode.LanguageModelChatRequestMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === vscode.LanguageModelChatMessageRole.User) {
      return message;
    }
  }

  return undefined;
}

function findLatestAssistantReasoningLength(messages: readonly OpenAIWireMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') {
      continue;
    }

    const reasoningContent = typeof message.reasoning_content === 'string' ? message.reasoning_content.trim() : '';
    if (reasoningContent) {
      return reasoningContent.length;
    }
  }

  return 0;
}

function normalizeUserContent(parts: OpenAIInputContentPart[]): string | OpenAIInputContentPart[] {
  if (parts.length === 1 && parts[0].type === 'text') {
    return parts[0].text;
  }

  return parts;
}

function normalizeResponsesUserContent(parts: ResponsesInputContentPart[]): string | ResponsesInputContentPart[] {
  if (parts.length === 1 && parts[0].type === 'input_text') {
    return parts[0].text;
  }

  return parts;
}

function serializeToolResultContent(content: readonly unknown[]): string {
  const values = content
    .map((part) => {
      if (isTextPart(part)) {
        return part.value;
      }

      if (isDataPart(part)) {
        if (part.mimeType.startsWith('image/')) {
          return `[binary ${part.mimeType} data omitted]`;
        }

        return decodeDataPartText(part);
      }

      if (typeof part === 'string') {
        return part;
      }

      try {
        return JSON.stringify(part);
      } catch {
        return String(part);
      }
    })
    .filter((value): value is string => typeof value === 'string' && value.length > 0);

  return values.join('\n').trim() || 'Tool completed with no textual result.';
}

function decodeDataPartText(part: { data: Uint8Array; mimeType: string }): string {
  if (part.mimeType.includes('json')) {
    try {
      return JSON.stringify(JSON.parse(dataPartTextDecoder.decode(part.data)));
    } catch {
      return dataPartTextDecoder.decode(part.data);
    }
  }

  return dataPartTextDecoder.decode(part.data);
}

function dataPartToDataUrl(part: { data: Uint8Array; mimeType: string }): string {
  const base64 = Buffer.from(part.data).toString('base64');
  return `data:${part.mimeType};base64,${base64}`;
}

function isTextPart(part: unknown): part is { value: string } {
  return Boolean(part && typeof part === 'object' && typeof (part as { value?: unknown }).value === 'string');
}

function isDataPart(part: unknown): part is { data: Uint8Array; mimeType: string } {
  if (!part || typeof part !== 'object') {
    return false;
  }

  const candidate = part as { data?: unknown; mimeType?: unknown };
  return candidate.data instanceof Uint8Array && typeof candidate.mimeType === 'string';
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

export function mapRequestMessagesToResponses(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  hiddenStateMimeType: string,
): ResponsesMessageMappingResult {
  const input: ResponsesInputItem[] = [];
  const latestBackendState = extractLatestReasoningHiddenStateFromMessages(messages, hiddenStateMimeType);

  for (const message of messages) {
    if (message.role === vscode.LanguageModelChatMessageRole.User) {
      input.push(...mapUserMessageToResponsesInput(message, hiddenStateMimeType));
      continue;
    }

    if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
      input.push(...mapAssistantMessageToResponsesInput(message));
    }
  }

  return {
    input,
    latestBackendState,
    mappedItemCount: input.length,
  };
}

export function mapResponsesTools(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): ResponsesWireToolDefinition[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }));
}

export function mapResponsesToolMode(
  toolMode: vscode.LanguageModelChatToolMode,
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): ResponsesRequest['tool_choice'] {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto';
}
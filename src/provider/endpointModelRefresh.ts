import * as vscode from 'vscode';

import { BackendEndpointType } from '../config/settings';
import { BridgeSettingsStore } from '../config/storage';
import { EndpointConnectionStatus, EndpointConnectionStatusSource, EndpointConnectionStatusStore } from './endpointConnectionStatus';
import { EndpointModelCacheStore } from './endpointModelCache';
import { fetchBackendChatModels } from './modelCatalog';
import { sanitizeUpstreamDiagnosticText } from './upstreamClient';

export interface EndpointModelRefreshRequest {
  readonly endpointId: string;
  readonly endpointName: string;
  readonly endpointType: BackendEndpointType;
  readonly baseUrl: string;
}

interface EndpointModelRefreshOptions {
  readonly preserveExistingCacheOnError?: boolean;
  readonly shouldApplyResult?: (apiKey: string | undefined) => Promise<boolean>;
}

export async function refreshEndpointModelCache(
  request: EndpointModelRefreshRequest,
  source: EndpointConnectionStatusSource,
  settingsStore: BridgeSettingsStore,
  outputChannel: vscode.LogOutputChannel,
  connectionStatusStore: EndpointConnectionStatusStore,
  modelCacheStore: EndpointModelCacheStore,
  options: EndpointModelRefreshOptions = {},
): Promise<void> {
  const previousStatus = source === 'automatic'
    ? connectionStatusStore.get(request.endpointId)
    : undefined;
  const existingCache = modelCacheStore.get(request.endpointId, request.endpointType, request.baseUrl);
  let requestedApiKey: string | undefined;

  connectionStatusStore.markRunning(request.endpointId, source);

  try {
    if (!request.baseUrl.trim()) {
      throw new Error('Base URL is required before running a connection test.');
    }

    requestedApiKey = await settingsStore.getApiKey(request.endpointId);
    const cancellationSource = new vscode.CancellationTokenSource();
    let chatModels;
    try {
      chatModels = await fetchBackendChatModels({
        endpointType: request.endpointType,
        baseUrl: request.baseUrl,
        apiKey: requestedApiKey,
      }, outputChannel, cancellationSource.token);
    } finally {
      cancellationSource.dispose();
    }

    if (options.shouldApplyResult && !(await options.shouldApplyResult(requestedApiKey))) {
      connectionStatusStore.replace(request.endpointId, previousStatus ?? null);
      return;
    }

    await modelCacheStore.setSuccess(request.endpointId, request.endpointType, request.baseUrl, chatModels);
    connectionStatusStore.markSuccess(request.endpointId, source, chatModels.length);
    outputChannel.info(
      `${buildRefreshLabel(source)} succeeded for ${request.endpointName}. Found ${chatModels.length} chat model(s).`,
    );
  } catch (error) {
    const detail = sanitizeUpstreamDiagnosticText(error instanceof Error ? error.message : String(error));

    if (options.shouldApplyResult && !(await options.shouldApplyResult(requestedApiKey))) {
      connectionStatusStore.replace(request.endpointId, previousStatus ?? null);
      return;
    }

    if (!(options.preserveExistingCacheOnError && existingCache?.kind === 'success')) {
      await modelCacheStore.setError(request.endpointId, request.endpointType, request.baseUrl, detail);
    }

    connectionStatusStore.markError(request.endpointId, source, detail);
    outputChannel.warn(`${buildRefreshLabel(source)} failed for ${request.endpointName}: ${detail}`);
  }
}

function buildRefreshLabel(source: EndpointConnectionStatusSource): string {
  return source === 'automatic' ? 'Automatic model refresh' : 'Connection test';
}

import * as vscode from 'vscode';

import { registerManagementCommands } from './commands/manageProvider';
import { BridgeSettingsStore } from './config/storage';
import { BridgeStoredSettings, PROVIDER_VENDOR, getActiveEndpoints, getEndpointById, getRuntimeEndpointBaseUrl } from './config/settings';
import { BridgeChatProvider } from './provider/chatProvider';
import { EndpointConnectionStatusStore } from './provider/endpointConnectionStatus';
import { EndpointModelCacheStore } from './provider/endpointModelCache';
import { EndpointModelRefreshRequest, refreshEndpointModelCache } from './provider/endpointModelRefresh';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('GHCC Custom Provider', { log: true });
  context.subscriptions.push(outputChannel);

  outputChannel.info(
    `Activating GHCC Custom Provider. extensionKind=${formatExtensionKind(context.extension.extensionKind)}, remoteName=${vscode.env.remoteName ?? 'none'}, uiKind=${formatUiKind(vscode.env.uiKind)}, extensionMode=${formatExtensionMode(context.extensionMode)}`,
  );

  const settingsStore = new BridgeSettingsStore(context, outputChannel);
  await settingsStore.initialize();
  const connectionStatusStore = new EndpointConnectionStatusStore(context);
  await connectionStatusStore.initialize();
  const modelCacheStore = new EndpointModelCacheStore(context);
  await modelCacheStore.initialize();

  const refreshActiveEndpointModels = (settings: BridgeStoredSettings, endpointIds?: readonly string[]): void => {
    const requests = buildActiveEndpointRefreshRequests(settings, endpointIds);
    for (const request of requests) {
      void refreshEndpointModelCache(
        request,
        'automatic',
        settingsStore,
        outputChannel,
        connectionStatusStore,
        modelCacheStore,
        {
          preserveExistingCacheOnError: true,
          shouldApplyResult: async (apiKey) => isCurrentActiveEndpointConnection(settingsStore, request, apiKey),
        },
      );
    }
  };

  const provider = new BridgeChatProvider(context, outputChannel, settingsStore, modelCacheStore);
  await provider.initialize();
  context.subscriptions.push(settingsStore.onDidChange((event) => {
    for (const endpointId of event.connectionStatusResetEndpointIds) {
      connectionStatusStore.clear(endpointId);
      void modelCacheStore.clear(endpointId);
    }

    if (event.languageModelRefreshKind === 'connection') {
      refreshActiveEndpointModels(event.settings, event.modelRefreshEndpointIds);
    }
  }));
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(PROVIDER_VENDOR, provider));

  registerManagementCommands(context, outputChannel, settingsStore, connectionStatusStore, modelCacheStore);
  refreshActiveEndpointModels(await settingsStore.getSettings());

  outputChannel.info('GHCC Custom Provider activated and provider registered.');
}

export function deactivate(): void {}

function buildActiveEndpointRefreshRequests(
  settings: BridgeStoredSettings,
  endpointIds?: readonly string[],
): EndpointModelRefreshRequest[] {
  const targetEndpointIds = endpointIds ? new Set(endpointIds) : undefined;
  return getActiveEndpoints(settings)
    .filter((endpoint) => !targetEndpointIds || targetEndpointIds.has(endpoint.id))
    .filter((endpoint) => endpoint.id.trim() && endpoint.baseUrl.trim())
    .map((endpoint) => ({
      endpointId: endpoint.id,
      endpointName: endpoint.name || endpoint.baseUrl || endpoint.id,
      endpointType: endpoint.endpointType,
      baseUrl: getRuntimeEndpointBaseUrl(endpoint),
    }));
}

async function isCurrentActiveEndpointConnection(
  settingsStore: BridgeSettingsStore,
  request: EndpointModelRefreshRequest,
  apiKey: string | undefined,
): Promise<boolean> {
  const settings = await settingsStore.getSettings();
  const activeEndpoint = getEndpointById(settings, request.endpointId);
  if (!activeEndpoint || !getActiveEndpoints(settings).some((endpoint) => endpoint.id === request.endpointId)) {
    return false;
  }

  if (activeEndpoint.endpointType !== request.endpointType) {
    return false;
  }

  if (normalizeBaseUrl(getRuntimeEndpointBaseUrl(activeEndpoint)) !== normalizeBaseUrl(request.baseUrl)) {
    return false;
  }

  const currentApiKey = await settingsStore.getApiKey(request.endpointId);
  return (currentApiKey ?? '') === (apiKey ?? '');
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function formatExtensionKind(kind: vscode.ExtensionKind): string {
  return kind === vscode.ExtensionKind.Workspace ? 'workspace' : 'ui';
}

function formatUiKind(kind: vscode.UIKind): string {
  return kind === vscode.UIKind.Web ? 'web' : 'desktop';
}

function formatExtensionMode(mode: vscode.ExtensionMode): string {
  switch (mode) {
    case vscode.ExtensionMode.Development:
      return 'development';
    case vscode.ExtensionMode.Test:
      return 'test';
    default:
      return 'production';
  }
}

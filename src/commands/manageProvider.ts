import { randomBytes } from 'node:crypto';

import * as vscode from 'vscode';

import {
  BackendEndpointType,
  CLEAR_API_KEY_COMMAND,
  HIDDEN_STATE_MIME,
  MANAGEMENT_COMMAND,
  OPEN_EXTENSION_SETTINGS_COMMAND,
  OPEN_RAW_SETTINGS_COMMAND,
  SET_API_KEY_COMMAND,
  SHOW_LOGS_COMMAND,
  BridgeSettingsViewState,
  BridgeStoredSettings,
  getRuntimeEndpointBaseUrl,
  sanitizeStoredSettings,
} from '../config/settings';
import { BridgeSettingsStore } from '../config/storage';
import { EndpointConnectionStatusStore } from '../provider/endpointConnectionStatus';
import { EndpointModelCacheStore } from '../provider/endpointModelCache';
import { refreshEndpointModelCache } from '../provider/endpointModelRefresh';
import { ManagerLocale, ManagerText, getManagerText, resolveManagerLocale } from './manageProviderText';

const PANEL_VIEW_TYPE = 'ghccCustomProvider.manager';

export function registerManagementCommands(
  context: vscode.ExtensionContext,
  outputChannel: vscode.LogOutputChannel,
  settingsStore: BridgeSettingsStore,
  connectionStatusStore: EndpointConnectionStatusStore,
  modelCacheStore: EndpointModelCacheStore,
): void {
  let panel: vscode.WebviewPanel | undefined;

  const refreshPanel = async (): Promise<void> => {
    if (!panel) {
      return;
    }

    panel.webview.html = await renderPanelHtml(settingsStore, connectionStatusStore, panel.webview);
  };

  const postApiKeyStatusChange = (endpointId: string | undefined, hasStoredApiKey: boolean): void => {
    if (!panel || !endpointId) {
      return;
    }

    void panel.webview.postMessage({
      command: 'apiKeyStatusChanged',
      endpointId,
      hasStoredApiKey,
    });
  };

  const showManagementPanel = async (): Promise<void> => {
    if (panel) {
      await refreshPanel();
      panel.reveal(vscode.ViewColumn.One);
      return;
    }

    panel = vscode.window.createWebviewPanel(
      PANEL_VIEW_TYPE,
      'GHCC Custom Provider',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [],
      },
    );

    await refreshPanel();

    let messageListener: vscode.Disposable | undefined;
    panel.onDidDispose(() => {
      messageListener?.dispose();
      panel = undefined;
    });

    messageListener = panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!message || typeof message !== 'object') {
        return;
      }

      const command = asString((message as { command?: unknown }).command);
      if (!command) {
        return;
      }

      if (command === 'showLogs') {
        outputChannel.show(true);
        return;
      }

      if (command === 'openRawSettings') {
        await settingsStore.openRawSettings();
        return;
      }

      if (command === 'importSyncedSettings') {
        const confirmed = await confirmSyncedSettingsImport(settingsStore);
        if (!confirmed) {
          return;
        }

        try {
          await settingsStore.importSyncedSettings();
          void vscode.window.showInformationMessage('Imported synced GHCC Custom Provider settings. API keys remain local to this extension host.');
          await refreshPanel();
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          void vscode.window.showErrorMessage(errorMessage);
        }

        return;
      }

      if (command === 'exportEncryptedApiKeys') {
        const passphrase = await promptForEncryptionPassphrase(settingsStore, 'export');
        if (!passphrase) {
          return;
        }

        try {
          const count = await settingsStore.exportEncryptedApiKeys(passphrase);
          void vscode.window.showInformationMessage(`Exported ${count} encrypted GHCC Custom Provider API key(s) to synced storage.`);
          await refreshPanel();
        } catch (error) {
          void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }

        return;
      }

      if (command === 'importEncryptedApiKeys') {
        const passphrase = await promptForEncryptionPassphrase(settingsStore, 'import');
        if (!passphrase) {
          return;
        }

        try {
          const count = await settingsStore.importEncryptedApiKeys(passphrase);
          void vscode.window.showInformationMessage(`Imported ${count} GHCC Custom Provider API key(s) into this extension host's SecretStorage.`);
          await refreshPanel();
        } catch (error) {
          void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }

        return;
      }

      if (command === 'copyPrompt') {
        await vscode.env.clipboard.writeText(getSuggestedProbePrompt());
        void vscode.window.showInformationMessage('Probe prompt copied to the clipboard.');
        return;
      }

      if (command === 'showError') {
        const text = asString((message as { text?: unknown }).text);
        if (text) {
          void vscode.window.showErrorMessage(text);
        }
        return;
      }

      if (command === 'testEndpointConnection') {
        if ((message as { userInitiated?: unknown }).userInitiated !== true) {
          outputChannel.warn('Ignored connection test request without explicit user initiation.');
          return;
        }

        const request = sanitizeConnectionTestRequest(message);
        if (!request) {
          return;
        }

        await refreshEndpointModelCache(
          request,
          'manual',
          settingsStore,
          outputChannel,
          connectionStatusStore,
          modelCacheStore,
        );

        return;
      }

      if (command === 'requestRemoveEndpoint') {
        const endpointId = asString((message as { endpointId?: unknown }).endpointId);
        if (!endpointId) {
          return;
        }

        const endpointName = asString((message as { endpointName?: unknown }).endpointName);
        const isActive = (message as { isActive?: unknown }).isActive === true;
        const confirmed = await confirmEndpointRemoval(settingsStore, endpointId, endpointName, isActive);
        if (panel) {
          void panel.webview.postMessage({
            command: 'removeEndpointConfirmationResult',
            endpointId,
            confirmed,
          });
        }
        return;
      }

      if (command === 'saveSettings') {
        const requestId = (message as { requestId?: unknown }).requestId;
        const refreshAfterSave = (message as { refreshAfterSave?: unknown }).refreshAfterSave === true;
        try {
          const payload = sanitizeSettingsPayload((message as { settings?: unknown }).settings);
          const expectedStorageRevision = (message as { storageRevision?: unknown }).storageRevision;
          const saved = await settingsStore.saveSettings(
            payload,
            typeof expectedStorageRevision === 'string' ? expectedStorageRevision : null,
          );
          if (refreshAfterSave) {
            await refreshPanel();
          } else if (panel) {
            void panel.webview.postMessage({
              command: 'saveResult',
              requestId,
              ok: true,
              storageRevision: saved.revision,
            });
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : `Failed to save settings: ${String(error)}`;
          if (panel) {
            void panel.webview.postMessage({
              command: 'saveResult',
              requestId,
              ok: false,
              error: errorMessage,
            });
          } else {
            void vscode.window.showErrorMessage(errorMessage);
          }
        }
        return;
      }

      if (command === 'setApiKey') {
        const endpointId = asString((message as { endpointId?: unknown }).endpointId);
        const endpointName = asString((message as { endpointName?: unknown }).endpointName);
        const didUpdate = await settingsStore.promptForApiKey(endpointId, endpointName);
        if (didUpdate) {
          postApiKeyStatusChange(endpointId, true);
          void vscode.window.showInformationMessage('GHCC Custom Provider API key was stored in secret storage.');
        }
        return;
      }

      if (command === 'clearApiKey') {
        const endpointId = asString((message as { endpointId?: unknown }).endpointId);
        const endpointName = asString((message as { endpointName?: unknown }).endpointName);
        const didClear = await settingsStore.clearApiKey(endpointId, endpointName);
        if (didClear) {
          postApiKeyStatusChange(endpointId, false);
          void vscode.window.showInformationMessage('GHCC Custom Provider API key was cleared from secret storage.');
        }
      }
    });
  };

  context.subscriptions.push(
    connectionStatusStore.onDidChange((event) => {
      if (!panel) {
        return;
      }

      void panel.webview.postMessage({
        command: 'endpointConnectionStatusChanged',
        endpointId: event.endpointId,
        status: event.status,
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(MANAGEMENT_COMMAND, showManagementPanel),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_EXTENSION_SETTINGS_COMMAND, showManagementPanel),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(SHOW_LOGS_COMMAND, () => {
      outputChannel.show(true);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_RAW_SETTINGS_COMMAND, async () => {
      await settingsStore.openRawSettings();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(SET_API_KEY_COMMAND, async () => {
      const didUpdate = await settingsStore.promptForApiKey();
      if (didUpdate) {
        await refreshPanel();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CLEAR_API_KEY_COMMAND, async () => {
      const didClear = await settingsStore.clearApiKey();
      if (didClear) {
        await refreshPanel();
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      if (!panel || !(await settingsStore.isStorageDocument(document))) {
        return;
      }

      await refreshPanel();
    }),
  );
}

async function renderPanelHtml(
  settingsStore: BridgeSettingsStore,
  connectionStatusStore: EndpointConnectionStatusStore,
  webview: vscode.Webview,
): Promise<string> {
  const viewState = await settingsStore.getViewState();
  const locale = resolveManagerLocale(viewState.settings.manager.language, vscode.env.language);
  const text = getManagerText(locale);
  const webviewState = buildWebviewState(viewState, connectionStatusStore, locale, text);
  const nonce = createNonce();

  return `<!DOCTYPE html>
<html lang="${text.htmlLang}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; font-src ${webview.cspSource}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
    <title>${escapeHtmlText(text.pageTitle)}</title>
    <style nonce="${nonce}">${getManagerStyles()}</style>
  </head>
  <body>
    <div class="shell">
      <aside class="sidebar">
        <div class="sidebar-header">
          <p class="eyebrow">${text.sidebar.eyebrow}</p>
          <h1>${text.pageTitle}</h1>
          <p>${text.sidebar.description}</p>
        </div>
        <div class="toolbar">
          <button class="button" id="addEndpointButton" type="button">${text.toolbar.addEndpoint}</button>
          <button class="button-ghost" id="duplicateEndpointButton" type="button">${text.toolbar.duplicate}</button>
          <button class="button-ghost" id="setActiveEndpointButton" type="button">${text.toolbar.setActive}</button>
          <button class="button-danger" id="removeEndpointButton" type="button">${text.toolbar.removeSelected}</button>
        </div>
        <div class="sidebar-mode">
          <button class="sidebar-mode-button" id="commonSettingsButton" type="button">${text.sections.common.buttonLabel}</button>
        </div>
        <div class="profile-list" id="endpointList"></div>
      </aside>

      <main class="editor">
        <div class="save-banner">
          <div class="banner-meta">
            <span class="status-pill" id="saveStatus"></span>
            <span class="banner-note" id="saveStatusDetail"></span>
          </div>
        </div>

        <section class="editor-section" id="endpointEditorSection">
          <div class="section-grid">
          <article class="card">
            <h2>${text.endpoint.heading}</h2>
            <dl>
              <dt>${text.endpoint.name}</dt>
              <dd><input id="endpointName" type="text" placeholder="${escapeHtmlAttribute(text.endpoint.namePlaceholder)}" /></dd>
              <dt>${text.endpoint.type}</dt>
              <dd>
                <select id="endpointType">
                  <option value="openai-compatible">${text.endpoint.openAiCompatible}</option>
                  <option value="responses-api">${text.endpoint.responsesApi}</option>
                  <option value="lm-studio">${text.endpoint.lmStudio}</option>
                  <option value="lm-studio-responses">${text.endpoint.lmStudioResponses}</option>
                  <option value="lm-studio-rest">${text.endpoint.lmStudioNative}</option>
                </select>
                <div class="hint">${text.endpoint.typeHint}</div>
                <div class="hint type-description" id="endpointTypeDescription"></div>
              </dd>
              <dt>${text.endpoint.baseUrl}</dt>
              <dd><input id="baseUrl" type="text" placeholder="${escapeHtmlAttribute(text.endpoint.baseUrlPlaceholder)}" /></dd>
              <dt>${text.endpoint.localhostRewrite}</dt>
              <dd>
                <select id="localhostRewrite">
                  <option value="auto">${text.capabilities.auto}</option>
                  <option value="on">${text.capabilities.on}</option>
                  <option value="off">${text.capabilities.off}</option>
                </select>
                <div class="hint">${text.endpoint.localhostRewriteHint}</div>
              </dd>
              <dt>${text.endpoint.defaultModel}</dt>
              <dd><input id="defaultModel" type="text" placeholder="${escapeHtmlAttribute(text.endpoint.defaultModelPlaceholder)}" /></dd>
              <dt>${text.endpoint.apiKeySource}</dt>
              <dd>
                <select id="apiKeySource">
                  <option value="secret-storage">${text.endpoint.apiKeySourceSecretStorage}</option>
                  <option value="environment">${text.endpoint.apiKeySourceEnvironment}</option>
                </select>
                <div class="hint" id="apiKeySourceHint"></div>
              </dd>
              <dt id="apiKeyEnvironmentVariableTerm">${text.endpoint.apiKeyEnvironmentVariable}</dt>
              <dd id="apiKeyEnvironmentVariableField"><input id="apiKeyEnvironmentVariable" type="text" placeholder="${escapeHtmlAttribute(text.endpoint.apiKeyEnvironmentVariablePlaceholder)}" /></dd>
              <dt id="apiKeySecretTerm">${text.endpoint.apiKey}</dt>
              <dd>
                <div class="inline-actions">
                  <button class="mini-button" id="apiKeyActionButton" type="button">${text.dynamic.setApiKey}</button>
                  <span class="status-pill" id="apiKeyStatus"></span>
                </div>
              </dd>
            </dl>
          </article>

          <article class="card">
            <h2>${text.connection.heading}</h2>
            <div class="inline-actions">
              <button class="mini-button" id="testConnectionButton" type="button">${text.connection.test}</button>
              <span class="status-pill" id="connectionStatusBadge"></span>
            </div>
            <div class="hint" id="connectionStatusSummary"></div>
            <div class="hint warning" id="connectionStatusDetail"></div>
          </article>

          <article class="card">
            <h2>${text.capabilities.heading}</h2>
            <dl>
              <dt>${text.capabilities.toolForwarding}</dt>
              <dd>
                <select id="toolExposure">
                  <option value="auto">${text.capabilities.auto}</option>
                  <option value="on">${text.capabilities.on}</option>
                  <option value="off">${text.capabilities.off}</option>
                </select>
                <div class="hint">${text.capabilities.toolForwardingHint}</div>
              </dd>
              <dt>${text.capabilities.advertisedToolLimit}</dt>
              <dd>
                <input id="advertisedToolLimit" type="number" min="1" step="1" placeholder="${escapeHtmlAttribute(text.capabilities.advertisedToolLimitPlaceholder)}" />
                <div class="hint">${text.capabilities.advertisedToolLimitHint}</div>
              </dd>
            </dl>
          </article>

          <article class="card card-wide">
            <h2>${text.requestOverrides.heading}</h2>
            <dl>
              <dt>${text.requestOverrides.reasoningEffort}</dt>
              <dd>
                <input id="reasoningEffort" type="text" placeholder="${escapeHtmlAttribute(text.requestOverrides.reasoningEffortPlaceholder)}" />
                <div class="hint">${text.requestOverrides.reasoningEffortHint}</div>
              </dd>
              <dt id="lmStudioReasoningTerm">${text.requestOverrides.lmStudioReasoning}</dt>
              <dd id="lmStudioReasoningField">
                <select id="lmStudioReasoning">
                  <option value="auto">${text.requestOverrides.auto}</option>
                  <option value="off">${text.requestOverrides.off}</option>
                  <option value="low">${text.requestOverrides.low}</option>
                  <option value="medium">${text.requestOverrides.medium}</option>
                  <option value="high">${text.requestOverrides.high}</option>
                  <option value="on">${text.requestOverrides.on}</option>
                </select>
                <div class="hint">${text.requestOverrides.lmStudioReasoningHint}</div>
              </dd>
              <dt>${text.requestOverrides.enableThinking}</dt>
              <dd>
                <select id="enableThinking">
                  <option value="auto">${text.requestOverrides.auto}</option>
                  <option value="on">${text.requestOverrides.on}</option>
                  <option value="off">${text.requestOverrides.off}</option>
                </select>
              </dd>
              <dt>${text.requestOverrides.preserveThinking}</dt>
              <dd>
                <select id="preserveThinking">
                  <option value="auto">${text.requestOverrides.auto}</option>
                  <option value="on">${text.requestOverrides.on}</option>
                  <option value="off">${text.requestOverrides.off}</option>
                </select>
                <div class="hint">${text.requestOverrides.preserveThinkingHint}</div>
              </dd>
              <dt>${text.requestOverrides.responsesStore}</dt>
              <dd>
                <select id="responsesStore">
                  <option value="auto">${text.requestOverrides.auto}</option>
                  <option value="on">${text.requestOverrides.on}</option>
                  <option value="off">${text.requestOverrides.off}</option>
                </select>
                <div class="hint">${text.requestOverrides.responsesStoreHint}</div>
              </dd>
              <dt>${text.requestOverrides.preservedThinkingMaxChars}</dt>
              <dd>
                <input id="preservedThinkingMaxChars" type="number" min="-1" step="1" placeholder="${escapeHtmlAttribute(text.requestOverrides.preservedThinkingMaxCharsPlaceholder)}" />
                <div class="hint">${text.requestOverrides.preservedThinkingMaxCharsHint}</div>
              </dd>
              <dt>${text.requestOverrides.syntheticReasoningReplayMaxChars}</dt>
              <dd>
                <input id="syntheticReasoningReplayMaxChars" type="number" min="-1" step="1" placeholder="${escapeHtmlAttribute(text.requestOverrides.syntheticReasoningReplayMaxCharsPlaceholder)}" />
                <div class="hint">${text.requestOverrides.syntheticReasoningReplayMaxCharsHint}</div>
              </dd>
              <dt>${text.requestOverrides.contextLength}</dt>
              <dd><input id="contextLength" type="number" min="1" step="1" placeholder="${escapeHtmlAttribute(text.requestOverrides.contextLengthPlaceholder)}" /></dd>
              <dt>${text.requestOverrides.maxTokens}</dt>
              <dd><input id="maxTokens" type="number" min="1" step="1" placeholder="${escapeHtmlAttribute(text.requestOverrides.maxTokensPlaceholder)}" /></dd>
              <dt>${text.requestOverrides.temperature}</dt>
              <dd><input id="temperature" type="number" step="0.01" placeholder="${escapeHtmlAttribute(text.requestOverrides.temperaturePlaceholder)}" /></dd>
              <dt>${text.requestOverrides.topP}</dt>
              <dd><input id="topP" type="number" step="0.01" placeholder="${escapeHtmlAttribute(text.requestOverrides.topPPlaceholder)}" /></dd>
              <dt>${text.requestOverrides.topK}</dt>
              <dd><input id="topK" type="number" min="1" step="1" placeholder="${escapeHtmlAttribute(text.requestOverrides.topKPlaceholder)}" /></dd>
              <dt>${text.requestOverrides.minP}</dt>
              <dd><input id="minP" type="number" step="0.01" placeholder="${escapeHtmlAttribute(text.requestOverrides.minPPlaceholder)}" /></dd>
              <dt>${text.requestOverrides.presencePenalty}</dt>
              <dd><input id="presencePenalty" type="number" step="0.01" placeholder="${escapeHtmlAttribute(text.requestOverrides.presencePenaltyPlaceholder)}" /></dd>
              <dt>${text.requestOverrides.repeatPenalty}</dt>
              <dd><input id="repeatPenalty" type="number" step="0.01" placeholder="${escapeHtmlAttribute(text.requestOverrides.repeatPenaltyPlaceholder)}" /></dd>
              <dt>${text.requestOverrides.customJson}</dt>
              <dd class="compact">
                <textarea id="customBodyJson" spellcheck="false"></textarea>
                <div class="hint">${text.requestOverrides.customJsonHint}</div>
                <div class="hint warning">${text.requestOverrides.customJsonWarning}</div>
              </dd>
            </dl>
          </article>

          <article class="card card-wide">
            <h2>${text.modelOverrides.heading}</h2>
            <dl>
              <dt>${text.modelOverrides.defaultToolCalling}</dt>
              <dd>
                <select id="defaultModelToolCalling">
                  <option value="auto">${text.capabilities.auto}</option>
                  <option value="on">${text.capabilities.on}</option>
                  <option value="off">${text.capabilities.off}</option>
                </select>
              </dd>
              <dt>${text.modelOverrides.defaultImageInput}</dt>
              <dd>
                <select id="defaultModelImageInput">
                  <option value="auto">${text.capabilities.auto}</option>
                  <option value="on">${text.capabilities.on}</option>
                  <option value="off">${text.capabilities.off}</option>
                </select>
              </dd>
              <dt>${text.modelOverrides.defaultMaxInputTokens}</dt>
              <dd>
                <input id="defaultModelMaxInputTokens" type="number" min="1" step="1" placeholder="${escapeHtmlAttribute(text.modelOverrides.defaultMaxInputTokensPlaceholder)}" />
                <div class="hint">${text.modelOverrides.defaultHint}</div>
              </dd>
              <dt>${text.modelOverrides.customJson}</dt>
              <dd class="compact">
                <textarea id="modelOverridesJson" spellcheck="false"></textarea>
                <div class="hint">${text.modelOverrides.customJsonHint}</div>
                <div class="hint">${text.modelOverrides.hint}</div>
              </dd>
            </dl>
          </article>

          </div>
        </section>

        <section class="editor-section" id="commonEditorSection">
          <div class="section-grid">

          <article class="card">
            <h2>${text.display.heading}</h2>
            <dl>
              <dt>${text.display.language}</dt>
              <dd>
                <select id="managerLanguage">
                  <option value="auto">${text.display.auto}</option>
                  <option value="en">${text.display.english}</option>
                  <option value="ja">${text.display.japanese}</option>
                </select>
                <div class="hint">${text.display.hint}</div>
              </dd>
            </dl>
          </article>

          <article class="card">
            <h2>${text.modelPicker.heading}</h2>
            <dl>
              <dt>${text.modelPicker.showModelsByDefault}</dt>
              <dd>
                <label class="checkbox"><input id="showModelsInPickerByDefault" type="checkbox" /> ${text.modelPicker.showModelsByDefaultLabel}</label>
                <div class="hint">${text.modelPicker.showModelsByDefaultHint}</div>
              </dd>
            </dl>
          </article>

          <article class="card">
            <h2>${text.conversationState.heading}</h2>
            <dl>
              <dt>${text.conversationState.diskPersistence}</dt>
              <dd>
                <label class="checkbox"><input id="persistAcrossReload" type="checkbox" /> ${text.conversationState.diskPersistenceLabel}</label>
                <div class="hint warning">${text.conversationState.diskPersistenceWarning}</div>
              </dd>
              <dt>${text.conversationState.ttlMinutes}</dt>
              <dd><input id="conversationStateTtlMinutes" type="number" min="1" step="1" placeholder="${escapeHtmlAttribute(text.conversationState.ttlMinutesPlaceholder)}" /></dd>
              <dt>${text.conversationState.maxEntries}</dt>
              <dd><input id="conversationStateMaxEntries" type="number" min="1" step="1" placeholder="${escapeHtmlAttribute(text.conversationState.maxEntriesPlaceholder)}" /></dd>
            </dl>
          </article>

          <article class="card">
            <h2>${text.probe.heading}</h2>
            <dl>
              <dt>${text.probe.showModel}</dt>
              <dd>
                <label class="checkbox"><input id="showProbeModel" type="checkbox" /> ${text.probe.showModelLabel}</label>
                <div class="hint">${text.probe.showModelHint}</div>
              </dd>
              <dt>${text.probe.debugLogs}</dt>
              <dd><label class="checkbox"><input id="debugLogging" type="checkbox" /> ${text.probe.debugLogsLabel}</label></dd>
              <dt>${text.probe.hiddenState}</dt>
              <dd><label class="checkbox"><input id="emitHiddenState" type="checkbox" /> ${text.probe.hiddenStateLabel}</label></dd>
              <dt>${text.probe.mimeType}</dt>
              <dd><input id="hiddenStateMimeType" type="text" placeholder="${escapeHtmlAttribute(HIDDEN_STATE_MIME)}" /></dd>
            </dl>
          </article>

          <article class="card card-wide">
            <h2>${text.actions.heading}</h2>
            <div class="actions-row">
              <button class="button-ghost" id="openRawSettingsButton" type="button">${text.actions.openRawSettings}</button>
              <button class="button-ghost" id="importSyncedSettingsButton" type="button">${text.actions.importSyncedSettings}</button>
              <button class="button-ghost" id="exportEncryptedApiKeysButton" type="button">${text.actions.exportEncryptedApiKeys}</button>
              <button class="button-ghost" id="importEncryptedApiKeysButton" type="button">${text.actions.importEncryptedApiKeys}</button>
              <button class="button-ghost" id="showLogsButton" type="button">${text.actions.showLogs}</button>
              <button class="button-ghost" id="copyPromptButton" type="button">${text.actions.copyProbePrompt}</button>
            </div>
          </article>
          </div>
        </section>
      </main>
    </div>

    <script nonce="${nonce}">${getManagerScript(webviewState)}</script>
  </body>
</html>`;
}

function buildWebviewState(
  viewState: BridgeSettingsViewState,
  connectionStatusStore: EndpointConnectionStatusStore,
  locale: ManagerLocale,
  text: ManagerText,
): Record<string, unknown> {
  return {
    settings: viewState.settings,
    connectionStatuses: connectionStatusStore.getAll(),
    storedApiKeyEndpointIds: viewState.storedApiKeyEndpointIds,
    storagePath: viewState.storageFileUri?.fsPath || '<storage unavailable>',
    source: viewState.source,
    storageExists: viewState.storageExists,
    storageRevision: viewState.storageRevision,
    storageReadError: viewState.storageReadError || '',
    probePrompt: getSuggestedProbePrompt(),
    locale,
    text,
  };
}

function getManagerStyles(): string {
  return `
:root {
  color-scheme: light dark;
  --bg: var(--vscode-editor-background, #1e1e1e);
  --panel: var(--vscode-sideBar-background, var(--bg));
  --panel-strong: var(--vscode-editorWidget-background, var(--panel));
  --card: var(--vscode-editorWidget-background, var(--panel-strong));
  --line: var(--vscode-panel-border, var(--vscode-widget-border, rgba(127, 127, 127, 0.35)));
  --ink: var(--vscode-editor-foreground, #d4d4d4);
  --muted: var(--vscode-descriptionForeground, #9da5b4);
  --accent: var(--vscode-textLink-foreground, var(--vscode-focusBorder, #3794ff));
  --accent-bg: var(--vscode-button-background, #0e639c);
  --accent-fg: var(--vscode-button-foreground, #ffffff);
  --accent-hover: var(--vscode-button-hoverBackground, #1177bb);
  --secondary-bg: var(--vscode-button-secondaryBackground, var(--card));
  --secondary-fg: var(--vscode-button-secondaryForeground, var(--ink));
  --secondary-hover: var(--vscode-button-secondaryHoverBackground, var(--panel-strong));
  --danger: var(--vscode-errorForeground, #f14c4c);
  --warning: var(--vscode-editorWarning-foreground, #cca700);
  --input-bg: var(--vscode-input-background, var(--bg));
  --input-fg: var(--vscode-input-foreground, var(--ink));
  --input-border: var(--vscode-input-border, var(--vscode-contrastBorder, var(--line)));
  --input-placeholder: var(--vscode-input-placeholderForeground, var(--muted));
  --focus-ring: var(--vscode-focusBorder, var(--accent));
  --dropdown-bg: var(--vscode-dropdown-background, var(--input-bg));
  --dropdown-fg: var(--vscode-dropdown-foreground, var(--input-fg));
  --dropdown-border: var(--vscode-dropdown-border, var(--input-border));
  --shadow: 0 18px 48px rgba(0, 0, 0, 0.18);
}

* {
  box-sizing: border-box;
}

[hidden] {
  display: none !important;
}

html,
body {
  margin: 0;
  min-height: 100%;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--vscode-font-family, "Segoe UI", sans-serif);
}

body {
  min-height: 100vh;
}

.shell {
  display: grid;
  grid-template-columns: minmax(280px, 340px) minmax(0, 1fr);
  gap: 20px;
  padding: 20px;
}

.sidebar,
.editor,
.card,
.status-card,
.profile-card {
  border: 1px solid var(--line);
  background: var(--panel);
  box-shadow: var(--shadow);
}

.sidebar {
  border-radius: 24px;
  overflow: hidden;
}

.editor {
  border-radius: 28px;
  padding: 24px;
  display: grid;
  gap: 20px;
}

.sidebar-header {
  padding: 24px 22px 16px;
  border-bottom: 1px solid var(--line);
}

.eyebrow {
  margin: 0;
  font-size: 12px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--accent);
}

.sidebar-header h1 {
  margin: 0;
  margin-top: 8px;
  font-size: 28px;
  line-height: 1.05;
}

.status-pill,
.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 999px;
  font-size: 12px;
}

.status-pill {
  background: var(--panel-strong);
  color: var(--muted);
}

.status-pill.is-positive {
  background: rgba(55, 148, 255, 0.12);
  color: var(--accent);
}

.status-pill.is-warning {
  background: rgba(204, 167, 0, 0.16);
  color: var(--warning);
}

.status-pill.is-error {
  background: rgba(241, 76, 76, 0.14);
  color: var(--danger);
}

.sidebar-header p:last-child,
.hint,
ul,
dd,
.profile-meta,
.state-banner p {
  color: var(--muted);
}

.toolbar {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--line);
}

.button,
.button-positive,
.button-ghost,
.button-danger,
.mini-button {
  appearance: none;
  border: 1px solid transparent;
  border-radius: 14px;
  padding: 10px 14px;
  font: inherit;
  cursor: pointer;
}

.button {
  background: var(--accent-bg);
  color: var(--accent-fg);
}

.button:hover {
  background: var(--accent-hover);
}

.button-positive {
  background: rgba(55, 148, 255, 0.12);
  color: var(--accent);
  border-color: rgba(55, 148, 255, 0.24);
}

.button-positive:hover {
  background: rgba(55, 148, 255, 0.18);
}

.button-ghost,
.mini-button {
  background: var(--secondary-bg);
  color: var(--secondary-fg);
  border-color: var(--line);
}

.button-ghost:hover,
.mini-button:hover {
  background: var(--secondary-hover);
}

.button-danger {
  background: transparent;
  color: var(--danger);
  border-color: var(--danger);
}

.button-danger:hover {
  background: rgba(241, 76, 76, 0.08);
}

.button:disabled,
.button-positive:disabled,
.button-ghost:disabled,
.button-danger:disabled,
.mini-button:disabled {
  opacity: 0.6;
  cursor: default;
}

.button-ghost.is-slot-hidden,
.button.is-slot-hidden,
.button-positive.is-slot-hidden,
.button-danger.is-slot-hidden,
.mini-button.is-slot-hidden {
  visibility: hidden;
  pointer-events: none;
}

.profile-list {
  display: grid;
  gap: 12px;
  padding: 16px 18px 20px;
}

.sidebar-mode {
  padding: 16px 18px 0;
}

.sidebar-mode-button {
  width: 100%;
  text-align: left;
  appearance: none;
  border: 1px solid var(--line);
  border-radius: 18px;
  padding: 12px 14px;
  font: inherit;
  color: var(--secondary-fg);
  background: var(--card);
  cursor: pointer;
}

.sidebar-mode-button:hover {
  background: var(--secondary-hover);
}

.sidebar-mode-button.is-selected {
  border-color: var(--accent);
  background: rgba(55, 148, 255, 0.08);
  color: var(--ink);
}

.profile-card {
  border-radius: 20px;
  padding: 16px;
  display: grid;
  gap: 10px;
  cursor: pointer;
  background: var(--card);
}

.profile-card.is-selected {
  border-color: var(--accent);
}

.profile-top {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}

.profile-card h2 {
  margin: 0;
  font-size: 16px;
}

.profile-card p,
.profile-meta {
  margin: 0;
  line-height: 1.45;
  word-break: break-word;
}

.badge-active {
  background: rgba(55, 148, 255, 0.12);
  color: var(--accent);
}

.badge-inactive {
  background: var(--panel-strong);
  color: var(--muted);
}

.badge-error {
  background: rgba(241, 76, 76, 0.14);
  color: var(--danger);
}

.save-banner {
  display: flex;
  justify-content: flex-end;
}

.banner-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-top: 12px;
}

.banner-note {
  color: var(--muted);
}

.editor-section {
  display: grid;
}

.section-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
}

.card {
  border-radius: 20px;
  padding: 18px;
  background: var(--card);
}

.card-wide {
  grid-column: 1 / -1;
}

.card h2 {
  margin: 0 0 12px;
  font-size: 16px;
}

dl {
  display: grid;
  grid-template-columns: minmax(120px, 160px) 1fr;
  gap: 10px 14px;
  margin: 0;
  align-items: start;
}

dt {
  padding-top: 10px;
  color: var(--muted);
}

dd {
  margin: 0;
}

input,
select,
textarea {
  width: 100%;
  border: 1px solid var(--input-border);
  border-radius: 12px;
  padding: 10px 12px;
  font: inherit;
  color: var(--input-fg);
  background: var(--input-bg);
  box-shadow: inset 0 0 0 1px transparent;
}

select {
  background: var(--dropdown-bg);
  color: var(--dropdown-fg);
  border-color: var(--dropdown-border);
}

input::placeholder,
textarea::placeholder {
  color: var(--input-placeholder);
}

input:hover,
select:hover,
textarea:hover {
  border-color: var(--focus-ring);
}

input:focus,
select:focus,
textarea:focus {
  outline: 1px solid var(--focus-ring);
  outline-offset: 0;
  border-color: var(--focus-ring);
}

textarea {
  min-height: 180px;
  resize: vertical;
  font-family: var(--vscode-editor-font-family, Consolas, monospace);
  line-height: 1.5;
}

.compact textarea {
  min-height: 140px;
}

.checkbox {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.checkbox input {
  width: auto;
}

.inline-actions,
.actions-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.warning {
  color: var(--warning);
}

.type-description {
  margin-top: 8px;
  padding-left: 10px;
  border-left: 2px solid var(--accent);
  line-height: 1.5;
}

code,
#storagePathValue {
  font-family: var(--vscode-editor-font-family, Consolas, monospace);
  word-break: break-all;
}

@media (max-width: 980px) {
  .shell {
    grid-template-columns: 1fr;
  }

  .editor {
    padding: 20px;
  }
}
`;
}

function getManagerScript(webviewState: Record<string, unknown>): string {
  return `
const vscode = acquireVsCodeApi();
const initialState = ${serializeForScript(webviewState)};
const persistedUiState = vscode.getState() || {};
const text = initialState.text;

const state = {
  settings: cloneJson(initialState.settings),
  connectionStatuses: cloneJson(initialState.connectionStatuses || {}),
  locale: String(initialState.locale || 'en'),
  selectedView: persistedUiState.selectedView === 'common' ? 'common' : 'endpoint',
  selectedEndpointId: persistedUiState.selectedEndpointId || initialState.settings.activeEndpointId,
  storedApiKeyEndpointIds: new Set(initialState.storedApiKeyEndpointIds || []),
  storageRevision: initialState.storageRevision === null || typeof initialState.storageRevision === 'string'
    ? initialState.storageRevision
    : null,
  customBodyTexts: {},
  modelOverridesTexts: {},
  defaultModelOverrideDrafts: {},
  nextSaveRequestId: 0,
  lastHandledSaveRequestId: 0,
  saveStatusKind: initialState.storageReadError ? 'error' : 'idle',
  saveStatusDetail: initialState.storageReadError ? String(initialState.storageReadError) : '',
};

state.settings.activeEndpointIds = normalizeActiveEndpointIds(state.settings.activeEndpointIds, state.settings.activeEndpointId);
state.settings.activeEndpointId = state.settings.activeEndpointIds[0] || '';

const elements = {
  commonSettingsButton: document.getElementById('commonSettingsButton'),
  endpointList: document.getElementById('endpointList'),
  endpointEditorSection: document.getElementById('endpointEditorSection'),
  commonEditorSection: document.getElementById('commonEditorSection'),
  saveStatus: document.getElementById('saveStatus'),
  saveStatusDetail: document.getElementById('saveStatusDetail'),
  apiKeyStatus: document.getElementById('apiKeyStatus'),
  apiKeyActionButton: document.getElementById('apiKeyActionButton'),
  endpointName: document.getElementById('endpointName'),
  endpointType: document.getElementById('endpointType'),
  endpointTypeDescription: document.getElementById('endpointTypeDescription'),
  baseUrl: document.getElementById('baseUrl'),
  localhostRewrite: document.getElementById('localhostRewrite'),
  defaultModel: document.getElementById('defaultModel'),
  apiKeySource: document.getElementById('apiKeySource'),
  apiKeySourceHint: document.getElementById('apiKeySourceHint'),
  apiKeyEnvironmentVariable: document.getElementById('apiKeyEnvironmentVariable'),
  apiKeyEnvironmentVariableTerm: document.getElementById('apiKeyEnvironmentVariableTerm'),
  apiKeyEnvironmentVariableField: document.getElementById('apiKeyEnvironmentVariableField'),
  apiKeySecretTerm: document.getElementById('apiKeySecretTerm'),
  toolExposure: document.getElementById('toolExposure'),
  advertisedToolLimit: document.getElementById('advertisedToolLimit'),
  reasoningEffort: document.getElementById('reasoningEffort'),
  lmStudioReasoning: document.getElementById('lmStudioReasoning'),
  enableThinking: document.getElementById('enableThinking'),
  preserveThinking: document.getElementById('preserveThinking'),
  responsesStore: document.getElementById('responsesStore'),
  preservedThinkingMaxChars: document.getElementById('preservedThinkingMaxChars'),
  syntheticReasoningReplayMaxChars: document.getElementById('syntheticReasoningReplayMaxChars'),
  testConnectionButton: document.getElementById('testConnectionButton'),
  connectionStatusBadge: document.getElementById('connectionStatusBadge'),
  connectionStatusSummary: document.getElementById('connectionStatusSummary'),
  connectionStatusDetail: document.getElementById('connectionStatusDetail'),
  contextLength: document.getElementById('contextLength'),
  maxTokens: document.getElementById('maxTokens'),
  temperature: document.getElementById('temperature'),
  topP: document.getElementById('topP'),
  topK: document.getElementById('topK'),
  minP: document.getElementById('minP'),
  presencePenalty: document.getElementById('presencePenalty'),
  repeatPenalty: document.getElementById('repeatPenalty'),
  customBodyJson: document.getElementById('customBodyJson'),
  modelOverridesJson: document.getElementById('modelOverridesJson'),
  defaultModelToolCalling: document.getElementById('defaultModelToolCalling'),
  defaultModelImageInput: document.getElementById('defaultModelImageInput'),
  defaultModelMaxInputTokens: document.getElementById('defaultModelMaxInputTokens'),
  lmStudioReasoningTerm: document.getElementById('lmStudioReasoningTerm'),
  lmStudioReasoningField: document.getElementById('lmStudioReasoningField'),
  showModelsInPickerByDefault: document.getElementById('showModelsInPickerByDefault'),
  showProbeModel: document.getElementById('showProbeModel'),
  debugLogging: document.getElementById('debugLogging'),
  emitHiddenState: document.getElementById('emitHiddenState'),
  hiddenStateMimeType: document.getElementById('hiddenStateMimeType'),
  persistAcrossReload: document.getElementById('persistAcrossReload'),
  conversationStateTtlMinutes: document.getElementById('conversationStateTtlMinutes'),
  conversationStateMaxEntries: document.getElementById('conversationStateMaxEntries'),
  managerLanguage: document.getElementById('managerLanguage'),
  addEndpointButton: document.getElementById('addEndpointButton'),
  duplicateEndpointButton: document.getElementById('duplicateEndpointButton'),
  removeEndpointButton: document.getElementById('removeEndpointButton'),
  setActiveEndpointButton: document.getElementById('setActiveEndpointButton'),
  openRawSettingsButton: document.getElementById('openRawSettingsButton'),
  importSyncedSettingsButton: document.getElementById('importSyncedSettingsButton'),
  exportEncryptedApiKeysButton: document.getElementById('exportEncryptedApiKeysButton'),
  importEncryptedApiKeysButton: document.getElementById('importEncryptedApiKeysButton'),
  showLogsButton: document.getElementById('showLogsButton'),
  copyPromptButton: document.getElementById('copyPromptButton'),
};

initializeRawTextMaps();
ensureSelectedEndpoint();
attachEventHandlers();
attachHostMessageHandlers();
render();

function initializeRawTextMaps() {
  for (const endpoint of state.settings.endpoints) {
    if (!(endpoint.id in state.customBodyTexts)) {
      state.customBodyTexts[endpoint.id] = formatJson(endpoint.requestOverrides?.customBody || {});
    }

    if (!(endpoint.id in state.modelOverridesTexts)) {
      state.modelOverridesTexts[endpoint.id] = formatJson(endpoint.modelOverrides || {});
    }

    if (!(endpoint.id in state.defaultModelOverrideDrafts)) {
      state.defaultModelOverrideDrafts[endpoint.id] = createDefaultModelOverrideDraftFromModelOverrides(endpoint.modelOverrides || {});
    }
  }
}

function normalizeActiveEndpointIds(activeEndpointIds, activeEndpointId) {
  const availableIds = new Set(state.settings.endpoints.map((endpoint) => endpoint.id));
  const seenIds = new Set();
  const normalizedIds = [];

  for (const endpointId of Array.isArray(activeEndpointIds) ? activeEndpointIds : []) {
    const normalizedEndpointId = typeof endpointId === 'string' ? endpointId.trim() : '';
    if (!normalizedEndpointId || !availableIds.has(normalizedEndpointId) || seenIds.has(normalizedEndpointId)) {
      continue;
    }

    seenIds.add(normalizedEndpointId);
    normalizedIds.push(normalizedEndpointId);
  }

  if (normalizedIds.length > 0) {
    return normalizedIds;
  }

  const fallbackEndpointId = typeof activeEndpointId === 'string' ? activeEndpointId.trim() : '';
  if (fallbackEndpointId && availableIds.has(fallbackEndpointId)) {
    return [fallbackEndpointId];
  }

  return [];
}

function getActiveEndpointIds() {
  return normalizeActiveEndpointIds(state.settings.activeEndpointIds, state.settings.activeEndpointId);
}

function isEndpointActive(endpointId) {
  return getActiveEndpointIds().includes(endpointId);
}

function syncActiveEndpointAliases() {
  const activeEndpointIds = getActiveEndpointIds();
  state.settings.activeEndpointIds = activeEndpointIds;
  state.settings.activeEndpointId = activeEndpointIds[0] || '';
}

function setEndpointActive(endpointId, shouldBeActive) {
  const activeEndpointIds = getActiveEndpointIds().filter((activeEndpointId) => activeEndpointId !== endpointId);
  if (shouldBeActive) {
    activeEndpointIds.push(endpointId);
  }

  state.settings.activeEndpointIds = activeEndpointIds;
  state.settings.activeEndpointId = activeEndpointIds[0] || '';
}

function createDefaultModelOverrideDraft() {
  return {
    toolCalling: 'auto',
    imageInput: 'auto',
    maxInputTokens: '',
  };
}

function createDefaultModelOverrideDraftFromModelOverrides(modelOverrides) {
  const wildcardOverride = isPlainObject(modelOverrides) && isPlainObject(modelOverrides['*'])
    ? modelOverrides['*']
    : null;

  return {
    toolCalling: normalizeToggleMode(wildcardOverride?.toolCalling),
    imageInput: normalizeToggleMode(wildcardOverride?.imageInput),
    maxInputTokens: stringifyOptionalNumber(parseOptionalPositiveInteger(wildcardOverride?.maxInputTokens)),
  };
}

function getDefaultModelOverrideDraft(endpointId) {
  if (!(endpointId in state.defaultModelOverrideDrafts)) {
    state.defaultModelOverrideDrafts[endpointId] = createDefaultModelOverrideDraft();
  }

  return state.defaultModelOverrideDrafts[endpointId];
}

function populateDefaultModelOverrideInputs(endpointId) {
  const draft = getDefaultModelOverrideDraft(endpointId);
  elements.defaultModelToolCalling.value = draft.toolCalling || 'auto';
  elements.defaultModelImageInput.value = draft.imageInput || 'auto';
  elements.defaultModelMaxInputTokens.value = draft.maxInputTokens || '';
}

function syncModelOverrideDraftFromJsonText(endpointId, inputText) {
  const parsed = tryParseJsonObjectText(inputText);
  if (!parsed) {
    return;
  }

  state.defaultModelOverrideDrafts[endpointId] = createDefaultModelOverrideDraftFromModelOverrides(parsed);
  if (state.selectedEndpointId === endpointId) {
    populateDefaultModelOverrideInputs(endpointId);
  }
}

function syncModelOverridesTextFromDefaultModelOverrideDraft(endpointId) {
  const parsed = tryParseJsonObjectText(elements.modelOverridesJson.value);
  if (!parsed) {
    return;
  }

  const nextModelOverrides = applyDefaultModelOverrideDraftToModelOverrides(parsed, getDefaultModelOverrideDraft(endpointId));
  const formatted = formatJson(nextModelOverrides);
  elements.modelOverridesJson.value = formatted;
  state.modelOverridesTexts[endpointId] = formatted;
}

function applyDefaultModelOverrideDraftToModelOverrides(modelOverrides, draft) {
  const nextModelOverrides = isPlainObject(modelOverrides) ? cloneJson(modelOverrides) : {};
  const wildcardOverride = isPlainObject(nextModelOverrides['*']) ? cloneJson(nextModelOverrides['*']) : {};
  const toolCalling = normalizeToggleMode(draft?.toolCalling);
  const imageInput = normalizeToggleMode(draft?.imageInput);
  const maxInputTokens = parseOptionalPositiveInteger(draft?.maxInputTokens);

  if (toolCalling === 'auto') {
    delete wildcardOverride.toolCalling;
  } else {
    wildcardOverride.toolCalling = toolCalling;
  }

  if (imageInput === 'auto') {
    delete wildcardOverride.imageInput;
  } else {
    wildcardOverride.imageInput = imageInput;
  }

  if (maxInputTokens === undefined) {
    delete wildcardOverride.maxInputTokens;
  } else {
    wildcardOverride.maxInputTokens = maxInputTokens;
  }

  if (Object.keys(wildcardOverride).length === 0) {
    delete nextModelOverrides['*'];
  } else {
    nextModelOverrides['*'] = wildcardOverride;
  }

  return nextModelOverrides;
}

function attachEventHandlers() {
  elements.endpointList.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const card = target ? target.closest('[data-endpoint-id]') : null;
    if (!card) {
      return;
    }

    syncSelectedEndpointFromInputs();
    state.selectedView = 'endpoint';
    state.selectedEndpointId = card.getAttribute('data-endpoint-id') || state.selectedEndpointId;
    persistUiState();
    render();
  });

  elements.commonSettingsButton.addEventListener('click', () => {
    syncSelectedEndpointFromInputs();
    state.selectedView = 'common';
    persistUiState();
    render();
  });

  elements.addEndpointButton.addEventListener('click', () => {
    syncSelectedEndpointFromInputs();
    const endpoint = createEndpointTemplate(state.settings.endpoints.length + 1);
    state.settings.endpoints.push(endpoint);
    state.selectedView = 'endpoint';
    state.selectedEndpointId = endpoint.id;
    state.customBodyTexts[endpoint.id] = '';
    state.modelOverridesTexts[endpoint.id] = '';
    state.defaultModelOverrideDrafts[endpoint.id] = createDefaultModelOverrideDraft();
    persistUiState();
    render();
    requestImmediateSave();
  });

  elements.duplicateEndpointButton.addEventListener('click', () => {
    const endpoint = getSelectedEndpoint();
    if (!endpoint || state.selectedView !== 'endpoint') {
      return;
    }

    syncSelectedEndpointFromInputs();
    const copy = cloneJson(endpoint);
    copy.id = createEndpointId();
    const duplicateBaseName = endpoint.name
      ? endpoint.name + ' ' + text.dynamic.endpointCopySuffix
      : text.dynamic.endpointCopyFallbackName;
    copy.name = createUniqueEndpointName(duplicateBaseName);
    state.settings.endpoints.push(copy);
    state.selectedView = 'endpoint';
    state.customBodyTexts[copy.id] = state.customBodyTexts[endpoint.id] || '';
    state.modelOverridesTexts[copy.id] = state.modelOverridesTexts[endpoint.id] || '';
    state.defaultModelOverrideDrafts[copy.id] = cloneJson(getDefaultModelOverrideDraft(endpoint.id));
    state.selectedEndpointId = copy.id;
    persistUiState();
    render();
    requestImmediateSave();
  });

  elements.removeEndpointButton.addEventListener('click', () => {
    if (state.selectedView !== 'endpoint') {
      return;
    }

    if (state.settings.endpoints.length <= 1) {
      vscode.postMessage({ command: 'showError', text: text.dynamic.oneEndpointRequired });
      return;
    }

    const endpoint = getSelectedEndpoint();
    if (!endpoint) {
      return;
    }

    syncSelectedEndpointFromInputs();
    vscode.postMessage({
      command: 'requestRemoveEndpoint',
      endpointId: endpoint.id,
      endpointName: endpoint.name,
      isActive: isEndpointActive(endpoint.id),
    });
  });

  elements.setActiveEndpointButton.addEventListener('click', () => {
    const endpoint = getSelectedEndpoint();
    if (!endpoint || state.selectedView !== 'endpoint') {
      return;
    }

    syncSelectedEndpointFromInputs();
    setEndpointActive(endpoint.id, !isEndpointActive(endpoint.id));
    persistUiState();
    render();
    requestImmediateSave();
  });

  elements.apiKeyActionButton.addEventListener('click', () => {
    const endpoint = getSelectedEndpoint();
    if (!endpoint) {
      return;
    }

    syncSelectedEndpointFromInputs();
    const command = elements.apiKeyActionButton.dataset.action === 'clear' ? 'clearApiKey' : 'setApiKey';
    vscode.postMessage({
      command,
      endpointId: endpoint.id,
      endpointName: endpoint.name,
    });
  });

  elements.testConnectionButton.addEventListener('click', () => {
    const endpoint = getSelectedEndpoint();
    if (!endpoint || state.selectedView !== 'endpoint') {
      return;
    }

    syncSelectedEndpointFromInputs();
    const selectedEndpoint = getSelectedEndpoint();
    if (!selectedEndpoint) {
      return;
    }

    state.connectionStatuses[selectedEndpoint.id] = {
      kind: 'running',
      source: 'manual',
      checkedAt: Date.now(),
    };
    renderConnectionStatus(selectedEndpoint);
    vscode.postMessage({
      command: 'testEndpointConnection',
      userInitiated: true,
      endpointId: selectedEndpoint.id,
      endpointName: selectedEndpoint.name,
      endpointType: selectedEndpoint.endpointType,
      baseUrl: selectedEndpoint.baseUrl,
      localhostRewrite: selectedEndpoint.localhostRewrite,
    });
  });

  elements.openRawSettingsButton.addEventListener('click', () => {
    vscode.postMessage({ command: 'openRawSettings' });
  });

  elements.importSyncedSettingsButton.addEventListener('click', () => {
    vscode.postMessage({ command: 'importSyncedSettings' });
  });

  elements.exportEncryptedApiKeysButton.addEventListener('click', () => {
    vscode.postMessage({ command: 'exportEncryptedApiKeys' });
  });

  elements.importEncryptedApiKeysButton.addEventListener('click', () => {
    vscode.postMessage({ command: 'importEncryptedApiKeys' });
  });

  elements.showLogsButton.addEventListener('click', () => {
    vscode.postMessage({ command: 'showLogs' });
  });

  elements.copyPromptButton.addEventListener('click', () => {
    vscode.postMessage({ command: 'copyPrompt' });
  });

  elements.modelOverridesJson.addEventListener('input', () => {
    const endpoint = getSelectedEndpoint();
    if (!endpoint || state.selectedView !== 'endpoint') {
      return;
    }

    state.modelOverridesTexts[endpoint.id] = elements.modelOverridesJson.value;
    syncModelOverrideDraftFromJsonText(endpoint.id, elements.modelOverridesJson.value);
  });

  const simpleModelOverrideElements = [
    elements.defaultModelToolCalling,
    elements.defaultModelImageInput,
    elements.defaultModelMaxInputTokens,
  ];

  for (const element of simpleModelOverrideElements) {
    element.addEventListener('change', () => {
      const endpoint = getSelectedEndpoint();
      if (!endpoint || state.selectedView !== 'endpoint') {
        return;
      }

      syncSelectedEndpointFromInputs();
      syncModelOverridesTextFromDefaultModelOverrideDraft(endpoint.id);
    });
  }

  const autoSaveElements = [
    elements.endpointName,
    elements.endpointType,
    elements.baseUrl,
    elements.localhostRewrite,
    elements.defaultModel,
    elements.apiKeySource,
    elements.apiKeyEnvironmentVariable,
    elements.toolExposure,
    elements.advertisedToolLimit,
    elements.reasoningEffort,
    elements.lmStudioReasoning,
    elements.enableThinking,
    elements.preserveThinking,
    elements.responsesStore,
    elements.preservedThinkingMaxChars,
    elements.syntheticReasoningReplayMaxChars,
    elements.contextLength,
    elements.maxTokens,
    elements.temperature,
    elements.topP,
    elements.topK,
    elements.minP,
    elements.presencePenalty,
    elements.repeatPenalty,
    elements.customBodyJson,
    elements.defaultModelToolCalling,
    elements.defaultModelImageInput,
    elements.defaultModelMaxInputTokens,
    elements.modelOverridesJson,
    elements.showModelsInPickerByDefault,
    elements.showProbeModel,
    elements.debugLogging,
    elements.emitHiddenState,
    elements.hiddenStateMimeType,
    elements.persistAcrossReload,
    elements.conversationStateTtlMinutes,
    elements.conversationStateMaxEntries,
  ];

  for (const element of autoSaveElements) {
    element.addEventListener('change', () => {
      syncSelectedEndpointFromInputs();
      render();
      requestImmediateSave();
    });
  }

  elements.managerLanguage.addEventListener('change', () => {
    syncSelectedEndpointFromInputs();
    requestImmediateSave(true);
  });
}

function attachHostMessageHandlers() {
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object') {
      return;
    }

    if (message.command === 'apiKeyStatusChanged') {
      const endpointId = typeof message.endpointId === 'string' ? message.endpointId : '';
      if (!endpointId) {
        return;
      }

      if (message.hasStoredApiKey) {
        state.storedApiKeyEndpointIds.add(endpointId);
      } else {
        state.storedApiKeyEndpointIds.delete(endpointId);
      }

      render();
      return;
    }

    if (message.command === 'endpointConnectionStatusChanged') {
      const endpointId = typeof message.endpointId === 'string' ? message.endpointId : '';
      if (!endpointId) {
        return;
      }

      const status = message.status && typeof message.status === 'object' ? cloneJson(message.status) : null;
      if (status) {
        state.connectionStatuses[endpointId] = status;
      } else {
        delete state.connectionStatuses[endpointId];
      }

      renderEndpointList();

      const endpoint = getSelectedEndpoint();
      if (endpoint && endpoint.id === endpointId && state.selectedView === 'endpoint') {
        renderConnectionStatus(endpoint);
      }
      return;
    }

    if (message.command === 'saveResult') {
      const requestId = typeof message.requestId === 'number' ? message.requestId : 0;
      if (requestId < state.lastHandledSaveRequestId) {
        return;
      }

      state.lastHandledSaveRequestId = requestId;
      if (message.ok === true) {
        state.storageRevision = typeof message.storageRevision === 'string' ? message.storageRevision : state.storageRevision;
        setSaveStatus('saved');
      } else {
        const detail = typeof message.error === 'string' ? message.error : '';
        setSaveStatus('error', detail);
      }
      renderSaveStatus();
      return;
    }

    if (message.command !== 'removeEndpointConfirmationResult') {
      return;
    }

    const endpointId = typeof message.endpointId === 'string' ? message.endpointId : '';
    if (!endpointId || message.confirmed !== true) {
      return;
    }

    removeEndpointFromDraft(endpointId);
  });
}

function render() {
  ensureSelectedEndpoint();
  const endpoint = getSelectedEndpoint();
  if (!endpoint) {
    return;
  }

  const isCommonView = state.selectedView === 'common';
  const hasStoredApiKey = state.storedApiKeyEndpointIds.has(endpoint.id);
  const isSelectedEndpointActive = isEndpointActive(endpoint.id);

  elements.commonEditorSection.hidden = !isCommonView;
  elements.endpointEditorSection.hidden = isCommonView;

  elements.apiKeyStatus.textContent = hasStoredApiKey ? text.dynamic.apiKeyStored : text.dynamic.noApiKey;
  elements.apiKeyStatus.className = hasStoredApiKey ? 'status-pill is-positive' : 'status-pill';
  elements.apiKeyActionButton.textContent = hasStoredApiKey ? text.dynamic.clearApiKey : text.dynamic.setApiKey;
  elements.apiKeyActionButton.dataset.action = hasStoredApiKey ? 'clear' : 'set';
  elements.setActiveEndpointButton.textContent = isSelectedEndpointActive ? text.toolbar.disableActive : text.toolbar.setActive;
  elements.setActiveEndpointButton.className = isCommonView
    ? 'button-ghost is-slot-hidden'
    : isSelectedEndpointActive
      ? 'button-ghost'
      : 'button-positive';
  elements.setActiveEndpointButton.setAttribute('aria-hidden', isCommonView ? 'true' : 'false');
  elements.duplicateEndpointButton.disabled = isCommonView;
  elements.setActiveEndpointButton.disabled = isCommonView;
  elements.removeEndpointButton.disabled = isCommonView || state.settings.endpoints.length <= 1;
  elements.commonSettingsButton.className = isCommonView ? 'sidebar-mode-button is-selected' : 'sidebar-mode-button';
  elements.copyPromptButton.hidden = !state.settings.probe.showModel;

  renderEndpointList();
  populateEndpointInputs(endpoint);
  populateGlobalInputs();
  updateConditionalFields(endpoint);
  renderConnectionStatus(endpoint);
  renderSaveStatus();
  persistUiState();
}

function renderEndpointList() {
  const selectedId = state.selectedEndpointId;
  elements.endpointList.innerHTML = state.settings.endpoints.map((endpoint) => {
    const isSelected = state.selectedView === 'endpoint' && endpoint.id === selectedId;
    const isActive = isEndpointActive(endpoint.id);
    const badge = getEndpointListBadge(endpoint.id, isActive);
    const apiKeyText = state.storedApiKeyEndpointIds.has(endpoint.id) ? text.dynamic.apiKeyStored : text.dynamic.noApiKey;
    const endpointLabel = getEndpointTypeLabel(endpoint.endpointType);

    return (
      '<article class="profile-card' + (isSelected ? ' is-selected' : '') + '" data-endpoint-id="' + escapeHtml(endpoint.id) + '">' +
        '<div class="profile-top">' +
          '<div>' +
            '<h2>' + escapeHtml(endpoint.name || endpoint.id) + '</h2>' +
            '<p>' + escapeHtml(endpoint.baseUrl || text.dynamic.noBaseUrlConfigured) + '</p>' +
          '</div>' +
          '<span class="badge ' + badge.className + '">' + badge.label + '</span>' +
        '</div>' +
        '<p class="profile-meta">' + escapeHtml(endpointLabel) + ' | ' + escapeHtml(apiKeyText) + '</p>' +
      '</article>'
    );
  }).join('');
}

function getEndpointListBadge(endpointId, isActive) {
  if (!isActive) {
    return { label: text.dynamic.registeredBadge, className: 'badge-inactive' };
  }

  const status = state.connectionStatuses[endpointId];
  if (status && status.kind === 'error') {
    return { label: text.dynamic.errorBadge, className: 'badge-error' };
  }

  return { label: text.dynamic.activeBadge, className: 'badge-active' };
}

function populateEndpointInputs(endpoint) {
  elements.endpointName.value = endpoint.name || '';
  elements.endpointType.value = endpoint.endpointType || 'openai-compatible';
  elements.endpointTypeDescription.textContent = getEndpointTypeDescription(endpoint.endpointType);
  elements.baseUrl.value = endpoint.baseUrl || '';
  elements.localhostRewrite.value = endpoint.localhostRewrite || 'auto';
  elements.defaultModel.value = endpoint.defaultModel || '';
  elements.apiKeySource.value = endpoint.apiKeySource || 'secret-storage';
  elements.apiKeyEnvironmentVariable.value = endpoint.apiKeyEnvironmentVariable || '';
  elements.toolExposure.value = endpoint.toolExposure || 'auto';
  elements.advertisedToolLimit.value = stringifyOptionalNumber(endpoint.advertisedToolLimit);
  elements.reasoningEffort.value = endpoint.requestOverrides.reasoningEffort || '';
  elements.lmStudioReasoning.value = endpoint.requestOverrides.lmStudioReasoning || 'auto';
  elements.enableThinking.value = endpoint.requestOverrides.enableThinking || 'auto';
  elements.preserveThinking.value = endpoint.requestOverrides.preserveThinking || 'auto';
  elements.responsesStore.value = endpoint.requestOverrides.responsesStore || 'auto';
  elements.preservedThinkingMaxChars.value = stringifyOptionalNumber(endpoint.requestOverrides.preservedThinkingMaxChars);
  elements.syntheticReasoningReplayMaxChars.value = stringifyOptionalNumber(endpoint.requestOverrides.syntheticReasoningReplayMaxChars);
  elements.contextLength.value = stringifyOptionalNumber(endpoint.requestOverrides.contextLength);
  elements.maxTokens.value = stringifyOptionalNumber(endpoint.requestOverrides.maxTokens);
  elements.temperature.value = stringifyOptionalNumber(endpoint.requestOverrides.temperature);
  elements.topP.value = stringifyOptionalNumber(endpoint.requestOverrides.topP);
  elements.topK.value = stringifyOptionalNumber(endpoint.requestOverrides.topK);
  elements.minP.value = stringifyOptionalNumber(endpoint.requestOverrides.minP);
  elements.presencePenalty.value = stringifyOptionalNumber(endpoint.requestOverrides.presencePenalty);
  elements.repeatPenalty.value = stringifyOptionalNumber(endpoint.requestOverrides.repeatPenalty);
  elements.customBodyJson.value = state.customBodyTexts[endpoint.id] || '';
  populateDefaultModelOverrideInputs(endpoint.id);
  elements.modelOverridesJson.value = state.modelOverridesTexts[endpoint.id] || '';
}

function getEndpointTypeLabel(endpointType) {
  if (endpointType === 'responses-api') {
    return text.endpoint.responsesApi;
  }

  if (endpointType === 'lm-studio') {
    return text.endpoint.lmStudio;
  }

  if (endpointType === 'lm-studio-responses') {
    return text.endpoint.lmStudioResponses;
  }

  if (endpointType === 'lm-studio-rest') {
    return text.endpoint.lmStudioNative;
  }

  return text.endpoint.openAiCompatible;
}

function getEndpointTypeDescription(endpointType) {
  if (endpointType === 'responses-api') {
    return text.endpoint.typeDescriptions.responsesApi;
  }

  if (endpointType === 'lm-studio') {
    return text.endpoint.typeDescriptions.lmStudio;
  }

  if (endpointType === 'lm-studio-responses') {
    return text.endpoint.typeDescriptions.lmStudioResponses;
  }

  if (endpointType === 'lm-studio-rest') {
    return text.endpoint.typeDescriptions.lmStudioNative;
  }

  return text.endpoint.typeDescriptions.openAiCompatible;
}

function populateGlobalInputs() {
  elements.showModelsInPickerByDefault.checked = Boolean(state.settings.modelPicker.showModelsByDefault);
  elements.showProbeModel.checked = Boolean(state.settings.probe.showModel);
  elements.debugLogging.checked = Boolean(state.settings.probe.debugLogging);
  elements.emitHiddenState.checked = Boolean(state.settings.probe.emitHiddenState);
  elements.hiddenStateMimeType.value = state.settings.probe.hiddenStateMimeType || '${escapeJsString(HIDDEN_STATE_MIME)}';
  elements.persistAcrossReload.checked = Boolean(state.settings.conversationState.persistAcrossReload);
  elements.conversationStateTtlMinutes.value = stringifyOptionalNumber(state.settings.conversationState.ttlMinutes);
  elements.conversationStateMaxEntries.value = stringifyOptionalNumber(state.settings.conversationState.maxEntries);
  elements.managerLanguage.value = state.settings.manager.language || 'auto';
}

function renderConnectionStatus(endpoint) {
  const status = state.connectionStatuses[endpoint.id];
  const baseUrl = String(endpoint.baseUrl || '').trim();
  const isRunning = Boolean(status && status.kind === 'running');
  elements.testConnectionButton.textContent = isRunning ? text.connection.testing : text.connection.test;
  elements.testConnectionButton.disabled = !baseUrl || isRunning;

  if (!baseUrl) {
    elements.connectionStatusBadge.textContent = text.connection.statusIncomplete;
    elements.connectionStatusBadge.className = 'status-pill';
    elements.connectionStatusSummary.textContent = text.connection.noBaseUrlHint;
    elements.connectionStatusDetail.textContent = '';
    elements.connectionStatusDetail.hidden = true;
    return;
  }

  if (!status) {
    elements.connectionStatusBadge.textContent = text.connection.statusNotChecked;
    elements.connectionStatusBadge.className = 'status-pill';
    elements.connectionStatusSummary.textContent = text.connection.idleHint;
    elements.connectionStatusDetail.textContent = '';
    elements.connectionStatusDetail.hidden = true;
    return;
  }

  const sourceText = status.source === 'automatic' ? text.connection.automaticSource : text.connection.manualSource;
  const isStale = status.freshness === 'stale';
  if (status.kind === 'running') {
    elements.connectionStatusBadge.textContent = text.connection.statusChecking;
    elements.connectionStatusBadge.className = 'status-pill is-warning';
    elements.connectionStatusSummary.textContent = formatTemplate(text.connection.testingHint, { source: sourceText });
    elements.connectionStatusDetail.textContent = '';
    elements.connectionStatusDetail.hidden = true;
    return;
  }

  if (status.kind === 'success') {
    const chatModelCount = Number(status.chatModelCount || 0);
    elements.connectionStatusBadge.textContent = isStale ? text.connection.statusChecked : text.connection.statusSuccess;
    elements.connectionStatusBadge.className = chatModelCount > 0 ? 'status-pill is-positive' : 'status-pill is-warning';
    elements.connectionStatusSummary.textContent = chatModelCount > 0
      ? formatTemplate(isStale ? text.connection.previousSuccessWithModels : text.connection.successWithModels, { source: sourceText, count: chatModelCount })
      : formatTemplate(isStale ? text.connection.previousSuccessWithoutModels : text.connection.successWithoutModels, { source: sourceText });
    elements.connectionStatusDetail.textContent = '';
    elements.connectionStatusDetail.hidden = true;
    return;
  }

  if (isStale) {
    elements.connectionStatusBadge.textContent = text.connection.statusRetest;
    elements.connectionStatusBadge.className = 'status-pill is-warning';
    elements.connectionStatusSummary.textContent = formatTemplate(text.connection.previousErrorHint, { source: sourceText });
    elements.connectionStatusDetail.textContent = status.detail || '';
    elements.connectionStatusDetail.hidden = !status.detail;
    return;
  }

  elements.connectionStatusBadge.textContent = text.connection.statusError;
  elements.connectionStatusBadge.className = 'status-pill is-error';
  elements.connectionStatusSummary.textContent = formatTemplate(text.connection.errorHint, { source: sourceText });
  elements.connectionStatusDetail.textContent = status.detail || '';
  elements.connectionStatusDetail.hidden = !status.detail;
}

function syncSelectedEndpointFromInputs() {
  const endpoint = getSelectedEndpoint();
  if (!endpoint) {
    return;
  }

  endpoint.name = elements.endpointName.value.trim() || endpoint.name || text.dynamic.endpointFallbackName;
  endpoint.endpointType = normalizeEndpointType(elements.endpointType.value);
  endpoint.baseUrl = elements.baseUrl.value.trim();
  endpoint.localhostRewrite = normalizeToggleMode(elements.localhostRewrite.value);
  endpoint.defaultModel = elements.defaultModel.value.trim();
  endpoint.apiKeySource = normalizeApiKeySource(elements.apiKeySource.value);
  endpoint.apiKeyEnvironmentVariable = normalizeEnvironmentVariableName(elements.apiKeyEnvironmentVariable.value);
  endpoint.toolExposure = normalizeToggleMode(elements.toolExposure.value);
  endpoint.advertisedToolLimit = parseOptionalPositiveInteger(elements.advertisedToolLimit.value);
  endpoint.requestOverrides.reasoningEffort = elements.reasoningEffort.value.trim();
  endpoint.requestOverrides.lmStudioReasoning = normalizeLmStudioReasoning(elements.lmStudioReasoning.value);
  endpoint.requestOverrides.enableThinking = normalizeToggleMode(elements.enableThinking.value);
  endpoint.requestOverrides.preserveThinking = normalizeToggleMode(elements.preserveThinking.value);
  endpoint.requestOverrides.responsesStore = normalizeToggleMode(elements.responsesStore.value);
  endpoint.requestOverrides.preservedThinkingMaxChars = parseOptionalThinkingCharLimit(elements.preservedThinkingMaxChars.value);
  endpoint.requestOverrides.syntheticReasoningReplayMaxChars = parseOptionalThinkingCharLimit(elements.syntheticReasoningReplayMaxChars.value);
  endpoint.requestOverrides.contextLength = parseOptionalPositiveInteger(elements.contextLength.value);
  endpoint.requestOverrides.maxTokens = parseOptionalPositiveInteger(elements.maxTokens.value);
  endpoint.requestOverrides.temperature = parseOptionalNumber(elements.temperature.value);
  endpoint.requestOverrides.topP = parseOptionalNumber(elements.topP.value);
  endpoint.requestOverrides.topK = parseOptionalPositiveInteger(elements.topK.value);
  endpoint.requestOverrides.minP = parseOptionalNumber(elements.minP.value);
  endpoint.requestOverrides.presencePenalty = parseOptionalNumber(elements.presencePenalty.value);
  endpoint.requestOverrides.repeatPenalty = parseOptionalNumber(elements.repeatPenalty.value);
  state.customBodyTexts[endpoint.id] = elements.customBodyJson.value;
  state.modelOverridesTexts[endpoint.id] = elements.modelOverridesJson.value;
  state.defaultModelOverrideDrafts[endpoint.id] = {
    toolCalling: normalizeToggleMode(elements.defaultModelToolCalling.value),
    imageInput: normalizeToggleMode(elements.defaultModelImageInput.value),
    maxInputTokens: elements.defaultModelMaxInputTokens.value.trim(),
  };

  state.settings.modelPicker.showModelsByDefault = Boolean(elements.showModelsInPickerByDefault.checked);
  state.settings.probe.showModel = Boolean(elements.showProbeModel.checked);
  state.settings.probe.debugLogging = Boolean(elements.debugLogging.checked);
  state.settings.probe.emitHiddenState = Boolean(elements.emitHiddenState.checked);
  state.settings.probe.hiddenStateMimeType = elements.hiddenStateMimeType.value.trim() || '${escapeJsString(HIDDEN_STATE_MIME)}';
  state.settings.conversationState.persistAcrossReload = Boolean(elements.persistAcrossReload.checked);
  state.settings.conversationState.ttlMinutes = parseOptionalPositiveInteger(elements.conversationStateTtlMinutes.value) || 720;
  state.settings.conversationState.maxEntries = parseOptionalPositiveInteger(elements.conversationStateMaxEntries.value) || 200;
  state.settings.manager.language = normalizeManagerLanguage(elements.managerLanguage.value);
}

function buildSettingsPayload() {
  syncSelectedEndpointFromInputs();
  syncActiveEndpointAliases();

  const endpoints = state.settings.endpoints.map((endpoint) => ({
    ...cloneJson(endpoint),
    requestOverrides: {
      ...cloneJson(endpoint.requestOverrides),
      customBody: parseJsonObjectText(state.customBodyTexts[endpoint.id], text.dynamic.jsonLabels.customRequest),
    },
    modelOverrides: applyDefaultModelOverrideDraftToModelOverrides(
      parseJsonObjectText(state.modelOverridesTexts[endpoint.id], text.dynamic.jsonLabels.modelOverrides),
      getDefaultModelOverrideDraft(endpoint.id),
    ),
  }));

  const fallbackEndpoint = endpoints[0];
  if (!fallbackEndpoint) {
    throw new Error(text.dynamic.oneEndpointRequired);
  }

  ensureUniqueEndpointNames(endpoints);

  const activeEndpointIds = normalizeActiveEndpointIds(state.settings.activeEndpointIds, state.settings.activeEndpointId)
    .filter((endpointId) => endpoints.some((endpoint) => endpoint.id === endpointId));
  const activeEndpoint = activeEndpointIds[0]
    ? endpoints.find((endpoint) => endpoint.id === activeEndpointIds[0]) || null
    : null;

  return {
    activeEndpointIds,
    activeEndpointId: activeEndpoint ? activeEndpoint.id : '',
    endpoints,
    backend: cloneJson(activeEndpoint || fallbackEndpoint),
    probe: cloneJson(state.settings.probe),
    modelPicker: cloneJson(state.settings.modelPicker),
    conversationState: cloneJson(state.settings.conversationState),
    manager: cloneJson(state.settings.manager),
  };
}

function removeEndpointFromDraft(endpointId) {
  if (state.settings.endpoints.length <= 1) {
    vscode.postMessage({ command: 'showError', text: text.dynamic.oneEndpointRequired });
    return;
  }

  const removedIndex = state.settings.endpoints.findIndex((candidate) => candidate.id === endpointId);
  if (removedIndex < 0) {
    return;
  }

  const previousActiveEndpointIds = getActiveEndpointIds();
  state.settings.endpoints = state.settings.endpoints.filter((candidate) => candidate.id !== endpointId);
  delete state.connectionStatuses[endpointId];
  delete state.customBodyTexts[endpointId];
  delete state.modelOverridesTexts[endpointId];
  delete state.defaultModelOverrideDrafts[endpointId];
  state.storedApiKeyEndpointIds.delete(endpointId);

  const replacementEndpoint = state.settings.endpoints[removedIndex] || state.settings.endpoints[Math.max(0, removedIndex - 1)] || null;
  const wasActive = previousActiveEndpointIds.includes(endpointId);
  const nextActiveEndpointIds = previousActiveEndpointIds.filter((activeEndpointId) => activeEndpointId !== endpointId);
  if (wasActive && nextActiveEndpointIds.length === 0 && replacementEndpoint) {
    nextActiveEndpointIds.push(replacementEndpoint.id);
  }

  state.settings.activeEndpointIds = nextActiveEndpointIds;
  state.settings.activeEndpointId = nextActiveEndpointIds[0] || '';

  state.selectedEndpointId = replacementEndpoint ? replacementEndpoint.id : state.settings.activeEndpointId || state.settings.endpoints[0]?.id || '';
  persistUiState();
  render();
  requestImmediateSave();
}

function ensureSelectedEndpoint() {
  if (state.settings.endpoints.some((endpoint) => endpoint.id === state.selectedEndpointId)) {
    return;
  }

  state.selectedEndpointId = state.settings.activeEndpointId || state.settings.endpoints[0]?.id || '';
}

function getSelectedEndpoint() {
  return state.settings.endpoints.find((endpoint) => endpoint.id === state.selectedEndpointId) || null;
}

function getActiveEndpoint() {
  const activeEndpointId = getActiveEndpointIds()[0];
  return state.settings.endpoints.find((endpoint) => endpoint.id === activeEndpointId) || null;
}

function normalizeEndpointNameForComparison(name) {
  return String(name || '').trim().toLowerCase();
}

function createUniqueEndpointName(baseName) {
  const normalizedBaseName = String(baseName || '').trim() || text.dynamic.endpointFallbackName;
  const usedNames = new Set(
    state.settings.endpoints
      .map((endpoint) => normalizeEndpointNameForComparison(endpoint.name))
      .filter((endpointName) => Boolean(endpointName))
  );

  if (!usedNames.has(normalizeEndpointNameForComparison(normalizedBaseName))) {
    return normalizedBaseName;
  }

  let suffix = 2;
  let candidateName = normalizedBaseName + ' (' + suffix + ')';
  while (usedNames.has(normalizeEndpointNameForComparison(candidateName))) {
    suffix += 1;
    candidateName = normalizedBaseName + ' (' + suffix + ')';
  }

  return candidateName;
}

function ensureUniqueEndpointNames(endpoints) {
  const seenNames = new Map();

  for (const endpoint of endpoints) {
    const endpointName = String(endpoint && endpoint.name ? endpoint.name : '').trim() || text.dynamic.endpointFallbackName;
    const normalizedName = normalizeEndpointNameForComparison(endpointName);
    if (!normalizedName) {
      continue;
    }

    if (seenNames.has(normalizedName)) {
      throw new Error(formatTemplate(text.dynamic.errors.duplicateEndpointName, { name: endpointName }));
    }

    seenNames.set(normalizedName, endpointName);
  }
}

function createEndpointTemplate(index) {
  return {
    id: createEndpointId(),
    name: createUniqueEndpointName(text.dynamic.endpointDefaultNamePrefix + ' ' + index),
    endpointType: 'openai-compatible',
    baseUrl: '',
    localhostRewrite: 'auto',
    defaultModel: '',
    apiKeySource: 'secret-storage',
    apiKeyEnvironmentVariable: '',
    toolExposure: 'auto',
    advertisedToolLimit: undefined,
    requestOverrides: {
      reasoningEffort: '',
      lmStudioReasoning: 'auto',
      enableThinking: 'auto',
      preserveThinking: 'auto',
      responsesStore: 'auto',
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

function createEndpointId() {
  return 'endpoint-' + Math.random().toString(36).slice(2, 10);
}

function parseJsonObjectText(inputText, label) {
  const normalized = String(inputText || '').trim();
  if (!normalized) {
    return {};
  }

  try {
    const parsed = JSON.parse(normalized);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(label + text.dynamic.errors.mustBeJsonObject);
    }

    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message.endsWith(text.dynamic.errors.mustBeJsonObject)) {
      throw error;
    }

    throw new Error(label + text.dynamic.errors.mustBeValidJson + (error instanceof Error ? error.message : String(error)));
  }
}

function stringifyOptionalNumber(value) {
  return value === undefined || value === null ? '' : String(value);
}

function parseOptionalPositiveInteger(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return undefined;
  }

  const parsed = Number.parseInt(normalized, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseOptionalThinkingCharLimit(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return undefined;
  }

  const parsed = Number.parseInt(normalized, 10);
  return Number.isInteger(parsed) && (parsed === -1 || parsed >= 0) ? parsed : undefined;
}

function parseOptionalNumber(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return undefined;
  }

  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function tryParseJsonObjectText(inputText) {
  const normalized = String(inputText || '').trim();
  if (!normalized) {
    return {};
  }

  try {
    const parsed = JSON.parse(normalized);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeToggleMode(value) {
  return value === 'on' || value === 'off' ? value : 'auto';
}

function normalizeEndpointType(value) {
  return value === 'responses-api' || value === 'lm-studio' || value === 'lm-studio-responses' || value === 'lm-studio-rest' ? value : 'openai-compatible';
}

function normalizeApiKeySource(value) {
  return value === 'environment' ? 'environment' : 'secret-storage';
}

function normalizeEnvironmentVariableName(value) {
  return String(value || '').trim().replace(/[^A-Za-z0-9_]/g, '').slice(0, 120);
}

function normalizeLmStudioReasoning(value) {
  return value === 'off' || value === 'low' || value === 'medium' || value === 'high' || value === 'on'
    ? value
    : 'auto';
}

function normalizeManagerLanguage(value) {
  return value === 'en' || value === 'ja' ? value : 'auto';
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function formatTemplate(template, replacements) {
  let result = String(template || '');
  for (const [key, value] of Object.entries(replacements || {})) {
    result = result.replaceAll('{' + key + '}', String(value));
  }

  return result;
}

function formatJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) {
    return '';
  }

  return JSON.stringify(value, null, 2);
}

function persistUiState() {
  vscode.setState({
    selectedView: state.selectedView,
    selectedEndpointId: state.selectedEndpointId,
  });
}

function updateConditionalFields(endpoint) {
  const isLmStudioEndpoint = endpoint.endpointType === 'lm-studio-rest';
  const usesEnvironmentApiKey = endpoint.apiKeySource === 'environment';
  elements.lmStudioReasoningTerm.hidden = !isLmStudioEndpoint;
  elements.lmStudioReasoningField.hidden = !isLmStudioEndpoint;
  elements.apiKeyEnvironmentVariableTerm.hidden = !usesEnvironmentApiKey;
  elements.apiKeyEnvironmentVariableField.hidden = !usesEnvironmentApiKey;
  elements.apiKeySecretTerm.hidden = usesEnvironmentApiKey;
  elements.apiKeyActionButton.hidden = usesEnvironmentApiKey;
  elements.apiKeySourceHint.textContent = usesEnvironmentApiKey ? text.endpoint.apiKeySourceEnvironmentHint : text.endpoint.apiKeySourceSecretStorageHint;
}

function renderSaveStatus() {
  const isIdle = state.saveStatusKind === 'idle';
  elements.saveStatus.hidden = isIdle;
  elements.saveStatusDetail.hidden = isIdle;
  if (isIdle) {
    elements.saveStatus.textContent = '';
    elements.saveStatus.className = 'status-pill';
    elements.saveStatusDetail.textContent = '';
    return;
  }

  const statusMap = {
    saving: { text: text.dynamic.autoSaveSaving, className: 'status-pill is-warning' },
    saved: { text: text.dynamic.autoSaveSaved, className: 'status-pill is-positive' },
    error: { text: text.dynamic.autoSaveError, className: 'status-pill is-error' },
  };

  const status = statusMap[state.saveStatusKind] || statusMap.saved;
  elements.saveStatus.textContent = status.text;
  elements.saveStatus.className = status.className;
  elements.saveStatusDetail.textContent = state.saveStatusDetail;
}

function requestImmediateSave(refreshAfterSave = false) {
  try {
    const payload = buildSettingsPayload();
    const requestId = ++state.nextSaveRequestId;
    setSaveStatus('saving');
    renderSaveStatus();
    vscode.postMessage({
      command: 'saveSettings',
      settings: payload,
      storageRevision: state.storageRevision,
      requestId,
      refreshAfterSave,
    });
  } catch (error) {
    setSaveStatus('error', error instanceof Error ? error.message : String(error));
    renderSaveStatus();
  }
}

function setSaveStatus(kind, detail) {
  state.saveStatusKind = kind;
  state.saveStatusDetail = kind === 'error' ? String(detail || '') : '';
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
`;
}

function sanitizeSettingsPayload(payload: unknown): BridgeStoredSettings {
  return sanitizeStoredSettings(payload);
}

function getSuggestedProbePrompt(): string {
  return [
    'First turn: say "probe one" and wait for the response.',
    'Second turn: ask the model whether it can report the previous hidden probe id from the transcript.',
    'Then inspect the GHCC Custom Provider output channel for the raw transcript diagnostics.',
  ].join('\n');
}

function serializeForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeHtmlText(value: string): string {
  return escapeHtmlAttribute(value);
}

function createNonce(): string {
  return randomBytes(16).toString('base64');
}

async function confirmEndpointRemoval(
  settingsStore: BridgeSettingsStore,
  endpointId: string,
  endpointName: string | undefined,
  isActive: boolean,
): Promise<boolean> {
  const viewState = await settingsStore.getViewState();
  const locale = resolveManagerLocale(viewState.settings.manager.language, vscode.env.language);
  const text = getManagerText(locale);
  const label = endpointName?.trim() || endpointId || text.dynamic.endpointFallbackName;
  const message = formatManagerMessage(
    isActive ? text.dynamic.removeActiveEndpointConfirmation : text.dynamic.removeEndpointConfirmation,
    label,
  );
  const detail = isActive
    ? text.dynamic.removeActiveEndpointConfirmationDetail
    : text.dynamic.removeEndpointConfirmationDetail;
  const messageOptions: vscode.MessageOptions = detail ? { modal: true, detail } : { modal: true };
  const result = await vscode.window.showWarningMessage(
    message,
    messageOptions,
    text.dynamic.removeEndpointAction,
  );

  return result === text.dynamic.removeEndpointAction;
}

async function confirmSyncedSettingsImport(settingsStore: BridgeSettingsStore): Promise<boolean> {
  const viewState = await settingsStore.getViewState();
  const locale = resolveManagerLocale(viewState.settings.manager.language, vscode.env.language);
  const text = getManagerText(locale);
  const result = await vscode.window.showWarningMessage(
    text.actions.importSyncedSettingsConfirmation,
    { modal: true, detail: text.actions.importSyncedSettingsConfirmationDetail },
    text.actions.importSyncedSettings,
  );

  return result === text.actions.importSyncedSettings;
}

async function promptForEncryptionPassphrase(settingsStore: BridgeSettingsStore, mode: 'export' | 'import'): Promise<string | undefined> {
  const viewState = await settingsStore.getViewState();
  const locale = resolveManagerLocale(viewState.settings.manager.language, vscode.env.language);
  const text = getManagerText(locale);
  const firstPrompt = mode === 'export'
    ? text.actions.exportApiKeysPassphrasePrompt
    : text.actions.importApiKeysPassphrasePrompt;
  const passphrase = await vscode.window.showInputBox({
    prompt: firstPrompt,
    password: true,
    ignoreFocusOut: true,
  });

  if (passphrase === undefined || !passphrase.trim()) {
    return undefined;
  }

  if (mode === 'import') {
    return passphrase;
  }

  const confirmation = await vscode.window.showInputBox({
    prompt: text.actions.exportApiKeysPassphraseConfirmationPrompt,
    password: true,
    ignoreFocusOut: true,
  });
  if (confirmation === undefined) {
    return undefined;
  }

  if (confirmation !== passphrase) {
    void vscode.window.showErrorMessage(text.actions.passphraseMismatch);
    return undefined;
  }

  return passphrase;
}

function formatManagerMessage(template: string, endpointName: string): string {
  return template.replaceAll('{name}', endpointName);
}

function escapeJsString(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('`', '\\`')
    .replaceAll('${', '\\${');
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function sanitizeConnectionTestRequest(message: unknown): {
  endpointId: string;
  endpointName: string;
  endpointType: BackendEndpointType;
  baseUrl: string;
} | undefined {
  if (!message || typeof message !== 'object') {
    return undefined;
  }

  const endpointId = asString((message as { endpointId?: unknown }).endpointId);
  if (!endpointId) {
    return undefined;
  }

  const endpointName = asString((message as { endpointName?: unknown }).endpointName) || endpointId;
  const endpointType = normalizeBackendEndpointType(asString((message as { endpointType?: unknown }).endpointType));
  const baseUrl = typeof (message as { baseUrl?: unknown }).baseUrl === 'string'
    ? (message as { baseUrl: string }).baseUrl.trim()
    : '';
  const localhostRewrite = normalizeBackendToggleMode(asString((message as { localhostRewrite?: unknown }).localhostRewrite));

  return {
    endpointId,
    endpointName,
    endpointType,
    baseUrl: getRuntimeEndpointBaseUrl({ baseUrl, localhostRewrite }),
  };
}

function normalizeBackendEndpointType(value: string | undefined): BackendEndpointType {
  return value === 'responses-api' || value === 'lm-studio' || value === 'lm-studio-responses' || value === 'lm-studio-rest' ? value : 'openai-compatible';
}

function normalizeBackendToggleMode(value: string | undefined): 'auto' | 'on' | 'off' {
  return value === 'on' || value === 'off' ? value : 'auto';
}

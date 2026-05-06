import * as vscode from 'vscode';

const CONNECTION_STATUS_STATE_KEY = 'ghccCustomProvider.endpointConnectionStatus.v1';

export type EndpointConnectionStatusSource = 'automatic' | 'manual';
export type EndpointConnectionStatusKind = 'running' | 'success' | 'error';
export type EndpointConnectionStatusFreshness = 'live' | 'stale';

export interface EndpointConnectionStatus {
  kind: EndpointConnectionStatusKind;
  source: EndpointConnectionStatusSource;
  checkedAt: number;
  freshness?: EndpointConnectionStatusFreshness;
  chatModelCount?: number;
  detail?: string;
}

export interface EndpointConnectionStatusChangeEvent {
  endpointId: string;
  status: EndpointConnectionStatus | null;
}

export class EndpointConnectionStatusStore {
  private readonly statuses = new Map<string, EndpointConnectionStatus>();
  private readonly changeEmitter = new vscode.EventEmitter<EndpointConnectionStatusChangeEvent>();

  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async initialize(): Promise<void> {
    const persisted = this.context.workspaceState.get<unknown>(CONNECTION_STATUS_STATE_KEY);
    this.statuses.clear();

    for (const [endpointId, status] of sanitizePersistedStatuses(persisted)) {
      this.statuses.set(endpointId, status);
    }
  }

  get(endpointId: string): EndpointConnectionStatus | undefined {
    const status = this.statuses.get(endpointId);
    return status ? cloneStatus(status) : undefined;
  }

  getAll(): Record<string, EndpointConnectionStatus> {
    return Object.fromEntries(
      [...this.statuses.entries()].map(([endpointId, status]) => [endpointId, cloneStatus(status)]),
    );
  }

  markRunning(endpointId: string, source: EndpointConnectionStatusSource): void {
    this.update(endpointId, {
      kind: 'running',
      source,
      checkedAt: Date.now(),
      freshness: 'live',
    }, { persist: false });
  }

  markSuccess(endpointId: string, source: EndpointConnectionStatusSource, chatModelCount: number): void {
    this.update(endpointId, {
      kind: 'success',
      source,
      checkedAt: Date.now(),
      freshness: 'live',
      chatModelCount,
    });
  }

  markError(endpointId: string, source: EndpointConnectionStatusSource, detail: string): void {
    this.update(endpointId, {
      kind: 'error',
      source,
      checkedAt: Date.now(),
      freshness: 'live',
      detail,
    });
  }

  replace(endpointId: string, status: EndpointConnectionStatus | null): void {
    if (!status) {
      this.clear(endpointId);
      return;
    }

    this.update(endpointId, cloneStatus(status), {
      persist: status.kind !== 'running',
    });
  }

  clear(endpointId: string): void {
    if (!this.statuses.delete(endpointId)) {
      return;
    }

    void this.persistStatuses();

    this.changeEmitter.fire({
      endpointId,
      status: null,
    });
  }

  private update(endpointId: string, status: EndpointConnectionStatus, options: { persist?: boolean } = {}): void {
    const clonedStatus = cloneStatus(status);
    this.statuses.set(endpointId, clonedStatus);
    if (options.persist !== false) {
      void this.persistStatuses();
    }

    this.changeEmitter.fire({
      endpointId,
      status: cloneStatus(clonedStatus),
    });
  }

  private async persistStatuses(): Promise<void> {
    const entries = [...this.statuses.entries()]
      .filter((entry): entry is [string, EndpointConnectionStatus] => entry[1].kind !== 'running')
      .map(([endpointId, status]) => [endpointId, cloneStatus({ ...status, freshness: 'live' })] as const);

    await this.context.workspaceState.update(CONNECTION_STATUS_STATE_KEY, Object.fromEntries(entries));
  }
}

function cloneStatus(status: EndpointConnectionStatus): EndpointConnectionStatus {
  return {
    ...status,
    freshness: status.freshness ?? 'live',
  };
}

function sanitizePersistedStatuses(raw: unknown): Array<readonly [string, EndpointConnectionStatus]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return [];
  }

  return Object.entries(raw)
    .map(([endpointId, value]) => sanitizePersistedStatus(endpointId, value))
    .filter((entry): entry is readonly [string, EndpointConnectionStatus] => Boolean(entry));
}

function sanitizePersistedStatus(endpointId: string, raw: unknown): readonly [string, EndpointConnectionStatus] | undefined {
  if (!endpointId.trim() || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }

  const source = raw as Partial<EndpointConnectionStatus>;
  if (!isStatusKind(source.kind) || !isStatusSource(source.source) || source.kind === 'running') {
    return undefined;
  }

  const status: EndpointConnectionStatus = {
    kind: source.kind,
    source: source.source,
    checkedAt: typeof source.checkedAt === 'number' && Number.isFinite(source.checkedAt) ? source.checkedAt : 0,
    freshness: 'stale',
    chatModelCount: typeof source.chatModelCount === 'number' && Number.isFinite(source.chatModelCount) ? source.chatModelCount : undefined,
    detail: typeof source.detail === 'string' ? source.detail : undefined,
  };

  return [endpointId, status];
}

function isStatusKind(value: unknown): value is EndpointConnectionStatusKind {
  return value === 'running' || value === 'success' || value === 'error';
}

function isStatusSource(value: unknown): value is EndpointConnectionStatusSource {
  return value === 'automatic' || value === 'manual';
}
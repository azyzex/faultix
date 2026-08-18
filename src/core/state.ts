import * as vscode from 'vscode';
import type { Incident } from './models';
import { getConfig } from './config';

type FingerprintStats = {
  count: number;
  firstSeen: string;
  lastSeen: string;
};

type HistoryRecord = {
  id: string;
  createdAt: string;
  kind: Incident['kind'];
  status: Incident['status'];
  title: string;
  fingerprint: Incident['fingerprint'];
};

type HistoryFile = {
  incidents: HistoryRecord[];
  fingerprints: Record<string, FingerprintStats>;
};

export class FaultixState {
  public latestIncident: Incident | undefined;

  private readonly statusBar: vscode.StatusBarItem;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.LogOutputChannel
  ) {
    this.statusBar = vscode.window.createStatusBarItem('faultix.status', vscode.StatusBarAlignment.Left, 100);
    this.statusBar.name = 'Faultix';
    this.statusBar.text = '$(error) Faultix: incident captured';
    this.statusBar.command = 'faultix.openLatestIncident';
    this.statusBar.tooltip = 'Open latest Faultix incident';
    this.statusBar.hide();

    this.context.subscriptions.push(this.statusBar);
  }

  public setLatestIncident(incident: Incident): Incident {
    this.latestIncident = incident;
    return incident;
  }

  public markLatestResolved(): void {
    if (!this.latestIncident) {
      return;
    }
    this.latestIncident.status = 'resolved';
    this.statusBar.hide();
  }

  public showStatusBar(): void {
    if (this.latestIncident?.status === 'unresolved') {
      this.statusBar.show();
    }
  }

  public getWorkspaceFolderUri(): vscode.Uri | undefined {
    const ws = vscode.workspace.workspaceFolders?.[0];
    return ws?.uri;
  }

  public getOutputDirUri(): vscode.Uri | undefined {
    const folder = this.getWorkspaceFolderUri();
    if (!folder) {
      return undefined;
    }
    const { outputDir } = getConfig();
    return vscode.Uri.joinPath(folder, outputDir);
  }

  public getLatestIncidentMarkdownUri(): vscode.Uri | undefined {
    const root = this.getOutputDirUri();
    if (!root) {
      return undefined;
    }
    return vscode.Uri.joinPath(root, 'latest', 'incident.md');
  }

  public async readHistory(): Promise<unknown> {
    if (!this.context.storageUri) {
      return { incidents: [], fingerprints: {} } satisfies HistoryFile;
    }
    const uri = vscode.Uri.joinPath(this.context.storageUri, 'faultix-history.json');
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const json = Buffer.from(bytes).toString('utf8');
      return JSON.parse(json);
    } catch {
      return { incidents: [], fingerprints: {} } satisfies HistoryFile;
    }
  }

  public async appendToHistory(incident: Incident): Promise<void> {
    if (!this.context.storageUri) {
      return;
    }
    await vscode.workspace.fs.createDirectory(this.context.storageUri);
    const uri = vscode.Uri.joinPath(this.context.storageUri, 'faultix-history.json');

    const existing = (await this.readHistory()) as Partial<HistoryFile>;
    const incidents: HistoryRecord[] = existing.incidents ?? [];
    const fingerprints: Record<string, FingerprintStats> = existing.fingerprints ?? {};

    const sig = incident.fingerprint.signature;
    const now = incident.createdAt;
    const prev = fingerprints[sig];
    const next: FingerprintStats = prev
      ? {
          count: prev.count + 1,
          firstSeen: prev.firstSeen <= now ? prev.firstSeen : now,
          lastSeen: now
        }
      : { count: 1, firstSeen: now, lastSeen: now };

    fingerprints[sig] = next;
    incident.fingerprint.count = next.count;
    incident.fingerprint.firstSeen = next.firstSeen;
    incident.fingerprint.lastSeen = next.lastSeen;

    const record: HistoryRecord = {
      id: incident.id,
      createdAt: incident.createdAt,
      kind: incident.kind,
      status: incident.status,
      title: incident.title,
      fingerprint: incident.fingerprint
    };

    incidents.unshift(record);
    const maxKeep = 200;
    const trimmed = incidents.slice(0, maxKeep);

    const text = JSON.stringify({ incidents: trimmed, fingerprints }, null, 2);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
  }
}

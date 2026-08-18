/**
 * Session and persisted state.
 *
 * Holds the current incident, maintains the fingerprint ledger that powers
 * repeat detection, and owns the status bar item. History lives in the
 * extension's own storage rather than in the workspace, so a repository never
 * gains files it did not ask for.
 */

import * as vscode from 'vscode';
import { getConfig } from './config';
import { coerceHistory, emptyHistory, toSummary } from './models';
import type { HistoryFile, Incident, IncidentSummary } from './models';
import { resolveWithinRoot } from '../analyze/paths';

const HISTORY_FILE = 'faultix-history.json';

export class FaultixState implements vscode.Disposable {
  public latestIncident: Incident | undefined;

  private readonly statusBar: vscode.StatusBarItem;
  private historyCache: HistoryFile | undefined;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.LogOutputChannel
  ) {
    this.statusBar = vscode.window.createStatusBarItem('faultix.status', vscode.StatusBarAlignment.Left, 100);
    this.statusBar.name = 'Faultix';
    this.statusBar.command = 'faultix.openLatestIncident';
    this.statusBar.hide();
    this.context.subscriptions.push(this.statusBar);
  }

  public dispose(): void {
    this.statusBar.dispose();
  }

  // --- Current incident ----------------------------------------------------

  public setLatestIncident(incident: Incident): void {
    this.latestIncident = incident;
    this.refreshStatusBar();
  }

  public markLatestResolved(): void {
    if (!this.latestIncident) {
      return;
    }
    this.latestIncident.status = 'resolved';
    this.refreshStatusBar();
  }

  public clearLatest(): void {
    this.latestIncident = undefined;
    this.refreshStatusBar();
  }

  private refreshStatusBar(): void {
    const incident = this.latestIncident;
    if (!incident || incident.status === 'resolved' || !getConfig().showStatusBar) {
      this.statusBar.hide();
      return;
    }

    const repeats = incident.fingerprint.count > 1 ? ` x${incident.fingerprint.count}` : '';
    this.statusBar.text = `$(bug) Faultix${repeats}`;
    this.statusBar.tooltip = new vscode.MarkdownString(
      `**${incident.summary ?? incident.title}**\n\nCaptured ${incident.createdAt}\n\nClick to open the brief.`
    );
    this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.statusBar.show();
  }

  // --- Paths ---------------------------------------------------------------

  public getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /**
   * Resolves the configured output directory, refusing any value that would
   * escape the workspace. Returns undefined when there is no safe target.
   */
  public getOutputDirUri(): vscode.Uri | undefined {
    const root = this.getWorkspaceRoot();
    if (!root) {
      return undefined;
    }

    const configured = getConfig().outputDir;
    const resolved = resolveWithinRoot(root, configured);
    if (!resolved) {
      this.output.warn(
        `Refusing to use faultix.output.dir "${configured}": it must be a relative path inside the workspace.`
      );
      return undefined;
    }

    return vscode.Uri.file(resolved);
  }

  public getLatestIncidentMarkdownUri(): vscode.Uri | undefined {
    const root = this.getOutputDirUri();
    return root ? vscode.Uri.joinPath(root, 'latest', 'incident.md') : undefined;
  }

  public getLatestPromptUri(): vscode.Uri | undefined {
    const root = this.getOutputDirUri();
    return root ? vscode.Uri.joinPath(root, 'latest', 'repair.prompt.md') : undefined;
  }

  // --- History -------------------------------------------------------------

  private get historyUri(): vscode.Uri | undefined {
    return this.context.storageUri ? vscode.Uri.joinPath(this.context.storageUri, HISTORY_FILE) : undefined;
  }

  public async readHistory(): Promise<HistoryFile> {
    if (this.historyCache) {
      return this.historyCache;
    }

    const uri = this.historyUri;
    if (!uri) {
      return emptyHistory();
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      this.historyCache = coerceHistory(JSON.parse(Buffer.from(bytes).toString('utf8')));
    } catch {
      // A missing or corrupt ledger is not worth surfacing; start fresh.
      this.historyCache = emptyHistory();
    }

    return this.historyCache;
  }

  /**
   * Records an incident and stamps its fingerprint with the running totals.
   * Called before rendering, so the brief can say "seen 6 times".
   */
  public async recordIncident(incident: Incident, archivePath?: string): Promise<void> {
    const history = await this.readHistory();
    const signature = incident.fingerprint.signature;
    const now = incident.createdAt;

    const previous = history.fingerprints[signature];
    const stats = previous
      ? {
          count: previous.count + 1,
          firstSeen: previous.firstSeen <= now ? previous.firstSeen : now,
          lastSeen: now,
          lastTitle: incident.title
        }
      : { count: 1, firstSeen: now, lastSeen: now, lastTitle: incident.title };

    history.fingerprints[signature] = stats;

    incident.fingerprint.count = stats.count;
    incident.fingerprint.firstSeen = stats.firstSeen;
    incident.fingerprint.lastSeen = stats.lastSeen;

    history.incidents.unshift(toSummary(incident, archivePath));
    const keep = Math.max(getConfig().keepHistory, 1);
    history.incidents = history.incidents.slice(0, keep);

    await this.writeHistory(history);
  }

  public async clearHistory(): Promise<void> {
    await this.writeHistory(emptyHistory());
  }

  public async recentIncidents(limit = 20): Promise<IncidentSummary[]> {
    return (await this.readHistory()).incidents.slice(0, limit);
  }

  private async writeHistory(history: HistoryFile): Promise<void> {
    this.historyCache = history;

    const uri = this.historyUri;
    if (!uri || !this.context.storageUri) {
      return;
    }

    try {
      await vscode.workspace.fs.createDirectory(this.context.storageUri);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(history, null, 2), 'utf8'));
    } catch (error) {
      this.output.warn(`Could not persist Faultix history: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

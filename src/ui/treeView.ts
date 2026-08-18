/**
 * The Faultix side panel.
 *
 * Shows the current failure as an expandable tree: the root cause, the files
 * worth opening, the parsed errors, and recent history. Every leaf that names
 * a file opens it at the right line, because the point of the panel is to get
 * you into the code, not to be read.
 */

import * as vscode from 'vscode';
import type { FaultixState } from '../core/state';
import type { Incident, IncidentSummary } from '../core/models';
import { describeKind } from '../analyze/classify';

type NodeKind = 'section' | 'error' | 'suspect' | 'info' | 'history' | 'empty';

export interface FaultixNode {
  kind: NodeKind;
  label: string;
  description?: string;
  tooltip?: string | vscode.MarkdownString;
  icon?: vscode.ThemeIcon;
  command?: vscode.Command;
  contextValue?: string;
  children?: FaultixNode[];
  collapsed?: boolean;
}

export class FaultixTreeDataProvider implements vscode.TreeDataProvider<FaultixNode> {
  private readonly changeEmitter = new vscode.EventEmitter<FaultixNode | undefined>();
  public readonly onDidChangeTreeData = this.changeEmitter.event;

  private history: IncidentSummary[] = [];

  public constructor(private readonly state: FaultixState) {}

  public refresh(): void {
    void this.state.recentIncidents(10).then((incidents) => {
      this.history = incidents;
      this.changeEmitter.fire(undefined);
    });
  }

  public getTreeItem(element: FaultixNode): vscode.TreeItem {
    const collapsibleState = element.children?.length
      ? element.collapsed
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.None;

    const item = new vscode.TreeItem(element.label, collapsibleState);
    item.description = element.description;
    item.tooltip = element.tooltip;
    item.iconPath = element.icon;
    item.command = element.command;
    item.contextValue = element.contextValue;
    return item;
  }

  public getChildren(element?: FaultixNode): FaultixNode[] {
    if (element) {
      return element.children ?? [];
    }

    const incident = this.state.latestIncident;
    if (!incident) {
      return [
        {
          kind: 'empty',
          label: 'No failures captured yet',
          description: 'Run a failing command',
          icon: new vscode.ThemeIcon('check-all'),
          tooltip: 'Faultix captures automatically when a command exits non-zero.'
        },
        ...this.historySection()
      ];
    }

    return [...incidentSections(incident), ...this.historySection()];
  }

  private historySection(): FaultixNode[] {
    if (!this.history.length) {
      return [];
    }

    return [
      {
        kind: 'section',
        label: 'Recent',
        icon: new vscode.ThemeIcon('history'),
        collapsed: true,
        children: this.history.map((entry) => ({
          kind: 'history',
          label: entry.summary ?? entry.title,
          description: `${entry.kind}${entry.count > 1 ? ` x${entry.count}` : ''}`,
          tooltip: new vscode.MarkdownString(`${entry.title}\n\n${entry.createdAt}`),
          icon: new vscode.ThemeIcon(entry.status === 'resolved' ? 'pass' : 'circle-outline')
        }))
      }
    ];
  }
}

function incidentSections(incident: Incident): FaultixNode[] {
  const nodes: FaultixNode[] = [];

  nodes.push({
    kind: 'section',
    label: incident.summary ?? incident.title,
    description: describeKind(incident.kind),
    tooltip: new vscode.MarkdownString(
      [
        `**${incident.title}**`,
        '',
        `Captured: ${incident.createdAt}`,
        `Fingerprint: \`${incident.fingerprint.signature}\``,
        `Seen: ${incident.fingerprint.count}x`
      ].join('\n')
    ),
    icon: new vscode.ThemeIcon(incident.status === 'resolved' ? 'pass' : 'error'),
    contextValue: 'faultix.incident',
    children: [
      {
        kind: 'info',
        label: 'Open brief',
        icon: new vscode.ThemeIcon('markdown'),
        command: { command: 'faultix.openLatestIncident', title: 'Open brief' }
      },
      {
        kind: 'info',
        label: 'Copy agent prompt',
        icon: new vscode.ThemeIcon('clippy'),
        command: { command: 'faultix.copyRepairPrompt', title: 'Copy agent prompt' }
      },
      ...(incident.command?.commandLine
        ? [
            {
              kind: 'info' as const,
              label: 'Re-run failing command',
              description: incident.command.commandLine,
              icon: new vscode.ThemeIcon('debug-restart'),
              command: { command: 'faultix.rerunLatestCommand', title: 'Re-run' }
            }
          ]
        : []),
      {
        kind: 'info',
        label: 'Mark resolved',
        icon: new vscode.ThemeIcon('check'),
        command: { command: 'faultix.markLatestResolved', title: 'Mark resolved' }
      }
    ]
  });

  const suspects = incident.suspects ?? [];
  if (suspects.length) {
    nodes.push({
      kind: 'section',
      label: 'Files to inspect',
      description: String(suspects.length),
      icon: new vscode.ThemeIcon('search'),
      children: suspects.map((suspect) => ({
        kind: 'suspect',
        label: suspect.file,
        description: suspect.line !== undefined ? `:${suspect.line} - ${suspect.score}` : String(suspect.score),
        tooltip: new vscode.MarkdownString(suspect.reasons.map((r) => `- ${r}`).join('\n')),
        icon: new vscode.ThemeIcon('file-code'),
        command: openFileCommand(suspect.absolutePath, suspect.line)
      }))
    });
  }

  const errors = incident.errors ?? [];
  if (errors.length) {
    nodes.push({
      kind: 'section',
      label: 'Parsed errors',
      description: String(errors.length),
      icon: new vscode.ThemeIcon('warning'),
      collapsed: true,
      children: errors.map((error) => ({
        kind: 'error',
        label: error.message,
        description: [error.code, error.file && error.line !== undefined ? `${error.file}:${error.line}` : error.file]
          .filter(Boolean)
          .join(' '),
        tooltip: error.message,
        icon: new vscode.ThemeIcon(error.severity === 'warning' ? 'warning' : 'error')
      }))
    });
  }

  return nodes;
}

/** Builds a command that opens a file at a line, or nothing when unavailable. */
function openFileCommand(absolutePath: string | undefined, line: number | undefined): vscode.Command | undefined {
  if (!absolutePath) {
    return undefined;
  }

  const uri = vscode.Uri.file(absolutePath);
  if (line === undefined) {
    return { command: 'vscode.open', title: 'Open file', arguments: [uri] };
  }

  // VS Code selections are zero-based; parsed line numbers are not.
  const position = new vscode.Position(Math.max(0, line - 1), 0);
  return {
    command: 'vscode.open',
    title: 'Open file at line',
    arguments: [uri, { selection: new vscode.Range(position, position) } satisfies vscode.TextDocumentShowOptions]
  };
}

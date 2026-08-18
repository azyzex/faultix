import * as vscode from 'vscode';
import type { FaultixState } from '../core/state';

type NodeKind = 'latest' | 'suspect' | 'meta';

interface FaultixNode {
  kind: NodeKind;
  label: string;
  description?: string;
  tooltip?: string;
  command?: vscode.Command;
  collapsibleState?: vscode.TreeItemCollapsibleState;
  children?: FaultixNode[];
}

export class FaultixTreeDataProvider implements vscode.TreeDataProvider<FaultixNode> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public constructor(private readonly state: FaultixState) {}

  public refresh(): void {
    this.changeEmitter.fire();
  }

  getTreeItem(element: FaultixNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, element.collapsibleState ?? vscode.TreeItemCollapsibleState.None);
    item.description = element.description;
    item.tooltip = element.tooltip;
    item.command = element.command;
    return item;
  }

  getChildren(element?: FaultixNode): vscode.ProviderResult<FaultixNode[]> {
    if (element?.children) {
      return element.children;
    }

    const latest = this.state.latestIncident;
    if (!latest) {
      return [
        {
          kind: 'meta',
          label: 'No incidents yet',
          description: 'Run a failing command or use “Create Repair Brief”.'
        }
      ];
    }

    const nodes: FaultixNode[] = [];

    nodes.push({
      kind: 'latest',
      label: latest.title,
      description: `${latest.kind} • ${latest.status} • ${latest.fingerprint.signature}`,
      tooltip: latest.createdAt,
      collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
      children: buildLatestChildren(latest)
    });

    return nodes;
  }
}

function buildLatestChildren(latest: NonNullable<FaultixState['latestIncident']>): FaultixNode[] {
  const nodes: FaultixNode[] = [];

  nodes.push({
    kind: 'meta',
    label: 'Open latest incident',
    command: { command: 'faultix.openLatestIncident', title: 'Open latest incident' }
  });

  if (latest.terminal?.commandLine) {
    nodes.push({
      kind: 'meta',
      label: 'Rerun failing command',
      description: latest.terminal.commandLine,
      command: { command: 'faultix.rerunLatestCommand', title: 'Rerun failing command' }
    });
  }

  if (latest.suspects.length) {
    nodes.push({
      kind: 'meta',
      label: 'Suspects',
      collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
      children: latest.suspects.map((s) => ({
        kind: 'suspect',
        label: vscode.workspace.asRelativePath(s.uri, false),
        description: `score ${Math.round(s.score)}`,
        tooltip: s.reasons.join('\n'),
        command: {
          command: 'vscode.open',
          title: 'Open suspect',
          arguments: [s.uri]
        }
      }))
    });
  }

  nodes.push({
    kind: 'meta',
    label: 'Mark resolved',
    command: { command: 'faultix.markLatestResolved', title: 'Mark resolved' }
  });

  return nodes;
}

import * as vscode from 'vscode';
import type { FaultixState } from '../core/state';
import type { Incident } from '../core/models';
import { getConfig } from '../core/config';

export async function writeLatestArtifacts(args: {
  context: vscode.ExtensionContext;
  state: FaultixState;
  incident: Incident;
  incidentMarkdown: string;
  promptMarkdown: string;
  output: vscode.LogOutputChannel;
}): Promise<void> {
  const cfg = getConfig();

  if (cfg.outputMode === 'clipboardOnly') {
    return;
  }

  if (cfg.outputMode === 'previewRequired') {
    const choice = await vscode.window.showWarningMessage(
      'Faultix captured an incident. Write repair brief artifacts to the workspace?',
      { modal: false },
      'Write files',
      'Cancel'
    );
    if (choice !== 'Write files') {
      return;
    }
  }

  const root = args.state.getOutputDirUri();
  if (!root) {
    args.output.warn('No workspace folder open; cannot write workspace artifacts.');
    return;
  }

  const latestDir = vscode.Uri.joinPath(root, 'latest');
  const historyDir = vscode.Uri.joinPath(root, 'history');

  await vscode.workspace.fs.createDirectory(latestDir);
  await vscode.workspace.fs.createDirectory(historyDir);

  const incidentJson = JSON.stringify(serializeIncident(args.incident), null, 2);

  await writeFile(latestDir, 'incident.md', args.incidentMarkdown, cfg.maxChars);
  await writeFile(latestDir, 'incident.json', incidentJson, cfg.maxChars);
  await writeFile(latestDir, 'repair.prompt.md', args.promptMarkdown, cfg.maxChars);

  // History bundle (json only for now)
  const stamp = args.incident.createdAt.replace(/[:.]/g, '-');
  const histName = `${stamp}_${args.incident.kind}_${args.incident.fingerprint.signature}.json`;
  await writeFile(historyDir, histName, incidentJson, cfg.maxChars);
}

async function writeFile(dir: vscode.Uri, name: string, contents: string, maxChars: number): Promise<void> {
  const uri = vscode.Uri.joinPath(dir, name);
  const slice = contents.length > maxChars ? contents.slice(0, maxChars) : contents;
  await vscode.workspace.fs.writeFile(uri, Buffer.from(slice, 'utf8'));
}

function serializeIncident(incident: Incident): unknown {
  return {
    ...incident,
    workspaceFolder: incident.workspaceFolder?.toString(),
    terminal: incident.terminal
      ? {
          ...incident.terminal,
          cwd: incident.terminal.cwd?.toString(),
          fileRefs: incident.terminal.fileRefs.map((r) => ({ ...r, uri: r.uri.toString() }))
        }
      : undefined,
    diagnostics: incident.diagnostics
      ? {
          ...incident.diagnostics,
          top: incident.diagnostics.top.map((d) => ({
            ...d,
            uri: d.uri.toString(),
            range: {
              start: { line: d.range.start.line, character: d.range.start.character },
              end: { line: d.range.end.line, character: d.range.end.character }
            }
          })),
          byFile: Array.from(incident.diagnostics.byFile.entries())
        }
      : undefined,
    suspects: incident.suspects.map((s) => ({ ...s, uri: s.uri.toString() }))
  };
}

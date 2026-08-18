/**
 * Artifact persistence.
 *
 * Writes the rendered brief into the workspace under the configured output
 * directory, keeping a `latest/` copy that always reflects the most recent
 * failure and an append-only `history/` archive.
 *
 * Three output modes are honoured, because writing files into someone's
 * repository without asking is a real imposition:
 *   autoWrite        - write immediately (default)
 *   previewRequired  - ask first
 *   clipboardOnly    - never touch the disk
 */

import * as vscode from 'vscode';
import type { FaultixConfig } from '../core/config';
import type { FaultixState } from '../core/state';
import type { Incident } from '../core/models';
import { truncateChars } from '../analyze/ansi';
import { buildIncidentMarkdown, buildRepairPrompt } from './templates';

export interface WriteResult {
  /** Absolute paths written, in order. */
  written: string[];
  /** Repository-relative path of the archived JSON, when one was kept. */
  archivePath?: string;
  skippedReason?: 'clipboard-only' | 'declined' | 'no-workspace';
}

export interface WriteArgs {
  state: FaultixState;
  incident: Incident;
  config: FaultixConfig;
  output: vscode.LogOutputChannel;
}

/** Renders the incident into its two documents plus the machine-readable form. */
export function renderIncident(incident: Incident): { markdown: string; prompt: string; json: string } {
  return {
    markdown: buildIncidentMarkdown(incident),
    prompt: buildRepairPrompt(incident),
    json: JSON.stringify(incident, null, 2)
  };
}

export async function writeArtifacts(args: WriteArgs): Promise<WriteResult> {
  const { config, incident, state, output } = args;

  if (config.outputMode === 'clipboardOnly') {
    return { written: [], skippedReason: 'clipboard-only' };
  }

  const root = state.getOutputDirUri();
  if (!root) {
    return { written: [], skippedReason: 'no-workspace' };
  }

  if (config.outputMode === 'previewRequired') {
    const choice = await vscode.window.showInformationMessage(
      'Faultix captured a failure. Write the repair brief into the workspace?',
      'Write files',
      'Not now'
    );
    if (choice !== 'Write files') {
      return { written: [], skippedReason: 'declined' };
    }
  }

  const rendered = renderIncident(incident);
  const latestDir = vscode.Uri.joinPath(root, 'latest');
  const written: string[] = [];

  await vscode.workspace.fs.createDirectory(latestDir);

  written.push(await writeFile(latestDir, 'incident.md', rendered.markdown, config.maxChars));
  written.push(await writeFile(latestDir, 'repair.prompt.md', rendered.prompt, config.maxChars));
  written.push(await writeFile(latestDir, 'incident.json', rendered.json, config.maxChars));

  let archivePath: string | undefined;
  if (config.keepHistory > 0) {
    const historyDir = vscode.Uri.joinPath(root, 'history');
    await vscode.workspace.fs.createDirectory(historyDir);

    const name = archiveName(incident);
    written.push(await writeFile(historyDir, name, rendered.json, config.maxChars));
    archivePath = `history/${name}`;

    await pruneHistory(historyDir, config.keepHistory, output);
  }

  output.info(`Wrote repair brief for ${incident.fingerprint.signature} (${written.length} files).`);
  return { written, archivePath };
}

/** Filenames sort chronologically and carry the signature for grepping. */
function archiveName(incident: Incident): string {
  const stamp = incident.createdAt.replace(/[:.]/g, '-');
  return `${stamp}_${incident.kind}_${incident.fingerprint.signature}.json`;
}

async function writeFile(dir: vscode.Uri, name: string, contents: string, maxChars: number): Promise<string> {
  const uri = vscode.Uri.joinPath(dir, name);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(truncateChars(contents, maxChars), 'utf8'));
  return uri.fsPath;
}

/**
 * Keeps the archive bounded. Without this, a workspace that fails often grows
 * an unbounded directory of JSON that nobody ever deletes.
 */
async function pruneHistory(dir: vscode.Uri, keep: number, output: vscode.LogOutputChannel): Promise<void> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    const files = entries
      .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.json'))
      .map(([name]) => name)
      .sort()
      .reverse();

    for (const stale of files.slice(keep)) {
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, stale), { useTrash: false });
    }
  } catch (error) {
    output.warn(`Could not prune Faultix history: ${error instanceof Error ? error.message : String(error)}`);
  }
}

import * as vscode from 'vscode';
import { createCaptureEngine } from './capture/captureEngine';
import { FaultixTreeDataProvider } from './ui/treeView';
import { FaultixState } from './core/state';
import type { Incident } from './core/models';
import { writeLatestArtifacts } from './output/writer';
import { buildRepairPromptMarkdown, buildIncidentMarkdown } from './output/markdown';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Faultix', { log: true });
  const state = new FaultixState(context, output);

  const treeProvider = new FaultixTreeDataProvider(state);
  vscode.window.registerTreeDataProvider('faultix.incidents', treeProvider);

  const captureEngine = createCaptureEngine({ context, state, output });
  context.subscriptions.push(captureEngine);

  context.subscriptions.push(
    captureEngine.onIncident(async (incident: Incident) => {
      await persistAndReveal(incident, state, treeProvider);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('faultix.createRepairBrief', async () => {
      const incident = await captureEngine.captureManual('Manual capture');
      if (!incident) {
        return;
      }
      // Persist is handled by the onIncident handler.
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('faultix.openLatestIncident', async () => {
      const uri = state.getLatestIncidentMarkdownUri();
      if (!uri) {
        void vscode.window.showWarningMessage('No incident has been captured yet.');
        return;
      }
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('faultix.copyLatestBrief', async () => {
      const latest = state.latestIncident;
      if (!latest) {
        void vscode.window.showWarningMessage('No incident has been captured yet.');
        return;
      }
      const md = buildIncidentMarkdown(latest);
      await vscode.env.clipboard.writeText(md);
      void vscode.window.showInformationMessage('Copied latest incident markdown to clipboard.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('faultix.rerunLatestCommand', async () => {
      const latest = state.latestIncident;
      if (!latest?.terminal?.commandLine?.trim()) {
        void vscode.window.showWarningMessage('Latest incident has no command line to rerun.');
        return;
      }

      const term = vscode.window.activeTerminal ?? vscode.window.createTerminal({ name: 'Faultix' });
      term.show(true);

      if (term.shellIntegration) {
        term.shellIntegration.executeCommand(latest.terminal.commandLine);
      } else {
        term.sendText(latest.terminal.commandLine, true);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('faultix.markLatestResolved', async () => {
      if (!state.latestIncident) {
        return;
      }
      state.markLatestResolved();
      treeProvider.refresh();
    })
  );

  async function persistAndReveal(
    incident: ReturnType<FaultixState['setLatestIncident']>,
    state: FaultixState,
    treeProvider: FaultixTreeDataProvider
  ): Promise<void> {
    const { incidentMarkdown, promptMarkdown } = {
      incidentMarkdown: buildIncidentMarkdown(incident),
      promptMarkdown: buildRepairPromptMarkdown(incident)
    };

    await writeLatestArtifacts({
      context,
      state,
      incident,
      incidentMarkdown,
      promptMarkdown,
      output
    });

    treeProvider.refresh();
    state.showStatusBar();
  }

  output.info('Faultix activated.');
}

export function deactivate(): void {
  // nothing
}

/**
 * Extension entry point.
 *
 * Wires the capture engine to persistence and the UI, and registers the
 * commands. Everything here is orchestration: no analysis, no rendering.
 */

import * as vscode from 'vscode';
import { getConfig } from './core/config';
import { FaultixState } from './core/state';
import type { Incident } from './core/models';
import { createCaptureEngine } from './capture/captureEngine';
import { RunStore } from './core/runStore';
import { findResolution } from './analyze/runLedger';
import { renderIncident, writeArtifacts } from './output/writer';
import { FaultixTreeDataProvider } from './ui/treeView';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Faultix', { log: true });
  context.subscriptions.push(output);

  const state = new FaultixState(context, output);
  context.subscriptions.push(state);

  const tree = new FaultixTreeDataProvider(state);
  context.subscriptions.push(vscode.window.registerTreeDataProvider('faultix.incidents', tree));

  const runs = new RunStore({ outputDir: () => state.getOutputDirUri(), output });
  context.subscriptions.push(runs);

  const engine = createCaptureEngine({ output, ledger: () => runs.read() });
  context.subscriptions.push(engine);

  context.subscriptions.push(
    engine.onIncident((incident) => {
      void handleIncident(incident);
    })
  );

  context.subscriptions.push(
    engine.onSuccessfulRun((run) => {
      void handleSuccess(run);
    })
  );

  /**
   * A command succeeded. Record it, and check whether it just resolved a
   * failure that was still open — the moment worth telling someone about.
   */
  async function handleSuccess(run: Parameters<Parameters<typeof engine.onSuccessfulRun>[0]>[0]): Promise<void> {
    try {
      const openSignature = state.latestIncident?.status === 'unresolved'
        ? state.latestIncident.fingerprint.signature
        : undefined;

      const ledger = await runs.record(RunStore.successRun(run));

      if (!openSignature) {
        return;
      }

      const resolution = findResolution(ledger, openSignature);
      if (!resolution || resolution.fixedAt !== ledger.runs[0]?.at) {
        return;
      }

      state.markLatestResolved();
      tree.refresh();

      if (!getConfig().notifyOnCapture) {
        return;
      }

      const files = resolution.likelyFixedBy.slice(0, 2).join(', ');
      const detail = files ? ` (you were editing ${files})` : '';
      void vscode.window.showInformationMessage(
        `Faultix: that failure is fixed after ${resolution.attempts} attempt${resolution.attempts === 1 ? '' : 's'}${detail}.`
      );
    } catch (error) {
      output.error(`Faultix failed to record a successful run: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Persist, render, reveal. The one path every capture takes. */
  async function handleIncident(incident: Incident): Promise<void> {
    try {
      const config = getConfig();

      // Recording first stamps the repeat count, so the brief can report it.
      await state.recordIncident(incident);
      state.setLatestIncident(incident);

      if (config.recordRuns) {
        await runs.record(RunStore.failureRun(incident));
      }

      const result = await writeArtifacts({ state, incident, config, output });
      if (result.archivePath) {
        // Patch the existing entry rather than recording again: a second
        // recordIncident would count this failure twice.
        await state.setArchivePath(incident.id, result.archivePath);
      }

      tree.refresh();

      if (config.openOnCapture) {
        await openLatestBrief();
      } else if (config.notifyOnCapture) {
        void notifyCaptured(incident);
      }
    } catch (error) {
      output.error(`Faultix failed to handle an incident: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    }
  }

  async function notifyCaptured(incident: Incident): Promise<void> {
    const repeats = incident.fingerprint.count > 1 ? ` (seen ${incident.fingerprint.count}x)` : '';
    const choice = await vscode.window.showInformationMessage(
      `Faultix: ${incident.summary ?? incident.title}${repeats}`,
      'Open brief',
      'Copy prompt'
    );

    if (choice === 'Open brief') {
      await openLatestBrief();
    } else if (choice === 'Copy prompt') {
      await copyPrompt();
    }
  }

  async function openLatestBrief(): Promise<void> {
    const uri = state.getLatestIncidentMarkdownUri();
    if (!uri) {
      await showLatestInUntitledDocument();
      return;
    }

    try {
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false });
    } catch {
      // The file may not exist in clipboardOnly mode or if the write was declined.
      await showLatestInUntitledDocument();
    }
  }

  /** Fallback for when nothing was written to disk. */
  async function showLatestInUntitledDocument(): Promise<void> {
    const incident = state.latestIncident;
    if (!incident) {
      void vscode.window.showInformationMessage('Faultix has not captured a failure yet.');
      return;
    }

    const document = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: renderIncident(incident).markdown
    });
    await vscode.window.showTextDocument(document, { preview: false });
  }

  async function copyPrompt(): Promise<void> {
    const incident = state.latestIncident;
    if (!incident) {
      void vscode.window.showWarningMessage('Faultix has not captured a failure yet.');
      return;
    }

    await vscode.env.clipboard.writeText(renderIncident(incident).prompt);
    void vscode.window.showInformationMessage('Faultix: repair prompt copied to the clipboard.');
  }

  const command = (name: string, run: () => Promise<void> | void): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(name, async () => {
        try {
          await run();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          output.error(`Command ${name} failed: ${message}`);
          void vscode.window.showErrorMessage(`Faultix: ${message}`);
        }
      })
    );
  };

  command('faultix.createRepairBrief', async () => {
    const incident = await engine.captureManual();
    if (!incident) {
      void vscode.window.showWarningMessage('Faultix could not capture the current state.');
    }
  });

  command('faultix.openLatestIncident', openLatestBrief);

  command('faultix.copyRepairPrompt', copyPrompt);

  command('faultix.copyLatestBrief', async () => {
    const incident = state.latestIncident;
    if (!incident) {
      void vscode.window.showWarningMessage('Faultix has not captured a failure yet.');
      return;
    }
    await vscode.env.clipboard.writeText(renderIncident(incident).markdown);
    void vscode.window.showInformationMessage('Faultix: brief copied to the clipboard.');
  });

  command('faultix.rerunLatestCommand', async () => {
    const commandLine = state.latestIncident?.command?.commandLine.trim();
    if (!commandLine) {
      void vscode.window.showWarningMessage('The latest incident has no command to re-run.');
      return;
    }

    const terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal({ name: 'Faultix' });
    terminal.show(true);

    if (terminal.shellIntegration) {
      terminal.shellIntegration.executeCommand(commandLine);
    } else {
      terminal.sendText(commandLine, true);
    }
  });

  command('faultix.markLatestResolved', () => {
    if (!state.latestIncident) {
      void vscode.window.showWarningMessage('Faultix has not captured a failure yet.');
      return;
    }
    state.markLatestResolved();
    tree.refresh();
  });

  command('faultix.openOutputFolder', async () => {
    const uri = state.getOutputDirUri();
    if (!uri) {
      void vscode.window.showWarningMessage('Faultix has no writable output folder for this workspace.');
      return;
    }
    await vscode.commands.executeCommand('revealFileInOS', uri);
  });

  command('faultix.clearHistory', async () => {
    const choice = await vscode.window.showWarningMessage(
      'Clear all recorded Faultix history? Repeat counts will reset.',
      { modal: true },
      'Clear'
    );
    if (choice !== 'Clear') {
      return;
    }
    await state.clearHistory();
    await runs.clear();
    state.clearLatest();
    tree.refresh();
    void vscode.window.showInformationMessage('Faultix history cleared.');
  });

  command('faultix.togglePause', () => {
    engine.setPaused(!engine.paused);
    void vscode.window.showInformationMessage(
      engine.paused ? 'Faultix: automatic capture paused.' : 'Faultix: automatic capture resumed.'
    );
  });

  tree.refresh();
  output.info('Faultix activated.');
}

export function deactivate(): void {
  // All disposables are registered on the extension context.
}

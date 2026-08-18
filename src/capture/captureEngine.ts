/**
 * Capture triggers.
 *
 * Watches the three places a failure surfaces in VS Code and turns each into a
 * call to `buildIncident`. This file owns the event plumbing and nothing else:
 * no parsing, no ranking, no rendering.
 *
 * Terminal reads start on the *start* event rather than the end event, because
 * several shells close the stream as the command finishes and a read begun
 * afterwards returns nothing.
 */

import * as vscode from 'vscode';
import { getConfig } from '../core/config';
import type { Incident } from '../core/models';
import { buildIncident } from './buildIncident';
import { snapshotDiagnostics } from './diagnosticsCapture';

export interface CaptureEngineDeps {
  output: vscode.LogOutputChannel;
}

export interface CaptureEngine extends vscode.Disposable {
  readonly onIncident: vscode.Event<Incident>;
  captureManual(): Promise<Incident | undefined>;
  /** True while automatic capture is suspended for this session. */
  readonly paused: boolean;
  setPaused(paused: boolean): void;
}

/** Debounce for diagnostics, which fire in bursts as a language server works. */
const DIAGNOSTICS_SETTLE_MS = 1500;

export function createCaptureEngine({ output }: CaptureEngineDeps): CaptureEngine {
  const disposables: vscode.Disposable[] = [];
  const incidentEmitter = new vscode.EventEmitter<Incident>();
  disposables.push(incidentEmitter);

  let paused = false;

  // --- Terminal ------------------------------------------------------------

  interface PendingExecution {
    output: Promise<string>;
    startedAt: number;
  }

  const pending = new WeakMap<vscode.TerminalShellExecution, PendingExecution>();

  disposables.push(
    vscode.window.onDidStartTerminalShellExecution((event) => {
      if (paused) {
        return;
      }
      const config = getConfig();
      if (!config.autoOnNonZeroExit) {
        return;
      }
      pending.set(event.execution, {
        output: readExecutionOutput(event.execution, config.maxChars),
        startedAt: Date.now()
      });
    })
  );

  disposables.push(
    vscode.window.onDidEndTerminalShellExecution(async (event) => {
      const record = pending.get(event.execution);
      pending.delete(event.execution);

      if (paused) {
        return;
      }

      const config = getConfig();
      if (!config.autoOnNonZeroExit) {
        return;
      }
      // Exit code 0 is success; undefined means the shell never reported one.
      if (event.exitCode === 0 || event.exitCode === undefined) {
        return;
      }

      const commandLine = event.execution.commandLine?.value?.trim();
      if (!commandLine) {
        return;
      }

      await guard(output, 'terminal capture', async () => {
        const incident = await buildIncident({
          trigger: 'terminal',
          config,
          rawOutput: record ? await record.output : '',
          commandLine,
          cwd: event.execution.cwd?.fsPath,
          exitCode: event.exitCode,
          durationMs: record ? Date.now() - record.startedAt : undefined
        });
        incidentEmitter.fire(incident);
      });
    })
  );

  // --- Tasks ---------------------------------------------------------------

  const taskStarts = new WeakMap<vscode.TaskExecution, number>();

  disposables.push(
    vscode.tasks.onDidStartTaskProcess((event) => {
      taskStarts.set(event.execution, Date.now());
    })
  );

  disposables.push(
    vscode.tasks.onDidEndTaskProcess(async (event) => {
      const startedAt = taskStarts.get(event.execution);
      taskStarts.delete(event.execution);

      if (paused) {
        return;
      }

      const config = getConfig();
      if (!config.autoOnTaskFailure) {
        return;
      }
      if (event.exitCode === 0 || event.exitCode === undefined) {
        return;
      }

      await guard(output, 'task capture', async () => {
        const incident = await buildIncident({
          trigger: 'task',
          config,
          taskName: event.execution.task.name,
          exitCode: event.exitCode,
          durationMs: startedAt ? Date.now() - startedAt : undefined
        });
        incidentEmitter.fire(incident);
      });
    })
  );

  // --- Diagnostics ---------------------------------------------------------

  // Tracked across events so a spike is measured against the previous settled
  // state rather than against whatever the language server emitted 5ms ago.
  let lastErrorCount = countErrors();
  let settleTimer: NodeJS.Timeout | undefined;

  disposables.push(
    vscode.languages.onDidChangeDiagnostics(() => {
      if (paused) {
        return;
      }
      if (!getConfig().autoOnDiagnosticsSpike) {
        return;
      }

      if (settleTimer) {
        clearTimeout(settleTimer);
      }
      settleTimer = setTimeout(() => {
        settleTimer = undefined;
        void onDiagnosticsSettled();
      }, DIAGNOSTICS_SETTLE_MS);
    })
  );

  disposables.push(
    new vscode.Disposable(() => {
      if (settleTimer) {
        clearTimeout(settleTimer);
      }
    })
  );

  async function onDiagnosticsSettled(): Promise<void> {
    const config = getConfig();
    const current = countErrors();
    const delta = current - lastErrorCount;
    lastErrorCount = current;

    if (delta < config.diagnosticsSpikeThreshold) {
      return;
    }

    await guard(output, 'diagnostics capture', async () => {
      const incident = await buildIncident({
        trigger: 'diagnostics',
        config,
        kindOverride: 'typecheck',
        titleOverride: `Diagnostics spike: +${delta} errors`
      });
      incidentEmitter.fire(incident);
    });
  }

  // --- Manual --------------------------------------------------------------

  async function captureManual(): Promise<Incident | undefined> {
    const config = getConfig();
    let incident: Incident | undefined;

    await guard(output, 'manual capture', async () => {
      incident = await buildIncident({
        trigger: 'manual',
        config,
        titleOverride: 'Manual capture'
      });
      incidentEmitter.fire(incident);
    });

    return incident;
  }

  return {
    onIncident: incidentEmitter.event,
    captureManual,
    get paused() {
      return paused;
    },
    setPaused(value: boolean) {
      paused = value;
      output.info(`Automatic capture ${value ? 'paused' : 'resumed'}.`);
    },
    dispose() {
      vscode.Disposable.from(...disposables).dispose();
    }
  };
}

function countErrors(): number {
  let errors = 0;
  for (const [, diagnostics] of vscode.languages.getDiagnostics()) {
    for (const diagnostic of diagnostics) {
      if (diagnostic.severity === vscode.DiagnosticSeverity.Error) {
        errors++;
      }
    }
  }
  return errors;
}

/**
 * Reads a shell execution's output stream.
 *
 * Bounded by `maxChars` so a runaway command cannot grow the buffer without
 * limit, and tolerant of shells whose integration does not support reading.
 */
async function readExecutionOutput(execution: vscode.TerminalShellExecution, maxChars: number): Promise<string> {
  const budget = Math.min(Math.max(maxChars, 2000), 200000);
  let text = '';

  try {
    for await (const chunk of execution.read()) {
      if (!chunk) {
        continue;
      }
      text += chunk;
      if (text.length >= budget) {
        break;
      }
    }
  } catch {
    // Shell integration is unavailable or the stream closed early; the
    // incident is still worth capturing from the command line alone.
  }

  return text;
}

/**
 * Runs a capture without ever letting it surface as an unhandled rejection.
 * A failed capture must never break the user's terminal or task.
 */
async function guard(output: vscode.LogOutputChannel, what: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    output.error(`Faultix ${what} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

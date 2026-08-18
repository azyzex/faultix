import * as vscode from 'vscode';
import type { FaultixState } from '../core/state';
import { getConfig } from '../core/config';
import type { Incident, IncidentKind, TerminalEvidence } from '../core/models';
import { redact } from '../privacy/redact';
import { snapshotDiagnostics } from './diagnosticsCapture';
import { extractCommandFileRefs, extractFileRefs, inferKindFromCommand, inferToolHint } from '../analyze/parse';
import { rankSuspects } from '../analyze/rank';
import { computeFingerprint } from '../analyze/fingerprint';
import { collectGitEvidence } from '../analyze/git';

export interface CaptureEngineDeps {
  context: vscode.ExtensionContext;
  state: FaultixState;
  output: vscode.LogOutputChannel;
}

export function createCaptureEngine({ context, state, output }: CaptureEngineDeps): vscode.Disposable & {
  captureManual: (reason: string) => Promise<Incident | undefined>;
  onIncident: vscode.Event<Incident>;
} {
  const disposables: vscode.Disposable[] = [];

  const incidentEmitter = new vscode.EventEmitter<Incident>();
  disposables.push(incidentEmitter);

  let lastDiagnosticsErrorCount = 0;

  const terminalOutputByExecution = new WeakMap<vscode.TerminalShellExecution, Promise<string>>();

  const onStart = vscode.window.onDidStartTerminalShellExecution((e: vscode.TerminalShellExecutionStartEvent) => {
    const cfg = getConfig();
    if (!cfg.autoOnNonZeroExit) {
      return;
    }
    // Start reading immediately; some shells don't allow reading after the end event.
    const maxChars = Math.min(cfg.maxChars, 50000);
    terminalOutputByExecution.set(e.execution, readExecutionOutput(e.execution, maxChars));
  });

  const onEnd = vscode.window.onDidEndTerminalShellExecution(async (e: vscode.TerminalShellExecutionEndEvent) => {
    const pendingOutput = terminalOutputByExecution.get(e.execution);
    terminalOutputByExecution.delete(e.execution);

    const cfg = getConfig();
    if (!cfg.autoOnNonZeroExit) {
      return;
    }
    if (e.exitCode === 0) {
      return;
    }

    const rawOutput = pendingOutput
      ? await pendingOutput
      : await readExecutionOutput(e.execution, Math.min(cfg.maxChars, 50000));

    const incident = await captureFromTerminalEndEvent(e, context, output, rawOutput);
    if (!incident) {
      return;
    }

    state.setLatestIncident(incident);
    await state.appendToHistory(incident);
    incidentEmitter.fire(incident);
  });

  const onDiagnostics = vscode.languages.onDidChangeDiagnostics(async () => {
    const cfg = getConfig();
    if (!cfg.autoOnDiagnosticsSpike) {
      return;
    }

    const diag = snapshotDiagnostics(cfg.maxDiagnostics);
    const delta = diag.errors - lastDiagnosticsErrorCount;
    lastDiagnosticsErrorCount = diag.errors;

    if (delta < cfg.diagnosticsSpikeThreshold) {
      return;
    }

    const incident = await buildIncident({
      kind: 'typecheck',
      title: `Diagnostics spike (+${delta} errors)`,
      terminal: undefined,
      output,
      context
    });

    state.setLatestIncident(incident);
    await state.appendToHistory(incident);
    incidentEmitter.fire(incident);
  });

  const taskStarts = new WeakMap<vscode.TaskExecution, { taskName: string; startedAt: string }>();

  const onTaskStart = vscode.tasks.onDidStartTaskProcess((e) => {
    taskStarts.set(e.execution, { taskName: e.execution.task.name, startedAt: new Date().toISOString() });
  });

  const onTaskEnd = vscode.tasks.onDidEndTaskProcess(async (e) => {
    const cfg = getConfig();
    if (!cfg.autoOnNonZeroExit) {
      return;
    }

    const exitCode = e.exitCode;
    if (exitCode === 0 || exitCode === undefined || exitCode === null) {
      return;
    }

    const taskName = e.execution.task.name;
    const kind = inferKindFromTaskName(taskName);

    const started = taskStarts.get(e.execution);

    const incident = await buildIncident({
      kind,
      title: `Task failed (${exitCode}): ${taskName}`,
      terminal: undefined,
      output,
      context
    });

    if (started?.startedAt) {
      // best-effort: enrich id uniqueness by leaving title as-is; timestamps already included in incident.id
      void started;
    }

    state.setLatestIncident(incident);
    await state.appendToHistory(incident);
    incidentEmitter.fire(incident);
  });

  disposables.push(onStart, onEnd, onDiagnostics, onTaskStart, onTaskEnd);

  async function captureManual(reason: string): Promise<Incident | undefined> {
    const cfg = getConfig();
    const last = state.latestIncident;
    const kind: IncidentKind = last?.kind ?? 'unknown';

    const incident = await buildIncident({
      kind,
      title: reason,
      terminal: last?.terminal,
      output,
      context
    });

    state.setLatestIncident(incident);
    await state.appendToHistory(incident);
    incidentEmitter.fire(incident);
    return incident;
  }

  return Object.assign(vscode.Disposable.from(...disposables), {
    captureManual,
    onIncident: incidentEmitter.event
  });
}

function inferKindFromTaskName(name: string): IncidentKind {
  const s = name.toLowerCase();
  if (s.includes('test') || s.includes('jest') || s.includes('vitest') || s.includes('pytest')) {
    return 'test';
  }
  if (s.includes('lint') || s.includes('eslint') || s.includes('pylint') || s.includes('ruff')) {
    return 'lint';
  }
  if (s.includes('typecheck') || s.includes('tsc') || s.includes('mypy')) {
    return 'typecheck';
  }
  if (s.includes('build') || s.includes('compile') || s.includes('bundle')) {
    return 'build';
  }
  if (s.includes('install') || s.includes('npm install') || s.includes('pnpm install') || s.includes('yarn install')) {
    return 'packageinstall';
  }
  return 'unknown';
}

async function captureFromTerminalEndEvent(
  e: vscode.TerminalShellExecutionEndEvent,
  context: vscode.ExtensionContext,
  output: vscode.LogOutputChannel,
  rawOutputOverride?: string
): Promise<Incident | undefined> {
  const cfg = getConfig();

  const commandLine = e.execution.commandLine?.value ?? '';
  if (!commandLine.trim()) {
    return undefined;
  }

  const kind = inferKindFromCommand(commandLine);
  const toolHint = inferToolHint(commandLine);

  const rawOutput = rawOutputOverride ?? (await readExecutionOutput(e.execution, Math.min(cfg.maxChars, 50000)));
  const safeOutput = cfg.redactSecrets ? redact(rawOutput) : rawOutput;

  const excerpt = excerptLines(safeOutput, cfg.maxTerminalLines);
  const fileRefsFromOutput = extractFileRefs(excerpt, context);
  const fileRefsFromCommand = extractCommandFileRefs(commandLine, context);

  const fileRefs: TerminalEvidence['fileRefs'] = [];
  const seen = new Set<string>();
  for (const ref of [...fileRefsFromOutput, ...fileRefsFromCommand]) {
    const key = ref.uri.toString();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    fileRefs.push(ref);
  }

  const terminal: TerminalEvidence = {
    commandLine,
    cwd: e.execution.cwd,
    exitCode: e.exitCode,
    toolHint,
    excerpt,
    fileRefs
  };

  return await buildIncident({
    kind,
    title: `Command failed (${e.exitCode}): ${commandLine}`,
    terminal,
    output,
    context
  });
}

async function buildIncident(args: {
  kind: IncidentKind;
  title: string;
  terminal: TerminalEvidence | undefined;
  output: vscode.LogOutputChannel;
  context: vscode.ExtensionContext;
}): Promise<Incident> {
  const cfg = getConfig();
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

  const diagnostics = snapshotDiagnostics(cfg.maxDiagnostics);
  const git = await collectGitEvidence({ enabled: cfg.gitEnabled, workspaceFolder: workspaceFolder?.uri });

  const suspects = rankSuspects({ terminal: args.terminal, diagnostics, git, workspaceFolder: workspaceFolder?.uri });
  const fingerprint = computeFingerprint({ kind: args.kind, terminal: args.terminal, diagnostics, suspects });

  const id = `${new Date().toISOString()}_${fingerprint.signature}`;

  return {
    id,
    createdAt: new Date().toISOString(),
    kind: args.kind,
    status: 'unresolved',
    title: args.title,
    workspaceName: vscode.workspace.name,
    workspaceFolder: workspaceFolder?.uri,
    terminal: args.terminal,
    diagnostics,
    git,
    suspects,
    fingerprint
  };
}

async function readExecutionOutput(execution: vscode.TerminalShellExecution, maxChars: number): Promise<string> {
  let text = '';
  try {
    for await (const chunk of execution.read()) {
      if (!chunk) {
        continue;
      }
      text += chunk;
      if (text.length >= maxChars) {
        break;
      }
    }
  } catch {
    // If read() fails or isn't supported, fall back to empty output.
  }
  return text;
}

function excerptLines(text: string, maxLines: number): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length <= maxLines) {
    return lines.join('\n');
  }
  const tail = lines.slice(-maxLines);
  return tail.join('\n');
}

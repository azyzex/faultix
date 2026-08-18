/**
 * VS Code adapter for the analysis pipeline.
 *
 * Gathers the things only the editor knows — open diagnostics, the workspace
 * folder, whether the workspace is trusted — and hands them to
 * `analyzeFailure`, which does the actual work and has no `vscode` import.
 *
 * Everything that makes a decision lives in the pipeline. If logic starts
 * accumulating here, it belongs on the other side of that boundary.
 */

import * as vscode from 'vscode';

import { analyzeFailure } from '../analyze/pipeline';
import type { AnalysisOptions, AnalyzeInput } from '../analyze/pipeline';
import { collectGitEvidence } from '../analyze/git';
import type { IncidentKind } from '../analyze/classify';
import type { FaultixConfig } from '../core/config';
import type { Incident, IncidentTrigger } from '../core/models';
import { snapshotDiagnostics } from './diagnosticsCapture';

export interface BuildIncidentInput {
  trigger: IncidentTrigger;
  config: FaultixConfig;
  /** Raw, unsanitized terminal text, when the trigger produced any. */
  rawOutput?: string;
  commandLine?: string;
  cwd?: string;
  exitCode?: number;
  taskName?: string;
  durationMs?: number;
  /** Overrides the derived title, used by diagnostics-spike captures. */
  titleOverride?: string;
  kindOverride?: IncidentKind;
}

/** Projects user settings onto the options the pipeline reads. */
export function toAnalysisOptions(config: FaultixConfig, allowFileReads: boolean): AnalysisOptions {
  return {
    maxChars: config.maxChars,
    maxTerminalLines: config.maxTerminalLines,
    maxErrors: config.maxErrors,
    maxSuspects: config.maxSuspects,
    maxSnippets: config.maxSnippets,
    snippetContextLines: config.snippetContextLines,
    redactSecrets: config.redactSecrets,
    redactEmails: config.redactEmails,
    anonymizePaths: config.anonymizePaths,
    ignoredSegments: config.ignoredSegments,
    allowFileReads
  };
}

export async function buildIncident(input: BuildIncidentInput): Promise<Incident> {
  const { config } = input;
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // In an untrusted workspace, running git and reading arbitrary files are both
  // side effects the user has explicitly declined. Capture still works; the
  // brief just carries less context.
  const trusted = vscode.workspace.isTrusted;

  const diagnostics = snapshotDiagnostics(config.maxDiagnostics, workspaceRoot);
  const git = await collectGitEvidence({ enabled: config.gitEnabled && trusted, workspaceRoot });

  const analyzeInput: AnalyzeInput = {
    trigger: input.trigger,
    options: toAnalysisOptions(config, trusted),
    rawOutput: input.rawOutput,
    commandLine: input.commandLine,
    cwd: input.cwd,
    exitCode: input.exitCode,
    taskName: input.taskName,
    durationMs: input.durationMs,
    titleOverride: input.titleOverride,
    kindOverride: input.kindOverride,
    workspaceRoot,
    workspaceName: vscode.workspace.name,
    diagnostics,
    git
  };

  return analyzeFailure(analyzeInput);
}

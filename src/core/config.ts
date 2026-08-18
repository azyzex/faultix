/**
 * Settings access.
 *
 * Reads `faultix.*` once per capture and hands the rest of the extension a
 * plain object. Values are clamped here rather than trusted, because a user
 * setting is untrusted input: a negative limit or a traversing output path
 * must not reach the filesystem layer.
 */

import * as vscode from 'vscode';

export type OutputMode = 'autoWrite' | 'previewRequired' | 'clipboardOnly';

export interface FaultixConfig {
  autoOnNonZeroExit: boolean;
  autoOnTaskFailure: boolean;
  autoOnDiagnosticsSpike: boolean;
  diagnosticsSpikeThreshold: number;

  outputMode: OutputMode;
  outputDir: string;
  keepHistory: number;

  maxChars: number;
  maxTerminalLines: number;
  maxDiagnostics: number;
  maxErrors: number;
  maxSuspects: number;
  maxSnippets: number;
  snippetContextLines: number;

  redactSecrets: boolean;
  redactEmails: boolean;
  anonymizePaths: boolean;

  gitEnabled: boolean;
  ignoredSegments: string[];

  openOnCapture: boolean;
  showStatusBar: boolean;
  notifyOnCapture: boolean;
}

/** Clamps a number into range, falling back when the value is not usable. */
function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function getConfig(scope?: vscode.ConfigurationScope): FaultixConfig {
  const cfg = vscode.workspace.getConfiguration('faultix', scope);

  return {
    autoOnNonZeroExit: cfg.get<boolean>('capture.autoOnNonZeroExit', true),
    autoOnTaskFailure: cfg.get<boolean>('capture.autoOnTaskFailure', true),
    autoOnDiagnosticsSpike: cfg.get<boolean>('capture.autoOnDiagnosticsSpike', true),
    diagnosticsSpikeThreshold: clamp(cfg.get('capture.diagnosticsSpikeThreshold'), 1, 10000, 10),

    outputMode: cfg.get<OutputMode>('output.mode', 'autoWrite'),
    outputDir: cfg.get<string>('output.dir', '.ai-repair'),
    keepHistory: clamp(cfg.get('output.keepHistory'), 0, 1000, 50),

    maxChars: clamp(cfg.get('output.maxChars'), 2000, 1000000, 60000),
    maxTerminalLines: clamp(cfg.get('output.maxTerminalLines'), 10, 5000, 200),
    maxDiagnostics: clamp(cfg.get('output.maxDiagnostics'), 0, 1000, 50),
    maxErrors: clamp(cfg.get('output.maxErrors'), 1, 200, 20),
    maxSuspects: clamp(cfg.get('output.maxSuspects'), 1, 50, 8),
    maxSnippets: clamp(cfg.get('output.maxSnippets'), 0, 20, 3),
    snippetContextLines: clamp(cfg.get('output.snippetContextLines'), 0, 50, 6),

    redactSecrets: cfg.get<boolean>('privacy.redactSecrets', true),
    redactEmails: cfg.get<boolean>('privacy.redactEmails', false),
    anonymizePaths: cfg.get<boolean>('privacy.anonymizeHomePaths', true),

    gitEnabled: cfg.get<boolean>('git.enabled', true),
    ignoredSegments: cfg.get<string[]>('analysis.ignoredFolders', []) ?? [],

    openOnCapture: cfg.get<boolean>('ui.openOnCapture', false),
    showStatusBar: cfg.get<boolean>('ui.showStatusBar', true),
    notifyOnCapture: cfg.get<boolean>('ui.notifyOnCapture', true)
  };
}

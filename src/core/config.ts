import * as vscode from 'vscode';

export type OutputMode = 'autoWrite' | 'previewRequired' | 'clipboardOnly';

export interface FaultixConfig {
  autoOnNonZeroExit: boolean;
  autoOnDiagnosticsSpike: boolean;
  diagnosticsSpikeThreshold: number;
  outputMode: OutputMode;
  outputDir: string;
  maxChars: number;
  maxTerminalLines: number;
  maxDiagnostics: number;
  redactSecrets: boolean;
  gitEnabled: boolean;
}

export function getConfig(): FaultixConfig {
  const cfg = vscode.workspace.getConfiguration('faultix');
  return {
    autoOnNonZeroExit: cfg.get<boolean>('capture.autoOnNonZeroExit', true),
    autoOnDiagnosticsSpike: cfg.get<boolean>('capture.autoOnDiagnosticsSpike', true),
    diagnosticsSpikeThreshold: cfg.get<number>('capture.diagnosticsSpikeThreshold', 10),
    outputMode: cfg.get<OutputMode>('output.mode', 'autoWrite'),
    outputDir: cfg.get<string>('output.dir', '.ai-repair'),
    maxChars: cfg.get<number>('output.maxChars', 60000),
    maxTerminalLines: cfg.get<number>('output.maxTerminalLines', 200),
    maxDiagnostics: cfg.get<number>('output.maxDiagnostics', 100),
    redactSecrets: cfg.get<boolean>('privacy.redactSecrets', true),
    gitEnabled: cfg.get<boolean>('git.enabled', true)
  };
}

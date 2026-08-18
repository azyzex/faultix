import * as vscode from 'vscode';

export type IncidentKind =
  | 'build'
  | 'test'
  | 'runtime'
  | 'lint'
  | 'typecheck'
  | 'packageinstall'
  | 'debug-session'
  | 'unknown';

export type IncidentStatus = 'unresolved' | 'resolved';

export interface TerminalEvidence {
  commandLine: string;
  cwd?: vscode.Uri;
  exitCode?: number;
  toolHint?: string;
  excerpt: string;
  fileRefs: Array<{ uri: vscode.Uri; line?: number; col?: number; raw: string }>;
}

export interface DiagnosticsEvidence {
  total: number;
  errors: number;
  warnings: number;
  top: Array<{
    uri: vscode.Uri;
    severity: vscode.DiagnosticSeverity;
    source?: string;
    message: string;
    range: vscode.Range;
  }>;
  byFile: Map<string, { errors: number; warnings: number }>;
}

export interface GitEvidence {
  enabled: boolean;
  insideWorkTree: boolean;
  branch?: string;
  isDirty?: boolean;
  changedFiles?: string[];
  diffStat?: string;
}

export interface Suspect {
  uri: vscode.Uri;
  score: number;
  reasons: string[];
}

export interface Fingerprint {
  signature: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
}

export interface Incident {
  id: string;
  createdAt: string;
  kind: IncidentKind;
  status: IncidentStatus;
  title: string;

  workspaceName?: string;
  workspaceFolder?: vscode.Uri;

  terminal?: TerminalEvidence;
  diagnostics?: DiagnosticsEvidence;
  git?: GitEvidence;

  suspects: Suspect[];
  fingerprint: Fingerprint;
}

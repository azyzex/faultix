import * as vscode from 'vscode';
import type { DiagnosticsEvidence, GitEvidence, Suspect, TerminalEvidence } from '../core/models';

export function rankSuspects(args: {
  terminal: TerminalEvidence | undefined;
  diagnostics: DiagnosticsEvidence | undefined;
  git: GitEvidence | undefined;
  workspaceFolder: vscode.Uri | undefined;
}): Suspect[] {
  const scores = new Map<string, { uri: vscode.Uri; score: number; reasons: string[] }>();

  const add = (uri: vscode.Uri, delta: number, reason: string): void => {
    const key = uri.toString();
    const current = scores.get(key) ?? { uri, score: 0, reasons: [] };
    current.score += delta;
    current.reasons.push(reason);
    scores.set(key, current);
  };

  if (args.terminal) {
    for (const ref of args.terminal.fileRefs) {
      const isCmdRef = ref.raw.startsWith('commandLine:');
      add(ref.uri, 50, isCmdRef ? `Referenced in command line (${ref.raw})` : `Mentioned in terminal output (${ref.raw})`);
    }
  }

  if (args.diagnostics) {
    for (const [uriString, counts] of args.diagnostics.byFile.entries()) {
      const uri = vscode.Uri.parse(uriString);
      if (counts.errors > 0) {
        add(uri, 40 + Math.min(counts.errors, 5) * 5, `${counts.errors} error diagnostics`);
      }
      if (counts.warnings > 0) {
        add(uri, 10 + Math.min(counts.warnings, 5) * 2, `${counts.warnings} warning diagnostics`);
      }
    }
  }

  // Git evidence (changed files)
  if (args.git?.changedFiles?.length) {
    for (const f of args.git.changedFiles) {
      const uri = args.workspaceFolder ? vscode.Uri.joinPath(args.workspaceFolder, f) : undefined;
      if (!uri) {
        continue;
      }
      add(uri, 20, 'Changed in git working tree');
    }
  }

  const suspects = Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((s) => ({ uri: s.uri, score: s.score, reasons: unique(s.reasons) }));

  return suspects;
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items));
}

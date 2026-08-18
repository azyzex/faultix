import * as vscode from 'vscode';
import type { Incident } from '../core/models';

export function buildIncidentMarkdown(incident: Incident): string {
  const lines: string[] = [];

  lines.push(`# Faultix Incident`);
  lines.push('');
  lines.push(`- **Created**: ${incident.createdAt}`);
  lines.push(`- **Kind**: ${incident.kind}`);
  lines.push(`- **Status**: ${incident.status}`);
  if (incident.workspaceName) {
    lines.push(`- **Workspace**: ${incident.workspaceName}`);
  }
  lines.push('');

  lines.push(`## What failed`);
  lines.push('');
  lines.push(incident.title);
  lines.push('');

  if (incident.terminal) {
    lines.push('## Terminal');
    lines.push('');
    lines.push(`- **Command**: \`${incident.terminal.commandLine}\``);
    if (incident.terminal.exitCode !== undefined) {
      lines.push(`- **Exit code**: ${incident.terminal.exitCode}`);
    }
    if (incident.terminal.toolHint) {
      lines.push(`- **Tool hint**: ${incident.terminal.toolHint}`);
    }
    lines.push('');
    lines.push('```text');
    lines.push(incident.terminal.excerpt.trimEnd());
    lines.push('```');
    lines.push('');
  }

  if (incident.diagnostics) {
    lines.push('## Diagnostics');
    lines.push('');
    lines.push(`- Total: ${incident.diagnostics.total}`);
    lines.push(`- Errors: ${incident.diagnostics.errors}`);
    lines.push(`- Warnings: ${incident.diagnostics.warnings}`);
    lines.push('');

    const top = incident.diagnostics.top.slice(0, 20);
    if (top.length) {
      lines.push('### Top');
      lines.push('');
      for (const d of top) {
        const file = vscode.workspace.asRelativePath(d.uri, false);
        const sev = severityLabel(d.severity);
        lines.push(`- ${sev} ${file}: ${oneLine(d.message)}`);
      }
      lines.push('');
    }
  }

  lines.push('## Suspects');
  lines.push('');
  if (!incident.suspects.length) {
    lines.push('_No suspects ranked yet._');
  } else {
    for (const s of incident.suspects) {
      const file = vscode.workspace.asRelativePath(s.uri, false);
      lines.push(`- **${file}** (score ${Math.round(s.score)})`);
      for (const r of s.reasons.slice(0, 3)) {
        lines.push(`  - ${r}`);
      }
    }
  }
  lines.push('');

  if (incident.git?.insideWorkTree) {
    lines.push('## Git');
    lines.push('');
    if (incident.git.branch) {
      lines.push(`- Branch: ${incident.git.branch}`);
    }
    if (incident.git.isDirty !== undefined) {
      lines.push(`- Dirty: ${incident.git.isDirty}`);
    }
    if (incident.git.diffStat) {
      lines.push('');
      lines.push('```text');
      lines.push(incident.git.diffStat.trimEnd());
      lines.push('```');
      lines.push('');
    }
  }

  lines.push('## Fingerprint');
  lines.push('');
  lines.push(`- Signature: ${incident.fingerprint.signature}`);
  lines.push(`- Seen: ${incident.fingerprint.count} time(s)`);
  lines.push(`- First seen: ${incident.fingerprint.firstSeen}`);
  lines.push(`- Last seen: ${incident.fingerprint.lastSeen}`);

  return lines.join('\n');
}

export function buildRepairPromptMarkdown(incident: Incident): string {
  const lines: string[] = [];
  lines.push('# Repair Brief');
  lines.push('');
  lines.push('You are fixing a codebase based on this local incident packet.');
  lines.push('');
  lines.push('## Goal');
  lines.push(oneLine(incident.title));
  lines.push('');

  if (incident.terminal?.commandLine) {
    lines.push('## Repro');
    lines.push('');
    lines.push('Run:');
    lines.push('```sh');
    lines.push(incident.terminal.commandLine);
    lines.push('```');
    lines.push('');
  }

  lines.push('## Best current suspects');
  lines.push('');
  for (const s of incident.suspects.slice(0, 5)) {
    lines.push(`- ${vscode.workspace.asRelativePath(s.uri, false)} (${Math.round(s.score)}): ${s.reasons.slice(0, 2).join('; ')}`);
  }
  lines.push('');

  if (incident.terminal?.excerpt) {
    lines.push('## Terminal excerpt');
    lines.push('');
    lines.push('```text');
    lines.push(incident.terminal.excerpt.trimEnd());
    lines.push('```');
    lines.push('');
  }

  if (incident.diagnostics?.top?.length) {
    lines.push('## Diagnostics');
    lines.push('');
    for (const d of incident.diagnostics.top.slice(0, 20)) {
      lines.push(`- ${severityLabel(d.severity)} ${vscode.workspace.asRelativePath(d.uri, false)}: ${oneLine(d.message)}`);
    }
    lines.push('');
  }

  lines.push('## Constraints');
  lines.push('- Keep changes minimal and targeted.');
  lines.push('- Prefer fixing root cause over suppressing errors.');

  return lines.join('\n');
}

function severityLabel(s: vscode.DiagnosticSeverity): string {
  switch (s) {
    case vscode.DiagnosticSeverity.Error:
      return 'ERROR';
    case vscode.DiagnosticSeverity.Warning:
      return 'WARN';
    case vscode.DiagnosticSeverity.Information:
      return 'INFO';
    case vscode.DiagnosticSeverity.Hint:
      return 'HINT';
    default:
      return 'DIAG';
  }
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

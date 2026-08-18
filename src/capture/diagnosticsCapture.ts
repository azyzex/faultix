import * as vscode from 'vscode';
import type { DiagnosticsEvidence } from '../core/models';

export function snapshotDiagnostics(maxEntries: number): DiagnosticsEvidence {
  const all = vscode.languages.getDiagnostics();

  let total = 0;
  let errors = 0;
  let warnings = 0;

  const byFile = new Map<string, { errors: number; warnings: number }>();
  const top: DiagnosticsEvidence['top'] = [];

  for (const [uri, diags] of all) {
    for (const d of diags) {
      total++;
      if (d.severity === vscode.DiagnosticSeverity.Error) {
        errors++;
      } else if (d.severity === vscode.DiagnosticSeverity.Warning) {
        warnings++;
      }

      const key = uri.toString();
      const current = byFile.get(key) ?? { errors: 0, warnings: 0 };
      if (d.severity === vscode.DiagnosticSeverity.Error) {
        current.errors++;
      } else if (d.severity === vscode.DiagnosticSeverity.Warning) {
        current.warnings++;
      }
      byFile.set(key, current);

      if (top.length < maxEntries) {
        top.push({
          uri,
          severity: d.severity,
          source: d.source,
          message: d.message,
          range: d.range
        });
      }
    }
  }

  // Sort top entries: Errors first, then by uri.
  top.sort((a, b) => {
    if (a.severity !== b.severity) {
      return a.severity - b.severity;
    }
    return a.uri.toString().localeCompare(b.uri.toString());
  });

  return {
    total,
    errors,
    warnings,
    top,
    byFile
  };
}

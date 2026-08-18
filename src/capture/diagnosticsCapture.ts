/**
 * Editor diagnostics snapshot.
 *
 * Converts VS Code's diagnostic collection into the plain shapes the analysis
 * core understands. This is the only place that knows `vscode.Diagnostic`
 * exists, which keeps ranking and rendering testable.
 */

import * as vscode from 'vscode';
import type { DiagnosticCount } from '../analyze/scoring';
import { displayPath } from '../analyze/paths';
import type { DiagnosticView } from '../output/templates';

export interface DiagnosticsSnapshot {
  total: number;
  errors: number;
  warnings: number;
  /** The most severe entries, capped for output. */
  top: DiagnosticView[];
  /** Per-file counts, used by suspect ranking. */
  byFile: DiagnosticCount[];
  /** Absolute path per display path, so the UI can still open the file. */
  absoluteByDisplay: Map<string, string>;
}

function severityLabel(severity: vscode.DiagnosticSeverity): DiagnosticView['severity'] {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return 'error';
    case vscode.DiagnosticSeverity.Warning:
      return 'warning';
    case vscode.DiagnosticSeverity.Information:
      return 'info';
    default:
      return 'hint';
  }
}

/**
 * Snapshots every open diagnostic.
 *
 * Only file-scheme diagnostics are considered: an entry belonging to an
 * untitled buffer or a virtual document cannot be a suspect on disk.
 */
export function snapshotDiagnostics(maxEntries: number, workspaceRoot?: string): DiagnosticsSnapshot {
  let total = 0;
  let errors = 0;
  let warnings = 0;

  const byFile = new Map<string, DiagnosticCount>();
  const absoluteByDisplay = new Map<string, string>();
  const collected: Array<DiagnosticView & { severityOrder: number }> = [];

  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== 'file') {
      continue;
    }

    const absolute = uri.fsPath;
    const display = displayPath(workspaceRoot, absolute);
    absoluteByDisplay.set(display, absolute);

    const counts = byFile.get(display) ?? { file: display, errors: 0, warnings: 0 };

    for (const diagnostic of diagnostics) {
      total++;

      if (diagnostic.severity === vscode.DiagnosticSeverity.Error) {
        errors++;
        counts.errors++;
      } else if (diagnostic.severity === vscode.DiagnosticSeverity.Warning) {
        warnings++;
        counts.warnings++;
      }

      collected.push({
        file: display,
        severity: severityLabel(diagnostic.severity),
        message: diagnostic.message,
        // VS Code ranges are zero-based; every other line number in a brief is not.
        line: diagnostic.range.start.line + 1,
        source: diagnostic.source,
        severityOrder: diagnostic.severity
      });
    }

    byFile.set(display, counts);
  }

  collected.sort((a, b) =>
    a.severityOrder !== b.severityOrder ? a.severityOrder - b.severityOrder : a.file.localeCompare(b.file)
  );

  const top = collected.slice(0, Math.max(0, maxEntries)).map(({ severityOrder, ...view }) => {
    void severityOrder;
    return view;
  });

  return {
    total,
    errors,
    warnings,
    top,
    byFile: [...byFile.values()],
    absoluteByDisplay
  };
}

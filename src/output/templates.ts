/**
 * Brief rendering.
 *
 * Two documents come out of every incident:
 *
 *  - `incident.md`, written for a human skimming what just broke.
 *  - `repair.prompt.md`, written for a coding agent that will act on it.
 *
 * They share the same view model but not the same shape. The human document
 * is chronological and complete; the agent document leads with the conclusion,
 * puts the code the agent needs inline, and ends with an explicit task.
 *
 * Pure: the view model is plain data, so both renderers are unit testable
 * without a workspace.
 */

import type { IncidentKind } from '../analyze/classify';
import { describeKind } from '../analyze/classify';
import { extensionOf } from '../analyze/paths';

export interface ErrorView {
  severity: 'error' | 'warning';
  message: string;
  code?: string;
  file?: string;
  line?: number;
  column?: number;
  matcher?: string;
}

export interface DiagnosticView {
  file: string;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  line?: number;
  source?: string;
}

export interface SuspectView {
  /** Workspace-relative path, used for display. */
  file: string;
  score: number;
  reasons: string[];
  line?: number;
  /** Absolute path, carried so the UI can open the file. Not rendered. */
  absolutePath?: string;
}

export interface CodeSnippet {
  /** Workspace-relative path, used for display. */
  file: string;
  /** Absolute path, carried so the UI can open the file. Not rendered. */
  absolutePath?: string;
  /** 1-based line number of the first line in `lines`. */
  startLine: number;
  /** 1-based line the error points at, highlighted in the render. */
  focusLine?: number;
  lines: string[];
  truncated?: boolean;
}

/** How a pile of errors breaks down, so symptoms do not read as causes. */
export interface ErrorGroupingView {
  totalErrors: number;
  totalFiles: number;
  dominantCode?: { code: string; count: number; share: number };
  byFile: Array<{ file?: string; count: number }>;
}

export interface IncidentView {
  id: string;
  createdAt: string;
  kind: IncidentKind;
  status: 'unresolved' | 'resolved';
  title: string;
  /** One-line statement of the root cause. */
  summary?: string;
  workspaceName?: string;

  command?: {
    commandLine: string;
    cwd?: string;
    exitCode?: number;
    toolHint?: string;
    durationMs?: number;
  };

  primaryError?: ErrorView;
  errors?: ErrorView[];
  /** Set when there are enough errors that their shape is worth stating. */
  grouping?: ErrorGroupingView;
  terminalExcerpt?: string;
  snippets?: CodeSnippet[];

  diagnostics?: {
    total: number;
    errors: number;
    warnings: number;
    top: DiagnosticView[];
  };

  suspects?: SuspectView[];

  git?: {
    branch?: string;
    /** Commit at capture time. Not rendered; used by the run ledger. */
    sha?: string;
    isDirty?: boolean;
    changedFiles?: string[];
    diffStat?: string;
  };

  fingerprint: {
    signature: string;
    count: number;
    firstSeen: string;
    lastSeen: string;
  };

  redaction?: {
    total: number;
    counts: Record<string, number>;
  };

  /**
   * What the run ledger knows about this failure and this command.
   *
   * This is the part an agent cannot work out for itself: it starts cold each
   * session and only sees the run it just performed.
   */
  history?: {
    /** The last time this exact failure went away, and what changed then. */
    priorFix?: {
      fixedAt: string;
      /** Files being edited when it went away. A heuristic; see runLedger. */
      likelyFixedBy: string[];
      attempts: number;
      /** True when commits landed too, so the file list is incomplete. */
      commitsInBetween: boolean;
    };
    /** When this command last succeeded, for "what changed since". */
    lastPassedAt?: string;
    lastPassedSha?: string;
    /** Share of runs of this command that passed, 0..1. */
    passRate?: number;
    totalRuns?: number;
    /** Set when this command has disagreed with itself. */
    flaky?: 'high' | 'low';
    /** What changed between the last passing run and now. */
    changesSincePass?: {
      sha: string;
      files: string[];
      commits?: number;
    };
  };
}

/** Maps a file extension to a markdown fence language. */
export function fenceLanguage(file: string | undefined): string {
  if (!file) {
    return 'text';
  }
  const base = file.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  if (base === 'dockerfile') {
    return 'dockerfile';
  }
  if (base === 'makefile') {
    return 'makefile';
  }

  const ext = extensionOf(file);
  const map: Record<string, string> = {
    ts: 'ts', tsx: 'tsx', mts: 'ts', cts: 'ts',
    js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
    py: 'python', pyi: 'python',
    go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', scala: 'scala',
    cs: 'csharp', fs: 'fsharp', vb: 'vb',
    c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp',
    rb: 'ruby', php: 'php', lua: 'lua', swift: 'swift', dart: 'dart',
    sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', psm1: 'powershell',
    bat: 'bat', cmd: 'bat',
    json: 'json', jsonc: 'jsonc', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    xml: 'xml', sql: 'sql', graphql: 'graphql', proto: 'proto',
    html: 'html', css: 'css', scss: 'scss', less: 'less',
    md: 'markdown', tf: 'hcl', gradle: 'groovy'
  };

  return map[ext] ?? 'text';
}

/** `file:line:col`, omitting the parts that are unknown. */
export function formatLocation(view: { file?: string; line?: number; column?: number }): string {
  if (!view.file) {
    return '';
  }
  if (view.line === undefined) {
    return view.file;
  }
  return view.column === undefined ? `${view.file}:${view.line}` : `${view.file}:${view.line}:${view.column}`;
}

/** Collapses a message to a single line so it cannot break a list item. */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Renders a code snippet as a fenced block with line numbers and a caret. */
export function renderSnippet(snippet: CodeSnippet): string[] {
  const out: string[] = [];
  const lastLineNumber = snippet.startLine + snippet.lines.length - 1;
  const width = String(lastLineNumber).length;

  out.push('```' + fenceLanguage(snippet.file));
  snippet.lines.forEach((text, i) => {
    const lineNumber = snippet.startLine + i;
    const marker = lineNumber === snippet.focusLine ? '>' : ' ';
    out.push(`${marker} ${String(lineNumber).padStart(width, ' ')} | ${text}`);
  });
  if (snippet.truncated) {
    out.push('  ... truncated ...');
  }
  out.push('```');

  return out;
}

/** Renders what the run ledger knows, as bullet points. Empty when it knows nothing. */
export function renderHistory(view: IncidentView): string[] {
  const history = view.history;
  if (!history) {
    return [];
  }

  const lines: string[] = [];

  if (history.priorFix) {
    const files = history.priorFix.likelyFixedBy;
    const where = files.length ? ` after changes to ${files.slice(0, 3).map((f) => `\`${f}\``).join(', ')}` : '';
    lines.push(`- **Fixed before:** this failure went away on ${history.priorFix.fixedAt}${where}.`);
    if (history.priorFix.commitsInBetween) {
      lines.push('  - Commits landed too, so that list is incomplete.');
    }
  }

  if (history.lastPassedAt) {
    const at = history.lastPassedSha ? ` at \`${history.lastPassedSha.slice(0, 8)}\`` : '';
    lines.push(`- **Last passed:** ${history.lastPassedAt}${at}.`);
  }

  if (history.flaky) {
    lines.push(
      history.flaky === 'high'
        ? '- **Unreliable:** this command has both passed and failed at the same commit with a clean tree.'
        : '- **Possibly unreliable:** this command has both passed and failed recently, with a dirty tree.'
    );
  }

  const changes = history.changesSincePass;
  if (changes?.files.length) {
    const commits = changes.commits ? ` and ${changes.commits} commit(s)` : '';
    lines.push(
      `- **Changed since it last passed:** ${changes.files.length} file(s)${commits}, against \`${changes.sha.slice(0, 8)}\`.`
    );
    for (const file of changes.files.slice(0, 8)) {
      lines.push(`  - \`${file}\``);
    }
    if (changes.files.length > 8) {
      lines.push(`  - ... and ${changes.files.length - 8} more`);
    }
  }

  if (history.passRate !== undefined && history.totalRuns) {
    lines.push(`- **Pass rate:** ${Math.round(history.passRate * 100)}% of ${history.totalRuns} recorded runs.`);
  }

  return lines;
}

/** A one-line note when a failure has been seen before. */
export function repeatNote(count: number): string | undefined {
  if (count <= 1) {
    return undefined;
  }
  if (count >= 5) {
    return `Seen ${count} times - this failure is recurring, so a previous fix did not hold.`;
  }
  return `Seen ${count} times.`;
}

/**
 * The human-facing document.
 */
export function buildIncidentMarkdown(view: IncidentView): string {
  const lines: string[] = [];
  const push = (...items: string[]): void => {
    lines.push(...items);
  };

  push(`# ${view.summary ? oneLine(view.summary) : view.title}`, '');

  // Facts table: quick to scan, easy to diff between incidents.
  push('| | |', '|---|---|');
  push(`| **Kind** | ${describeKind(view.kind)} |`);
  if (view.command?.commandLine) {
    push(`| **Command** | \`${escapePipes(view.command.commandLine)}\` |`);
  }
  if (view.command?.exitCode !== undefined) {
    push(`| **Exit code** | ${formatExitCode(view.command.exitCode)} |`);
  }
  if (view.command?.toolHint) {
    push(`| **Tool** | ${view.command.toolHint} |`);
  }
  if (view.command?.durationMs !== undefined) {
    push(`| **Duration** | ${formatDuration(view.command.durationMs)} |`);
  }
  push(`| **When** | ${view.createdAt} |`);
  if (view.workspaceName) {
    push(`| **Workspace** | ${view.workspaceName} |`);
  }
  push(`| **Status** | ${view.status} |`);
  push(`| **Fingerprint** | \`${view.fingerprint.signature}\` (seen ${view.fingerprint.count}x) |`);
  push('');

  const repeat = repeatNote(view.fingerprint.count);
  if (repeat) {
    push(`> ${repeat}`, '');
  }

  if (view.primaryError) {
    push('## Root cause');
    push('');
    push(formatErrorLine(view.primaryError));
    push('');
  }

  const historyLines = renderHistory(view);
  if (historyLines.length) {
    push('## What history says', '');
    push(...historyLines);
    push('');
  }

  const snippets = view.snippets ?? [];
  if (snippets.length) {
    push('## Code context', '');
    for (const snippet of snippets) {
      push(`**${snippet.file}**`, '');
      push(...renderSnippet(snippet));
      push('');
    }
  }

  const errors = view.errors ?? [];
  if (errors.length > 1) {
    const grouping = view.grouping;
    const heading =
      grouping && grouping.totalFiles > 1
        ? `## All parsed errors (${errors.length} across ${grouping.totalFiles} files)`
        : `## All parsed errors (${errors.length})`;

    push(heading, '');

    const dominant = describeDominantCode(grouping);
    if (dominant) {
      push(`> ${dominant}`, '');
    }

    for (const error of errors) {
      push(`- ${formatErrorLine(error)}`);
    }
    push('');
  }

  const suspects = view.suspects ?? [];
  if (suspects.length) {
    push('## Files to inspect first', '');
    for (const suspect of suspects) {
      const location = suspect.line !== undefined ? `${suspect.file}:${suspect.line}` : suspect.file;
      push(`- **${location}** (score ${suspect.score})`);
      for (const reason of suspect.reasons.slice(0, 3)) {
        push(`  - ${reason}`);
      }
    }
    push('');
  }

  if (view.diagnostics && view.diagnostics.total > 0) {
    push('## Editor diagnostics', '');
    push(
      `${view.diagnostics.total} total - ${view.diagnostics.errors} error(s), ${view.diagnostics.warnings} warning(s).`
    );
    push('');
    for (const diagnostic of view.diagnostics.top.slice(0, 15)) {
      const location = diagnostic.line !== undefined ? `${diagnostic.file}:${diagnostic.line}` : diagnostic.file;
      push(`- \`${diagnostic.severity.toUpperCase()}\` ${location} - ${oneLine(diagnostic.message)}`);
    }
    push('');
  }

  if (view.terminalExcerpt) {
    push('## Terminal output', '');
    push('```text');
    push(view.terminalExcerpt.trimEnd());
    push('```');
    push('');
  }

  if (view.git?.branch || view.git?.changedFiles?.length) {
    push('## Working tree', '');
    if (view.git.branch) {
      push(`- Branch: \`${view.git.branch}\``);
    }
    if (view.git.isDirty !== undefined) {
      push(`- Dirty: ${view.git.isDirty ? 'yes' : 'no'}`);
    }
    const changed = view.git.changedFiles ?? [];
    if (changed.length) {
      push(`- Changed files (${changed.length}):`);
      for (const file of changed.slice(0, 20)) {
        push(`  - ${file}`);
      }
      if (changed.length > 20) {
        push(`  - ... and ${changed.length - 20} more`);
      }
    }
    push('');
  }

  if (view.redaction && view.redaction.total > 0) {
    push('---', '');
    push(`_${view.redaction.total} potential secret(s) were redacted from this brief._`);
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/**
 * The agent-facing document.
 *
 * Ordered so a model reading top-to-bottom has the conclusion, the evidence,
 * and the code before it is asked to do anything.
 */
export function buildRepairPrompt(view: IncidentView): string {
  const lines: string[] = [];
  const push = (...items: string[]): void => {
    lines.push(...items);
  };

  push(`# Repair brief: ${view.summary ? oneLine(view.summary) : oneLine(view.title)}`, '');

  push('## What failed', '');
  push(`${describeKind(view.kind)}.`);
  if (view.command?.commandLine) {
    const exit = view.command.exitCode !== undefined ? ` (exit ${formatExitCode(view.command.exitCode)})` : '';
    push(`Command: \`${view.command.commandLine}\`${exit}`);
  }
  const repeat = repeatNote(view.fingerprint.count);
  if (repeat) {
    push('', repeat);
  }
  push('');

  if (view.primaryError) {
    push('## Most likely root cause', '');
    push(formatErrorLine(view.primaryError));
    push('');
  }

  const priorFix = view.history?.priorFix;
  if (priorFix) {
    push('## You have fixed this before', '');
    push(
      `The same failure was resolved on ${priorFix.fixedAt}, after ${priorFix.attempts} ` +
        `attempt${priorFix.attempts === 1 ? '' : 's'}.`
    );
    if (priorFix.likelyFixedBy.length) {
      push('', 'Files being edited when it went away:');
      for (const file of priorFix.likelyFixedBy.slice(0, 10)) {
        push(`- \`${file}\``);
      }
      push('', 'Start there. It is a strong hint, not a certainty.');
    }
    if (priorFix.commitsInBetween) {
      push('', 'Commits landed between the failure and the fix, so that list is incomplete.');
    }
    push('');
  }

  const sincePass = view.history?.changesSincePass;
  if (sincePass?.files.length) {
    push('## What changed since this last worked', '');
    push(
      `${sincePass.files.length} file(s) differ from \`${sincePass.sha.slice(0, 8)}\`, the commit where this command last passed` +
        (sincePass.commits ? `, across ${sincePass.commits} commit(s)` : '') +
        '. The cause is very likely among them.'
    );
    push('');
    for (const file of sincePass.files.slice(0, 20)) {
      push(`- \`${file}\``);
    }
    if (sincePass.files.length > 20) {
      push(`- ... and ${sincePass.files.length - 20} more`);
    }
    push('');
  }

  if (view.history?.flaky) {
    push('## This command is unreliable', '');
    push(
      view.history.flaky === 'high'
        ? 'It has both passed and failed at the same commit with a clean tree, so the code did not change between those runs. Consider whether this is a flaky test, a race, or an unstable environment before changing logic.'
        : 'It has both passed and failed recently. The working tree was dirty, so an edit may explain it — but check for flakiness before assuming a code fault.'
    );
    push('');
  }

  const snippets = view.snippets ?? [];
  if (snippets.length) {
    push('## Code at the failure site', '');
    for (const snippet of snippets) {
      push(`\`${snippet.file}\``, '');
      push(...renderSnippet(snippet));
      push('');
    }
  }

  // Compared by value, not identity: the primary error is rebuilt separately
  // from the list, so reference equality would never hold and the root cause
  // would be printed twice.
  const errors = (view.errors ?? []).filter((e) => !isSameError(e, view.primaryError));
  if (errors.length) {
    push(`## Other reported problems (${errors.length})`, '');

    const dominant = describeDominantCode(view.grouping);
    if (dominant) {
      push('', dominant, '');
    }

    for (const error of errors.slice(0, 15)) {
      push(`- ${formatErrorLine(error)}`);
    }
    push('');
  }

  const suspects = view.suspects ?? [];
  if (suspects.length) {
    push('## Where to look', '');
    for (const suspect of suspects.slice(0, 6)) {
      const location = suspect.line !== undefined ? `${suspect.file}:${suspect.line}` : suspect.file;
      push(`- \`${location}\` - ${suspect.reasons.slice(0, 2).join('; ')}`);
    }
    push('');
  }

  if (view.terminalExcerpt) {
    push('## Raw output', '');
    push('```text');
    push(view.terminalExcerpt.trimEnd());
    push('```');
    push('');
  }

  // Only emit the heading when there is something to put under it.
  const contextLines: string[] = [];
  if (view.workspaceName) {
    contextLines.push(`- Workspace: ${view.workspaceName}`);
  }
  if (view.git?.branch) {
    contextLines.push(`- Branch: ${view.git.branch}${view.git.isDirty ? ' (uncommitted changes present)' : ''}`);
  }
  const changed = view.git?.changedFiles ?? [];
  if (changed.length) {
    contextLines.push(`- Recently changed: ${changed.slice(0, 10).join(', ')}${changed.length > 10 ? ', ...' : ''}`);
  }
  if (contextLines.length) {
    push('## Context', '');
    push(...contextLines);
    push('');
  }

  push('## Your task', '');
  push('1. Identify the root cause from the evidence above. Do not guess beyond it.');
  push('2. Make the smallest change that fixes the cause rather than the symptom.');
  push('3. Do not suppress, silence, or work around the error.');
  if (view.command?.commandLine) {
    push(`4. Verify by re-running: \`${view.command.commandLine}\``);
  } else {
    push('4. Verify by re-running whatever reproduces the failure.');
  }
  push('');
  push('If the evidence is insufficient to be confident, say what additional output you need.');

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/**
 * One-line summary of an error, for a title or the status bar.
 *
 * Takes an ErrorView rather than raw text so the location is the resolved
 * display path; summarizing from the raw output would embed the absolute path
 * the tool happened to print.
 */
export function summarizeError(error: ErrorView, max = 200): string {
  const location = error.file ? ` (${error.file}${error.line !== undefined ? `:${error.line}` : ''})` : '';
  const code = error.code && !error.message.startsWith(error.code) ? `${error.code}: ` : '';
  const summary = `${code}${oneLine(error.message)}${location}`;
  return summary.length <= max ? summary : `${summary.slice(0, Math.max(0, max - 3))}...`;
}

/**
 * States when one diagnostic code accounts for most of the output.
 *
 * Forty errors from one bad import are one problem with forty symptoms, and a
 * flat list invites fixing them one at a time.
 */
export function describeDominantCode(grouping: ErrorGroupingView | undefined): string | undefined {
  // Guarding on the property narrows the container too, so `grouping` is known
  // to be defined below without a second redundant check.
  if (!grouping?.dominantCode) {
    return undefined;
  }
  const dominant = grouping.dominantCode;

  const rest = grouping.totalErrors - dominant.count;
  const spread = grouping.totalFiles > 1 ? ` across ${grouping.totalFiles} files` : '';

  return (
    `${dominant.count} of ${grouping.totalErrors} errors are \`${dominant.code}\`${spread}` +
    `${rest > 0 ? `, with ${rest} other${rest === 1 ? '' : 's'}` : ''}. ` +
    'They are probably symptoms of one cause rather than separate problems - fix that first and re-run.'
  );
}

/** Renders one error as a single markdown line. */
export function formatErrorLine(error: ErrorView): string {
  const parts: string[] = [];

  if (error.severity === 'warning') {
    parts.push('`WARN`');
  }
  // Exception-style messages already begin with their type ("TypeError: ..."),
  // so prefixing the code would render it twice.
  if (error.code && !error.message.startsWith(error.code)) {
    parts.push(`\`${error.code}\``);
  }
  parts.push(oneLine(error.message));

  const location = formatLocation(error);
  if (location) {
    parts.push(`(\`${location}\`)`);
  }

  return parts.join(' ');
}

/** Two error records describe the same problem when message and place agree. */
export function isSameError(a: ErrorView | undefined, b: ErrorView | undefined): boolean {
  if (!a || !b) {
    return false;
  }
  // Deliberately ignores code and column: the same problem is sometimes
  // reported once with a diagnostic code and once without.
  return a.message === b.message && a.file === b.file && a.line === b.line;
}

/**
 * Windows reports a negative exit status as its unsigned 32-bit form, so an
 * errno of -4058 arrives as 4294963238. Show the number the tool meant.
 */
export function formatExitCode(code: number): string {
  if (!Number.isInteger(code)) {
    return String(code);
  }
  return String(code > 0x7fffffff ? code - 0x100000000 : code);
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, '\\|');
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

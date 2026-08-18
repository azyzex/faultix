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
    push(`| **Exit code** | ${view.command.exitCode} |`);
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
    push(`## All parsed errors (${errors.length})`, '');
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
    push(`Command: \`${view.command.commandLine}\`` + (view.command.exitCode !== undefined ? ` (exit ${view.command.exitCode})` : ''));
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

  const snippets = view.snippets ?? [];
  if (snippets.length) {
    push('## Code at the failure site', '');
    for (const snippet of snippets) {
      push(`\`${snippet.file}\``, '');
      push(...renderSnippet(snippet));
      push('');
    }
  }

  const errors = (view.errors ?? []).filter((e) => e !== view.primaryError);
  if (errors.length) {
    push(`## Other reported problems (${errors.length})`, '');
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

  push('## Context', '');
  if (view.workspaceName) {
    push(`- Workspace: ${view.workspaceName}`);
  }
  if (view.git?.branch) {
    push(`- Branch: ${view.git.branch}${view.git.isDirty ? ' (uncommitted changes present)' : ''}`);
  }
  const changed = view.git?.changedFiles ?? [];
  if (changed.length) {
    push(`- Recently changed: ${changed.slice(0, 10).join(', ')}${changed.length > 10 ? ', ...' : ''}`);
  }
  push('');

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

/** Renders one error as a single markdown line. */
export function formatErrorLine(error: ErrorView): string {
  const parts: string[] = [];

  if (error.severity === 'warning') {
    parts.push('`WARN`');
  }
  if (error.code) {
    parts.push(`\`${error.code}\``);
  }
  parts.push(oneLine(error.message));

  const location = formatLocation(error);
  if (location) {
    parts.push(`(\`${location}\`)`);
  }

  return parts.join(' ');
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

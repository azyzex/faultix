/**
 * Incident assembly.
 *
 * The single place where observations become an incident. Everything upstream
 * only gathers raw material (terminal text, a task name, a diagnostics
 * snapshot); everything downstream only renders or persists what this produces.
 *
 * The pipeline, in order:
 *   sanitize -> redact -> classify -> extract errors -> resolve paths ->
 *   rank suspects -> read code context -> fingerprint.
 */

import * as path from 'path';
import * as vscode from 'vscode';

import { excerptLines, sanitizeTerminalOutput, truncateChars } from '../analyze/ansi';
import { inferKindFromCommand, inferKindFromTaskName, inferToolHint, refineKindFromOutput } from '../analyze/classify';
import type { IncidentKind } from '../analyze/classify';
import { dedupeErrors, extractErrors, extractFileRefs, extractPrimaryError, rankErrors, summarizeFailure } from '../analyze/errorExtract';
import type { ExtractedError } from '../analyze/errorExtract';
import { computeFingerprint } from '../analyze/fingerprint';
import { collectGitEvidence } from '../analyze/git';
import { displayPath, isWithin } from '../analyze/paths';
import { dedupeRefs, rankSuspects } from '../analyze/scoring';
import type { FileRef } from '../analyze/scoring';
import type { FaultixConfig } from '../core/config';
import type { Incident, IncidentTrigger } from '../core/models';
import { anonymizeHomePaths, redactWithReport } from '../privacy/redact';
import type { ErrorView } from '../output/templates';
import { snapshotDiagnostics } from './diagnosticsCapture';
import { readSnippets } from './snippets';
import type { SnippetRequest } from './snippets';

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

/** Assembles a complete incident from whatever was observed. */
export async function buildIncident(input: BuildIncidentInput): Promise<Incident> {
  const { config } = input;
  const folder = vscode.workspace.workspaceFolders?.[0];
  const workspaceRoot = folder?.uri.fsPath;

  // 1. Make the terminal text readable, then remove anything secret from it.
  //
  // Home-path anonymization is deliberately NOT applied here. Analysis needs
  // the real absolute paths a tool printed in order to resolve them on disk,
  // read code context, and let the tree view open the right file. Anonymizing
  // first would turn every stack frame into an unresolvable `<home>\...`.
  // It is applied to the rendered excerpt at step 8 instead.
  const sanitized = sanitizeTerminalOutput(input.rawOutput ?? '');
  const redaction = config.redactSecrets
    ? redactWithReport(sanitized, { anonymizeHome: false, redactEmails: config.redactEmails })
    : { text: sanitized, counts: {}, total: 0 };

  // 2. Classify the failure.
  const kind = input.kindOverride ?? deriveKind(input, redaction.text);
  const toolHint = input.commandLine ? inferToolHint(input.commandLine) : undefined;

  // 3. Pull structured errors out of the readable text.
  const extracted = rankErrors(dedupeErrors(extractErrors(redaction.text), config.maxErrors));
  const primary = extractPrimaryError(redaction.text);

  // 4. Resolve every referenced path against the workspace.
  const resolver = createPathResolver(workspaceRoot, input.cwd);
  const errorRefs = dedupeRefs(
    extracted.filter((e) => e.file).map((e) => ({ file: e.file as string, line: e.line, column: e.column }))
  );
  const terminalRefs = dedupeRefs(
    extractFileRefs(redaction.text).map((r) => ({ file: r.file, line: r.line, column: r.column }))
  );
  const commandRefs = input.commandLine ? dedupeRefs(extractCommandRefs(input.commandLine)) : [];

  const diagnostics = snapshotDiagnostics(config.maxDiagnostics, workspaceRoot);

  // In an untrusted workspace, running git and reading arbitrary files are both
  // side effects the user has explicitly not consented to. Capture still works;
  // it just carries less context.
  const trusted = vscode.workspace.isTrusted;
  const git = await collectGitEvidence({ enabled: config.gitEnabled && trusted, workspaceRoot });

  // 5. Rank, using display paths so everything collapses onto one spelling.
  const suspects = rankSuspects(
    {
      primaryErrorFile: primary?.file ? resolver.toRef({ file: primary.file, line: primary.line }) : undefined,
      errorRefs: errorRefs.map(resolver.toRef).filter(isResolved),
      terminalRefs: terminalRefs.map(resolver.toRef).filter(isResolved),
      commandRefs: commandRefs.map(resolver.toRef).filter(isResolved),
      diagnostics: diagnostics.byFile,
      gitChangedFiles: git.changedFiles ?? []
    },
    { limit: config.maxSuspects, ignoredSegments: config.ignoredSegments }
  ).map((suspect) => ({
    ...suspect,
    absolutePath: resolver.toAbsolute(suspect.file) ?? diagnostics.absoluteByDisplay.get(suspect.file)
  }));

  // 6. Read the code around the failure, best effort.
  const snippets =
    trusted && config.snippetContextLines > 0 && config.maxSnippets > 0
      ? readSnippets(snippetRequests(primary, suspects, resolver), config.maxSnippets, {
          contextLines: config.snippetContextLines,
          redactSecrets: config.redactSecrets
        })
      : [];

  // 7. Fingerprint so repeats can be counted.
  const fingerprint = computeFingerprint({
    kind,
    commandLine: input.commandLine,
    toolHint,
    primaryMessage: primary?.message,
    primaryCode: primary?.code,
    primaryFile: primary?.file ? displayPath(workspaceRoot, resolver.toAbsolute(primary.file) ?? primary.file) : undefined
  });

  // 8. Render-time privacy: now that every path has been resolved, the excerpt
  //    can have the home directory stripped without costing anything.
  const excerpt = truncateChars(
    excerptLines(
      config.anonymizePaths ? anonymizeHomePaths(redaction.text) : redaction.text,
      config.maxTerminalLines
    ),
    Math.floor(config.maxChars * 0.6)
  );

  const rawSummary = summarizeFailure(redaction.text, input.titleOverride ?? deriveTitle(input));
  const summary = config.anonymizePaths ? anonymizeHomePaths(rawSummary) : rawSummary;
  const createdAt = new Date().toISOString();

  return {
    id: `${createdAt.replace(/[:.]/g, '-')}_${fingerprint.signature}`,
    createdAt,
    kind,
    status: 'unresolved',
    trigger: input.trigger,
    title: input.titleOverride ?? deriveTitle(input),
    summary,
    workspaceName: vscode.workspace.name,
    workspaceRoot,

    command: input.commandLine
      ? {
          commandLine: input.commandLine,
          cwd: input.cwd,
          exitCode: input.exitCode,
          toolHint,
          durationMs: input.durationMs
        }
      : undefined,

    primaryError: primary ? toErrorView(primary, resolver, workspaceRoot) : undefined,
    errors: extracted.map((e) => toErrorView(e, resolver, workspaceRoot)),
    terminalExcerpt: excerpt || undefined,
    snippets,

    diagnostics: diagnostics.total
      ? {
          total: diagnostics.total,
          errors: diagnostics.errors,
          warnings: diagnostics.warnings,
          top: diagnostics.top
        }
      : undefined,

    suspects,
    git: git.insideWorkTree
      ? { branch: git.branch, isDirty: git.isDirty, changedFiles: git.changedFiles, diffStat: git.diffStat }
      : undefined,

    fingerprint,
    redaction: redaction.total > 0 ? { total: redaction.total, counts: redaction.counts } : undefined
  };
}

function isResolved(ref: FileRef | undefined): ref is FileRef {
  return ref !== undefined;
}

function deriveKind(input: BuildIncidentInput, output: string): IncidentKind {
  const base = input.commandLine
    ? inferKindFromCommand(input.commandLine)
    : input.taskName
      ? inferKindFromTaskName(input.taskName)
      : 'unknown';
  return refineKindFromOutput(base, output);
}

function deriveTitle(input: BuildIncidentInput): string {
  if (input.taskName) {
    return `Task failed${input.exitCode !== undefined ? ` (${input.exitCode})` : ''}: ${input.taskName}`;
  }
  if (input.commandLine) {
    return `Command failed${input.exitCode !== undefined ? ` (${input.exitCode})` : ''}: ${input.commandLine}`;
  }
  return 'Failure captured';
}

function toErrorView(error: ExtractedError, resolver: PathResolver, workspaceRoot: string | undefined): ErrorView {
  const absolute = error.file ? resolver.toAbsolute(error.file) : undefined;
  return {
    severity: error.severity,
    message: error.message,
    code: error.code,
    file: absolute ? displayPath(workspaceRoot, absolute) : error.file,
    line: error.line,
    column: error.column,
    matcher: error.matcher
  };
}

/**
 * Files named directly on the command line, e.g. `node scripts/build.js`.
 * These are strong evidence: you ran that file and it failed.
 */
function extractCommandRefs(commandLine: string): FileRef[] {
  const pattern = /(?:^|\s)(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+))(?=\s|$)/g;
  const refs: FileRef[] = [];

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(commandLine)) !== null) {
    const token = match[1] ?? match[2] ?? match[3];
    if (!token || token.startsWith('-')) {
      continue;
    }
    if (/\.[A-Za-z0-9]{1,8}$/.test(token)) {
      refs.push({ file: token });
    }
    if (refs.length >= 20) {
      break;
    }
  }

  return refs;
}

interface PathResolver {
  /** Rewrites a parsed reference into workspace-relative display form. */
  toRef: (ref: FileRef) => FileRef | undefined;
  /** Resolves a parsed or display path to an absolute path on disk. */
  toAbsolute: (file: string) => string | undefined;
}

/**
 * Parsed paths arrive in every shape a tool cares to print: absolute, relative
 * to the workspace, relative to the command's working directory, or prefixed
 * with `./`. This normalizes them to one absolute path and one display path,
 * and drops anything that escapes the workspace.
 */
function createPathResolver(workspaceRoot: string | undefined, cwd: string | undefined): PathResolver {
  const bases = [cwd, workspaceRoot].filter((b): b is string => Boolean(b));
  const cache = new Map<string, string | undefined>();

  const resolve = (file: string): string | undefined => {
    const trimmed = file.trim().replace(/^\.[\\/]/, '');
    if (!trimmed) {
      return undefined;
    }

    if (cache.has(trimmed)) {
      return cache.get(trimmed);
    }

    let resolved: string | undefined;

    if (path.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) {
      resolved = path.normalize(trimmed);
    } else {
      for (const base of bases) {
        const candidate = path.resolve(base, trimmed);
        if (isWithin(base, candidate)) {
          resolved = candidate;
          break;
        }
      }
    }

    cache.set(trimmed, resolved);
    return resolved;
  };

  return {
    toAbsolute: resolve,
    toRef: (ref) => {
      const absolute = resolve(ref.file);
      if (!absolute) {
        return undefined;
      }
      return { file: displayPath(workspaceRoot, absolute), line: ref.line, column: ref.column };
    }
  };
}

/** Chooses which locations deserve an inline code snippet. */
function snippetRequests(
  primary: ExtractedError | undefined,
  suspects: Array<{ file: string; line?: number; absolutePath?: string }>,
  resolver: PathResolver
): SnippetRequest[] {
  const requests: SnippetRequest[] = [];

  if (primary?.file && primary.line !== undefined) {
    const absolute = resolver.toAbsolute(primary.file);
    if (absolute) {
      requests.push({ absolutePath: absolute, displayPath: primary.file, line: primary.line });
    }
  }

  for (const suspect of suspects) {
    if (suspect.line === undefined || !suspect.absolutePath) {
      continue;
    }
    requests.push({ absolutePath: suspect.absolutePath, displayPath: suspect.file, line: suspect.line });
  }

  return requests;
}

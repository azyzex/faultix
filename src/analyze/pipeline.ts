/**
 * The analysis pipeline.
 *
 * Everything that turns raw observations into a finished incident, with no
 * `vscode` dependency. The extension calls this after gathering editor state;
 * the `faultix-brief` CLI calls it directly. Both therefore exercise the same
 * code, which is the point: a pipeline that only the extension can run is a
 * pipeline that can only be tested by launching an editor.
 *
 * Ordering here is load-bearing in two places, both marked below.
 */

import * as path from 'path';

import { excerptLines, sanitizeTerminalOutput, truncateChars } from './ansi';
import { inferKindFromCommand, inferKindFromTaskName, inferToolHint, refineKindFromOutput } from './classify';
import type { IncidentKind } from './classify';
import {
  dedupeErrors,
  extractErrors,
  extractFileRefs,
  extractPrimaryError,
  rankErrors,
  summarizeFailure
} from './errorExtract';
import type { ExtractedError } from './errorExtract';
import { computeFingerprint } from './fingerprint';
import type { GitEvidence } from './git';
import { displayPath, isWithin, toPosix } from './paths';
import { dedupeRefs, rankSuspects } from './scoring';
import type { DiagnosticCount, FileRef } from './scoring';
import { anonymizeHomePaths, redactWithReport } from '../privacy/redact';
import { readSnippets } from '../capture/snippets';
import type { SnippetRequest } from '../capture/snippets';
import type { Incident, IncidentTrigger } from '../core/models';
import { summarizeError } from '../output/templates';
import type { DiagnosticView, ErrorView } from '../output/templates';

/** The settings the pipeline actually reads. */
export interface AnalysisOptions {
  maxChars: number;
  maxTerminalLines: number;
  maxErrors: number;
  maxSuspects: number;
  maxSnippets: number;
  snippetContextLines: number;
  redactSecrets: boolean;
  redactEmails: boolean;
  anonymizePaths: boolean;
  ignoredSegments: readonly string[];
  /** False in an untrusted workspace: no file reads for code context. */
  allowFileReads: boolean;
}

export const DEFAULT_ANALYSIS_OPTIONS: AnalysisOptions = {
  maxChars: 60000,
  maxTerminalLines: 200,
  maxErrors: 20,
  maxSuspects: 8,
  maxSnippets: 3,
  snippetContextLines: 6,
  redactSecrets: true,
  redactEmails: false,
  anonymizePaths: true,
  ignoredSegments: [],
  allowFileReads: true
};

/** Editor diagnostics, already reduced to plain data by the caller. */
export interface DiagnosticsInput {
  total: number;
  errors: number;
  warnings: number;
  top: DiagnosticView[];
  byFile: DiagnosticCount[];
  absoluteByDisplay: Map<string, string>;
}

export interface AnalyzeInput {
  trigger: IncidentTrigger;
  options: AnalysisOptions;

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

  workspaceRoot?: string;
  workspaceName?: string;

  diagnostics?: DiagnosticsInput;
  git?: GitEvidence;

  /**
   * What the run ledger knows about this failure and this command. Computed by
   * the caller, because the ledger is persisted state rather than something
   * derivable from this run.
   */
  history?: Incident['history'];

  /** Injectable clock, so fingerprints and ids are deterministic in tests. */
  now?: Date;
}

/** Assembles a complete incident from whatever was observed. */
export function analyzeFailure(input: AnalyzeInput): Incident {
  const { options } = input;
  const workspaceRoot = input.workspaceRoot;

  // 1. Make the terminal text readable, then remove anything secret from it.
  //
  // ORDERING: home-path anonymization is deliberately NOT applied here.
  // Analysis needs the real absolute paths a tool printed in order to resolve
  // them on disk, read code context, and let the UI open the right file.
  // Anonymizing first turns every stack frame into an unresolvable
  // `<home>\...`. It is applied to the rendered excerpt at step 8 instead.
  const sanitized = sanitizeTerminalOutput(input.rawOutput ?? '');
  const redaction = options.redactSecrets
    ? redactWithReport(sanitized, { anonymizeHome: false, redactEmails: options.redactEmails })
    : { text: sanitized, counts: {}, total: 0 };

  // 2. Classify the failure.
  const kind = input.kindOverride ?? deriveKind(input, redaction.text);
  const toolHint = input.commandLine ? inferToolHint(input.commandLine) : undefined;

  // 3. Pull structured errors out of the readable text.
  const extracted = rankErrors(dedupeErrors(extractErrors(redaction.text), options.maxErrors));
  const primary = extractPrimaryError(redaction.text);

  // 4. Resolve every referenced path against the workspace.
  const resolver = createPathResolver(workspaceRoot, input.cwd);
  const errorRefs = dedupeRefs(
    extracted
      .filter((error): error is ExtractedError & { file: string } => Boolean(error.file))
      .map((error) => ({ file: error.file, line: error.line, column: error.column }))
  );
  const terminalRefs = dedupeRefs(
    extractFileRefs(redaction.text).map((ref) => ({ file: ref.file, line: ref.line, column: ref.column }))
  );
  const commandRefs = input.commandLine ? dedupeRefs(extractCommandRefs(input.commandLine)) : [];

  // 5. Rank, using display paths so every spelling collapses onto one file.
  //
  // ORDERING: diagnostics are applied inside rankSuspects after the
  // output-derived evidence, because their weight depends on whether anything
  // else already implicated the file.
  const suspects = rankSuspects(
    {
      primaryErrorFile: primary?.file ? resolver.toRef({ file: primary.file, line: primary.line }) : undefined,
      errorRefs: errorRefs.map(resolver.toRef).filter(isResolved),
      terminalRefs: terminalRefs.map(resolver.toRef).filter(isResolved),
      commandRefs: commandRefs.map(resolver.toRef).filter(isResolved),
      diagnostics: input.diagnostics?.byFile,
      gitChangedFiles: input.git?.changedFiles ?? []
    },
    { limit: options.maxSuspects, ignoredSegments: options.ignoredSegments }
  ).map((suspect) => ({
    ...suspect,
    absolutePath: resolver.toAbsolute(suspect.file) ?? input.diagnostics?.absoluteByDisplay.get(suspect.file)
  }));

  // 6. Read the code around the failure, best effort.
  const snippets =
    options.allowFileReads && options.snippetContextLines > 0 && options.maxSnippets > 0
      ? readSnippets(snippetRequests(primary, suspects, resolver, workspaceRoot), options.maxSnippets, {
          contextLines: options.snippetContextLines,
          redactSecrets: options.redactSecrets
        })
      : [];

  // 7. Fingerprint so repeats can be counted across runs.
  const now = input.now ?? new Date();
  const fingerprint = computeFingerprint(
    {
      kind,
      commandLine: input.commandLine,
      toolHint,
      primaryMessage: primary?.message,
      primaryCode: primary?.code,
      primaryFile: primary?.file
        ? displayPath(workspaceRoot, resolver.toAbsolute(primary.file) ?? primary.file)
        : undefined
    },
    now
  );

  // 8. Render-time privacy: every path has been resolved by now, so stripping
  //    the home directory costs nothing.
  const excerpt = truncateChars(
    excerptLines(
      options.anonymizePaths ? anonymizeHomePaths(redaction.text) : redaction.text,
      options.maxTerminalLines
    ),
    Math.floor(options.maxChars * 0.6)
  );

  const anonymize = options.anonymizePaths ? anonymizeHomePaths : (text: string): string => text;
  const primaryView = primary ? toErrorView(primary, resolver, workspaceRoot, anonymize) : undefined;
  const fallbackTitle = input.titleOverride ?? deriveTitle(input);
  const rawSummary = primaryView
    ? summarizeError(primaryView)
    : summarizeFailure(redaction.text, fallbackTitle);
  const summary = anonymize(rawSummary);
  const createdAt = now.toISOString();

  return {
    id: `${createdAt.replace(/[:.]/g, '-')}_${fingerprint.signature}`,
    createdAt,
    kind,
    status: 'unresolved',
    trigger: input.trigger,
    title: anonymize(input.titleOverride ?? deriveTitle(input)),
    summary,
    workspaceName: input.workspaceName,
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

    primaryError: primaryView,
    errors: extracted.map((error) => toErrorView(error, resolver, workspaceRoot, anonymize)),
    terminalExcerpt: excerpt || undefined,
    snippets,

    diagnostics: input.diagnostics?.total
      ? {
          total: input.diagnostics.total,
          errors: input.diagnostics.errors,
          warnings: input.diagnostics.warnings,
          top: input.diagnostics.top
        }
      : undefined,

    suspects,
    git: input.git?.insideWorkTree
      ? {
          branch: input.git.branch,
          sha: input.git.sha,
          isDirty: input.git.isDirty,
          changedFiles: input.git.changedFiles,
          diffStat: input.git.diffStat
        }
      : undefined,

    fingerprint,
    history: input.history,
    redaction: redaction.total > 0 ? { total: redaction.total, counts: redaction.counts } : undefined
  };
}

function isResolved(ref: FileRef | undefined): ref is FileRef {
  return ref !== undefined;
}

function deriveKind(input: AnalyzeInput, output: string): IncidentKind {
  const base = input.commandLine
    ? inferKindFromCommand(input.commandLine)
    : input.taskName
      ? inferKindFromTaskName(input.taskName)
      : 'unknown';
  return refineKindFromOutput(base, output);
}

function deriveTitle(input: AnalyzeInput): string {
  if (input.taskName) {
    return `Task failed${input.exitCode !== undefined ? ` (${input.exitCode})` : ''}: ${input.taskName}`;
  }
  if (input.commandLine) {
    return `Command failed${input.exitCode !== undefined ? ` (${input.exitCode})` : ''}: ${input.commandLine}`;
  }
  return 'Failure captured';
}

function toErrorView(
  error: ExtractedError,
  resolver: PathResolver,
  workspaceRoot: string | undefined,
  anonymize: (text: string) => string
): ErrorView {
  const absolute = error.file ? resolver.toAbsolute(error.file) : undefined;
  const file = absolute ? displayPath(workspaceRoot, absolute) : error.file;
  return {
    severity: error.severity,
    // The message is raw tool text. Tools print absolute paths inside their
    // messages, not only in the surrounding output, so anonymization has to
    // reach in here too - otherwise a brief that scrubs its terminal excerpt
    // still leaks the home directory through the error list.
    message: anonymize(error.message),
    code: error.code,
    file: file ? anonymize(file) : undefined,
    line: error.line,
    column: error.column,
    matcher: error.matcher
  };
}

/**
 * Files named directly on the command line, e.g. `node scripts/build.js`.
 * Strong evidence: you ran that file and it failed.
 */
export function extractCommandRefs(commandLine: string): FileRef[] {
  const pattern = /(?:^|\s)(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+))(?=\s|$)/g;
  const refs: FileRef[] = [];

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(commandLine)) !== null) {
    // Three alternatives, exactly one of which participates. RegExpExecArray
    // types every group as `string`, which would hide that from the compiler.
    const [, doubleQuoted, singleQuoted, bare] = match as unknown as Array<string | undefined>;
    const token = doubleQuoted ?? singleQuoted ?? bare;

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

export interface PathResolver {
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
export function createPathResolver(workspaceRoot: string | undefined, cwd: string | undefined): PathResolver {
  const bases = [cwd, workspaceRoot].filter((base): base is string => Boolean(base));
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
      if (absolute) {
        return { file: displayPath(workspaceRoot, absolute), line: ref.line, column: ref.column };
      }

      // No base to resolve against — a window with no folder open, or a path
      // that escapes the workspace. The file still deserves to be ranked and
      // named; it just cannot be opened, so keep the reference in display form
      // rather than discarding the evidence entirely.
      const relative = ref.file.trim().replace(/^\.[\\/]/, '');
      if (!relative || path.isAbsolute(relative) || /^[A-Za-z]:[\\/]/.test(relative)) {
        return undefined;
      }
      return { file: toPosix(relative), line: ref.line, column: ref.column };
    }
  };
}

/** Chooses which locations deserve an inline code snippet. */
function snippetRequests(
  primary: ExtractedError | undefined,
  suspects: Array<{ file: string; line?: number; absolutePath?: string }>,
  resolver: PathResolver,
  workspaceRoot: string | undefined
): SnippetRequest[] {
  const requests: SnippetRequest[] = [];

  if (primary?.file && primary.line !== undefined) {
    const absolute = resolver.toAbsolute(primary.file);
    if (absolute) {
      requests.push({
        absolutePath: absolute,
        // The parsed path is whatever the tool printed, often absolute. The
        // brief must show the workspace-relative form.
        displayPath: displayPath(workspaceRoot, absolute),
        line: primary.line
      });
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

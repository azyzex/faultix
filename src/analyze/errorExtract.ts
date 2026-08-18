/**
 * Error extraction.
 *
 * A repair brief is only useful if it leads with the actual failure rather
 * than 200 lines of build chatter. This module reads sanitized terminal text
 * and pulls out structured error records: message, severity, diagnostic code,
 * and source location, using per-toolchain matchers.
 *
 * Each matcher carries a confidence weight. A line that yields a diagnostic
 * code and a file/line/column is far more trustworthy than a line that merely
 * contains the word "error", so the primary error is chosen by confidence
 * first and position second.
 *
 * Verified against recorded output from tsc, eslint, node, python, pytest,
 * jest, vitest, rustc, go, gcc, javac, msbuild, npm, docker, make, bash and
 * PowerShell; see `src/test/fixtures`.
 *
 * Pure: no `vscode` import.
 */

export type ExtractedSeverity = 'error' | 'warning';

export interface ExtractedError {
  /** Which matcher produced this record; also names the toolchain. */
  matcher: string;
  severity: ExtractedSeverity;
  message: string;
  /** Diagnostic code such as TS2345, E0308 or CS1002, when the tool emits one. */
  code?: string;
  file?: string;
  line?: number;
  column?: number;
  /** Zero-based index of the source line this was found on. */
  index: number;
  /** How much to trust this record relative to others. */
  confidence: number;
  /** The raw line the record came from, trimmed. */
  raw: string;
}

export interface ExtractedRef {
  file: string;
  line?: number;
  column?: number;
  raw: string;
  index: number;
}

/**
 * Lines longer than this are almost always minified bundles or base64 blobs.
 * Capping the length keeps every regex below linear-in-practice cost and
 * removes any chance of pathological backtracking on adversarial input.
 */
const MAX_LINE_LENGTH = 2000;

/** Upper bound on lines scanned, so a 500k-line log cannot stall the host. */
const MAX_LINES_SCANNED = 5000;

/** How far to search for a location belonging to a location-less message. */
const LOCATION_LOOKAHEAD = 10;
const LOCATION_LOOKBEHIND = 12;

/** Confidence tiers, named so the matcher table reads clearly. */
const CONF = {
  codedWithLocation: 100,
  exception: 90,
  location: 70,
  /** An assertion detail explains a failure better than the suite header does. */
  assertion: 65,
  runnerFailure: 60,
  toolPrefixed: 45,
  keyword: 20
} as const;

/**
 * Extensions a file reference may carry. Without this allowlist, expressions
 * like `expect(x).toBe(5)` parse as the file `.toBe` at line 5.
 */
const REF_EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte',
  'py', 'pyi', 'pyx', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'cs', 'fs', 'vb',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hxx', 'm', 'mm',
  'rb', 'php', 'lua', 'pl', 'pm', 'swift', 'dart', 'ex', 'exs', 'erl', 'clj',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'psd1', 'bat', 'cmd',
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'xml', 'ini', 'cfg', 'conf', 'env',
  'sql', 'graphql', 'gql', 'proto', 'md', 'mdx', 'rst',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'styl',
  'gradle', 'tf', 'tfvars', 'csproj', 'vbproj', 'sln', 'lock', 'txt', 'cfg'
]);

/**
 * Capture-group accessor.
 *
 * `RegExpMatchArray` is indexed as `string`, but a group that did not
 * participate yields `undefined` — so `m[3].trim()` on an optional group is a
 * crash the type system cannot see. Going through this interface forces every
 * access to declare which kind of group it is, which puts the distinction the
 * pattern already encodes in front of the compiler.
 */
export interface Captures {
  /** A group the pattern guarantees participated. */
  req(index: number): string;
  /** A group that may not have participated. */
  opt(index: number): string | undefined;
}

class MissingCaptureError extends Error {
  public constructor(matcher: string, index: number) {
    super(`matcher "${matcher}": capture group ${index} was read as required but did not participate`);
    this.name = 'MissingCaptureError';
  }
}

function captures(match: RegExpMatchArray, matcherName: string): Captures {
  return {
    req(index: number): string {
      const value = match[index] as string | undefined;
      if (value === undefined) {
        // A required group that did not participate means the accessor and
        // the pattern disagree: a bug in this file, not in the input.
        throw new MissingCaptureError(matcherName, index);
      }
      return value;
    },
    opt: (index: number): string | undefined => match[index] as string | undefined
  };
}

interface Matcher {
  name: string;
  pattern: RegExp;
  confidence: number;
  build: (c: Captures) => Omit<ExtractedError, 'matcher' | 'index' | 'confidence' | 'raw'> | undefined;
}

const severityOf = (word: string | undefined): ExtractedSeverity =>
  word && /^warn/i.test(word) ? 'warning' : 'error';

const num = (v: string | undefined): number | undefined => {
  if (v === undefined) {
    return undefined;
  }
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/**
 * MSBuild appends the owning project to every diagnostic
 * (`; expected [/repo/src/Demo.csproj]`). It is noise in a brief.
 */
const stripProjectSuffix = (message: string): string =>
  message.replace(/\s*\[[^\]]*\.(?:csproj|vbproj|fsproj|sln|vcxproj)\]\s*$/i, '').trim();

/**
 * Ordered by specificity. The first matcher that claims a line wins, so
 * anything with a diagnostic code must precede the generic location matchers,
 * which in turn precede the keyword fallback.
 */
const MATCHERS: Matcher[] = [
  {
    // tsc / MSBuild / C#: src/a.ts(12,5): error TS2345: Argument of type ...
    name: 'compiler-paren',
    pattern: /^(.+?)\((\d+)(?:,(\d+))?\):\s*(error|warning)\s+([A-Za-z]+\d+):\s*(.+)$/,
    confidence: CONF.codedWithLocation,
    build: (c) => ({
      severity: severityOf(c.req(4)),
      code: c.req(5),
      message: stripProjectSuffix(c.req(6)),
      file: c.req(1).trim(),
      line: num(c.req(2)),
      column: num(c.opt(3))
    })
  },
  {
    // tsc pretty output: src/a.ts:12:5 - error TS2345: Argument of type ...
    name: 'compiler-dash',
    pattern: /^(.+?):(\d+):(\d+)\s+-\s+(error|warning)\s+([A-Za-z]+\d+):\s*(.+)$/,
    confidence: CONF.codedWithLocation,
    build: (c) => ({
      severity: severityOf(c.req(4)),
      code: c.req(5),
      message: stripProjectSuffix(c.req(6)),
      file: c.req(1).trim(),
      line: num(c.req(2)),
      column: num(c.req(3))
    })
  },
  {
    // gcc / clang / many others: main.c:12:5: error: expected ';' before ...
    name: 'gnu-location',
    pattern: /^(.+?):(\d+):(\d+):\s*(fatal error|error|warning):\s*(.+)$/,
    confidence: CONF.codedWithLocation,
    build: (c) => ({
      severity: severityOf(c.req(4)),
      message: c.req(5).trim(),
      file: c.req(1).trim(),
      line: num(c.req(2)),
      column: num(c.req(3))
    })
  },
  {
    // javac / kotlinc: Foo.java:12: error: cannot find symbol
    name: 'javac',
    pattern: /^(.+?\.(?:java|kt|scala)):(\d+):\s*(error|warning):\s*(.+)$/,
    confidence: CONF.codedWithLocation,
    build: (c) => ({
      severity: severityOf(c.req(3)),
      message: c.req(4).trim(),
      file: c.req(1).trim(),
      line: num(c.req(2))
    })
  },
  {
    // PHP: PHP Parse error:  syntax error, unexpected ... in /app/x.php on line 12
    name: 'php',
    pattern: /^PHP\s+(?:Parse|Fatal|Warning)\s*error:\s*(.+?)\s+in\s+(.+?)\s+on line\s+(\d+)/i,
    confidence: CONF.codedWithLocation,
    build: (c) => ({
      severity: 'error',
      message: c.req(1).trim(),
      file: c.req(2).trim(),
      line: num(c.req(3))
    })
  },
  {
    // make: Makefile:4: *** missing separator.  Stop.
    name: 'make',
    pattern: /^(.*[Mm]akefile[\w.]*):(\d+):\s*\*\*\*\s*(.+?)\.?\s*(?:Stop\.)?$/,
    confidence: CONF.codedWithLocation,
    build: (c) => ({
      severity: 'error',
      message: c.req(3).trim(),
      file: c.req(1).trim(),
      line: num(c.req(2))
    })
  },
  {
    // rustc summary lines carry no detail; keep them but rank them low.
    name: 'rustc-summary',
    pattern: /^(?:error|warning):\s*(aborting due to .*|could not compile .*|build failed.*)$/i,
    confidence: CONF.keyword,
    build: (c) => ({ severity: 'error', message: c.req(1).trim() })
  },
  {
    // rustc: error[E0308]: mismatched types
    name: 'rustc-header',
    pattern: /^(error|warning)(?:\[([A-Z]\d+)\])?:\s*(.+)$/,
    confidence: CONF.exception,
    build: (c) => ({
      severity: severityOf(c.req(1)),
      code: c.opt(2),
      message: c.req(3).trim()
    })
  },
  {
    // go build: ./main.go:12:5: undefined: fmtt
    name: 'go-location',
    pattern: /^(\.{0,2}[\w./\\-]*\.go):(\d+)(?::(\d+))?:\s*(.+)$/,
    confidence: CONF.location,
    build: (c) => ({
      severity: 'error',
      message: c.req(4).trim(),
      file: c.req(1).trim(),
      line: num(c.req(2)),
      column: num(c.opt(3))
    })
  },
  {
    // bash / sh: script.sh: line 4: unexpected EOF while looking for matching `"'
    name: 'shell-location',
    pattern: /^(?:(.+?):\s*)?line\s+(\d+):\s*(.+)$/,
    confidence: CONF.location,
    build: (c) => {
      const message = c.req(3).trim();
      if (message.length < 3) {
        return undefined;
      }
      return {
        severity: 'error',
        message,
        file: c.opt(1)?.trim(),
        line: num(c.req(2))
      };
    }
  },
  {
    // Python (and Node) exception line. The optional prefix lets a bare
    // "Error: boom" match as well as "ModuleNotFoundError: ...".
    name: 'exception',
    pattern: /^((?:[A-Z][A-Za-z0-9_.]*)??(?:Error|Exception|Fault|Panic|Failure))(?::\s*(.*))?$/,
    confidence: CONF.exception,
    build: (c) => {
      const type = c.req(1);
      const detail = (c.opt(2) ?? '').trim();
      return {
        severity: 'error',
        code: type,
        message: detail ? `${type}: ${detail}` : type
      };
    }
  },
  {
    // pytest assertion line: E   ZeroDivisionError: division by zero
    name: 'pytest-e',
    pattern: /^E\s{2,}([A-Za-z_.]*(?:Error|Exception|Failed)?):?\s*(.*)$/,
    confidence: CONF.exception,
    build: (c) => {
      const type = c.req(1);
      const detail = c.req(2);
      const message = `${type}${detail ? `: ${detail}` : ''}`.trim();
      return message.length > 2 ? { severity: 'error', message } : undefined;
    }
  },
  {
    // cmd.exe: 'foo' is not recognized as an internal or external command
    name: 'cmd-not-found',
    pattern: /^'?([^'\r\n]+?)'?\s+is not recognized as an internal or external command/,
    confidence: CONF.exception,
    build: (c) => ({
      severity: 'error',
      code: 'CommandNotFound',
      message: `Command not found: ${c.req(1).trim()}`
    })
  },
  {
    // POSIX shells: bash: foo: command not found
    name: 'sh-not-found',
    pattern: /^(?:.*:\s*)?([\w.\-/]+):\s*(?:command not found|not found)$/,
    confidence: CONF.exception,
    build: (c) => ({
      severity: 'error',
      code: 'CommandNotFound',
      message: `Command not found: ${c.req(1).trim()}`
    })
  },
  {
    // jest / vitest suite header: FAIL src/sum.test.js
    name: 'jest-fail',
    pattern: /^\s*FAIL\s+(\S+)(?:\s+[>›]\s+(.*))?$/,
    confidence: CONF.runnerFailure,
    build: (c) => {
      const suite = c.req(1);
      const name = c.opt(2)?.trim();
      return {
        severity: 'error',
        message: name ? `Test failed: ${name}` : `Test suite failed: ${suite}`,
        file: suite
      };
    }
  },
  {
    // Individual failing test marker, where the capture is a test name not a path.
    name: 'test-marker',
    pattern: /^\s*(?:[\u2715\u00d7\u2717\u2718]|\u25cf)\s+(.+?)(?:\s+\(\d+\s*ms\))?$/,
    confidence: CONF.runnerFailure,
    build: (c) => {
      const name = c.req(1).trim();
      return name.length > 1 ? { severity: 'error', message: `Failing test: ${name}` } : undefined;
    }
  },
  {
    // jest/vitest assertion detail, the line that actually explains the failure.
    name: 'assertion',
    pattern: /^\s*(expect\(.+?\)\..+|AssertionError.*|Expected:\s*.+|Received:\s*.+)$/,
    confidence: CONF.assertion,
    build: (c) => {
      const message = c.req(1).trim();
      if (/^(Expected|Received):/.test(message) && message.length < 12) {
        return undefined;
      }
      return { severity: 'error', message };
    }
  },
  {
    // pytest summary: FAILED tests/test_x.py::test_y - AssertionError: ...
    name: 'pytest-failed',
    pattern: /^FAILED\s+([^\s:]+)(?:::(\S+))?\s*(?:-\s*(.*))?$/,
    confidence: CONF.runnerFailure,
    build: (c) => {
      const file = c.req(1);
      const test = c.opt(2);
      const detail = c.opt(3)?.trim();
      return {
        severity: 'error',
        message: detail || `Test failed: ${test ?? file}`,
        file
      };
    }
  },
  {
    // eslint result line: "  12:5  error  'x' is never used  no-unused-vars"
    name: 'eslint',
    pattern: /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}([\w@][\w@/-]*))?\s*$/,
    confidence: CONF.location,
    build: (c) => ({
      severity: severityOf(c.req(3)),
      code: c.opt(5),
      message: c.req(4).trim(),
      line: num(c.req(1)),
      column: num(c.req(2))
    })
  },
  {
    // PowerShell location header: At C:\repo\x.ps1:6 char:24
    name: 'ps-location',
    pattern: /^At\s+(.+?):(\d+)\s+char:(\d+)\s*$/,
    confidence: CONF.location,
    build: (c) => ({
      severity: 'error',
      message: 'PowerShell parse error',
      file: c.req(1).trim(),
      line: num(c.req(2)),
      column: num(c.req(3))
    })
  },
  {
    // PowerShell diagnostic tail: + CategoryInfo : ParserError: (:) [], ...
    name: 'powershell',
    pattern: /^\s*\+?\s*(?:CategoryInfo\s*:\s*)?(ParserError|CommandNotFoundException|RuntimeException|ParentContainsErrorRecordException)\b\s*:?\s*(.*)$/,
    confidence: CONF.toolPrefixed,
    build: (c) => {
      const kind = c.req(1);
      return { severity: 'error', code: kind, message: `PowerShell ${kind}` };
    }
  },
  {
    // npm: npm ERR! code ERESOLVE
    name: 'npm',
    pattern: /^npm ERR!\s+(.+)$/,
    confidence: CONF.toolPrefixed,
    build: (c) => {
      const message = c.req(1).trim();
      if (/^(A complete log|code |errno |path |command |gyp |peer |node_modules)/i.test(message)) {
        return undefined;
      }
      return { severity: 'error', message };
    }
  },
  {
    // docker buildkit
    name: 'docker',
    pattern: /^(?:#\d+\s+)?ERROR:\s*(failed to solve.*|.*did not complete successfully.*)$/,
    confidence: CONF.toolPrefixed,
    build: (c) => ({ severity: 'error', message: c.req(1).trim() })
  },
  {
    // Generic "path:line: something went wrong" used by ruby, lua and sql tools.
    name: 'generic-location',
    pattern: /^(.+?\.[A-Za-z0-9]{1,8}):(\d+):\s*(.+)$/,
    confidence: CONF.location,
    build: (c) => {
      const message = c.req(3).trim();
      if (!/error|expected|unexpected|invalid|cannot|failed|undefined|missing/i.test(message)) {
        return undefined;
      }
      return { severity: 'error', message, file: c.req(1).trim(), line: num(c.req(2)) };
    }
  },
  {
    // Last resort: a line that clearly announces a failure.
    name: 'keyword',
    pattern:
      /^(.*\b(?:fatal|error|exception|panic|failed|failure|cannot|unable to|no such file|permission denied|unterminated|missing the terminator|unexpected token)\b.*)$/i,
    confidence: CONF.keyword,
    build: (c) => {
      const message = c.req(1).trim();
      if (/\b0 (errors?|problems?|failures?)\b/i.test(message)) {
        return undefined;
      }
      if (message.length < 8 || message.length > 400) {
        return undefined;
      }
      return { severity: 'error', message };
    }
  }
];

/**
 * Stand-alone file references, used to seed suspect ranking.
 *
 * Every pattern requires a word character immediately before the extension dot
 * so that method calls (`.toBe(5)`) cannot masquerade as `file(line)` refs.
 */
const REF_PATTERNS: RegExp[] = [
  // Python frames: File "x.py", line 12
  /File\s+"([^"\r\n]+)",\s+line\s+(\d+)/g,
  // rustc arrow: --> src/main.rs:12:5
  /-->\s+([\w./\\-]+):(\d+)(?::(\d+))?/g,
  // path(12,5) or path(12)
  /((?:[A-Za-z]:)?[\w./\\@+-]*\w\.[A-Za-z0-9]{1,8})\((\d+)(?:,(\d+))?\)/g,
  // path:12:5 and path:12
  /((?:[A-Za-z]:)?[\w./\\@+-]*\w\.[A-Za-z0-9]{1,8}):(\d+)(?::(\d+))?/g,
  // PHP: in /app/x.php on line 12
  /\bin\s+([\w./\\:-]*\w\.[A-Za-z0-9]{1,8})\s+on line\s+(\d+)/g
];

/** Lines that look like a bare path, used as file context for eslint-style output. */
const BARE_PATH_PATTERN = /^(?:[A-Za-z]:)?[\w./\\@+-]*\w\.[A-Za-z0-9]{1,8}$/;

/** Normalizes and caps the input so every downstream regex sees sane lines. */
function toScannableLines(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .slice(0, MAX_LINES_SCANNED)
    .map((line) => (line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) : line));
}

/** True when the reference points at something that could be a real file. */
function isPlausibleRef(file: string): boolean {
  if (!file || file.length > 400) {
    return false;
  }
  const base = file.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) {
    return false;
  }
  return REF_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

/**
 * Runs every matcher over the text and returns the structured records, in the
 * order they appeared. A line yields at most one record.
 *
 * A running "current file" is tracked so that tools which print the path once
 * as a header (eslint, jest) still produce located records.
 */
export function extractErrors(text: string): ExtractedError[] {
  if (!text) {
    return [];
  }

  const lines = toScannableLines(text);
  const results: ExtractedError[] = [];
  let currentFile: string | undefined;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    if (BARE_PATH_PATTERN.test(trimmed) && isPlausibleRef(trimmed)) {
      currentFile = trimmed;
      continue;
    }

    for (const matcher of MATCHERS) {
      const match = line.match(matcher.pattern);
      if (!match) {
        continue;
      }

      let built: ReturnType<Matcher['build']>;
      try {
        built = matcher.build(captures(match, matcher.name));
      } catch (error) {
        // A matcher whose accessor disagrees with its pattern is a bug here,
        // but extraction is best effort: skip the matcher rather than losing
        // every remaining error in the output. Tests surface it immediately,
        // because the fixture expectations assert on extracted content.
        if (!(error instanceof MissingCaptureError)) {
          throw error;
        }
        continue;
      }

      if (!built || !built.message) {
        continue;
      }

      results.push({
        ...built,
        file: built.file ?? currentFile,
        matcher: matcher.name,
        index,
        confidence: matcher.confidence,
        raw: trimmed
      });
      break;
    }
  }

  return preferDescriptiveMessages(attachNearbyLocations(results, lines), lines);
}

/**
 * Some tools put the message and the location on different lines: rustc emits
 * `error[E0308]: mismatched types` then ` --> src/main.rs:12:5`, and Python
 * puts the offending frame above the exception. This walks a short window
 * around each location-less record to adopt the closest reference.
 */
function attachNearbyLocations(records: ExtractedError[], lines: string[]): ExtractedError[] {
  return records.map((record) => {
    if (record.file && record.line !== undefined) {
      return record;
    }

    for (let offset = 1; offset <= LOCATION_LOOKAHEAD; offset++) {
      const ref = firstRefIn(lines[record.index + offset], record.index + offset);
      if (ref) {
        return { ...record, file: record.file ?? ref.file, line: record.line ?? ref.line, column: record.column ?? ref.column };
      }
    }

    // Python and Node put the deepest frame immediately above the exception.
    for (let offset = 1; offset <= LOCATION_LOOKBEHIND; offset++) {
      const ref = firstRefIn(lines[record.index - offset], record.index - offset);
      if (ref) {
        return { ...record, file: record.file ?? ref.file, line: record.line ?? ref.line, column: record.column ?? ref.column };
      }
    }

    return record;
  });
}

/**
 * PowerShell (and a few others) print a human sentence and then a structured
 * tail. The tail matches more precisely but reads worse, so when a record's
 * message is a bare marker, adopt the descriptive sentence just above it.
 */
function preferDescriptiveMessages(records: ExtractedError[], lines: string[]): ExtractedError[] {
  return records.map((record) => {
    if (!/^PowerShell (ParserError|RuntimeException)$|^PowerShell parse error$/.test(record.message)) {
      return record;
    }

    // The sentence sits below the caret marker for parser errors and above the
    // structured tail for runtime errors, so search outward in both directions.
    for (const offset of [1, 2, 3, 4, -1, -2, -3, -4]) {
      const candidate = lines[record.index + offset]?.trim();
      if (!candidate || candidate.startsWith('+') || candidate.startsWith('At ')) {
        continue;
      }
      if (/^[A-Z].{10,200}$/.test(candidate) && !/^[~^]+$/.test(candidate)) {
        return { ...record, message: candidate };
      }
    }

    return record;
  });
}

function firstRefIn(line: string | undefined, index: number): ExtractedRef | undefined {
  if (!line) {
    return undefined;
  }
  return extractFileRefs(line, index)[0];
}

/**
 * Pulls every `file:line:col`-shaped reference out of the text. Duplicates are
 * removed, keeping the first occurrence, which is usually the deepest and most
 * relevant frame.
 */
export function extractFileRefs(text: string, baseIndex = 0): ExtractedRef[] {
  if (!text) {
    return [];
  }

  const lines = toScannableLines(text);
  const seen = new Set<string>();
  const results: ExtractedRef[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of REF_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = pattern.exec(line)) !== null) {
        const file = match[1];
        if (!isPlausibleRef(file)) {
          continue;
        }

        const line1 = num(match[2]);
        const column = num(match[3]);
        const key = `${file}|${line1 ?? ''}|${column ?? ''}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);

        results.push({ file, line: line1, column, raw: match[0], index: baseIndex + i });

        if (results.length >= 200) {
          return results;
        }
      }
    }
  }

  return results;
}

/**
 * Picks the single error a repair brief should lead with.
 *
 * Highest confidence wins. Within a tier, the earliest record wins for
 * compiler-style output (the first error usually causes the rest) but the
 * latest wins for exception-style output, where the trailing line is the
 * exception that actually terminated the process.
 */
export function extractPrimaryError(text: string): ExtractedError | undefined {
  const records = extractErrors(text);
  if (!records.length) {
    return undefined;
  }

  const best = Math.max(...records.map((r) => r.confidence));
  const tier = records.filter((r) => r.confidence === best);

  const exceptionLike = tier.filter((r) => r.matcher === 'exception' || r.matcher === 'pytest-e');
  if (exceptionLike.length) {
    return exceptionLike[exceptionLike.length - 1];
  }

  return tier[0];
}

/**
 * Deduplicates records that repeat the same message so a brief lists distinct
 * problems rather than the same one forty times.
 */
export function dedupeErrors(records: ExtractedError[], limit = 20): ExtractedError[] {
  const seen = new Set<string>();
  const out: ExtractedError[] = [];

  for (const record of records) {
    const key = `${record.severity}|${record.code ?? ''}|${displayKey(record.message)}|${record.file ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(record);
    if (out.length >= limit) {
      break;
    }
  }

  return out;
}

/**
 * Ranks records for display: strongest evidence first, then document order.
 */
export function rankErrors(records: ExtractedError[]): ExtractedError[] {
  return [...records].sort((a, b) => {
    if (a.severity !== b.severity) {
      return a.severity === 'error' ? -1 : 1;
    }
    if (a.confidence !== b.confidence) {
      return b.confidence - a.confidence;
    }
    return a.index - b.index;
  });
}

/**
 * Dedupe key for *display*.
 *
 * Deliberately lighter than `normalizeMessage`: quoted literals are kept,
 * because `Type 'string' is not assignable to type 'number'` and
 * `Type 'number' is not assignable to type 'string'` are two different
 * problems that a brief must list separately. Only the values that genuinely
 * repeat without meaning - line numbers, offsets, counts - are collapsed.
 */
export function displayKey(message: string): string {
  return message
    .trim()
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * Strips the variable parts of a message so that two runs of the same failure
 * hash to the same fingerprint: numbers, quoted literals, paths, and hex ids.
 *
 * Lossier than `displayKey` on purpose: for fingerprinting, the same failure
 * about a different file or symbol should still count as a repeat.
 */
export function normalizeMessage(message: string): string {
  return message
    .trim()
    .replace(/(?:[A-Za-z]:)?[\\/][^\s'"]+/g, '<path>')
    .replace(/'[^']*'|"[^"]*"/g, '<str>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * One-line human summary of what went wrong, suitable for a title or the
 * status bar. Falls back to the command description when nothing parsed.
 */
export function summarizeFailure(text: string, fallback: string): string {
  const primary = extractPrimaryError(text);
  if (!primary) {
    return fallback;
  }

  const location = primary.file
    ? ` (${primary.file}${primary.line !== undefined ? `:${primary.line}` : ''})`
    : '';
  const code = primary.code && !primary.message.startsWith(primary.code) ? `${primary.code}: ` : '';

  return truncate(`${code}${primary.message}${location}`, 200);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 3))}...`;
}

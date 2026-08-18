/**
 * End-to-end coverage of the analysis pipeline.
 *
 * These tests run a recorded terminal capture through every stage the real
 * extension uses - sanitize, redact, classify, extract, rank, render - and
 * assert on the finished brief. They are the closest thing to "does Faultix
 * actually work" that can run without an Extension Host, and they are what
 * would catch a regression that unit tests on individual modules would miss.
 */

import * as assert from 'assert';
import { extractPrimaryError } from '../../analyze/errorExtract';
import { analyzeFailure, DEFAULT_ANALYSIS_OPTIONS } from '../../analyze/pipeline';
import type { DiagnosticCount } from '../../analyze/scoring';
import { sanitizeTerminalOutput } from '../../analyze/ansi';
import { redactWithReport } from '../../privacy/redact';
import { buildIncidentMarkdown, buildRepairPrompt } from '../../output/templates';
import type { Incident } from '../../core/models';
import { readFixture } from './helpers';

/**
 * Runs the real pipeline. Before this, the harness re-implemented the stages
 * by hand, which meant the suite could stay green while the extension's own
 * assembly drifted away from it.
 *
 * File reads are disabled because fixture paths point at machines that no
 * longer exist; snippet rendering is covered separately in templates.test.ts.
 */
function runPipeline(
  fixture: string,
  commandLine: string,
  options: { diagnostics?: DiagnosticCount[]; gitChangedFiles?: string[] } = {}
): Incident {
  const diagnostics = options.diagnostics;

  return analyzeFailure({
    trigger: 'terminal',
    options: { ...DEFAULT_ANALYSIS_OPTIONS, allowFileReads: false },
    rawOutput: readFixture(fixture),
    commandLine,
    exitCode: 1,
    workspaceName: 'demo',
    diagnostics: diagnostics
      ? {
          total: diagnostics.reduce((sum, d) => sum + d.errors + d.warnings, 0),
          errors: diagnostics.reduce((sum, d) => sum + d.errors, 0),
          warnings: diagnostics.reduce((sum, d) => sum + d.warnings, 0),
          top: [],
          byFile: diagnostics,
          absoluteByDisplay: new Map()
        }
      : undefined,
    git: options.gitChangedFiles
      ? { enabled: true, insideWorkTree: true, changedFiles: options.gitChangedFiles }
      : undefined,
    // Fixed clock so ids and fingerprints are reproducible.
    now: new Date('2026-01-01T00:00:00.000Z')
  });
}

suite('pipeline/python runtime failure', () => {
  const incident = runPipeline('py-runtime.txt', 'python python/runtime_error.py');

  test('classifies as a runtime failure', () => {
    assert.strictEqual(incident.kind, 'runtime');
  });

  test('summarizes the root cause', () => {
    assert.ok(incident.summary?.includes('ZeroDivisionError'));
    assert.ok(incident.summary?.includes('division by zero'));
  });

  test('points at the frame that raised, not the entry point', () => {
    assert.strictEqual(incident.primaryError?.line, 6);
  });

  test('ranks the failing file first', () => {
    assert.ok(incident.suspects?.[0].file.includes('runtime_error.py'));
  });

  test('renders a brief that leads with the cause', () => {
    const markdown = buildIncidentMarkdown(incident);
    assert.ok(markdown.startsWith('# ZeroDivisionError'));
    assert.ok(markdown.includes('## Files to inspect first'));
  });

  test('renders a prompt an agent can act on', () => {
    const prompt = buildRepairPrompt(incident);
    assert.ok(prompt.includes('## Most likely root cause'));
    assert.ok(prompt.includes('## Your task'));
    assert.ok(prompt.includes('python python/runtime_error.py'));
  });
});

suite('pipeline/typescript type errors', () => {
  const incident = runPipeline('tsc-type-errors.txt', 'npx tsc --noEmit');

  test('classifies as a type check', () => {
    assert.strictEqual(incident.kind, 'typecheck');
    assert.strictEqual(incident.command?.toolHint, 'tsc');
  });

  test('collapses repeats but keeps genuinely distinct diagnostics', () => {
    const messages = (incident.errors ?? []).map((e) => e.message);

    // tsc reported the same assignment error on four lines; that is one problem.
    assert.strictEqual(
      messages.filter((m) => m.includes("Type 'number' is not assignable to type 'string'")).length,
      1
    );

    // But the reverse assignment is a different problem and must survive.
    assert.ok(messages.some((m) => m.includes("Type 'string' is not assignable to type 'number'")));

    const codes = new Set((incident.errors ?? []).map((e) => e.code));
    assert.ok(codes.has('TS2307'), 'missing module error kept');
    assert.ok(codes.has('TS2345'), 'argument type error kept');
    assert.ok(codes.has('TS18047'), 'nullability error kept');
    assert.ok(codes.size >= 5, `expected several distinct codes, got ${[...codes].join(', ')}`);
  });

  test('carries diagnostic codes through to the brief', () => {
    assert.ok(buildIncidentMarkdown(incident).includes('TS2322'));
  });

  test('ranks both offending files', () => {
    const files = (incident.suspects ?? []).map((s) => s.file);
    assert.ok(files.some((f) => f.includes('type_errors.ts')));
    assert.ok(files.some((f) => f.includes('import_errors.ts')));
  });
});

suite('pipeline/noisy terminal capture', () => {
  const incident = runPipeline('ansi-noisy.txt', 'cmd /c scripts\\bad.bat');

  test('produces a brief with no escape bytes', () => {
    const markdown = buildIncidentMarkdown(incident);
    assert.ok(!markdown.includes(String.fromCharCode(0x1b)));
    assert.ok(!markdown.includes(String.fromCharCode(0x07)));
  });

  test('identifies the missing command', () => {
    assert.ok(incident.summary?.includes('Command not found'));
  });

  test('keeps the readable output', () => {
    assert.ok(incident.terminalExcerpt?.includes('Starting batch error demo'));
  });
});

suite('pipeline/ranking under ambient noise', () => {
  // The original ranking bug: a warning-heavy unrelated file outranked the
  // file the failure actually named.
  const incident = runPipeline('py-runtime.txt', 'python python/runtime_error.py', {
    diagnostics: [
      { file: 'unrelated/tsconfig.invalid.json', errors: 0, warnings: 40 },
      { file: 'another/noisy.ts', errors: 2, warnings: 10 }
    ]
  });

  test('keeps the failing file on top despite the noise', () => {
    assert.ok(incident.suspects?.[0].file.includes('runtime_error.py'));
  });

  test('drops files known only from ambient diagnostics', () => {
    const files = (incident.suspects ?? []).map((s) => s.file);
    assert.ok(!files.some((f) => f.includes('tsconfig.invalid.json')), 'warning pile is not a suspect');
    assert.ok(!files.some((f) => f.includes('noisy.ts')), 'unrelated errors are not suspects either');
  });
});

suite('pipeline/home paths never reach the brief', () => {
  // npm prints absolute paths inside its messages, not only in the surrounding
  // output, so anonymizing the excerpt alone left them in the error list.
  const incident = runPipeline('npm-enoent.txt', 'npm run verify');

  test('the summary carries no home directory', () => {
    assert.ok(!incident.summary?.includes('C:\Users\dev'), incident.summary);
    assert.ok(incident.summary?.includes('<home>'));
  });

  test('no parsed error carries a home directory', () => {
    for (const error of incident.errors ?? []) {
      assert.ok(!error.message.includes('C:\Users\dev'), `leaked in: ${error.message}`);
    }
  });

  test('the rendered brief carries no home directory anywhere', () => {
    const markdown = buildIncidentMarkdown(incident);
    assert.ok(!markdown.includes('C:\Users\dev'), 'home path leaked into the brief');
    assert.ok(!markdown.includes('/Users/dev'), 'posix home path leaked into the brief');
  });

  test('the agent prompt carries no home directory either', () => {
    assert.ok(!buildRepairPrompt(incident).includes('C:\Users\dev'));
  });
});

suite('pipeline/secret handling', () => {
  test('a token printed by a failing command never reaches the brief', () => {
    const raw = [
      'Deploying with GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'Traceback (most recent call last):',
      '  File "deploy.py", line 12, in <module>',
      '    raise RuntimeError("deploy failed")',
      'RuntimeError: deploy failed'
    ].join('\n');

    const redaction = redactWithReport(sanitizeTerminalOutput(raw));
    assert.ok(!redaction.text.includes('ghp_abcdefghij'));
    assert.ok(redaction.total > 0);

    const primary = extractPrimaryError(redaction.text);
    assert.ok(primary?.message.includes('deploy failed'), 'redaction must not break extraction');
    assert.strictEqual(primary?.line, 12);
  });
});

suite('pipeline/repeat detection', () => {
  test('the same failure fingerprints identically across runs', () => {
    const first = runPipeline('py-runtime.txt', 'python python/runtime_error.py');
    const second = runPipeline('py-runtime.txt', 'python python/runtime_error.py');
    assert.strictEqual(first.fingerprint.signature, second.fingerprint.signature);
  });

  test('a different failure fingerprints differently', () => {
    const python = runPipeline('py-runtime.txt', 'python python/runtime_error.py');
    const types = runPipeline('tsc-type-errors.txt', 'npx tsc --noEmit');
    assert.notStrictEqual(python.fingerprint.signature, types.fingerprint.signature);
  });
});

suite('pipeline/every fixture produces a usable brief', () => {
  const commands: Record<string, string> = {
    'ansi-noisy.txt': 'cmd /c scripts\\bad.bat',
    'docker-build.txt': 'docker build -t app .',
    'eslint-errors.txt': 'npx eslint src',
    'gcc-errors.txt': 'gcc -Wall -c main.c',
    'go-build.txt': 'go build ./...',
    'javac-errors.txt': 'javac Main.java',
    'jest-failures.txt': 'npx jest',
    'make-missing-separator.txt': 'make',
    'msbuild-csharp.txt': 'dotnet build',
    'node-promise.txt': 'node node-js/unhandled_promise.js',
    'node-runtime.txt': 'node node-js/runtime_error.js',
    'node-syntax.txt': 'node node-js/broken_syntax.js',
    'npm-enoent.txt': 'npm run verify',
    'npm-eresolve.txt': 'npm install',
    'powershell-parse.txt': 'pwsh shell/bad.ps1',
    'py-import.txt': 'python python/import_error.py',
    'py-runtime.txt': 'python python/runtime_error.py',
    'py-syntax.txt': 'python python/broken_syntax.py',
    'pytest-failures.txt': 'pytest -q',
    'rustc-errors.txt': 'cargo build',
    'sh-error.txt': 'bash shell/bad.sh',
    'tsc-errors.txt': 'npx tsc --noEmit',
    'tsc-type-errors.txt': 'npx tsc --noEmit',
    'vitest-failures.txt': 'npx vitest run'
  };

  for (const [fixture, command] of Object.entries(commands)) {
    test(`${fixture} renders a complete brief`, () => {
      const incident = runPipeline(fixture, command);
      const markdown = buildIncidentMarkdown(incident);
      const prompt = buildRepairPrompt(incident);

      assert.ok(incident.summary && incident.summary.length > 5, 'has a summary');
      assert.ok(incident.primaryError, 'has a root cause');
      assert.ok(markdown.includes('## Root cause'), 'brief states the cause');
      assert.ok(prompt.includes('## Your task'), 'prompt ends with a task');
      assert.ok(markdown.length > 200, 'brief is substantive');
      // "undefined" is legitimate error text ("undefined: fmtt", "expected
      // undefined to be ''"), so check the structural positions instead.
      assert.ok(!/\|\s*undefined\s*\|/.test(markdown), 'no undefined in the facts table');
      assert.ok(!markdown.includes('undefined:undefined'), 'no undefined location');
      assert.ok(!markdown.includes('`undefined`'), 'no undefined rendered as a value');
      assert.ok(!markdown.includes('[object Object]'), 'no object leaks into the render');
    });
  }
});

suite('pipeline/no workspace folder open', () => {
  // A window with a single file open has no workspace root, so relative paths
  // cannot be resolved to disk. The evidence is still worth ranking; it just
  // cannot be opened.
  const incident = runPipeline('go-build.txt', 'go build ./...');

  test('still ranks suspects', () => {
    assert.ok((incident.suspects?.length ?? 0) > 0, 'suspects must survive an unresolvable root');
    assert.ok(incident.suspects?.[0].file.includes('main.go'));
  });

  test('names them in display form', () => {
    assert.ok(!incident.suspects?.[0].file.startsWith('./'), 'leading ./ is normalized away');
  });

  test('reports no absolute path, because there is none to report', () => {
    assert.strictEqual(incident.suspects?.[0].absolutePath, undefined);
  });

  test('still renders a complete brief', () => {
    const markdown = buildIncidentMarkdown(incident);
    assert.ok(markdown.includes('## Root cause'));
    assert.ok(markdown.includes('main.go'));
  });
});

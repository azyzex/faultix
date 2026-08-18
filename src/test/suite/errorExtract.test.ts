import * as assert from 'assert';
import { sanitizeTerminalOutput } from '../../analyze/ansi';
import {
  dedupeErrors,
  extractErrors,
  extractFileRefs,
  extractPrimaryError,
  normalizeMessage,
  rankErrors,
  summarizeFailure
} from '../../analyze/errorExtract';
import { allFixtures, readFixture } from './helpers';

/** Reads a fixture the same way the capture pipeline would. */
function clean(name: string): string {
  return sanitizeTerminalOutput(readFixture(name));
}

/**
 * The contract each recorded capture must satisfy: what the primary error
 * should say, and where it should point. These are the assertions that keep
 * the matchers honest as new toolchains are added.
 */
interface Expectation {
  messageIncludes: string;
  fileIncludes?: string;
  line?: number;
  code?: string;
}

const EXPECTATIONS: Record<string, Expectation> = {
  'ansi-noisy.txt': { messageIncludes: 'Command not found', code: 'CommandNotFound' },
  'docker-build.txt': { messageIncludes: 'did not complete successfully' },
  'eslint-errors.txt': {
    messageIncludes: 'is assigned a value but never used',
    fileIncludes: 'lint_demo_tmp.ts',
    line: 2
  },
  'gcc-errors.txt': { messageIncludes: "expected ';' before 'return'", fileIncludes: 'main.c', line: 5 },
  'go-build.txt': { messageIncludes: 'undefined: fmtt', fileIncludes: 'main.go', line: 9 },
  'javac-errors.txt': { messageIncludes: 'package Systm does not exist', fileIncludes: 'Main.java', line: 3 },
  'jest-failures.txt': { messageIncludes: 'expect(received)', fileIncludes: 'sum.test.js' },
  'make-missing-separator.txt': { messageIncludes: 'missing separator', fileIncludes: 'Makefile', line: 4 },
  'msbuild-csharp.txt': { messageIncludes: '; expected', fileIncludes: 'Program.cs', line: 12, code: 'CS1002' },
  'node-promise.txt': { messageIncludes: 'Boom: unhandled rejection', fileIncludes: 'unhandled_promise.js' },
  'node-runtime.txt': { messageIncludes: 'is not a function', fileIncludes: 'runtime_error.js' },
  'node-syntax.txt': { messageIncludes: 'missing ) after argument list', fileIncludes: 'broken_syntax.js', line: 4 },
  'npm-eresolve.txt': { messageIncludes: 'unable to resolve dependency tree' },
  'powershell-parse.txt': { messageIncludes: 'missing the terminator', fileIncludes: 'bad.ps1', line: 6 },
  'py-import.txt': { messageIncludes: 'No module named', fileIncludes: 'import_error.py', line: 3 },
  'py-runtime.txt': { messageIncludes: 'division by zero', fileIncludes: 'runtime_error.py', line: 6 },
  'py-syntax.txt': { messageIncludes: "expected ':'", fileIncludes: 'broken_syntax.py', line: 3 },
  'pytest-failures.txt': { messageIncludes: 'division by zero', fileIncludes: 'calc.py' },
  'rustc-errors.txt': { messageIncludes: 'cannot find value', fileIncludes: 'main.rs', line: 3, code: 'E0425' },
  'sh-error.txt': { messageIncludes: 'unexpected EOF', fileIncludes: 'bad.sh', line: 4 },
  'tsc-errors.txt': { messageIncludes: "':' expected", fileIncludes: 'syntax_error.ts', line: 4, code: 'TS1005' },
  'tsc-type-errors.txt': { messageIncludes: 'Cannot find module', fileIncludes: 'import_errors.ts', code: 'TS2307' },
  'vitest-failures.txt': { messageIncludes: 'AssertionError', fileIncludes: 'parse.test.ts', line: 14 }
};

suite('errorExtract/primary error per toolchain', () => {
  for (const [fixture, expected] of Object.entries(EXPECTATIONS)) {
    test(`${fixture}: identifies the root cause`, () => {
      const primary = extractPrimaryError(clean(fixture));
      assert.ok(primary, `expected a primary error for ${fixture}`);

      assert.ok(
        primary.message.includes(expected.messageIncludes),
        `message "${primary.message}" should include "${expected.messageIncludes}"`
      );

      if (expected.fileIncludes) {
        assert.ok(primary.file, `expected a file for ${fixture}`);
        assert.ok(
          primary.file.includes(expected.fileIncludes),
          `file "${primary.file}" should include "${expected.fileIncludes}"`
        );
      }

      if (expected.line !== undefined) {
        assert.strictEqual(primary.line, expected.line, `wrong line for ${fixture}`);
      }

      if (expected.code) {
        assert.strictEqual(primary.code, expected.code, `wrong code for ${fixture}`);
      }
    });
  }
});

suite('errorExtract/coverage of the fixture corpus', () => {
  test('every recorded capture yields at least one error', () => {
    const missed = allFixtures().filter((f) => extractErrors(clean(f)).length === 0);
    assert.deepStrictEqual(missed, [], 'these fixtures produced no errors');
  });

  test('every recorded capture yields a primary error', () => {
    const missed = allFixtures().filter((f) => !extractPrimaryError(clean(f)));
    assert.deepStrictEqual(missed, [], 'these fixtures produced no primary error');
  });

  test('every expectation names a fixture that exists', () => {
    const known = new Set(allFixtures());
    const unknown = Object.keys(EXPECTATIONS).filter((f) => !known.has(f));
    assert.deepStrictEqual(unknown, []);
  });

  test('every fixture has an expectation', () => {
    const covered = new Set(Object.keys(EXPECTATIONS));
    const uncovered = allFixtures().filter((f) => !covered.has(f));
    assert.deepStrictEqual(uncovered, []);
  });
});

suite('errorExtract/extractErrors', () => {
  test('finds every tsc diagnostic', () => {
    const errors = extractErrors(clean('tsc-type-errors.txt'));
    assert.ok(errors.length >= 9, `expected many diagnostics, got ${errors.length}`);
    assert.ok(errors.every((e) => e.matcher === 'compiler-paren'));
  });

  test('records severity', () => {
    const errors = extractErrors(clean('msbuild-csharp.txt'));
    assert.ok(errors.some((e) => e.severity === 'warning'), 'expected a warning');
    assert.ok(errors.some((e) => e.severity === 'error'), 'expected an error');
  });

  test('strips the MSBuild project suffix from messages', () => {
    const errors = extractErrors(clean('msbuild-csharp.txt'));
    assert.ok(errors.every((e) => !e.message.includes('.csproj')));
  });

  test('adopts the eslint file header for indented result lines', () => {
    const errors = extractErrors(clean('eslint-errors.txt'));
    assert.ok(errors.length >= 2);
    assert.ok(errors.every((e) => e.file?.endsWith('lint_demo_tmp.ts')));
  });

  test('returns an empty list for text with no failure', () => {
    assert.deepStrictEqual(extractErrors('Build succeeded.\n0 errors, 0 warnings'), []);
  });

  test('handles empty input', () => {
    assert.deepStrictEqual(extractErrors(''), []);
  });

  test('caps work on pathological input', () => {
    const huge = ('x'.repeat(5000) + '\n').repeat(20000);
    const start = Date.now();
    extractErrors(huge);
    assert.ok(Date.now() - start < 5000, 'extraction should stay bounded');
  });
});

suite('errorExtract/extractFileRefs', () => {
  test('reads Python traceback frames', () => {
    const refs = extractFileRefs(clean('py-runtime.txt'));
    assert.ok(refs.some((r) => r.file.endsWith('runtime_error.py') && r.line === 10));
    assert.ok(refs.some((r) => r.line === 6));
  });

  test('reads rustc arrow locations', () => {
    // Recorded on Windows, so cargo prints a backslash separator.
    const refs = extractFileRefs(clean('rustc-errors.txt'));
    assert.ok(
      refs.some((r) => r.file.replace(/\\/g, '/') === 'src/main.rs' && r.line === 3 && r.column === 20),
      `expected src/main.rs:3:20, got ${refs.map((r) => `${r.file}:${r.line}:${r.column}`).join(', ')}`
    );
  });

  test('reads paren-style locations', () => {
    const refs = extractFileRefs('src/Program.cs(12,30): error CS1002: ; expected');
    assert.strictEqual(refs[0].file, 'src/Program.cs');
    assert.strictEqual(refs[0].line, 12);
    assert.strictEqual(refs[0].column, 30);
  });

  test('does not mistake a method call for a file reference', () => {
    const refs = extractFileRefs('expect(sum(2, 3)).toBe(5);');
    assert.deepStrictEqual(refs, []);
  });

  test('does not mistake a bare number in parentheses for a location', () => {
    assert.deepStrictEqual(extractFileRefs('retry(3) failed'), []);
  });

  test('rejects unknown extensions', () => {
    assert.deepStrictEqual(extractFileRefs('thing.zzzz:12'), []);
  });

  test('deduplicates repeated references', () => {
    const refs = extractFileRefs('a.ts:1\na.ts:1\na.ts:1');
    assert.strictEqual(refs.length, 1);
  });

  test('handles Windows absolute paths', () => {
    const refs = extractFileRefs('C:\\repo\\src\\a.ts:12:5');
    assert.strictEqual(refs[0].file, 'C:\\repo\\src\\a.ts');
    assert.strictEqual(refs[0].line, 12);
  });
});

suite('errorExtract/dedupeErrors', () => {
  test('collapses repeats of the same message', () => {
    const errors = extractErrors('a.ts(1,1): error TS1: same\na.ts(1,1): error TS1: same');
    assert.strictEqual(dedupeErrors(errors).length, 1);
  });

  test('keeps distinct messages', () => {
    const errors = extractErrors('a.ts(1,1): error TS1: one\na.ts(2,1): error TS1: two');
    assert.strictEqual(dedupeErrors(errors).length, 2);
  });

  test('treats messages differing only by a number as one problem', () => {
    // This is the point of normalization: the same failure at forty call sites
    // is one problem, not forty.
    const text = Array.from({ length: 50 }, (_, i) => `a.ts(${i},1): error TS1: msg ${i}`).join('\n');
    assert.strictEqual(dedupeErrors(extractErrors(text)).length, 1);
  });

  test('honours the limit', () => {
    const text = Array.from({ length: 50 }, (_, i) => `a.ts(1,1): error TS1: distinct problem ${'x'.repeat(i + 1)}`).join('\n');
    assert.strictEqual(dedupeErrors(extractErrors(text), 5).length, 5);
  });
});

suite('errorExtract/rankErrors', () => {
  test('puts errors before warnings', () => {
    const errors = extractErrors(clean('msbuild-csharp.txt'));
    const ranked = rankErrors(errors);
    const firstWarning = ranked.findIndex((e) => e.severity === 'warning');
    const lastError = ranked.map((e) => e.severity).lastIndexOf('error');
    assert.ok(firstWarning === -1 || firstWarning > lastError);
  });
});

suite('errorExtract/normalizeMessage', () => {
  test('collapses numbers', () => {
    assert.strictEqual(normalizeMessage('failed after 42 retries'), 'failed after <n> retries');
  });

  test('collapses quoted literals', () => {
    assert.strictEqual(normalizeMessage("cannot find 'foo'"), 'cannot find <str>');
  });

  test('collapses paths', () => {
    assert.strictEqual(normalizeMessage('cannot open /tmp/abc/def.txt'), 'cannot open <path>');
  });

  test('makes two runs of the same failure identical', () => {
    const a = normalizeMessage("Cannot find module '/repo/a/x.js' at line 12");
    const b = normalizeMessage("Cannot find module '/other/b/y.js' at line 99");
    assert.strictEqual(a, b);
  });
});

suite('errorExtract/summarizeFailure', () => {
  test('summarizes a real capture', () => {
    const summary = summarizeFailure(clean('py-runtime.txt'), 'fallback');
    assert.ok(summary.includes('division by zero'));
    assert.ok(summary.includes('runtime_error.py'));
  });

  test('falls back when nothing parses', () => {
    assert.strictEqual(summarizeFailure('all fine', 'the fallback'), 'the fallback');
  });

  test('bounds the summary length', () => {
    const long = `Error: ${'x'.repeat(1000)}`;
    assert.ok(summarizeFailure(long, 'f').length <= 201);
  });
});

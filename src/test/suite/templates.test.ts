import * as assert from 'assert';
import {
  buildIncidentMarkdown,
  buildRepairPrompt,
  fenceLanguage,
  formatErrorLine,
  formatLocation,
  oneLine,
  renderSnippet,
  repeatNote
} from '../../output/templates';
import type { IncidentView } from '../../output/templates';

function view(overrides: Partial<IncidentView> = {}): IncidentView {
  return {
    id: '2026-01-01T00-00-00-000Z_abc123',
    createdAt: '2026-01-01T00:00:00.000Z',
    kind: 'test',
    status: 'unresolved',
    title: 'Command failed (1): npm test',
    summary: "AssertionError: expected 2 to be 3 (src/sum.test.ts:4)",
    workspaceName: 'demo',
    command: { commandLine: 'npm test', exitCode: 1, toolHint: 'vitest', durationMs: 2500 },
    primaryError: {
      severity: 'error',
      message: 'expected 2 to be 3',
      code: 'AssertionError',
      file: 'src/sum.test.ts',
      line: 4,
      column: 21
    },
    errors: [
      { severity: 'error', message: 'expected 2 to be 3', file: 'src/sum.test.ts', line: 4 },
      { severity: 'warning', message: 'unused import', file: 'src/sum.ts', line: 1 }
    ],
    terminalExcerpt: 'FAIL src/sum.test.ts\nexpected 2 to be 3',
    snippets: [
      {
        file: 'src/sum.test.ts',
        startLine: 2,
        focusLine: 4,
        lines: ['import { sum } from "./sum";', '', 'test("adds", () => {', '  expect(sum(1, 1)).toBe(3);', '});']
      }
    ],
    diagnostics: {
      total: 3,
      errors: 1,
      warnings: 2,
      top: [{ file: 'src/sum.ts', severity: 'error', message: 'Type error', line: 7 }]
    },
    suspects: [
      { file: 'src/sum.test.ts', score: 155, reasons: ['Named by the primary error'], line: 4 },
      { file: 'src/sum.ts', score: 40, reasons: ['Mentioned in the failure output', 'Modified in the working tree'] }
    ],
    git: { branch: 'feature/sum', isDirty: true, changedFiles: ['src/sum.ts'] },
    fingerprint: { signature: 'abc123def456', count: 1, firstSeen: 'x', lastSeen: 'y' },
    ...overrides
  };
}

suite('templates/fenceLanguage', () => {
  const cases: Array<[string, string]> = [
    ['a.ts', 'ts'],
    ['a.py', 'python'],
    ['a.rs', 'rust'],
    ['a.go', 'go'],
    ['a.cs', 'csharp'],
    ['a.ps1', 'powershell'],
    ['a.yml', 'yaml'],
    ['Dockerfile', 'dockerfile'],
    ['build/Makefile', 'makefile'],
    ['a.unknownext', 'text']
  ];
  for (const [file, expected] of cases) {
    test(`${file} -> ${expected}`, () => assert.strictEqual(fenceLanguage(file), expected));
  }

  test('handles undefined', () => assert.strictEqual(fenceLanguage(undefined), 'text'));
});

suite('templates/formatLocation', () => {
  test('renders file, line and column', () => {
    assert.strictEqual(formatLocation({ file: 'a.ts', line: 2, column: 3 }), 'a.ts:2:3');
  });
  test('omits the column when unknown', () => {
    assert.strictEqual(formatLocation({ file: 'a.ts', line: 2 }), 'a.ts:2');
  });
  test('omits the line when unknown', () => {
    assert.strictEqual(formatLocation({ file: 'a.ts' }), 'a.ts');
  });
  test('returns empty without a file', () => {
    assert.strictEqual(formatLocation({ line: 2 }), '');
  });
});

suite('templates/oneLine', () => {
  test('collapses newlines so a message cannot break a list', () => {
    assert.strictEqual(oneLine('a\n  b\t c '), 'a b c');
  });
});

suite('templates/renderSnippet', () => {
  const snippet = {
    file: 'src/a.ts',
    startLine: 8,
    focusLine: 10,
    lines: ['const a = 1;', 'const b = 2;', 'throw new Error("x");']
  };

  test('opens a fence for the right language', () => {
    assert.strictEqual(renderSnippet(snippet)[0], '```ts');
  });

  test('numbers every line from startLine', () => {
    const rendered = renderSnippet(snippet).join('\n');
    assert.ok(rendered.includes(' 8 | const a = 1;'));
    assert.ok(rendered.includes(' 9 | const b = 2;'));
  });

  test('marks the focus line', () => {
    const rendered = renderSnippet(snippet).join('\n');
    assert.ok(rendered.includes('> 10 | throw new Error("x");'));
  });

  test('aligns line numbers of differing width', () => {
    const wide = { file: 'a.ts', startLine: 98, lines: ['a', 'b', 'c', 'd'] };
    const rendered = renderSnippet(wide).join('\n');
    assert.ok(rendered.includes('  98 | a'));
    assert.ok(rendered.includes(' 101 | d'));
  });

  test('notes truncation', () => {
    assert.ok(renderSnippet({ ...snippet, truncated: true }).join('\n').includes('truncated'));
  });
});

suite('templates/repeatNote', () => {
  test('says nothing the first time', () => assert.strictEqual(repeatNote(1), undefined));
  test('mentions a small repeat', () => assert.ok(repeatNote(3)?.includes('3 times')));
  test('escalates a persistent repeat', () => assert.ok(repeatNote(6)?.includes('did not hold')));
});

suite('templates/formatErrorLine', () => {
  test('includes code, message and location', () => {
    const line = formatErrorLine({ severity: 'error', message: 'boom', code: 'TS1', file: 'a.ts', line: 3 });
    assert.ok(line.includes('TS1'));
    assert.ok(line.includes('boom'));
    assert.ok(line.includes('a.ts:3'));
  });

  test('marks warnings', () => {
    assert.ok(formatErrorLine({ severity: 'warning', message: 'meh' }).includes('WARN'));
  });

  test('omits the location when unknown', () => {
    assert.strictEqual(formatErrorLine({ severity: 'error', message: 'boom' }), 'boom');
  });
});

suite('templates/buildIncidentMarkdown', () => {
  const markdown = buildIncidentMarkdown(view());

  test('leads with the summary', () => {
    assert.ok(markdown.startsWith('# AssertionError: expected 2 to be 3'));
  });

  test('includes the facts table', () => {
    assert.ok(markdown.includes('| **Kind** | Test failure |'));
    assert.ok(markdown.includes('| **Exit code** | 1 |'));
    assert.ok(markdown.includes('| **Tool** | vitest |'));
    assert.ok(markdown.includes('| **Duration** | 2.5s |'));
  });

  test('includes the root cause section', () => {
    assert.ok(markdown.includes('## Root cause'));
  });

  test('includes code context with the focus marker', () => {
    assert.ok(markdown.includes('## Code context'));
    assert.ok(markdown.includes('> 4 |'));
  });

  test('lists suspects with reasons', () => {
    assert.ok(markdown.includes('## Files to inspect first'));
    assert.ok(markdown.includes('src/sum.test.ts:4'));
    assert.ok(markdown.includes('Named by the primary error'));
  });

  test('includes diagnostics and git', () => {
    assert.ok(markdown.includes('## Editor diagnostics'));
    assert.ok(markdown.includes('## Working tree'));
    assert.ok(markdown.includes('feature/sum'));
  });

  test('includes the terminal excerpt in a fence', () => {
    assert.ok(markdown.includes('## Terminal output'));
    assert.ok(markdown.includes('```text'));
  });

  test('never leaves three consecutive newlines', () => {
    assert.ok(!markdown.includes('\n\n\n'));
  });

  test('ends with a single trailing newline', () => {
    assert.ok(markdown.endsWith('\n'));
    assert.ok(!markdown.endsWith('\n\n'));
  });

  test('escapes pipes in a command so the table survives', () => {
    const piped = buildIncidentMarkdown(view({ command: { commandLine: 'a | b', exitCode: 1 } }));
    assert.ok(piped.includes('a \\| b'));
  });

  test('reports redaction when it happened', () => {
    const redacted = buildIncidentMarkdown(view({ redaction: { total: 2, counts: { 'github-token': 2 } } }));
    assert.ok(redacted.includes('2 potential secret(s) were redacted'));
  });

  test('says nothing about redaction when nothing was removed', () => {
    assert.ok(!markdown.includes('redacted'));
  });

  test('survives a minimal incident', () => {
    const minimal = buildIncidentMarkdown({
      id: 'x',
      createdAt: 'now',
      kind: 'unknown',
      status: 'unresolved',
      title: 'Something failed',
      fingerprint: { signature: 's', count: 1, firstSeen: 'a', lastSeen: 'b' }
    });
    assert.ok(minimal.includes('Something failed'));
  });

  test('warns when the same failure keeps recurring', () => {
    const recurring = buildIncidentMarkdown(
      view({ fingerprint: { signature: 's', count: 7, firstSeen: 'a', lastSeen: 'b' } })
    );
    assert.ok(recurring.includes('did not hold'));
  });
});

suite('templates/buildRepairPrompt', () => {
  const prompt = buildRepairPrompt(view());

  test('leads with the conclusion', () => {
    assert.ok(prompt.startsWith('# Repair brief: AssertionError'));
  });

  test('states the root cause before the evidence', () => {
    assert.ok(prompt.indexOf('## Most likely root cause') < prompt.indexOf('## Raw output'));
  });

  test('embeds the code the agent needs', () => {
    assert.ok(prompt.includes('## Code at the failure site'));
    assert.ok(prompt.includes('expect(sum(1, 1)).toBe(3);'));
  });

  test('ends with an explicit task', () => {
    assert.ok(prompt.includes('## Your task'));
    assert.ok(prompt.includes('smallest change'));
  });

  test('tells the agent how to verify', () => {
    assert.ok(prompt.includes('re-running: `npm test`'));
  });

  test('does not repeat the primary error in the secondary list', () => {
    // Scope to the section itself: the raw-output block further down legitimately
    // contains the same text.
    const after = prompt.split('## Other reported problems')[1] ?? '';
    const section = after.split('\n## ')[0];
    assert.ok(!section.includes('expected 2 to be 3'), `primary error repeated in:\n${section}`);
    assert.ok(section.includes('unused import'), 'other problems should still be listed');
  });

  test('invites the agent to ask rather than guess', () => {
    assert.ok(prompt.includes('additional output'));
  });

  test('falls back when there is no command', () => {
    const noCommand = buildRepairPrompt(view({ command: undefined }));
    assert.ok(noCommand.includes('whatever reproduces the failure'));
  });

  test('survives a minimal incident', () => {
    const minimal = buildRepairPrompt({
      id: 'x',
      createdAt: 'now',
      kind: 'unknown',
      status: 'unresolved',
      title: 'Something failed',
      fingerprint: { signature: 's', count: 1, firstSeen: 'a', lastSeen: 'b' }
    });
    assert.ok(minimal.includes('## Your task'));
  });
});

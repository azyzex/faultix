import * as assert from 'assert';
import { dedupeRefs, normalizeKey, rankSuspects } from '../../analyze/scoring';

suite('scoring/rankSuspects', () => {
  test('ranks the primary error file first', () => {
    const ranked = rankSuspects({
      primaryErrorFile: { file: 'src/broken.ts', line: 12 },
      terminalRefs: [{ file: 'src/other.ts' }]
    });

    assert.strictEqual(ranked[0].file, 'src/broken.ts');
    assert.strictEqual(ranked[0].line, 12);
    assert.ok(ranked[0].reasons.some((r) => r.includes('primary error')));
  });

  test('does not let ambient diagnostics outrank the failing file', () => {
    // The exact bug the original ranking had: a warning-heavy file unrelated to
    // the failure appeared as the second suspect for a failing batch script.
    const ranked = rankSuspects({
      commandRefs: [{ file: 'scripts/bad.bat' }],
      diagnostics: [{ file: 'config/tsconfig.invalid.json', errors: 0, warnings: 2 }]
    });

    assert.strictEqual(ranked[0].file, 'scripts/bad.bat');
    const noisy = ranked.find((r) => r.file.includes('tsconfig.invalid.json'));
    assert.ok(!noisy || noisy.score < ranked[0].score / 4, 'unrelated warnings must stay far below');
  });

  test('counts diagnostics fully when the failure output agrees', () => {
    const corroborated = rankSuspects({
      primaryErrorFile: { file: 'src/a.ts' },
      diagnostics: [{ file: 'src/a.ts', errors: 3, warnings: 0 }]
    });
    const ambient = rankSuspects({
      primaryErrorFile: { file: 'src/b.ts' },
      diagnostics: [{ file: 'src/a.ts', errors: 3, warnings: 0 }]
    });

    const corroboratedScore = corroborated.find((r) => r.file === 'src/a.ts')?.score ?? 0;
    const ambientScore = ambient.find((r) => r.file === 'src/a.ts')?.score ?? 0;
    assert.ok(corroboratedScore > ambientScore * 2, 'corroborated diagnostics must weigh more');
  });

  test('promotes diagnostics when they are the only evidence', () => {
    const ranked = rankSuspects({
      diagnostics: [
        { file: 'src/a.ts', errors: 4, warnings: 0 },
        { file: 'src/b.ts', errors: 1, warnings: 0 }
      ]
    });

    assert.strictEqual(ranked[0].file, 'src/a.ts');
    assert.ok(ranked[0].score >= 40, 'a diagnostics-spike incident should still rank strongly');
  });

  test('decays successive error references', () => {
    const ranked = rankSuspects({
      errorRefs: [{ file: 'src/first.ts' }, { file: 'src/second.ts' }, { file: 'src/third.ts' }]
    });

    assert.strictEqual(ranked[0].file, 'src/first.ts');
    assert.ok(ranked[0].score > ranked[1].score);
    assert.ok(ranked[1].score > ranked[2].score);
  });

  test('demotes vendored paths hard', () => {
    const ranked = rankSuspects({
      errorRefs: [{ file: 'node_modules/react/index.js' }, { file: 'src/app.ts' }]
    });

    assert.strictEqual(ranked[0].file, 'src/app.ts');
    const vendored = ranked.find((r) => r.file.includes('node_modules'));
    assert.ok(!vendored || vendored.score < 15);
  });

  test('demotes generated files', () => {
    const ranked = rankSuspects({
      errorRefs: [{ file: 'dist/app.min.js' }, { file: 'src/app.ts' }]
    });
    assert.strictEqual(ranked[0].file, 'src/app.ts');
  });

  test('boosts a changed file only when something else implicated it', () => {
    const both = rankSuspects({
      terminalRefs: [{ file: 'src/a.ts' }],
      gitChangedFiles: ['src/a.ts']
    });
    const onlyGit = rankSuspects({
      terminalRefs: [{ file: 'src/b.ts' }],
      gitChangedFiles: ['src/a.ts']
    });

    const withBoth = both.find((r) => r.file === 'src/a.ts')?.score ?? 0;
    const withGitOnly = onlyGit.find((r) => r.file === 'src/a.ts')?.score ?? 0;
    assert.ok(withBoth > withGitOnly + 10);
  });

  test('merges the many spellings of one path', () => {
    const ranked = rankSuspects({
      primaryErrorFile: { file: 'src/a.ts' },
      terminalRefs: [{ file: './src/a.ts' }],
      errorRefs: [{ file: 'src\\a.ts' }]
    });

    assert.strictEqual(ranked.length, 1, 'the same file must not appear three times');
  });

  test('keeps the first known line number', () => {
    const ranked = rankSuspects({
      errorRefs: [{ file: 'src/a.ts', line: 42 }],
      terminalRefs: [{ file: 'src/a.ts', line: 99 }]
    });
    assert.strictEqual(ranked[0].line, 42);
  });

  test('does not repeat a reason', () => {
    const ranked = rankSuspects({
      terminalRefs: [{ file: 'src/a.ts' }, { file: 'src/a.ts' }, { file: 'src/a.ts' }]
    });
    const mentions = ranked[0].reasons.filter((r) => r.includes('Mentioned'));
    assert.strictEqual(mentions.length, 1);
  });

  test('honours the limit', () => {
    const refs = Array.from({ length: 40 }, (_, i) => ({ file: `src/f${i}.ts` }));
    assert.strictEqual(rankSuspects({ errorRefs: refs }, { limit: 5 }).length, 5);
  });

  test('returns nothing when there is no evidence', () => {
    assert.deepStrictEqual(rankSuspects({}), []);
  });

  test('ignores blank paths', () => {
    assert.deepStrictEqual(rankSuspects({ terminalRefs: [{ file: '   ' }] }), []);
  });

  test('produces stable output for equal scores', () => {
    const evidence = { errorRefs: [{ file: 'src/b.ts' }, { file: 'src/a.ts' }] };
    const first = rankSuspects(evidence).map((r) => r.file);
    const second = rankSuspects(evidence).map((r) => r.file);
    assert.deepStrictEqual(first, second);
  });

  test('scores are whole numbers', () => {
    const ranked = rankSuspects({
      primaryErrorFile: { file: 'src/a.ts' },
      diagnostics: [{ file: 'src/a.ts', errors: 1, warnings: 3 }]
    });
    assert.ok(ranked.every((r) => Number.isInteger(r.score)));
  });
});

suite('scoring/normalizeKey', () => {
  test('folds case', () => {
    assert.strictEqual(normalizeKey('SRC/A.TS'), 'src/a.ts');
  });

  test('normalizes separators', () => {
    assert.strictEqual(normalizeKey('src\\a.ts'), 'src/a.ts');
  });

  test('drops a leading ./', () => {
    assert.strictEqual(normalizeKey('./src/a.ts'), 'src/a.ts');
  });

  test('drops a trailing slash', () => {
    assert.strictEqual(normalizeKey('src/'), 'src');
  });

  test('returns empty for blank input', () => {
    assert.strictEqual(normalizeKey('   '), '');
  });
});

suite('scoring/dedupeRefs', () => {
  test('merges duplicates', () => {
    const merged = dedupeRefs([{ file: 'a.ts' }, { file: './a.ts' }, { file: 'A.TS' }]);
    assert.strictEqual(merged.length, 1);
  });

  test('adopts a line number from a later duplicate', () => {
    const merged = dedupeRefs([{ file: 'a.ts' }, { file: 'a.ts', line: 5 }]);
    assert.strictEqual(merged[0].line, 5);
  });

  test('keeps the earliest line number', () => {
    const merged = dedupeRefs([{ file: 'a.ts', line: 5 }, { file: 'a.ts', line: 9 }]);
    assert.strictEqual(merged[0].line, 5);
  });

  test('drops blank paths', () => {
    assert.deepStrictEqual(dedupeRefs([{ file: '' }]), []);
  });
});

suite('scoring/reason tidying', () => {
  test('drops reasons a stronger reason already implies', () => {
    const ranked = rankSuspects({
      primaryErrorFile: { file: 'src/a.ts', line: 3 },
      errorRefs: [{ file: 'src/a.ts', line: 3 }],
      terminalRefs: [{ file: 'src/a.ts' }]
    });

    assert.deepStrictEqual(ranked[0].reasons, ['Named by the primary error']);
  });

  test('keeps independent reasons', () => {
    const ranked = rankSuspects({
      primaryErrorFile: { file: 'src/a.ts' },
      gitChangedFiles: ['src/a.ts']
    });

    assert.ok(ranked[0].reasons.includes('Named by the primary error'));
    assert.ok(ranked[0].reasons.includes('Modified in the working tree'));
  });
});

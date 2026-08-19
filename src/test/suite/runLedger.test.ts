import * as assert from 'assert';
import {
  allCommandStats,
  appendRun,
  coerceLedger,
  commandKeyOf,
  deriveHistory,
  detectFlakyCommands,
  emptyLedger,
  findAllResolutions,
  findResolution,
  lastPassingRun,
  occurrencesOf,
  statsForCommand
} from '../../analyze/runLedger';
import type { RunLedger, RunRecord } from '../../analyze/runLedger';

/** Builds a ledger from oldest-to-newest records, the way time runs. */
function ledgerOf(...oldestFirst: Array<Partial<RunRecord>>): RunLedger {
  let ledger = emptyLedger();
  oldestFirst.forEach((partial, index) => {
    ledger = appendRun(ledger, {
      at: partial.at ?? `2026-01-0${index + 1}T00:00:00.000Z`,
      commandKey: partial.commandKey ?? commandKeyOf(partial.commandLine ?? 'npm test'),
      commandLine: partial.commandLine ?? 'npm test',
      ok: partial.ok ?? true,
      ...partial
    });
  });
  return ledger;
}

suite('runLedger/commandKeyOf', () => {
  test('groups the same command written differently', () => {
    assert.strictEqual(commandKeyOf('npm test'), commandKeyOf('npm  test'));
    assert.strictEqual(commandKeyOf('NPM TEST'), commandKeyOf('npm test'));
  });

  test('separates genuinely different commands', () => {
    assert.notStrictEqual(commandKeyOf('npm test'), commandKeyOf('npm run build'));
  });

  test('ignores paths, which vary between machines', () => {
    assert.strictEqual(commandKeyOf('node /home/a/x.js'), commandKeyOf('node /home/b/y.js'));
  });
});

suite('runLedger/appendRun', () => {
  test('keeps the newest run first', () => {
    const ledger = ledgerOf({ at: '2026-01-01T00:00:00.000Z' }, { at: '2026-01-02T00:00:00.000Z' });
    assert.strictEqual(ledger.runs[0].at, '2026-01-02T00:00:00.000Z');
  });

  test('trims to the cap', () => {
    let ledger = emptyLedger();
    for (let i = 0; i < 20; i++) {
      ledger = appendRun(ledger, { at: `t${i}`, commandKey: 'k', commandLine: 'c', ok: true }, 5);
    }
    assert.strictEqual(ledger.runs.length, 5);
    assert.strictEqual(ledger.runs[0].at, 't19', 'the newest survives trimming');
  });

  test('never trims to nothing', () => {
    const ledger = appendRun(emptyLedger(), { at: 't', commandKey: 'k', commandLine: 'c', ok: true }, 0);
    assert.strictEqual(ledger.runs.length, 1);
  });
});

suite('runLedger/coerceLedger', () => {
  const junk: Array<[string, unknown]> = [
    ['null', null],
    ['a string', 'nope'],
    ['an array', []],
    ['an object without runs', {}],
    ['runs as a string', { runs: 'nope' }]
  ];

  for (const [label, value] of junk) {
    test(`survives ${label}`, () => {
      const ledger = coerceLedger(value);
      assert.strictEqual(ledger.version, 1);
      assert.deepStrictEqual(ledger.runs, []);
    });
  }

  test('drops records that are not runs', () => {
    const ledger = coerceLedger({
      runs: [{ at: 'x', commandKey: 'k', ok: true }, { nonsense: true }, null, 7]
    });
    assert.strictEqual(ledger.runs.length, 1);
  });

  test('round-trips through JSON', () => {
    const original = ledgerOf({ ok: false, signature: 's' });
    assert.deepStrictEqual(coerceLedger(JSON.parse(JSON.stringify(original))), original);
  });
});

suite('runLedger/findResolution', () => {
  test('reports a failure that later passed', () => {
    const ledger = ledgerOf(
      { at: '2026-01-01T00:00:00.000Z', ok: false, signature: 'abc', changedFiles: ['src/db.ts'] },
      { at: '2026-01-02T00:00:00.000Z', ok: true, changedFiles: ['src/db.ts'] }
    );

    const resolution = findResolution(ledger, 'abc');
    assert.ok(resolution, 'expected a resolution');
    assert.strictEqual(resolution.failedAt, '2026-01-01T00:00:00.000Z');
    assert.strictEqual(resolution.fixedAt, '2026-01-02T00:00:00.000Z');
    assert.deepStrictEqual(resolution.likelyFixedBy, ['src/db.ts']);
  });

  test('says nothing while the failure is still failing', () => {
    const ledger = ledgerOf({ ok: false, signature: 'abc' }, { ok: false, signature: 'abc' });
    assert.strictEqual(findResolution(ledger, 'abc'), undefined);
  });

  test('counts how many attempts it took', () => {
    const ledger = ledgerOf(
      { ok: false, signature: 'abc' },
      { ok: false, signature: 'abc' },
      { ok: false, signature: 'abc' },
      { ok: true }
    );
    assert.strictEqual(findResolution(ledger, 'abc')?.attempts, 3);
  });

  test('forgets a fix that did not hold', () => {
    const ledger = ledgerOf(
      { at: '2026-01-01T00:00:00.000Z', ok: false, signature: 'abc' },
      { at: '2026-01-02T00:00:00.000Z', ok: true },
      { at: '2026-01-03T00:00:00.000Z', ok: false, signature: 'abc' }
    );
    assert.strictEqual(findResolution(ledger, 'abc'), undefined, 'it is broken again, so it is not resolved');
  });

  test('reports the most recent fix when it broke and was fixed twice', () => {
    const ledger = ledgerOf(
      { at: '2026-01-01T00:00:00.000Z', ok: false, signature: 'abc' },
      { at: '2026-01-02T00:00:00.000Z', ok: true },
      { at: '2026-01-03T00:00:00.000Z', ok: false, signature: 'abc' },
      { at: '2026-01-04T00:00:00.000Z', ok: true }
    );
    assert.strictEqual(findResolution(ledger, 'abc')?.fixedAt, '2026-01-04T00:00:00.000Z');
  });

  test('ignores a different command passing', () => {
    const ledger = ledgerOf(
      { commandLine: 'npm test', ok: false, signature: 'abc' },
      { commandLine: 'npm run build', ok: true }
    );
    assert.strictEqual(findResolution(ledger, 'abc'), undefined);
  });

  test('prefers files edited in both states over their union', () => {
    const ledger = ledgerOf(
      { ok: false, signature: 'abc', changedFiles: ['src/a.ts', 'src/b.ts'] },
      { ok: true, changedFiles: ['src/b.ts', 'README.md'] }
    );
    // b.ts was being edited when it broke and when it worked; that is the signal.
    assert.deepStrictEqual(findResolution(ledger, 'abc')?.likelyFixedBy, ['src/b.ts']);
  });

  test('falls back to the union when nothing overlaps', () => {
    const ledger = ledgerOf(
      { ok: false, signature: 'abc', changedFiles: ['src/a.ts'] },
      { ok: true, changedFiles: ['src/c.ts'] }
    );
    assert.deepStrictEqual(findResolution(ledger, 'abc')?.likelyFixedBy, ['src/a.ts', 'src/c.ts']);
  });

  test('flags commits landing in between, because the diff is then incomplete', () => {
    const ledger = ledgerOf(
      { ok: false, signature: 'abc', gitSha: 'aaa' },
      { ok: true, gitSha: 'bbb' }
    );
    assert.strictEqual(findResolution(ledger, 'abc')?.commitsInBetween, true);
  });

  test('does not flag commits when the sha did not move', () => {
    const ledger = ledgerOf({ ok: false, signature: 'abc', gitSha: 'aaa' }, { ok: true, gitSha: 'aaa' });
    assert.strictEqual(findResolution(ledger, 'abc')?.commitsInBetween, false);
  });

  test('returns nothing for an unknown signature', () => {
    assert.strictEqual(findResolution(ledgerOf({ ok: true }), 'never-seen'), undefined);
  });

  test('handles an empty ledger', () => {
    assert.strictEqual(findResolution(emptyLedger(), 'abc'), undefined);
  });
});

suite('runLedger/findAllResolutions', () => {
  test('lists every resolved failure, newest fix first', () => {
    const ledger = ledgerOf(
      { at: '2026-01-01T00:00:00.000Z', commandLine: 'npm test', ok: false, signature: 'one' },
      { at: '2026-01-02T00:00:00.000Z', commandLine: 'npm test', ok: true },
      { at: '2026-01-03T00:00:00.000Z', commandLine: 'npm run build', ok: false, signature: 'two' },
      { at: '2026-01-04T00:00:00.000Z', commandLine: 'npm run build', ok: true }
    );

    const resolutions = findAllResolutions(ledger);
    assert.strictEqual(resolutions.length, 2);
    assert.strictEqual(resolutions[0].signature, 'two');
  });

  test('omits failures that are still failing', () => {
    const ledger = ledgerOf({ ok: false, signature: 'one' });
    assert.deepStrictEqual(findAllResolutions(ledger), []);
  });
});

suite('runLedger/detectFlakyCommands', () => {
  test('flags disagreement at one commit with a clean tree as high confidence', () => {
    const ledger = ledgerOf(
      { ok: true, gitSha: 'aaa', gitDirty: false },
      { ok: false, gitSha: 'aaa', gitDirty: false, signature: 's' }
    );

    const flaky = detectFlakyCommands(ledger);
    assert.strictEqual(flaky.length, 1);
    assert.strictEqual(flaky[0].confidence, 'high');
    assert.strictEqual(flaky[0].conflictingSha, 'aaa');
  });

  test('downgrades disagreement with a dirty tree, since an edit explains it', () => {
    const ledger = ledgerOf(
      { ok: true, gitSha: 'aaa', gitDirty: true },
      { ok: false, gitSha: 'aaa', gitDirty: true, signature: 's' }
    );
    assert.strictEqual(detectFlakyCommands(ledger)[0].confidence, 'low');
  });

  test('does not flag a command that only ever fails', () => {
    const ledger = ledgerOf({ ok: false, gitSha: 'a', signature: 's' }, { ok: false, gitSha: 'a', signature: 's' });
    assert.deepStrictEqual(detectFlakyCommands(ledger), []);
  });

  test('does not flag a command that only ever passes', () => {
    assert.deepStrictEqual(detectFlakyCommands(ledgerOf({ ok: true }, { ok: true })), []);
  });

  test('does not flag a genuine fix across commits', () => {
    // Failed at one commit, passes at the next: that is a fix, not flakiness.
    const ledger = ledgerOf(
      { ok: false, gitSha: 'aaa', gitDirty: false, signature: 's' },
      { ok: true, gitSha: 'bbb', gitDirty: false }
    );
    assert.deepStrictEqual(detectFlakyCommands(ledger), []);
  });

  test('counts passes and failures', () => {
    const ledger = ledgerOf(
      { ok: true, gitSha: 'a', gitDirty: false },
      { ok: false, gitSha: 'a', gitDirty: false, signature: 's' },
      { ok: true, gitSha: 'a', gitDirty: false }
    );
    const flaky = detectFlakyCommands(ledger)[0];
    assert.strictEqual(flaky.passes, 2);
    assert.strictEqual(flaky.failures, 1);
  });

  test('sorts high confidence first', () => {
    const ledger = ledgerOf(
      { commandLine: 'a b', ok: true, gitSha: 'x', gitDirty: true },
      { commandLine: 'a b', ok: false, gitSha: 'x', gitDirty: true, signature: 's' },
      { commandLine: 'c d', ok: true, gitSha: 'y', gitDirty: false },
      { commandLine: 'c d', ok: false, gitSha: 'y', gitDirty: false, signature: 't' }
    );
    assert.strictEqual(detectFlakyCommands(ledger)[0].confidence, 'high');
  });

  test('ignores runs with no commit information', () => {
    const ledger = ledgerOf({ ok: true }, { ok: false, signature: 's' });
    assert.deepStrictEqual(detectFlakyCommands(ledger), [], 'without a sha there is nothing to compare');
  });
});

suite('runLedger/statistics', () => {
  const ledger = ledgerOf(
    { at: '2026-01-01T00:00:00.000Z', ok: false, signature: 's', gitSha: 'aaa' },
    { at: '2026-01-02T00:00:00.000Z', ok: true, gitSha: 'bbb' },
    { at: '2026-01-03T00:00:00.000Z', ok: true, gitSha: 'ccc' }
  );

  test('summarizes one command', () => {
    const stats = statsForCommand(ledger, commandKeyOf('npm test'));
    assert.ok(stats);
    assert.strictEqual(stats.runs, 3);
    assert.strictEqual(stats.passes, 2);
    assert.strictEqual(stats.failures, 1);
    assert.ok(Math.abs(stats.passRate - 2 / 3) < 1e-9);
  });

  test('records the last passing commit, for "what changed since"', () => {
    assert.strictEqual(statsForCommand(ledger, commandKeyOf('npm test'))?.lastPassSha, 'ccc');
  });

  test('returns nothing for a command never run', () => {
    assert.strictEqual(statsForCommand(ledger, 'never-run'), undefined);
  });

  test('lists every command, most recent first', () => {
    const mixed = ledgerOf(
      { at: '2026-01-01T00:00:00.000Z', commandLine: 'npm test', ok: true },
      { at: '2026-01-02T00:00:00.000Z', commandLine: 'npm run build', ok: true }
    );
    const all = allCommandStats(mixed);
    assert.strictEqual(all.length, 2);
    assert.strictEqual(all[0].commandLine, 'npm run build');
  });

  test('finds the last passing run', () => {
    assert.strictEqual(lastPassingRun(ledger, commandKeyOf('npm test'))?.gitSha, 'ccc');
  });

  test('counts occurrences of a signature', () => {
    assert.strictEqual(occurrencesOf(ledger, 's').length, 1);
  });
});

suite('runLedger/deriveHistory', () => {
  const ledger = ledgerOf(
    { at: '2026-01-01T00:00:00.000Z', ok: true, gitSha: 'aaa111' },
    { at: '2026-01-02T00:00:00.000Z', ok: false, signature: 'sig', gitSha: 'bbb222' }
  );

  test('reports what the ledger knows', () => {
    const history = deriveHistory(ledger, 'npm test', 'sig');
    assert.ok(history);
    assert.strictEqual(history.lastPassedSha, 'aaa111');
    assert.strictEqual(history.totalRuns, 2);
  });

  test('passes the since-last-pass diff through', () => {
    const history = deriveHistory(ledger, 'npm test', 'sig', {
      sha: 'aaa111',
      files: ['src/a.ts', 'src/b.ts'],
      commits: 2
    });
    assert.ok(history?.changesSincePass, 'the diff should be carried through');
    assert.strictEqual(history.changesSincePass.files.length, 2);
    assert.strictEqual(history.changesSincePass.commits, 2);
  });

  test('says nothing when the ledger knows nothing', () => {
    assert.strictEqual(deriveHistory(emptyLedger(), 'npm test', 'sig'), undefined);
  });

  test('does not call a command flaky when a fix explains the disagreement', () => {
    // A pass and a fail at one commit with a dirty tree is what a fix looks
    // like; reporting flakiness as well would contradict it.
    const fixed = ledgerOf(
      { at: '2026-01-01T00:00:00.000Z', ok: false, signature: 'sig', gitSha: 'aaa', gitDirty: true },
      { at: '2026-01-02T00:00:00.000Z', ok: true, gitSha: 'aaa', gitDirty: true }
    );
    const history = deriveHistory(fixed, 'npm test', 'sig');
    assert.ok(history?.priorFix, 'the fix is reported');
    assert.strictEqual(history.flaky, undefined, 'and flakiness is not');
  });

  test('still reports flakiness when the tree was clean', () => {
    // A clean tree means the code provably did not change, which no fix explains.
    const flaky = ledgerOf(
      { at: '2026-01-01T00:00:00.000Z', ok: false, signature: 'sig', gitSha: 'aaa', gitDirty: false },
      { at: '2026-01-02T00:00:00.000Z', ok: true, gitSha: 'aaa', gitDirty: false }
    );
    assert.strictEqual(deriveHistory(flaky, 'npm test', 'sig')?.flaky, 'high');
  });
});

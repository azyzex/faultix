import * as assert from 'assert';
import { coerceHistory, emptyHistory, toSummary } from '../../core/models';
import type { Incident } from '../../core/models';

function incident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: '2026-01-01T00-00-00-000Z_abc123',
    createdAt: '2026-01-01T00:00:00.000Z',
    kind: 'test',
    status: 'unresolved',
    trigger: 'terminal',
    title: 'Command failed (1): npm test',
    summary: 'AssertionError: expected 2 to be 3',
    fingerprint: { signature: 'abc123', count: 4, firstSeen: 'a', lastSeen: 'b' },
    ...overrides
  };
}

suite('models/emptyHistory', () => {
  test('is a valid, versioned, empty ledger', () => {
    const history = emptyHistory();
    assert.strictEqual(history.version, 1);
    assert.deepStrictEqual(history.incidents, []);
    assert.deepStrictEqual(history.fingerprints, {});
  });

  test('returns a fresh object each time', () => {
    const first = emptyHistory();
    first.incidents.push(toSummary(incident()));
    assert.strictEqual(emptyHistory().incidents.length, 0, 'state must not leak between calls');
  });
});

suite('models/coerceHistory', () => {
  test('accepts a well-formed ledger', () => {
    const input = {
      version: 1,
      incidents: [{ id: 'x', createdAt: 'now', kind: 'test', status: 'unresolved', title: 't', trigger: 'terminal', signature: 's', count: 1 }],
      fingerprints: { s: { count: 1, firstSeen: 'a', lastSeen: 'b' } }
    };
    const history = coerceHistory(input);
    assert.strictEqual(history.incidents.length, 1);
    assert.strictEqual(history.fingerprints.s?.count, 1);
  });

  test('a signature that was never seen looks up as undefined', () => {
    assert.strictEqual(coerceHistory({}).fingerprints['never-seen'], undefined);
  });

  // A ledger on disk can be truncated by a crash or edited by hand. None of
  // these shapes should stop the extension from capturing.
  const junk: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['a string', 'not an object'],
    ['a number', 42],
    ['an array', [1, 2, 3]],
    ['an empty object', {}],
    ['incidents as a string', { incidents: 'nope' }],
    ['fingerprints as an array', { fingerprints: [] }],
    ['fingerprints as null', { fingerprints: null }]
  ];

  for (const [label, value] of junk) {
    test(`survives ${label}`, () => {
      const history = coerceHistory(value);
      assert.strictEqual(history.version, 1);
      assert.ok(Array.isArray(history.incidents));
      assert.strictEqual(typeof history.fingerprints, 'object');
    });
  }

  test('drops entries that are not incident records', () => {
    const history = coerceHistory({
      incidents: [
        { id: 'good', createdAt: 'now' },
        { missingEverything: true },
        null,
        'string',
        42
      ]
    });
    assert.strictEqual(history.incidents.length, 1);
    assert.strictEqual(history.incidents[0].id, 'good');
  });

  test('round-trips through JSON', () => {
    const original = coerceHistory({ incidents: [{ id: 'a', createdAt: 'b' }], fingerprints: { s: { count: 2, firstSeen: 'x', lastSeen: 'y' } } });
    const restored = coerceHistory(JSON.parse(JSON.stringify(original)));
    assert.deepStrictEqual(restored, original);
  });
});

suite('models/toSummary', () => {
  test('carries the fields history needs', () => {
    const summary = toSummary(incident());

    assert.strictEqual(summary.id, '2026-01-01T00-00-00-000Z_abc123');
    assert.strictEqual(summary.kind, 'test');
    assert.strictEqual(summary.status, 'unresolved');
    assert.strictEqual(summary.trigger, 'terminal');
    assert.strictEqual(summary.signature, 'abc123');
    assert.strictEqual(summary.count, 4);
    assert.strictEqual(summary.summary, 'AssertionError: expected 2 to be 3');
  });

  test('records the archive path when one was written', () => {
    assert.strictEqual(toSummary(incident(), 'history/x.json').archivePath, 'history/x.json');
  });

  test('leaves the archive path undefined when nothing was archived', () => {
    assert.strictEqual(toSummary(incident()).archivePath, undefined);
  });

  test('does not carry the heavy fields', () => {
    const summary = toSummary(incident({ terminalExcerpt: 'x'.repeat(50000) })) as unknown as Record<string, unknown>;
    assert.strictEqual(summary.terminalExcerpt, undefined, 'history must stay small');
    assert.strictEqual(summary.snippets, undefined);
    assert.strictEqual(summary.errors, undefined);
  });
});

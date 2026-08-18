import * as assert from 'assert';
import { computeFingerprint, fingerprintSource, normalizeCommand } from '../../analyze/fingerprint';

suite('fingerprint/normalizeCommand', () => {
  test('collapses absolute paths', () => {
    assert.strictEqual(normalizeCommand('node C:\\repo\\src\\a.js'), 'node <path>');
  });

  test('collapses posix paths', () => {
    assert.strictEqual(normalizeCommand('python /home/dev/app/main.py'), 'python <path>');
  });

  test('collapses commit hashes', () => {
    assert.strictEqual(normalizeCommand('git show a1b2c3d4e5f6'), 'git show <hash>');
  });

  test('collapses numbers', () => {
    assert.strictEqual(normalizeCommand('retry 42 times'), 'retry <n> times');
  });

  test('collapses repeated whitespace', () => {
    assert.strictEqual(normalizeCommand('npm    test'), 'npm test');
  });

  test('folds case', () => {
    assert.strictEqual(normalizeCommand('NPM Test'), 'npm test');
  });
});

suite('fingerprint/computeFingerprint', () => {
  const base = {
    kind: 'test',
    commandLine: 'npm test',
    toolHint: 'vitest',
    primaryMessage: 'expected 2 to be 3',
    primaryCode: 'AssertionError',
    primaryFile: 'src/sum.test.ts'
  };

  test('is stable across runs', () => {
    assert.strictEqual(computeFingerprint(base).signature, computeFingerprint(base).signature);
  });

  test('is independent of the timestamp', () => {
    const early = computeFingerprint(base, new Date('2020-01-01'));
    const late = computeFingerprint(base, new Date('2030-06-06'));
    assert.strictEqual(early.signature, late.signature);
  });

  test('ignores line numbers embedded in the message', () => {
    const a = computeFingerprint({ ...base, primaryMessage: 'failed at line 12' });
    const b = computeFingerprint({ ...base, primaryMessage: 'failed at line 84' });
    assert.strictEqual(a.signature, b.signature);
  });

  test('ignores the absolute location of the workspace', () => {
    const a = computeFingerprint({ ...base, commandLine: 'node /home/alice/app/x.js' });
    const b = computeFingerprint({ ...base, commandLine: 'node /home/bob/other/y.js' });
    assert.strictEqual(a.signature, b.signature);
  });

  test('distinguishes different failures', () => {
    const a = computeFingerprint(base);
    const b = computeFingerprint({ ...base, primaryMessage: 'something else entirely' });
    assert.notStrictEqual(a.signature, b.signature);
  });

  test('distinguishes different commands', () => {
    const a = computeFingerprint(base);
    const b = computeFingerprint({ ...base, commandLine: 'npm run build' });
    assert.notStrictEqual(a.signature, b.signature);
  });

  test('distinguishes different kinds', () => {
    assert.notStrictEqual(computeFingerprint(base).signature, computeFingerprint({ ...base, kind: 'build' }).signature);
  });

  test('distinguishes different files', () => {
    const a = computeFingerprint(base);
    const b = computeFingerprint({ ...base, primaryFile: 'src/other.ts' });
    assert.notStrictEqual(a.signature, b.signature);
  });

  test('treats path separators as equivalent', () => {
    const a = computeFingerprint({ ...base, primaryFile: 'src/a.ts' });
    const b = computeFingerprint({ ...base, primaryFile: 'src\\a.ts' });
    assert.strictEqual(a.signature, b.signature);
  });

  test('produces a short hex signature', () => {
    assert.match(computeFingerprint(base).signature, /^[0-9a-f]{12}$/);
  });

  test('starts the count at one', () => {
    const fingerprint = computeFingerprint(base);
    assert.strictEqual(fingerprint.count, 1);
    assert.strictEqual(fingerprint.firstSeen, fingerprint.lastSeen);
  });

  test('copes with no command and no error', () => {
    const fingerprint = computeFingerprint({ kind: 'unknown' });
    assert.match(fingerprint.signature, /^[0-9a-f]{12}$/);
  });

  test('exposes a readable source string', () => {
    assert.ok(fingerprintSource(base).includes('vitest'));
    assert.ok(fingerprintSource({ kind: 'x' }).includes('no-command'));
  });
});

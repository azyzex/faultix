import * as assert from 'assert';
import {
  applyLineRewrites,
  collapseBlankLines,
  excerptLines,
  sanitizeTerminalOutput,
  stripAnsi,
  truncateChars
} from '../../analyze/ansi';
import { bel, esc, readFixture } from './helpers';

suite('ansi/stripAnsi', () => {
  test('removes SGR colour codes but keeps the text', () => {
    assert.strictEqual(stripAnsi(esc('[31m') + 'red' + esc('[0m')), 'red');
  });

  test('removes cursor positioning', () => {
    assert.strictEqual(stripAnsi(esc('[3;1H') + 'top'), 'top');
  });

  test('removes erase-in-line sequences', () => {
    assert.strictEqual(stripAnsi('done' + esc('[K')), 'done');
  });

  test('removes device status report queries', () => {
    assert.strictEqual(stripAnsi(esc('[6n') + 'x'), 'x');
  });

  test('removes BEL-terminated OSC window titles', () => {
    assert.strictEqual(stripAnsi(esc(']0;C:\\Windows\\cmd.exe') + bel + 'after'), 'after');
  });

  test('removes ST-terminated OSC sequences', () => {
    assert.strictEqual(stripAnsi(esc(']633;C') + esc('\\') + 'after'), 'after');
  });

  test('removes VS Code shell integration markers', () => {
    const input = esc(']633;A') + bel + 'prompt$ ' + esc(']633;B') + bel + 'output';
    assert.strictEqual(stripAnsi(input), 'prompt$ output');
  });

  test('removes DCS strings', () => {
    assert.strictEqual(stripAnsi(esc('P') + 'payload' + esc('\\') + 'kept'), 'kept');
  });

  test('removes charset selection escapes', () => {
    assert.strictEqual(stripAnsi(esc('(B') + 'text'), 'text');
  });

  test('removes 8-bit CSI introducers', () => {
    assert.strictEqual(stripAnsi(String.fromCharCode(0x9b) + '31m' + 'x'), 'x');
  });

  test('leaves plain text untouched', () => {
    const plain = 'error: something broke at line 12';
    assert.strictEqual(stripAnsi(plain), plain);
  });

  test('leaves bracket characters that are not escapes', () => {
    assert.strictEqual(stripAnsi('array[0] and [1;2]'), 'array[0] and [1;2]');
  });

  test('handles empty input', () => {
    assert.strictEqual(stripAnsi(''), '');
  });

  test('is idempotent', () => {
    const once = stripAnsi(esc('[31m') + 'x' + esc('[0m'));
    assert.strictEqual(stripAnsi(once), once);
  });
});

suite('ansi/applyLineRewrites', () => {
  test('collapses a progress bar to its final state', () => {
    assert.strictEqual(applyLineRewrites('10%\r55%\r100% done'), '100% done');
  });

  test('overwrites only the characters the rewrite covers', () => {
    assert.strictEqual(applyLineRewrites('abcdef\rXY'), 'XYcdef');
  });

  test('applies backspace', () => {
    assert.strictEqual(applyLineRewrites('abc\b\bX'), 'aXc');
  });

  test('returns the input unchanged when there is nothing to rewrite', () => {
    assert.strictEqual(applyLineRewrites('plain text'), 'plain text');
  });

  test('handles a leading carriage return', () => {
    assert.strictEqual(applyLineRewrites('\rabc'), 'abc');
  });

  test('does not go negative on excess backspaces', () => {
    assert.strictEqual(applyLineRewrites('\b\b\bab'), 'ab');
  });
});

suite('ansi/collapseBlankLines', () => {
  test('collapses runs of blank lines to one', () => {
    assert.deepStrictEqual(collapseBlankLines(['a', '', '', '', 'b']), ['a', '', 'b']);
  });

  test('trims leading and trailing blanks', () => {
    assert.deepStrictEqual(collapseBlankLines(['', '', 'a', '', '']), ['a']);
  });

  test('treats whitespace-only lines as blank', () => {
    assert.deepStrictEqual(collapseBlankLines(['a', '   ', '\t', 'b']), ['a', '   ', 'b']);
  });

  test('handles an all-blank input', () => {
    assert.deepStrictEqual(collapseBlankLines(['', '  ', '']), []);
  });
});

suite('ansi/sanitizeTerminalOutput', () => {
  test('produces readable text from the recorded noisy capture', () => {
    const clean = sanitizeTerminalOutput(readFixture('ansi-noisy.txt'));

    assert.ok(clean.includes('Starting batch error demo'), 'keeps real output');
    assert.ok(clean.includes('is not recognized as an internal or external command'));
    assert.ok(!clean.includes(String.fromCharCode(0x1b)), 'no escape bytes survive');
    assert.ok(!clean.includes(bel), 'no BEL bytes survive');
    assert.ok(!clean.includes('cmd.exe'), 'window title is dropped');
    assert.ok(!/\[\d+m/.test(clean), 'no colour code remnants');
  });

  test('collapses the progress bar in the recorded capture', () => {
    const clean = sanitizeTerminalOutput(readFixture('ansi-noisy.txt'));
    assert.ok(clean.includes('progress: 100%'));
    assert.ok(!clean.includes('progress: 10%'));
  });

  test('normalizes CRLF', () => {
    assert.strictEqual(sanitizeTerminalOutput('a\r\nb'), 'a\nb');
  });

  test('strips trailing whitespace per line', () => {
    assert.strictEqual(sanitizeTerminalOutput('a   \nb\t\t'), 'a\nb');
  });

  test('handles empty input', () => {
    assert.strictEqual(sanitizeTerminalOutput(''), '');
  });

  test('removes zero-width characters', () => {
    const input = 'a' + String.fromCharCode(0x200b) + 'b';
    assert.strictEqual(sanitizeTerminalOutput(input), 'ab');
  });

  test('keeps tabs, which carry indentation meaning', () => {
    assert.strictEqual(sanitizeTerminalOutput('\tindented'), '\tindented');
  });
});

suite('ansi/excerptLines', () => {
  const many = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n');

  test('returns short input unchanged', () => {
    assert.strictEqual(excerptLines('a\nb', 10), 'a\nb');
  });

  test('keeps both the head and the tail', () => {
    const out = excerptLines(many, 20);
    assert.ok(out.includes('line0'), 'keeps the head');
    assert.ok(out.includes('line99'), 'keeps the tail');
    assert.ok(out.includes('omitted'), 'marks the gap');
  });

  test('respects the line budget', () => {
    assert.strictEqual(excerptLines(many, 20).split('\n').length, 20);
  });

  test('reports the omitted count correctly', () => {
    const out = excerptLines(many, 20);
    const head = Math.floor(20 * 0.35);
    const tail = 20 - head - 1;
    assert.ok(out.includes(`${100 - head - tail} lines omitted`));
  });

  test('falls back to the tail for very small budgets', () => {
    assert.strictEqual(excerptLines(many, 3), 'line97\nline98\nline99');
  });

  test('treats a non-positive budget as unlimited', () => {
    assert.strictEqual(excerptLines('a\nb\nc', 0), 'a\nb\nc');
  });
});

suite('ansi/truncateChars', () => {
  test('returns short input unchanged', () => {
    assert.strictEqual(truncateChars('abc', 10), 'abc');
  });

  test('breaks on a line boundary when one is close enough', () => {
    const out = truncateChars('aaaa\nbbbb\ncccc', 11);
    assert.ok(out.startsWith('aaaa\nbbbb'));
    assert.ok(out.includes('truncated'));
  });

  test('never exceeds the budget plus the marker', () => {
    const out = truncateChars('x'.repeat(1000), 100);
    assert.ok(out.length <= 100 + '\n... truncated ...'.length);
  });

  test('treats a non-positive budget as unlimited', () => {
    assert.strictEqual(truncateChars('abc', 0), 'abc');
  });
});

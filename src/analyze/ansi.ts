/**
 * Terminal output sanitization.
 *
 * Raw output captured from a shell execution is full of control data that is
 * meaningless (and actively harmful) inside a repair brief: colour codes,
 * cursor movement, device-status queries, window-title updates, and the
 * OSC 633/133 sequences VS Code's shell integration injects. Progress bars
 * additionally rewrite the same line many times using carriage returns.
 *
 * Control characters are built with `chr()` rather than written as escape
 * literals so this file stays pure ASCII and survives copy/paste, patching and
 * editors that normalize unusual bytes.
 *
 * Everything here is pure and free of the `vscode` module so it can be unit
 * tested without launching an Extension Host.
 */

const chr = (code: number): string => String.fromCharCode(code);

const ESC = chr(0x1b);
const BEL = chr(0x07);
const ST = chr(0x9c);
const CSI_8BIT = chr(0x9b);
const OSC_8BIT = chr(0x9d);

/** Any byte sequence that terminates a string-type escape. */
const TERMINATOR = '(?:' + ESC + '\\\\|' + ST + '|' + BEL + ')';

/** Newline-tolerant lazy payload, used inside string-type escapes. */
const ANY = '[\\s\\S]*?';

/**
 * CSI: ESC [ <params> <intermediates> <final byte 0x40-0x7e>.
 * Covers SGR colours, cursor moves (H/A/B/C/D), erase (J/K) and DSR (6n).
 */
const CSI_PATTERN = new RegExp(ESC + '\\[[0-?]*[ -/]*[@-~]', 'g');

/**
 * OSC: ESC ] <params> terminated by BEL or ST.
 * Includes window titles (OSC 0/2) and VS Code shell integration (OSC 633/133),
 * whose markers can straddle a line break.
 */
const OSC_PATTERN = new RegExp(ESC + '\\]' + ANY + TERMINATOR, 'g');

/** DCS / SOS / PM / APC strings, all terminated by ST. */
const STRING_PATTERN = new RegExp(ESC + '[P^_X]' + ANY + TERMINATOR, 'g');

/** Two-and-three byte escapes: charset selection, keypad mode, RIS, etc. */
const SHORT_ESCAPE_PATTERN = new RegExp(ESC + '(?:[()*+#%][\\s\\S]|[=><78MHcZ])', 'g');

/** 8-bit CSI/OSC introducers used by some emitters. */
const C1_CSI_PATTERN = new RegExp(CSI_8BIT + '[0-?]*[ -/]*[@-~]', 'g');
const C1_OSC_PATTERN = new RegExp(OSC_8BIT + ANY + '(?:' + ST + '|' + BEL + ')', 'g');

/** Any escape we failed to classify. */
const ORPHAN_ESCAPE_PATTERN = new RegExp(ESC, 'g');

/** Leftover control bytes. Tab (0x09) and newline (0x0a) are deliberately kept. */
const CONTROL_PATTERN = new RegExp(
  '[' +
    chr(0x00) + '-' + chr(0x08) +
    chr(0x0b) + chr(0x0c) +
    chr(0x0e) + '-' + chr(0x1f) +
    chr(0x7f) + '-' + chr(0x9f) +
    ']',
  'g'
);

/** Zero-width and bidi characters that survive copy/paste and confuse diffs. */
const INVISIBLE_PATTERN = new RegExp(
  '[' +
    chr(0x200b) + '-' + chr(0x200f) +
    chr(0x202a) + '-' + chr(0x202e) +
    chr(0x2060) + '-' + chr(0x2064) +
    chr(0xfeff) +
    ']',
  'g'
);

/** Unicode line/paragraph separators, normalized to plain newlines. */
const LINE_SEPARATOR_PATTERN = new RegExp('[' + chr(0x2028) + chr(0x2029) + ']', 'g');

/**
 * Removes ANSI/VT escape sequences without touching printable text.
 *
 * Order matters: the string-terminated sequences (OSC/DCS) are consumed first
 * so that a CSI-looking payload nested inside a window title cannot be
 * partially eaten, leaving an unterminated tail behind.
 */
export function stripAnsi(input: string): string {
  if (!input) {
    return '';
  }
  return input
    .replace(OSC_PATTERN, '')
    .replace(STRING_PATTERN, '')
    .replace(CSI_PATTERN, '')
    .replace(C1_OSC_PATTERN, '')
    .replace(C1_CSI_PATTERN, '')
    .replace(SHORT_ESCAPE_PATTERN, '')
    .replace(ORPHAN_ESCAPE_PATTERN, '');
}

/**
 * Applies carriage-return and backspace semantics so that a progress bar which
 * rewrote one line 200 times collapses to the final rendered text.
 */
export function applyLineRewrites(line: string): string {
  if (!line.includes('\r') && !line.includes('\b')) {
    return line;
  }

  let buffer = '';
  let cursor = 0;

  for (const ch of line) {
    if (ch === '\r') {
      cursor = 0;
      continue;
    }
    if (ch === '\b') {
      cursor = Math.max(0, cursor - 1);
      continue;
    }
    if (cursor === buffer.length) {
      buffer += ch;
    } else {
      buffer = buffer.slice(0, cursor) + ch + buffer.slice(cursor + 1);
    }
    cursor++;
  }

  return buffer;
}

/**
 * Full pipeline: strip escapes, normalize newlines, resolve line rewrites,
 * drop control leftovers and trailing whitespace, and collapse runs of blank
 * lines. The result is roughly what a human would have seen on screen.
 */
export function sanitizeTerminalOutput(input: string): string {
  if (!input) {
    return '';
  }

  const stripped = stripAnsi(input)
    .replace(/\r\n/g, '\n')
    .replace(LINE_SEPARATOR_PATTERN, '\n');

  const lines = stripped
    .split('\n')
    .map((line) => applyLineRewrites(line))
    .map((line) => line.replace(CONTROL_PATTERN, '').replace(INVISIBLE_PATTERN, ''))
    .map((line) => line.replace(/[ \t]+$/, ''));

  return collapseBlankLines(lines).join('\n');
}

/** Collapses runs of blank lines to one and trims blank lines off both ends. */
export function collapseBlankLines(lines: string[]): string[] {
  const out: string[] = [];
  let blankRun = 0;

  for (const line of lines) {
    if (line.trim() === '') {
      blankRun++;
      if (blankRun > 1) {
        continue;
      }
    } else {
      blankRun = 0;
    }
    out.push(line);
  }

  while (out.length && out[0].trim() === '') {
    out.shift();
  }
  while (out.length && out[out.length - 1].trim() === '') {
    out.pop();
  }

  return out;
}

/**
 * Keeps the head and tail of an over-long excerpt. The first lines usually
 * carry the command echo and the first real error; the last lines carry the
 * summary and exit status. The middle is the part nobody reads.
 */
export function excerptLines(text: string, maxLines: number, headRatio = 0.35): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (maxLines <= 0 || lines.length <= maxLines) {
    return lines.join('\n');
  }

  if (maxLines < 8) {
    return lines.slice(-maxLines).join('\n');
  }

  const headCount = Math.max(1, Math.floor(maxLines * headRatio));
  const tailCount = maxLines - headCount - 1;
  const omitted = lines.length - headCount - tailCount;

  return [
    ...lines.slice(0, headCount),
    '... ' + omitted + ' line' + (omitted === 1 ? '' : 's') + ' omitted ...',
    ...lines.slice(-tailCount)
  ].join('\n');
}

/** Hard character cap that breaks on a line boundary when it reasonably can. */
export function truncateChars(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  const slice = text.slice(0, maxChars);
  const lastNewline = slice.lastIndexOf('\n');
  const cut = lastNewline > maxChars * 0.6 ? slice.slice(0, lastNewline) : slice;
  return cut + '\n... truncated ...';
}

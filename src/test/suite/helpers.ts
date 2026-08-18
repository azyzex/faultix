import * as fs from 'fs';
import * as path from 'path';

/**
 * Fixtures live in `src/` rather than `out/` because they are recorded data,
 * not compiled code. Tests run from `out/test/suite`, so walk back to the
 * repository root and down into the source tree.
 */
const FIXTURE_DIR = path.resolve(__dirname, '..', '..', '..', 'src', 'test', 'fixtures');

export function fixturePath(name: string): string {
  return path.join(FIXTURE_DIR, name);
}

/** Reads a recorded terminal capture verbatim, escape bytes included. */
export function readFixture(name: string): string {
  return fs.readFileSync(fixturePath(name), 'utf8');
}

/** Every recorded fixture, sorted, for table-driven tests. */
export function allFixtures(): string[] {
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.txt'))
    .sort();
}

/** Builds a string containing real ANSI control sequences. */
export const esc = (s: string): string => String.fromCharCode(0x1b) + s;
export const bel = String.fromCharCode(0x07);

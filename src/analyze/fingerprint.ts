/**
 * Failure fingerprinting.
 *
 * Two runs of the same broken build must produce the same signature, and two
 * genuinely different failures must not. That makes repeat detection possible:
 * "seen 6 times" is the strongest signal a brief can carry, because it means
 * whatever was tried last did not work.
 *
 * The signature deliberately excludes timestamps, absolute paths, line numbers
 * and any other value that drifts between runs. It includes the failure kind,
 * the tool, the normalized command, and the normalized primary error.
 *
 * Pure apart from `crypto`, so it is unit testable.
 */

import * as crypto from 'crypto';
import { normalizeMessage } from './errorExtract';

export interface Fingerprint {
  signature: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
}

export interface FingerprintInput {
  kind: string;
  commandLine?: string;
  toolHint?: string;
  primaryMessage?: string;
  primaryCode?: string;
  primaryFile?: string;
}

/** Length of the hex signature. 12 hex chars is ~48 bits: plenty here. */
const SIGNATURE_LENGTH = 12;

/**
 * Reduces a command to its stable shape: paths, numbers, temp directories and
 * hashes all vary between runs of the same failing command.
 */
export function normalizeCommand(commandLine: string): string {
  return commandLine
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/(?:[A-Za-z]:)?[\\/][^\s"']+/g, '<path>')
    .replace(/\b[0-9a-f]{7,40}\b/gi, '<hash>')
    .replace(/\b\d+\b/g, '<n>')
    .toLowerCase();
}

/** Builds the string that gets hashed. Exposed so tests can assert on it. */
export function fingerprintSource(input: FingerprintInput): string {
  return [
    input.kind,
    input.toolHint ?? 'unknown-tool',
    input.commandLine ? normalizeCommand(input.commandLine) : 'no-command',
    input.primaryCode ?? '',
    input.primaryMessage ? normalizeMessage(input.primaryMessage) : '',
    input.primaryFile ? input.primaryFile.replace(/\\/g, '/').toLowerCase() : ''
  ].join('|');
}

/** Computes a fresh fingerprint. Counts are filled in later from history. */
export function computeFingerprint(input: FingerprintInput, now = new Date()): Fingerprint {
  const signature = crypto
    .createHash('sha256')
    .update(fingerprintSource(input))
    .digest('hex')
    .slice(0, SIGNATURE_LENGTH);

  const timestamp = now.toISOString();
  return { signature, count: 1, firstSeen: timestamp, lastSeen: timestamp };
}

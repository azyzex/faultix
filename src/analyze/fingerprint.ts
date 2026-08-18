import * as crypto from 'crypto';
import type { DiagnosticsEvidence, Fingerprint, Suspect, TerminalEvidence } from '../core/models';

export function computeFingerprint(args: {
  kind: string;
  terminal: TerminalEvidence | undefined;
  diagnostics: DiagnosticsEvidence | undefined;
  suspects: Suspect[];
}): Fingerprint {
  const tool = args.terminal?.toolHint ?? 'unknown';
  const cmd = normalizeCommand(args.terminal?.commandLine ?? '');
  const topDiag = args.diagnostics?.top?.[0]?.message ?? '';
  const topSuspect = args.suspects[0]?.uri.toString() ?? '';

  const raw = [args.kind, tool, cmd, normalizeMessage(topDiag), topSuspect].join('|');
  const signature = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
  const now = new Date().toISOString();
  return { signature, count: 1, firstSeen: now, lastSeen: now };
}

function normalizeCommand(commandLine: string): string {
  return commandLine
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/([A-Za-z]:)?[\\/][^\s]+/g, '<path>');
}

function normalizeMessage(message: string): string {
  return message
    .trim()
    .replace(/\b\d+\b/g, '<n>')
    .replace(/([A-Za-z]:)?[\\/][^\s]+/g, '<path>');
}

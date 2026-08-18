/**
 * The incident model.
 *
 * An incident is deliberately plain data: strings, numbers and arrays, with no
 * `vscode.Uri` anywhere. That has three payoffs. It serializes to JSON without
 * a custom encoder, it renders without a workspace, and it can be asserted on
 * in unit tests that never launch an Extension Host.
 *
 * The renderers in `output/templates.ts` consume this type directly, so the
 * incident *is* the view model rather than being mapped onto one.
 */

import type { IncidentKind } from '../analyze/classify';
import type { CodeSnippet, DiagnosticView, ErrorView, IncidentView, SuspectView } from '../output/templates';

export type { IncidentKind, CodeSnippet, DiagnosticView, ErrorView, SuspectView };

export type IncidentStatus = 'unresolved' | 'resolved';

/** An incident is exactly what the renderers need, plus bookkeeping. */
export interface Incident extends IncidentView {
  /** Absolute path of the workspace this was captured in, when there is one. */
  workspaceRoot?: string;
  /** Why the capture happened, for the log and the tree view. */
  trigger: IncidentTrigger;
}

export type IncidentTrigger = 'terminal' | 'task' | 'diagnostics' | 'manual';

/** Compact record kept in history; the full incident stays on disk. */
export interface IncidentSummary {
  id: string;
  createdAt: string;
  kind: IncidentKind;
  status: IncidentStatus;
  title: string;
  summary?: string;
  trigger: IncidentTrigger;
  signature: string;
  count: number;
  /** Relative path of the archived JSON, when one was written. */
  archivePath?: string;
}

/** Everything Faultix persists between sessions. */
export interface HistoryFile {
  version: 1;
  incidents: IncidentSummary[];
  /**
   * Keyed by signature. The value is optional because this is deserialized
   * from a file on disk: a lookup for a signature never seen before misses,
   * and typing it as always-present hides that from the compiler.
   */
  fingerprints: Record<string, FingerprintStats | undefined>;
}

export interface FingerprintStats {
  count: number;
  firstSeen: string;
  lastSeen: string;
  /** Last title seen for this signature, so history reads sensibly. */
  lastTitle?: string;
}

export function emptyHistory(): HistoryFile {
  return { version: 1, incidents: [], fingerprints: {} };
}

/** Narrows unknown JSON into a history file, tolerating older shapes. */
export function coerceHistory(value: unknown): HistoryFile {
  if (!value || typeof value !== 'object') {
    return emptyHistory();
  }

  const record = value as Partial<HistoryFile>;
  return {
    version: 1,
    incidents: Array.isArray(record.incidents) ? record.incidents.filter(isIncidentSummary) : [],
    fingerprints:
      record.fingerprints && typeof record.fingerprints === 'object' ? (record.fingerprints as HistoryFile['fingerprints']) : {}
  };
}

function isIncidentSummary(value: unknown): value is IncidentSummary {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<IncidentSummary>;
  return typeof candidate.id === 'string' && typeof candidate.createdAt === 'string';
}

/** Reduces a full incident to its history record. */
export function toSummary(incident: Incident, archivePath?: string): IncidentSummary {
  return {
    id: incident.id,
    createdAt: incident.createdAt,
    kind: incident.kind,
    status: incident.status,
    title: incident.title,
    summary: incident.summary,
    trigger: incident.trigger,
    signature: incident.fingerprint.signature,
    count: incident.fingerprint.count,
    archivePath
  };
}

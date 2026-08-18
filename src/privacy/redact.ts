/**
 * Secret redaction.
 *
 * Everything Faultix writes is intended to be pasted into a chat window, a
 * pull request, or an agent prompt. Terminal output routinely contains
 * credentials — a CI token echoed by a script, a database URL in a connection
 * error, an `env` dump in a stack trace — so output is scrubbed before it is
 * ever persisted.
 *
 * Design rules:
 *  - Fail safe. A pattern that is slightly too eager costs readability; one
 *    that is too lax leaks a credential.
 *  - Preserve shape. `api_key=<redacted>` still tells the reader what was
 *    there, which keeps the brief useful.
 *  - Be idempotent. Redacting twice must not corrupt the placeholder.
 *  - Stay linear. Every pattern is bounded, so no input can trigger
 *    catastrophic backtracking.
 *
 * Pure: no `vscode` import.
 */

export const PLACEHOLDER = '<redacted>';

export interface RedactOptions {
  /** Replace the user's home directory with a neutral marker. Default true. */
  anonymizeHome?: boolean;
  /** Redact email addresses. Default false: they are rarely secret and often useful. */
  redactEmails?: boolean;
  /** Additional caller-supplied patterns. */
  extraPatterns?: RegExp[];
}

export interface RedactionResult {
  text: string;
  /** How many replacements each named rule made. */
  counts: Record<string, number>;
  /** Total replacements across all rules. */
  total: number;
}

interface Rule {
  name: string;
  pattern: RegExp;
  /**
   * Replacement. When a rule captures a "label" group it is preserved so the
   * reader can still see which setting was scrubbed.
   */
  replace: (match: string, ...groups: string[]) => string;
}

/** Keeps the label and hides the value: `token=<redacted>`. */
const keepLabel = (_match: string, label: string): string => `${label}${PLACEHOLDER}`;

/** Hides everything. */
const hideAll = (): string => PLACEHOLDER;

/**
 * Ordered most-specific-first. Vendor-shaped tokens are matched before the
 * generic `key=value` rules so the output names the vendor.
 */
const RULES: Rule[] = [
  // --- Whole-block material -------------------------------------------------
  {
    name: 'private-key-block',
    pattern:
      /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,8000}?-----END (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
    replace: () => `${PLACEHOLDER} (private key)`
  },
  {
    name: 'ssh-public-key',
    pattern: /\bssh-(?:rsa|dss|ed25519)\s+AAAA[A-Za-z0-9+/=]{20,}/g,
    replace: hideAll
  },

  // --- Vendor-shaped tokens -------------------------------------------------
  {
    name: 'github-token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,255}\b/g,
    replace: hideAll
  },
  {
    name: 'github-pat',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g,
    replace: hideAll
  },
  {
    name: 'aws-access-key-id',
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
    replace: hideAll
  },
  {
    name: 'anthropic-key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,255}\b/g,
    replace: hideAll
  },
  {
    name: 'openai-key',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,255}\b/g,
    replace: hideAll
  },
  {
    name: 'slack-token',
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,255}\b/g,
    replace: hideAll
  },
  {
    name: 'stripe-key',
    pattern: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,255}\b/g,
    replace: hideAll
  },
  {
    name: 'google-api-key',
    // Google keys are AIza + 35 chars today; accept a range so a format change
    // does not silently turn redaction off.
    pattern: /\bAIza[0-9A-Za-z_-]{30,60}\b/g,
    replace: hideAll
  },
  {
    name: 'npm-token',
    pattern: /\bnpm_[A-Za-z0-9]{20,64}\b/g,
    replace: hideAll
  },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: hideAll
  },
  {
    name: 'azure-account-key',
    pattern: /\b(AccountKey=)[A-Za-z0-9+/=]{20,}/gi,
    replace: keepLabel
  },

  // --- Header and URL credentials ------------------------------------------
  {
    name: 'authorization-header',
    pattern: /\b(authorization\s*[:=]\s*(?:bearer|basic|token)\s+)\S{4,}/gi,
    replace: keepLabel
  },
  {
    name: 'url-credentials',
    pattern: /\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@]{1,128}:)[^\s@/]{1,256}(@)/gi,
    replace: (_m, label: string, at: string) => `${label}${PLACEHOLDER}${at}`
  },

  // --- Generic labelled secrets --------------------------------------------
  {
    name: 'labelled-secret',
    pattern:
      /\b((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key|private[_-]?key|password|passwd|pwd|credential|session[_-]?key)\s*[:=]\s*)(?:"[^"\n]{1,512}"|'[^'\n]{1,512}'|\S{1,512})/gi,
    replace: keepLabel
  },
  {
    name: 'env-style-secret',
    pattern: /\b([A-Z][A-Z0-9_]{2,64}(?:_(?:TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIALS?|APIKEY))\s*=\s*)(?:"[^"\n]{1,512}"|'[^'\n]{1,512}'|\S{1,512})/g,
    replace: keepLabel
  },
  {
    name: 'bare-token-label',
    pattern: /\b(token\s*[:=]\s*)(?:"[^"\n]{1,512}"|'[^'\n]{1,512}'|\S{1,512})/gi,
    replace: keepLabel
  }
];

/** Applied only when `redactEmails` is enabled. */
const EMAIL_RULE: Rule = {
  name: 'email',
  pattern: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,128}\.[A-Za-z]{2,24}\b/g,
  replace: hideAll
};

/**
 * Home-directory shapes across the three platforms. The username itself is
 * often a real person's name, and a brief that travels should not carry it.
 */
const HOME_PATTERNS: Array<[string, RegExp]> = [
  ['windows-home', /\b[A-Za-z]:\\Users\\[^\\/:*?"<>|\r\n]{1,64}/g],
  ['windows-home-posix', /\b[A-Za-z]:\/Users\/[^\\/:*?"<>|\r\n]{1,64}/g],
  ['macos-home', /\/Users\/[A-Za-z0-9._-]{1,64}/g],
  ['linux-home', /\/home\/[A-Za-z0-9._-]{1,64}/g]
];

const HOME_PLACEHOLDER = '<home>';

/**
 * Scrubs secrets from text and reports what was removed.
 *
 * The placeholder is deliberately not itself matchable by any rule, so
 * redacting already-redacted text is a no-op.
 */
export function redactWithReport(text: string, options: RedactOptions = {}): RedactionResult {
  if (!text) {
    return { text: '', counts: {}, total: 0 };
  }

  const rules = [...RULES];
  if (options.redactEmails) {
    rules.push(EMAIL_RULE);
  }
  for (const [i, pattern] of (options.extraPatterns ?? []).entries()) {
    rules.push({ name: `custom-${i}`, pattern, replace: hideAll });
  }

  const counts: Record<string, number> = {};
  let out = text;

  for (const rule of rules) {
    // Reset lastIndex: the patterns are module-level and reused across calls.
    rule.pattern.lastIndex = 0;
    let hits = 0;

    out = out.replace(rule.pattern, (...args: unknown[]) => {
      hits++;
      const match = args[0] as string;
      const groups = args.slice(1, -2) as string[];
      return rule.replace(match, ...groups);
    });

    if (hits > 0) {
      counts[rule.name] = hits;
    }
  }

  if (options.anonymizeHome !== false) {
    for (const [name, pattern] of HOME_PATTERNS) {
      pattern.lastIndex = 0;
      let hits = 0;
      out = out.replace(pattern, () => {
        hits++;
        return HOME_PLACEHOLDER;
      });
      if (hits > 0) {
        counts[name] = (counts[name] ?? 0) + hits;
      }
    }
  }

  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return { text: out, counts, total };
}

/** Convenience wrapper for callers that only want the scrubbed text. */
export function redact(text: string, options: RedactOptions = {}): string {
  return redactWithReport(text, options).text;
}

/**
 * Replaces home-directory prefixes only, leaving the rest of the path intact.
 * Used for display paths that fall outside the workspace.
 */
export function anonymizeHomePaths(text: string): string {
  let out = text;
  for (const [, pattern] of HOME_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, HOME_PLACEHOLDER);
  }
  return out;
}

/** Names of every rule, for tests and documentation. */
export function ruleNames(): string[] {
  return [...RULES.map((r) => r.name), EMAIL_RULE.name, ...HOME_PATTERNS.map(([name]) => name)];
}

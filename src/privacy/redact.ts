const patterns: RegExp[] = [
  // Authorization: Bearer ...
  /(authorization\s*:\s*bearer\s+)([^\s\r\n]+)/gi,
  // Generic API keys / tokens
  /(api[_-]?key\s*[=:]\s*)([^\s\r\n]+)/gi,
  /(token\s*[=:]\s*)([^\s\r\n]+)/gi,
  /(password\s*[=:]\s*)([^\s\r\n]+)/gi,
  // GitHub tokens
  /(ghp_)[A-Za-z0-9]{20,}/g,
  /(github_pat_)[A-Za-z0-9_]{20,}/g
];

export function redact(text: string): string {
  let out = text;
  for (const re of patterns) {
    out = out.replace(re, (_m, p1, p2) => {
      if (typeof p2 === 'string') {
        return `${p1}<redacted>`;
      }
      return '<redacted>';
    });
  }
  return out;
}

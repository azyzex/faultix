# Security

## Reporting a vulnerability

Please report security issues privately through
[GitHub Security Advisories](https://github.com/azyzex/faultix/security/advisories/new)
rather than as a public issue. Include the version, the workspace conditions
needed to reproduce, and what an attacker gains.

You can expect an acknowledgement within a few days. Please allow a reasonable
period for a fix before public disclosure.

## Threat model

Faultix reads failure output and writes files into your workspace. That leads
to three things worth being careful about, and each is handled deliberately.

### 1. Terminal output can contain secrets

A failing command routinely prints credentials: a CI token echoed by a script,
a database URL in a connection error, an `env` dump inside a stack trace.
Everything Faultix persists or copies is scrubbed first.

Redacted by default:

| Category | Examples |
|---|---|
| Vendor tokens | GitHub (`ghp_`, `gho_`, `github_pat_`), AWS access key ids, OpenAI, Anthropic, Slack, Stripe, Google, npm |
| Structured credentials | JWTs, private key blocks, SSH public keys, Azure account keys |
| Header and URL credentials | `Authorization: Bearer …`, `Basic …`, `postgres://user:pass@host` |
| Labelled assignments | `api_key=`, `password:`, `client_secret=`, `*_TOKEN=`, `*_SECRET=` |
| Home directory paths | `C:\Users\you`, `/Users/you`, `/home/you` become `<home>` |

Redaction preserves the label (`api_key=<redacted>`) so a brief stays readable,
and every brief reports how many values it removed.

Two settings adjust this:

- `faultix.privacy.redactSecrets` (default `true`) — turning this off is not
  recommended, and the brief is intended to be pasted elsewhere.
- `faultix.privacy.redactEmails` (default `false`) — addresses are usually
  useful context rather than secrets, so this is opt-in.

**Redaction is best effort.** It recognises common shapes, not every possible
secret. Read a brief before pasting it somewhere public.

### 2. Settings are untrusted input

`faultix.output.dir` names a directory Faultix writes to. A workspace can carry
its own `.vscode/settings.json`, so opening someone else's repository must not
let it choose a write target.

The value is resolved against the workspace root and rejected unless the result
stays inside it. Absolute paths, drive-qualified paths, UNC paths and `..`
traversal are all refused, and the refusal is logged rather than silently
falling back. See `resolveWithinRoot` in `src/analyze/paths.ts`, covered by
tests in `src/test/suite/paths.test.ts`.

### 3. Failure output is attacker-influenced text

Output can be arbitrarily long, arbitrarily wide, and shaped to be awkward to
parse. Every parsing stage is bounded:

- lines longer than 2,000 characters are truncated before matching
- at most 5,000 lines are scanned
- terminal reads stop at the configured character budget
- every redaction pattern uses bounded quantifiers, so no input triggers
  catastrophic backtracking
- files over 2 MB, and binary files, are skipped when reading code context

The test suite asserts these stay bounded on pathological input.

## The run ledger

Recording successful runs (`faultix.history.recordRuns`, on by default) writes
`.ai-repair/runs.json`, containing for each tracked command: the command line,
whether it passed, the commit, whether the tree was dirty, and the
repository-relative paths that were modified. Failing runs also carry the
failure fingerprint and its one-line summary.

Two consequences worth stating plainly:

- **It is a record of your recent work.** Add `.ai-repair/` to `.gitignore`
  unless you intend to share it. Summaries are redacted and home paths
  anonymized like everything else, but the file names files you were editing.
- **`clipboardOnly` suppresses it.** That mode means "do not write to my
  workspace", and the ledger is a workspace file like any other. Turning it on
  disables run history, fix correlation and the MCP history tools; that is the
  trade the setting asks for.

## The MCP server

`faultix-mcp` exposes the contents of `.ai-repair/` to whatever agent you
connect it to. It is read-only by construction: it opens files, runs no
commands, modifies nothing and makes no network calls.

Connecting it means an agent — and therefore, usually, a model provider — can
read your failure history. That is the point of it, but it is a decision worth
making deliberately, and it is off until you configure it.

## What Faultix does not do

- **No network calls.** Nothing is uploaded, and there is no telemetry. The
  extension has no HTTP client.
- **No code execution.** The only subprocess is `git`, invoked via `execFile`
  with a fixed argument array (never a shell string), a 1.5 second timeout, and
  a 1 MB output cap. `faultix.git.enabled` turns it off entirely.
- **No writes outside the workspace.** History metadata lives in the
  extension's own storage; briefs live only under the configured output folder.

## Untrusted and virtual workspaces

In an untrusted workspace, Faultix does not run `git` and does not read files
for code context. Capture still works from terminal output alone.

## Dependencies

Faultix ships no runtime dependencies — the packaged extension is compiled
JavaScript plus two icons. Everything in `devDependencies` stays out of the
`.vsix`; `npm run package` verifies this via `.vscodeignore`.

`package.json` pins two `overrides` (`serialize-javascript`, `diff`) to pull
patched versions into the mocha dependency tree. Without them `npm audit`
reports advisories whose only offered remedy is downgrading mocha by three
major versions, which would be strictly worse. `npm audit` currently reports
zero vulnerabilities.

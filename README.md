# Faultix

**Remembers every failure in your project, and what fixed it — and lets your
coding agent ask.**

[![CI](https://github.com/azyzex/faultix/actions/workflows/ci.yml/badge.svg)](https://github.com/azyzex/faultix/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.93-007ACC.svg)](https://code.visualstudio.com/)

When a build breaks, Faultix works out the root cause, pulls in the code around
it, strips the secrets, and writes a brief you can hand straight to an agent.

It also records the runs that *succeed*, which is what makes the useful part
possible: it knows this failure has happened six times, that you fixed it last
Tuesday by editing one file, and that this test disagrees with itself at the
same commit. An agent starts every session cold and cannot know any of that —
so Faultix exposes it over the Model Context Protocol, and the agent asks.

Everything happens locally. There are no network calls and no telemetry.

---

## What a brief looks like

A failing `python app.py` produces this, automatically:

````markdown
# ZeroDivisionError: division by zero (app/report.py:6)

| | |
|---|---|
| **Kind** | Runtime error |
| **Command** | `python app.py` |
| **Exit code** | 1 |
| **Duration** | 1.8s |
| **Fingerprint** | `bc614b553120` (seen 3x) |

> Seen 3 times.

## Root cause

ZeroDivisionError: division by zero (`app/report.py:6`)

## Code context

**app/report.py**

```python
  3 | def summarize(rows):
  4 |     data = {"count": 0}
  5 |     print("count:", data["count"])
> 6 |     return 10 / data["count"]
  7 |
  8 | summarize([])
```

## Files to inspect first

- **app/report.py:6** (score 177)
  - Named by the primary error
  - Modified in the working tree
````

Alongside it, `repair.prompt.md` says the same thing in the order an agent
wants it: conclusion, evidence, code, then an explicit task with instructions
not to paper over the error.

## For agents

```bash
claude mcp add faultix -- node /path/to/faultix/out/mcp/server.js /path/to/project
```

Then your agent can ask:

| Tool | Answers |
|---|---|
| `faultix_latest_failure` | What just broke? |
| `faultix_search_failures` | Has this happened before? |
| `faultix_failure_history` | Was it fixed, and by changing what? |
| `faultix_flaky_commands` | Which commands disagree with themselves? |
| `faultix_command_stats` | Pass rates, and when each last worked. |
| `faultix_recent_failures` | What has been going wrong lately? |

The server is read-only and ships with the extension. **Faultix: Copy MCP
Server Config** puts a ready-to-paste config on your clipboard. See
[docs/MCP.md](docs/MCP.md).

## What it remembers

Because successes are recorded too, a brief can say things no single run
reveals:

```markdown
## What history says

- **Fixed before:** this failure went away on 2026-08-19 after changes to
  `src/db/pool.ts`, `src/db/schema.sql`.
- **Last passed:** 2026-08-19 at `bbb222`.
- **Pass rate:** 33% of 3 recorded runs.
```

And the agent prompt leads with it:

```markdown
## You have fixed this before

The same failure was resolved on 2026-08-19, after 2 attempts.

Files being edited when it went away:
- `src/db/pool.ts`

Start there. It is a strong hint, not a certainty.
```

**Flaky detection** falls out of the same data. When a command passed *and*
failed at the same commit with a clean working tree, the code provably did not
change between those runs — so the failure is flakiness, a race or an unstable
environment, not a fault to fix in the logic. Faultix says so rather than
letting you or your agent burn an hour on it.

## How it works

```
failing command
      |
      v
  sanitize      strip ANSI, cursor moves, shell-integration markers;
      |         collapse progress bars back to their final line
      v
   redact       remove tokens, keys, credentials, home paths
      |
      v
  classify      what kind of failure, and which toolchain
      |
      v
   extract      parse structured errors; pick the root cause by confidence
      |
      v
    rank        score suspect files; require corroboration before trusting
      |         ambient editor diagnostics
      v
  code context  read the lines around the failure
      |
      v
  fingerprint   recognise this failure if it happens again
      |
      v
   history      has this happened before? was it fixed? by changing what?
      |
      v
   render       incident.md, repair.prompt.md, incident.json
```

### Ranking, briefly

The interesting decision is what counts as evidence. A workspace often has
hundreds of open warnings that have nothing to do with the command that just
failed, so diagnostics only count fully when the failure output names the same
file. A file known *only* from ambient diagnostics is not listed at all.
Vendored and generated paths are demoted; recently-changed files are promoted,
but only once something else has implicated them.

## Install

Not yet on the Marketplace. To build and install locally:

```bash
git clone https://github.com/azyzex/faultix.git
cd faultix
npm install
npm run package
code --install-extension faultix.vsix
```

To develop, open the folder in VS Code and press `F5` for an Extension
Development Host.

## Usage

Faultix runs on its own. Once installed:

- Run a command that fails in the integrated terminal (shell integration must
  be on, which it is by default) and a brief appears.
- A failing VS Code task does the same.
- So does a sudden rise in error diagnostics.

Files land in `.ai-repair/` in your workspace:

```
.ai-repair/
  latest/
    incident.md          human-readable
    repair.prompt.md     paste into an agent
    incident.json        machine-readable
  history/               archived incidents, pruned automatically
  runs.json              the run ledger: what passed, what failed, when
```

Add `.ai-repair/` to your `.gitignore`, or set
`faultix.output.mode` to `clipboardOnly` if you would rather nothing was
written at all.

### Commands

| Command | What it does |
|---|---|
| `Faultix: Capture Repair Brief Now` | Capture the current state without waiting for a failure |
| `Faultix: Open Latest Brief` | Open `incident.md` |
| `Faultix: Copy Agent Prompt` | Copy `repair.prompt.md` to the clipboard |
| `Faultix: Copy Brief as Markdown` | Copy the human brief |
| `Faultix: Re-run Failing Command` | Re-run the command that failed |
| `Faultix: Mark Latest Incident Resolved` | Clear the status bar indicator |
| `Faultix: Reveal Output Folder` | Open `.ai-repair/` in the OS file manager |
| `Faultix: Show Flaky Commands` | List commands that disagree with themselves |
| `Faultix: Copy MCP Server Config` | Connect an agent to this workspace's history |
| `Faultix: Clear History` | Reset the archive, run ledger and repeat counts |
| `Faultix: Pause or Resume Automatic Capture` | Stop capturing for this session |

### Settings

All settings live under `faultix.*`. The ones worth knowing:

| Setting | Default | Purpose |
|---|---|---|
| `capture.autoOnNonZeroExit` | `true` | Capture when a terminal command fails |
| `capture.autoOnTaskFailure` | `true` | Capture when a task fails |
| `capture.autoOnDiagnosticsSpike` | `true` | Capture on a burst of new errors |
| `capture.diagnosticsSpikeThreshold` | `10` | How many new errors count as a burst |
| `output.mode` | `autoWrite` | `autoWrite`, `previewRequired`, or `clipboardOnly` |
| `output.dir` | `.ai-repair` | Where briefs go (must stay inside the workspace) |
| `output.keepHistory` | `50` | Archived incidents to retain |
| `output.maxSnippets` | `3` | Inline code snippets per brief |
| `output.snippetContextLines` | `6` | Lines of context either side of a failure |
| `history.recordRuns` | `true` | Record successful runs too, enabling fix correlation and flaky detection |
| `history.maxRuns` | `500` | How many runs to remember |
| `privacy.redactSecrets` | `true` | Scrub credentials before writing anything |
| `privacy.anonymizeHomePaths` | `true` | Replace your home directory with `<home>` |
| `git.enabled` | `true` | Include branch, dirty state and changed files |
| `ui.notifyOnCapture` | `true` | Show a notification on capture |

## Toolchain coverage

Root-cause extraction is verified against recorded output from:

TypeScript · ESLint · Node.js · Python · pytest · Jest · Vitest · Rust ·
Go · GCC/Clang · javac · MSBuild/C# · npm · Docker · Make · Bash · PowerShell ·
cmd.exe

Unrecognised toolchains still produce a brief; they fall back to generic
`file:line` and keyword matching.

## Privacy and security

- No network calls, no telemetry.
- The only subprocess is `git`, with fixed arguments and a 1.5 second timeout.
- Secrets are redacted before anything is written or copied.
- The output directory setting cannot escape the workspace.
- All parsing is bounded so hostile output cannot stall the editor.

See [SECURITY.md](SECURITY.md) for the full threat model.

## Trying it without installing

`faultix-brief` runs a command and prints the brief the extension would
produce, using the same pipeline:

```bash
npm run compile
npm run brief -- "python app.py"
npm run brief -- --prompt "npm test"     # the agent version
npm run brief -- --json "cargo build"    # every matcher that fired
```

## Development

```bash
npm install
npm run verify           # lint, typecheck, and 553 unit tests
npm run test:integration # 17 tests in a real VS Code Extension Host
npm run test:coverage   # coverage report
npm run package         # build faultix.vsix
```

The analysis core in `src/analyze` and `src/output` imports no `vscode` APIs,
so it runs under plain mocha. The VS Code layer is a thin adapter over it.
Recorded failure output lives in `src/test/fixtures` — adding a toolchain means
adding a fixture and an expectation, not writing a mock.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow,
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pipeline fits
together, [docs/TESTING.md](docs/TESTING.md) for how to exercise it, and
[docs/MCP.md](docs/MCP.md) for the agent integration.

## License

[MIT](LICENSE)

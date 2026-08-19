# Changelog

All notable changes to Faultix are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-08-19

### Added

- **What changed since it last passed.** The ledger already recorded the commit
  of the last passing run; nothing used it. Briefs now list the files that
  differ from that commit, and the agent prompt says plainly that the cause is
  very likely among them. It is the first question anyone asks when something
  that used to work stops, and it is pure bookkeeping to answer. Degrades
  quietly when the commit cannot be resolved, since a branch that has been
  rebased away is normal rather than an error.
- **Error grouping.** Briefs state how many files the errors span, and call it
  out when one diagnostic code accounts for most of them: *"4 of 5 errors are
  TS2304 across 3 files ... probably symptoms of one cause rather than separate
  problems"*. A flat list of forty errors from one bad import invites fixing
  them one at a time. The threshold is 60% of the output and at least three
  errors, because below that there is no pile to explain.

## [0.3.1] - 2026-08-19

### Fixed

- **JSON was written non-atomically.** A reader could observe a truncated
  `incident.json`, which parses as "nothing captured" rather than as an error
  — the worst kind of wrong answer, and the MCP server is exactly such a
  reader. Briefs, the archive and both ledgers now write to a temporary file
  and rename over the target, with a direct write as a fallback. A temporary
  left behind by a crash is cleaned up during pruning.
- **`output.mode: clipboardOnly` was writing the run ledger.** That mode
  promises nothing is written to the workspace, and the ledger is a workspace
  file like any other. It now honours the mode, at the cost of the history
  features — which is the trade the setting asks for.

## [0.3.0] - 2026-08-19

Faultix stops being a formatter and starts being a memory.

Recording only failures meant it could say a command broke but never that it
started working again. Recording successes too makes three questions
answerable, and none of them can be answered by an agent, which starts every
session cold and only sees the run it just performed.

### Added

- **Run ledger.** Every tracked command is recorded, passing or failing, in
  `.ai-repair/runs.json`. Successful runs are filtered by the capture
  classifier, so builds and test runs are kept and `cd` and `ls` are not.
- **Fix correlation.** When a failure goes away, Faultix reports what was being
  edited when it did — the overlap between the failing and passing working
  trees, or their union when nothing overlaps. Briefs carry a
  "What history says" section; the agent prompt leads with "You have fixed this
  before" and the files involved. It is a heuristic and says so, and it flags
  when commits landed in between.
- **Flaky detection.** A command that passed *and* failed at the same commit
  with a clean working tree cannot have been affected by a code change, so the
  failure is flakiness, a race or an unstable environment. Reported at lower
  confidence when the tree was dirty, and suppressed entirely when a fix was
  recorded, since that explains the disagreement without invoking flakiness.
- **What changed since it last passed.** The commit of the last passing run.
- **MCP server.** `faultix-mcp` exposes the whole of the above to a coding
  agent over the Model Context Protocol: `faultix_latest_failure`,
  `faultix_search_failures`, `faultix_failure_history`,
  `faultix_flaky_commands`, `faultix_command_stats` and
  `faultix_recent_failures`. Read-only: it opens the files the extension wrote,
  runs nothing and modifies nothing. See docs/MCP.md.
- **Two commands:** Copy MCP Server Config, which emits a config pointing at
  the installed server so it works as pasted, and Show Flaky Commands.
- **Two settings:** `faultix.history.recordRuns` and
  `faultix.history.maxRuns`.

### Fixed

- The agent prompt printed a "Context" heading with nothing beneath it.

### Internal

- `deriveHistory` was pure logic stranded in the `vscode` adapter, so neither
  the CLI nor the MCP server could reach it; it now lives in `analyze/`.
  Three front ends — the extension, `faultix-brief` and `faultix-mcp` — run the
  same analysis code as a result.
- The MCP protocol is implemented directly rather than through the SDK. It is
  JSON-RPC 2.0 over stdio with four methods that matter, and adding a package
  tree to serve read-only queries would break the zero-runtime-dependency
  promise for no benefit.
- 522 unit tests and 17 Extension Host tests.

## [0.2.3] - 2026-08-19

Found by running the extension against a real workspace rather than a fixture.

### Fixed

- **npm 10 output was not recognised.** npm changed its prefix from
  `npm ERR!` to `npm error` in v10, so every line fell through to the keyword
  fallback: a failed `npm run` produced eight near-useless "errors" and led
  with `npm error code ENOENT` instead of the sentence that explains it,
  `Could not read package.json: ENOENT ...`. Both spellings are now accepted,
  npm's per-line bookkeeping markers are stripped, and a line the npm matcher
  rejects as noise no longer falls through to be picked up again.
- **Home directories leaked through error messages.** Anonymization covered
  the terminal excerpt and the summary but not the parsed error list, and
  tools print absolute paths inside their messages. A brief that scrubbed its
  own output still showed `C:\Users\you\...` a few lines further down.
- **Exit codes were unreadable on Windows.** A negative status arrives in its
  unsigned 32-bit form, so npm's errno -4058 displayed as 4294963238.

## [0.2.2] - 2026-08-18

### Fixed

- **Briefs could leak an absolute path.** The title was built from the raw
  output rather than the resolved location, so it embedded whatever path the
  tool happened to print — including the home directory the rest of the brief
  anonymizes. Code-context headers had the same problem.
- **Capturing with no workspace folder open produced no suspects.** Every
  relative path failed to resolve and the evidence was silently discarded.
  Unresolvable references are now kept in display form: they rank and are
  named, they just cannot be opened.

### Added

- `faultix-brief`, a CLI that runs a command and prints the brief the
  extension would produce, without launching an editor. `--prompt` for the
  agent version, `--json` to see every matcher that fired, `--save` to record
  a test fixture. Not shipped in the extension package. See
  [docs/TESTING.md](docs/TESTING.md).

### Internal

- The pipeline moved into `analyze/pipeline.ts` with no `vscode` import;
  `buildIncident` is now a thin adapter over it, and the CLI calls it directly.
  The pipeline tests had re-implemented the stages by hand and could have
  stayed green while the extension's assembly drifted; they now call the real
  code.
- Capture groups go through an accessor that distinguishes required from
  optional, so the compiler checks a distinction the regex already encodes.
  This made `no-unnecessary-condition` trustworthy enough to enable, which then
  found four more places where a declared type was more confident than reality.
- `docs/ARCHITECTURE.md` and `docs/TESTING.md`.

## [0.2.1] - 2026-08-18

Two defects found by reviewing and testing the 0.2.0 build. Anyone on 0.2.0
should move to this release.

### Fixed

- **Repeat counts advanced in steps of two.** Every capture was recorded
  twice — once to stamp the count before rendering, then again to attach the
  archive path — so three failures reported "seen 6 times" and history
  collected duplicate entries. The archive path is now patched onto the
  existing record.
- **The declared VS Code version was wrong.** `engines.vscode` claimed
  `^1.88.0`, but the extension is built on the terminal shell integration API
  finalized in 1.93, so installing on 1.88 would have failed at runtime. The
  floor is now `^1.93.0`, and `@types/vscode` is pinned with `~` to the same
  version so the compiler enforces it rather than letting the types float
  twenty minor versions ahead.

### Internal

- `verify` and `test:coverage` ran mocha without compiling first and only
  passed locally because a previous build had left `out/` in place. Every test
  entry point now compiles.
- A passing Extension Host run could still fail: cleanup of the temporary
  workspace hit `EBUSY` on Windows. Teardown now retries and never changes the
  result.
- The rustc, javac and gcc fixtures are now real captured output from
  cargo 1.97, javac 17 and gcc 13.2 rather than hand-written approximations.
- Coverage thresholds enforced in CI (90% statements, 80% branches);
  `docs/ARCHITECTURE.md` added; launch configurations for the extension, a
  broken workspace, and both test suites.

## [0.2.0] - 2026-08-18

The first release where a brief is genuinely useful without editing. Briefs now
lead with the root cause, embed the code around it, and no longer carry terminal
control-code garbage.

### Added

- **Root-cause extraction.** Structured error records are parsed from failure
  output using per-toolchain matchers with confidence tiers, so a brief leads
  with the error that actually stopped the build rather than the first line
  containing the word "error". Verified against recorded output from tsc,
  eslint, node, python, pytest, jest, vitest, rustc, go, gcc, javac, msbuild,
  npm, docker, make, bash and PowerShell.
- **Inline code context.** Briefs embed the lines around each failure location
  with the offending line marked, so an agent does not need a round trip to
  read the code.
- **Repeat detection.** Failures are fingerprinted from the normalized command
  and primary error, so the same failure is recognised across runs. A brief
  that has been seen five times says so.
- **New commands:** Copy Agent Prompt, Reveal Output Folder, Clear History, and
  Pause or Resume Automatic Capture.
- **Richer side panel.** Suspects and parsed errors open the file at the right
  line; recent history is listed.
- **Task duration** and **capture trigger** are recorded on each incident.
- **12 new settings** covering snippet size, suspect and error limits, history
  retention, notification behaviour, and extra ignored folders.
- **Untrusted workspace support.** Git and file reads are skipped rather than
  silently attempted.

### Changed

- **Terminal output is sanitized.** ANSI colour codes, cursor movement, device
  status queries, window titles and VS Code shell-integration markers are
  stripped, and progress bars that rewrote one line are collapsed to their
  final state. Previously briefs opened with several lines of escape sequences.
- **Suspect ranking now requires corroboration.** Open editor diagnostics count
  fully only when the failure output names the same file; a file known solely
  from ambient diagnostics is no longer listed as a suspect. Previously an
  unrelated warning-heavy file could rank second for a failing shell script.
- **Excerpts keep the head and the tail** of long output instead of only the
  tail, so the command echo and the first error survive alongside the summary.
- **Secret redaction hardened** from 6 patterns to 20, adding AWS, OpenAI,
  Anthropic, Slack, Stripe, Google, npm, JWTs, private key blocks, URL
  credentials and env-style assignments. Briefs report how much was removed.
- **Home directories are anonymized** in output, at render time so that path
  resolution and code context still work.
- **The incident model is plain serializable data**, which removed the custom
  JSON encoder and made rendering testable without a workspace.
- **Diagnostics capture is debounced** so a language server working through a
  large project produces one incident rather than a burst.

### Fixed

- The primary error was listed twice in the agent prompt: de-duplication
  compared object identity, which never matched in practice.
- A diagnostic code was printed twice when the message already began with it.
- `src/bin` was treated as build output, demoting real Rust sources.
- Task names using plurals ("Run unit tests") were not classified as tests.
- Method calls such as `expect(x).toBe(5)` were parsed as the file `.toBe` at
  line 5.
- Windows-only line-ending normalization corrupted recorded test fixtures.
- A failed capture could surface as an unhandled rejection; captures are now
  isolated and logged.

### Security

- The `faultix.output.dir` setting is validated against workspace escape.
  Absolute, drive-qualified, UNC and `..` paths are refused, closing a path
  traversal a malicious workspace could otherwise trigger.
- All parsing is bounded by line length, line count and character budget, so
  hostile output cannot stall the extension host.
- Dependency advisories resolved: `npm audit` reports zero vulnerabilities.

### Internal

- The analysis core was extracted into `vscode`-free modules, making it unit
  testable without an Extension Host.
- Test suite grew from 2 tests to 416, including 23 recorded failure fixtures
  and an end-to-end suite that renders a brief for every one of them.

## [0.1.0] - 2026-03-28

Initial working version: terminal, task and diagnostics capture; suspect
ranking; fingerprinting; markdown and prompt output; tree view.

[0.4.0]: https://github.com/azyzex/faultix/releases/tag/v0.4.0
[0.3.1]: https://github.com/azyzex/faultix/releases/tag/v0.3.1
[0.3.0]: https://github.com/azyzex/faultix/releases/tag/v0.3.0
[0.2.3]: https://github.com/azyzex/faultix/releases/tag/v0.2.3
[0.2.2]: https://github.com/azyzex/faultix/releases/tag/v0.2.2
[0.2.1]: https://github.com/azyzex/faultix/releases/tag/v0.2.1
[0.2.0]: https://github.com/azyzex/faultix/releases/tag/v0.2.0
[0.1.0]: https://github.com/azyzex/faultix/releases/tag/v0.1.0

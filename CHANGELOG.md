# Changelog

All notable changes to Faultix are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.2.2]: https://github.com/azyzex/faultix/releases/tag/v0.2.2
[0.2.1]: https://github.com/azyzex/faultix/releases/tag/v0.2.1
[0.2.0]: https://github.com/azyzex/faultix/releases/tag/v0.2.0
[0.1.0]: https://github.com/azyzex/faultix/releases/tag/v0.1.0

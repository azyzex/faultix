# Changelog

All notable changes to Faultix are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.2.0]: https://github.com/azyzex/faultix/releases/tag/v0.2.0
[0.1.0]: https://github.com/azyzex/faultix/releases/tag/v0.1.0

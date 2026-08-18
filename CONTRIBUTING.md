# Contributing to Faultix

Thanks for taking a look. This document covers how the project is laid out and
what a change is expected to come with.

## Getting started

```bash
npm install
npm run verify            # lint + typecheck + 416 unit tests
npm run test:integration  # 16 tests inside a real Extension Host
```

Press `F5` in VS Code to launch an Extension Development Host. Point it at a
workspace with something broken in it — there is a companion "error zoo" of
intentionally broken files across many languages that works well for this.

## Layout

The single most important structural rule: **the analysis core does not import
`vscode`.**

```
src/
  analyze/      pure. ANSI sanitizing, classification, error extraction,
                path safety, suspect ranking, fingerprinting
  privacy/      pure. Secret redaction
  output/       pure. Brief and prompt rendering
  capture/      VS Code adapter. Event plumbing and incident assembly
  core/         VS Code adapter. Settings, state, persistence
  ui/           VS Code adapter. The side panel
  test/
    fixtures/   recorded terminal output from real failing tools
    suite/      mocha tests
```

Everything in `analyze/`, `privacy/` and `output/` runs under plain mocha with
no Extension Host. That is what makes the test suite fast and worth having, so
please keep new logic on that side of the line and let the adapter layer stay
thin.

## Adding support for a toolchain

This is the most common useful contribution, and it is deliberately easy.

1. **Record real output.** Run the failing tool, capture stdout and stderr
   verbatim, and save it to `src/test/fixtures/<tool>-<case>.txt`. Do not
   hand-write it — the value of the corpus is that it is real. Replace any
   personal paths with `C:\Users\dev\projects\demo` or `/home/dev/demo`.
2. **Add an expectation** to `EXPECTATIONS` in
   `src/test/suite/errorExtract.test.ts`, stating what the primary error should
   say and where it should point. The suite asserts every fixture has one, so a
   fixture without an expectation fails the build.
3. **Add a matcher** in `src/analyze/errorExtract.ts` if the existing ones do
   not already handle it. Matchers are ordered most-specific-first and carry a
   confidence tier; anything with a diagnostic code and a location belongs
   above the generic location matchers, which belong above the keyword
   fallback.
4. **Add the fixture to the pipeline suite** command map in
   `src/test/suite/pipeline.test.ts` so it is rendered end to end.

Run `npm run test:unit`. If another fixture regresses, the matcher is too
greedy — tighten it rather than reordering the table.

## Expectations for a change

- **Tests.** Behaviour changes come with tests. The suite is fixture-driven, so
  this is usually a matter of recording output rather than writing mocks.
- **Bounded parsing.** Anything reading failure output must stay bounded in
  line length and count. Failure output is attacker-influenced text; see
  [SECURITY.md](SECURITY.md).
- **No new runtime dependencies.** The packaged extension is compiled
  JavaScript and two icons, and it should stay that way. `devDependencies` are
  fine.
- **No network calls.** Faultix is local-first, and that is a promise made in
  the README rather than a default that might drift.
- **Comments explain why.** The code says what it does; a comment should say
  why it is that way, especially where the reason is not obvious (ordering
  constraints, workarounds for shell behaviour, deliberate trade-offs).

## Commit messages

Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`,
`refactor:`). Explain the reasoning in the body when a change is not
self-evident — the changelog is written from these.

## Releasing

Maintainers only:

1. Update `CHANGELOG.md` under a new version heading.
2. Bump `version` in `package.json`.
3. Tag `vX.Y.Z` and push. The release workflow builds the `.vsix`, attaches it
   to a GitHub release, and publishes to the Marketplace when a `VSCE_PAT`
   secret is configured.

## Dependency overrides

`package.json` pins `serialize-javascript` and `diff` via `overrides` to pull
patched versions into mocha's dependency tree. Without them `npm audit` reports
advisories whose only offered remedy is downgrading mocha by three major
versions. If mocha ships updated ranges, remove the overrides and confirm
`npm audit` still reports zero vulnerabilities.

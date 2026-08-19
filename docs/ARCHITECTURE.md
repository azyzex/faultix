# Architecture

## The rule everything else follows from

**The analysis core does not import `vscode`.**

```
src/analyze/   pure    ANSI sanitizing, classification, error extraction,
src/privacy/   pure    path safety, ranking, fingerprinting, the run ledger,
src/output/    pure    redaction, brief and prompt rendering
                       |
                       | consumed by
                       v
src/capture/   adapter event plumbing and incident assembly
src/core/      adapter settings, state, persistence
src/ui/        adapter the side panel
src/mcp/       adapter the MCP server (filesystem only, no vscode)
src/tools/     adapter the faultix-brief CLI (no vscode)
```

Note what that last pair implies: because the core has no `vscode` import,
three separate front ends run the *same* analysis — the extension, the CLI and
the MCP server. None of them re-implements it.

Everything above the line runs under plain mocha in about 300ms. Everything
below it needs an Extension Host and takes about 8 seconds. That ratio is why
the split is worth enforcing: it is what makes it cheap enough to test the
interesting logic thoroughly, and it is why 421 of the 437 tests never launch
an editor.

The practical consequence is that logic should keep moving *up*. When a piece
of the adapter layer starts making decisions, that decision belongs in a pure
module with the adapter passing it plain data.

## The pipeline

`analyze/pipeline.ts` is the only place observations become an incident, and
it has no `vscode` import. `capture/buildIncident.ts` is a thin adapter that
gathers editor state and calls it; the `faultix-brief` CLI calls it directly.
Both paths therefore run the same code.
Everything upstream gathers raw material; everything downstream renders or
persists what it produced. The ordering is not arbitrary — each step below
depends on the one before it, and two of the orderings are load-bearing.

| # | Stage | Module | Notes |
|---|---|---|---|
| 1 | sanitize | `analyze/ansi.ts` | Strip escapes, resolve carriage-return rewrites |
| 2 | redact | `privacy/redact.ts` | Secrets only — see below |
| 3 | classify | `analyze/classify.ts` | Kind and toolchain; the tool hint picks the parser |
| 4 | extract | `analyze/errorExtract.ts` | Structured errors, ranked by confidence |
| 5 | resolve | `buildIncident.ts` | Every path spelling collapses to one absolute path |
| 6 | rank | `analyze/scoring.ts` | Suspect files, weighted by evidence quality |
| 7 | context | `capture/snippets.ts` | Read the code around each location |
| 8 | fingerprint | `analyze/fingerprint.ts` | Recognise the failure across runs |
| 9 | history | `analyze/runLedger.ts` | Has this happened before? Was it fixed? |
| 10 | render | `output/templates.ts` | Home-path anonymization happens *here* |

## The run ledger

`analyze/runLedger.ts` records every tracked command, passing or failing, in
`.ai-repair/runs.json`. Recording only failures was the original design, and it
made three questions unanswerable:

- **Was it fixed, and by what?** A failure followed by a pass of the same
  command is a resolution. The files reported are those being edited across
  both runs — the overlap when there is one, the union otherwise. It is a
  heuristic, documented as one, and it flags when commits landed too.
- **Is this flaky?** A pass and a failure at the same commit with a clean tree
  means the code did not change, so the fault is not in the logic. A dirty tree
  gets the same finding at lower confidence, because an edit explains it — and
  when a fix was recorded for that command, the low-confidence signal is
  suppressed entirely rather than contradicting it.
- **What changed since it last passed?** The commit of the last passing run.

Successful runs are filtered by the capture classifier: if it can name what
kind of work a command is, the run is worth keeping. That is what stops every
`cd` and `ls` from burying the builds.

### Two orderings that matter

**Redaction splits in two.** Secret removal runs at step 2, before anything
touches the text. Home-directory anonymization runs at step 9, after paths
have been resolved. Doing both at step 2 was a real bug: it turned every stack
frame into `<home>\...`, which resolves to nothing, silently disabling code
snippets and open-at-line while every test still passed.

**Diagnostics are applied last in ranking.** Their weight depends on whether
any other evidence already implicated the file, so they cannot be accumulated
until the terminal-derived evidence is in.

## Data model

An incident is plain serializable data — strings, numbers, arrays, no
`vscode.Uri` anywhere. It is *also* the view model the renderers consume, so
there is no mapping layer between them.

That buys three things: JSON persistence needs no custom encoder, rendering
can be tested without a workspace, and the archived `incident.json` is exactly
the structure the code operates on rather than a lossy projection of it.

Where the UI needs to open a file, the model carries an `absolutePath`
alongside the workspace-relative `file` used for display. Renderers ignore it.

## Error extraction

The part that does the real work. Roughly twenty matchers, each a regex plus a
builder plus a confidence tier, ordered most-specific-first:

```
codedWithLocation  100   tsc, MSBuild, gcc, javac, make, PHP
exception           90   Python and Node exception lines, pytest E-lines
location            70   go, eslint, bash, generic path:line
assertion           65   jest/vitest expect() and Expected/Received
runnerFailure       60   FAIL headers and test markers
toolPrefixed        45   npm ERR!, docker, PowerShell tails
keyword             20   anything announcing a failure
```

The first matcher to claim a line wins. The primary error is the highest
confidence tier; within a tier, compiler-style output takes the *first* record
(the first error usually causes the rest) while exception-style output takes
the *last* (the trailing exception is what actually stopped the process).

Two passes run afterwards. `attachNearbyLocations` walks a window around each
location-less record, because rustc puts the location on the following line and
Python puts the offending frame above the exception. `preferDescriptiveMessages`
swaps a structured marker for the human sentence next to it, which is how
PowerShell output becomes readable.

### Adding a toolchain

Record real output into `src/test/fixtures/`, add an expectation, add a matcher
if needed. The suite asserts every fixture has an expectation and every
expectation names a real fixture, so neither half can be forgotten. Fixtures
are marked `-text` in `.gitattributes` because escape bytes and CRLF are the
point.

## Ranking

Scores accumulate from evidence, then multipliers apply:

```
primary error         100      vendored path    x0.15
command argument       45      generated file   x0.40
parsed error         55..20    test file        x0.90
terminal mention       22
git changed        15 or 4     (15 only once something else implicated it)
diagnostics         see below
```

Diagnostics are the interesting case, because a workspace routinely has
hundreds of open warnings unrelated to the command that just failed. They are
weighted by *corroboration*:

- **corroborated** — the failure output names this file too: full weight
- **ambient** — nothing else implicated it: near-zero, and dropped entirely
  from the suspect list
- **sole** — there is no failure output at all, as in a diagnostics-spike
  capture: diagnostics become the primary signal

## Bounds

Failure output is attacker-influenced text and arrives inside the editor
process, so every stage is bounded: 2,000 characters per line and 5,000 lines
scanned before matching, a configurable character budget on terminal reads,
bounded quantifiers in every redaction pattern, and a 2 MB ceiling plus a
binary check before reading a file for context. `git` runs through `execFile`
with a fixed argument array, a 1.5 second timeout and a 1 MB output cap.

## Testing

| Suite | Count | Runtime | What it proves |
|---|---|---|---|
| Unit | 421 | ~0.3s | Every pure module, fixture-driven |
| Pipeline | included above | | A brief renders for all 23 recorded failures |
| Extension Host | 16 | ~8s | Activation, commands, settings, real file writes |

The pipeline suite is the one that catches integration regressions: it wires
the same stages `buildIncident` does and asserts on the finished markdown, so a
change that keeps every unit green but breaks the output still fails.

Two settings behaviours are asserted against the filesystem rather than mocked,
because they are security properties: a traversing `output.dir` must create
nothing outside the workspace, and `clipboardOnly` must write nothing at all.

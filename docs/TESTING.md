# Testing Faultix

Three ways to exercise it, fastest first.

## 1. The fast loop: `faultix-brief`

Runs a command and prints the brief the extension would produce, without
launching an editor. It calls the same `analyzeFailure` pipeline the extension
does — the only things it cannot supply are open editor diagnostics and the
workspace name.

```bash
npm run compile
npm run brief -- --cwd ../faultixTEST "python python/runtime_error.py"
```

```
> python python/runtime_error.py
  exit 1 in 63ms

# ZeroDivisionError: division by zero (python/runtime_error.py:6)
...
## Code context

**python/runtime_error.py**

```python
   4 |     data = {"count": 0}
   5 |     print("count:", data["count"])
>  6 |     return 10 / data["count"]
```
```

Options:

| Flag | Effect |
|---|---|
| `--prompt` | Print the agent prompt instead of the human brief |
| `--json` | Print the whole incident, including every matcher that fired |
| `--cwd <dir>` | Run the command somewhere else |
| `--save <name>` | Also write the raw output to `src/test/fixtures/<name>.txt` |
| `--no-redact` | Skip secret scrubbing (only on output you trust) |

`--json` is the one to reach for when extraction picks the wrong error: it
shows every record with its matcher name and confidence, so you can see which
matcher claimed the line.

`--save` is how new fixtures get recorded. Run the failing tool, save it, then
add an expectation in `src/test/suite/errorExtract.test.ts`.

## 2. The real thing: Extension Development Host

The CLI cannot test capture triggers, the side panel, or the notification
flow. For those, run the extension.

Press `F5` and pick **Run Faultix against a broken workspace**, which opens
`../faultixTEST` — a folder of intentionally broken files across ~15
languages. If you keep it elsewhere, use **Run Faultix** and open any folder.

### Checklist

Each row exercises a different path into the extension. Run the command in the
dev host's integrated terminal.

| # | What to do | What should happen |
|---|---|---|
| 1 | `python python/runtime_error.py` | Notification appears; brief names `ZeroDivisionError` at `runtime_error.py:6` |
| 2 | Open `.ai-repair/latest/incident.md` | Leads with the root cause, embeds the code with `>` on line 6 |
| 3 | Click a file under **Files to inspect** in the side panel | Opens that file at the failing line |
| 4 | Run the same command twice more | Brief says "Seen 3 times"; the count goes up by exactly one each run |
| 5 | `node node-js/broken_syntax.js` | New fingerprint, not a repeat of the Python one |
| 6 | `cmd /c scripts\bad.bat` | Terminal shows escape-code noise; the brief does not |
| 7 | **Terminal → Run Task** → any failing task | Captured with kind derived from the task name |
| 8 | Open `node-ts/tsconfig.invalid.json` and break more files | A diagnostics spike captures on its own after ~1.5s |
| 9 | **Faultix: Copy Agent Prompt**, paste somewhere | Starts `# Repair brief:`, ends with `## Your task` |
| 10 | **Faultix: Pause Automatic Capture**, run a failing command | Nothing is captured |
| 11 | Set `faultix.output.mode` to `clipboardOnly`, capture | No files written; copy commands still work |
| 12 | Set `faultix.output.dir` to `../escape`, capture | Nothing created outside the workspace; a warning in the Faultix output channel |

### What to look at when something is wrong

The **Faultix** output channel (View → Output → Faultix) logs every capture and
every failure. Captures are wrapped so a broken one can never take down your
terminal — it logs instead, which means a silent absence of briefs is usually
visible there.

## 3. Automated

```bash
npm run verify            # lint, typecheck, 421 unit tests (~1s)
npm run test:integration  # 16 tests in a real Extension Host (~10s)
npm run test:coverage     # enforces 90% statements on the analysis core
```

The unit suite includes a pipeline group that runs all 23 recorded failure
captures through `analyzeFailure` and asserts on the finished markdown, so it
catches regressions that per-module tests would miss.

The integration suite builds a throwaway workspace per run, and asserts two
security properties against the real filesystem rather than a mock: a
traversing `output.dir` creates nothing outside the workspace, and
`clipboardOnly` writes nothing at all.

# Faultix

Faultix is a local-first VS Code extension that turns build/test/runtime failures into compact, agent-ready repair briefs.

## MVP (v0.1)
- Auto-capture on failing terminal commands (shell integration)
- Auto-capture on failing VS Code Tasks (best effort)
- Fuse with Problems/Diagnostics + git context (best effort)
- Root-cause suspect ranking with reasons
- Fingerprint repeat tracking (count/first/last seen)
- Writes `.ai-repair/latest/incident.md`, `incident.json`, `repair.prompt.md`
- Native Tree View + commands

## Development

```bash
npm install
npm run compile
```

Press `F5` to launch the Extension Development Host.

## Tests

```bash
npm test
```

Runs fast unit tests (Mocha) without launching VS Code.

```bash
npm run test:integration
```

Runs the VS Code Extension Host test runner (can be sensitive to VS Code updates on Windows).

## Commands
- `Faultix: Create Repair Brief`
- `Faultix: Open Latest Incident`
- `Faultix: Copy Latest Brief`
- `Faultix: Rerun Latest Failing Command`

## Notes
Faultix is local-only by default: no network calls.

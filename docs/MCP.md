# Connecting Faultix to an agent

Faultix can expose a workspace's failure history over the
[Model Context Protocol](https://modelcontextprotocol.io), so a coding agent
can ask what broke instead of waiting for you to paste it.

## Why this exists

An agent that runs your commands already sees their output, so formatting a
failure for it adds little. What it *cannot* see is everything outside the run
it just performed:

- This failure has happened six times.
- You fixed it last Tuesday, by editing `src/db/pool.ts`.
- This test disagrees with itself at the same commit, so the failure may not be
  a fault in the code at all.

That is the memory an agent lacks and Faultix keeps.

## Setup

The extension writes what it knows into `.ai-repair/` in your workspace. The
MCP server reads those files. Nothing else is required.

### Easiest

Run **Faultix: Copy MCP Server Config** from the command palette. It puts a
ready-to-paste config on your clipboard, pointing at the installed copy of the
server, and can open a page with per-agent instructions.

### Claude Code

```bash
claude mcp add faultix -- node /path/to/faultix/out/mcp/server.js /path/to/your/project
```

### Config-file agents (Cursor, Windsurf, Claude Desktop)

```json
{
  "mcpServers": {
    "faultix": {
      "command": "node",
      "args": ["/path/to/faultix/out/mcp/server.js", "/path/to/your/project"]
    }
  }
}
```

The workspace path is optional; without it the server reads the directory it
was started in. Pass `--output-dir` if you changed `faultix.output.dir`.

### From a clone

```bash
git clone https://github.com/azyzex/faultix.git
cd faultix && npm install && npm run compile
node out/mcp/server.js /path/to/your/project
```

## What it exposes

| Tool | Answers |
|---|---|
| `faultix_latest_failure` | What just broke? Returns the full repair brief. |
| `faultix_search_failures` | Has this happened before? Searches past failures by error text, file or command. |
| `faultix_failure_history` | Was it ever fixed, and by changing what? |
| `faultix_flaky_commands` | Which commands disagree with themselves? |
| `faultix_command_stats` | Pass rates, and when each command last worked. |
| `faultix_recent_failures` | What has been going wrong lately? |

Every tool returns markdown rather than JSON: a model reads it directly, and a
sentence explaining what a number means is worth more than the number.

## Things worth knowing

**It is read-only.** The server opens the files Faultix wrote and does nothing
else. It runs no commands, modifies nothing, and makes no network calls. That
is deliberate — an agent asking "have I seen this before" should not be able to
change the answer.

**Fix correlation is a heuristic, and says so.** When a failure goes away, the
files reported are those being edited across the failing and passing runs. That
points at the right file far more often than not, but it cannot know which edit
mattered, and every answer that uses it says as much.

**It needs run recording.** `faultix.history.recordRuns` is on by default and
writes `.ai-repair/runs.json`. With `faultix.output.mode` set to
`clipboardOnly` nothing is written to the workspace, so the history tools have
nothing to read.

**Add `.ai-repair/` to `.gitignore`** unless you want the history shared. It
contains failure output from your machine — redacted, but still yours.

## Example

Asking Claude Code to fix a failing migration, with Faultix connected:

```
> the migration is failing again

I'll check what Faultix knows about this.

[faultix_latest_failure]
  ECONNREFUSED: could not connect to postgres (src/db/pool.ts:31), seen 3 times.

[faultix_failure_history]
  It was fixed 7 hours ago, after 2 attempts.
  Files being edited when it went away: src/db/pool.ts

Looking at src/db/pool.ts:31 — the pool is constructed before the
environment is loaded, so DATABASE_URL is undefined at connect time.
That matches the earlier fix.
```

The second call is the one that matters. Without it, the agent starts from
nothing every session.

## Protocol notes

Implemented directly rather than via the SDK, because MCP is JSON-RPC 2.0 over
newline-delimited stdio with a handful of methods, and Faultix ships no runtime
dependencies. Supported revisions are `2025-06-18` and `2024-11-05`; the server
echoes back a requested version it implements, and otherwise offers its newest.

`initialize`, `ping`, `tools/list` and `tools/call` are handled; notifications
are accepted and correctly not answered. A tool that throws is reported as a
tool-level error rather than a transport error, so the model can read it and try
something else. See `src/mcp/protocol.ts` and its tests.

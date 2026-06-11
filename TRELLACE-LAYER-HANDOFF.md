# Trellace Layer Handoff (feature/trellace-layer)

Branch: `feature/trellace-layer` (based on `main` @ fb9d529).
Built 2026-06-10. All work is committed to this branch only. Nothing touches `main`.

## What this branch adds

Three features, designed against `docs/team/claudian-settings-and-secrets.md`
sections 2-5, 11, 12, 13B/C, 14 (in the vault):

### 1. Trellace env injection (per session spawn)

At every session spawn, Claudian reads `~/.claude/remote-settings.json`
directly (gate-immune file read, see doc section 4) and merges ONLY variables
whose names start with `TRELLACE_` into the child session env.

- Injection point: `src/core/agent/QueryOptionsBuilder.ts`, in both the
  persistent and cold-start env blocks. Order: `process.env`, then TRELLACE_
  vars, then the user's environment-variables box, then the PATH override.
  An explicit env-box entry can still shadow an org-pushed value; nothing can
  shadow PATH.
- Non-prefixed variables are never injected. A plain `ANTHROPIC_API_KEY` in
  remote settings would otherwise silently flip team sessions to API billing
  (doc section 12 Q1).
- Silent no-op if the file is absent, unreadable, or malformed.
- Read fresh per spawn: a key rotation pushed by Chris reaches the next
  session without an Obsidian restart.
- Code: `src/core/trellace/trellaceEnv.ts`.

### 2. Trellace hook materialization (at plugin load)

At plugin load (Claudian code in `onload()`, NOT a hook, so it runs on
machines with zero hooks registered), Claudian reads the synced vault file
`args/claudian-hooks.yaml` and merges its hooks into the machine-local
`.claude/settings.json`. This is the cross-surface design from doc section
13C: settings.json is honored natively by Claudian, Claude Code desktop, and
the terminal, so one registration path covers all three surfaces.

- Code: `src/core/trellace/hookMaterializer.ts` (parse, substitute, merge),
  `src/core/trellace/TrellaceLayer.ts` (orchestration), wired in
  `src/main.ts` right after settings load.
- The merge touches only the `hooks` key. The `permissions` block (Claudian's
  own store) and every other key are preserved exactly. Claudian's own
  permission saves preserve unknown keys, so the two writers coexist.
- Dedup is by exact command string. If an identical command already exists in
  settings.json (hand-carried), it is adopted, not duplicated.
- Commands written by the layer are tracked in
  `.claude/trellace-hooks-state.json` (machine-local, unsynced dot path).
  When the yaml changes, stale layer-managed commands are removed and new
  ones added. Hooks a human added by hand are never removed.
- Idempotent: a second load with no changes writes nothing to settings.json.
- A corrupt settings.json is never overwritten (status `settings-unreadable`).
- The source yaml already exists in the vault; this branch only reads it.

#### Interpreter resolution strategy ({{PY}})

`src/core/trellace/pythonResolver.ts` resolves one absolute python path per
machine and substitutes it for `{{PY}}`, quoted, with backslashes converted
to forward slashes (hook commands execute under git-bash on Windows, where
backslashes are escape characters). Resolution order:

1. `TRELLACE_PYTHON` env override (process env or an org-pushed remote
   variable), used only if the path exists on disk. A bad override falls
   through to auto-detection instead of failing.
2. Windows: the py launcher (`%SystemRoot%\py.exe`, then bare `py`) asked for
   `sys.executable` of the default Python 3.
3. Windows: scan `%LOCALAPPDATA%\Programs\Python`, `%ProgramFiles%`,
   `%ProgramFiles(x86)%`, and `C:\` for `Python3*` directories containing
   `python.exe`; pick the highest version.
4. Windows: ask bare `python`, then `python3`, from the GUI PATH for
   `sys.executable`. This covers Microsoft Store Python (Chris's machine is
   exactly this case: Store Python 3.13, no py launcher, no classic install
   directories). A successful execution is the validation; the dead Store
   stub exits nonzero and falls through.
5. macOS/Linux: `/opt/homebrew/bin/python3`, `/usr/local/bin/python3`,
   `/usr/bin/python3`, then `command -v python3` via `/bin/sh`.

If nothing resolves, settings.json is left untouched. A command containing a
raw `{{PY}}` is never written. The status command reports `(python not found)`.

#### Stop-bridge accounting (important behavior change)

`ClaudianService` contained an inline Stop bridge that re-executed Stop hooks
from BOTH `.claude/settings.local.json` AND `.claude/settings.json`. The CLI
already executes settings.json Stop hooks natively (project tier loads under
Claudian, doc section 2), so any settings.json Stop hook double-fired per
Stop even before this branch. Once the layer materializes the memory hook
into settings.json, that double-fire would have become a guaranteed daily
event.

This branch extracts the bridge to `src/core/hooks/StopHookBridge.ts` and
restricts it to `settings.local.json` only (the tier SDK sessions never
load, which is the only reason the bridge exists). Side fix: the bridge's
`$CLAUDE_PROJECT_DIR` text substitution used an unescaped `$` in the regex
and never actually substituted; it now does, which also makes bridged
commands work under cmd.exe on Windows.

### 3. Status command (UI verification)

Obsidian command palette: "Claudian: Trellace layer status". Shows a Notice:

```
Trellace layer: env injected yes | hooks materialized 4
```

`env injected` is computed live from the remote-settings file (yes when at
least one TRELLACE_ variable is available for injection). `hooks
materialized N` is the count from the plugin-load materialization run.
Failure modes append a suffix: `(python not found)`,
`(args/claudian-hooks.yaml not found)`, `(source yaml malformed)`,
`(settings.json unreadable)`, `(materialization error)`.

## Files changed

| File | Change |
|---|---|
| `src/core/trellace/trellaceEnv.ts` | new: TRELLACE_ env reader |
| `src/core/trellace/pythonResolver.ts` | new: interpreter resolution |
| `src/core/trellace/hookMaterializer.ts` | new: yaml parse, {{PY}} substitution, settings.json merge |
| `src/core/trellace/TrellaceLayer.ts` | new: load-time orchestration + status line formatting |
| `src/core/trellace/index.ts` | new: barrel |
| `src/core/hooks/StopHookBridge.ts` | new: extracted Stop bridge, local tier only |
| `src/core/hooks/index.ts` | export the bridge |
| `src/core/agent/ClaudianService.ts` | use extracted bridge, remove inline copy |
| `src/core/agent/QueryOptionsBuilder.ts` | inject TRELLACE_ env in both builders |
| `src/main.ts` | run materializer at load, add status command |
| `tests/unit/core/trellace/*` (4 files) | new: 52 tests |
| `tests/unit/core/hooks/StopHookBridge.test.ts` | new: 9 tests |
| `tests/unit/core/agent/QueryOptionsBuilder.test.ts` | 5 new injection tests |
| `package-lock.json` | version field synced to package.json (1.3.69) |

## Verification done on this branch

- `npm run typecheck`: clean.
- `npm run lint`: clean.
- `npm run test`: 4540 passed, 25 failed in 6 suites (TabBar, utils/path,
  externalContext, sdkSession, utils/utils, AgentManager). The identical 25
  failures occur on pristine `main` on this machine (verified via
  `git archive main` into a clean directory). They are pre-existing
  Windows-environment failures, unrelated to this branch. All integration
  tests pass.
- `npm run build` (production): succeeds, main.js + styles.css produced.

Jest gotcha on this machine: jest cannot match test files when the repo
lives under the vault's `.tmp` folder (jest's glob normalization treats
`\.tmp` in the Windows path as an escaped dot and the testMatch pattern
never matches). Workaround used here, same spirit as the file-drop branch:
robocopy the working tree to a clean path and run there.

```powershell
robocopy "C:\Users\heyse\Documents\Trellace OS - Prototype\.tmp\claudian-inspect" `
  "$env:LOCALAPPDATA\claudian-trellace-test" /MIR /XD .git node_modules dist coverage
cd "$env:LOCALAPPDATA\claudian-trellace-test"; npm install; npm run test
```

The copies `$env:LOCALAPPDATA\claudian-trellace-test` and
`$env:LOCALAPPDATA\claudian-main-test` are scratch and can be deleted.

## Push, merge, and release steps (Chris)

Deployment mechanics, verified against the repo on 2026-06-11: BRAT installs
from GitHub RELEASES of TrellaceTeam/claudian, not from raw main.
`.github/workflows/release.yml` builds and attaches main.js, manifest.json,
and styles.css whenever a tag is pushed. BRAT updates a machine at Obsidian
startup only when the latest release's manifest version is GREATER than the
installed one (installed today: 1.3.74, equal to tag 1.3.74 = current main).
So "deploy" = merge to main + bump manifest.json + push a tag.

1. Test locally first (manual verification below) with the branch build.
   The local manifest.json says 1.3.74, equal to the latest release, so BRAT
   will NOT overwrite the hand-copied test build at startup.
2. Push the branch: `git push -u origin feature/trellace-layer`.
   PR is optional (Chris is the sole git user); a local merge is equivalent.
3. After verification passes: merge to main, bump `manifest.json` to 1.3.75
   in a commit on main (versions.json is historically not bumped), tag the
   commit `1.3.75`, push main and the tag. The release workflow does the
   rest. Confirm the release exists and carries the three files.
4. Team machines pick it up at their next Obsidian start (BRAT
   updateAtStartup is true). Then do the per-machine rollout step below.

## Manual Obsidian verification (before merging to main)

On Chris's machine with the branch build installed:

1. Restart Obsidian. Confirm Claudian loads normally (no error notice).
2. Command palette -> "Claudian: Trellace layer status". Expect:
   `Trellace layer: env injected yes | hooks materialized 4`
   (env `yes` assuming the remote-settings push from 2026-06-10 is cached on
   the machine; hooks `4` for the current yaml: SessionStart, Stop, 2x
   PreToolUse).
3. Open `{vault}/.claude/settings.json`. Confirm:
   - the `permissions` block is exactly what it was before,
   - a `hooks` block exists with the 4 commands, each with an absolute
     forward-slash python path in place of `{{PY}}`,
   - no duplicated entries (compare against any hand-carried hooks; identical
     commands must appear once).
4. Confirm `{vault}/.claude/trellace-hooks-state.json` exists and lists the
   4 managed commands and the resolved pythonPath.
5. In a Claudian chat, run a bash command:
   `echo $TRELLACE_ANTHROPIC_API_KEY | cut -c1-8` (or check any TRELLACE_
   var). Expect the injected value, proving env injection reached the
   session. Verify it also works with a provider snippet active (DeepSeek or
   Kimi): injection is a file read, the auth gate does not apply.
6. Send any message and let the response finish (Stop fires). Check
   `memory/logs/{user}/` heartbeat updates ONCE per response, not twice
   (no Stop double-fire).
7. Trigger the guardrail: ask Claudian to write a file into the vault root.
   Expect the guardrail hook to block or warn per identity, proving
   PreToolUse hooks fire from the materialized registration.
8. Restart Obsidian a second time. Re-run the status command (same numbers)
   and confirm `git -C {vault} status` shows no churn in settings.json
   (idempotence) if the vault were tracked; otherwise diff the file by eye.

If any step fails, do not merge. The branch is inert when the yaml is absent
or python is unresolved, so partial failures should be visible in the status
suffix first.

## Rollout note (after merge and verification)

Hand-carried hooks in `.claude/settings.json` get stripped only AFTER this
ships and is verified on each machine. Machine reality check (2026-06-11):
Chris's hand-carried commands use bare `python3`, which differs from the
materialized absolute-path commands, so both would register and double-fire
until the old entries are removed. Per machine:

1. Verify first: restart Obsidian after the BRAT update, run the status
   command, expect `hooks materialized 4`, and confirm the absolute-path
   hooks exist in `.claude/settings.json`.
2. Then, with Obsidian closed (back the file up first), delete the OLD
   entries whose commands contain bare `python3 hooks/`. Keep the
   materialized ones (absolute interpreter path). The state file does not
   own the old entries, so the materializer will not re-add them.
   On a machine being tested BEFORE the merge (Chris), it is cleaner to
   strip in the same Obsidian-closed window as installing the test build:
   the materializer recreates the full set at launch and no double-fire
   window ever exists.
3. Machines whose settings.json never had hooks (the Praetor case) need no
   strip; the materializer simply adds.
4. Team members have no terminal and Claudian guardrails block `.claude/`
   writes for team identities, so the strip on their machines is a Chris
   action (screen share or remote), one time. It is the last hand-carry.
5. The Stop-bridge change ships in the same build, so settings.json Stop
   hooks no longer double-execute under Claudian regardless.

Future hook changes: edit `args/claudian-hooks.yaml` in the vault, let
Obsidian Sync distribute it, and each machine re-materializes at its next
Obsidian start. No more per-machine hand-carry for hook registration.

## Known limitations / follow-ups

- The materializer runs once at plugin load. A yaml change synced mid-session
  applies at the next Obsidian start. Acceptable: hook registration changes
  are rare and the CLI reads settings.json per session anyway, so a manual
  re-run is only an Obsidian restart away.
- `statusMessage` in the yaml is passed through to settings.json untouched.
  Current Claude Code versions ignore unknown hook fields if unsupported.
- If a machine has no python anywhere, hooks stay unmaterialized and the
  status command says so. The session itself works normally (guardrails
  reduce to Claudian's built-in blocklist + vault fence, doc section 7).
- The env probe `TRELLACE_PROBE_LOCAL` in settings.local.json still reads
  False under Claudian (dead tier, doc section 9.7). Unchanged by design.

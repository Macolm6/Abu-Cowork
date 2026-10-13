# Conversation shutdown durability

Validated on 2026-10-14 using Windows 11 Pro 10.0.26200, Electron 43.1.1, Node 24.18.0 and Abu 0.51.0. The isolated host started from `origin/dev` at `3ec84a27`, incorporating the shutdown interfaces from PR #677. The paired private checkout started from `origin/main` at `608166a` and incorporated PR #49.

## Reproduction and cause

1. Start the actual Electron app and send a request that streams a partial reply.
2. Wait until the reply text is visibly rendered.
3. Click Stop and immediately quit the application.
4. Restart, open the conversation from the sidebar, and inspect the reply and task state.

On the initial host, the displayed reply was absent after restart. The ledger contained an empty assistant message and a user message still marked `running`; restart recovery marked that user message `failed`. The Stop action signals the sidecar and returns before its ordered abort acknowledgement and final transcript writes. Native quit did not wait for those operations or the message/index write queues.

The public client now registers the save coordinator for OSS and enterprise builds. Quit blocks new dispatches, awaits complete dispatch lifetimes, flushes buffered text, drains queued persistence, checkpoints histories modified in this process and flushes the index before native resources close. Each modification keeps a revision until both messages and index have saved; cancellation or failure retains it for retry. A history opened for viewing alone is left byte for byte unchanged. Recovery, import and undo-delete writes enter the same queue. Failed or cancelled preparation releases admission and keeps the page usable. A confirmed save remains valid when an updater destroys the window before `before-quit`.

## Executed checks

| Check | Result |
|---|---|
| Public `npm run verify`, `VITEST_MAX_WORKERS=2` | Exit 0; 1,043 files, 21,108 passed, 34 existing skips |
| Coverage | Statements 81.29%, branches 73.40%, functions 83.21%, lines 83.07%; original thresholds retained |
| `npm run build`, `npm run typecheck:enterprise`, `npm run electron:dev:check` | Exit 0 each |
| Writer / lifecycle / exit unit tests | 86 passed; native quit tests 10 passed in verify |
| OSS real Electron | Stop and immediate application quit; Stop and immediate native window close; settled Stop and quit; completed stream and immediate quit: 4 passed |
| Enterprise real Electron | Same 4 journeys passed with `ABU_BUILD_TARGET=enterprise` |
| Electron smoke | 5 passed |
| Paired private `npm run verify` | Exit 0; 34 infra checks; 50 files, 902 passed, 1 existing skip |
| Real Windows native helper | Exit 0; Calculator 30/30, Notepad UIA 30/30, keyboard, WGC, screenshot and window ownership checks passed |
| Independent review | `gpt-6-astra / xhigh`; no remaining confirmed finding |

Every exit journey restarts twice, opens sidebar history, checks the original visible reply, continues the task, and verifies that the next model request contains the earlier reply. The completed-stream ledger retained `completed` terminals for both turns. The sole model boundary is the repository's permitted loopback LLM service; renderer, sidecar, native Electron exit and filesystem persistence use production code.

The byte-preservation regression was reproduced locally with the existing real Electron read-error journey. Final OSS and enterprise runs each combined all four exit journeys and history read-error/retry/delete journeys: seven passed, one POSIX permission check skipped on Windows. Three additional unit cases use the real store, storage and writer with only the permitted native filesystem boundary replaced: recovery and both import formats first encounter failed append/atomic writes, then successful shutdown repairs the file and a fresh read retains the message and recovered terminal state.

The first full gate encountered three 5-second test timeouts. All 66 tests in those files passed in isolation; the complete gate then passed with two workers, retaining every test and the original timeout/coverage settings. Private canonical fixtures were extracted with `git archive` from workspace commit `9679af531a1e6c684257b5a68708972e123c65b9` and passed the unchanged SHA guard.

## Local evidence

Evidence is retained under the isolated host's `.agent/`: `baseline-electron-confirm.log`, `fixed-electron-final.log`, `enterprise-electron.log`, `verify-public-final.log`, `build-public.log`, `typecheck-enterprise.log`, `preflight.log`, `native-helper.log`, and `updater-destroyed-red.log` / `updater-destroyed-green.log`. Revision checks additionally retain `read-only-red.log`, `revision-electron.log`, `revision-repair-unit-final.log` and `verify-revision-final.log`. Isolated Electron profiles retain the actual ledgers. Private checks are in the sibling `.agent/verify-private-final.log`. Raw machine logs are kept locally.

Final build logs are `build-revision.log`, `typecheck-enterprise-revision.log`, `preflight-revision.log`; final Electron logs are `oss-revision-electron-final.log` and `enterprise-revision-electron-final.log`. An earlier enterprise run timed out while clicking the animated close-setting dropdown before any task was sent. Opening that same setting with real keyboard input resolved the harness failure; shutdown timing and assertions were retained.

## Conditions outside this validation

Installed macOS updates, macOS native helpers, Windows logout/system shutdown, forced process termination, power loss, physical-input takeover and production enterprise gateway credentials were not exercised. Updater window destruction is covered by the native boundary regression. Account ownership rule R02 remains pending separately.

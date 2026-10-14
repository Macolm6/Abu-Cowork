# Conversation shutdown durability

Validated on 2026-10-15 using Windows 11 Pro 10.0.26200, Electron 43.1.1, Node 24.18.0 and Abu 0.51.0. The isolated host integrates `dev` at `2aa9a4d202879e5d4dce4b94bc157005edba3879`. OSS and enterprise builds use the same public save coordinator.

## Reproduction and confirmed causes

1. Send a request in the real Electron application and wait for part of the reply to appear.
2. Press Stop and immediately quit the application or close its native window with the close action configured to quit.
3. Restart and open the conversation from the sidebar.

The baseline lost the displayed reply. Its ledger contained an empty assistant message and a user message still marked `running`; restart recovery marked that message `failed`. Stop signalled the sidecar before the ordered abort acknowledgement and final transcript writes had completed. Native quit did not await those operations or the message/index write queues.

Native save-failure tests also reproduced a Windows process that remained alive after its windows closed and Electron emitted `quit`. This occurred with the production main entry launched directly, using Chromium CDP and Windows UI Automation without a Node inspector connection. DbgEng recorded the main thread waiting in `UnregisterWaitEx` during `node::FreeEnvironment`, with another thread processing a UI Automation COM callback. Emitting the JavaScript `process.exit` event did not prove OS process termination.

## Implemented ordering

Quit stops running tasks, blocks new dispatches, awaits complete dispatch lifetimes, flushes buffered text, drains queued persistence, checkpoints modified histories and flushes the index. Each modification retains its revision until both messages and index are saved. Concurrent changes trigger another pass. Viewing a history alone preserves its bytes. Recovery, import and undo-delete writes use the same queue.

After five seconds a native dialog offers Keep waiting and Quit anyway. Successful saving closes that dialog. Save failure offers Retry, Cancel quit and Quit anyway. Retry acquires its barrier before releasing the previous attempt. Cancellation restores interaction and retains unsaved revisions. Only the explicit Quit anyway choice bypasses saving. Requests and responses are scoped to the current operation.

After saving or explicit forced exit, the host stops its registered child processes while Node's event loop is active and awaits their `close` events; PTY completion uses `onExit`. Registration retains older process generations until they close. MCP, sidecar, commands, native helpers, GUI helpers and Git processes participate. New resources are rejected during this phase. Repeated exit requests share its completion. Final Electron quit follows completion. Cancelling a prepared restart reopens admission, and genuine MCP close notifications allow the next task to reconnect.

Manual Stop keeps its existing meaning. App exit records the interruption cause `app_exit`. Update/restart entry points own their final operation; a confirmed save survives updater window destruction.

## Executed checks

Build, enterprise typecheck and OSS/enterprise `electron:dev:check` each exited 0 on the integrated sources. OSS and enterprise real Electron runs each passed 21 tests with one Windows-inapplicable POSIX permission case skipped. This includes smoke, exit/history/continuation, native dialogs and the latest-reply search regression.

Public `npm run verify` exited 0: 1,046 test files, 21,203 passed and 34 existing skips. Coverage passed the unchanged thresholds: statements 81.25%, branches 73.40%, functions 83.13%, lines 83.04%. The full gate includes lint, typecheck, generated-file checks, native host/quit tests, inventory verification and the coverage suite; `VITEST_MAX_WORKERS=2`.

- Native Windows scenarios repeated three times: 15 passed. These cover cancelling a prepared restart and sending another task, delayed renderer saving, retry after a real filesystem failure, cancel and force.
- Direct production-main launch without a Node inspector: eight consecutive native force-exit runs passed with full-window UI Automation traversal.
- Related process-owner and exit-controller Node tests: 97 passed, three existing platform skips; exit 0.
- Real Windows native helper: exit 0; Calculator 30/30, Notepad UIA 30/30, keyboard input, WGC and window ownership checks passed. The first invocation was refused by Windows during Calculator activation; the unchanged standalone command passed on recheck.
- Independent review: `gpt-6-astra / xhigh`, no remaining confirmed blocking finding.

The four conversation journeys cover immediate Stop/quit, immediate Stop/window-close, settled Stop/quit and completed-stream/quit. Each restarts twice, checks sidebar history, sends another task and checks that the model request includes the earlier reply. The completed-stream journey checks `completed` terminals. The permitted loopback LLM is the network boundary; renderer, sidecar, Electron exit and filesystem persistence execute production code.

Native failure tests replace the actual index path with a directory, use Windows UI Automation to read the dialog and physical pointer input to choose an action. The wait test pauses the renderer through CDP, verifies the native waiting choice, resumes saving and awaits actual application closure. The cancelled-restart case executes the host's prepare/cancel methods and sends a real next task through the restarted sidecar.

## Evidence

The isolated checkout retains `.agent/` logs and Electron profiles with actual ledgers:

- Original reply-loss reproduction: `baseline-electron-confirm.log`.
- Windows native process diagnosis: `no-inspector-full.log`, `no-inspector-native-waits.log`; passing direct-launch runs: `no-inspector-drained.log`.
- Repeated native interaction checks: `runtime-drained-e2e.log` and `runtime-drained-e2e-results/`.
- Process ownership checks: `owned-runtime-check-final.log`; exit completion regressions: `runtime-drain-red.log` and `runtime-drain-green.log`.
- Final serial gates: `validation-progress.log`, `build-c01-final.log`, `typecheck-enterprise-c01-final.log`, `preflight-c01-final.log`, `preflight-enterprise-c01-final.log`, `oss-c01-final.log`, `enterprise-c01-final.log`, `native-helper-c01-recheck.log` and `verify-c01-final.log`.

Raw machine logs remain local. Test reports attach native dialog text and retain traces on failure.

## Conditions outside this validation

Installed macOS updates, macOS native helpers, Windows logout/system shutdown, forced process termination, power loss, physical-input takeover and production enterprise gateway credentials were not exercised. Updater window destruction has a native boundary regression. Cancellation after preparation has a real Electron continuation test; an installed updater failure was not exercised. Conversation ownership rule R02 remains pending separately.

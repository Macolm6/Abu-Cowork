use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::{json, Value};

// Writes `requests` to a fresh helper, closes its stdin, and returns every
// response line in order (event lines left out).
fn replies_after_stdin_closes(requests: &[Value], run: usize) -> Vec<Value> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_native-helper"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn native-helper");
    let mut stdin = child.stdin.take().expect("helper stdin");
    for request in requests {
        writeln!(stdin, "{request}").expect("write request");
    }
    drop(stdin);
    let output = child.wait_with_output().expect("wait for native-helper");
    assert!(output.status.success(), "run {run}: helper exited with {}", output.status);
    String::from_utf8(output.stdout)
        .expect("utf-8 stdout")
        .lines()
        .map(|line| serde_json::from_str(line).expect("response line is JSON"))
        .filter(|message: &Value| message.get("event").is_none())
        .collect()
}

// A host may write its requests and then close stdin. Every request read
// before that close still gets its response line. The reader thread sees the
// close while the main thread is picking up the queued request, so one run
// alone does not show a dropped reply; repeated runs do.
#[test]
fn answers_every_request_written_before_stdin_closes() {
    let requests = [
        json!({ "id": 1, "method": "ping", "params": {} }),
        json!({ "id": 2, "method": "hello", "params": {} }),
    ];
    for run in 0..200 {
        let responses = replies_after_stdin_closes(&requests, run);
        assert_eq!(responses.len(), 2, "run {run}: responses {responses:?}");
        assert_eq!(responses[0]["id"], 1, "run {run}: responses {responses:?}");
        assert_eq!(responses[0]["result"]["pong"], true, "run {run}: responses {responses:?}");
        assert_eq!(responses[1]["id"], 2, "run {run}: responses {responses:?}");
        assert!(responses[1]["result"]["binary_version"].is_string(), "run {run}: responses {responses:?}");
    }
}

// Closing stdin cancels every file session, so a file operation the main
// thread reaches after that point is refused. An operation it reached before
// the cancellation has already run, and thread timing decides which side of
// that point each request falls on, so each run accepts either outcome and
// the runs together must show the refusal.
#[test]
fn refuses_file_operations_reached_after_stdin_closes() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let target = json!({ "path": path, "purpose": "read", "followFinalSymlink": true });
    let requests = [
        json!({ "id": 1, "method": "file_operation",
            "params": { "action": "open", "session": "1", "targets": [target] } }),
        json!({ "id": 2, "method": "file_operation",
            "params": { "action": "observe", "session": "1", "path": path, "purpose": "read", "followFinalSymlink": true } }),
    ];
    let mut observe_refusals = 0;
    for run in 0..200 {
        let responses = replies_after_stdin_closes(&requests, run);
        assert_eq!(responses.len(), 2, "run {run}: responses {responses:?}");
        for (index, response) in responses.iter().enumerate() {
            assert_eq!(response["id"], index + 1, "run {run}: responses {responses:?}");
            assert!(
                response.get("result").is_some() || response["error"]["code"] == "file-operation-refused",
                "run {run}: responses {responses:?}"
            );
        }
        if responses[0].get("error").is_some() {
            assert!(responses[1].get("error").is_some(), "run {run}: responses {responses:?}");
        }
        if responses[1].get("error").is_some() {
            observe_refusals += 1;
        }
    }
    assert!(observe_refusals > 0, "observe ran in all 200 runs after stdin closed");
}

use std::io::Write;
use std::process::{Command, Stdio};

use serde_json::Value;

// A host may write its requests and then close stdin. Every request read
// before that close still gets its response line. The reader thread sees the
// close while the main thread is picking up the queued request, so one run
// alone does not show a dropped reply; repeated runs do.
#[test]
fn answers_every_request_written_before_stdin_closes() {
    for run in 0..200 {
        let mut child = Command::new(env!("CARGO_BIN_EXE_native-helper"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn native-helper");
        let mut stdin = child.stdin.take().expect("helper stdin");
        stdin
            .write_all(b"{\"id\":1,\"method\":\"ping\",\"params\":{}}\n{\"id\":2,\"method\":\"hello\",\"params\":{}}\n")
            .expect("write requests");
        drop(stdin);
        let output = child.wait_with_output().expect("wait for native-helper");
        assert!(output.status.success(), "run {run}: helper exited with {}", output.status);
        let responses: Vec<Value> = String::from_utf8(output.stdout)
            .expect("utf-8 stdout")
            .lines()
            .map(|line| serde_json::from_str(line).expect("response line is JSON"))
            .filter(|message: &Value| message.get("event").is_none())
            .collect();
        assert_eq!(responses.len(), 2, "run {run}: responses {responses:?}");
        assert_eq!(responses[0]["id"], 1, "run {run}: responses {responses:?}");
        assert_eq!(responses[0]["result"]["pong"], true, "run {run}: responses {responses:?}");
        assert_eq!(responses[1]["id"], 2, "run {run}: responses {responses:?}");
        assert!(responses[1]["result"]["binary_version"].is_string(), "run {run}: responses {responses:?}");
    }
}

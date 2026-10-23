// SPDX-License-Identifier: GPL-3.0-or-later

//! `isled --agent-hook claude|codex`: run by the AI itself, it turns what the AI hands its hooks into an
//! event for the running isled. Quick and silent, and it never fails: a hook must not get in the AI's way.

use std::io::Read;
use std::path::Path;
use std::time::Duration;

use serde_json::Value;
use zbus::proxy::{CacheProperties, MethodFlags};

use super::Event;

/// All the hook may take, connecting included.
const TIMEOUT: Duration = Duration::from_secs(1);
/// Claude Code's payload is small; more than this is not read.
const MAX_INPUT: u64 = 1024 * 1024;

/// `args` are what follows `--agent-hook`: the AI, then (Codex) its JSON as the last.
pub async fn run(args: &[String]) {
    let event = match args.first().map(String::as_str) {
        Some("claude") => {
            let mut input = Vec::new();
            let _ = std::io::stdin().take(MAX_INPUT).read_to_end(&mut input);
            serde_json::from_slice(&input)
                .ok()
                .and_then(|payload| from_claude(&payload))
        }
        Some("codex") => args
            .get(1..)
            .and_then(<[String]>::last)
            .and_then(|json| serde_json::from_str(json).ok())
            .and_then(|payload| from_codex(&payload)),
        _ => None,
    };
    if let Some(event) = event {
        let _ = tokio::time::timeout(TIMEOUT, send(&event)).await;
    }
}

/// Never starts isled: when it is not running there is no island to tell.
async fn send(event: &Event) -> zbus::Result<()> {
    let bus = zbus::Connection::session().await?;
    let proxy: zbus::Proxy = zbus::proxy::Builder::new(&bus)
        .destination(crate::BUS_NAME)?
        .path(crate::OBJECT_PATH)?
        .interface("io.github.zickrian.isle.Agents1")?
        .cache_properties(CacheProperties::No)
        .build()
        .await?;
    let json = serde_json::to_string(event).unwrap_or_default();
    proxy
        .call_with_flags::<_, _, ()>("Report", MethodFlags::NoAutoStart.into(), &(json,))
        .await?;
    Ok(())
}

/// Claude Code's `Notification` (needs a permission, or waits for the user) and `Stop` (done).
fn from_claude(payload: &Value) -> Option<Event> {
    let text = |key: &str| payload[key].as_str().unwrap_or_default();
    let (kind, message) = match text("hook_event_name") {
        "Notification" => (
            notification_kind(text("notification_type"), text("message"))?,
            text("message"),
        ),
        "Stop" => ("done", first_line(text("last_assistant_message"))),
        _ => return None,
    };
    event("claude", kind, text("cwd"), message, text("session_id"))
}

fn notification_kind(kind: &str, message: &str) -> Option<&'static str> {
    match kind {
        "permission_prompt" => Some("permission"),
        "idle_prompt" | "elicitation_dialog" => Some("waiting"),
        // Signed in again: nothing to do.
        "auth_success" => None,
        // Older Claude Codes send only the message.
        _ if message.to_lowercase().contains("permission") => Some("permission"),
        _ => Some("waiting"),
    }
}

/// Codex's `agent-turn-complete`.
fn from_codex(payload: &Value) -> Option<Event> {
    let text = |key: &str| payload[key].as_str().unwrap_or_default();
    if text("type") != "agent-turn-complete" {
        return None;
    }
    let session = [text("thread-id"), text("turn-id")]
        .into_iter()
        .find(|id| !id.is_empty())
        .unwrap_or_default();
    let message = first_line(text("last-assistant-message"));
    event("codex", "done", text("cwd"), message, session)
}

fn first_line(text: &str) -> &str {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default()
}

/// The folder the AI works in: the payload's, else the hook's own (the AI starts it there).
fn event(provider: &str, kind: &str, cwd: &str, message: &str, session: &str) -> Option<Event> {
    let cwd = if cwd.is_empty() {
        std::env::current_dir()
            .map(|dir| dir.to_string_lossy().into_owned())
            .unwrap_or_default()
    } else {
        cwd.to_owned()
    };
    let project = Path::new(&cwd)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    Event {
        provider: provider.into(),
        kind: kind.into(),
        project,
        cwd,
        message: message.into(),
        session: session.into(),
    }
    .checked()
    .ok()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn claude_permission_and_waiting() {
        let permission = from_claude(&json!({
            "session_id": "8a7c",
            "transcript_path": "/home/a/.claude/projects/x.jsonl",
            "cwd": "/home/a/code/isle",
            "hook_event_name": "Notification",
            "message": "Claude needs your permission to use Bash"
        }))
        .unwrap();
        assert_eq!(
            permission,
            Event {
                provider: "claude".into(),
                kind: "permission".into(),
                project: "isle".into(),
                cwd: "/home/a/code/isle".into(),
                message: "Claude needs your permission to use Bash".into(),
                session: "8a7c".into(),
            }
        );
        let waiting = from_claude(&json!({
            "cwd": "/home/a/code/isle",
            "hook_event_name": "Notification",
            "message": "Claude is waiting for your input"
        }))
        .unwrap();
        assert_eq!(waiting.kind, "waiting");
        let typed = from_claude(&json!({
            "cwd": "/w",
            "hook_event_name": "Notification",
            "notification_type": "permission_prompt",
            "message": "Claude needs your approval"
        }))
        .unwrap();
        assert_eq!(typed.kind, "permission");
        assert!(
            from_claude(
                &json!({"hook_event_name": "Notification", "notification_type": "auth_success"})
            )
            .is_none()
        );
    }

    #[test]
    fn claude_stopping_is_done() {
        let done = from_claude(&json!({
            "session_id": "8a7c",
            "cwd": "/home/a/code/isle",
            "hook_event_name": "Stop",
            "stop_hook_active": false
        }))
        .unwrap();
        assert_eq!((done.kind.as_str(), done.message.as_str()), ("done", ""));
        let summed_up = from_claude(&json!({
            "cwd": "/home/a/code/isle",
            "hook_event_name": "Stop",
            "last_assistant_message": "\nFixed the build.\n\nDetails follow…"
        }))
        .unwrap();
        assert_eq!(summed_up.message, "Fixed the build.");
        assert!(from_claude(&json!({"hook_event_name": "PreToolUse"})).is_none());
        assert!(from_claude(&json!([1, 2])).is_none());
    }

    #[test]
    fn codex_turns_are_done() {
        let done = from_codex(&json!({
            "type": "agent-turn-complete",
            "thread-id": "0199a",
            "turn-id": "12",
            "cwd": "/home/a/code/site",
            "input-messages": ["fix the header"],
            "last-assistant-message": "  Fixed the header's height.  \nAlso tidied the CSS."
        }))
        .unwrap();
        assert_eq!(
            done,
            Event {
                provider: "codex".into(),
                kind: "done".into(),
                project: "site".into(),
                cwd: "/home/a/code/site".into(),
                message: "Fixed the header's height.".into(),
                session: "0199a".into(),
            }
        );
        let turn_only =
            from_codex(&json!({"type": "agent-turn-complete", "turn-id": "12", "cwd": "/w"}));
        assert_eq!(turn_only.unwrap().session, "12");
        assert!(from_codex(&json!({"type": "something-else"})).is_none());
    }
}

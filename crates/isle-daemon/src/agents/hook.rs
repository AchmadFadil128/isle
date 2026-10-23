// SPDX-License-Identifier: GPL-3.0-or-later

//! `isled --agent-hook claude|codex`: run by the AI itself, it turns what the AI hands its hooks into an
//! event for the running isled, or (a permission) asks the island and prints the user's answer for the AI.
//! It never fails: when there is no answer (no isled, no reply in time) it prints nothing, and the AI asks
//! in its own terminal as it would without Isle.

use std::io::Read;
use std::path::Path;
use std::time::Duration;

use serde_json::Value;
use zbus::proxy::{CacheProperties, MethodFlags};

use super::{Event, Request};

/// All the hook may take, connecting included.
const TIMEOUT: Duration = Duration::from_secs(1);
/// A permission waits this long for the island at most (the AIs give the hook ten minutes).
const ANSWER: Duration = Duration::from_secs(9 * 60 + 40);
/// Claude Code's payload is small; more than this is not read.
const MAX_INPUT: u64 = 1024 * 1024;

/// `args` are what follows `--agent-hook`: the AI, then (Codex) its JSON as the last.
pub async fn run(args: &[String]) {
    let ai = args.first().map(String::as_str);
    // Codex's old `notify` passes its JSON as the last argument; hooks pass theirs on stdin.
    let payload: Option<Value> = match args.get(1..).and_then(<[String]>::last) {
        Some(json) if ai == Some("codex") => serde_json::from_str(json).ok(),
        _ => {
            let mut input = Vec::new();
            let _ = std::io::stdin().take(MAX_INPUT).read_to_end(&mut input);
            serde_json::from_slice(&input).ok()
        }
    };
    let Some(payload) = payload else { return };
    if payload["hook_event_name"] == "PermissionRequest" {
        let Some(request) = request(ai.unwrap_or_default(), &payload) else {
            return;
        };
        let answer = tokio::time::timeout(ANSWER, decide(&request)).await;
        if let Ok(Ok(answer)) = answer
            && let Some(output) = decision(ai.unwrap_or_default(), &answer, &payload)
        {
            println!("{output}");
        }
        return;
    }
    let event = match ai {
        Some("claude") => from_claude(&payload),
        Some("codex") => from_codex(&payload).or_else(|| from_codex_hook(&payload)),
        _ => None,
    };
    if let Some(event) = event {
        let _ = tokio::time::timeout(TIMEOUT, send(&event)).await;
    }
}

/// What the island shows of a permission: the tool, and what it would run or touch.
fn request(ai: &str, payload: &Value) -> Option<Request> {
    if !matches!(ai, "claude" | "codex") {
        return None;
    }
    let text = |key: &str| payload[key].as_str().unwrap_or_default();
    let input = &payload["tool_input"];
    let line = ["command", "file_path", "path", "url", "pattern", "query"]
        .iter()
        .find_map(|key| input[key].as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            if input.is_null() {
                String::new()
            } else {
                input.to_string()
            }
        });
    let cwd = if text("cwd").is_empty() {
        std::env::current_dir()
            .map(|dir| dir.to_string_lossy().into_owned())
            .unwrap_or_default()
    } else {
        text("cwd").to_owned()
    };
    Some(Request {
        provider: ai.into(),
        cwd,
        session: text("session_id").into(),
        tool: text("tool_name").into(),
        input: line,
        always: payload["permission_suggestions"]
            .as_array()
            .is_some_and(|s| !s.is_empty()),
        ..Request::default()
    })
}

/// Asks the island and waits; "" for no answer. Never starts isled.
async fn decide(request: &Request) -> zbus::Result<String> {
    let bus = zbus::conn::Builder::session()?
        .method_timeout(ANSWER)
        .build()
        .await?;
    let proxy: zbus::Proxy = zbus::proxy::Builder::new(&bus)
        .destination(crate::BUS_NAME)?
        .path(crate::OBJECT_PATH)?
        .interface("io.github.zickrian.isle.Agents1")?
        .cache_properties(CacheProperties::No)
        .build()
        .await?;
    let json = serde_json::to_string(request).unwrap_or_default();
    proxy
        .call_with_flags::<_, _, String>("Decide", MethodFlags::NoAutoStart.into(), &(json,))
        .await?
        .ok_or_else(|| zbus::Error::Failure("no answer".into()))
}

/// The user's answer as the AI's hook output, or none (no answer: the AI asks itself). "always" keeps
/// the rule Claude itself suggested, where it suggested it.
fn decision(ai: &str, answer: &str, payload: &Value) -> Option<String> {
    let decision = match answer {
        "allow" => serde_json::json!({"behavior": "allow"}),
        "always" if ai == "claude" => {
            serde_json::json!({"behavior": "allow", "updatedPermissions": payload["permission_suggestions"]})
        }
        "always" => serde_json::json!({"behavior": "allow"}),
        "deny" => {
            serde_json::json!({"behavior": "deny", "message": "The user denied this from Isle."})
        }
        _ => return None,
    };
    Some(serde_json::json!({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": decision}}).to_string())
}

/// Codex's `Stop` hook: its turn is done.
fn from_codex_hook(payload: &Value) -> Option<Event> {
    let text = |key: &str| payload[key].as_str().unwrap_or_default();
    if text("hook_event_name") != "Stop" {
        return None;
    }
    let session = [text("session_id"), text("turn_id")]
        .into_iter()
        .find(|id| !id.is_empty())
        .unwrap_or_default();
    event(
        "codex",
        "done",
        text("cwd"),
        first_line(text("last_assistant_message")),
        session,
    )
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
        "Notification" => {
            let kind = notification_kind(text("notification_type"), text("message"))?;
            // Asked through PermissionRequest already (see `decide`): no second alert for it.
            if kind == "permission" {
                return None;
            }
            (kind, text("message"))
        }
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
        }));
        // The permission itself comes through PermissionRequest; its notification is not shown again.
        assert!(permission.is_none());
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
        }));
        assert!(typed.is_none());
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
    fn a_permission_is_asked_and_answered_as_each_ai_wants() {
        let claude = json!({
            "hook_event_name": "PermissionRequest", "session_id": "s1", "cwd": "/home/a/korus",
            "tool_name": "Bash", "tool_input": {"command": "git push origin main", "description": "Push"},
            "permission_suggestions": [{"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "git push:*"}],
                "behavior": "allow", "destination": "localSettings"}]
        });
        let asked = request("claude", &claude).unwrap();
        assert_eq!(
            (asked.tool.as_str(), asked.input.as_str(), asked.always),
            ("Bash", "git push origin main", true)
        );
        let allow: Value =
            serde_json::from_str(&decision("claude", "allow", &claude).unwrap()).unwrap();
        assert_eq!(
            allow["hookSpecificOutput"]["hookEventName"],
            "PermissionRequest"
        );
        assert_eq!(
            allow["hookSpecificOutput"]["decision"],
            json!({"behavior": "allow"})
        );
        let always: Value =
            serde_json::from_str(&decision("claude", "always", &claude).unwrap()).unwrap();
        assert_eq!(
            always["hookSpecificOutput"]["decision"]["updatedPermissions"],
            claude["permission_suggestions"]
        );
        let deny: Value =
            serde_json::from_str(&decision("codex", "deny", &claude).unwrap()).unwrap();
        assert_eq!(deny["hookSpecificOutput"]["decision"]["behavior"], "deny");
        // No answer: nothing printed, the AI asks in its terminal.
        assert!(decision("claude", "", &claude).is_none());
        let edit = json!({"hook_event_name": "PermissionRequest", "tool_name": "apply_patch",
            "tool_input": {"command": "*** Begin Patch"}, "cwd": "/w"});
        let asked = request("codex", &edit).unwrap();
        assert!(!asked.always && asked.input == "*** Begin Patch");
        assert!(request("agy", &edit).is_none());
    }

    #[test]
    fn codex_stop_hook_is_done() {
        let done = from_codex_hook(
            &json!({"hook_event_name": "Stop", "session_id": "t1", "cwd": "/home/a/site",
            "last_assistant_message": "All tests pass.\nMore."}),
        )
        .unwrap();
        assert_eq!(
            (
                done.kind.as_str(),
                done.message.as_str(),
                done.project.as_str()
            ),
            ("done", "All tests pass.", "site")
        );
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

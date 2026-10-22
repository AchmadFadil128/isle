// SPDX-License-Identifier: GPL-3.0-or-later

//! Claude Code (`claude`) in stream-json print mode, with the user's own sign-in: one process per
//! conversation, kept to the web tools, without the user's settings, hooks, memory or MCP servers.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use anyhow::{Context, bail};
use chrono::{DateTime, Local, NaiveDate};
use serde::Deserialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc::UnboundedSender;

use super::answer::{Answer, SCHEMA};
use super::child::{self, Group};

/// Claude Code's own coding-agent prompt is replaced by this; the job comes with the first request.
const SYSTEM: &str = "You are Isle, a voice assistant on the user's Linux desktop, not a coding agent. Follow \
     the instructions in the user's messages and answer only in the JSON they describe.";
/// The tools it may use: the web, nothing on this computer.
const TOOLS: &str = "WebSearch,WebFetch";
const STDERR_LINES: usize = 20;

pub struct Claude {
    _child: Group,
    stdin: ChildStdin,
    events: Lines<BufReader<ChildStdout>>,
    stderr: Arc<Mutex<VecDeque<String>>>,
    pub conversation: Option<String>,
}

impl Claude {
    pub fn start(
        program: &Path,
        model: &str,
        resume: Option<&str>,
        workspace: &Path,
    ) -> anyhow::Result<Self> {
        std::fs::create_dir_all(workspace)?;
        let mut command = Command::new(program);
        command
            .args([
                "-p",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
            ])
            .args(["--tools", TOOLS, "--allowedTools", TOOLS])
            // None of the user's settings, hooks, CLAUDE.md or MCP servers: only its sign-in.
            .args(["--setting-sources", "", "--strict-mcp-config"])
            .args(["--system-prompt", SYSTEM, "--json-schema", SCHEMA]);
        if !model.is_empty() {
            command.args(["--model", model]);
        }
        if let Some(id) = resume {
            command.args(["--resume", id]);
        }
        command
            .current_dir(workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = child::spawn(&mut command)
            .context("could not start claude; is Claude Code installed?")?;
        let stdin = child.stdin.take().expect("piped stdin");
        let events = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
        let stderr = Arc::new(Mutex::new(VecDeque::new()));
        let mut lines = BufReader::new(child.stderr.take().expect("piped stderr")).lines();
        let kept = stderr.clone();
        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                let mut kept = kept.lock().unwrap();
                if kept.len() == STDERR_LINES {
                    kept.pop_front();
                }
                kept.push_back(line);
            }
        });
        Ok(Self {
            _child: child,
            stdin,
            events,
            stderr,
            conversation: resume.map(str::to_owned),
        })
    }

    pub async fn ask(
        &mut self,
        prompt: &str,
        activity: Option<&UnboundedSender<String>>,
    ) -> anyhow::Result<Answer> {
        self.stderr.lock().unwrap().clear();
        self.turn(prompt, activity).await.map_err(|err| {
            let stderr = Vec::from(self.stderr.lock().unwrap().clone()).join(" | ");
            if stderr.is_empty() {
                err
            } else {
                err.context(stderr)
            }
        })
    }

    async fn turn(
        &mut self,
        prompt: &str,
        activity: Option<&UnboundedSender<String>>,
    ) -> anyhow::Result<Answer> {
        let message =
            serde_json::json!({"type": "user", "message": {"role": "user", "content": prompt}});
        // Claude Code that quit at once (signed out) still left its reason on stdout: read it then.
        let sent = self
            .stdin
            .write_all(format!("{message}\n").as_bytes())
            .await;
        while let Some(line) = self.events.next_line().await? {
            let Ok(event) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if let Some(id) = event["session_id"].as_str() {
                self.conversation = Some(id.to_owned());
            }
            match event["type"].as_str() {
                Some("result") => return parse_result(&event),
                Some("assistant") => {
                    if let Some(activity) = activity {
                        steps(&event).into_iter().for_each(|step| {
                            activity.send(step).ok();
                        });
                    }
                }
                _ => {}
            }
        }
        sent.context("claude stopped")?;
        bail!("claude stopped")
    }
}

/// What Claude starts doing in a message, for the island: its web searches and the pages it reads.
fn steps(event: &Value) -> Vec<String> {
    let Some(content) = event["message"]["content"].as_array() else {
        return Vec::new();
    };
    content
        .iter()
        .filter(|part| part["type"] == "tool_use")
        .filter_map(|tool| match tool["name"].as_str()? {
            "WebSearch" => Some(match tool["input"]["query"].as_str() {
                Some(query) => format!("Searching the web for “{query}”…"),
                None => "Searching the web…".into(),
            }),
            "WebFetch" => {
                let url = tool["input"]["url"].as_str().unwrap_or_default();
                let host = url
                    .split("://")
                    .nth(1)
                    .and_then(|rest| rest.split('/').next());
                Some(format!("Reading {}…", host.unwrap_or("a page")))
            }
            _ => None,
        })
        .collect()
}

fn parse_result(event: &Value) -> anyhow::Result<Answer> {
    if event["is_error"].as_bool() == Some(true) || event["subtype"] != "success" {
        let reason = event["result"]
            .as_str()
            .or(event["error"].as_str())
            .unwrap_or("claude failed")
            .to_owned();
        bail!("{reason}");
    }
    if let Ok(answer) = Answer::deserialize(&event["structured_output"]) {
        return Ok(answer);
    }
    Ok(super::answer::from_text(
        event["result"].as_str().unwrap_or_default(),
    ))
}

/// Where Claude Code keeps the conversations it had in Isle's workspace (and only those).
fn store() -> Option<PathBuf> {
    let workspace = crate::store::data_dir().join("assistant");
    // Claude Code names a project's folder after its path, every character but letters and digits a dash.
    let name: String = workspace
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    Some(dirs::home_dir()?.join(".claude/projects").join(name))
}

/// Deletes Isle's Claude conversation `id` now.
#[cfg(test)]
pub fn forget(id: &str) {
    if let Some(dir) = store() {
        std::fs::remove_file(dir.join(format!("{id}.jsonl"))).ok();
    }
}

/// Deletes Isle's Claude conversations last changed before `today`.
pub fn prune(today: NaiveDate) {
    let Some(entries) = store().and_then(|dir| std::fs::read_dir(dir).ok()) else {
        return;
    };
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .is_ok_and(|time| DateTime::<Local>::from(time).date_naive() < today);
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if !old || kind.is_symlink() {
            continue;
        }
        // A conversation is `<id>.jsonl`, and a `<id>/` folder beside it for what its tools kept.
        if kind.is_dir() {
            std::fs::remove_dir_all(entry.path()).ok();
        } else if entry.path().extension().is_some_and(|e| e == "jsonl") {
            std::fs::remove_file(entry.path()).ok();
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn reads_claudes_answer_and_steps() {
        let done = json!({"type": "result", "subtype": "success", "is_error": false, "result": "{}",
            "structured_output": {"say": "Oke, aku bukain YouTube.", "actions": [{"type": "open_url", "url": "https://youtube.com"}]}});
        let answer = parse_result(&done).unwrap();
        assert_eq!(
            (answer.say.as_str(), answer.actions.len()),
            ("Oke, aku bukain YouTube.", 1)
        );
        let signed_out = json!({"type": "result", "subtype": "success", "is_error": true, "result": "Invalid API key · Please run /login"});
        assert!(
            parse_result(&signed_out)
                .unwrap_err()
                .to_string()
                .contains("/login")
        );
        let search = json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "x"},
            {"type": "tool_use", "name": "WebSearch", "input": {"query": "cuaca jakarta"}}]}});
        assert_eq!(steps(&search), ["Searching the web for “cuaca jakarta”…"]);
    }

    #[test]
    fn keeps_to_isles_own_conversations() {
        let dir = store().unwrap();
        assert!(dir.starts_with(dirs::home_dir().unwrap().join(".claude/projects")));
        // Named after Isle's own workspace, wherever its data folder is (XDG_DATA_HOME moves it).
        let workspace = crate::store::data_dir().join("assistant");
        assert!(
            dir.to_string_lossy()
                .ends_with(&*workspace.to_string_lossy().replace(['/', '.'], "-")),
            "{}",
            dir.display()
        );
    }
}

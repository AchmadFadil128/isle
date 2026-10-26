// SPDX-License-Identifier: GPL-3.0-or-later

//! Grok (`grok`) in headless print mode, with the user's own sign-in: one run per turn, resumed, kept to
//! the web tools, in a home of its own so its chats never mix with the user's. Its words stream as they come.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use anyhow::{Context, bail};
use chrono::{DateTime, Local, NaiveDate};
use serde::Deserialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc::UnboundedSender;

use super::answer::{Answer, SCHEMA};
use super::child::{self, Events};

/// Fast answers for a voice assistant; the user's own Grok settings are not used.
const EFFORT: &str = "low";
const STDERR_LINES: usize = 20;
/// A turn that searches and then answers fits in this many model rounds.
const MAX_TURNS: &str = "8";
/// Isle's Grok only answers, with web search: no shell, no files, no subagents.
const TOOLS: &str = "web_search,web_fetch";
const DISALLOWED: &str = "run_terminal_cmd,search_replace,write,task,image_gen";
/// Written on every start, in Isle's own home for Grok: none of the user's tools, memory or workflows.
const CONFIG: &str = "# Written by Isle on every start: Grok here only answers; Isle runs the actions.
[features]
telemetry = false
feedback = false

[memory]
enabled = false

[workflows]
enabled = false
";

/// How hard it thinks: `EFFORT`, unless the eval tries another (ISLE_GROK_EFFORT).
fn effort() -> String {
    std::env::var("ISLE_GROK_EFFORT").unwrap_or_else(|_| EFFORT.to_owned())
}

pub struct Grok {
    program: PathBuf,
    model: String,
    workspace: PathBuf,
    instructions: String,
    pub conversation: Option<String>,
}

/// Grok's home for Isle, under Isle's data folder; it shares only the user's sign-in.
fn home() -> PathBuf {
    crate::store::data_dir().join("grok")
}

/// The user's own Grok home: `$GROK_HOME`, else `~/.grok`.
pub fn user_home() -> PathBuf {
    std::env::var_os("GROK_HOME")
        .filter(|dir| !dir.is_empty())
        .map_or_else(
            || dirs::home_dir().unwrap_or_default().join(".grok"),
            PathBuf::from,
        )
}

impl Grok {
    /// Remembers the conversation to resume (`resume`) and the job (`instructions`). Each turn starts
    /// `grok` and lets it exit: headless mode answers once and stops.
    pub fn start(
        program: &Path,
        model: &str,
        resume: Option<&str>,
        workspace: &Path,
        instructions: &str,
    ) -> anyhow::Result<Self> {
        std::fs::create_dir_all(workspace)?;
        crate::store::create_private_dir(&home()).context("could not make Grok's folder")?;
        std::fs::write(home().join("config.toml"), CONFIG).context("could not write Grok's settings")?;
        trust_workspace(workspace);
        link_sign_in();
        let model = if model.is_empty() {
            user_model().unwrap_or_default()
        } else {
            model.to_owned()
        };
        Ok(Self {
            program: program.to_owned(),
            model,
            workspace: workspace.to_owned(),
            instructions: instructions.to_owned(),
            conversation: resume.map(str::to_owned),
        })
    }

    pub async fn ask(
        &mut self,
        prompt: &str,
        activity: Option<&UnboundedSender<String>>,
        draft: Option<&UnboundedSender<String>>,
    ) -> anyhow::Result<Answer> {
        let answer = self.turn(prompt, activity, draft).await;
        // A resumed session Grok no longer has (pruned, or never stored): start a new one, once.
        let answer = match answer {
            Err(err) if self.conversation.is_some() && session_missing(&err) => {
                self.conversation = None;
                self.turn(prompt, activity, draft).await
            }
            other => other,
        };
        // A token it renewed meanwhile goes back to the user's own Grok.
        link_sign_in();
        answer
    }

    /// One headless run.
    async fn turn(
        &mut self,
        prompt: &str,
        activity: Option<&UnboundedSender<String>>,
        draft: Option<&UnboundedSender<String>>,
    ) -> anyhow::Result<Answer> {
        let prompt_path = home().join("prompt.txt");
        crate::store::write_private(&prompt_path, prompt.as_bytes())
            .context("could not write Grok's prompt")?;
        let _prompt_file = PromptFile(prompt_path.clone());
        let mut command = Command::new(&self.program);
        command
            .arg("--prompt-file")
            .arg(&prompt_path)
            .args([
                "--output-format",
                "streaming-messages-json",
                "--include-partial-messages",
                "--verbatim",
                "--json-schema",
                SCHEMA,
                "--system-prompt-override",
            ])
            .arg(&self.instructions)
            .args(["--tools", TOOLS, "--disallowed-tools", DISALLOWED])
            .args(["--no-plan", "--no-subagents", "--no-memory", "--always-approve"])
            .args(["--reasoning-effort", &effort(), "--max-turns", MAX_TURNS])
            .arg("--leader-socket")
            .arg(home().join("leader.sock"))
            .arg("--cwd")
            .arg(&self.workspace)
            .env("GROK_HOME", home())
            .env("GROK_DISABLE_AUTOUPDATER", "1")
            .current_dir(&self.workspace)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if !self.model.is_empty() {
            command.args(["--model", &self.model]);
        }
        if let Some(id) = &self.conversation {
            command.args(["--resume", id]);
        }
        let mut child = child::spawn(&mut command).context("could not start grok; is Grok installed?")?;
        let events = Events::new(child.stdout.take().expect("piped stdout"));
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
        let answer = read_turn(&mut self.conversation, events, activity, draft).await;
        drop(child);
        answer.map_err(|err| {
            let stderr = Vec::from(stderr.lock().unwrap().clone()).join(" | ");
            if stderr.is_empty() {
                err
            } else {
                err.context(stderr)
            }
        })
    }
}

/// Whether `err` is a resume of a session Grok does not have, rather than a failure of the answer.
fn session_missing(err: &anyhow::Error) -> bool {
    let text = err.to_string().to_lowercase();
    text.contains("session")
        && (text.contains("not found")
            || text.contains("does not exist")
            || text.contains("no such")
            || text.contains("unknown"))
}

/// Holds the prompt file until the run has read it.
struct PromptFile(PathBuf);

impl Drop for PromptFile {
    fn drop(&mut self) {
        std::fs::remove_file(&self.0).ok();
    }
}

/// Reads one run's stream into an answer, keeping the session id and what to show meanwhile.
async fn read_turn(
    conversation: &mut Option<String>,
    mut events: Events<tokio::process::ChildStdout>,
    activity: Option<&UnboundedSender<String>>,
    draft: Option<&UnboundedSender<String>>,
) -> anyhow::Result<Answer> {
    let words: &[&str] = &[
        "\"init\"",
        "\"result\"",
        "\"tool_use\"",
        "\"text_delta\"",
        "\"input_json_delta\"",
        "\"type\":\"error\"",
        "\"type\": \"error\"",
    ];
    let mut written = String::new();
    let mut shown = String::new();
    while let Some(event) = events.next(words).await? {
        if let Some(id) = event["session_id"].as_str().filter(|id| !id.is_empty()) {
            *conversation = Some(id.to_owned());
        }
        match event["type"].as_str() {
            Some("result") => return parse_result(&event),
            Some("error") => {
                bail!(
                    "{}",
                    event["message"].as_str().unwrap_or("grok failed")
                );
            }
            Some("stream_event") => note_delta(&event["event"], &mut written, &mut shown, draft),
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
    bail!("grok stopped")
}

/// The answer so far, from a partial message: the schema's JSON, or the text it is writing.
fn note_delta(
    event: &Value,
    written: &mut String,
    shown: &mut String,
    draft: Option<&UnboundedSender<String>>,
) {
    let delta = &event["delta"];
    match delta["type"].as_str() {
        Some("input_json_delta") => written.push_str(delta["partial_json"].as_str().unwrap_or_default()),
        Some("text_delta") => written.push_str(delta["text"].as_str().unwrap_or_default()),
        _ => {
            if event["type"] == "content_block_start" {
                written.clear();
            }
            return;
        }
    }
    if let (Some(draft), Some(say)) = (draft, super::answer::partial_say(written))
        && say != *shown
    {
        draft.send(say.clone()).ok();
        *shown = say;
    }
}

/// What Grok starts doing, for the island: its web searches and the pages it reads.
fn steps(event: &Value) -> Vec<String> {
    let Some(content) = event["message"]["content"].as_array() else {
        return Vec::new();
    };
    content
        .iter()
        .filter(|part| part["type"] == "tool_use")
        .filter_map(|tool| match tool["name"].as_str()? {
            "web_search" | "WebSearch" => Some(match query(tool) {
                Some(query) => format!("Searching the web for “{query}”…"),
                None => "Searching the web…".into(),
            }),
            "web_fetch" | "WebFetch" => {
                let url = tool["input"]["url"]
                    .as_str()
                    .or(tool["input"]["uri"].as_str())
                    .unwrap_or_default();
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

fn query(tool: &Value) -> Option<&str> {
    ["query", "q", "search_term"]
        .iter()
        .find_map(|key| tool["input"][*key].as_str().filter(|q| !q.is_empty()))
}

fn parse_result(event: &Value) -> anyhow::Result<Answer> {
    if event["is_error"].as_bool() == Some(true) || event["subtype"].as_str().is_some_and(|s| s != "success")
    {
        let reason = event["result"]
            .as_str()
            .or(event["message"].as_str())
            .or(event["error"].as_str())
            .unwrap_or("grok failed");
        bail!("{reason}");
    }
    if let Ok(answer) = Answer::deserialize(&event["structured_output"]) {
        return Ok(answer);
    }
    Ok(super::answer::from_text(
        event["result"].as_str().unwrap_or_default(),
    ))
}

/// The model in the user's own config.toml (`[models] default`), when they picked none.
fn user_model() -> Option<String> {
    model_in(&std::fs::read_to_string(user_home().join("config.toml")).ok()?)
}

/// `default` in the `[models]` table of `config`.
fn model_in(config: &str) -> Option<String> {
    let mut in_models = false;
    for line in config.lines() {
        let line = line.trim();
        if let Some(name) = line.strip_prefix('[').and_then(|rest| rest.strip_suffix(']')) {
            in_models = name.trim() == "models";
            continue;
        }
        if !in_models {
            continue;
        }
        let value = line.strip_prefix("default")?.trim_start().strip_prefix('=')?.trim();
        let value = value.trim_matches(|c: char| c == '"' || c == '\'');
        if !value.is_empty() {
            return Some(value.to_owned());
        }
    }
    None
}

/// Marks Isle's workspace trusted, so a headless run there is not held for a question nobody can answer.
fn trust_workspace(workspace: &Path) {
    let path = workspace.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"");
    let now = chrono::Utc::now().timestamp();
    let text = format!("[folders.\"{path}\"]\ntrusted = true\ndecided_at = {now}\n");
    std::fs::write(home().join("trusted_folders.toml"), text).ok();
}

/// Links Isle's Grok home to the user's sign-in (`auth.json`; see sign_in.rs).
fn link_sign_in() {
    super::sign_in::share(&user_home().join("auth.json"), &home().join("auth.json"));
}

/// A sign-in Grok stored: the session token, the user id the billing call names, and when it runs out
/// (0 when it did not say).
pub struct SignIn {
    pub token: String,
    pub user_id: String,
    pub expires_ms: i64,
}

/// Whether Grok has a way to sign in: its own sign-in, or an API key.
pub fn signed_in() -> bool {
    std::env::var_os("XAI_API_KEY").is_some_and(|key| !key.is_empty()) || sign_in().is_some()
}

/// The newest sign-in in `auth.json` (several accounts: the one that lasts longest).
pub fn sign_in() -> Option<SignIn> {
    let text = std::fs::read_to_string(user_home().join("auth.json")).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    sign_in_from(&value)
}

fn sign_in_from(value: &Value) -> Option<SignIn> {
    let mut best: Option<SignIn> = None;
    for entry in value.as_object()?.values() {
        let Some(token) = entry["key"].as_str().filter(|token| !token.is_empty()) else {
            continue;
        };
        let Some(user_id) = entry["user_id"].as_str().filter(|id| !id.is_empty()) else {
            continue;
        };
        let expires_ms = entry["expires_at"].as_str().map(rfc3339_ms).unwrap_or(0);
        let better = best.as_ref().is_none_or(|have| expires_ms >= have.expires_ms);
        if better {
            best = Some(SignIn {
                token: token.to_owned(),
                user_id: user_id.to_owned(),
                expires_ms,
            });
        }
    }
    best
}

/// The installed Grok's version, as it last wrote it, for the billing call that asks.
pub fn client_version() -> Option<String> {
    let text = std::fs::read_to_string(user_home().join("version.json")).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value["version"]
        .as_str()
        .filter(|version| !version.is_empty())
        .map(str::to_owned)
}

/// Where Grok reads the plan's allowance. `$GROK_CLI_CHAT_PROXY_BASE_URL`, else `[endpoints]` in the
/// user's config, else Grok's own proxy.
pub fn billing_url() -> String {
    let base = std::env::var("GROK_CLI_CHAT_PROXY_BASE_URL")
        .ok()
        .filter(|url| !url.trim().is_empty())
        .or_else(proxy_from_config)
        .unwrap_or_else(|| "https://cli-chat-proxy.grok.com/v1".to_owned());
    format!(
        "{}/billing?format=credits",
        base.trim().trim_end_matches('/')
    )
}

fn proxy_from_config() -> Option<String> {
    let config = std::fs::read_to_string(user_home().join("config.toml")).ok()?;
    let mut in_endpoints = false;
    for line in config.lines() {
        let line = line.trim();
        if let Some(name) = line.strip_prefix('[').and_then(|rest| rest.strip_suffix(']')) {
            in_endpoints = name.trim() == "endpoints";
            continue;
        }
        if !in_endpoints {
            continue;
        }
        let value = line
            .strip_prefix("cli_chat_proxy_base_url")?
            .trim_start()
            .strip_prefix('=')?
            .trim()
            .trim_matches(|c: char| c == '"' || c == '\'');
        if value.starts_with("https://") || value.starts_with("http://") {
            return Some(value.to_owned());
        }
    }
    None
}

fn rfc3339_ms(text: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(text).map_or(0, |time| time.timestamp_millis())
}

/// Deletes Isle's Grok conversation `id` now (an id as Grok makes them, never a path).
pub fn forget(id: &str) {
    if !session_id(id) {
        return;
    }
    if let Some(program) = super::brain::Provider::Grok.program() {
        let mut command = std::process::Command::new(program);
        command
            .args(["sessions", "delete", id])
            // The default socket stays ~/.grok/leader.sock even with GROK_HOME set.
            .arg("--leader-socket")
            .arg(home().join("leader.sock"))
            .env("GROK_HOME", home())
            .env("GROK_DISABLE_AUTOUPDATER", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Ok(mut child) = command.spawn() {
            let _ = child.wait();
        }
    }
    forget_files(id);
}

fn session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Deletes the folder of conversation `id` left in Isle's Grok home.
fn forget_files(id: &str) {
    fn walk(dir: &Path, id: &str) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                if entry.file_name().to_string_lossy() == id {
                    std::fs::remove_dir_all(&path).ok();
                } else {
                    walk(&path, id);
                }
            }
        }
    }
    walk(&home().join("sessions"), id);
}

/// Deletes Isle's Grok conversations last changed before `today`.
pub fn prune(today: NaiveDate) {
    fn walk(dir: &Path, today: NaiveDate) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            if !kind.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if session_id(&name) {
                let old = entry
                    .metadata()
                    .and_then(|meta| meta.modified())
                    .is_ok_and(|time| DateTime::<Local>::from(time).date_naive() < today);
                if old {
                    std::fs::remove_dir_all(&path).ok();
                }
            } else {
                walk(&path, today);
                std::fs::remove_dir(&path).ok();
            }
        }
    }
    walk(&home().join("sessions"), today);
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn reads_groks_answer_and_steps() {
        let done = json!({"type": "result", "subtype": "success", "is_error": false, "result": "{}",
            "structured_output": {"say": "Done.", "actions": [{"type": "open_url", "url": "https://x.com"}]}});
        let answer = parse_result(&done).unwrap();
        assert_eq!((answer.say.as_str(), answer.actions.len()), ("Done.", 1));
        let failed = json!({"type": "result", "subtype": "error_during_execution", "is_error": true,
            "result": "Please run grok login"});
        assert!(parse_result(&failed).unwrap_err().to_string().contains("login"));
        let search = json!({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "web_search", "input": {"query": "weather"}}]}});
        assert_eq!(steps(&search), ["Searching the web for “weather”…"]);
    }

    #[test]
    fn reads_the_users_default_model_and_sign_in() {
        let config = "[cli]\ninstaller = \"internal\"\n\n[models]\ndefault = \"grok-4.7\"\n";
        assert_eq!(model_in(config).as_deref(), Some("grok-4.7"));
        assert!(model_in("[cli]\ndefault = \"no\"\n").is_none());
        let auth = json!({"https://auth.x.ai::one": {"key": "old", "user_id": "a",
            "expires_at": "2026-01-01T00:00:00Z"},
            "https://auth.x.ai::two": {"key": "new", "user_id": "b",
            "expires_at": "2026-12-01T00:00:00Z"}});
        let sign_in = sign_in_from(&auth).unwrap();
        assert_eq!((sign_in.token.as_str(), sign_in.user_id.as_str()), ("new", "b"));
        assert!(sign_in.expires_ms > 0);
    }

    #[test]
    fn billing_url_stays_on_the_proxy() {
        assert!(billing_url().starts_with("https://") || billing_url().starts_with("http://"));
        assert!(billing_url().ends_with("/billing?format=credits"));
    }
}

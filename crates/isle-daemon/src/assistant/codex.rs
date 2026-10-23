// SPDX-License-Identifier: GPL-3.0-or-later

//! Codex (`codex exec`), with the user's own sign-in: a process per turn, resuming the conversation, in a
//! read-only sandbox with web search, and a home of its own so its chats never mix with the user's.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context, bail};
use chrono::{DateTime, Local, NaiveDate};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc::UnboundedSender;

use super::answer::{Answer, SCHEMA};
use super::child::{self, Events};

/// Fast answers for a voice assistant; the user's own Codex settings are not used.
const EFFORT: &str = "model_reasoning_effort=\"low\"";
/// Isle's Codex only answers, with web search: no shell, no files, no browser or desktop control, no
/// plugins or apps. Unknown keys are ignored, so names a Codex version lacks do no harm.
const CONFIG: &str =
    "# Written by Isle on every start: Codex here only answers; Isle runs the actions.
[features]
shell_tool = false
unified_exec = false
unified_exec_tty = false
shell_snapshot = false
apply_patch_freeform = false
view_image = false
computer_use = false
browser_use = false
browser_use_external = false
browser_use_full_cdp_access = false
in_app_browser = false
in_app_local_automation = false
apps = false
plugins = false
remote_plugin = false
plugin_sharing = false
hooks = false
multi_agent = false
image_generation = false
skill_search = false
skill_mcp_dependency_install = false
tool_suggest = false
goals = false
worktrees = false
workspace_dependencies = false
sleep_tool = false
";

pub struct Codex {
    program: PathBuf,
    model: String,
    workspace: PathBuf,
    pub conversation: Option<String>,
}

/// Codex's home for Isle, under Isle's data folder; it shares only the user's sign-in.
fn home() -> PathBuf {
    crate::store::data_dir().join("codex")
}

impl Codex {
    pub fn start(
        program: &Path,
        model: &str,
        resume: Option<&str>,
        workspace: &Path,
    ) -> anyhow::Result<Self> {
        std::fs::create_dir_all(workspace)?;
        std::fs::create_dir_all(home())?;
        if let Some(user) = dirs::home_dir() {
            link_sign_in(&user.join(".codex"), &home());
        }
        std::fs::write(home().join("answer.schema.json"), strict(SCHEMA)?)
            .context("could not write Codex's schema")?;
        std::fs::write(home().join("config.toml"), CONFIG)
            .context("could not write Codex's settings")?;
        // With no model picked, the one the user's own Codex uses.
        let model = if model.is_empty() {
            user_model().unwrap_or_default()
        } else {
            model.to_owned()
        };
        Ok(Self {
            program: program.to_owned(),
            model,
            workspace: workspace.to_owned(),
            conversation: resume.map(str::to_owned),
        })
    }

    pub async fn ask(
        &mut self,
        prompt: &str,
        activity: Option<&UnboundedSender<String>>,
    ) -> anyhow::Result<Answer> {
        let mut command = Command::new(&self.program);
        command.arg("--search").arg("exec");
        if let Some(id) = &self.conversation {
            command.args(["resume", id]);
        }
        command
            .args([
                "--json",
                "--skip-git-repo-check",
                "-c",
                EFFORT,
                "-c",
                "sandbox_mode=\"read-only\"",
            ])
            .arg("--output-schema")
            .arg(home().join("answer.schema.json"));
        if !self.model.is_empty() {
            command.args(["-m", &self.model]);
        }
        // The prompt goes on stdin ("-"): on the command line, any user could read it in /proc, and a
        // long one would not fit.
        command
            .arg("-")
            .env("CODEX_HOME", home())
            .current_dir(&self.workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child =
            child::spawn(&mut command).context("could not start codex; is Codex installed?")?;
        let mut stdin = child.stdin.take().expect("piped stdin");
        stdin.write_all(prompt.as_bytes()).await.ok();
        drop(stdin);
        // Read as it comes, so a chatty stderr never fills its pipe and stalls Codex; only its last
        // line is kept, to explain a failure.
        let mut stderr = BufReader::new(child.stderr.take().expect("piped stderr")).lines();
        let errors = tokio::spawn(async move {
            let mut last = String::new();
            while let Ok(Some(line)) = stderr.next_line().await {
                if !line.trim().is_empty() {
                    last = line;
                }
            }
            last
        });
        let mut events = Events::new(child.stdout.take().expect("piped stdout"));
        let mut answer = None;
        let mut failure = None;
        // Commands' output, the bulk, is skipped unparsed.
        let words: &[&str] = match activity {
            Some(_) => &[
                "\"thread.started\"",
                "\"agent_message\"",
                "\"turn.failed\"",
                "\"error\"",
                "\"web_search\"",
            ],
            None => &[
                "\"thread.started\"",
                "\"agent_message\"",
                "\"turn.failed\"",
                "\"error\"",
            ],
        };
        while let Some(event) = events.next(words).await? {
            match event["type"].as_str() {
                Some("thread.started") => {
                    self.conversation = event["thread_id"].as_str().map(str::to_owned)
                }
                Some("item.started") | Some("item.completed") => {
                    let item = &event["item"];
                    if item["type"] == "agent_message" && event["type"] == "item.completed" {
                        answer = item["text"].as_str().map(str::to_owned);
                    } else if let (Some(activity), Some(step)) = (activity, step(item)) {
                        activity.send(step).ok();
                    }
                }
                Some("turn.failed") | Some("error") => {
                    failure = Some(
                        event["error"]["message"]
                            .as_str()
                            .or(event["message"].as_str())
                            .unwrap_or("codex failed")
                            .to_owned(),
                    );
                }
                _ => {}
            }
        }
        child.wait().await.ok();
        // A token it renewed meanwhile goes back to the user's own Codex.
        if let Some(user) = dirs::home_dir() {
            link_sign_in(&user.join(".codex"), &home());
        }
        let errors = errors.await.unwrap_or_default();
        match (answer, failure) {
            (Some(text), _) => parse_answer(&text),
            (None, Some(reason)) => bail!("{reason}"),
            (None, None) => bail!("codex stopped: {errors}"),
        }
    }
}

/// What Codex starts doing, for the island: its web searches.
fn step(item: &Value) -> Option<String> {
    if item["type"] != "web_search" {
        return None;
    }
    Some(match item["query"].as_str().filter(|q| !q.is_empty()) {
        Some(query) => format!("Searching the web for “{query}”…"),
        None => "Searching the web…".into(),
    })
}

/// Its answer; without the JSON asked for, the text as said, as the other AIs' (see `answer::from_text`).
fn parse_answer(text: &str) -> anyhow::Result<Answer> {
    let Ok(mut value) = serde_json::from_str::<Value>(text.trim()) else {
        anyhow::ensure!(!text.trim().is_empty(), "codex answered nothing");
        return Ok(super::answer::from_text(text));
    };
    // Its schema has every field, unused ones null: only what was given is kept.
    if let Some(answer) = value.as_object_mut() {
        answer.retain(|_, field| !field.is_null());
    }
    if let Some(actions) = value["actions"].as_array_mut() {
        for action in actions.iter_mut().filter_map(Value::as_object_mut) {
            action.retain(|_, field| !field.is_null());
        }
    }
    Ok(serde::Deserialize::deserialize(&value)?)
}

/// `schema` as Codex's structured output needs it: every field required (optional ones may be null),
/// and no others allowed.
fn strict(schema: &str) -> anyhow::Result<String> {
    fn tighten(node: &mut Value) {
        let Some(object) = node.as_object_mut() else {
            return;
        };
        let required: Vec<String> = object
            .get("required")
            .and_then(Value::as_array)
            .map(|r| {
                r.iter()
                    .filter_map(|k| k.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        let keys = match object.get_mut("properties") {
            Some(Value::Object(properties)) => {
                for (key, property) in properties.iter_mut() {
                    tighten(property);
                    if !required.contains(key) {
                        if let Some(kind) = property.get("type").cloned() {
                            property["type"] = Value::Array(vec![kind, Value::from("null")]);
                        }
                        // A field that may be null may not also be held to a list of values.
                        if let Some(property) = property.as_object_mut() {
                            property.remove("enum");
                        }
                    }
                }
                Some(
                    properties
                        .keys()
                        .map(|k| Value::from(k.as_str()))
                        .collect::<Vec<_>>(),
                )
            }
            _ => None,
        };
        if let Some(all) = keys {
            object.insert("required".into(), Value::Array(all));
            object.insert("additionalProperties".into(), Value::Bool(false));
        }
        if let Some(items) = object.get_mut("items") {
            tighten(items);
        }
    }
    let mut value: Value = serde_json::from_str(schema)?;
    tighten(&mut value);
    Ok(value.to_string())
}

/// The model in the user's own ~/.codex/config.toml, so Isle uses the same one unless told otherwise:
/// its top-level `model`, not a profile's.
fn user_model() -> Option<String> {
    let config = std::fs::read_to_string(dirs::home_dir()?.join(".codex/config.toml")).ok()?;
    top_level_model(&config)
}

fn top_level_model(config: &str) -> Option<String> {
    config
        .lines()
        .take_while(|line| !line.trim_start().starts_with('['))
        .find_map(|line| {
            let value = line
                .trim()
                .strip_prefix("model")?
                .trim_start()
                .strip_prefix('=')?;
            Some(value.trim().trim_matches('"').to_owned())
        })
}

/// Links Isle's Codex home to the user's sign-in (`auth.json`; see sign_in.rs).
fn link_sign_in(user: &Path, isle: &Path) {
    super::sign_in::share(&user.join("auth.json"), &isle.join("auth.json"));
}

/// Deletes Isle's Codex conversation `id` now.
#[cfg(test)]
pub fn forget(id: &str) {
    fn walk(dir: &Path, id: &str) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for path in entries.flatten().map(|e| e.path()) {
            if path.is_dir() {
                walk(&path, id);
            } else if path.to_string_lossy().contains(id) {
                std::fs::remove_file(&path).ok();
            }
        }
    }
    walk(&home().join("sessions"), id);
}

/// Deletes Isle's Codex conversations last changed before `today`.
pub fn prune(today: NaiveDate) {
    fn walk(dir: &Path, today: NaiveDate) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            // Never through a link, which could lead out of Isle's own folder.
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                walk(&path, today);
                // Folders emptied by it go too.
                std::fs::remove_dir(&path).ok();
            } else if entry
                .metadata()
                .and_then(|meta| meta.modified())
                .is_ok_and(|time| DateTime::<Local>::from(time).date_naive() < today)
            {
                std::fs::remove_file(&path).ok();
            }
        }
    }
    walk(&home().join("sessions"), today);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn makes_the_schema_strict() {
        let strict: Value = serde_json::from_str(&strict(SCHEMA).unwrap()).unwrap();
        assert_eq!(strict["additionalProperties"], false);
        assert_eq!(
            strict["properties"]["listen"]["type"],
            serde_json::json!(["boolean", "null"])
        );
        let item = &strict["properties"]["actions"]["items"];
        assert_eq!(item["additionalProperties"], false);
        let fields = item["properties"].as_object().unwrap().len();
        assert!(fields > 15 && item["required"].as_array().unwrap().len() == fields);
        // The action type stays required and limited to the known ones.
        assert_eq!(item["properties"]["type"]["type"], "string");
        assert!(item["properties"]["type"]["enum"].is_array());
        assert_eq!(
            item["properties"]["terms"]["type"],
            serde_json::json!(["array", "null"])
        );
    }

    #[test]
    fn takes_only_the_top_level_model() {
        assert_eq!(
            top_level_model("model = \"gpt-5.5\"\n[profiles.fast]\nmodel = \"mini\"\n").as_deref(),
            Some("gpt-5.5")
        );
        assert_eq!(top_level_model("[profiles.fast]\nmodel = \"mini\"\n"), None);
    }

    #[test]
    fn reads_codexs_answer() {
        let text = r#"{"say":"Membuka YouTube.","listen":false,"actions":[{"type":"open_url","url":"https://www.youtube.com","app":null,"minutes":null}]}"#;
        let answer = parse_answer(text).unwrap();
        assert_eq!(answer.say, "Membuka YouTube.");
        assert_eq!(
            answer.actions[0],
            serde_json::json!({"type": "open_url", "url": "https://www.youtube.com"})
        );
        assert_eq!(
            step(&serde_json::json!({"type": "web_search", "query": "cuaca"})).unwrap(),
            "Searching the web for “cuaca”…"
        );
    }
}

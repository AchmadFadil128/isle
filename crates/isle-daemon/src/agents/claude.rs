// SPDX-License-Identifier: GPL-3.0-or-later

//! Claude Code's alerts: a `Notification` and a `Stop` hook in its settings.json, each running
//! `isled --agent-hook claude`. Everything else in the file is left as it was, in its order.

use std::path::{Path, PathBuf};

use anyhow::{Context, bail};
use serde_json::{Value, json};

use super::file;

/// The hook events Isle listens to.
const EVENTS: [&str; 2] = ["Notification", "Stop"];
/// What marks a hook as Isle's, whichever isled it runs.
const MARK: &str = "--agent-hook claude";

/// `$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`.
pub fn settings_path() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|dir| !dir.is_empty())
        .map_or_else(
            || dirs::home_dir().unwrap_or_default().join(".claude"),
            PathBuf::from,
        )
        .join("settings.json")
}

/// The command each hook runs: `isled` quoted for the shell Claude Code runs it with.
pub fn command(isled: &str) -> String {
    format!("{} {MARK}", shell_quote(isled))
}

fn shell_quote(text: &str) -> String {
    let plain = |c: char| c.is_ascii_alphanumeric() || "/._+-".contains(c);
    if !text.is_empty() && text.chars().all(plain) {
        text.to_owned()
    } else {
        format!("'{}'", text.replace('\'', r"'\''"))
    }
}

/// Whether both of Isle's hooks are in the settings file.
pub fn hooked(path: &Path) -> bool {
    file::read(path)
        .ok()
        .flatten()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .is_some_and(|settings| has_hooks(&settings))
}

/// Adds Isle's hooks (or points them at `command`); a file that is not JSON is never written.
pub fn install(path: &Path, command: &str) -> anyhow::Result<()> {
    let text = file::read(path).with_context(|| format!("could not read {}", path.display()))?;
    let mut settings = parse(path, text.as_deref())?;
    if add_hooks(&mut settings, command).with_context(|| format!("in {}", path.display()))? {
        save(path, &settings, text.as_deref())?;
    }
    Ok(())
}

/// Takes Isle's hooks out; whether there were any.
pub fn remove(path: &Path) -> anyhow::Result<bool> {
    let text = file::read(path).with_context(|| format!("could not read {}", path.display()))?;
    let Some(text) = text else {
        return Ok(false);
    };
    let mut settings = parse(path, Some(&text))?;
    let removed = remove_hooks(&mut settings);
    if removed {
        save(path, &settings, Some(&text))?;
    }
    Ok(removed)
}

fn parse(path: &Path, text: Option<&str>) -> anyhow::Result<Value> {
    match text {
        Some(text) if !text.trim().is_empty() => serde_json::from_str(text)
            .with_context(|| format!("{} is not valid JSON; fix it first", path.display())),
        _ => Ok(json!({})),
    }
}

/// Written as Claude Code writes it: two spaces, and the old file's final newline.
fn save(path: &Path, settings: &Value, old: Option<&str>) -> anyhow::Result<()> {
    let mut text = serde_json::to_string_pretty(settings)?;
    if old.is_none_or(|old| old.ends_with('\n')) {
        text.push('\n');
    }
    file::backup_once(path).with_context(|| format!("could not back up {}", path.display()))?;
    file::write_atomic(path, &text).with_context(|| format!("could not write {}", path.display()))
}

fn is_ours(hook: &Value) -> bool {
    hook["command"].as_str().is_some_and(|c| c.contains(MARK))
}

/// Every hook listed under `event`, whatever its matcher.
fn hooks_of<'a>(settings: &'a Value, event: &str) -> impl Iterator<Item = &'a Value> {
    settings["hooks"][event]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry["hooks"].as_array())
        .flatten()
}

fn has_hooks(settings: &Value) -> bool {
    EVENTS
        .iter()
        .all(|event| hooks_of(settings, event).any(is_ours))
}

/// Whether anything changed.
fn add_hooks(settings: &mut Value, command: &str) -> anyhow::Result<bool> {
    let Some(settings) = settings.as_object_mut() else {
        bail!("the settings are not a JSON object");
    };
    let Some(hooks) = settings
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
    else {
        bail!("`hooks` is not a JSON object");
    };
    let mut changed = false;
    for event in EVENTS {
        let Some(list) = hooks
            .entry(event)
            .or_insert_with(|| json!([]))
            .as_array_mut()
        else {
            bail!("`hooks.{event}` is not a list");
        };
        let ours = list
            .iter_mut()
            .filter_map(|entry| entry.get_mut("hooks").and_then(Value::as_array_mut))
            .flatten()
            .find(|hook| is_ours(hook));
        match ours {
            Some(hook) if hook["command"] == command => {}
            // Kept, but run by this isled (an older one may be gone).
            Some(hook) => {
                hook["command"] = json!(command);
                changed = true;
            }
            None => {
                list.push(json!({"hooks": [{"type": "command", "command": command}]}));
                changed = true;
            }
        }
    }
    Ok(changed)
}

/// Whether anything changed. Only lists Isle emptied go, with `hooks` if that empties it.
fn remove_hooks(settings: &mut Value) -> bool {
    let Some(settings) = settings.as_object_mut() else {
        return false;
    };
    let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) else {
        return false;
    };
    let mut removed = false;
    let mut emptied = false;
    for event in EVENTS {
        let Some(list) = hooks.get_mut(event).and_then(Value::as_array_mut) else {
            continue;
        };
        let mut found = false;
        list.retain_mut(|entry| {
            let Some(inner) = entry.get_mut("hooks").and_then(Value::as_array_mut) else {
                return true;
            };
            let count = inner.len();
            inner.retain(|hook| !is_ours(hook));
            found |= inner.len() < count;
            !(inner.is_empty() && count > 0)
        });
        removed |= found;
        if found && list.is_empty() {
            hooks.shift_remove(event);
            emptied = true;
        }
    }
    if emptied && hooks.is_empty() {
        settings.shift_remove("hooks");
    }
    removed
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::agents::file::tests::scratch;

    const COMMAND: &str = "/usr/bin/isled --agent-hook claude";

    #[test]
    fn hooks_go_in_beside_the_users_own() {
        let dir = scratch("claude-install");
        let path = dir.join("settings.json");
        let before = r#"{
  "model": "opus",
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "notify-send done"
          }
        ]
      }
    ],
    "PreToolUse": []
  },
  "env": {
    "B": "1",
    "A": "2"
  }
}
"#;
        fs::write(&path, before).unwrap();
        assert!(!hooked(&path));
        install(&path, COMMAND).unwrap();
        assert!(hooked(&path));
        let text = fs::read_to_string(&path).unwrap();
        let settings: Value = serde_json::from_str(&text).unwrap();
        // Keys keep their order; the user's own hook stays first.
        let keys: Vec<&String> = settings.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["model", "hooks", "env"]);
        let env: Vec<&String> = settings["env"].as_object().unwrap().keys().collect();
        assert_eq!(env, ["B", "A"]);
        assert_eq!(
            settings["hooks"]["Stop"][0]["hooks"][0]["command"],
            "notify-send done"
        );
        assert_eq!(
            settings["hooks"]["Stop"][1],
            json!({"hooks": [{"type": "command", "command": COMMAND}]})
        );
        assert_eq!(
            settings["hooks"]["Notification"][0]["hooks"][0]["command"],
            COMMAND
        );
        assert!(text.contains("\n  \"model\": \"opus\",\n") && text.ends_with("}\n"));
        assert_eq!(
            fs::read_to_string(file::sibling(&path, ".isle-backup")).unwrap(),
            before
        );

        // Twice is once.
        install(&path, COMMAND).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), text);

        // Off again: the file is as it was.
        assert!(remove(&path).unwrap());
        assert_eq!(fs::read_to_string(&path).unwrap(), before);
        assert!(!remove(&path).unwrap());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_missing_file_is_made_and_emptied_again() {
        let dir = scratch("claude-new");
        let path = dir.join("sub/settings.json");
        install(&path, "'/home/a b/isled' --agent-hook claude").unwrap();
        assert!(hooked(&path));
        assert!(!file::sibling(&path, ".isle-backup").exists());
        assert!(remove(&path).unwrap());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{}\n");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn bad_json_is_never_written() {
        let dir = scratch("claude-bad");
        let path = dir.join("settings.json");
        fs::write(&path, "{\"model\": ").unwrap();
        let err = install(&path, COMMAND).unwrap_err();
        assert!(err.to_string().contains("not valid JSON"), "{err}");
        assert!(remove(&path).is_err());
        fs::write(&path, r#"{"hooks": []}"#).unwrap();
        assert!(install(&path, COMMAND).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), r#"{"hooks": []}"#);
        assert!(!file::sibling(&path, ".isle-backup").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_moved_isled_is_followed() {
        let mut settings = json!({});
        assert!(add_hooks(&mut settings, "/old/isled --agent-hook claude").unwrap());
        assert!(add_hooks(&mut settings, COMMAND).unwrap());
        assert!(!add_hooks(&mut settings, COMMAND).unwrap());
        assert_eq!(settings["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert_eq!(settings["hooks"]["Stop"][0]["hooks"][0]["command"], COMMAND);
    }

    #[test]
    fn only_isles_hooks_are_removed() {
        let mut settings = json!({
            "hooks": {
                "Notification": [
                    {"hooks": [
                        {"type": "command", "command": "mine"},
                        {"type": "command", "command": COMMAND}
                    ]}
                ],
                "Stop": [{"hooks": [{"type": "command", "command": COMMAND}]}],
                "SessionStart": []
            }
        });
        assert!(remove_hooks(&mut settings));
        assert_eq!(
            settings,
            json!({
                "hooks": {
                    "Notification": [{"hooks": [{"type": "command", "command": "mine"}]}],
                    "SessionStart": []
                }
            })
        );
        assert!(!remove_hooks(&mut settings));
        // A list already empty is the user's to keep.
        let mut settings = json!({"hooks": {"Stop": []}});
        assert!(!remove_hooks(&mut settings));
        assert_eq!(settings, json!({"hooks": {"Stop": []}}));
    }

    #[test]
    fn odd_paths_are_quoted() {
        assert_eq!(command("/usr/bin/isled"), COMMAND);
        assert_eq!(
            command("/home/a b/it's/isled"),
            r"'/home/a b/it'\''s/isled' --agent-hook claude"
        );
    }
}

// SPDX-License-Identifier: GPL-3.0-or-later

//! The conversation the island shows: what the user said, the commands that ran, and the answers. Only the
//! current one is kept (in chat.json, private to the user), never past a day: it ends at midnight, or once
//! quiet as long as Settings says, and then it is deleted, with the AI's own copy of it.

use chrono::{Local, TimeZone};
use serde::{Deserialize, Serialize};

/// The island shows this many of the newest messages; older ones are let go.
const SHOWN: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
    Command,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Item {
    pub role: Role,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub text: String,
    /// Said rather than typed (the user's own words).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub spoken: bool,
    /// A command that ran, or was asked for: the command and how it went (done, failed, denied, stopped).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub command: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub status: String,
    /// When, in milliseconds since 1970.
    pub at: i64,
}

impl Item {
    pub fn said(text: &str, spoken: bool, at: i64) -> Self {
        Self {
            role: Role::User,
            text: text.to_owned(),
            spoken,
            command: String::new(),
            status: String::new(),
            at,
        }
    }

    pub fn answer(text: &str, at: i64) -> Self {
        Self {
            role: Role::Assistant,
            text: text.to_owned(),
            spoken: false,
            command: String::new(),
            status: String::new(),
            at,
        }
    }

    pub fn command(command: &str, status: &str, at: i64) -> Self {
        Self {
            role: Role::Command,
            text: String::new(),
            spoken: false,
            command: command.to_owned(),
            status: status.to_owned(),
            at,
        }
    }
}

/// How long a quiet conversation is kept, from Settings ("day", "idle-30m", "idle-2h"); never past midnight.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Keep {
    Day,
    Idle(i64),
}

impl Keep {
    pub fn parse(setting: &str) -> Self {
        match setting {
            "idle-30m" => Keep::Idle(30 * 60_000),
            "idle-2h" => Keep::Idle(2 * 3_600_000),
            _ => Keep::Day,
        }
    }
}

/// The current conversation, as saved: its messages, and the AI conversation that goes with it, so a
/// restart of isled resumes it rather than starting over.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Chat {
    pub items: Vec<Item>,
    /// The AI it is had with ("claude", "codex", "agy") and its id there.
    pub provider: String,
    pub conversation: String,
    /// The last time anything was said, in milliseconds since 1970.
    pub last: i64,
}

impl Chat {
    pub fn push(&mut self, item: Item) {
        self.last = self.last.max(item.at);
        self.items.push(item);
        if self.items.len() > SHOWN {
            self.items.drain(..self.items.len() - SHOWN);
        }
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty() && self.conversation.is_empty()
    }

    /// Whether, at `now` (ms), it has ended: it began on an earlier day, or has been quiet longer than `keep`.
    pub fn expired(&self, now: i64, keep: Keep) -> bool {
        if self.is_empty() {
            return false;
        }
        let day = |ms: i64| {
            Local
                .timestamp_millis_opt(ms)
                .single()
                .map(|time| time.date_naive())
        };
        if day(self.last) != day(now) {
            return true;
        }
        match keep {
            Keep::Day => false,
            Keep::Idle(quiet) => now - self.last > quiet,
        }
    }

    /// The island's view: the messages as JSON.
    pub fn history(&self) -> String {
        serde_json::to_string(&self.items).unwrap_or_else(|_| "[]".into())
    }
}

/// Now, in milliseconds since 1970.
pub fn now_ms() -> i64 {
    Local::now().timestamp_millis()
}

/// `text` with what looks like a secret blanked out (private keys, tokens, passwords in the clear), before
/// it goes to the AI or into the conversation: a command's output can print them.
pub fn mask_secrets(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_key = false;
    for line in text.lines() {
        if line.contains("-----BEGIN") && line.contains("PRIVATE KEY") {
            in_key = true;
            out.push_str("[private key hidden]\n");
            continue;
        }
        if in_key {
            in_key = !(line.contains("-----END") && line.contains("PRIVATE KEY"));
            continue;
        }
        out.push_str(&mask_line(line));
        out.push('\n');
    }
    if !text.ends_with('\n') {
        out.pop();
    }
    out
}

fn mask_line(line: &str) -> String {
    let lower = line.to_lowercase();
    // "password=…", "token: …", "Authorization: Bearer …": what follows is hidden.
    for key in [
        "password",
        "passwd",
        "secret",
        "token",
        "api_key",
        "apikey",
        "api-key",
        "authorization",
    ] {
        if let Some(at) = lower.find(key) {
            let rest = &line[at + key.len()..];
            if let Some(sep) = rest.find([':', '=']) {
                let value = rest[sep + 1..].trim();
                if !value.is_empty() {
                    let cut = at + key.len() + sep + 1;
                    return format!("{} [hidden]", line[..cut].trim_end());
                }
            }
        }
    }
    // Keys that announce themselves: GitHub, OpenAI, Anthropic, AWS, Slack.
    line.split(' ')
        .map(|word| {
            let token =
                word.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '-');
            let known = [
                "ghp_",
                "gho_",
                "github_pat_",
                "sk-",
                "xoxb-",
                "xoxp-",
                "AKIA",
            ]
            .iter()
            .any(|prefix| token.starts_with(prefix) && token.len() >= 20);
            if known {
                "[hidden]".to_owned()
            } else {
                word.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(day: u32, hour: u32, minute: u32) -> i64 {
        Local
            .with_ymd_and_hms(2026, 10, day, hour, minute, 0)
            .single()
            .unwrap()
            .timestamp_millis()
    }

    #[test]
    fn a_conversation_never_outlives_its_day() {
        let mut chat = Chat::default();
        assert!(!chat.expired(at(23, 12, 0), Keep::Day));
        chat.push(Item::said("halo", false, at(23, 9, 0)));
        assert!(!chat.expired(at(23, 23, 59), Keep::Day));
        assert!(chat.expired(at(24, 0, 1), Keep::Day));
        // Quiet for 31 minutes with the 30-minute setting; 29 is fine.
        assert!(chat.expired(at(23, 9, 31), Keep::parse("idle-30m")));
        assert!(!chat.expired(at(23, 9, 29), Keep::parse("idle-30m")));
        assert!(!chat.expired(at(23, 10, 59), Keep::parse("idle-2h")));
        assert!(chat.expired(at(24, 0, 1), Keep::parse("idle-2h")));
    }

    #[test]
    fn keeps_the_newest_messages() {
        let mut chat = Chat::default();
        for n in 0..SHOWN + 7 {
            chat.push(Item::answer(&n.to_string(), n as i64));
        }
        assert_eq!(chat.items.len(), SHOWN);
        assert_eq!(chat.items[0].text, "7");
        assert_eq!(chat.last, (SHOWN + 6) as i64);
        let json: serde_json::Value = serde_json::from_str(&chat.history()).unwrap();
        assert_eq!(
            json[0],
            serde_json::json!({"role": "assistant", "text": "7", "at": 7})
        );
    }

    #[test]
    fn hides_secrets_in_output() {
        let output = "ok\nexport GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123\nAuthorization: Bearer abc.def\n\
                      -----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\nkey sk-ant-api03-abcdefghijklmnop done\npassword: hunter2";
        let masked = mask_secrets(output);
        for secret in ["ghp_abc", "abc.def", "AAAA", "sk-ant", "hunter2"] {
            assert!(!masked.contains(secret), "{secret} left in:\n{masked}");
        }
        assert!(masked.starts_with("ok\n") && masked.contains("[private key hidden]"));
        assert!(masked.contains("key [hidden] done"));
        assert_eq!(
            mask_secrets("Unpacking libreoffice-core ..."),
            "Unpacking libreoffice-core ..."
        );
    }
}

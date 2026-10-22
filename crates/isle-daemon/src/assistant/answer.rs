// SPDX-License-Identifier: GPL-3.0-or-later

//! What every AI answers with, whichever the user picked: a JSON object of what to say, the actions
//! Isle runs, whether it is done or wants to see what they did first, and whether to listen again.

use serde::Deserialize;
use serde_json::Value;

/// What the model must answer with; the extension runs the actions.
pub const SCHEMA: &str = r#"{"type":"object","required":["say","actions"],"properties":{
"say":{"type":"string"},"listen":{"type":"boolean"},"done":{"type":"boolean"},
"actions":{"type":"array","items":{"type":"object","required":["type"],"properties":{
"type":{"type":"string","enum":["open_url","open_app","media","focus","add_task","add_event",
"volume","wifi","bluetooth","dnd","remind","settings","terminal","close_app","open_folder","brightness","dark_mode","night_light","done_task","remove_task","cancel_reminder","remove_event","play_music","window","find_files","list_folder","recent_files","read_text","find_apps","top_processes","chrome_profiles","open_file","reveal_file","chrome_profile","notifications","screenshot","lock","write","arrange"]},
"url":{"type":"string"},"app":{"type":"string"},"command":{"type":"string"},
"text":{"type":"string"},"date":{"type":"string"},"level":{"type":"number"},
"minutes":{"type":"number"},"on":{"type":"boolean"},"panel":{"type":"string"},"path":{"type":"string"},"id":{"type":"number"},"query":{"type":"string"},"uri":{"type":"string"},
"terms":{"type":"array","items":{"type":"string"}},"in":{"type":"string"},"kind":{"type":"string"},
"profile":{"type":"string"},"title":{"type":"string"},"layout":{"type":"string"},
"apps":{"type":"array","items":{"type":"string"}}}}}}}"#;

#[derive(Debug, Clone, Deserialize)]
pub struct Answer {
    pub say: String,
    #[serde(default)]
    pub actions: Vec<Value>,
    /// The answer asks the user something, so Isle listens again at once.
    #[serde(default)]
    pub listen: bool,
    /// False while the AI wants its actions run and their results back before it goes on.
    #[serde(default = "yes")]
    pub done: bool,
    /// The tools isled ran for this answer, in order (see agent.rs).
    #[serde(skip)]
    pub tools: Vec<String>,
    /// Its actions already ran and worked, but those left for once the island closes (see agent.rs).
    #[serde(skip)]
    pub checked: bool,
}

impl Answer {
    /// Just words: what an AI said without the JSON asked for, or an error.
    pub fn plain(say: impl Into<String>) -> Self {
        Self {
            say: say.into(),
            actions: Vec::new(),
            listen: false,
            done: true,
            tools: Vec::new(),
            checked: false,
        }
    }
}

fn yes() -> bool {
    true
}

/// The answer in `text`: its JSON, also inside a ```json fence, else the text as said, without actions.
pub fn from_text(text: &str) -> Answer {
    let text = text.trim();
    let inner = text
        .strip_prefix("```json")
        .or_else(|| text.strip_prefix("```"))
        .and_then(|rest| rest.trim_end().strip_suffix("```"))
        .map_or(text, str::trim);
    serde_json::from_str(inner).unwrap_or_else(|_| Answer::plain(text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_an_answer_however_it_is_wrapped() {
        let json = r#"{"say": "Opened", "actions": [{"type": "open_app", "app": "Files"}]}"#;
        assert_eq!(from_text(json).actions.len(), 1);
        assert_eq!(from_text(&format!("```json\n{json}\n```")).actions.len(), 1);
        assert_eq!(from_text(&format!("```\n{json}\n```")).say, "Opened");
        let plain = from_text("  Sure, it is 3 pm.  ");
        assert_eq!(plain.say, "Sure, it is 3 pm.");
        assert!(plain.actions.is_empty() && plain.done);
    }
}

// SPDX-License-Identifier: GPL-3.0-or-later

//! What every AI answers with, whichever the user picked: a JSON object of what to say, the actions
//! Isle runs, and whether to listen again.

use serde::Deserialize;
use serde_json::Value;

/// What the model must answer with; the extension runs the actions.
pub const SCHEMA: &str = r#"{"type":"object","required":["say","actions"],"properties":{
"say":{"type":"string"},"listen":{"type":"boolean"},
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
    /// The tools isled ran for this answer, in order (see agent.rs).
    #[serde(skip)]
    pub tools: Vec<String>,
}

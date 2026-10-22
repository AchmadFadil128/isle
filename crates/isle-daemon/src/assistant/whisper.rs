// SPDX-License-Identifier: GPL-3.0-or-later

//! Speech to text: `isle-whisper.py` (faster-whisper) in the venv `isle-setup-voice` makes.

use std::path::PathBuf;
use std::process::Stdio;

use anyhow::{Context, bail};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use crate::store::{data_dir, write_private};

pub struct Whisper {
    _child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    ready: bool,
    /// Where a recording waits for the helper; removed after each one, and on drop.
    audio: PathBuf,
}

/// The venv's Python and the helper script, when set up.
fn helper() -> Option<(PathBuf, PathBuf)> {
    let python = data_dir().join("voice-venv/bin/python");
    let script = data_dir().join("isle-whisper.py");
    (python.exists() && script.exists()).then_some((python, script))
}

pub fn installed() -> bool {
    helper().is_some()
}

impl Whisper {
    /// Starts the helper; it loads the model while the user is still speaking.
    pub fn start(model: &str, language: &str) -> anyhow::Result<Self> {
        let (python, script) = helper().context("speech recognition is not set up")?;
        let mut child = Command::new(python)
            .arg("-I")
            .arg(script)
            .args(["--model", model, "--language", language])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .context("could not start speech recognition")?;
        let stdin = child.stdin.take().expect("piped stdin");
        let lines = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
        // A private folder: the session's runtime directory, else Isle's own data folder.
        let audio = dirs::runtime_dir()
            .unwrap_or_else(data_dir)
            .join(format!("isle-voice-{}.pcm", std::process::id()));
        Ok(Self {
            _child: child,
            stdin,
            lines,
            ready: false,
            audio,
        })
    }

    async fn read(&mut self) -> anyhow::Result<Value> {
        let line = self
            .lines
            .next_line()
            .await?
            .context("speech recognition stopped")?;
        let message: Value = serde_json::from_str(&line)?;
        if let Some(error) = message["error"].as_str() {
            bail!("{error}");
        }
        Ok(message)
    }

    pub async fn transcribe(&mut self, audio: &[i16]) -> anyhow::Result<String> {
        if !self.ready {
            self.read().await?;
            self.ready = true;
        }
        let result = self.ask(audio).await;
        // What was said is not left on disk, whatever happened.
        tokio::fs::remove_file(&self.audio).await.ok();
        result
    }

    async fn ask(&mut self, audio: &[i16]) -> anyhow::Result<String> {
        let bytes: Vec<u8> = audio.iter().flat_map(|s| s.to_le_bytes()).collect();
        write_private(&self.audio, &bytes)?;
        let request = serde_json::json!({"audio": self.audio});
        self.stdin
            .write_all(format!("{request}\n").as_bytes())
            .await?;
        Ok(self.read().await?["text"]
            .as_str()
            .unwrap_or_default()
            .to_owned())
    }
}

impl Drop for Whisper {
    // Dropped mid-way (the user closed the island), the recording is still removed.
    fn drop(&mut self) {
        std::fs::remove_file(&self.audio).ok();
    }
}

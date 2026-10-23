// SPDX-License-Identifier: GPL-3.0-or-later

//! What the user's login shell sets that isled lacks, started by systemd from the desktop session: where
//! their programs are (nvm, Homebrew, a custom npm prefix…), and what their AI CLIs read (another config
//! folder, an API key, a proxy). Asked once at start, as code editors do; what systemd already sets wins.

use std::ffi::OsString;
use std::io::Read;
use std::os::unix::ffi::OsStringExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// A shell slower than this (a prompt, a network mount) is left behind.
const TIMEOUT: Duration = Duration::from_secs(3);
/// What comes before the environment, so whatever the startup files print is skipped.
const MARK: &str = "ISLE-ENV-1f2e";

/// Variables taken over, by name or by the start of it.
const KEPT: &[&str] = &[
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "CLOUD_ML_REGION",
    "NODE_EXTRA_CA_CERTS",
    "NODE_OPTIONS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NVM_DIR",
    "VOLTA_HOME",
    "PNPM_HOME",
    "BUN_INSTALL",
    "FNM_DIR",
    "N_PREFIX",
    "NPM_CONFIG_PREFIX",
];
const KEPT_PREFIXES: &[&str] = &["ANTHROPIC_", "CLAUDE_CODE_", "AWS_", "VERTEX_"];
const PROXIES: &[&str] = &["http_proxy", "https_proxy", "no_proxy", "all_proxy"];

/// Takes over what the login shell sets. Call it before any other thread runs.
pub fn import() {
    let started = Instant::now();
    let Some(env) = login_env() else {
        return;
    };
    let mut taken = 0;
    for (name, value) in env {
        let Some(name) = name.to_str().map(str::to_owned) else {
            continue;
        };
        if name == "PATH" {
            if let Some(path) = joined_path(&value) {
                // SAFETY: called first thing, before isled starts any thread.
                unsafe { std::env::set_var("PATH", path) };
            }
            continue;
        }
        let wanted = KEPT.contains(&name.as_str())
            || KEPT_PREFIXES.iter().any(|prefix| name.starts_with(prefix))
            || PROXIES.contains(&name.to_lowercase().as_str());
        if wanted && std::env::var_os(&name).is_none() {
            // SAFETY: as above.
            unsafe { std::env::set_var(&name, &value) };
            taken += 1;
        }
    }
    log::info!(
        "took {taken} settings and the PATH from the login shell in {} ms",
        started.elapsed().as_millis()
    );
}

/// isled's PATH, then the shell's folders it lacks.
fn joined_path(shell: &OsString) -> Option<OsString> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    let before = dirs.len();
    for dir in std::env::split_paths(shell) {
        if dir.is_absolute() && !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    (dirs.len() > before).then(|| std::env::join_paths(dirs).ok())?
}

/// The environment of an interactive login shell, where version managers set themselves up.
fn login_env() -> Option<Vec<(OsString, OsString)>> {
    let shell = user_shell()?;
    let mut child = Command::new(&shell)
        .args(["-l", "-i", "-c", &format!("printf {MARK}; env -0")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).ok();
        bytes
    });
    let deadline = Instant::now() + TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                log::warn!(
                    "the login shell ({}) took too long; going on without it",
                    shell.display()
                );
                child.kill().ok();
                child.wait().ok();
                return None;
            }
        }
    }
    let bytes = reader.join().ok()?;
    Some(parse(&bytes))
}

/// `env -0`'s output after the mark: NAME=value, each ended by a NUL.
fn parse(bytes: &[u8]) -> Vec<(OsString, OsString)> {
    let start = bytes
        .windows(MARK.len())
        .rposition(|window| window == MARK.as_bytes())
        .map_or(bytes.len(), |at| at + MARK.len());
    bytes[start..]
        .split(|&b| b == 0)
        .filter_map(|entry| {
            let at = entry.iter().position(|&b| b == b'=')?;
            (at > 0).then(|| {
                (
                    OsString::from_vec(entry[..at].to_vec()),
                    OsString::from_vec(entry[at + 1..].to_vec()),
                )
            })
        })
        .collect()
}

/// The user's shell: $SHELL, else their entry in the password database.
fn user_shell() -> Option<PathBuf> {
    let shell = std::env::var_os("SHELL").map(PathBuf::from).or_else(|| {
        // SAFETY: getpwuid returns a pointer into static storage, read at once.
        let entry = unsafe { libc::getpwuid(libc::getuid()) };
        if entry.is_null() {
            return None;
        }
        let shell = unsafe { std::ffi::CStr::from_ptr((*entry).pw_shell) };
        Some(PathBuf::from(OsString::from_vec(shell.to_bytes().to_vec())))
    })?;
    // A login that cannot run commands (nologin, false) has nothing to give.
    let name = shell.file_name()?.to_string_lossy().into_owned();
    (shell.is_absolute() && shell.is_file() && !matches!(name.as_str(), "nologin" | "false"))
        .then_some(shell)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_environment_after_the_mark() {
        let mut out = b"Welcome back!\n".to_vec();
        out.extend(MARK.as_bytes());
        out.extend(b"PATH=/a:/b\0CODEX_HOME=/x/codex\0EMPTY=\0ODD\0");
        let env = parse(&out);
        assert_eq!(env.len(), 3);
        assert_eq!(env[0], ("PATH".into(), "/a:/b".into()));
        assert_eq!(env[1], ("CODEX_HOME".into(), "/x/codex".into()));
        assert!(parse(b"no mark here").is_empty());
    }

    #[test]
    fn asks_a_real_shell() {
        // sh -l -i reads little; it still answers with an environment and a PATH.
        let env = parse(
            &Command::new("/bin/sh")
                .args(["-c", &format!("printf {MARK}; env -0")])
                .output()
                .unwrap()
                .stdout,
        );
        assert!(env.iter().any(|(name, _)| name == "PATH"));
    }
}

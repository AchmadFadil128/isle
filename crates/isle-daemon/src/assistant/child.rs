// SPDX-License-Identifier: GPL-3.0-or-later

//! The helpers isled starts for the assistant (the AI CLIs, speech recognition): each leads a process
//! group of its own at a lower priority, so the desktop stays smooth while they work, and nothing they
//! start outlives them.

use std::ops::{Deref, DerefMut};

use tokio::process::{Child, Command};

/// How much they give way to the desktop (see nice(1)).
const NICENESS: libc::c_int = 10;

/// A started helper; dropped, its whole process group is killed.
pub struct Group(Child);

/// Starts `command` in a process group of its own, at a lower priority. Its own folder leads its PATH, so
/// a CLI that starts with `#!/usr/bin/env node` finds the Node installed beside it (nvm, volta…).
pub fn spawn(command: &mut Command) -> std::io::Result<Group> {
    let program = std::path::PathBuf::from(command.as_std().get_program());
    if let Some(dir) = program.parent().filter(|dir| !dir.as_os_str().is_empty()) {
        let path = std::env::var_os("PATH").unwrap_or_default();
        let dirs = std::iter::once(dir.to_path_buf()).chain(std::env::split_paths(&path));
        if let Ok(joined) = std::env::join_paths(dirs) {
            command.env("PATH", joined);
        }
    }
    let child = command.process_group(0).kill_on_drop(true).spawn()?;
    if let Some(pid) = child.id() {
        // SAFETY: setpriority only reads its plain integer arguments.
        unsafe { libc::setpriority(libc::PRIO_PGRP, pid, NICENESS) };
    }
    Ok(Group(child))
}

impl Drop for Group {
    fn drop(&mut self) {
        // Its group, led by it: the node workers or servers an AI CLI starts go with it.
        if let Some(pid) = self.0.id().and_then(|pid| libc::pid_t::try_from(pid).ok()) {
            // SAFETY: killpg only reads its plain integer arguments.
            unsafe { libc::killpg(pid, libc::SIGKILL) };
        }
    }
}

impl Deref for Group {
    type Target = Child;

    fn deref(&self) -> &Child {
        &self.0
    }
}

impl DerefMut for Group {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn takes_its_whole_group_along() {
        // A shell that leaves a grandchild running, as an AI CLI's node workers would.
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30 & echo $!; wait"]);
        command.stdout(std::process::Stdio::piped());
        let mut group = spawn(&mut command).unwrap();
        let stdout = group.stdout.take().unwrap();
        let mut lines = tokio::io::AsyncBufReadExt::lines(tokio::io::BufReader::new(stdout));
        let grandchild: i32 = lines.next_line().await.unwrap().unwrap().parse().unwrap();
        drop(group);
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        // Gone, or a zombie left for whoever adopted it to reap.
        let state = std::fs::read_to_string(format!("/proc/{grandchild}/stat")).unwrap_or_default();
        let alive = state
            .rsplit(')')
            .next()
            .is_some_and(|rest| !rest.trim_start().starts_with('Z') && !rest.is_empty());
        assert!(!alive, "the grandchild outlived its group");
    }
}

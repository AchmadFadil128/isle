// SPDX-License-Identifier: GPL-3.0-or-later

//! `check`: commands that only look (which Linux, whether a package is installed or available, a
//! program's version), run at once for the AI without asking the user. Only what is listed here runs, as
//! a program with its arguments, never through a shell, so nothing in them can chain another command.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::Command;

use super::chat::mask_secrets;
use super::child;

/// A look taking longer than this is stopped.
const TIMEOUT: Duration = Duration::from_secs(20);
/// What the AI gets of the output, at most (the end of it, where the answer usually is).
const MAX_OUTPUT: usize = 4000;

/// The programs `check` runs, each with the first arguments that keep it to looking. `None` takes any
/// arguments that are plain words (package names), `Some` lists the subcommands or options allowed first.
const ALLOWED: &[(&str, Option<&[&str]>)] = &[
    ("uname", Some(&["-a", "-r", "-m", "-s", "-o"])),
    ("lsb_release", Some(&["-a", "-d", "-r", "-c"])),
    ("cat", Some(&["/etc/os-release", "/etc/lsb-release"])),
    (
        "apt-cache",
        Some(&["policy", "show", "search", "madison", "showpkg"]),
    ),
    ("apt", Some(&["list", "show", "search", "policy"])),
    (
        "dpkg",
        Some(&["-s", "-l", "-L", "--status", "--list", "--listfiles"]),
    ),
    (
        "dpkg-query",
        Some(&["-W", "-s", "-l", "--show", "--status", "--list"]),
    ),
    ("rpm", Some(&["-q", "-qi", "-qa", "-ql", "--query"])),
    (
        "dnf",
        Some(&["info", "list", "search", "provides", "repolist"]),
    ),
    ("pacman", Some(&["-Si", "-Qi", "-Ss", "-Q", "-Qs", "-Ql"])),
    (
        "zypper",
        Some(&["info", "se", "search", "if", "lr", "repos"]),
    ),
    (
        "flatpak",
        Some(&["search", "info", "list", "remote-ls", "remotes"]),
    ),
    ("snap", Some(&["find", "info", "list", "version"])),
    (
        "npm",
        Some(&["view", "ls", "list", "-v", "--version", "config"]),
    ),
    ("pipx", Some(&["list"])),
    ("node", Some(&["-v", "--version"])),
    ("python3", Some(&["--version", "-V"])),
    (
        "systemctl",
        Some(&["status", "is-active", "is-enabled", "list-units"]),
    ),
    ("df", None),
    ("free", None),
    ("lscpu", None),
    ("lspci", None),
    ("lsusb", None),
    ("nvidia-smi", None),
    ("which", None),
];
/// Options and words that make a package tool change the system, refused anywhere in a check.
const CHANGES: &[&str] = &[
    "-i",
    "--install",
    "install",
    "-r",
    "--remove",
    "remove",
    "-P",
    "--purge",
    "purge",
    "--configure",
    "-S",
    "-R",
    "-U",
    "-e",
    "--erase",
    "--setopt",
    "-y",
    "--yes",
    "--assumeyes",
    "upgrade",
    "update",
    "reinstall",
    "uninstall",
    "--root",
    "--admindir",
    "-o",
    "--option",
    "--refresh",
    "erase",
    "start",
    "stop",
    "restart",
    "enable",
    "disable",
    "mask",
    "--set",
    "set",
    "delete",
    "config-set",
];

/// Any program may say its version.
const VERSION: &[&str] = &["--version", "-V", "version"];

/// `command` as a program and its arguments if it may run as a check, else why not.
pub fn parse(command: &str) -> Result<Vec<String>, String> {
    // It runs without a shell, so `$`, quotes and globs are only letters; what would chain or redirect
    // commands in a shell is refused, so the AI learns a check is one command.
    if command.chars().any(|c| ";|&<>`\n".contains(c)) {
        return Err("a check is one command, without pipes, redirects or a second command".into());
    }
    let words = split(command)?;
    let Some((program, args)) = words.split_first() else {
        return Err("the check is empty".into());
    };
    if program.contains('/') {
        return Err("a check names a program, not a path".into());
    }
    // "command -v x" is how scripts ask whether x is installed; `which` answers the same.
    if program == "command" && args.first().map(String::as_str) == Some("-v") {
        return Ok(std::iter::once("which".to_owned())
            .chain(args[1..].iter().cloned())
            .collect());
    }
    if args.len() == 1 && VERSION.contains(&args[0].as_str()) {
        return Ok(words);
    }
    let Some((_, first)) = ALLOWED.iter().find(|(name, _)| name == program) else {
        return Err(format!(
            "{program} is not one of the commands a check may run"
        ));
    };
    // After the first word that keeps it to looking, nothing that would make it change things.
    let plain = |arg: &String| !CHANGES.contains(&arg.split('=').next().unwrap_or_default());
    match first {
        None => Ok(words),
        Some(first) => {
            let ok = args
                .first()
                .is_some_and(|arg| first.contains(&arg.as_str()))
                && args.iter().skip(1).all(plain);
            if ok {
                Ok(words)
            } else {
                Err(format!(
                    "{program} may only run as: {program} {}",
                    first.join(" | ")
                ))
            }
        }
    }
}

/// Words of `command`, with '…' and "…" quoting kept together.
fn split(command: &str) -> Result<Vec<String>, String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut started = false;
    for c in command.chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => word.push(c),
            (None, '\'' | '"') => {
                quote = Some(c);
                started = true;
            }
            (None, c) if c.is_whitespace() => {
                if started || !word.is_empty() {
                    words.push(std::mem::take(&mut word));
                    started = false;
                }
            }
            (None, c) => word.push(c),
        }
    }
    if quote.is_some() {
        return Err("a quote is left open".into());
    }
    if started || !word.is_empty() {
        words.push(word);
    }
    Ok(words)
}

/// Where a program for a check is looked for: the system's folders and the user's own.
fn find(program: &str) -> Option<PathBuf> {
    let home = dirs::home_dir().unwrap_or_default();
    [
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/usr/local/bin",
        "/snap/bin",
    ]
    .iter()
    .map(PathBuf::from)
    .chain([home.join(".local/bin")])
    .map(|dir| dir.join(program))
    .find(|path| path.is_file())
}

/// Runs the check `command`: its output (the end of it, secrets hidden) and exit code, as text for the AI.
pub async fn run(command: &str) -> String {
    let words = match parse(command) {
        Ok(words) => words,
        Err(why) => {
            return format!(
                "check `{command}` did not run: {why}. Propose it with run instead if it is needed."
            );
        }
    };
    if words[0] == "which" {
        let found: Vec<String> = words[1..]
            .iter()
            .map(|name| match find(name) {
                Some(path) => path.display().to_string(),
                None => format!("{name}: not installed"),
            })
            .collect();
        return format!("check `{command}`:\n{}", found.join("\n"));
    }
    let Some(program) = find(&words[0]) else {
        return format!("check `{command}`: {} is not installed", words[0]);
    };
    match output(&program, &words[1..]).await {
        Ok((code, text)) => format!("check `{command}` (exit {code}):\n{text}"),
        Err(why) => format!("check `{command}` failed: {why}"),
    }
}

async fn output(program: &Path, args: &[String]) -> anyhow::Result<(i32, String)> {
    let mut command = Command::new(program);
    command
        .args(args)
        .env("LANG", "C.UTF-8")
        .env("LC_ALL", "C.UTF-8")
        .env("PAGER", "cat")
        .env("SYSTEMD_PAGER", "")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = child::spawn(&mut command)?;
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let read = async {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let (a, b) = tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err));
        a?;
        b?;
        let status = child.wait().await?;
        out.extend(err);
        anyhow::Ok((status.code().unwrap_or(-1), out))
    };
    let (code, bytes) = tokio::time::timeout(TIMEOUT, read)
        .await
        .map_err(|_| anyhow::anyhow!("it took longer than {} s", TIMEOUT.as_secs()))??;
    Ok((
        code,
        tail(&mask_secrets(&String::from_utf8_lossy(&bytes)), MAX_OUTPUT),
    ))
}

/// The last `max` bytes of `text`, cut at a line where it can be.
pub fn tail(text: &str, max: usize) -> String {
    let text = text.trim_end();
    if text.len() <= max {
        return text.to_owned();
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    let cut = &text[start..];
    let cut = cut.find('\n').map_or(cut, |at| &cut[at + 1..]);
    format!("…\n{cut}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lets_only_looking_through() {
        for ok in [
            "apt-cache policy libreoffice",
            "dpkg -s libreoffice-core",
            "flatpak search libreoffice",
            "uname -a",
            "cat /etc/os-release",
            "libreoffice --version",
            "codex --version",
            "snap info code",
            "npm view @openai/codex version",
            "pacman -Qi firefox",
            "dnf info 'libreoffice-writer'",
            "dpkg-query -W -f='${Status} ${Version}' libreoffice",
            "apt list --installed vlc",
            "flatpak list --app --columns=application",
            "rpm -q --qf '%{VERSION}' firefox",
        ] {
            assert!(parse(ok).is_ok(), "{ok}: {:?}", parse(ok));
        }
        assert_eq!(parse("command -v node").unwrap(), ["which", "node"]);
        for refused in [
            "apt install libreoffice",
            "apt-cache policy x; rm -rf ~",
            "cat ~/.ssh/id_rsa",
            "dpkg -i evil.deb",
            "flatpak install flathub org.libreoffice.LibreOffice",
            "sh -c 'echo hi'",
            "dpkg -s x -i y.deb",
            "rpm -q x --erase y",
            "npm config set prefix /tmp",
            "apt-cache policy x | head",
            "/tmp/evil --version",
            "rm --version x",
            "snap find x && reboot",
            "npm install -g x",
            "systemctl stop gdm",
            "echo $HOME",
            "dnf info x --setopt=y",
        ] {
            assert!(parse(refused).is_err(), "{refused} was let through");
        }
    }

    #[test]
    fn keeps_the_end_of_long_output() {
        let long: String = (0..2000).map(|n| format!("line {n}\n")).collect();
        let cut = tail(&long, 100);
        assert!(cut.starts_with("…\nline ") && cut.ends_with("line 1999") && cut.len() <= 110);
        assert_eq!(tail("short\n", 100), "short");
    }

    #[tokio::test]
    async fn runs_a_check_and_says_what_is_missing() {
        let said = run("uname -s").await;
        assert!(
            said.starts_with("check `uname -s` (exit 0):\nLinux"),
            "{said}"
        );
        assert!(
            run("command -v no-such-program-isle")
                .await
                .contains("not installed")
        );
        assert!(run("apt install x").await.contains("did not run"));
    }
}

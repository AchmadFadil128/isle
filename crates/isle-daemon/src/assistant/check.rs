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

/// What a word after the first may be, for each program `check` runs.
#[derive(Clone, Copy)]
enum Rest {
    /// Nothing more.
    None,
    /// Package, app or unit names (see `is_name`), and these options.
    Names(&'static [&'static str]),
    /// Only these options.
    Options(&'static [&'static str]),
}

/// The programs `check` runs: the first word that keeps each to looking (empty: none needed), then what
/// may follow. Exact shapes only, so no option can make one write, run or read anything else.
const ALLOWED: &[(&str, &[&str], Rest)] = &[
    ("uname", &["", "-a", "-r", "-m", "-s", "-o"], Rest::None),
    (
        "lsb_release",
        &["-a", "-d", "-r", "-c", "-ds", "-rs", "-cs", "-is"],
        Rest::None,
    ),
    ("cat", &["/etc/os-release", "/etc/lsb-release"], Rest::None),
    (
        "apt-cache",
        &["policy", "show", "search", "madison", "showpkg"],
        Rest::Names(&["--names-only", "--full"]),
    ),
    (
        "apt",
        &["list", "show", "search", "policy"],
        Rest::Names(&["--installed", "--upgradable", "-a", "--all-versions"]),
    ),
    (
        "dpkg",
        &["-s", "-l", "-L", "--status", "--list", "--listfiles"],
        Rest::Names(&[]),
    ),
    (
        "dpkg-query",
        &["-W", "-s", "-l", "--show", "--status", "--list"],
        Rest::Names(&["-f", "--showformat"]),
    ),
    (
        "rpm",
        &["-q", "-qi", "-qa", "-ql", "--query"],
        Rest::Names(&["--qf", "--queryformat", "-i", "--info"]),
    ),
    (
        "dnf",
        &["info", "list", "search", "provides", "repolist"],
        Rest::Names(&[
            "--installed",
            "--available",
            "-q",
            "--quiet",
            "-C",
            "--cacheonly",
        ]),
    ),
    (
        "pacman",
        &["-Si", "-Qi", "-Ss", "-Q", "-Qs", "-Ql"],
        Rest::Names(&[]),
    ),
    (
        "zypper",
        &["info", "se", "search", "if", "lr", "repos"],
        Rest::Names(&["--installed-only"]),
    ),
    (
        "flatpak",
        &["search", "info", "list", "remote-ls", "remotes"],
        Rest::Names(&[
            "--app",
            "--runtime",
            "--user",
            "--system",
            "--updates",
            "--columns",
        ]),
    ),
    (
        "snap",
        &["find", "info", "list", "version"],
        Rest::Names(&[]),
    ),
    (
        "npm",
        &["view", "ls", "list", "-v", "--version"],
        Rest::Names(&["-g", "--global", "--depth", "--json"]),
    ),
    ("pipx", &["list"], Rest::Options(&["--short"])),
    ("node", &["-v", "--version"], Rest::None),
    ("python3", &["--version", "-V"], Rest::None),
    (
        "systemctl",
        &["status", "is-active", "is-enabled", "list-units"],
        Rest::Names(&["--user", "--no-pager", "--type", "--state", "--all"]),
    ),
    (
        "df",
        &["", "-h", "-H", "-T", "-hT", "-l"],
        Rest::Options(&["-h", "-T", "-l", "--total"]),
    ),
    (
        "free",
        &["", "-h", "-m", "-g", "--si"],
        Rest::Options(&["-h", "-t", "--si"]),
    ),
    ("lscpu", &[""], Rest::None),
    (
        "lspci",
        &["", "-k", "-nn", "-v"],
        Rest::Options(&["-k", "-nn"]),
    ),
    ("lsusb", &["", "-t"], Rest::None),
    (
        "nvidia-smi",
        &["", "-q", "-L", "--query-gpu"],
        Rest::Options(&["--format"]),
    ),
    ("which", &[], Rest::Names(&[])),
];

/// Options whose value may follow an `=` (and only a plain one: letters, digits, `,.:_-${}%`).
const VALUED: &[&str] = &[
    "-f",
    "--showformat",
    "--qf",
    "--queryformat",
    "--columns",
    "--depth",
    "--type",
    "--state",
    "--query-gpu",
    "--format",
];

/// Programs that are never asked their version: what they do, they may do whatever the word.
const NEVER_RUN: &[&str] = &[
    "reboot",
    "poweroff",
    "shutdown",
    "halt",
    "rm",
    "rmdir",
    "dd",
    "mkfs",
    "kill",
    "pkill",
    "killall",
    "sudo",
    "pkexec",
    "su",
    "systemctl",
    "loginctl",
    "shred",
    "truncate",
    "mv",
    "cp",
    "chmod",
    "chown",
];

/// A package, app, unit or command name: letters, digits and `@._+:*~/-`, never starting with `-` or `/`,
/// nor going up a folder.
fn is_name(word: &str) -> bool {
    word.chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric() || c == '@')
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "@._+:*~/-".contains(c))
        && !word.contains("..")
}

/// Whether `word` is one of `options`, alone or (for `VALUED` ones) with a plain value.
fn is_option(word: &str, options: &[&str]) -> bool {
    let (name, value) = word
        .split_once('=')
        .map_or((word, None), |(n, v)| (n, Some(v)));
    options.contains(&name)
        && match value {
            None => true,
            Some(value) => {
                VALUED.contains(&name)
                    && !value.contains("%(")
                    && value
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || " ,.:_-${}%\\t\\n".contains(c))
            }
        }
}

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
    if !is_name(program) || program.contains('/') {
        return Err("a check names a program, not a path".into());
    }
    // "command -v x" is how scripts ask whether x is installed; `which` answers the same.
    if program == "command" && args.first().map(String::as_str) == Some("-v") {
        let names = &args[1..];
        return if !names.is_empty()
            && names
                .iter()
                .all(|name| is_name(name) && !name.contains('/'))
        {
            Ok(std::iter::once("which".to_owned())
                .chain(names.iter().cloned())
                .collect())
        } else {
            Err("command -v takes program names".into())
        };
    }
    let Some((_, first, rest)) = ALLOWED.iter().find(|(name, ..)| name == program) else {
        // Any program may say its version, but only that.
        return if args.len() == 1
            && args[0] == "--version"
            && !NEVER_RUN.contains(&program.as_str())
        {
            Ok(words)
        } else {
            Err(format!(
                "{program} is not one of the commands a check may run; `{program} --version` is"
            ))
        };
    };
    let shape = || {
        let firsts = first
            .iter()
            .filter(|word| !word.is_empty())
            .copied()
            .collect::<Vec<_>>();
        format!(
            "{program} may only run as: {program} {}",
            firsts.join(" | ")
        )
    };
    // The first word, unless the program needs none (`which`) or may run bare ("").
    let mut rest_args = args;
    if !first.is_empty() {
        match args.first() {
            Some(arg)
                if first.contains(&arg.as_str())
                    || (arg.starts_with("--query-gpu=") && first.contains(&"--query-gpu")) =>
            {
                rest_args = &args[1..];
                if arg.contains('=') && !is_option(arg, first) {
                    return Err(shape());
                }
            }
            None if first.contains(&"") => {}
            _ => return Err(shape()),
        }
    }
    let (options, names) = match rest {
        Rest::None => (&[][..], false),
        Rest::Options(options) => (*options, false),
        Rest::Names(options) => (*options, true),
    };
    let mut args = rest_args.iter();
    while let Some(arg) = args.next() {
        if is_option(arg, options) {
            // `--qf '%{VERSION}'`: the value as the next word.
            if VALUED.contains(&arg.as_str()) {
                let value = args.next().ok_or_else(shape)?;
                if !is_option(&format!("{arg}={value}"), options) {
                    return Err(shape());
                }
            }
        } else if !(names && is_name(arg) && (*program != "which" || !arg.contains('/'))) {
            return Err(shape());
        }
    }
    Ok(words)
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

/// Where a program for a check is looked for: the system's folders, then where the user's own programs
/// are (as the AI CLIs are looked for: npm, nvm, Homebrew…).
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
    .chain(super::install_dirs(&home))
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
    // A Node program (npm, codex) finds the Node installed beside it.
    if let Some(path) = super::child::path_for(program) {
        command.env("PATH", path);
    }
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
            "uname",
            "df -h",
            "free -h",
            "nvidia-smi --query-gpu=name,memory.total --format=csv",
            "systemctl status --user isled",
            "which node npm",
            "lsb_release -ds",
            "npm ls -g --depth=0",
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
            // Read another file, run a program, write a file, act on a word, reach another host.
            "cat /etc/os-release /home/ana/.git-credentials",
            "cat /etc/os-release ../../etc/shadow",
            "npm config edit --editor=sh",
            "npm config get prefix",
            "rpm -q x --pipe sh",
            "rpm -q --qf '%(id)' x",
            "rpm -q -E '%(touch /tmp/x)'",
            "nvidia-smi -f /home/ana/.bashrc",
            "rm version",
            "reboot --version",
            "rm --version",
            "systemctl status -H evil.example x",
            "which /home/ana/.ssh/id_rsa",
            "dpkg -L ../../etc",
            "apt show -o Dir::Etc=/tmp x",
            "flatpak list --columns=$(id)",
            "uname -a extra",
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

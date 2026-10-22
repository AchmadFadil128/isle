// SPDX-License-Identifier: GPL-3.0-or-later

//! Facts about this computer for the AI, which may not look for itself: the system, battery, disk and memory.

use std::fs;
use std::path::Path;
use std::process::Command;

const GB: f64 = 1024.0 * 1024.0 * 1024.0;

/// A few lines such as "Battery: 77%, not charging; charge limit 60% (…)", all on one line each.
pub fn facts() -> String {
    let mut lines = vec![format!("The system: {}.", system())];
    if let Some(folders) = folders() {
        lines.push(format!("Folders in ~: {folders}."));
    }
    lines.extend(battery());
    let mut usage = Vec::new();
    if let Some((free, total)) = disk() {
        usage.push(format!(
            "{} free of {} on the disk (/)",
            gb(free),
            gb(total)
        ));
    }
    if let Some((free, total)) = fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|m| memory(&m))
    {
        usage.push(format!("{} of {} memory free", gb(free), gb(total)));
    }
    if !usage.is_empty() {
        lines.push(format!("Now: {}.", usage.join("; ")));
    }
    lines.join("\n")
}

/// The folders in the home folder, not hidden, sorted; at most 40.
fn folders() -> Option<String> {
    let mut names: Vec<String> = fs::read_dir(dirs::home_dir()?)
        .ok()?
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| !name.starts_with('.'))
        .collect();
    names.sort();
    names.truncate(40);
    (!names.is_empty()).then(|| names.join(", "))
}

fn read(path: impl AsRef<Path>) -> Option<String> {
    let value = fs::read_to_string(path).ok()?.trim().to_owned();
    (!value.is_empty()).then_some(value)
}

/// "Ubuntu 24.04.5 LTS, GNOME, on a ASUSTeK COMPUTER INC. TUF Gaming FX505GT".
fn system() -> String {
    let os = read("/etc/os-release")
        .and_then(|release| {
            release.lines().find_map(|line| {
                let name = line.strip_prefix("PRETTY_NAME=")?;
                Some(name.trim_matches('"').to_owned())
            })
        })
        .unwrap_or_else(|| "Linux".into());
    let machine = ["sys_vendor", "product_name"]
        .iter()
        .filter_map(|name| read(format!("/sys/class/dmi/id/{name}")))
        .collect::<Vec<_>>()
        .join(" ");
    if machine.is_empty() {
        format!("{os}, GNOME")
    } else {
        format!("{os}, GNOME, on a {machine}")
    }
}

/// Each battery's charge and state, and its charge limit with the file that sets it, when it has one.
fn battery() -> Vec<String> {
    let Ok(entries) = fs::read_dir("/sys/class/power_supply") else {
        return Vec::new();
    };
    let mut batteries: Vec<_> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| read(path.join("type")).as_deref() == Some("Battery"))
        .collect();
    batteries.sort();
    batteries
        .iter()
        .map(|path| {
            let mut line = format!(
                "Battery: {}%, {}",
                read(path.join("capacity")).unwrap_or_else(|| "?".into()),
                read(path.join("status"))
                    .unwrap_or_else(|| "unknown".into())
                    .to_lowercase()
            );
            let limit = path.join("charge_control_end_threshold");
            // From Isle's own install (~/.local/bin) or a system package (/usr/bin).
            let helper = dirs::home_dir()
                .map(|home| home.join(".local/bin"))
                .into_iter()
                .chain(std::env::var_os("PATH").iter().flat_map(std::env::split_paths))
                .any(|dir| dir.join("isle-charge-limit").is_file());
            match read(&limit) {
                // The helper keeps it after a restart, which writing the file alone does not.
                Some(value) if helper => line.push_str(&format!(
                    "; charge limit {value}% (set it, kept after a restart, with the terminal command \
                     `isle-charge-limit <percent>`; 100 removes it)"
                )),
                Some(value) => line.push_str(&format!(
                    "; charge limit {value}% (set by writing to {} as root; resets on restart)",
                    limit.display()
                )),
                None => line.push_str("; no charge limit setting"),
            }
            line.push('.');
            line
        })
        .collect()
}

/// Free and total bytes on /, from `df`.
fn disk() -> Option<(f64, f64)> {
    let output = Command::new("df").args(["-Pk", "/"]).output().ok()?;
    df(&String::from_utf8_lossy(&output.stdout))
}

fn df(output: &str) -> Option<(f64, f64)> {
    let fields: Vec<&str> = output.lines().nth(1)?.split_whitespace().collect();
    let kib = |index: usize| fields.get(index)?.parse::<f64>().ok().map(|k| k * 1024.0);
    Some((kib(3)?, kib(1)?))
}

/// Available and total bytes, from /proc/meminfo.
fn memory(meminfo: &str) -> Option<(f64, f64)> {
    let field = |name: &str| {
        meminfo.lines().find_map(|line| {
            let kib = line.strip_prefix(name)?.trim().strip_suffix("kB")?;
            kib.trim().parse::<f64>().ok().map(|k| k * 1024.0)
        })
    };
    Some((field("MemAvailable:")?, field("MemTotal:")?))
}

fn gb(bytes: f64) -> String {
    format!("{:.1} GB", bytes / GB)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_df() {
        let output = "Filesystem 1024-blocks Used Available Capacity Mounted on\n\
                      /dev/nvme0n1p2 490617784 256000000 209715200 56% /\n";
        let (free, total) = df(output).unwrap();
        assert_eq!(gb(free), "200.0 GB");
        assert_eq!(gb(total), "467.9 GB");
        assert_eq!(df("Filesystem\n"), None);
    }

    #[test]
    fn reads_meminfo() {
        let meminfo =
            "MemTotal:       16252928 kB\nMemFree:  1000 kB\nMemAvailable:    8126464 kB\n";
        let (free, total) = memory(meminfo).unwrap();
        assert_eq!((gb(free), gb(total)), ("7.8 GB".into(), "15.5 GB".into()));
    }
}

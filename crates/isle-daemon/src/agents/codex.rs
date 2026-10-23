// SPDX-License-Identifier: GPL-3.0-or-later

//! Codex's alerts: `notify = ["<isled>", "--agent-hook", "codex"]` in its config.toml, which Codex runs
//! with a JSON summary after each turn. Only set when no other program gets Codex's notifications.

use std::path::{Path, PathBuf};

use anyhow::{Context, bail};
use toml_edit::{Array, DocumentMut, Item, value};

use super::file;

/// `$CODEX_HOME/config.toml`, else `~/.codex/config.toml`.
pub fn config_path() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .filter(|dir| !dir.is_empty())
        .map_or_else(
            || dirs::home_dir().unwrap_or_default().join(".codex"),
            PathBuf::from,
        )
        .join("config.toml")
}

fn words(item: &Item) -> Vec<&str> {
    let array = item.as_array().into_iter().flatten();
    array.filter_map(|word| word.as_str()).collect()
}

fn is_ours(item: &Item) -> bool {
    words(item)
        .windows(2)
        .any(|pair| pair == ["--agent-hook", "codex"])
}

fn notify(isled: &str) -> Array {
    Array::from_iter([isled, "--agent-hook", "codex"])
}

/// Whether Codex notifies Isle.
pub fn hooked(path: &Path) -> bool {
    file::read(path)
        .ok()
        .flatten()
        .and_then(|text| text.parse::<DocumentMut>().ok())
        .is_some_and(|config| config.get("notify").is_some_and(is_ours))
}

/// Points `notify` at isled; never over another program's.
pub fn install(path: &Path, isled: &str) -> anyhow::Result<()> {
    let text = file::read(path).with_context(|| format!("could not read {}", path.display()))?;
    let mut config = parse(path, text.as_deref())?;
    match config.get("notify") {
        // Isle's, but maybe another isled's: pointed at this one.
        Some(item) if is_ours(item) => {
            if words(item) == [isled, "--agent-hook", "codex"] {
                return Ok(());
            }
        }
        Some(_) => bail!("Codex already sends its notifications to another program"),
        None => {}
    }
    config["notify"] = value(notify(isled));
    save(path, &config)
}

/// Takes Isle's `notify` out; whether it was there.
pub fn remove(path: &Path) -> anyhow::Result<bool> {
    let text = file::read(path).with_context(|| format!("could not read {}", path.display()))?;
    let Some(text) = text else {
        return Ok(false);
    };
    let mut config = parse(path, Some(&text))?;
    if !config.get("notify").is_some_and(is_ours) {
        return Ok(false);
    }
    config.remove("notify");
    save(path, &config)?;
    Ok(true)
}

fn parse(path: &Path, text: Option<&str>) -> anyhow::Result<DocumentMut> {
    text.unwrap_or_default()
        .parse()
        .with_context(|| format!("{} is not valid TOML; fix it first", path.display()))
}

fn save(path: &Path, config: &DocumentMut) -> anyhow::Result<()> {
    file::backup_once(path).with_context(|| format!("could not back up {}", path.display()))?;
    file::write_atomic(path, &config.to_string())
        .with_context(|| format!("could not write {}", path.display()))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::agents::file::tests::scratch;

    const ISLED: &str = "/usr/bin/isled";

    #[test]
    fn notify_goes_in_above_the_tables_and_comes_out_again() {
        let dir = scratch("codex-install");
        let path = dir.join("config.toml");
        let before = "# My Codex\nmodel = \"gpt-5\"  # the best\n\n[projects.\"/home/a\"]\ntrust_level = \"trusted\"\n";
        fs::write(&path, before).unwrap();
        assert!(!hooked(&path));
        install(&path, ISLED).unwrap();
        assert!(hooked(&path));
        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(
            text,
            "# My Codex\nmodel = \"gpt-5\"  # the best\nnotify = [\"/usr/bin/isled\", \"--agent-hook\", \"codex\"]\n\n[projects.\"/home/a\"]\ntrust_level = \"trusted\"\n"
        );
        assert_eq!(
            fs::read_to_string(file::sibling(&path, ".isle-backup")).unwrap(),
            before
        );
        install(&path, ISLED).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
        assert!(remove(&path).unwrap());
        assert_eq!(fs::read_to_string(&path).unwrap(), before);
        assert!(!remove(&path).unwrap());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn another_programs_notify_is_left_alone() {
        let dir = scratch("codex-other");
        let path = dir.join("config.toml");
        let before = "notify = [\"notify-send\", \"Codex\"]\n";
        fs::write(&path, before).unwrap();
        let err = install(&path, ISLED).unwrap_err();
        assert_eq!(
            err.to_string(),
            "Codex already sends its notifications to another program"
        );
        assert!(!remove(&path).unwrap());
        assert_eq!(fs::read_to_string(&path).unwrap(), before);
        fs::write(&path, "notify = [").unwrap();
        assert!(install(&path, ISLED).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "notify = [");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_missing_config_is_made_with_one_line() {
        let dir = scratch("codex-new");
        let path = dir.join("codex/config.toml");
        install(&path, "/home/a b/.local/bin/isled").unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "notify = [\"/home/a b/.local/bin/isled\", \"--agent-hook\", \"codex\"]\n"
        );
        // Another isled's entry is Isle's too: pointed at this one.
        install(&path, ISLED).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "notify = [\"/usr/bin/isled\", \"--agent-hook\", \"codex\"]\n"
        );
        fs::remove_dir_all(dir).unwrap();
    }
}

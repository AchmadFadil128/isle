// SPDX-License-Identifier: GPL-3.0-or-later

//! The assistant's "brain": whichever AI CLI the user has and picked (agy, Claude Code or Codex), behind one
//! face. Each runs with the user's own sign-in, kept to answering; isled runs the tools and actions itself.

use std::path::{Path, PathBuf};

use tokio::sync::mpsc::UnboundedSender;

use super::agy::{self, Agy};
use super::answer::Answer;
use super::claude::Claude;
use super::codex::Codex;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Agy,
    Claude,
    Codex,
}

/// Tried in this order when the user picked "auto": the one Isle began with first.
const AUTO: [Provider; 3] = [Provider::Agy, Provider::Claude, Provider::Codex];

impl Provider {
    pub fn id(self) -> &'static str {
        match self {
            Provider::Agy => "agy",
            Provider::Claude => "claude",
            Provider::Codex => "codex",
        }
    }

    /// The name the island shows ("Sign in to Claude Code").
    pub fn name(self) -> &'static str {
        match self {
            Provider::Agy => "Antigravity",
            Provider::Claude => "Claude Code",
            Provider::Codex => "Codex",
        }
    }

    fn command(self) -> &'static str {
        match self {
            Provider::Agy => "agy",
            Provider::Claude => "claude",
            Provider::Codex => "codex",
        }
    }

    /// The CLI on the PATH, else where its installer puts it (isled's PATH may lack ~/.local/bin).
    pub fn program(self) -> Option<PathBuf> {
        let name = self.command();
        let home = dirs::home_dir().unwrap_or_default();
        std::env::var_os("PATH")
            .into_iter()
            .flat_map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>())
            .chain([
                home.join(".local/bin"),
                home.join(".npm-global/bin"),
                home.join(".bun/bin"),
            ])
            .map(|dir| dir.join(name))
            .find(|path| path.is_file())
    }

    /// `wanted` ("agy", "claude", "codex" or "auto"), if installed; else the first installed for "auto".
    pub fn pick(wanted: &str) -> Option<Provider> {
        let installed = |p: &Provider| p.program().is_some();
        match AUTO.into_iter().find(|p| p.id() == wanted) {
            Some(provider) => installed(&provider).then_some(provider),
            None => AUTO.into_iter().find(installed),
        }
    }
}

pub enum Brain {
    Agy(Agy),
    Claude(Claude),
    Codex(Codex),
}

impl Brain {
    pub fn start(
        provider: Provider,
        model: &str,
        resume: Option<&str>,
        workspace: &Path,
    ) -> anyhow::Result<Self> {
        let program = provider.program().ok_or_else(|| {
            anyhow::anyhow!("could not start {}: no such file", provider.command())
        })?;
        Ok(match provider {
            Provider::Agy => Brain::Agy(Agy::start_program(&program, model, resume, workspace)?),
            Provider::Claude => Brain::Claude(Claude::start(&program, model, resume, workspace)?),
            Provider::Codex => Brain::Codex(Codex::start(&program, model, resume, workspace)?),
        })
    }

    pub fn provider(&self) -> Provider {
        match self {
            Brain::Agy(_) => Provider::Agy,
            Brain::Claude(_) => Provider::Claude,
            Brain::Codex(_) => Provider::Codex,
        }
    }

    /// One turn; `activity` hears what it does meanwhile ("Searching the web for …").
    pub async fn ask(
        &mut self,
        prompt: &str,
        activity: Option<&UnboundedSender<String>>,
    ) -> anyhow::Result<Answer> {
        match self {
            Brain::Agy(agy) => agy.ask(prompt, activity).await,
            Brain::Claude(claude) => claude.ask(prompt, activity).await,
            Brain::Codex(codex) => codex.ask(prompt, activity).await,
        }
    }

    /// The conversation's id, to resume it once the process had to go.
    pub fn conversation(&self) -> Option<String> {
        match self {
            Brain::Agy(agy) => agy.conversation.clone(),
            Brain::Claude(claude) => claude.conversation.clone(),
            Brain::Codex(codex) => codex.conversation.clone(),
        }
    }

    /// Deletes the conversation `id` had with `provider` now (the eval leaves nothing behind).
    #[cfg(test)]
    pub fn forget(provider: Provider, id: &str) {
        match provider {
            Provider::Agy => agy::forget(id),
            Provider::Claude => super::claude::forget(id),
            Provider::Codex => super::codex::forget(id),
        }
    }

    /// Deletes every provider's conversations last used before `today` (Isle's own, never the user's).
    pub fn prune(today: chrono::NaiveDate) {
        agy::prune(today);
        super::claude::prune(today);
        super::codex::prune(today);
    }
}

/// A failure as the island shows it: what went wrong, what to do, and whether signing in fixes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub error: String,
    pub hint: String,
    pub sign_in: bool,
}

impl From<(&str, &str)> for Failure {
    fn from((error, hint): (&str, &str)) -> Self {
        Self {
            error: error.into(),
            hint: hint.into(),
            sign_in: false,
        }
    }
}

/// `error` from `provider`, as the user sees it.
pub fn explain(provider: Provider, error: &str) -> Failure {
    let name = provider.name();
    let error = error.to_lowercase();
    // Codes and short words count only whole ("401" in a request id says nothing); longer ones are
    // stems too ("eligib", "credential").
    let says = |words: &[&str]| {
        words.iter().any(|word| {
            if word.len() <= 3 || word.chars().all(|c| c.is_ascii_digit()) {
                has_word(&error, word)
            } else {
                error.contains(word)
            }
        })
    };
    if says(&["could not start", "no such file"]) {
        return Failure::from((
            &*format!("{name} isn't installed"),
            "Install it, or pick another in Settings.",
        ));
    }
    if says(&[
        "log in",
        "login",
        "sign in",
        "signin",
        "sign-in",
        "unauthenticated",
        "unauthorized",
        "credential",
        "authentication",
        "oauth",
        "401",
        "reauth",
        "not authenticated",
        "invalid api key",
        "/login",
    ]) {
        return Failure {
            error: format!("Sign in to {name}"),
            hint: "Sign in, then press Super+I again.".into(),
            sign_in: true,
        };
    }
    if says(&[
        "quota",
        "rate limit",
        "rate_limit",
        "429",
        "exhausted",
        "usage limit",
        "eligib",
        "permission denied",
        "403",
        "subscription",
        "not entitled",
        "not available in your",
        "limit reached",
        "overloaded",
    ]) {
        return Failure::from((
            &*format!("{name} isn't available"),
            "Its limit may be used up for now; try again later, or pick another in Settings.",
        ));
    }
    if says(&[
        "network",
        "dial tcp",
        "no such host",
        "connection refused",
        "unreachable",
        "offline",
        "dns",
    ]) {
        return Failure::from((
            "You're offline",
            "Check the internet connection and try again.",
        ));
    }
    Failure::from((
        UNKNOWN,
        &*format!("{name} could not answer this time; try again."),
    ))
}

/// Whether `word` (or phrase) is in `text` with no letter or digit right before or after it.
fn has_word(text: &str, word: &str) -> bool {
    text.match_indices(word).any(|(at, _)| {
        let before = text[..at].chars().next_back();
        let after = text[at + word.len()..].chars().next();
        !before.is_some_and(char::is_alphanumeric) && !after.is_some_and(char::is_alphanumeric)
    })
}

/// A failure `explain` has no better words for.
pub const UNKNOWN: &str = "Something went wrong";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explains_each_providers_failures() {
        assert_eq!(
            explain(
                Provider::Agy,
                "could not start agy: No such file or directory"
            )
            .error,
            "Antigravity isn't installed"
        );
        let signed_out = explain(Provider::Claude, "Invalid API key · Please run /login");
        assert!(signed_out.sign_in && signed_out.error == "Sign in to Claude Code");
        assert!(
            explain(
                Provider::Agy,
                "Error: authentication required. Run 'agy' to log in"
            )
            .sign_in
        );
        assert_eq!(
            explain(Provider::Codex, "You've hit your usage limit").error,
            "Codex isn't available"
        );
        assert_eq!(
            explain(Provider::Agy, "dial tcp: lookup example.com: no such host").error,
            "You're offline"
        );
        assert_eq!(
            explain(Provider::Codex, "weird").error,
            "Something went wrong"
        );
        // A number or word inside another says nothing.
        assert_eq!(
            explain(Provider::Codex, "request req_4012 failed").error,
            "Something went wrong"
        );
        assert_eq!(
            explain(Provider::Claude, "HTTP 429 Too Many Requests").error,
            "Claude Code isn't available"
        );
        assert!(explain(Provider::Claude, "No credentials found").sign_in);
        assert_eq!(
            explain(Provider::Codex, "account not eligible").error,
            "Codex isn't available"
        );
    }

    #[test]
    fn picks_only_installed_providers() {
        assert!(Provider::pick("no-such-provider").is_none_or(|p| p.program().is_some()));
        for provider in AUTO {
            assert!(Provider::pick(provider.id()).is_none_or(|p| p == provider));
        }
    }
}

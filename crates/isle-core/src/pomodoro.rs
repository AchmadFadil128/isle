// SPDX-License-Identifier: GPL-3.0-or-later

//! Pomodoro focus timer: focus sessions separated by short breaks, with a
//! long break after every few sessions.
//!
//! All times are wall-clock milliseconds since the Unix epoch, passed in by
//! the caller so the logic stays deterministic and testable.

use serde::{Deserialize, Serialize};

const MINUTE_MS: i64 = 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    #[default]
    Idle,
    Focus,
    ShortBreak,
    LongBreak,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PomodoroConfig {
    pub focus_minutes: u32,
    pub short_break_minutes: u32,
    pub long_break_minutes: u32,
    pub sessions_before_long_break: u32,
    /// Start a break as soon as a focus session ends.
    pub auto_start_breaks: bool,
    /// Start the next focus session as soon as a break ends.
    pub auto_start_focus: bool,
}

impl Default for PomodoroConfig {
    fn default() -> Self {
        Self {
            focus_minutes: 25,
            short_break_minutes: 5,
            long_break_minutes: 15,
            sessions_before_long_break: 4,
            auto_start_breaks: true,
            auto_start_focus: false,
        }
    }
}

impl PomodoroConfig {
    fn duration_ms(&self, phase: Phase) -> i64 {
        let minutes = match phase {
            Phase::Idle => 0,
            Phase::Focus => self.focus_minutes,
            Phase::ShortBreak => self.short_break_minutes,
            Phase::LongBreak => self.long_break_minutes,
        };
        i64::from(minutes.max(1)) * MINUTE_MS
    }
}

/// A phase that just ended and the one that follows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Transition {
    pub finished: Phase,
    pub next: Phase,
}

/// What the UI needs to draw the timer at a given moment.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PomodoroView {
    pub phase: Phase,
    pub running: bool,
    /// When the phase ends, if running.
    pub ends_at_ms: Option<i64>,
    pub remaining_ms: i64,
    pub duration_ms: i64,
    pub completed_sessions: u32,
    pub sessions_before_long_break: u32,
}

#[derive(Debug, Clone, Default)]
pub struct Pomodoro {
    config: PomodoroConfig,
    phase: Phase,
    /// Set while running.
    ends_at: Option<i64>,
    /// Time left while not running.
    remaining_ms: i64,
    /// Focus sessions completed since the last long break.
    completed_sessions: u32,
}

impl Pomodoro {
    pub fn new(config: PomodoroConfig) -> Self {
        Self {
            config,
            ..Self::default()
        }
    }

    pub fn config(&self) -> &PomodoroConfig {
        &self.config
    }

    /// Applies new durations. The current phase keeps its length; later
    /// phases use the new one.
    pub fn set_config(&mut self, config: PomodoroConfig) {
        self.config = config;
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    pub fn view(&self, now: i64) -> PomodoroView {
        PomodoroView {
            phase: self.phase,
            running: self.ends_at.is_some(),
            ends_at_ms: self.ends_at,
            remaining_ms: self.remaining(now),
            duration_ms: if self.phase == Phase::Idle {
                self.config.duration_ms(Phase::Focus)
            } else {
                self.config.duration_ms(self.phase)
            },
            completed_sessions: self.completed_sessions,
            sessions_before_long_break: self.config.sessions_before_long_break,
        }
    }

    pub fn remaining(&self, now: i64) -> i64 {
        match self.ends_at {
            Some(ends_at) => (ends_at - now).max(0),
            None if self.phase == Phase::Idle => self.config.duration_ms(Phase::Focus),
            None => self.remaining_ms,
        }
    }

    /// When the running phase ends, for scheduling a wake-up.
    pub fn deadline(&self) -> Option<i64> {
        self.ends_at
    }

    /// Starts a focus session from idle, or resumes a paused phase.
    pub fn start(&mut self, now: i64) {
        if self.ends_at.is_some() {
            return;
        }
        if self.phase == Phase::Idle {
            self.enter(Phase::Focus, now, true);
        } else {
            self.ends_at = Some(now + self.remaining_ms);
        }
    }

    /// Starts `phase` right away, e.g. a short break from the timer's chips.
    /// Starting `Idle` stops the timer.
    pub fn start_phase(&mut self, phase: Phase, now: i64) {
        if phase == Phase::Idle {
            self.stop();
        } else {
            self.enter(phase, now, true);
        }
    }

    pub fn pause(&mut self, now: i64) {
        if let Some(ends_at) = self.ends_at.take() {
            self.remaining_ms = (ends_at - now).max(0);
        }
    }

    /// Abandons the cycle and returns to idle.
    pub fn stop(&mut self) {
        *self = Self::new(self.config.clone());
    }

    /// Ends the current phase early. A skipped focus session does not count.
    pub fn skip(&mut self, now: i64) -> Option<Transition> {
        (self.phase != Phase::Idle).then(|| self.advance(now, false))
    }

    /// Advances to the next phase if the running one has ended.
    pub fn tick(&mut self, now: i64) -> Option<Transition> {
        match self.ends_at {
            Some(ends_at) if now >= ends_at => Some(self.advance(now, true)),
            _ => None,
        }
    }

    fn advance(&mut self, now: i64, completed: bool) -> Transition {
        let finished = self.phase;
        let (next, autostart) = match finished {
            Phase::Focus => {
                if completed {
                    self.completed_sessions += 1;
                }
                let every = self.config.sessions_before_long_break.max(1);
                let long = completed && self.completed_sessions % every == 0;
                let next = if long {
                    Phase::LongBreak
                } else {
                    Phase::ShortBreak
                };
                (next, self.config.auto_start_breaks)
            }
            Phase::LongBreak => {
                self.completed_sessions = 0;
                (Phase::Focus, self.config.auto_start_focus)
            }
            Phase::ShortBreak | Phase::Idle => (Phase::Focus, self.config.auto_start_focus),
        };
        self.enter(next, now, autostart);
        Transition { finished, next }
    }

    fn enter(&mut self, phase: Phase, now: i64, running: bool) {
        let duration = self.config.duration_ms(phase);
        self.phase = phase;
        self.remaining_ms = duration;
        self.ends_at = running.then_some(now + duration);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quick() -> Pomodoro {
        Pomodoro::new(PomodoroConfig {
            focus_minutes: 2,
            short_break_minutes: 1,
            long_break_minutes: 3,
            sessions_before_long_break: 2,
            auto_start_breaks: true,
            auto_start_focus: true,
        })
    }

    #[test]
    fn runs_a_full_cycle() {
        let mut timer = quick();
        let mut now = 0;
        timer.start(now);
        let mut phases = Vec::new();
        for _ in 0..4 {
            now = timer.deadline().unwrap();
            phases.push(timer.tick(now).unwrap().next);
        }
        use Phase::*;
        assert_eq!(phases, [ShortBreak, Focus, LongBreak, Focus]);
        assert_eq!(timer.view(now).completed_sessions, 0);
    }

    #[test]
    fn start_phase_jumps_straight_in() {
        let mut timer = quick();
        timer.start_phase(Phase::ShortBreak, 0);
        let view = timer.view(0);
        assert_eq!(view.phase, Phase::ShortBreak);
        assert!(view.running);
        assert_eq!(timer.deadline(), Some(MINUTE_MS));
    }

    #[test]
    fn pause_keeps_remaining_time() {
        let mut timer = quick();
        timer.start(0);
        timer.pause(30_000);
        assert_eq!(timer.remaining(1_000_000), 90_000);
        timer.start(1_000_000);
        assert_eq!(timer.deadline(), Some(1_090_000));
    }

    #[test]
    fn does_not_tick_early() {
        let mut timer = quick();
        timer.start(0);
        assert_eq!(timer.tick(119_999), None);
    }

    #[test]
    fn skipped_focus_does_not_count() {
        let mut timer = quick();
        timer.start(0);
        let transition = timer.skip(10).unwrap();
        assert_eq!(transition.next, Phase::ShortBreak);
        assert_eq!(timer.view(10).completed_sessions, 0);
    }

    #[test]
    fn waits_when_autostart_is_off() {
        let mut timer = Pomodoro::new(PomodoroConfig {
            auto_start_breaks: false,
            ..PomodoroConfig::default()
        });
        timer.start(0);
        timer.tick(timer.deadline().unwrap());
        let view = timer.view(0);
        assert_eq!(view.phase, Phase::ShortBreak);
        assert!(!view.running);
        assert_eq!(view.remaining_ms, 5 * MINUTE_MS);
    }
}

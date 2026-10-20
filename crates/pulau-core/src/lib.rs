//! Platform-independent core of Pulau.
//!
//! Nothing in this crate talks to D-Bus, GTK or the network, so every rule
//! that decides what the island shows can be unit tested in isolation.

pub mod geometry;
pub mod lrc;
pub mod pomodoro;
pub mod shelf;
pub mod spring;
pub mod todo;
pub mod track;

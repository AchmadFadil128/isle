// SPDX-License-Identifier: GPL-3.0-or-later

//! To-do list with optional due times, plus a quick-add syntax:
//! "Call mum @18:30", "Stretch in 20m", "Send report @3pm".

use chrono::{DateTime, NaiveTime, TimeDelta, TimeZone};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TodoItem {
    pub id: u64,
    pub title: String,
    pub due_at_ms: Option<i64>,
    pub done: bool,
    /// Whether the due alert has been shown.
    #[serde(default)]
    pub alerted: bool,
    /// When the task was ticked off.
    #[serde(default)]
    pub done_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TodoList {
    items: Vec<TodoItem>,
    next_id: u64,
}

impl TodoList {
    pub fn items(&self) -> &[TodoItem] {
        &self.items
    }

    pub fn add(&mut self, title: &str, due_at_ms: Option<i64>) -> u64 {
        self.next_id += 1;
        self.items.push(TodoItem {
            id: self.next_id,
            title: title.trim().to_owned(),
            due_at_ms,
            done: false,
            alerted: false,
            done_at_ms: None,
        });
        self.next_id
    }

    pub fn set_done(&mut self, id: u64, done: bool, now: i64) -> bool {
        self.find(id)
            .map(|item| {
                item.done = done;
                item.done_at_ms = done.then_some(now);
            })
            .is_some()
    }

    pub fn rename(&mut self, id: u64, title: &str) -> bool {
        let title = title.trim();
        if title.is_empty() {
            return false;
        }
        self.find(id)
            .map(|item| item.title = title.to_owned())
            .is_some()
    }

    /// Moves a task's due time (`None` clears it). The task alerts again
    /// when the new time arrives.
    pub fn set_due(&mut self, id: u64, due_at_ms: Option<i64>) -> bool {
        self.find(id)
            .map(|item| {
                item.due_at_ms = due_at_ms;
                item.alerted = false;
            })
            .is_some()
    }

    /// Drops tasks finished before `day_start`, so each day starts with only
    /// what is still open. Returns whether anything was removed.
    pub fn drop_done_before(&mut self, day_start: i64) -> bool {
        let before = self.items.len();
        self.items
            .retain(|item| !item.done || item.done_at_ms.is_some_and(|at| at >= day_start));
        self.items.len() != before
    }

    pub fn remove(&mut self, id: u64) -> bool {
        let before = self.items.len();
        self.items.retain(|item| item.id != id);
        self.items.len() != before
    }

    pub fn clear_done(&mut self) {
        self.items.retain(|item| !item.done);
    }

    /// The earliest due time that still needs an alert.
    pub fn deadline(&self) -> Option<i64> {
        self.pending_alerts()
            .filter_map(|item| item.due_at_ms)
            .min()
    }

    /// Marks every item due by `now` as alerted and returns them.
    pub fn take_due(&mut self, now: i64) -> Vec<TodoItem> {
        let mut due = Vec::new();
        for item in &mut self.items {
            if !item.done && !item.alerted && item.due_at_ms.is_some_and(|at| at <= now) {
                item.alerted = true;
                due.push(item.clone());
            }
        }
        due
    }

    fn pending_alerts(&self) -> impl Iterator<Item = &TodoItem> {
        self.items.iter().filter(|item| !item.done && !item.alerted)
    }

    fn find(&mut self, id: u64) -> Option<&mut TodoItem> {
        self.items.iter_mut().find(|item| item.id == id)
    }
}

/// Splits quick-add text into a title and an optional due time.
///
/// Understands a trailing `@HH:MM`, `@H`, `@Hpm`/`@Ham` (the next time that
/// clock time comes round) or `in Nm`/`in Nh` (relative to now). A delay too
/// large to be a real date is not a due time, so the text stays as typed.
pub fn parse_quick_add<Tz: TimeZone>(text: &str, now: &DateTime<Tz>) -> (String, Option<i64>) {
    let text = text.trim();
    let words: Vec<&str> = text.split_whitespace().collect();

    if let Some((last, rest)) = words.split_last() {
        if let Some(time) = last.strip_prefix('@').and_then(parse_clock) {
            return (rest.join(" "), next_occurrence(now, time));
        }
        if let [head @ .., "in", amount] = words.as_slice() {
            let due = parse_delay(amount).and_then(|delay| now.clone().checked_add_signed(delay));
            if let Some(due) = due {
                return (head.join(" "), Some(due.timestamp_millis()));
            }
        }
    }
    (text.to_owned(), None)
}

fn parse_clock(text: &str) -> Option<NaiveTime> {
    let lower = text.to_ascii_lowercase();
    let (digits, pm) = match (lower.strip_suffix("pm"), lower.strip_suffix("am")) {
        (Some(d), _) => (d.to_owned(), Some(true)),
        (_, Some(d)) => (d.to_owned(), Some(false)),
        _ => (lower, None),
    };
    let (hour, minute) = match digits.split_once([':', '.']) {
        Some((h, m)) => (h.parse::<u32>().ok()?, m.parse::<u32>().ok()?),
        None => (digits.parse::<u32>().ok()?, 0),
    };
    let hour = match pm {
        Some(_) if !(1..=12).contains(&hour) => return None,
        Some(true) => hour % 12 + 12,
        Some(false) => hour % 12,
        None => hour,
    };
    NaiveTime::from_hms_opt(hour, minute, 0)
}

/// Parses `20m`, `2h` and the like. The `try_` constructors matter: the
/// amount comes straight from the user, and the plain ones panic when it is
/// out of range.
fn parse_delay(text: &str) -> Option<TimeDelta> {
    let split = text.find(|c: char| !c.is_ascii_digit())?;
    let amount: i64 = text[..split].parse().ok()?;
    match &text[split..] {
        "m" | "min" | "mins" => TimeDelta::try_minutes(amount),
        "h" | "hr" | "hrs" => TimeDelta::try_hours(amount),
        _ => None,
    }
}

/// The next time the clock shows `time`: today if still ahead, else tomorrow.
fn next_occurrence<Tz: TimeZone>(now: &DateTime<Tz>, time: NaiveTime) -> Option<i64> {
    let today = now.date_naive();
    [Some(today), today.succ_opt()]
        .into_iter()
        .flatten()
        .filter_map(|date| {
            now.timezone()
                .from_local_datetime(&date.and_time(time))
                .earliest()
        })
        .find(|candidate| candidate > now)
        .map(|candidate| candidate.timestamp_millis())
}

#[cfg(test)]
mod tests {
    use chrono::FixedOffset;

    use super::*;

    fn at(day: u32, hour: u32, minute: u32) -> DateTime<FixedOffset> {
        let tz = FixedOffset::east_opt(7 * 3600).unwrap();
        tz.with_ymd_and_hms(2026, 10, day, hour, minute, 0).unwrap()
    }

    #[test]
    fn quick_add_clock_times() {
        let now = at(20, 10, 0);
        assert_eq!(
            parse_quick_add("Call mum @18:30", &now),
            ("Call mum".into(), Some(at(20, 18, 30).timestamp_millis()))
        );
        assert_eq!(
            parse_quick_add("Report @3pm", &now).1,
            Some(at(20, 15, 0).timestamp_millis())
        );
        // Already past today: tomorrow.
        assert_eq!(
            parse_quick_add("Gym @7", &now).1,
            Some(at(21, 7, 0).timestamp_millis())
        );
    }

    #[test]
    fn quick_add_relative_times() {
        let now = at(20, 10, 0);
        assert_eq!(
            parse_quick_add("Stretch in 20m", &now),
            ("Stretch".into(), Some(at(20, 10, 20).timestamp_millis()))
        );
        assert_eq!(
            parse_quick_add("Nap in 2h", &now).1,
            Some(at(20, 12, 0).timestamp_millis())
        );
    }

    #[test]
    fn quick_add_plain_text() {
        let now = at(20, 10, 0);
        assert_eq!(
            parse_quick_add("Email @ team", &now),
            ("Email @ team".into(), None)
        );
        assert_eq!(
            parse_quick_add("Fly in style", &now),
            ("Fly in style".into(), None)
        );
        assert_eq!(parse_quick_add("Bad @25:00", &now).1, None);
    }

    #[test]
    fn quick_add_absurd_delays_are_plain_text() {
        let now = at(20, 10, 0);
        // Too many minutes for a time span at all.
        assert_eq!(
            parse_quick_add("x in 999999999999999m", &now),
            ("x in 999999999999999m".into(), None)
        );
        // A valid span, but it ends past the last representable date.
        assert_eq!(
            parse_quick_add("x in 99999999999h", &now),
            ("x in 99999999999h".into(), None)
        );
        // Too many digits for a number.
        assert_eq!(parse_quick_add("x in 99999999999999999999m", &now).1, None);
    }

    #[test]
    fn due_items_alert_once() {
        let mut list = TodoList::default();
        let a = list.add("A", Some(100));
        list.add("B", Some(200));
        list.add("C", None);
        assert_eq!(list.deadline(), Some(100));
        assert_eq!(
            list.take_due(150).iter().map(|i| i.id).collect::<Vec<_>>(),
            [a]
        );
        assert!(list.take_due(150).is_empty());
        assert_eq!(list.deadline(), Some(200));
    }

    #[test]
    fn done_items_never_alert() {
        let mut list = TodoList::default();
        let id = list.add("A", Some(100));
        list.set_done(id, true, 50);
        assert_eq!(list.deadline(), None);
        assert!(list.take_due(500).is_empty());
    }

    #[test]
    fn finished_tasks_leave_the_next_day() {
        let mut list = TodoList::default();
        let old = list.add("Yesterday", None);
        let today = list.add("Today", None);
        list.add("Open", None);
        list.set_done(old, true, 100);
        list.set_done(today, true, 1_000);
        assert!(list.drop_done_before(500));
        let titles: Vec<_> = list.items().iter().map(|i| i.title.as_str()).collect();
        assert_eq!(titles, ["Today", "Open"]);
    }

    #[test]
    fn set_due_rearms_the_alert() {
        let mut list = TodoList::default();
        let id = list.add("A", Some(1_000));
        assert_eq!(list.take_due(1_000).len(), 1);
        assert!(list.set_due(id, Some(2_000)));
        assert_eq!(list.deadline(), Some(2_000));
        assert!(list.take_due(1_999).is_empty());
        assert_eq!(list.take_due(2_000).len(), 1);
        assert!(list.set_due(id, None));
        assert_eq!(list.deadline(), None);
        assert!(!list.set_due(id + 1, None));
    }

    #[test]
    fn rename_rejects_empty_titles() {
        let mut list = TodoList::default();
        let id = list.add("A", None);
        assert!(!list.rename(id, "  "));
        assert!(list.rename(id, "B"));
        assert_eq!(list.items()[0].title, "B");
    }
}

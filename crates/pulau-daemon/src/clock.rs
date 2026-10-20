//! Wall-clock time and waiting for wall-clock deadlines.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::Notify;

/// Longest single sleep. Tokio sleeps on the monotonic clock, which stops
/// during suspend, so long waits are split up and the wall clock re-checked.
const MAX_NAP: Duration = Duration::from_secs(30);

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

/// Waits until the wall-clock `deadline` passes or `wake` is notified.
/// Returns whether the deadline has passed; on `false`, re-read the state
/// and call again.
pub async fn wait_until(deadline: Option<i64>, wake: &Notify) -> bool {
    let notified = wake.notified();
    let Some(deadline) = deadline else {
        notified.await;
        return false;
    };
    let remaining = deadline - now_ms();
    if remaining <= 0 {
        return true;
    }
    let nap = Duration::from_millis(remaining as u64).min(MAX_NAP);
    tokio::select! {
        () = tokio::time::sleep(nap) => now_ms() >= deadline,
        () = notified => false,
    }
}

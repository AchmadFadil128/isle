use std::sync::Arc;

use log::warn;
use pulau_core::pomodoro::{Phase, Pomodoro, PomodoroConfig};
use tokio::sync::Notify;
use zbus::object_server::{InterfaceRef, SignalEmitter};
use zbus::{fdo, interface};

use crate::clock::{now_ms, wait_until};
use crate::store::Store;

pub struct PomodoroService {
    timer: Pomodoro,
    store: Store<PomodoroConfig>,
    wake: Arc<Notify>,
}

impl PomodoroService {
    pub fn load() -> Self {
        let store = Store::new("pomodoro");
        Self {
            timer: Pomodoro::new(store.load()),
            store,
            wake: Arc::default(),
        }
    }

    /// Publishes the new state and reschedules the phase-end wake-up.
    async fn changed(&self, emitter: &SignalEmitter<'_>) -> zbus::Result<()> {
        self.wake.notify_one();
        self.state_changed(emitter).await
    }
}

#[interface(name = "io.github.pulau.Pomodoro1")]
impl PomodoroService {
    /// Starts a focus session, or resumes a paused phase.
    async fn start(&mut self, #[zbus(signal_emitter)] emitter: SignalEmitter<'_>) -> fdo::Result<()> {
        self.timer.start(now_ms());
        Ok(self.changed(&emitter).await?)
    }

    async fn pause(&mut self, #[zbus(signal_emitter)] emitter: SignalEmitter<'_>) -> fdo::Result<()> {
        self.timer.pause(now_ms());
        Ok(self.changed(&emitter).await?)
    }

    /// Abandons the current cycle.
    async fn stop(&mut self, #[zbus(signal_emitter)] emitter: SignalEmitter<'_>) -> fdo::Result<()> {
        self.timer.stop();
        Ok(self.changed(&emitter).await?)
    }

    /// Starts a phase right away: "focus", "short_break", "long_break", or
    /// "idle" to stop.
    async fn start_phase(
        &mut self,
        phase: &str,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        let phase: Phase = serde_json::from_value(serde_json::Value::String(phase.to_owned()))
            .map_err(|_| fdo::Error::InvalidArgs(format!("unknown phase `{phase}`")))?;
        self.timer.start_phase(phase, now_ms());
        Ok(self.changed(&emitter).await?)
    }

    /// Ends the current phase early.
    async fn skip(&mut self, #[zbus(signal_emitter)] emitter: SignalEmitter<'_>) -> fdo::Result<()> {
        self.timer.skip(now_ms());
        Ok(self.changed(&emitter).await?)
    }

    /// Replaces the configuration with a JSON-encoded `PomodoroConfig`.
    async fn set_config(
        &mut self,
        config: &str,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        let config: PomodoroConfig =
            serde_json::from_str(config).map_err(|err| fdo::Error::InvalidArgs(err.to_string()))?;
        self.store.save(&config);
        self.timer.set_config(config);
        self.config_changed(&emitter).await?;
        Ok(self.changed(&emitter).await?)
    }

    /// JSON `PomodoroView`.
    #[zbus(property)]
    fn state(&self) -> String {
        serde_json::to_string(&self.timer.view(now_ms())).unwrap_or_default()
    }

    /// JSON `PomodoroConfig`.
    #[zbus(property)]
    fn config(&self) -> String {
        serde_json::to_string(self.timer.config()).unwrap_or_default()
    }

    /// A phase ended on its own (not skipped or stopped).
    #[zbus(signal)]
    async fn phase_finished(emitter: &SignalEmitter<'_>, finished: &str, next: &str) -> zbus::Result<()>;
}

/// Advances the timer whenever a phase runs out.
pub async fn run(iface: InterfaceRef<PomodoroService>) {
    let wake = iface.get().await.wake.clone();
    loop {
        let deadline = iface.get().await.timer.deadline();
        if !wait_until(deadline, &wake).await {
            continue;
        }

        let mut service = iface.get_mut().await;
        let Some(transition) = service.timer.tick(now_ms()) else {
            continue;
        };
        let emitter = iface.signal_emitter();
        let phase = |phase| serde_json::to_value(phase).ok().and_then(|v| v.as_str().map(str::to_owned));
        let result = async {
            service.state_changed(emitter).await?;
            PomodoroService::phase_finished(
                emitter,
                &phase(transition.finished).unwrap_or_default(),
                &phase(transition.next).unwrap_or_default(),
            )
            .await
        };
        if let Err(err) = result.await {
            warn!("could not announce the pomodoro phase change: {err}");
        }
    }
}

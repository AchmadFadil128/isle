// SPDX-License-Identifier: GPL-3.0-or-later

//! Waking from suspend, from logind: the clock's waits re-check the time then (see `clock::resumed`),
//! so they can sleep until their deadline instead of waking every few seconds to look.

use futures_util::StreamExt;
use zbus::{Connection, MatchRule, MessageStream};

pub async fn watch(bus: Connection) -> anyhow::Result<()> {
    let rule = MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .sender("org.freedesktop.login1")?
        .interface("org.freedesktop.login1.Manager")?
        .member("PrepareForSleep")?
        .build();
    let mut signals = MessageStream::for_match_rule(rule, &bus, None).await?;
    while let Some(message) = signals.next().await {
        // `false`: waking up, not going to sleep.
        if message?.body().deserialize::<bool>() == Ok(false) {
            crate::clock::resumed();
        }
    }
    Ok(())
}

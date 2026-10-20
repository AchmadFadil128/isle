// Helpers for the daemon's `NowPlaying` and `Lyrics` state.

import {nowMs} from './format.js';

export function isPlaying(nowPlaying) {
    return nowPlaying?.available && nowPlaying.status === 'Playing';
}

export function hasTrack(nowPlaying) {
    return nowPlaying?.available && Boolean(nowPlaying.title);
}

/**
 * The playback position right now, in milliseconds. The daemon only samples
 * the position when something changes; while playing it advances in real time.
 */
export function positionMs(nowPlaying) {
    if (!nowPlaying?.available)
        return 0;
    let position = nowPlaying.position_us / 1000;
    if (nowPlaying.status === 'Playing')
        position += (nowMs() - nowPlaying.sampled_at_ms) * (nowPlaying.rate || 1);
    const length = nowPlaying.length_us / 1000;
    return length > 0 ? Math.min(Math.max(position, 0), length) : Math.max(position, 0);
}

export function lengthMs(nowPlaying) {
    return (nowPlaying?.length_us ?? 0) / 1000;
}

export function hasSyncedLyrics(lyrics) {
    return lyrics?.status === 'synced' && lyrics.lines.length > 0;
}

/** Index of the line being sung at `position`, or -1 before the first line. */
export function lineIndexAt(lines, position) {
    let low = 0;
    let high = lines.length - 1;
    let found = -1;
    while (low <= high) {
        const middle = (low + high) >> 1;
        if (lines[middle].time_ms <= position) {
            found = middle;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    return found;
}

/**
 * Milliseconds until the line after `index` starts at the current playback
 * speed, or null if there is none.
 */
export function msUntilLine(nowPlaying, lines, index) {
    const next = lines[index + 1];
    if (!next)
        return null;
    const rate = nowPlaying.rate || 1;
    return Math.max(0, (next.time_ms - positionMs(nowPlaying)) / rate);
}

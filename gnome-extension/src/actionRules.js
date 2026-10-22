// SPDX-License-Identifier: GPL-3.0-or-later

// The assistant's rules that need nothing of GNOME, kept apart so tests run them anywhere (tests/).

/** What actions run mid-way do, for the island: "Opening Files…", or how many there are. */
export function describeActions(actions = []) {
    const [first] = actions;
    if (!first)
        return 'Working…';
    const what = {
        open_app: `Opening ${first.app ?? 'the app'}…`,
        open_url: 'Opening the page…',
        open_file: 'Opening the file…',
        open_folder: 'Opening the folder…',
        window: 'Moving the window…',
        arrange: 'Arranging the windows…',
        play_music: 'Playing music…',
        media: 'Controlling the music…',
        close_app: `Closing ${first.app ?? 'the app'}…`,
    }[first.type] ?? 'Working on it…';
    return actions.length > 1 ? `${what.replace(/…$/, '')} and ${actions.length - 1} more…` : what;
}

// Parts of the screen's work area, as [x, y, width, height] shares of it: where one window goes...
export const TILES = {
    left: [0, 0, 0.5, 1],
    right: [0.5, 0, 0.5, 1],
    top: [0, 0, 1, 0.5],
    bottom: [0, 0.5, 1, 0.5],
    top_left: [0, 0, 0.5, 0.5],
    top_right: [0.5, 0, 0.5, 0.5],
    bottom_left: [0, 0.5, 0.5, 0.5],
    bottom_right: [0.5, 0.5, 0.5, 0.5],
    center: [0.125, 0.1, 0.75, 0.8],
};
// ...and where several go, left to right and top to bottom.
const LAYOUTS = {
    halves: [TILES.left, TILES.right],
    rows: [TILES.top, TILES.bottom],
    quarters: [TILES.top_left, TILES.top_right, TILES.bottom_left, TILES.bottom_right],
    thirds: [[0, 0, 1 / 3, 1], [1 / 3, 0, 1 / 3, 1], [2 / 3, 0, 1 / 3, 1]],
};

/** The places for `count` windows in `layout`, or in a grid that fits them when it names none. */
export function slotsFor(layout, count) {
    if (LAYOUTS[layout])
        return LAYOUTS[layout];
    if (count <= 1)
        return [[0, 0, 1, 1]];
    if (count <= 4)
        return [LAYOUTS.halves, LAYOUTS.thirds, LAYOUTS.quarters][count - 2];
    const columns = 3;
    const rows = Math.ceil(count / columns);
    return Array.from({length: count}, (_, i) =>
        [(i % columns) / columns, Math.floor(i / columns) / rows, 1 / columns, 1 / rows]);
}

/** An action that could not be done, and why. */
export function failed(detail) {
    return {ok: false, detail};
}

// What an action returned, as {ok, detail}: nothing (or a call's reply) is done, a string says what it
// did, and false, '' or null (a failed call) is not done.
export function outcomeOf(outcome) {
    if (outcome?.ok === false)
        return outcome;
    if (typeof outcome === 'string' && outcome)
        return {ok: true, detail: outcome};
    return {ok: outcome === undefined || outcome === true || Array.isArray(outcome), detail: ''};
}

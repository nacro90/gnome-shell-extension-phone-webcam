// Manual check against a real phone, without GNOME Shell:
//   gjs -m tools/try-stream.js [back|front] [seconds]
// Starts the stream, prints every state change, switches to the other camera
// halfway through, then stops.
import GLib from 'gi://GLib';
import {Stream} from '../lib/stream.js';
import {System} from '../lib/system.js';

const camera = ARGV[0] ?? 'back';
const seconds = Number(ARGV[1] ?? 10);
const loop = new GLib.MainLoop(null, false);
const started = GLib.get_monotonic_time();

const stream = new Stream(new System(), (state, reason) => {
    const t = ((GLib.get_monotonic_time() - started) / 1e6).toFixed(1);
    print(`${t}s ${state}${reason ? ` (${reason})` : ''}`);
    if (state === 'off' || state === 'failed')
        loop.quit();
});

stream.listPhones()
    .then(phones => print(`phones: ${phones.map(p => `${p.label} x${p.serials.length}`).join(', ') || 'none'}`))
    .catch(e => print(`phones: ${e.message}`));
stream.start(camera);
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, Math.floor(seconds / 2), () => {
    stream.start(camera === 'back' ? 'front' : 'back');
    return GLib.SOURCE_REMOVE;
});
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
    stream.stop();
    return GLib.SOURCE_REMOVE;
});
loop.run();

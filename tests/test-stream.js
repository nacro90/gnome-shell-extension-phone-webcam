// Tests for the lib/stream.js state machine, driven by a fake system.
// Run: gjs -m tests/test-stream.js
import {Stream} from '../lib/stream.js';

let failed = 0;
function check(name, expected, actual) {
    const e = JSON.stringify(expected), a = JSON.stringify(actual);
    if (e === a) {
        print(`ok   ${name}`);
    } else {
        print(`FAIL ${name}: expected ${e}, got ${a}`);
        failed++;
    }
}

const SERIAL = 'PHONE1';

class FakeSys {
    constructor() {
        this.now_ = 1000;
        this.sleeps = [];
        this.calls = [];          // every run() argv, joined
        this.procs = [];          // every spawned process
        this.loopbacks = ['video10'];
        this.live = false;        // loopback sysfs state reads "capture"
        this.liveOnSpawn = true;  // the device goes live as soon as scrcpy runs
        this.devices = `List of devices attached\n${SERIAL}\tdevice\n`;
        this.smartStay = '1';
        this.props = {};          // adb serial -> getprop output; default is its own phone
        this.propFails = false;
        this.timeouts = [];       // timeout passed with each run(), in order
        this.putFails = false;
        this.adbMissing = false;
        this.scrcpyMissing = false;
        this.pendingRuns = null;  // when an array, run() parks until released
        this.detached = [];
        this.logs = [];
        this.disposed = false;
    }

    async run(argv, timeoutSeconds) {
        const line = argv.join(' ');
        this.calls.push(line);
        this.timeouts.push(timeoutSeconds);
        if (this.pendingRuns)
            await new Promise(resolve => this.pendingRuns.push(resolve));
        if (this.adbMissing)
            throw Object.assign(new Error('no adb'), {missing: true});
        if (line === 'adb devices')
            return this.devices;
        if (line.includes('getprop')) {
            if (this.propFails)
                throw Object.assign(new Error('closed'), {missing: false});
            return this.props[argv[2]] ?? `HW-${argv[2]}\nModel ${argv[2]}\n`;
        }
        if (line.includes('settings get'))
            return `${this.smartStay}\n`;
        if (line.includes('settings put')) {
            if (this.putFails)
                throw Object.assign(new Error('device offline'), {missing: false});
            this.smartStay = argv[argv.length - 1];
            return '';
        }
        throw new Error(`unexpected command: ${line}`);
    }

    runDetached(argv) {
        this.detached.push(argv.join(' '));
    }

    spawn(argv) {
        if (this.scrcpyMissing)
            throw Object.assign(new Error('no scrcpy'), {missing: true});
        const proc = {argv, killed: false, alive: true};
        proc.exited = new Promise(resolve => {
            proc.exit = (lines = []) => {
                if (!proc.alive)
                    return;
                proc.alive = false;
                this.live = false;
                resolve(lines);
            };
        });
        proc.kill = () => {
            proc.killed = true;
            proc.exit([]);
        };
        this.procs.push(proc);
        if (this.liveOnSpawn)
            this.live = true;
        return proc;
    }

    async listLoopbacks() {
        return this.loopbacks;
    }

    async loopbackState() {
        return this.live ? 'capture\n' : 'output\n';
    }

    sleep(ms) {
        return new Promise(resolve => this.sleeps.push({at: this.now_ + ms / 1000, resolve}));
    }

    now() {
        return this.now_;
    }

    log(message) {
        this.logs.push(message);
    }

    dispose() {
        this.disposed = true;
    }

    // Test helpers.
    releaseRuns() {
        const parked = this.pendingRuns ?? [];
        this.pendingRuns = null;
        parked.forEach(resolve => resolve());
    }

    get running() {
        return this.procs.filter(p => p.alive);
    }

    facing(proc) {
        return proc.argv.find(a => a.startsWith('--camera-facing=')).split('=')[1];
    }

    puts() {
        return this.calls.filter(c => c.includes('settings put')).map(c => c.split(' ').pop());
    }
}

async function settle() {
    for (let i = 0; i < 200; i++)
        await Promise.resolve();
}

async function advance(sys, seconds) {
    const steps = Math.round(seconds * 10);
    for (let i = 0; i < steps; i++) {
        sys.now_ += 0.1;
        const due = sys.sleeps.filter(s => s.at <= sys.now_ + 1e-9);
        sys.sleeps = sys.sleeps.filter(s => !due.includes(s));
        due.forEach(s => s.resolve());
        await settle();
    }
}

function setup() {
    const sys = new FakeSys();
    const states = [];
    const stream = new Stream(sys, (state, reason) => states.push(reason ? `${state}:${reason}` : state));
    return {sys, states, stream};
}

// Start, go live, stop.
{
    const {sys, states, stream} = setup();
    stream.start('back');
    await advance(sys, 1);
    check('happy: states until live', ['starting', 'on'], states);
    check('happy: one scrcpy with the back camera', ['back'], sys.procs.map(p => sys.facing(p)));
    check('happy: scrcpy targets the loopback device and the phone', true,
        sys.procs[0].argv.includes('--v4l2-sink=/dev/video10') && sys.procs[0].argv.includes(`--serial=${SERIAL}`));
    check('happy: smart stay turned off', '0', sys.smartStay);
    stream.stop();
    await advance(sys, 3);
    check('happy: off after stop', 'off', states[states.length - 1]);
    check('happy: process killed', true, sys.procs[0].killed);
    check('happy: smart stay restored', '1', sys.smartStay);
    check('happy: off then on, once each', ['0', '1'], sys.puts());
}

// 'on' waits for the loopback device to be fed.
{
    const {sys, states, stream} = setup();
    sys.liveOnSpawn = false;
    stream.start('back');
    await advance(sys, 2);
    check('live: still starting while the device is idle', ['starting'], states);
    sys.live = true;
    await advance(sys, 1);
    check('live: on once the device is fed', ['starting', 'on'], states);
}

// Camera switch keeps smart stay off the whole time.
{
    const {sys, states, stream} = setup();
    stream.start('back');
    await advance(sys, 1);
    stream.start('front');
    await advance(sys, 4);
    check('switch: back then front', ['back', 'front'], sys.procs.map(p => sys.facing(p)));
    check('switch: only the front process is left', ['front'], sys.running.map(p => sys.facing(p)));
    check('switch: ends live', 'on', states[states.length - 1]);
    check('switch: smart stay never restored in between', ['0'], sys.puts());
    check('switch: no failure reported', false, states.some(s => s.startsWith('failed')));
}

// A second start while the first launch is still talking to adb.
{
    const {sys, stream} = setup();
    sys.pendingRuns = [];
    stream.start('back');
    await settle();
    stream.start('front');
    await settle();
    sys.releaseRuns();
    await advance(sys, 4);
    check('double start: exactly one process survives', 1, sys.running.length);
    check('double start: it uses the last requested camera', 'front', sys.facing(sys.running[0]));
    check('double start: smart stay off exactly once', ['0'], sys.puts());
    stream.stop();
    await advance(sys, 3);
    check('double start: smart stay restored after stop', '1', sys.smartStay);
}

// Stop and start again in the same tick: the running stream is simply kept.
{
    const {sys, states, stream} = setup();
    stream.start('back');
    await advance(sys, 1);
    stream.stop();
    stream.start('back');
    await advance(sys, 4);
    check('instant restart: the same process keeps running', [1, 1], [sys.procs.length, sys.running.length]);
    check('instant restart: still live', 'on', states[states.length - 1]);
}

// Start again with the same camera while the stopped process is exiting.
{
    const {sys, states, stream} = setup();
    stream.start('back');
    await advance(sys, 1);
    stream.stop();
    await settle();
    check('restart: the old process was killed', true, sys.procs[0].killed);
    stream.start('back');
    await advance(sys, 2);
    check('restart: a new process runs without the retry delay', [2, 1], [sys.procs.length, sys.running.length]);
    check('restart: live again', 'on', states[states.length - 1]);
    check('restart: never failed', false, states.some(s => s.startsWith('failed')));
}

// The stream dies on its own: retry after 3 s.
{
    const {sys, states, stream} = setup();
    stream.start('back');
    await advance(sys, 1);
    sys.procs[0].exit(['[server] WARN: Camera disconnected']);
    await advance(sys, 1);
    check('retry: back to starting, not relaunched yet', ['starting', 1], [states[states.length - 1], sys.procs.length]);
    await advance(sys, 3);
    check('retry: relaunched after the delay', 2, sys.procs.length);
    check('retry: live again', 'on', states[states.length - 1]);
    check('retry: smart stay stayed off', '0', sys.smartStay);
}

// Stop during the retry delay takes effect at once.
{
    const {sys, states, stream} = setup();
    stream.start('back');
    await advance(sys, 1);
    sys.procs[0].exit([]);
    await advance(sys, 1);
    stream.stop();
    await advance(sys, 1);
    check('stop while retrying: off', 'off', states[states.length - 1]);
    await advance(sys, 5);
    check('stop while retrying: no relaunch later', 1, sys.procs.length);
    check('stop while retrying: smart stay restored', '1', sys.smartStay);
}

// Five failures within a minute: give up and name the error.
{
    const {sys, states, stream} = setup();
    sys.liveOnSpawn = false;
    stream.start('back');
    for (let i = 0; i < 5; i++) {
        await advance(sys, 1);
        sys.running[0]?.exit(['ERROR: Could not open camera']);
        await advance(sys, 4);
    }
    check('give up: failed with the scrcpy error', 'failed:Could not open camera', states[states.length - 1]);
    check('give up: five attempts', 5, sys.procs.length);
    check('give up: nothing left running', 0, sys.running.length);
    check('give up: smart stay restored', '1', sys.smartStay);
    await advance(sys, 10);
    check('give up: no further attempts', 5, sys.procs.length);
}

// Problems a retry cannot fix fail at once.
{
    const {sys, states, stream} = setup();
    sys.loopbacks = [];
    stream.start('back');
    await advance(sys, 1);
    check('no loopback: failed at once', ['starting', 'failed:noLoopback'], states);
    check('no loopback: adb never called', [], sys.calls);
}
{
    const {sys, states, stream} = setup();
    sys.adbMissing = true;
    stream.start('back');
    await advance(sys, 1);
    check('adb missing: failed at once', ['starting', 'failed:noScrcpy'], states);
}
{
    const {sys, states, stream} = setup();
    sys.scrcpyMissing = true;
    stream.start('back');
    await advance(sys, 1);
    check('scrcpy missing: failed at once', 'failed:noScrcpy', states[states.length - 1]);
    check('scrcpy missing: smart stay restored', '1', sys.smartStay);
}

// No phone: retried, then reported.
{
    const {sys, states, stream} = setup();
    sys.devices = 'List of devices attached\n\n';
    stream.start('back');
    await advance(sys, 1);
    check('no phone: still trying', ['starting'], states);
    await advance(sys, 20);
    check('no phone: reported', 'failed:noDevice', states[states.length - 1]);
    check('no phone: scrcpy never started', 0, sys.procs.length);
}

// The preferred serial is honored.
{
    const {sys, states, stream} = setup();
    sys.devices = 'List of devices attached\nOTHER\tdevice\nPHONE2\tdevice\n';
    stream.start('back', {serial: 'PHONE2'});
    await advance(sys, 1);
    check('serial: preferred device used', true, sys.procs[0].argv.includes('--serial=PHONE2'));
    check('serial: live', 'on', states[states.length - 1]);
    check('serial: phones not looked up', false, sys.calls.some(c => c.includes('getprop')));
}

// Two transports of one phone and a second phone.
const TWO_PHONES = 'List of devices attached\n10.0.0.5:4444\tdevice\nUSB1\tdevice\n10.0.0.9:5555\tdevice\nGONE\toffline\n';
const TWO_PROPS = {
    '10.0.0.5:4444': 'HW-A\nSM-S918B\n',
    'USB1': 'HW-A\nSM-S918B\n',
    '10.0.0.9:5555': 'HW-B\nPixel 8\n',
};
{
    const {sys, stream} = setup();
    sys.devices = TWO_PHONES;
    sys.props = TWO_PROPS;
    check('list phones: one entry per phone',
        [{id: 'HW-A', label: 'SM-S918B', serials: ['USB1', '10.0.0.5:4444']},
            {id: 'HW-B', label: 'Pixel 8', serials: ['10.0.0.9:5555']}],
        await stream.listPhones());
    check('list phones: offline devices not asked', false, sys.calls.some(c => c.includes('GONE')));
    check('list phones: nothing started', 0, sys.procs.length);
}
{
    const {sys, states, stream} = setup();
    sys.devices = TWO_PHONES;
    sys.props = TWO_PROPS;
    stream.start('back', {phone: 'HW-B'});
    await advance(sys, 1);
    check('phone: chosen phone used', true, sys.procs[0].argv.includes('--serial=10.0.0.9:5555'));
    check('phone: live', 'on', states[states.length - 1]);

    stream.start('back', {phone: 'HW-A'});
    await advance(sys, 4);
    check('phone change: stream restarted on the other phone, over USB',
        ['--serial=USB1'], sys.running.map(p => p.argv.find(a => a.startsWith('--serial='))));
    check('phone change: smart stay restored on the first phone, turned off on the second',
        ['0', '1', '0'], sys.puts());
    check('phone change: ends live', 'on', states[states.length - 1]);
}
// Nothing chosen: the first ready device, without asking any phone who it is.
{
    const {sys, stream} = setup();
    sys.devices = TWO_PHONES;
    sys.props = TWO_PROPS;
    stream.start('back');
    await advance(sys, 1);
    check('default: first ready device used', true, sys.procs[0].argv.includes('--serial=10.0.0.5:4444'));
    check('default: no phone asked for its serial number', false, sys.calls.some(c => c.includes('getprop')));
}
// The lookup must not hold up a start for long when a transport is dead.
{
    const {sys, stream} = setup();
    sys.devices = TWO_PHONES;
    sys.props = TWO_PROPS;
    stream.start('back', {phone: 'HW-B'});
    await advance(sys, 1);
    const asked = sys.calls.map((c, i) => [c, sys.timeouts[i]]).filter(([c]) => c.includes('getprop'));
    check('lookup: every ready device asked, with a short timeout', [3, true],
        [asked.length, asked.every(([, t]) => t > 0 && t <= 3)]);
}
{
    const {sys, states, stream} = setup();
    sys.devices = TWO_PHONES;
    sys.props = TWO_PROPS;
    stream.start('back', {phone: 'HW-Z'});
    await advance(sys, 21);
    check('phone: chosen phone absent is reported, no other phone used',
        ['failed:noDevice', 0], [states[states.length - 1], sys.procs.length]);
}
// A phone that does not say who it is cannot be chosen (its adb serial is no
// lasting name), but it still streams when nothing is chosen.
{
    const {sys, states, stream} = setup();
    sys.propFails = true;
    check('getprop fails: not offered', [], await stream.listPhones());
    stream.start('back');
    await advance(sys, 1);
    check('getprop fails: stream still starts when nothing is chosen', ['on', true],
        [states[states.length - 1], sys.procs[0].argv.includes(`--serial=${SERIAL}`)]);
}
{
    const {sys, stream} = setup();
    sys.devices = TWO_PHONES;
    sys.props = {...TWO_PROPS, 'USB1': 'unknown\nSM-S918B\n', '10.0.0.9:5555': 'unknown\nPixel 8\n'};
    check('placeholder serial numbers: those transports are left out, phones are not merged',
        [{id: 'HW-A', label: 'SM-S918B', serials: ['10.0.0.5:4444']}], await stream.listPhones());
}
{
    const {sys, stream} = setup();
    sys.adbMissing = true;
    let missing = null;
    await stream.listPhones().catch(e => {
        missing = e.missing;
    });
    check('list phones: adb missing is passed on', true, missing);
}

// Phones without Smart Stay are left alone.
{
    const {sys, stream} = setup();
    sys.smartStay = 'null';
    stream.start('back');
    await advance(sys, 1);
    stream.stop();
    await advance(sys, 3);
    check('no smart stay: nothing written', [], sys.puts());
}
{
    const {sys, stream} = setup();
    sys.smartStay = '0';
    stream.start('back');
    await advance(sys, 1);
    stream.stop();
    await advance(sys, 3);
    check('smart stay already off: nothing written, not turned on', [[], '0'], [sys.puts(), sys.smartStay]);
}

// A restore that fails is remembered and done after the next stream.
{
    const {sys, stream} = setup();
    stream.start('back');
    await advance(sys, 1);
    sys.putFails = true;
    stream.stop();
    await advance(sys, 3);
    check('failed restore: still off on the phone', '0', sys.smartStay);
    sys.putFails = false;
    stream.start('back');
    await advance(sys, 1);
    stream.stop();
    await advance(sys, 3);
    check('failed restore: restored after the next stream', '1', sys.smartStay);
}

// After a switch the new stream is not called live on the old one's leftovers.
{
    const {sys, states, stream} = setup();
    stream.start('back');
    await advance(sys, 1);
    sys.liveOnSpawn = false;
    stream.start('front');
    await advance(sys, 3);
    check('stale live: front is starting, not on', 'starting', states[states.length - 1]);
    sys.live = true;
    await advance(sys, 1);
    check('stale live: on once the new stream feeds the device', 'on', states[states.length - 1]);
}

// destroy() leaves nothing behind and stays silent.
{
    const {sys, states, stream} = setup();
    stream.start('back');
    await advance(sys, 1);
    const before = states.length;
    stream.destroy();
    await advance(sys, 5);
    check('destroy: process killed', [true, 0], [sys.procs[0].killed, sys.running.length]);
    check('destroy: smart stay restore sent without waiting', 1,
        sys.detached.filter(c => c.endsWith('intelligent_sleep_mode 1')).length);
    check('destroy: no callbacks afterwards', before, states.length);
    check('destroy: system resources released', true, sys.disposed);
    check('destroy: no relaunch', 1, sys.procs.length);
}
{
    const {sys, stream} = setup();
    sys.pendingRuns = [];
    stream.start('back');
    await settle();
    stream.destroy();
    sys.releaseRuns();
    await advance(sys, 5);
    check('destroy during launch: scrcpy never started', 0, sys.procs.length);
    check('destroy during launch: smart stay not left off', true,
        sys.smartStay === '1' || sys.detached.some(c => c.endsWith('intelligent_sleep_mode 1')));
}

// A throwing callback must not wedge the stream.
{
    const sys = new FakeSys();
    let calls = 0;
    const stream = new Stream(sys, () => {
        calls++;
        throw new Error('ui broke');
    });
    stream.start('back');
    await advance(sys, 1);
    stream.stop();
    await advance(sys, 3);
    check('throwing callback: stream still ran and stopped', [1, 0], [sys.procs.length, sys.running.length]);
    check('throwing callback: logged', true, sys.logs.length > 0 && calls > 0);
}

if (failed > 0)
    imports.system.exit(1);

// State machine for the phone camera stream. It decides what to run and when;
// everything that touches the outside world goes through the `sys` object
// (lib/system.js in the extension, a fake in tests/test-stream.js), so this
// file has no imports besides the pure logic.
//
// One loop owns all the work. start() and stop() only record what is wanted
// and wake the loop, so two requests can never run side by side.
import {
    parseAdbDevices, pickDevice, pickLoopback, scrcpyArgs, isLoopbackLive,
    lastErrorLine, mayRestart, smartStayWasOn,
    parsePhoneInfo, groupPhones, pickPhoneSerial,
} from './logic.js';

const RETRY_MS = 3000;
const LIVE_POLL_MS = 500;
// How long to wait for the loopback device to go idle after a process ended.
const IDLE_POLLS = 6;

// Failures that a retry cannot fix.
const PERMANENT = ['noLoopback', 'noScrcpy'];
// Asking a phone who it is must not hold up a start when a transport is dead.
const PHONE_INFO_TIMEOUT_SECONDS = 3;

function phoneInfo(serial) {
    return ['adb', '-s', serial, 'shell', 'getprop ro.serialno; getprop ro.product.model'];
}

function smartStay(serial, ...args) {
    return ['adb', '-s', serial, 'shell', 'settings', ...args, 'system', 'intelligent_sleep_mode'];
}

function smartStayPut(serial, value) {
    return [...smartStay(serial, 'put'), value];
}

export class Stream {
    // onChange(state, reason): state is 'off', 'starting', 'on' or 'failed';
    // reason is set for 'failed' ('noDevice', 'noLoopback', 'noScrcpy', or the
    // last scrcpy error line).
    constructor(sys, onChange) {
        this._sys = sys;
        this._onChange = onChange;
        this._state = 'off';
        this._want = null;          // {camera, phone, serial} while a stream is wanted
        this._proc = null;          // record of the running scrcpy
        this._failures = [];
        this._smartStaySerial = null; // phone whose Smart Stay we turned off
        this._running = false;
        this._kicks = 0;
        this._wake = null;
        this._destroyed = false;
    }

    get state() {
        return this._state;
    }

    // Starts the stream, or restarts it when the camera or phone changed.
    // phone: serial number of the phone to use, '' for the first one.
    // serial: exact adb serial to use instead; it overrides `phone`.
    start(camera, {phone = '', serial = ''} = {}) {
        this._want = {camera, phone, serial};
        this._failures = [];
        this._kick();
    }

    stop() {
        this._want = null;
        this._kick();
    }

    // The connected phones as [{id, label, serials}], one entry per phone even
    // when adb reaches it over several transports. A transport whose phone
    // does not say who it is is left out: its adb serial is no lasting name.
    // Rejects when adb fails.
    async listPhones() {
        const ready = parseAdbDevices(await this._sys.run(['adb', 'devices']))
            .filter(d => d.state === 'device');
        const seen = await Promise.all(ready.map(async ({serial}) => {
            const info = await this._sys.run(phoneInfo(serial), PHONE_INFO_TIMEOUT_SECONDS)
                .then(parsePhoneInfo).catch(() => null);
            return info ? {serial, ...info} : null;
        }));
        return groupPhones(seen.filter(Boolean));
    }

    destroy() {
        this._destroyed = true;
        this._want = null;
        if (this._proc) {
            this._proc.killed = true;
            this._proc.handle.kill();
        }
        this._restoreSmartStayDetached();
        this._kick();
        this._sys.dispose();
    }

    _set(state, reason = null) {
        this._state = state;
        if (this._destroyed)
            return;
        try {
            this._onChange(state, reason);
        } catch (e) {
            this._sys.log(`state callback failed: ${e.message}`);
        }
    }

    _kick() {
        this._kicks++;
        this._wake?.();
        this._wake = null;
        if (!this._running && !this._destroyed) {
            this._running = true;
            this._loop()
                .catch(e => {
                    this._sys.log(`stream loop failed: ${e.message}`);
                    this._want = null;
                    this._set('failed');
                })
                .finally(() => {
                    this._running = false;
                });
        }
    }

    // Resolves on the next start(), stop() or destroy().
    _woken() {
        return new Promise(resolve => {
            this._wake = resolve;
        });
    }

    async _loop() {
        let triedRestore = false;
        while (!this._destroyed) {
            const kicks = this._kicks;
            const want = this._want;
            const proc = this._proc;

            if (proc) {
                if (proc.done) {
                    this._proc = null;
                    await this._waitIdle(proc.device);
                    if (!proc.killed && this._want)
                        await this._failed(lastErrorLine(proc.lines));
                    continue;
                }
                if (!want || want.camera !== proc.camera || want.phone !== proc.phone || want.serial !== proc.serial) {
                    proc.killed = true;
                    proc.handle.kill();
                    await proc.exited;
                    continue;
                }
                if (this._state !== 'on') {
                    const state = await this._sys.loopbackState(proc.device).catch(() => null);
                    if (this._destroyed || proc.done || kicks !== this._kicks)
                        continue;
                    if (isLoopbackLive(state)) {
                        this._set('on');
                        continue;
                    }
                    await Promise.race([proc.exited, this._woken(), this._sys.sleep(LIVE_POLL_MS)]);
                    continue;
                }
                await Promise.race([proc.exited, this._woken()]);
                continue;
            }

            if (!want) {
                if (this._smartStaySerial && !triedRestore) {
                    triedRestore = true;
                    await this._restoreSmartStay();
                    continue;
                }
                if (this._state !== 'failed')
                    this._set('off');
                return;
            }

            triedRestore = false;
            if (this._state !== 'starting')
                this._set('starting');
            const failure = await this._launch(want);
            if (failure && !this._destroyed && this._want)
                await this._failed(failure);
        }
    }

    // Spawns scrcpy for `want`. Returns null on success or a failure reason.
    async _launch(want) {
        const device = pickLoopback(await this._sys.listLoopbacks().catch(() => []));
        if (!device)
            return 'noLoopback';

        let serial;
        try {
            // Only a chosen phone has to be found by its serial number;
            // otherwise the first ready device will do, as `adb devices` lists it.
            serial = want.phone && !want.serial
                ? pickPhoneSerial(await this.listPhones(), want.phone)
                : pickDevice(parseAdbDevices(await this._sys.run(['adb', 'devices'])), want.serial);
        } catch (e) {
            return e.missing ? 'noScrcpy' : 'noDevice';
        }
        if (!serial)
            return 'noDevice';

        await this._disableSmartStay(serial);
        if (this._destroyed) {
            this._restoreSmartStayDetached();
            return null;
        }

        let handle;
        try {
            handle = this._sys.spawn(scrcpyArgs({serial, camera: want.camera, device}));
        } catch (e) {
            return e.missing ? 'noScrcpy' : e.message;
        }
        const proc = {
            handle, device, camera: want.camera, phone: want.phone, serial: want.serial,
            done: false, killed: false, lines: [],
        };
        proc.exited = handle.exited.then(lines => {
            proc.done = true;
            proc.lines = lines ?? [];
        });
        this._proc = proc;
        return null;
    }

    // The stream could not start or died on its own: wait and let the loop try
    // again, or give up.
    async _failed(reason) {
        const now = this._sys.now();
        this._failures.push(now);
        if (PERMANENT.includes(reason) || !mayRestart(this._failures, now)) {
            this._want = null;
            this._set('failed', reason);
            return;
        }
        if (this._state !== 'starting')
            this._set('starting');
        await Promise.race([this._woken(), this._sys.sleep(RETRY_MS)]);
    }

    // The sysfs state lags behind the process. Wait for it to read idle so the
    // next stream is not reported live on the previous one's leftovers.
    async _waitIdle(device) {
        for (let i = 0; i < IDLE_POLLS && !this._destroyed; i++) {
            const state = await this._sys.loopbackState(device).catch(() => null);
            if (!isLoopbackLive(state))
                return;
            await this._sys.sleep(LIVE_POLL_MS);
        }
    }

    // Smart Stay stays off across camera switches and retries; it is restored
    // only when the stream ends. See smartStayWasOn() for why it matters.
    async _disableSmartStay(serial) {
        if (this._smartStaySerial === serial)
            return;
        await this._restoreSmartStay();
        try {
            if (!smartStayWasOn(await this._sys.run(smartStay(serial, 'get'))))
                return;
            await this._sys.run(smartStayPut(serial, '0'));
            this._smartStaySerial = serial;
        } catch {
            // Best effort: the stream works without it.
        }
    }

    // On failure the serial is kept, so the restore is tried again when the
    // next stream ends.
    async _restoreSmartStay() {
        const serial = this._smartStaySerial;
        if (!serial)
            return;
        try {
            await this._sys.run(smartStayPut(serial, '1'));
            this._smartStaySerial = null;
        } catch (e) {
            this._sys.log(`could not restore Smart Stay on ${serial}: ${e.message}`);
        }
    }

    // For destroy(), which cannot wait.
    _restoreSmartStayDetached() {
        const serial = this._smartStaySerial;
        if (!serial)
            return;
        this._smartStaySerial = null;
        this._sys.runDetached(smartStayPut(serial, '1'));
    }
}

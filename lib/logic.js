// Pure logic for the Phone Webcam extension. No GNOME Shell or GLib imports,
// so it runs under plain gjs for tests (gjs -m tests/test-logic.js).

export const ICON = 'camera-web-symbolic';

export const CAMERAS = [
    {id: 'back', labels: {tr: 'Arka kamera', en: 'Back camera'}},
    {id: 'front', labels: {tr: 'Ön kamera', en: 'Front camera'}},
];

export const TEXT = {
    tr: {
        title: 'Telefon Webcam',
        off: 'Kapalı',
        starting: 'Bağlanıyor',
        failed: 'Bağlanamadı',
        noDevice: 'Telefon bulunamadı',
        noLoopback: 'v4l2loopback yüklü değil',
        noScrcpy: 'scrcpy ya da adb yok',
    },
    en: {
        title: 'Phone Webcam',
        off: 'Off',
        starting: 'Connecting',
        failed: 'Failed',
        noDevice: 'No phone found',
        noLoopback: 'v4l2loopback not loaded',
        noScrcpy: 'scrcpy or adb missing',
    },
};

const FAILURE_REASONS = ['noDevice', 'noLoopback', 'noScrcpy'];

// Restart policy after the stream dies on its own: give up after
// MAX_FAILURES within WINDOW_SECONDS.
const MAX_FAILURES = 5;
const WINDOW_SECONDS = 60;

export function pickLang(names) {
    return (names ?? []).some(n => n === 'tr' || n.startsWith('tr_')) ? 'tr' : 'en';
}

export function knownCamera(id) {
    return CAMERAS.some(c => c.id === id) ? id : CAMERAS[0].id;
}

// What the tile shows for a stream state ('off', 'starting', 'on', 'failed').
export function describe(state) {
    return {
        checked: state === 'on' || state === 'starting',
        topBar: state === 'on',
    };
}

// While streaming the tile names the camera; a failure names its reason when
// it is one the user can act on.
export function subtitleFor(state, cameraId, lang, reason = null) {
    const text = TEXT[lang];
    if (state === 'on')
        return CAMERAS.find(c => c.id === knownCamera(cameraId)).labels[lang];
    if (state === 'failed')
        return FAILURE_REASONS.includes(reason) ? text[reason] : text.failed;
    return text[state] ?? text.off;
}

// Parses `adb devices` output into [{serial, state}].
export function parseAdbDevices(output) {
    const devices = [];
    for (const line of (output ?? '').split('\n')) {
        const match = line.match(/^(\S+)\t(\w+)\s*$/);
        if (match)
            devices.push({serial: match[1], state: match[2]});
    }
    return devices;
}

// Serial to stream from: the preferred one if set, else the first ready device.
// A phone on wireless debugging often shows up twice (IP and mDNS name), so
// "exactly one device" cannot be required.
export function pickDevice(devices, preferred) {
    const ready = devices.filter(d => d.state === 'device');
    if (preferred)
        return ready.some(d => d.serial === preferred) ? preferred : null;
    return ready[0]?.serial ?? null;
}

// names: entries of /sys/devices/virtual/video4linux (only virtual video
// devices live there). Returns the device node with the lowest number.
export function pickLoopback(names) {
    const numbers = names
        .map(n => n.match(/^video(\d+)$/)?.[1])
        .filter(n => n !== undefined)
        .map(Number)
        .sort((a, b) => a - b);
    return numbers.length > 0 ? `/dev/video${numbers[0]}` : null;
}

export function scrcpyArgs({serial, camera, device}) {
    return [
        'scrcpy', `--serial=${serial}`, '--video-source=camera',
        `--camera-facing=${knownCamera(camera)}`,
        '--camera-ar=16:9', '--max-size=1920', '--camera-fps=30',
        '--no-audio', '--no-window', `--v4l2-sink=${device}`,
    ];
}

// Content of the loopback device's sysfs "state" file: "capture" once a
// producer feeds it, "output" while idle. scrcpy's own log cannot be used for
// this because its stdout is block buffered when piped.
export function isLoopbackLive(state) {
    return (state ?? '').trim() === 'capture';
}

export function lastErrorLine(lines) {
    for (let i = lines.length - 1; i >= 0; i--) {
        const match = lines[i].match(/ERROR: (.*)$/);
        if (match)
            return match[1];
    }
    return null;
}

// failureTimes: seconds at which the stream died unexpectedly, oldest first.
export function mayRestart(failureTimes, now) {
    return failureTimes.filter(t => now - t < WINDOW_SECONDS).length < MAX_FAILURES;
}

// Samsung's Smart Stay opens the front camera before the screen dims, which
// makes Android take the camera away from scrcpy. The value is "1" when it is
// on and "null" on phones without the setting.
export function smartStayWasOn(output) {
    return (output ?? '').trim() === '1';
}

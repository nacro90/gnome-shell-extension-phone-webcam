// Tests for lib/logic.js. Run: gjs -m tests/test-logic.js
import {
    TEXT, CAMERAS, pickLang, describe, subtitleFor, knownCamera,
    parseAdbDevices, pickDevice, pickLoopback, scrcpyArgs, isLoopbackLive,
    lastErrorLine, mayRestart, smartStayWasOn,
} from '../lib/logic.js';

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

check('lang: Turkish locale', 'tr', pickLang(['tr_TR.UTF-8', 'tr_TR', 'tr', 'C']));
check('lang: other locale falls back to English', 'en', pickLang(['de_DE.UTF-8', 'de', 'C']));
check('lang: empty list', 'en', pickLang([]));
for (const lang of ['tr', 'en']) {
    for (const key of ['title', 'off', 'starting', 'failed', 'noDevice', 'noLoopback', 'noScrcpy'])
        check(`text ${lang}.${key} exists`, true, typeof TEXT[lang][key] === 'string' && TEXT[lang][key].length > 0);
}

check('two cameras, back first', ['back', 'front'], CAMERAS.map(c => c.id));
check('camera: known id kept', 'front', knownCamera('front'));
check('camera: unknown id becomes back', 'back', knownCamera('side'));

check('on is checked with top bar icon', {checked: true, topBar: true}, describe('on'));
check('starting is checked without icon', {checked: true, topBar: false}, describe('starting'));
check('off', {checked: false, topBar: false}, describe('off'));
check('failed', {checked: false, topBar: false}, describe('failed'));
check('unknown state is off', {checked: false, topBar: false}, describe(undefined));

check('subtitle: streaming names the camera', 'Front camera', subtitleFor('on', 'front', 'en'));
check('subtitle: streaming names the camera (tr)', 'Arka kamera', subtitleFor('on', 'back', 'tr'));
check('subtitle: off', 'Off', subtitleFor('off', 'back', 'en'));
check('subtitle: failed without reason', 'Failed', subtitleFor('failed', 'back', 'en'));
check('subtitle: failed with known reason', 'No phone found', subtitleFor('failed', 'back', 'en', 'noDevice'));
check('subtitle: failed with unknown reason', 'Failed', subtitleFor('failed', 'back', 'en', 'whatever'));

const ADB = `List of devices attached
192.168.1.20:41143\tdevice
adb-ABC123-xyz._adb-tls-connect._tcp\tdevice
EMULATOR5554\toffline
USB999\tunauthorized

`;
check('adb: parses serial and state', [
    {serial: '192.168.1.20:41143', state: 'device'},
    {serial: 'adb-ABC123-xyz._adb-tls-connect._tcp', state: 'device'},
    {serial: 'EMULATOR5554', state: 'offline'},
    {serial: 'USB999', state: 'unauthorized'},
], parseAdbDevices(ADB));
check('adb: empty output', [], parseAdbDevices('List of devices attached\n\n'));
check('adb: null output', [], parseAdbDevices(null));
check('adb: daemon chatter ignored', [{serial: 'X1', state: 'device'}],
    parseAdbDevices('* daemon not running; starting now at tcp:5037\n* daemon started successfully\nList of devices attached\nX1\tdevice\n'));

const devices = parseAdbDevices(ADB);
check('device: first ready one by default', '192.168.1.20:41143', pickDevice(devices, ''));
check('device: preferred serial wins', 'adb-ABC123-xyz._adb-tls-connect._tcp',
    pickDevice(devices, 'adb-ABC123-xyz._adb-tls-connect._tcp'));
check('device: preferred but not ready is not used', null, pickDevice(devices, 'USB999'));
check('device: preferred but absent is not used', null, pickDevice(devices, 'NOPE'));
check('device: none ready', null, pickDevice(parseAdbDevices('List of devices attached\nA\toffline\n'), ''));

check('loopback: lowest number wins', '/dev/video2', pickLoopback(['video10', 'video2']));
check('loopback: single', '/dev/video10', pickLoopback(['video10']));
check('loopback: none', null, pickLoopback([]));
check('loopback: junk ignored', '/dev/video7', pickLoopback(['foo', 'video7', 'videoX']));

check('scrcpy args', [
    'scrcpy', '--serial=S1', '--video-source=camera', '--camera-facing=front',
    '--camera-ar=16:9', '--max-size=1920', '--camera-fps=30',
    '--no-audio', '--no-window', '--v4l2-sink=/dev/video10',
], scrcpyArgs({serial: 'S1', camera: 'front', device: '/dev/video10'}));
check('scrcpy args: unknown camera becomes back', '--camera-facing=back',
    scrcpyArgs({serial: 'S1', camera: 'side', device: '/dev/video10'})[3]);

check('loopback live: producer attached', true, isLoopbackLive('capture\n'));
check('loopback live: idle', false, isLoopbackLive('output\n'));
check('loopback live: unreadable', false, isLoopbackLive(null));

check('error: last ERROR line', 'Could not open camera',
    lastErrorLine(['INFO: x', 'ERROR: first', '[server] ERROR: Could not open camera', 'INFO: y']));
check('error: none', null, lastErrorLine(['INFO: x']));

check('restart: no failures yet', true, mayRestart([], 100));
check('restart: four recent failures', true, mayRestart([50, 60, 70, 80], 100));
check('restart: five recent failures stops', false, mayRestart([50, 60, 70, 80, 90], 100));
check('restart: old failures do not count', true, mayRestart([1, 2, 3, 4, 90], 100));
check('restart: a failure exactly 60 s old no longer counts', true, mayRestart([40, 50, 60, 70, 80], 100));
check('restart: a failure just under 60 s old counts', false, mayRestart([40.5, 50, 60, 70, 80], 100));

check('smart stay: on', true, smartStayWasOn('1\n'));
check('smart stay: off', false, smartStayWasOn('0\n'));
check('smart stay: key missing on non-Samsung', false, smartStayWasOn('null\n'));
check('smart stay: no output', false, smartStayWasOn(null));

if (failed > 0)
    imports.system.exit(1);

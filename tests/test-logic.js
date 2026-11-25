// Tests for lib/logic.js. Run: gjs -m tests/test-logic.js
import {
    TEXT, CAMERAS, pickLang, describe, subtitleFor, knownCamera,
    parseAdbDevices, pickDevice, pickLoopback, scrcpyArgs, isLoopbackLive,
    lastErrorLine, mayRestart, smartStayWasOn,
    parsePhoneInfo, groupPhones, pickPhoneSerial, phoneMenu, samePhoneItems, restartsOnPhoneChange,
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

// Phones: the same phone can be reachable over several adb transports.
check('phone info: serial number and model', {id: 'R5CW1234', model: 'SM-S918B'},
    parsePhoneInfo('R5CW1234\nSM-S918B\n'));
check('phone info: CRLF line ends', {id: 'R5CW1234', model: 'SM-S918B'},
    parsePhoneInfo('R5CW1234\r\nSM-S918B\r\n'));
check('phone info: model missing', {id: 'R5CW1234', model: ''}, parsePhoneInfo('R5CW1234\n\n'));
check('phone info: no serial number', null, parsePhoneInfo('\nSM-S918B\n'));
check('phone info: no output', null, parsePhoneInfo(null));
for (const placeholder of ['unknown', 'UNKNOWN', '0123456789ABCDEF', '0123456789abcdef', '00000000'])
    check(`phone info: placeholder serial number ${placeholder} identifies nothing`, null, parsePhoneInfo(`${placeholder}\nCheap Phone\n`));

const seen = [
    {serial: '192.168.1.20:41143', id: 'HW-A', model: 'SM-S918B'},
    {serial: 'adb-HW-A-xyz._adb-tls-connect._tcp', id: 'HW-A', model: 'SM-S918B'},
    {serial: 'USBSERIAL', id: 'HW-A', model: 'SM-S918B'},
    {serial: '192.168.1.30:5555', id: 'HW-B', model: 'Pixel 8'},
];
const phones = groupPhones(seen);
check('phones: one entry per phone, in adb order', ['HW-A', 'HW-B'], phones.map(p => p.id));
check('phones: labelled by model', ['SM-S918B', 'Pixel 8'], phones.map(p => p.label));
check('phones: USB transport first, then adb order',
    ['USBSERIAL', '192.168.1.20:41143', 'adb-HW-A-xyz._adb-tls-connect._tcp'], phones[0].serials);
check('phones: same model told apart by serial number ending',
    ['Pixel 8 (1111)', 'Pixel 8 (2222)'],
    groupPhones([
        {serial: 'a', id: 'XX1111', model: 'Pixel 8'},
        {serial: 'b', id: 'YY2222', model: 'Pixel 8'},
    ]).map(p => p.label));
check('phones: empty model falls back to the serial number', ['HW-C'],
    groupPhones([{serial: 'c', id: 'HW-C', model: ''}]).map(p => p.label));
check('phones: none', [], groupPhones([]));

check('phone pick: first phone by default', 'USBSERIAL', pickPhoneSerial(phones, ''));
check('phone pick: chosen phone', '192.168.1.30:5555', pickPhoneSerial(phones, 'HW-B'));
check('phone pick: chosen phone absent, no silent fallback', null, pickPhoneSerial(phones, 'HW-Z'));
check('phone pick: no phones', null, pickPhoneSerial([], ''));

check('phone menu: hidden with a single phone', false, phoneMenu(groupPhones(seen.slice(0, 3)), '').visible);
check('phone menu: hidden with a single phone that is the chosen one', false,
    phoneMenu(groupPhones(seen.slice(0, 3)), 'HW-A').visible);
check('phone menu: hidden without phones', false, phoneMenu([], 'HW-A').visible);
check('phone menu: shown with two phones, chosen one marked',
    {visible: true, items: [
        {id: 'HW-A', label: 'SM-S918B', selected: false},
        {id: 'HW-B', label: 'Pixel 8', selected: true},
    ]}, phoneMenu(phones, 'HW-B'));
check('phone menu: nothing chosen marks the first, which is the one used',
    [true, false], phoneMenu(phones, '').items.map(i => i.selected));
check('phone menu: shown when the chosen phone is absent, so another can be picked',
    {visible: true, items: [{id: 'HW-A', label: 'SM-S918B', selected: false}]},
    phoneMenu(groupPhones(seen.slice(0, 3)), 'HW-Z'));
check('phone menu: hidden while an adb serial override is set, since it decides the phone', false,
    phoneMenu(phones, 'HW-B', 'USBSERIAL').visible);

const shown = phoneMenu(phones, 'HW-A').items;
check('phone items: same phones, other selection', true, samePhoneItems(shown, phoneMenu(phones, 'HW-B').items));
check('phone items: a phone left', false, samePhoneItems(shown, shown.slice(0, 1)));
check('phone items: a label changed', false, samePhoneItems(shown, shown.map(i => ({...i, label: `${i.label}!`}))));
check('phone items: other order', false, samePhoneItems(shown, [...shown].reverse()));
check('phone items: both empty', true, samePhoneItems([], []));

check('phone change: restarts a running stream', true, restartsOnPhoneChange('on'));
check('phone change: restarts a connecting stream', true, restartsOnPhoneChange('starting'));
check('phone change: retries after a failure, such as the chosen phone being absent', true, restartsOnPhoneChange('failed'));
check('phone change: does not start a stream that is off', false, restartsOnPhoneChange('off'));

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

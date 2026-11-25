// The real `sys` for lib/stream.js: subprocesses, sysfs and timers through
// Gio and GLib. All I/O is asynchronous. No GNOME Shell imports, so
// tools/try-stream.js can use it from a terminal.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const LOOPBACK_SYSFS = '/sys/devices/virtual/video4linux';
const RUN_TIMEOUT_SECONDS = 10;
const KEPT_LOG_LINES = 20;
const SIGTERM = 15;

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');

// Marks "the program is not installed" so the stream can name it.
function spawnError(e) {
    const missing = e.matches?.(GLib.SpawnError, GLib.SpawnError.NOENT) ?? false;
    return Object.assign(new Error(e.message), {missing});
}

export class System {
    constructor() {
        this._sources = new Set();
        this._cancellable = new Gio.Cancellable();
    }

    // Runs a short command and returns its stdout. Rejects when the program is
    // missing (error.missing), exits non-zero or takes too long.
    async run(argv) {
        let proc;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            throw spawnError(e);
        }
        const timeoutId = this._addTimeout(RUN_TIMEOUT_SECONDS * 1000, () => proc.force_exit());
        try {
            const [stdout] = await proc.communicate_utf8_async(null, this._cancellable);
            if (!proc.get_successful())
                throw new Error(`${argv[0]} failed`);
            return stdout;
        } catch (e) {
            proc.force_exit();
            throw Object.assign(new Error(e.message), {missing: false});
        } finally {
            this._removeTimeout(timeoutId);
        }
    }

    // Starts a command without waiting for it; works after dispose().
    runDetached(argv) {
        try {
            Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch {
            // Program vanished; nothing more to do.
        }
    }

    // Starts a long-running command. Returns {exited, kill}; `exited` resolves
    // with the last lines of its output.
    spawn(argv) {
        let proc;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
        } catch (e) {
            throw spawnError(e);
        }
        const lines = [];
        const reading = this._readLines(proc, lines);
        const exited = proc.wait_async(null)
            .catch(() => {})
            .then(() => reading)
            .then(() => lines);
        return {exited, kill: () => proc.send_signal(SIGTERM)};
    }

    async _readLines(proc, lines) {
        const stream = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});
        const decoder = new TextDecoder();
        try {
            for (;;) {
                const [line] = await stream.read_line_async(GLib.PRIORITY_DEFAULT, null);
                if (line === null)
                    break;
                lines.push(decoder.decode(line));
                if (lines.length > KEPT_LOG_LINES)
                    lines.shift();
            }
        } catch {
            // Pipe closed with the process.
        } finally {
            stream.close(null);
        }
    }

    // Names of the virtual video devices (only those live in this directory).
    async listLoopbacks() {
        const names = [];
        let children;
        try {
            children = await Gio.File.new_for_path(LOOPBACK_SYSFS).enumerate_children_async(
                'standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, this._cancellable);
        } catch {
            return names;
        }
        for (;;) {
            const infos = await children.next_files_async(16, GLib.PRIORITY_DEFAULT, this._cancellable);
            if (infos.length === 0)
                break;
            infos.forEach(info => names.push(info.get_name()));
        }
        return names;
    }

    // Content of the loopback device's sysfs "state" file.
    async loopbackState(device) {
        const file = Gio.File.new_for_path(`${LOOPBACK_SYSFS}/${device.replace('/dev/', '')}/state`);
        const [contents] = await file.load_contents_async(this._cancellable);
        return new TextDecoder().decode(contents);
    }

    // Never resolves once dispose() ran.
    sleep(ms) {
        return new Promise(resolve => this._addTimeout(ms, resolve));
    }

    now() {
        return GLib.get_monotonic_time() / 1e6;
    }

    log(message) {
        console.warn(`phone-webcam: ${message}`);
    }

    dispose() {
        for (const id of this._sources)
            GLib.Source.remove(id);
        this._sources.clear();
        this._cancellable.cancel();
    }

    _addTimeout(ms, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._sources.delete(id);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this._sources.add(id);
        return id;
    }

    _removeTimeout(id) {
        if (this._sources.delete(id))
            GLib.Source.remove(id);
    }
}

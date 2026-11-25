# Phone Webcam

A GNOME Shell Quick Settings toggle that turns an Android phone into a webcam.

One click streams the phone camera into a `v4l2loopback` device with
[scrcpy](https://github.com/Genymobile/scrcpy), over USB or wireless debugging.
Meet, Zoom, OBS and browsers then see it as a regular camera. Nothing is
installed on the phone.

- Click the tile to start or stop the stream.
- Open the tile menu to switch between the back and the front camera.
- With more than one phone connected, the same menu lists the phones to choose
  from.
- A camera icon sits in the top bar while the stream is live.
- If Android takes the camera away (face unlock, another camera app), the
  stream reconnects on its own.

When the stream is off, no process runs on the computer or the phone.

## Requirements

- GNOME Shell 50
- `scrcpy` 2.2 or newer and `adb`
- The `v4l2loopback` kernel module
- An Android 12 or newer phone with USB debugging or wireless debugging enabled
  and already authorized for this computer (`adb devices` lists it as `device`)

Load the module once per boot:

```bash
sudo modprobe v4l2loopback card_label="Phone" exclusive_caps=1
```

Or make it permanent:

```bash
echo v4l2loopback | sudo tee /etc/modules-load.d/v4l2loopback.conf
echo 'options v4l2loopback card_label="Phone" exclusive_caps=1' | sudo tee /etc/modprobe.d/v4l2loopback.conf
```

`exclusive_caps=1` matters: browsers ignore the device without it.

## Install

Download the zip from the
[latest release](https://github.com/nacro90/gnome-shell-extension-phone-webcam/releases/latest), then:

```bash
gnome-extensions install --force phone-webcam@nacro90.github.io.shell-extension.zip
```

Log out and back in, then:

```bash
gnome-extensions enable phone-webcam@nacro90.github.io
```

From a checkout, `make install` does the packing and installing.

## Settings

There is no preferences window. The tile menu sets the camera and the phone.
All keys can also be changed in dconf Editor under `/org/gnome/shell/extensions/phone-webcam/`,
or from a checkout:

```bash
glib-compile-schemas schemas
gsettings --schemadir schemas set org.gnome.shell.extensions.phone-webcam serial 'YOUR_SERIAL'
```

| Key | Default | Meaning |
|---|---|---|
| `camera` | `back` | `back` or `front`. The tile menu sets this. |
| `device` | empty | Serial number of the phone to use. The tile menu sets this. Empty means the first connected phone. |
| `serial` | empty | Exact adb serial to use; overrides `device` and hides the phone list. For setups the menu cannot express. |

## Good to know

- Start the stream before opening the app that uses the camera. With
  `exclusive_caps=1` the device is only announced as a camera while it is fed.
- The camera sensor is landscape. Hold the phone sideways, or the picture is
  rotated by 90 degrees.
- The stream is 16:9, at most 1920 pixels wide, 30 fps, without audio.
- Samsung phones: Smart Stay opens the front camera before the screen dims,
  which makes Android close the stream. The extension turns Smart Stay off
  while streaming and turns it back on afterwards. Other phones are not touched.
- A phone is recognized by its serial number, so it is listed once even when
  adb reaches it over USB and wireless debugging at the same time, and the
  choice survives the port changes of wireless debugging. A chosen phone is
  streamed over USB when it is plugged in.
- Until a phone is chosen in the menu, the first device listed by
  `adb devices` is used.
- If the chosen phone is not connected the tile says so; it does not fall back
  to another phone. The menu then lists the connected phones, and picking one
  starts the stream on it.
- A phone that reports no serial number of its own (some report `unknown`) is
  not listed. It still works while no phone is chosen in the menu, or through
  the `serial` key.
- The first virtual video device (lowest number) is used as the target.
- The stream keeps running while the screen is locked, so a call survives the
  lock screen. The tile is hidden there; starting needs an unlocked session.
- If GNOME Shell crashes, a running `scrcpy` is left behind. `pkill -x scrcpy`
  ends it.

## Troubleshooting

| Tile says | Check |
|---|---|
| No phone found | `adb devices` must list the phone as `device`. Wireless debugging turns itself off when the phone reboots. |
| v4l2loopback not loaded | Run the `modprobe` command above. |
| scrcpy or adb missing | Install both and make sure they are on `PATH`. |
| Failed | Run `gjs -m tools/try-stream.js back 10` from a checkout to see the states, or run `scrcpy --video-source=camera --no-window` to see scrcpy's own error. |

## Development

```bash
make test      # unit tests (logic and the stream state machine) and a schema check
make pack      # build the zip
gjs -m tools/try-stream.js back 20   # drive a real phone without GNOME Shell
```

`lib/logic.js` holds the pure helpers. `lib/stream.js` is the state machine
(when to start, retry, switch, restore); it reaches the outside world only
through a `sys` object, so the tests drive it with a fake. `lib/system.js` is
the real `sys` (adb, scrcpy, sysfs, timers) on Gio and GLib. `extension.js` is
the Quick Settings UI.

Releases are automatic: every push is tested and packed, and a push to `main`
whose `version-name` in `metadata.json` has no release yet is published as a
GitHub release. Bump `version-name` to ship.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).

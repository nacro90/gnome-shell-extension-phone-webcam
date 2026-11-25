// Quick Settings tile that turns an Android phone into a webcam.
//
// Tile:    click starts or stops the stream; the subtitle shows the state, or
//          the camera while streaming. The arrow opens a menu to pick the back
//          or front camera, which (re)starts the stream with it. With more than
//          one phone connected the menu also lists the phones.
// Top bar: a camera icon is shown only while the stream is running.
//
// The stream keeps running while the screen is locked (session mode
// "unlock-dialog"), so a call survives the lock screen. The tile is hidden
// there: nobody can start the camera without unlocking.
//
// lib/stream.js decides what to run; lib/system.js runs it (adb, scrcpy).
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {
    ICON, TEXT, CAMERAS, pickLang, describe, subtitleFor, knownCamera,
    phoneMenu, samePhoneItems, restartsOnPhoneChange,
} from './lib/logic.js';
import {Stream} from './lib/stream.js';
import {System} from './lib/system.js';

const KNOWN_REASONS = ['noDevice', 'noLoopback', 'noScrcpy'];

const WebcamToggle = GObject.registerClass({
    Signals: {
        'camera-requested': {param_types: [GObject.TYPE_STRING]},
        'phone-requested': {param_types: [GObject.TYPE_STRING]},
    },
}, class WebcamToggle extends QuickSettings.QuickMenuToggle {
    _init(lang) {
        super._init({
            title: TEXT[lang].title,
            subtitle: TEXT[lang].off,
            iconName: ICON,
            toggleMode: false,
        });
        this._lang = lang;

        this.menu.setHeader(ICON, TEXT[lang].title);
        this._items = new Map();
        for (const camera of CAMERAS) {
            const item = new PopupMenu.PopupMenuItem(camera.labels[lang]);
            item.connect('activate', () => this.emit('camera-requested', camera.id));
            this.menu.addMenuItem(item);
            this._items.set(camera.id, item);
        }

        this._shownPhones = [];
        this._phoneItems = [];
        this._phoneSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this._phoneSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._phoneSeparator);
        this.menu.addMenuItem(this._phoneSection);
        this.showPhones({visible: false, items: []});
    }

    // Takes the result of phoneMenu(). The items are rebuilt only when the
    // phones themselves changed: a rebuild destroys the item under the pointer,
    // which must not happen while that item is being activated.
    showPhones({visible, items}) {
        if (!samePhoneItems(items, this._shownPhones)) {
            this._phoneSection.removeAll();
            this._phoneItems = items.map(phone => {
                const item = new PopupMenu.PopupMenuItem(phone.label);
                item.connect('activate', () => this.emit('phone-requested', phone.id));
                this._phoneSection.addMenuItem(item);
                return item;
            });
        }
        this._shownPhones = items;
        items.forEach((phone, i) => this._phoneItems[i].setOrnament(
            phone.selected ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE));
        this._phoneSeparator.visible = visible;
        this._phoneSection.actor.visible = visible;
    }

    showState(state, reason, cameraId) {
        this.subtitle = subtitleFor(state, cameraId, this._lang, reason);
        this.checked = describe(state).checked;
        for (const [id, item] of this._items) {
            item.setOrnament(id === cameraId
                ? PopupMenu.Ornament.DOT
                : PopupMenu.Ornament.NONE);
        }
    }
});

const WebcamIndicator = GObject.registerClass(
class WebcamIndicator extends QuickSettings.SystemIndicator {
    _init(settings) {
        super._init();

        this._settings = settings;
        this._state = 'off';
        this._reason = null;
        this._phones = [];
        this._refreshing = false;

        this._icon = this._addIndicator();
        this._icon.icon_name = ICON;
        this._icon.visible = false;

        this._toggle = new WebcamToggle(pickLang(GLib.get_language_names()));
        this._toggle.connect('clicked', () => this._onClicked());
        this._toggle.connect('camera-requested', (_toggle, id) => this._setCamera(id));
        this._toggle.connect('phone-requested', (_toggle, id) => this._setPhone(id));
        this._toggle.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._refreshPhones();
        });
        this.quickSettingsItems.push(this._toggle);

        this._stream = new Stream(new System(), (state, reason) => {
            this._state = state;
            this._reason = reason;
            if (state === 'failed' && !KNOWN_REASONS.includes(reason))
                console.warn(`phone-webcam: stream failed: ${reason ?? 'unknown error'}`);
            this._show();
        });
        this._cameraChangedId = this._settings.connect('changed::camera', () => this._show());
        this._phoneChangedIds = ['device', 'serial'].map(key =>
            this._settings.connect(`changed::${key}`, () => this._showPhones()));
        this._sessionId = Main.sessionMode.connect('updated', () => this._syncLocked());
        this._syncLocked();
        this._show();
    }

    get _camera() {
        return knownCamera(this._settings.get_string('camera'));
    }

    _syncLocked() {
        this._toggle.visible = !Main.sessionMode.isLocked;
    }

    _show() {
        this._toggle.showState(this._state, this._reason, this._camera);
        this._icon.visible = describe(this._state).topBar;
    }

    _showPhones() {
        this._toggle.showPhones(phoneMenu(this._phones,
            this._settings.get_string('device'), this._settings.get_string('serial')));
    }

    // The phones are looked up each time the menu opens; nothing polls. One
    // lookup runs at a time, so an older answer can never replace a newer one.
    async _refreshPhones() {
        if (this._refreshing)
            return;
        this._refreshing = true;
        const stream = this._stream;
        const phones = await stream.listPhones().catch(() => []);
        this._refreshing = false;
        if (this._stream !== stream)
            return;
        this._phones = phones;
        this._showPhones();
    }

    _start() {
        this._stream.start(this._camera, {
            phone: this._settings.get_string('device'),
            serial: this._settings.get_string('serial'),
        });
    }

    _onClicked() {
        if (describe(this._state).checked)
            this._stream.stop();
        else
            this._start();
    }

    _setCamera(id) {
        this._settings.set_string('camera', id);
        this._start();
    }

    _setPhone(id) {
        this._settings.set_string('device', id);
        if (restartsOnPhoneChange(this._state))
            this._start();
    }

    destroy() {
        this._stream.destroy();
        this._stream = null;
        Main.sessionMode.disconnect(this._sessionId);
        this._settings.disconnect(this._cameraChangedId);
        this._phoneChangedIds.forEach(id => this._settings.disconnect(id));
        this._settings = null;
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});

export default class PhoneWebcam extends Extension {
    enable() {
        this._indicator = new WebcamIndicator(this.getSettings());
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}

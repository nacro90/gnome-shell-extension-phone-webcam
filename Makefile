UUID := phone-webcam@nacro90.github.io
ZIP := $(UUID).shell-extension.zip
FILES := metadata.json extension.js lib schemas/org.gnome.shell.extensions.phone-webcam.gschema.xml LICENSE

.PHONY: test pack install clean

test:
	gjs -m tests/test-logic.js
	gjs -m tests/test-stream.js
	glib-compile-schemas --strict --dry-run schemas

pack: clean
	zip -qr $(ZIP) $(FILES)

install: pack
	gnome-extensions install --force $(ZIP)

clean:
	rm -f $(ZIP)

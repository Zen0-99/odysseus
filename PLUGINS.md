# Odysseus Plugin Developer Guide

This guide teaches you how to build plugins for Odysseus. A plugin is a self-contained bundle of frontend JavaScript, optional Python backend hooks, and static assets that extends the Odysseus web UI and server runtime.

---

## What Is a Plugin?

An Odysseus plugin is a folder with at minimum:

- `odysseus-plugin.json` — the manifest
- `index.js` — the frontend script

Optionally you can add:

- `plugin.py` — backend Python hooks
- `styles.css` — stylesheet injected into the main app
- Images, fonts, or other static assets

When a user installs your plugin, Odysseus:

1. Loads your frontend script into a sandboxed iframe.
2. Injects any declared stylesheets into the main page.
3. Imports your backend module and calls lifecycle hooks (`on_startup`, `on_install`, etc.).
4. Registers any panels you declared so they appear in the left sidebar.

---

## Hello, Odysseus

Create a folder named `hello-odysseus` and add two files.

### `odysseus-plugin.json`

```json
{
  "id": "io.odysseus.hello",
  "name": "Hello Odysseus",
  "version": "1.0.0",
  "description": "A minimal plugin that greets the user.",
  "entrypoints": {
    "frontend": "index.js"
  },
  "panels": [
    {
      "id": "hello-panel",
      "label": "Hello",
      "icon": ""
    }
  ]
}
```

The `id` should be a reverse-domain string. The `panels` array tells Odysseus to create a sidebar button. When clicked, it opens an iframe running your `index.js`.

### `index.js`

```js
(function() {
  var panelId = window.odysseus.getPanelId();

  if (panelId) {
    // We are inside a panel iframe
    document.body.innerHTML =
      '<h1>Hello from ' + panelId + '</h1>' +
      '<p>This plugin is running inside Odysseus.</p>';
    // Change the app title while this panel is active
    window.odysseus.setTitle('Hello Odysseus');
  } else {
    // We are in the background iframe
    console.log('[Hello Plugin] Background script loaded');
  }
})();
```

### Testing locally

Place the `hello-odysseus` folder inside the Odysseus plugins directory:

```
data/plugins/hello-odysseus/
  odysseus-plugin.json
  index.js
```

Restart Odysseus. Open the Plugins modal. Your plugin appears in the **Installed** tab. Click it, then click the **Hello** panel icon in the left rail. You will see your custom HTML rendered in the main area.

---

## The Manifest

`odysseus-plugin.json` is the heart of every plugin. Odysseus reads it to decide what your plugin does, what to load, and how to present it.

```json
{
  "id": "io.odysseus.hello",
  "name": "Hello Odysseus",
  "version": "1.0.0",
  "description": "A minimal plugin that greets the user.",
  "entrypoints": {
    "frontend": "index.js",
    "backend": "plugin.py"
  },
  "panels": [
    { "id": "hello-panel", "label": "Hello", "icon": "" }
  ],
  "styles": ["styles.css"],
  "settings": {
    "greeting": { "type": "string", "label": "Greeting", "default": "Hello" }
  },
  "permissions": ["storage"],
  "affects": ["Greeting"],
  "file_hashes": {
    "index.js": "sha256:abc123...",
    "plugin.py": "sha256:def456..."
  }
}
```

**Required fields:** `id`, `name`, `version`, `description`, `entrypoints.frontend`, and `file_hashes`.

**Optional fields:**

- `entrypoints.backend` — Python file with lifecycle hooks.
- `panels` — UI panels registered in the sidebar.
- `styles` — CSS files injected into the main app page.
- `settings` — Schema for an auto-generated settings form.
- `permissions` — Array of required capabilities (`storage`, `network`, `dom`).
- `affects` — Custom tags shown on the plugin card (max 10).
- `theme` — Object of CSS variable overrides for the host app.

---

## Frontend Script

Your frontend script runs inside a sandboxed iframe. It cannot touch the parent DOM directly. Instead, Odysseus injects a `window.odysseus` API:

### Detecting Context

```js
var panelId = window.odysseus.getPanelId();
if (panelId) {
  // Running inside a panel iframe
} else {
  // Running in the background iframe (always loaded)
}
```

The same script is loaded twice: once as a hidden background iframe, and once per panel. Use `getPanelId()` to branch your logic.

### Events

```js
window.odysseus.on('theme-changed', function(detail) {
  console.log('Theme changed to', detail.theme);
});

window.odysseus.emit('my-plugin-event', { status: 'ready' });
```

`on` listens for events broadcast by Odysseus or other plugins. `emit` broadcasts to all listeners, including other plugin sandboxes.

### Storage

```js
window.odysseus.storage.set('count', 42);
var count = await window.odysseus.storage.get('count');
```

Storage is scoped to your plugin. Other plugins cannot read your keys.

### Settings

If your manifest declares a `settings` schema, users see an auto-generated form in the plugin detail panel. You read values like this:

```js
var greeting = await window.odysseus.getSetting('greeting');
console.log(greeting); // "Hello" or whatever the user typed
```

### Dynamic Panels

You can also register panels at runtime:

```js
window.odysseus.registerPanel({
  id: 'extra-panel',
  label: 'Extra',
  icon: ''
});
```

This is useful when a plugin needs to create panels conditionally based on settings or state.

---

## Backend Hooks

If you declare `entrypoints.backend`, Odysseus imports your Python file and calls well-known functions.

### `plugin.py`

```python
import odysseus

def on_startup():
    """Called once when the Odysseus server starts."""
    odysseus.log("info", "Hello plugin is ready")

def on_shutdown():
    """Called during graceful shutdown."""
    pass

def on_install():
    """Called immediately after the plugin is installed."""
    odysseus.log("info", "Installed")

def on_uninstall():
    """Called just before the plugin files are removed."""
    odysseus.log("info", "Uninstalled")
```

The `odysseus` module is injected by the host. It provides:

- `odysseus.get_setting(key)` — Read a plugin-scoped setting.
- `odysseus.set_setting(key, value)` — Write a plugin-scoped setting.
- `odysseus.log(level, message)` — Log with level `debug`, `info`, `warning`, or `error`.
- `odysseus.manifest()` — Return your manifest as a Python dict.

Backend hooks run **in-process** inside the same Python interpreter as Odysseus. Keep them lightweight and wrap external calls in `try/except`.

---

## Styling

Plugins can ship CSS that gets injected into the main Odysseus page.

```json
"styles": ["styles.css"]
```

Because these styles apply globally, use specific selectors. If you want to style only your panel iframe, target the `body` inside your panel — each panel gets its own iframe document.

Odysseus also exposes CSS variables you can use:

```css
body {
  background: var(--bg, #0d1117);
  color: var(--fg, #c9d1d9);
}
```

Common variables: `--bg`, `--fg`, `--panel`, `--border`, `--accent`, `--red`, `--input-bg`.

You can also override these globally for the entire app using the `theme` field:

```json
"theme": {
  "--accent": "#4caf50"
}
```

---

## Settings Form

The `settings` object in your manifest auto-generates a settings panel.

```json
"settings": {
  "greeting": {
    "type": "string",
    "label": "Greeting",
    "default": "Hello"
  },
  "darkMode": {
    "type": "boolean",
    "label": "Dark Mode",
    "default": true
  },
  "theme": {
    "type": "select",
    "label": "Theme",
    "options": ["dark", "light"],
    "default": "dark"
  },
  "notes": {
    "type": "textarea",
    "label": "Notes",
    "default": ""
  },
  "apiKey": {
    "type": "string",
    "label": "API Key",
    "secret": true,
    "default": ""
  }
}
```

Supported types:

- `string` — single-line text input
- `number` — numeric input
- `boolean` — checkbox
- `select` — dropdown (requires `options` array)
- `textarea` — multi-line text
- `secret` — password field (set `secret: true` on any string/textarea)

Values are persisted to `localStorage` and shared with the backend via `odysseus.get_setting()`.

---

## Publishing

Plugins are distributed via GitHub repositories.

### Repository Layout

```
my-odysseus-plugins/
  plugins.json
  hello-odysseus/
    odysseus-plugin.json
    index.js
    plugin.py
    styles.css
```

`plugins.json` at the repo root lists your plugin folders:

```json
{
  "plugins": ["hello-odysseus"]
}
```

Users paste the repository URL into the Odysseus Plugins modal and click **Search** to discover and install.

### Generating file_hashes

Before committing, run the hash generator so Odysseus can verify your plugin files against the manifest at install time:

```bash
python scripts/generate_plugin_hashes.py hello-odysseus
```

This computes SHA-256 for every file in the plugin folder and writes them into `odysseus-plugin.json` under `file_hashes`. The field is **mandatory** — manifests without it are rejected.

---

## Security

- **Frontend sandbox:** Frontend code runs in a unique-origin iframe. It cannot access `window.parent` or the parent DOM. All interaction goes through `window.odysseus` APIs.
- **Backend sandbox:** Backend Python hooks run in an isolated subprocess with a restricted `sys.path`. They cannot access the host's database, internal modules, or other plugins' memory.
- **Supply-chain verification:** Every plugin must declare `file_hashes` in its manifest. Odysseus verifies each file's SHA-256 against the manifest at install time and on demand. Any mismatch blocks installation.
- **Least privilege:** Only request the permissions you need. `storage` is common; `network` and `dom` should be justified.
- **CSS scoping:** Styles in `styles` are loaded globally. Avoid overly broad selectors like `* { ... }`.

---

## Troubleshooting

| Symptom | Likely Cause |
|---------|-------------|
| Plugin card shows only **Other** | Add `panels`, `settings`, or `affects` to give Odysseus more signals |
| Panel iframe is blank | Check browser DevTools console inside the iframe for JS errors |
| Styles not applying | Verify filenames in `styles` match actual files; check DevTools Network tab |
| Backend hook not called | Ensure `entrypoints.backend` filename is correct; check server logs for import errors |
| `registerPanel` does nothing | Must be called from inside the sandbox iframe, not the host page |
| Settings not appearing | Settings UI only renders for **installed** plugins |

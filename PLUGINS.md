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

1. Loads your frontend script as a regular `<script>` in the main page.
2. Injects any declared stylesheets into the main page.
3. Imports your backend module and calls lifecycle hooks (`on_startup`, `on_install`, etc.).

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
  }
}
```

The `id` should be a reverse-domain string.

### `index.js`

```js
(function() {
  console.log('[Hello Plugin] Loaded in Odysseus');
  // Your plugin code runs directly in the main page.
  // Access the minimal odysseus API via window.odysseus
})();
```

### Testing locally

Place the `hello-odysseus` folder inside the Odysseus plugins directory:

```
data/plugins/hello-odysseus/
  odysseus-plugin.json
  index.js
```

Restart Odysseus. The plugin frontend will be loaded automatically.

---

## The Manifest

`odysseus-plugin.json` is the heart of every plugin. Odysseus reads it to decide what your plugin does and what to load.

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
  "styles": ["styles.css"],
  "settings": {
    "greeting": { "type": "string", "label": "Greeting", "default": "Hello" }
  },
  "permissions": ["storage"],
  "file_hashes": {
    "index.js": "sha256:abc123...",
    "plugin.py": "sha256:def456..."
  }
}
```

**Required fields:** `id`, `name`, `version`, `description`, `entrypoints`, and `file_hashes`.

**Optional fields:**

- `entrypoints.backend` — Python file with lifecycle hooks.
- `styles` — CSS files injected into the main app page.
- `settings` — Schema for a settings form.
- `permissions` — Array of required capabilities (`storage`, `network`, `dom`).

---

## Frontend Script

Your frontend script runs directly in the main Odysseus page as a regular `<script>` tag. It has full DOM access. Odysseus exposes a minimal `window.odysseus` API:

### Settings

If your manifest declares a `settings` schema, you read values like this:

```js
var greeting = window.odysseus.getSetting('io.odysseus.hello', 'greeting');
console.log(greeting); // "Hello" or whatever the user typed
```

`window.odysseus.setSetting(pluginId, key, value)` writes settings back to `localStorage`.

### Logging

```js
window.odysseus.log('info', 'Hello plugin is ready');
```

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

Because these styles apply globally, use specific selectors scoped to your plugin.

Odysseus exposes CSS variables you can use:

```css
body {
  background: var(--bg, #0d1117);
  color: var(--fg, #c9d1d9);
}
```

Common variables: `--bg`, `--fg`, `--panel`, `--border`, `--accent`, `--red`, `--input-bg`.

---

## Settings Form

The `settings` object in your manifest declares configurable values.

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

### Generating file_hashes

Before committing, run the hash generator so Odysseus can verify your plugin files against the manifest at install time:

```bash
python scripts/generate_plugin_hashes.py hello-odysseus
```

This computes SHA-256 for every file in the plugin folder and writes them into `odysseus-plugin.json` under `file_hashes`. The field is **mandatory** — manifests without it are rejected.

---

## Security

- **In-process execution:** Both frontend and backend code run in-process with Odysseus. Plugins share the same trust model as pip-installed dependencies. Only install plugins you trust.
- **Supply-chain verification:** Every plugin must declare `file_hashes` in its manifest. Odysseus verifies each file's SHA-256 against the manifest at install time and on demand. Any mismatch blocks installation.
- **Least privilege:** Only request the permissions you need. `storage` is common; `network` and `dom` should be justified.
- **CSS scoping:** Styles in `styles` are loaded globally. Avoid overly broad selectors like `* { ... }`.

---

## Troubleshooting

| Symptom | Likely Cause |
|---------|-------------|
| Styles not applying | Verify filenames in `styles` match actual files; check DevTools Network tab |
| Backend hook not called | Ensure `entrypoints.backend` filename is correct; check server logs for import errors |
| Settings not persisting | Settings are stored in `localStorage` under `plugin:{id}:settings:{key}` |

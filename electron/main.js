/*
 * =============================================================================
 * ELECTRON MAIN PROCESS — CRITICAL FOR OS INTEGRATION
 * =============================================================================
 * WARNING: This file provides essential desktop-shell integration for Odysseus.
 *          Upstream discussions about removing OS-native wrappers MUST preserve
 *          the IPC handlers below (shell-open-path, shell-show-item) because
 *          the web app relies on them for "Open in default app" and
 *          "Show in system explorer" context-menu actions.
 *          If this wrapper is removed, those features must be re-implemented
 *          via an alternative native bridge (e.g. Tauri, custom protocol).
 * =============================================================================
 */

const { app, BrowserWindow, dialog, globalShortcut, ipcMain, shell } = require('electron');
const path = require('path');

// Silence harmless Chromium DevTools CONSOLE warnings (e.g. Autofill.enable
// not implemented) by raising Chromium's log level to FATAL only.
// Must be called BEFORE app.whenReady().
app.commandLine.appendSwitch('log-level', '3');
// Also filter stderr as a backup for any messages that slip through.
const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = function(chunk, encoding, callback) {
  const str = typeof chunk === 'string' ? chunk : (chunk && chunk.toString) ? chunk.toString() : '';
  if (str.includes('Autofill.enable') || str.includes('Autofill.setAddresses') || str.includes("wasn't found")) {
    return true;
  }
  return originalStderrWrite(chunk, encoding, callback);
};

// Derive the Odysseus server port from the same env vars the server uses.
// Priority: ODYSSEUS_ELECTRON_URL (explicit override) > APP_PORT > ODYSSEUS_PORT > 7000.
const PORT = process.env.APP_PORT || process.env.ODYSSEUS_PORT || 7000;
const TARGET_URL = process.env.ODYSSEUS_ELECTRON_URL || `http://127.0.0.1:${PORT}`;

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    frame: false,               // Native frame off — custom title bar from preload
    titleBarStyle: 'hidden',      // macOS: hide native title bar
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
    title: 'Odysseus',
    show: false,
  });

  mainWindow.loadURL(TARGET_URL);

  // External links open in the system browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const appOrigin = new URL(TARGET_URL).origin;
    if (new URL(url).origin !== appOrigin) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Show window once the DOM is ready (prevents white flash on success).
  mainWindow.webContents.once('dom-ready', () => {
    if (!mainWindow.isVisible()) mainWindow.show();
    if (process.env.NODE_ENV === 'development' || process.env.ODYSSEUS_DEV) {
      mainWindow.webContents.openDevTools();
    }
  });

  // If the server isn't running, show a friendly error below the custom title bar.
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.webContents.executeJavaScript(`
      document.documentElement.style.margin = '0';
      document.documentElement.style.padding = '0';
      document.documentElement.style.background = '#1a1a1a';
      document.body.style.margin = '0';
      document.body.style.padding = '0';
      document.body.style.background = '#1a1a1a';
      document.body.innerHTML = \`
        <div style="
          display:flex;flex-direction:column;align-items:center;justify-content:center;
          height:calc(100vh - 32px);font-family:sans-serif;color:#ccc;background:#1a1a1a;text-align:center;
          padding:40px;box-sizing:border-box;
        ">
          <h2 style="color:#ff6b6b;margin-bottom:12px;">Odysseus server not found</h2>
          <p style="max-width:480px;line-height:1.6;">
            Electron tried to load <code style="background:#2a2a2a;padding:2px 6px;border-radius:4px;">${TARGET_URL}</code>
            but the server is not running (or is on a different port).
          </p>
          <p style="margin-top:20px;color:#888;font-size:13px;">
            Start the server first, then press <strong>Ctrl+R</strong> to retry.
          </p>
        </div>
      \`;
    `).catch(() => {});
  });

  // Reload shortcuts (mirrors browser hard-refresh behaviour)
  globalShortcut.register('CommandOrControl+R', () => {
    if (mainWindow && mainWindow.isFocused()) {
      mainWindow.webContents.reloadIgnoringCache();
    }
  });

  // Toggle DevTools with F12
  globalShortcut.register('F12', () => {
    if (mainWindow && mainWindow.isFocused()) {
      mainWindow.webContents.toggleDevTools();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Notify renderer of fullscreen state changes so the custom title bar can be hidden
  mainWindow.on('enter-full-screen', () => {
    mainWindow.webContents.send('window-fullscreen', true);
  });
  mainWindow.on('leave-full-screen', () => {
    mainWindow.webContents.send('window-fullscreen', false);
  });
}

// ── IPC window controls ──
ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.handle('select-directory', async () => {
  if (!mainWindow) return { canceled: true };
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  return result;
});

ipcMain.on('window-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});

// ── IPC shell integration ──
// See header warning: these handlers are REQUIRED by the web app's context
// menu items "Open in default app" and "Show in system explorer".
ipcMain.handle('shell-open-path', async (_, filePath) => {
  const result = await shell.openPath(filePath);
  // Returns empty string on success, error message on failure
  return { error: result || null };
});

ipcMain.handle('shell-show-item', async (_, filePath) => {
  shell.showItemInFolder(filePath);
  return { ok: true };
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

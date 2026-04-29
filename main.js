const { app, BrowserWindow, dialog, shell, Menu } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

// Single-instance lock: prevent a second copy from racing on port 3000.
// If lock fails, exit immediately; the running instance will receive
// a 'second-instance' event and focus itself.
if (!app.requestSingleInstanceLock()) {
    app.quit();
    process.exit(0);
}

// Set the data directory for config/logs before server loads
process.env.SMART_DATA_DIR = app.getPath('userData');

// Boot up the local backend server and get the ready promise
const { serverReady } = require('./server.js');

let splashWin = null;
let mainWin = null;

app.on('second-instance', () => {
    if (mainWin) {
        if (mainWin.isMinimized()) mainWin.restore();
        mainWin.focus();
    }
});

function createSplash() {
    // Read logo and base64 encode it for the splash HTML
    let logoBase64 = '';
    try {
        const logoBuffer = fs.readFileSync(path.join(__dirname, 'build', 'logo.png'));
        logoBase64 = logoBuffer.toString('base64');
    } catch (e) {}

    const splashHTML = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#0b1120; display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; overflow:hidden; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; -webkit-app-region:drag; }
img { width:280px; margin-bottom:32px; animation:fadeIn 0.6s ease; }
.loader { width:180px; height:3px; background:rgba(255,255,255,0.1); border-radius:3px; overflow:hidden; }
.loader-bar { width:40%; height:100%; background:linear-gradient(90deg,#3b82f6,#60a5fa,#3b82f6); border-radius:3px; animation:slide 1.4s ease-in-out infinite; }
.text { color:rgba(255,255,255,0.5); font-size:12px; margin-top:16px; letter-spacing:1px; }
@keyframes fadeIn { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
@keyframes slide { 0%{transform:translateX(-100%)} 100%{transform:translateX(350%)} }
</style></head><body>
${logoBase64 ? `<img src="data:image/png;base64,${logoBase64}" alt="KLS Digital Solutions">` : '<div style="color:white;font-size:24px;font-weight:700;margin-bottom:32px;">Smart Workspace</div>'}
<div class="loader"><div class="loader-bar"></div></div>
<div class="text">Loading workspace…</div>
</body></html>`;

    splashWin = new BrowserWindow({
        width: 480,
        height: 320,
        frame: false,
        resizable: false,
        transparent: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        center: true,
        backgroundColor: '#0b1120',
        icon: path.join(__dirname, 'build', 'icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false
        }
    });

    splashWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(splashHTML));
    splashWin.on('closed', () => { splashWin = null; });
}

function createWindow() {
    // Read fullscreen-on-start preference synchronously before creating the window.
    let fullscreenOnStart = false;
    try {
        const cfgPath = path.join(app.getPath('userData'), 'config.json');
        if (fs.existsSync(cfgPath)) {
            const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
            fullscreenOnStart = !!(cfg && cfg.settings && cfg.settings.fullscreenOnStart);
        }
    } catch (e) {}

    const win = new BrowserWindow({
        width: 1100,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        autoHideMenuBar: true,
        title: "Smart Workspace",
        show: false,
        fullscreen: fullscreenOnStart,
        icon: path.join(__dirname, 'build', 'icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false
        }
    });
    mainWin = win;
    win.on('closed', () => { mainWin = null; });

    // Route any external link (target="_blank", window.open, middle-click)
    // to the user's default browser instead of opening a new app window.
    win.webContents.setWindowOpenHandler(({ url }) => {
        const kids = global.smartKidsState && global.smartKidsState.enabled;
        // In Kids Mode, deny popups silently — never spawn extra windows or hand off to the OS browser.
        if (kids) return { action: 'deny' };
        // Never relay our own app URL back out to the system browser.
        if (url && /^https?:\/\//i.test(url) && !/^https?:\/\/127\.0\.0\.1:3000/i.test(url)) {
            shell.openExternal(url);
        }
        return { action: 'deny' };
    });

    // Catch in-page navigations to external URLs as a safety net.
    win.webContents.on('will-navigate', (event, url) => {
        const kids = global.smartKidsState && global.smartKidsState.enabled;
        if (kids) {
            // Always allow our own app shell.
            if (url.startsWith('http://127.0.0.1:3000')) return;
            // Allow only if URL hostname is in the parent-approved allowlist.
            try {
                const host = new URL(url).hostname.toLowerCase();
                const allowed = global.smartKidsState.hosts;
                if (allowed && (allowed.has(host) || [...allowed].some(h => host === h || host.endsWith('.' + h)))) return;
            } catch {}
            event.preventDefault();
            // Send them to the in-app blocked page (served by the renderer).
            try { win.loadURL('http://127.0.0.1:3000/?kids=1&blocked=1&u=' + encodeURIComponent(url)); } catch {}
            return;
        }
        if (!url.startsWith('http://127.0.0.1:3000')) {
            event.preventDefault();
            if (/^https?:\/\//i.test(url)) shell.openExternal(url);
        }
    });

    // Block downloads while Kids Mode is on. Also suppress right-click and devtools shortcuts.
    try {
        win.webContents.session.on('will-download', (event) => {
            if (global.smartKidsState && global.smartKidsState.enabled) event.preventDefault();
        });
    } catch {}
    win.webContents.on('context-menu', (event) => {
        if (global.smartKidsState && global.smartKidsState.enabled) event.preventDefault();
    });
    win.webContents.on('before-input-event', (event, input) => {
        if (!(global.smartKidsState && global.smartKidsState.enabled)) return;
        const k = (input.key || '').toLowerCase();
        // Block devtools, view-source, and printing-style shortcuts that could expose chrome.
        if (k === 'f12') return event.preventDefault();
        if (input.control && input.shift && (k === 'i' || k === 'j' || k === 'c')) return event.preventDefault();
        if (input.control && (k === 'u' || k === 's' || k === 'p')) return event.preventDefault();
    });

    // When Kids Mode is on, inject a floating "🏠 Home" button onto every external
    // page so the child always has a visible way back to the dashboard — even in
    // fullscreen where the menu bar is hidden. The button is a plain anchor to the
    // app's own URL, which the will-navigate guard already allows.
    function injectKidsHomeButton() {
        try {
            if (!(global.smartKidsState && global.smartKidsState.enabled)) return;
            const cur = win.webContents.getURL() || '';
            if (cur.startsWith('http://127.0.0.1:3000')) return; // dashboard already has its own UI
            const js = "(function(){try{var existing=document.getElementById('__kidsHomeBtn');if(existing)existing.remove();var b=document.createElement('a');b.id='__kidsHomeBtn';b.href='http://127.0.0.1:3000/?kids=1';b.textContent='\u{1F3E0} Home';b.setAttribute('style','position:fixed!important;top:12px!important;left:12px!important;z-index:2147483647!important;background:#2563eb!important;color:#fff!important;font:600 14px system-ui,Segoe UI,sans-serif!important;padding:10px 16px!important;border-radius:24px!important;box-shadow:0 4px 14px rgba(0,0,0,.35)!important;text-decoration:none!important;border:2px solid #fff!important;cursor:pointer!important;');(document.body||document.documentElement).appendChild(b);}catch(e){}})();";
            win.webContents.executeJavaScript(js).catch(() => {});
        } catch {}
    }
    win.webContents.on('did-finish-load', injectKidsHomeButton);
    win.webContents.on('did-frame-finish-load', (_e, isMainFrame) => { if (isMainFrame) injectKidsHomeButton(); });

    // Wait for the server to be listening before loading the UI.
    // If the server fails to start, surface a dialog and exit cleanly
    // instead of leaving the splash hanging.
    serverReady.then(() => {
        win.loadURL('http://127.0.0.1:3000');
    }).catch((err) => {
        if (splashWin) { try { splashWin.close(); } catch (_) {} splashWin = null; }
        dialog.showErrorBox(
            'Smart Workspace failed to start',
            'The local server could not start.\n\n' + (err && err.message ? err.message : String(err))
        );
        app.quit();
    });

    win.once('ready-to-show', () => {
        win.show();
        if (splashWin) {
            splashWin.close();
            splashWin = null;
        }
    });
}

// When Electron is ready, open the window
app.whenReady().then(() => {
    // Deny all renderer permission requests by default (camera, mic, geo, notifications, etc.).
    try {
        const { session } = require('electron');
        session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
            callback(false);
        });
    } catch (e) {}

    createSplash();
    createWindow();

    // Kids Mode menu wiring. server.js publishes state and calls global.smartKidsApply()
    // whenever the toggle, PIN, or allowlist changes. We rebuild the application menu
    // so a child can always click "🏠 Home" to return to the dashboard.
    function applyKidsMode() {
        const kids = global.smartKidsState && global.smartKidsState.enabled;
        if (kids) {
            const template = [
                {
                    label: '🏠 Home',
                    accelerator: 'F1',
                    click: () => {
                        if (mainWin) {
                            try { mainWin.loadURL('http://127.0.0.1:3000/?kids=1'); } catch {}
                        }
                    }
                },
                {
                    label: 'Back',
                    accelerator: 'Alt+Left',
                    click: () => { try { mainWin && mainWin.webContents.goBack(); } catch {} }
                },
                {
                    label: 'Forward',
                    accelerator: 'Alt+Right',
                    click: () => { try { mainWin && mainWin.webContents.goForward(); } catch {} }
                }
            ];
            try { Menu.setApplicationMenu(Menu.buildFromTemplate(template)); } catch {}
            if (mainWin) try { mainWin.setMenuBarVisibility(true); mainWin.setAutoHideMenuBar(false); } catch {}
        } else {
            try { Menu.setApplicationMenu(null); } catch {}
            if (mainWin) try { mainWin.setMenuBarVisibility(false); mainWin.setAutoHideMenuBar(true); } catch {}
        }
    }
    global.smartKidsApply = applyKidsMode;
    // Apply once now in case the server already published initial state.
    applyKidsMode();

    // Shared state with server for update status UI
    global.smartUpdateState = {
        status: 'idle',
        version: null,
        checkedAt: null,
        error: null
    };
    global.smartQuitAndInstall = () => {
        try { autoUpdater.quitAndInstall(false, true); } catch (e) {}
    };

    // Skip auto-updater entirely in dev (electron .) — it logs misleading
    // errors and writes a useless updater.log when there's no installer context.
    if (!app.isPackaged) {
        global.smartUpdateState.status = 'dev';
        return;
    }

    // Persistent updater log — separate file so it's easy to inspect
    const updaterLogPath = path.join(app.getPath('userData'), 'updater.log');
    function writeUpdaterLog(message) {
        const line = `[${new Date().toISOString()}] ${message}\n`;
        try { fs.appendFileSync(updaterLogPath, line); } catch (e) {}
        console.log(`[updater] ${message}`);
    }
    function formatUpdaterError(err) {
        if (!err) return 'unknown error';
        const code = err.code || err.statusCode || '';
        const stack = (err.stack || '').split('\n').slice(1).find(l => l.trim()) || '';
        return [err.message, code ? `code=${code}` : '', stack].filter(Boolean).join(' | ');
    }

    // Silent auto-update: download in background, install on quit
    // disableDifferentialDownload forces a full installer fetch, bypassing
    // blockmap/range-request failures which are the most common Windows NSIS failure mode
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.disableDifferentialDownload = true;

    autoUpdater.on('checking-for-update', () => {
        global.smartUpdateState.status = 'checking';
        global.smartUpdateState.checkedAt = new Date().toISOString();
        global.smartUpdateState.error = null;
        writeUpdaterLog('Checking for updates');
    });
    autoUpdater.on('update-available', (info) => {
        global.smartUpdateState.status = 'downloading';
        global.smartUpdateState.version = info.version;
        global.smartUpdateState.error = null;
        writeUpdaterLog(`Update available: v${info.version} — downloading`);
    });
    autoUpdater.on('download-progress', (p) => {
        writeUpdaterLog(`Download progress: ${p.percent.toFixed(1)}% (${p.transferred}/${p.total} bytes, ${p.bytesPerSecond} B/s)`);
    });
    autoUpdater.on('update-not-available', () => {
        global.smartUpdateState.status = 'up-to-date';
        global.smartUpdateState.checkedAt = new Date().toISOString();
        global.smartUpdateState.error = null;
        writeUpdaterLog('No update available — already on latest');
    });
    autoUpdater.on('update-downloaded', (info) => {
        global.smartUpdateState.status = 'downloaded';
        global.smartUpdateState.version = info.version;
        global.smartUpdateState.error = null;
        writeUpdaterLog(`Update downloaded: v${info.version} — will install on quit`);
    });
    autoUpdater.on('error', (err) => {
        const detail = formatUpdaterError(err);
        global.smartUpdateState.status = 'error';
        global.smartUpdateState.error = err.message || detail;
        writeUpdaterLog(`ERROR: ${detail}`);
    });

    function checkForUpdates() {
        autoUpdater.checkForUpdates().catch((err) => {
            const detail = formatUpdaterError(err);
            global.smartUpdateState.status = 'error';
            global.smartUpdateState.error = err.message || detail;
            writeUpdaterLog(`checkForUpdates rejected: ${detail}`);
        });
    }

    // Expose so renderer can trigger a manual check via /api/check-for-updates.
    global.smartCheckForUpdates = checkForUpdates;

    checkForUpdates();

    // Check again every 4 hours
    setInterval(checkForUpdates, 4 * 60 * 60 * 1000);
});

// When the user closes the app window, quit the application entirely
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
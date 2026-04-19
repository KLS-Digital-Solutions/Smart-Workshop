const { app, BrowserWindow } = require('electron');
const path = require('path');

// Set the data directory for config/logs before server loads
process.env.SMART_DATA_DIR = app.getPath('userData');

// Boot up the local backend server and get the ready promise
const { serverReady } = require('./server.js');

function createWindow() {
    const win = new BrowserWindow({
        width: 1100,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        autoHideMenuBar: true,
        title: "Smart Workspace",
        icon: path.join(__dirname, 'build', 'icon.png'),
        webPreferences: {
            nodeIntegration: false
        }
    });

    // Wait for the server to be listening before loading the UI
    serverReady.then(() => {
        win.loadURL('http://127.0.0.1:3000');
    });
}

// When Electron is ready, open the window
app.whenReady().then(createWindow);

// When the user closes the app window, quit the application entirely
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
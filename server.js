const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, execFile } = require('child_process');

const PORT = 3000;
const MAX_BODY_BYTES = 1024 * 1024; // 1MB body limit

// Data directory: installed mode uses SMART_DATA_DIR (AppData), portable fallback, then cwd
const dataDir = process.env.SMART_DATA_DIR || process.env.PORTABLE_EXECUTABLE_DIR || process.cwd();
fs.mkdirSync(dataDir, { recursive: true });
const CONFIG_PATH = path.join(dataDir, 'config.json');

// --- App Version ---
let appVersion = '1.0.0';
let storeUrl = '';
try {
    const pkg = require('./package.json');
    appVersion = pkg.version;
    storeUrl = pkg.storeUrl || '';
} catch (e) {
    appVersion = 'Unknown';
}

// --- CPU Sampling ---
let cpuPercent = 0;
function sampleCpu() {
    const cpus = os.cpus();
    const totals = cpus.reduce((acc, cpu) => {
        const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
        return { idle: acc.idle + cpu.times.idle, total: acc.total + total };
    }, { idle: 0, total: 0 });
    if (sampleCpu._prev) {
        const idleDiff = totals.idle - sampleCpu._prev.idle;
        const totalDiff = totals.total - sampleCpu._prev.total;
        cpuPercent = totalDiff > 0 ? Math.round(100 - (idleDiff / totalDiff) * 100) : 0;
    }
    sampleCpu._prev = totals;
}
sampleCpu();
setInterval(sampleCpu, 2000);

// --- Logging ---
const LOG_PATH = path.join(dataDir, 'smart-workspace.log');
const MAX_LOG_BYTES = 512 * 1024;

function log(level, message) {
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}\n`;
    try {
        try {
            const stat = fs.statSync(LOG_PATH);
            if (stat.size > MAX_LOG_BYTES) {
                const content = fs.readFileSync(LOG_PATH, 'utf8');
                const half = content.substring(content.length / 2);
                const nl = half.indexOf('\n');
                fs.writeFileSync(LOG_PATH, nl > -1 ? half.substring(nl + 1) : half);
            }
        } catch {}
        fs.appendFileSync(LOG_PATH, line);
    } catch {}
}

// --- Licensing (Lemon Squeezy) ---
const LICENSE_PATH = path.join(dataDir, 'license.json');
const TRIAL_DAYS = 14;
const OFFLINE_GRACE_DAYS = 7;

function loadLicense() {
    try {
        return JSON.parse(fs.readFileSync(LICENSE_PATH, 'utf8'));
    } catch {
        const lic = {
            trial_start: new Date().toISOString(),
            license_key: null,
            instance_id: null,
            status: 'trial',
            last_validated: null
        };
        fs.writeFileSync(LICENSE_PATH, JSON.stringify(lic, null, 2));
        return lic;
    }
}

function saveLicense(lic) {
    fs.writeFileSync(LICENSE_PATH, JSON.stringify(lic, null, 2));
}

function getInstanceName() {
    try { return `${os.hostname()}-${os.userInfo().username}`; }
    catch { return os.hostname(); }
}

function maskKey(key) {
    if (!key || key.length < 8) return '****';
    return key.substring(0, 4) + '····' + key.substring(key.length - 4);
}

function lemonPost(endpoint, params) {
    return new Promise((resolve, reject) => {
        const body = new URLSearchParams(params).toString();
        const req = https.request({
            hostname: 'api.lemonsqueezy.com',
            path: `/v1/licenses/${endpoint}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch { reject(new Error('Invalid API response')); }
            });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.write(body);
        req.end();
    });
}

async function validateLicenseOnline(lic) {
    if (!lic.license_key || !lic.instance_id) return false;
    try {
        const result = await lemonPost('validate', {
            license_key: lic.license_key,
            instance_id: lic.instance_id
        });
        if (result.valid) {
            lic.last_validated = new Date().toISOString();
            lic.status = 'active';
            saveLicense(lic);
            return true;
        }
        lic.status = 'expired';
        lic.license_key = null;
        lic.instance_id = null;
        saveLicense(lic);
        return false;
    } catch {
        if (lic.last_validated) {
            const daysSince = (Date.now() - new Date(lic.last_validated).getTime()) / 86400000;
            if (daysSince <= OFFLINE_GRACE_DAYS) return true;
        }
        return false;
    }
}

// --- Helpers ---

function parseBody(req, maxBytes = MAX_BODY_BYTES) {
    return new Promise((resolve, reject) => {
        let body = '';
        let bytes = 0;
        req.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > maxBytes) {
                req.destroy();
                return reject({ status: 413, message: 'Request body too large' });
            }
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(body));
            } catch {
                reject({ status: 400, message: 'Invalid JSON' });
            }
        });
        req.on('error', () => reject({ status: 500, message: 'Request error' }));
    });
}

function sendJSON(res, data, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function sendError(res, status, message) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
}

function isValidUrl(urlString) {
    try {
        const url = new URL(urlString);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

// --- System Scanning ---

// Parse Windows .lnk shortcut files to extract target path (pure Node.js, no COM)
function parseLnkTarget(lnkPath) {
    try {
        const buf = fs.readFileSync(lnkPath);
        // Validate .lnk magic header: 4C 00 00 00
        if (buf.length < 76 || buf.readUInt32LE(0) !== 0x0000004C) return null;

        const flags = buf.readUInt32LE(20);
        const hasLinkTargetIDList = (flags & 0x01) !== 0;
        const hasLinkInfo = (flags & 0x02) !== 0;

        let offset = 76; // end of ShellLinkHeader

        // Skip LinkTargetIDList if present
        if (hasLinkTargetIDList) {
            if (offset + 2 > buf.length) return null;
            const idListSize = buf.readUInt16LE(offset);
            offset += 2 + idListSize;
        }

        // Read LinkInfo to get LocalBasePath
        if (hasLinkInfo) {
            if (offset + 4 > buf.length) return null;
            const linkInfoSize = buf.readUInt32LE(offset);
            if (linkInfoSize < 28 || offset + linkInfoSize > buf.length) return null;

            const linkInfoStart = offset;
            const linkInfoFlags = buf.readUInt32LE(offset + 8);
            const volumeIDAndLocalBasePath = (linkInfoFlags & 0x01) !== 0;

            if (volumeIDAndLocalBasePath) {
                const localBasePathOffset = buf.readUInt32LE(offset + 16);
                const pathStart = linkInfoStart + localBasePathOffset;
                if (pathStart < buf.length) {
                    const nullEnd = buf.indexOf(0, pathStart);
                    const targetPath = buf.toString('ascii', pathStart, nullEnd > pathStart ? nullEnd : buf.length);
                    if (targetPath && targetPath.length > 3) return targetPath;
                }
            }
        }
        return null;
    } catch {
        return null;
    }
}

// Recursively collect .lnk files from a directory
function getShortcuts(dir) {
    const results = [];
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            try {
                if (entry.isDirectory()) {
                    results.push(...getShortcuts(fullPath));
                } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.lnk')) {
                    results.push(fullPath);
                }
            } catch {}
        }
    } catch {}
    return results;
}

// Scan Windows Registry App Paths for registered applications
function scanRegistry() {
    return new Promise((resolve) => {
        execFile('reg', [
            'query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths', '/s'
        ], { maxBuffer: 1024 * 1024 * 5, timeout: 10000 }, (error, stdout) => {
            if (error) return resolve([]);
            const apps = [];
            const lines = stdout.split('\r\n');
            let currentName = null;

            for (const line of lines) {
                // Registry key line contains the .exe name
                const keyMatch = line.match(/\\App Paths\\(.+\.exe)$/i);
                if (keyMatch) {
                    currentName = keyMatch[1].replace(/\.exe$/i, '');
                    continue;
                }
                // Default value line contains the full path
                if (currentName && line.includes('(Default)') && line.includes('REG_SZ')) {
                    const parts = line.split('REG_SZ').pop().trim();
                    if (parts && parts.toLowerCase().endsWith('.exe')) {
                        const cleanPath = parts.replace(/^"|"$/g, '');
                        if (fs.existsSync(cleanPath)) {
                            apps.push({ name: currentName, path: cleanPath });
                        }
                    }
                    currentName = null;
                }
            }
            resolve(apps);
        });
    });
}

async function scanSystemApps() {
    if (process.platform !== 'win32') return [];

    try {
        // Source 1: Start Menu & Desktop shortcuts (parsed with Node.js)
        const shortcutDirs = [
            path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Microsoft\\Windows\\Start Menu\\Programs'),
            path.join(process.env.APPDATA || '', 'Microsoft\\Windows\\Start Menu\\Programs'),
            path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop'),
            path.join(os.homedir(), 'Desktop')
        ];

        const lnkApps = [];
        for (const dir of shortcutDirs) {
            const shortcuts = getShortcuts(dir);
            for (const lnk of shortcuts) {
                const target = parseLnkTarget(lnk);
                if (target && target.toLowerCase().endsWith('.exe') && fs.existsSync(target)) {
                    const name = path.basename(lnk, '.lnk');
                    lnkApps.push({ name, path: target });
                }
            }
        }

        // Source 2: Registry App Paths
        const regApps = await scanRegistry();

        // Merge and deduplicate
        const seen = new Set();
        const merged = [];
        for (const app of [...lnkApps, ...regApps]) {
            const key = app.path.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                merged.push(app);
            }
        }
        merged.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

        log('info', `System scan: found ${merged.length} apps (${lnkApps.length} from shortcuts, ${regApps.length} from registry)`);

        if (merged.length > 0) return merged;

        // Fallback: PowerShell with fixed COM handling
        log('info', 'Node.js scan found 0 apps, trying PowerShell fallback');
        return await scanSystemAppsPowerShell();
    } catch (err) {
        log('error', `System scan error: ${err.message}`);
        return [];
    }
}

// PowerShell fallback — COM object created once, forced array output
function scanSystemAppsPowerShell() {
    return new Promise((resolve) => {
        const psScript = `
            $ErrorActionPreference = 'SilentlyContinue';
            $paths = @(
                [Environment]::GetFolderPath('CommonPrograms'),
                [Environment]::GetFolderPath('Programs'),
                [Environment]::GetFolderPath('CommonDesktopDirectory'),
                [Environment]::GetFolderPath('DesktopDirectory')
            );
            $sh = New-Object -ComObject WScript.Shell;
            $apps = [System.Collections.ArrayList]::new();
            foreach ($p in $paths) {
                if ($p -and (Test-Path $p)) {
                    Get-ChildItem -Path $p -Recurse -Filter "*.lnk" -ErrorAction SilentlyContinue | ForEach-Object {
                        try {
                            $target = $sh.CreateShortcut($_.FullName).TargetPath;
                            if ($target -and $target -match '\\.exe$') {
                                $null = $apps.Add([PSCustomObject]@{ name = [System.IO.Path]::GetFileNameWithoutExtension($_.Name); path = $target });
                            }
                        } catch {}
                    }
                }
            }
            [System.Runtime.InteropServices.Marshal]::ReleaseComObject($sh) | Out-Null;
            $unique = $apps | Sort-Object name -Unique;
            ConvertTo-Json @($unique) -Compress;
        `;

        const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
        execFile('powershell', [
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded
        ], { maxBuffer: 1024 * 1024 * 10, timeout: 30000 }, (error, stdout, stderr) => {
            if (error) {
                log('error', `PowerShell fallback failed: ${error.message}`);
                return resolve([]);
            }
            try {
                const trimmed = stdout.trim();
                if (!trimmed || trimmed === 'null') return resolve([]);
                const parsed = JSON.parse(trimmed);
                const result = Array.isArray(parsed) ? parsed : [parsed];
                log('info', `PowerShell fallback found ${result.length} apps`);
                resolve(result);
            } catch (e) {
                log('error', `PowerShell parse error: ${e.message}`);
                resolve([]);
            }
        });
    });
}

// Icon extraction — path passed via env variable to prevent PowerShell injection
function extractIcon(exePath) {
    return new Promise((resolve) => {
        if (process.platform !== 'win32') return resolve(null);

        const cleaned = exePath.replace(/"/g, '');
        if (!cleaned.toLowerCase().endsWith('.exe')) return resolve(null);

        const psScript = `
            Add-Type -AssemblyName System.Drawing;
            try {
                $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($env:SMART_ICON_PATH);
                if ($icon -ne $null) {
                    $bitmap = $icon.ToBitmap();
                    $stream = New-Object System.IO.MemoryStream;
                    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png);
                    Write-Output ([Convert]::ToBase64String($stream.ToArray()));
                } else { Write-Output "ERROR"; }
            } catch { Write-Output "ERROR"; }
        `;

        const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
        execFile('powershell', [
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded
        ], {
            env: { ...process.env, SMART_ICON_PATH: cleaned }
        }, (error, stdout) => {
            if (error || stdout.trim() === 'ERROR' || !stdout.trim()) resolve(null);
            else resolve(`data:image/png;base64,${stdout.trim()}`);
        });
    });
}

function checkAppExists(command) {
    return new Promise((resolve) => {
        const cleaned = command.replace(/"/g, '');
        if (fs.existsSync(cleaned)) return resolve(true);
        execFile(
            process.platform === 'win32' ? 'where' : 'which',
            [cleaned],
            (error) => resolve(!error)
        );
    });
}

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
    }
    return 'Offline';
}

// --- Safe Launchers ---

function launchApplication(appPath, args) {
    return new Promise((resolve) => {
        const cleaned = appPath.replace(/"/g, '');
        if (!cleaned) return resolve(false);

        if (process.platform === 'win32') {
            const argStr = args ? ` ${args.replace(/"/g, '')}` : '';
            exec(`start "" "${cleaned}"${argStr}`, (error) => {
                log(error ? 'error' : 'info', `Launch app: ${cleaned}${argStr} — ${error ? 'FAIL' : 'OK'}`);
                resolve(!error);
            });
        } else {
            const argList = args ? args.split(/\s+/) : [];
            execFile(cleaned, argList, (error) => {
                log(error ? 'error' : 'info', `Launch app: ${cleaned} — ${error ? 'FAIL' : 'OK'}`);
                resolve(!error);
            });
        }
    });
}

function launchUrl(url) {
    return new Promise((resolve) => {
        if (!isValidUrl(url)) return resolve(false);
        const safeUrl = url.replace(/"/g, '');
        if (process.platform === 'win32') {
            exec(`start "" "${safeUrl}"`, (error) => {
                log(error ? 'error' : 'info', `Launch URL: ${safeUrl} — ${error ? 'FAIL' : 'OK'}`);
                resolve(!error);
            });
        } else {
            execFile('open', [safeUrl], (error) => {
                log(error ? 'error' : 'info', `Launch URL: ${safeUrl} — ${error ? 'FAIL' : 'OK'}`);
                resolve(!error);
            });
        }
    });
}

// --- Startup Setting ---

async function applyStartupSetting(enable) {
    if (process.platform !== 'win32') return;

    const startupFolder = path.join(
        os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows',
        'Start Menu', 'Programs', 'Startup'
    );
    const shortcutPath = path.join(startupFolder, 'SmartWorkspace.lnk');

    if (enable) {
        const psScript = `$s=(New-Object -COM WScript.Shell).CreateShortcut($env:SMART_SHORTCUT);$s.TargetPath=$env:SMART_TARGET;$s.Save()`;
        const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
        execFile('powershell', [
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded
        ], {
            env: { ...process.env, SMART_SHORTCUT: shortcutPath, SMART_TARGET: process.execPath }
        });
    } else {
        if (fs.existsSync(shortcutPath)) fs.unlinkSync(shortcutPath);
    }
}

// --- Config Management ---

const DEFAULT_CONFIG = { localApps: [], webLinks: [], workflows: [], categories: ['General'], settings: { startup: false } };

function validateConfig(config) {
    if (!config || typeof config !== 'object') return { ...DEFAULT_CONFIG };
    if (!Array.isArray(config.localApps)) config.localApps = [];
    if (!Array.isArray(config.webLinks)) config.webLinks = [];
    if (!Array.isArray(config.workflows)) config.workflows = [];
    if (!Array.isArray(config.categories) || config.categories.length === 0) config.categories = ['General'];
    if (!config.settings || typeof config.settings !== 'object') config.settings = { startup: false };
    return config;
}

async function loadConfig() {
    try {
        const data = await fs.promises.readFile(CONFIG_PATH, 'utf8');
        return validateConfig(JSON.parse(data));
    } catch {
        const config = { ...DEFAULT_CONFIG };
        await fs.promises.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
        return config;
    }
}

async function saveConfig(config) {
    config = validateConfig(config);
    await fs.promises.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// --- Route Handlers ---

async function handleServeHTML(req, res) {
    const htmlPath = path.join(__dirname, 'index.html');
    fs.readFile(htmlPath, (err, content) => {
        if (err) return sendError(res, 500, 'Error loading interface');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(content);
    });
}

async function handleGetConfig(req, res) {
    const config = await loadConfig();
    const availableApps = [];
    for (const app of config.localApps) {
        if (await checkAppExists(app.command)) availableApps.push(app);
    }
    sendJSON(res, {
        hostname: os.hostname(),
        version: appVersion,
        localApps: availableApps,
        webLinks: config.webLinks,
        workflows: config.workflows,
        categories: config.categories
    });
}

async function handleGetSettings(req, res) {
    const config = await loadConfig();
    sendJSON(res, config.settings);
}

async function handlePostSettings(req, res) {
    const body = await parseBody(req);
    const config = await loadConfig();
    config.settings = { ...config.settings, ...body };
    if (body.startup !== undefined) await applyStartupSetting(!!body.startup);
    await saveConfig(config);
    sendJSON(res, { success: true });
}

async function handleGetStats(req, res) {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPercent = Math.round((usedMem / totalMem) * 100);
    sendJSON(res, {
        ip: getLocalIP(),
        ram: `${memPercent}% Used (${Math.round(usedMem / 1073741824)}GB / ${Math.round(totalMem / 1073741824)}GB)`,
        cpu: `${cpuPercent}%`
    });
}

async function handleGetSystemApps(req, res) {
    sendJSON(res, await scanSystemApps());
}

async function handleExtractIcon(req, res) {
    const body = await parseBody(req);
    if (!body.path || typeof body.path !== 'string') {
        return sendError(res, 400, 'Invalid path');
    }
    sendJSON(res, { icon: await extractIcon(body.path) });
}

async function handleAdd(req, res) {
    const item = await parseBody(req);
    if (!['app', 'link', 'workflow'].includes(item.type)) {
        return sendError(res, 400, 'Invalid item type');
    }
    const config = await loadConfig();
    item.id = Date.now().toString();
    if (item.type === 'app') config.localApps.push(item);
    else if (item.type === 'link') config.webLinks.push(item);
    else config.workflows.push(item);
    await saveConfig(config);
    sendJSON(res, { success: true });
}

async function handleEdit(req, res) {
    const item = await parseBody(req);
    const config = await loadConfig();
    const list = item.type === 'app' ? config.localApps
        : item.type === 'link' ? config.webLinks
        : item.type === 'workflow' ? config.workflows
        : null;
    if (!list) return sendError(res, 400, 'Invalid item type');
    const index = list.findIndex(i => i.id === item.id);
    if (index !== -1) {
        list[index] = { ...list[index], ...item };
        await saveConfig(config);
    }
    sendJSON(res, { success: true });
}

async function handleReorder(req, res) {
    const { type, order } = await parseBody(req);
    const config = await loadConfig();
    const list = type === 'app' ? config.localApps
        : type === 'link' ? config.webLinks
        : type === 'workflow' ? config.workflows
        : null;
    if (list && Array.isArray(order)) {
        list.sort((a, b) => {
            const idxA = order.indexOf(a.id);
            const idxB = order.indexOf(b.id);
            if (idxA === -1) return 1;
            if (idxB === -1) return -1;
            return idxA - idxB;
        });
        await saveConfig(config);
    }
    sendJSON(res, { success: true });
}

async function handleDelete(req, res) {
    const id = req.url.split('/api/delete/')[1];
    if (!id || !/^\d+$/.test(id)) {
        return sendError(res, 400, 'Invalid item ID');
    }
    const config = await loadConfig();
    config.localApps = config.localApps.filter(a => a.id !== id);
    config.webLinks = config.webLinks.filter(l => l.id !== id);
    config.workflows = config.workflows.filter(w => w.id !== id);
    await saveConfig(config);
    sendJSON(res, { success: true });
}

async function handleLaunch(req, res) {
    const body = await parseBody(req);
    if (!body.command || typeof body.command !== 'string') {
        return sendError(res, 400, 'Invalid command');
    }
    const success = await launchApplication(body.command, body.args);
    sendJSON(res, { success });
}

async function handleLaunchWorkflow(req, res) {
    const body = await parseBody(req);
    if (!body.id || typeof body.id !== 'string') {
        return sendError(res, 400, 'Invalid workflow ID');
    }
    const config = await loadConfig();
    const workflow = config.workflows.find(w => w.id === body.id);
    if (!workflow) return sendError(res, 404, 'Workflow not found');

    const results = await Promise.all(workflow.items.map(itemId => {
        const app = config.localApps.find(a => a.id === itemId);
        const link = config.webLinks.find(l => l.id === itemId);
        if (app) return launchApplication(app.command, app.args);
        if (link) return launchUrl(link.url);
        return Promise.resolve(false);
    }));
    sendJSON(res, { success: results.some(r => r) });
}

async function handleCategories(req, res) {
    const body = await parseBody(req);
    if (!Array.isArray(body.categories) || body.categories.length === 0) {
        return sendError(res, 400, 'Categories must be a non-empty array');
    }
    const config = await loadConfig();
    config.categories = body.categories.map(c => String(c).trim()).filter(Boolean);
    if (config.categories.length === 0) config.categories = ['General'];
    await saveConfig(config);
    sendJSON(res, { success: true });
}

async function handleExport(req, res) {
    const config = await loadConfig();
    log('info', 'Config exported');
    sendJSON(res, config);
}

async function handleImport(req, res) {
    const body = await parseBody(req);
    const config = validateConfig(body);
    await saveConfig(config);
    log('info', 'Config imported');
    sendJSON(res, { success: true });
}

async function handleGetLogs(req, res) {
    try {
        const content = await fs.promises.readFile(LOG_PATH, 'utf8');
        const lines = content.trim().split('\n');
        sendJSON(res, { lines: lines.slice(-100) });
    } catch {
        sendJSON(res, { lines: [] });
    }
}

async function handleGetLicense(req, res) {
    const lic = loadLicense();
    if (lic.license_key && lic.instance_id) {
        const valid = await validateLicenseOnline(lic);
        if (valid) {
            return sendJSON(res, {
                status: 'active',
                license_key: maskKey(lic.license_key),
                store_url: storeUrl
            });
        }
    }
    const daysUsed = Math.floor((Date.now() - new Date(lic.trial_start).getTime()) / 86400000);
    const daysRemaining = Math.max(0, TRIAL_DAYS - daysUsed);
    if (daysRemaining > 0) {
        sendJSON(res, { status: 'trial', days_remaining: daysRemaining, store_url: storeUrl });
    } else {
        sendJSON(res, { status: 'expired', store_url: storeUrl });
    }
}

async function handleActivateLicense(req, res) {
    const body = await parseBody(req);
    if (!body.license_key || typeof body.license_key !== 'string') {
        return sendError(res, 400, 'License key is required');
    }
    try {
        const result = await lemonPost('activate', {
            license_key: body.license_key.trim(),
            instance_name: getInstanceName()
        });
        if (result.activated) {
            const lic = loadLicense();
            lic.license_key = body.license_key.trim();
            lic.instance_id = result.instance.id;
            lic.status = 'active';
            lic.last_validated = new Date().toISOString();
            saveLicense(lic);
            log('info', 'License activated');
            return sendJSON(res, { success: true });
        }
        sendJSON(res, { success: false, error: result.error || 'Activation failed' });
    } catch (err) {
        log('error', `License activation error: ${err.message}`);
        sendError(res, 500, 'Could not reach license server. Check your internet connection.');
    }
}

async function handleDeactivateLicense(req, res) {
    const lic = loadLicense();
    if (!lic.license_key || !lic.instance_id) {
        return sendError(res, 400, 'No active license');
    }
    try {
        await lemonPost('deactivate', {
            license_key: lic.license_key,
            instance_id: lic.instance_id
        });
    } catch {}
    lic.license_key = null;
    lic.instance_id = null;
    lic.status = 'trial';
    lic.last_validated = null;
    saveLicense(lic);
    log('info', 'License deactivated');
    sendJSON(res, { success: true });
}

// --- Route Table ---

const routes = {
    'GET /': handleServeHTML,
    'GET /index.html': handleServeHTML,
    'GET /api/config': handleGetConfig,
    'GET /api/settings': handleGetSettings,
    'POST /api/settings': handlePostSettings,
    'GET /api/stats': handleGetStats,
    'GET /api/system-apps': handleGetSystemApps,
    'POST /api/extract-icon': handleExtractIcon,
    'POST /api/add': handleAdd,
    'POST /api/edit': handleEdit,
    'POST /api/reorder': handleReorder,
    'POST /api/launch': handleLaunch,
    'POST /api/launch-workflow': handleLaunchWorkflow,
    'POST /api/categories': handleCategories,
    'GET /api/export': handleExport,
    'POST /api/import': handleImport,
    'GET /api/logs': handleGetLogs,
    'GET /api/license': handleGetLicense,
    'POST /api/license/activate': handleActivateLicense,
    'POST /api/license/deactivate': handleDeactivateLicense,
};

const server = http.createServer(async (req, res) => {
    const routeKey = `${req.method} ${req.url}`;

    if (routes[routeKey]) {
        try {
            await routes[routeKey](req, res);
        } catch (err) {
            if (err.status) sendError(res, err.status, err.message);
            else {
                log('error', `Route ${routeKey}: ${err.message}`);
                sendError(res, 500, 'Internal server error');
            }
        }
        return;
    }

    // Dynamic route: DELETE /api/delete/:id
    if (req.method === 'DELETE' && req.url.startsWith('/api/delete/')) {
        try {
            await handleDelete(req, res);
        } catch (err) {
            if (err.status) sendError(res, err.status, err.message);
            else {
                log('error', `DELETE: ${err.message}`);
                sendError(res, 500, 'Internal server error');
            }
        }
        return;
    }

    sendError(res, 404, 'Not found');
});

// Export ready promise so main.js can wait for the server
const serverReady = new Promise((resolve) => {
    server.listen(PORT, '127.0.0.1', () => {
        console.log(`Smart Workspace server running on http://127.0.0.1:${PORT}`);
        log('info', `Server started on http://127.0.0.1:${PORT}`);
        resolve();
    });
});

module.exports = { serverReady };
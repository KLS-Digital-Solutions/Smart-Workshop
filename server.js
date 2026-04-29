const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec, execFile } = require('child_process');

const PORT = 3000;
const MAX_BODY_BYTES = 1024 * 1024; // 1MB body limit

// Data directory: installed mode uses SMART_DATA_DIR (AppData), portable fallback, then cwd
const dataDir = process.env.SMART_DATA_DIR || process.env.PORTABLE_EXECUTABLE_DIR || process.cwd();
fs.mkdirSync(dataDir, { recursive: true });
const CONFIG_PATH = path.join(dataDir, 'config.json');

// Safety guard: dataDir holds per-user config (apps, links, routines, PIN).
// It must NEVER point at a machine-wide location like %PROGRAMDATA% \u2014 doing so
// would leak one user's setup to every Windows account on the PC. Only the
// license file is machine-wide (see resolveLicensePath below).
if (process.platform === 'win32' && process.env.PROGRAMDATA) {
    const programData = path.resolve(process.env.PROGRAMDATA).toLowerCase();
    if (path.resolve(dataDir).toLowerCase().startsWith(programData)) {
        // Cannot use log() here \u2014 it isn't defined yet. Use stderr.
        console.error('[smart-workspace] FATAL: dataDir resolved to a machine-wide path. Refusing to start to prevent cross-user data leak.');
        process.exit(1);
    }
}

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
// License is stored machine-wide so that all Windows user accounts on the
// same PC share a single activation slot. Falls back to the per-user data
// dir if the machine-wide location isn't writable (locked-down enterprise PCs,
// portable mode, non-Windows).
function resolveLicensePath() {
    const candidates = [];
    if (process.platform === 'win32' && process.env.PROGRAMDATA) {
        candidates.push(path.join(process.env.PROGRAMDATA, 'Smart Workspace'));
    } else if (process.platform !== 'win32') {
        candidates.push('/var/lib/smart-workspace');
    }
    candidates.push(dataDir); // per-user fallback
    for (const dir of candidates) {
        try {
            fs.mkdirSync(dir, { recursive: true });
            const probe = path.join(dir, '.write-probe');
            fs.writeFileSync(probe, '');
            fs.unlinkSync(probe);
            return path.join(dir, 'license.json');
        } catch {}
    }
    return path.join(dataDir, 'license.json');
}
const LICENSE_PATH = resolveLicensePath();
// One-time migration: if we're now using the machine-wide path but a legacy
// per-user license.json exists, promote it. The first Windows account to
// upgrade donates its activation slot to all other accounts on this PC.
try {
    const legacyPath = path.join(dataDir, 'license.json');
    if (LICENSE_PATH !== legacyPath && fs.existsSync(legacyPath) && !fs.existsSync(LICENSE_PATH)) {
        fs.copyFileSync(legacyPath, LICENSE_PATH);
        try { fs.unlinkSync(legacyPath); } catch {}
        log('info', `Migrated license to machine-wide path: ${LICENSE_PATH}`);
    }
} catch (e) {
    // Non-fatal; loadLicense will still work against whichever path resolved.
}
const TRIAL_DAYS = 14;
const OFFLINE_GRACE_DAYS = 7;
// Only re-validate against Lemon Squeezy at most once per this interval
// to avoid hammering the API and to limit blast-radius of transient failures.
const ONLINE_REVALIDATE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
// API responses that *definitively* mean the key is no longer valid.
// Anything else (rate-limit, timeout, malformed JSON, network blip) is treated
// as transient and falls through to the offline-grace path \u2014 we never wipe a
// paying customer's key on a flaky response.
const TERMINAL_LICENSE_ERRORS = new Set([
    'license_key_not_found',
    'license_key_disabled',
    'license_key_expired',
    'license_key_revoked'
]);

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

// Returns a stable per-machine identifier used as the human-readable label
// for the activation in Lemon Squeezy. On Windows we prefer the OS MachineGuid
// (survives renames). Hostname is the cross-platform fallback.
let _cachedInstanceName = null;
function getInstanceName() {
    if (_cachedInstanceName) return _cachedInstanceName;
    let label = null;
    try {
        if (process.platform === 'win32') {
            const out = require('child_process').execSync(
                'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
                { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
            );
            const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
            if (m) label = `${os.hostname()}-${m[1].slice(0, 8)}`;
        } else if (fs.existsSync('/etc/machine-id')) {
            const id = fs.readFileSync('/etc/machine-id', 'utf8').trim();
            if (id) label = `${os.hostname()}-${id.slice(0, 8)}`;
        }
    } catch {}
    if (!label) {
        try { label = os.hostname(); }
        catch { label = 'smart-workspace-device'; }
    }
    _cachedInstanceName = label;
    return label;
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
        if (result && result.valid) {
            lic.last_validated = new Date().toISOString();
            lic.status = 'active';
            saveLicense(lic);
            return true;
        }
        // Only treat *explicit* terminal errors as a real revocation.
        // Lemon Squeezy returns { valid:false, error:'license_key_not_found' } etc.
        const errCode = (result && (result.error || (result.license_key && result.license_key.status))) || '';
        if (TERMINAL_LICENSE_ERRORS.has(String(errCode))) {
            log('info', `License terminally invalid: ${errCode}`);
            lic.status = 'expired';
            lic.license_key = null;
            lic.instance_id = null;
            saveLicense(lic);
            return false;
        }
        // Unknown / transient response \u2014 do NOT wipe the key. Fall through.
        log('warn', `License validate returned non-terminal failure: ${JSON.stringify(result).slice(0, 200)}`);
    } catch (err) {
        log('warn', `License validate network error: ${err.message}`);
    }
    // Transient failure path: honor offline grace based on last successful validation
    if (lic.last_validated) {
        const daysSince = (Date.now() - new Date(lic.last_validated).getTime()) / 86400000;
        if (daysSince <= OFFLINE_GRACE_DAYS) return true;
    }
    return false;
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
            const linkInfoHeaderSize = buf.readUInt32LE(offset + 4);
            const linkInfoFlags = buf.readUInt32LE(offset + 8);
            const volumeIDAndLocalBasePath = (linkInfoFlags & 0x01) !== 0;

            if (volumeIDAndLocalBasePath) {
                // Prefer Unicode path when present (LinkInfoHeaderSize >= 36 means
                // optional Unicode offset fields exist). Falls back to ASCII.
                if (linkInfoHeaderSize >= 36 && offset + 36 <= linkInfoStart + linkInfoSize) {
                    const unicodeOffset = buf.readUInt32LE(offset + 28);
                    if (unicodeOffset > 0) {
                        const start = linkInfoStart + unicodeOffset;
                        if (start < buf.length) {
                            // UTF-16LE null-terminated
                            let end = start;
                            while (end + 1 < buf.length && !(buf[end] === 0 && buf[end + 1] === 0)) end += 2;
                            const unicodePath = buf.toString('utf16le', start, end);
                            if (unicodePath && unicodePath.length > 3) return unicodePath;
                        }
                    }
                }
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
            env: { ...process.env, SMART_ICON_PATH: cleaned },
            timeout: 8000,
            maxBuffer: 1024 * 1024 * 4
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

// --- Link metadata fetch (title + favicon) ---

const LINK_META_TIMEOUT_MS = 5000;
const LINK_META_MAX_HTML_BYTES = 512 * 1024;
const LINK_META_MAX_ICON_BYTES = 256 * 1024;
const LINK_META_MAX_REDIRECTS = 3;

function httpGetCapped(targetUrl, maxBytes, redirectsLeft) {
    return new Promise((resolve, reject) => {
        let parsed;
        try { parsed = new URL(targetUrl); } catch { return reject(new Error('Invalid URL')); }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return reject(new Error('Unsupported protocol'));
        }
        const lib = parsed.protocol === 'https:' ? https : http;
        const req = lib.request({
            method: 'GET',
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: (parsed.pathname || '/') + (parsed.search || ''),
            headers: {
                'User-Agent': 'Mozilla/5.0 SmartWorkspace/1.0',
                'Accept': '*/*'
            }
        }, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
                res.resume();
                let next;
                try { next = new URL(res.headers.location, targetUrl).toString(); }
                catch (e) { return reject(e); }
                return httpGetCapped(next, maxBytes, redirectsLeft - 1).then(resolve, reject);
            }
            if (res.statusCode < 200 || res.statusCode >= 300) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const chunks = [];
            let bytes = 0;
            res.on('data', (c) => {
                bytes += c.length;
                if (bytes > maxBytes) {
                    res.destroy();
                    return reject(new Error('Response too large'));
                }
                chunks.push(c);
            });
            res.on('end', () => resolve({
                buffer: Buffer.concat(chunks),
                contentType: (res.headers['content-type'] || '').toLowerCase(),
                finalUrl: targetUrl
            }));
            res.on('error', reject);
        });
        req.setTimeout(LINK_META_TIMEOUT_MS, () => { req.destroy(new Error('Timeout')); });
        req.on('error', reject);
        req.end();
    });
}

function decodeHtmlEntities(str) {
    if (!str) return str;
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// Pick the best <link rel="icon"> href from raw HTML
function pickFaviconHref(html) {
    const linkRe = /<link\b[^>]*>/gi;
    const candidates = [];
    let m;
    while ((m = linkRe.exec(html)) !== null) {
        const tag = m[0];
        const relMatch = tag.match(/\brel\s*=\s*["']([^"']+)["']/i);
        if (!relMatch) continue;
        const rel = relMatch[1].toLowerCase();
        if (!/(^|\s)(icon|shortcut icon|apple-touch-icon|apple-touch-icon-precomposed)(\s|$)/.test(rel)) continue;
        const hrefMatch = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
        if (!hrefMatch) continue;
        const sizeMatch = tag.match(/\bsizes\s*=\s*["']([^"']+)["']/i);
        let size = 0;
        if (sizeMatch) {
            const n = sizeMatch[1].match(/(\d+)/);
            if (n) size = parseInt(n[1], 10);
        }
        // Prefer bigger; apple-touch icons are usually large + clean PNGs
        const score = size + (rel.includes('apple-touch') ? 32 : 0);
        candidates.push({ href: decodeHtmlEntities(hrefMatch[1]), score });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].href;
}

async function fetchLinkMeta(rawUrl) {
    let url = String(rawUrl || '').trim();
    if (!url) return { name: null, iconDataUrl: null, finalUrl: null };
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    if (!isValidUrl(url)) return { name: null, iconDataUrl: null, finalUrl: null };

    let pageRes;
    try {
        pageRes = await httpGetCapped(url, LINK_META_MAX_HTML_BYTES, LINK_META_MAX_REDIRECTS);
    } catch (err) {
        log('warn', `fetchLinkMeta page error for ${url}: ${err.message}`);
        return { name: null, iconDataUrl: null, finalUrl: url };
    }

    const html = pageRes.buffer.toString('utf8');
    const finalUrl = pageRes.finalUrl;

    let name = null;
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) {
        name = decodeHtmlEntities(titleMatch[1]).replace(/\s+/g, ' ').trim().slice(0, 200);
        if (!name) name = null;
    }

    const iconHref = pickFaviconHref(html);
    let iconUrl = null;
    try {
        iconUrl = iconHref
            ? new URL(iconHref, finalUrl).toString()
            : new URL('/favicon.ico', finalUrl).toString();
    } catch {}

    let iconDataUrl = null;
    if (iconUrl) {
        try {
            const iconRes = await httpGetCapped(iconUrl, LINK_META_MAX_ICON_BYTES, LINK_META_MAX_REDIRECTS);
            const ct = iconRes.contentType.split(';')[0].trim();
            if (ct.startsWith('image/') && iconRes.buffer.length > 0) {
                iconDataUrl = `data:${ct};base64,${iconRes.buffer.toString('base64')}`;
            }
        } catch (err) {
            log('warn', `fetchLinkMeta icon error for ${iconUrl}: ${err.message}`);
            // If a parsed <link rel> href failed, fall back to /favicon.ico
            if (iconHref) {
                try {
                    const fallback = new URL('/favicon.ico', finalUrl).toString();
                    const iconRes = await httpGetCapped(fallback, LINK_META_MAX_ICON_BYTES, LINK_META_MAX_REDIRECTS);
                    const ct = iconRes.contentType.split(';')[0].trim();
                    if (ct.startsWith('image/') && iconRes.buffer.length > 0) {
                        iconDataUrl = `data:${ct};base64,${iconRes.buffer.toString('base64')}`;
                    }
                } catch {}
            }
        }
    }

    return { name, iconDataUrl, finalUrl };
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
        await new Promise((resolve) => {
            execFile('powershell', [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded
            ], {
                env: { ...process.env, SMART_SHORTCUT: shortcutPath, SMART_TARGET: process.execPath },
                timeout: 8000
            }, (err) => {
                if (err) log('error', `applyStartupSetting failed: ${err.message}`);
                resolve();
            });
        });
    } else {
        try { if (fs.existsSync(shortcutPath)) fs.unlinkSync(shortcutPath); }
        catch (err) { log('error', `applyStartupSetting unlink failed: ${err.message}`); }
    }
}

// --- Config Management ---

const DEFAULT_SETTINGS = { startup: false, onboarded: false, fullscreenOnStart: false, simpleMode: false, simplePinHash: '' };
const DEFAULT_CONFIG = { localApps: [], webLinks: [], workflows: [], categories: ['General'], settings: { ...DEFAULT_SETTINGS } };

function sha256(input) {
    return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function validateConfig(config) {
    if (!config || typeof config !== 'object') return { ...DEFAULT_CONFIG, settings: { ...DEFAULT_SETTINGS } };
    if (!Array.isArray(config.localApps)) config.localApps = [];
    if (!Array.isArray(config.webLinks)) config.webLinks = [];
    if (!Array.isArray(config.workflows)) config.workflows = [];
    if (!Array.isArray(config.categories) || config.categories.length === 0) config.categories = ['General'];
    // Migrate legacy workflows missing a category field.
    for (const w of config.workflows) {
        if (!w || typeof w !== 'object') continue;
        if (typeof w.category !== 'string' || !w.category.trim()) w.category = 'General';
    }
    if (!config.settings || typeof config.settings !== 'object') config.settings = { ...DEFAULT_SETTINGS };
    if (typeof config.settings.onboarded !== 'boolean') config.settings.onboarded = false;
    if (typeof config.settings.fullscreenOnStart !== 'boolean') config.settings.fullscreenOnStart = false;
    if (typeof config.settings.simpleMode !== 'boolean') config.settings.simpleMode = false;
    if (typeof config.settings.simplePinHash !== 'string') config.settings.simplePinHash = '';
    return config;
}

async function loadConfig() {
    // PER-USER ONLY. CONFIG_PATH lives under dataDir (= %APPDATA%\Smart Workspace
    // on Windows, via SMART_DATA_DIR env from main.js). Each Windows account has
    // its own config so users never see each other's apps, links, routines, or
    // Simple Mode PIN. Do NOT relocate this to %PROGRAMDATA%; only license.json
    // is intentionally machine-wide. See v1.0.37 release notes.
    // Try main file, then .bak fallback. On corruption, archive the bad copy
    // to userData/crashes/ for forensics and recover from .bak when possible.
    const tryRead = async (p) => {
        const data = await fs.promises.readFile(p, 'utf8');
        return validateConfig(JSON.parse(data));
    };
    try {
        const cfg = await tryRead(CONFIG_PATH);
        // Best-effort: refresh .bak with last-known-good copy.
        try { await fs.promises.copyFile(CONFIG_PATH, CONFIG_PATH + '.bak'); } catch {}
        return cfg;
    } catch (mainErr) {
        // Main file missing or corrupt. Try the backup.
        try {
            const cfg = await tryRead(CONFIG_PATH + '.bak');
            log('warn', `config.json unreadable (${mainErr.message}); recovered from .bak`);
            // Archive the bad file for debugging, then restore from .bak.
            try {
                if (fs.existsSync(CONFIG_PATH)) {
                    const crashDir = path.join(dataDir, 'crashes');
                    fs.mkdirSync(crashDir, { recursive: true });
                    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
                    fs.copyFileSync(CONFIG_PATH, path.join(crashDir, `config-${stamp}.bad`));
                }
                fs.copyFileSync(CONFIG_PATH + '.bak', CONFIG_PATH);
            } catch (e) { log('error', `config restore from .bak failed: ${e.message}`); }
            return cfg;
        } catch (bakErr) {
            // Nothing usable: write defaults atomically.
            const config = { ...DEFAULT_CONFIG };
            try { await saveConfig(config); } catch {}
            return config;
        }
    }
}

async function saveConfig(config) {
    config = validateConfig(config);
    // Atomic write: write to .tmp, fsync, then rename over the destination.
    // rename() is atomic on the same volume on Windows + POSIX.
    const tmpPath = CONFIG_PATH + '.tmp';
    const json = JSON.stringify(config, null, 2);
    const fh = await fs.promises.open(tmpPath, 'w');
    try {
        await fh.writeFile(json, 'utf8');
        try { await fh.sync(); } catch {}
    } finally {
        await fh.close();
    }
    await fs.promises.rename(tmpPath, CONFIG_PATH);
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

async function handleServeLogo(req, res) {
    const devPath = path.join(__dirname, 'build', 'logo.png');
    const prodPath = process.resourcesPath
        ? path.join(process.resourcesPath, 'logo.png')
        : devPath;
    const logoPath = fs.existsSync(prodPath) ? prodPath : devPath;
    fs.readFile(logoPath, (err, content) => {
        if (err) return sendError(res, 404, 'Logo not found');
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
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
    // Never expose the PIN hash to the renderer; surface presence as a boolean.
    const { simplePinHash, ...safe } = config.settings;
    safe.simplePinSet = !!simplePinHash;
    sendJSON(res, safe);
}

async function handlePostSettings(req, res) {
    const body = await parseBody(req);
    const config = await loadConfig();
    // Strip protected fields; they have dedicated endpoints.
    const { simplePinHash, simpleMode, ...safeBody } = body || {};
    config.settings = { ...config.settings, ...safeBody };
    if (safeBody.startup !== undefined) await applyStartupSetting(!!safeBody.startup);
    await saveConfig(config);
    sendJSON(res, { success: true });
}

async function handleSimpleMode(req, res) {
    const body = await parseBody(req);
    const config = await loadConfig();
    const enabled = !!body.enabled;
    const currentHash = config.settings.simplePinHash || '';
    const pin = typeof body.pin === 'string' ? body.pin.trim() : '';
    const hasNewPin = body.newPin !== undefined;
    const newPin = hasNewPin ? String(body.newPin).trim() : '';

    // PIN management is independent of enable/disable: set/clear works in either mode.
    if (hasNewPin) {
        if (currentHash && sha256(pin) !== currentHash) return sendError(res, 403, 'Incorrect PIN');
        if (newPin && !/^\d{4,8}$/.test(newPin)) return sendError(res, 400, 'PIN must be 4–8 digits');
        config.settings.simplePinHash = newPin ? sha256(newPin) : '';
    }

    if (enabled) {
        config.settings.simpleMode = true;
        // Ensure a "Family" category exists so users have something to tag with.
        if (!config.categories.includes('Family')) config.categories.push('Family');
    } else if (!hasNewPin) {
        // Plain disable: require existing PIN if one is set.
        if (currentHash && sha256(pin) !== currentHash) return sendError(res, 403, 'Incorrect PIN');
        config.settings.simpleMode = false;
    }
    // else: PIN management call with enabled=false → leave simpleMode unchanged.

    await saveConfig(config);
    sendJSON(res, { success: true, simpleMode: config.settings.simpleMode, simplePinSet: !!config.settings.simplePinHash });
}

async function handleVerifySimplePin(req, res) {
    const body = await parseBody(req);
    const config = await loadConfig();
    const currentHash = config.settings.simplePinHash || '';
    if (!currentHash) return sendJSON(res, { ok: true });
    const pin = typeof body.pin === 'string' ? body.pin.trim() : '';
    sendJSON(res, { ok: sha256(pin) === currentHash });
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

async function handleFetchLinkMeta(req, res) {
    const body = await parseBody(req);
    if (!body.url || typeof body.url !== 'string') {
        return sendError(res, 400, 'Invalid url');
    }
    const meta = await fetchLinkMeta(body.url);
    sendJSON(res, meta);
}

// --- Suggested websites (curated for the first-run wizard + Settings shortcut) ---
const SUGGESTED_SITES = [
    { name: 'Google',         url: 'https://google.com',           emoji: '\uD83D\uDD0D' },
    { name: 'YouTube',        url: 'https://youtube.com',          emoji: '\u25B6\uFE0F' },
    { name: 'Gmail',          url: 'https://mail.google.com',      emoji: '\u2709\uFE0F' },
    { name: 'Facebook',       url: 'https://facebook.com',         emoji: '\uD83D\uDC65' },
    { name: 'Amazon',         url: 'https://amazon.com',           emoji: '\uD83D\uDCE6' },
    { name: 'BBC News',       url: 'https://bbc.com/news',         emoji: '\uD83D\uDCF0' },
    { name: 'Weather',        url: 'https://weather.com',          emoji: '\u26C5' },
    { name: 'Netflix',        url: 'https://netflix.com',          emoji: '\uD83C\uDFAC' },
    { name: 'WhatsApp Web',   url: 'https://web.whatsapp.com',     emoji: '\uD83D\uDCAC' },
    { name: 'Wikipedia',      url: 'https://wikipedia.org',        emoji: '\uD83D\uDCDA' },
    { name: 'Google Maps',    url: 'https://maps.google.com',      emoji: '\uD83D\uDDFA\uFE0F' },
    { name: 'Bank of America',url: 'https://bankofamerica.com',    emoji: '\uD83C\uDFE6' },
    { name: 'PayPal',         url: 'https://paypal.com',           emoji: '\uD83D\uDCB3' },
    { name: 'Spotify',        url: 'https://open.spotify.com',     emoji: '\uD83C\uDFB5' },
    { name: 'Outlook.com',    url: 'https://outlook.live.com',     emoji: '\uD83D\uDCE7' }
];

async function handleGetSuggestedSites(req, res) {
    sendJSON(res, SUGGESTED_SITES);
}

// --- Changelog ---
let githubReleasesCache = null; // { fetchedAt, byTag: Map }

function findChangelogPath() {
    const dev = path.join(__dirname, 'CHANGELOG.md');
    if (process.resourcesPath) {
        const prod = path.join(process.resourcesPath, 'CHANGELOG.md');
        if (fs.existsSync(prod)) return prod;
    }
    return dev;
}

function findEulaPath() {
    const dev = path.join(__dirname, 'build', 'LICENSE.txt');
    if (process.resourcesPath) {
        const prod = path.join(process.resourcesPath, 'LICENSE.txt');
        if (fs.existsSync(prod)) return prod;
    }
    return dev;
}

async function handleGetEula(req, res) {
    try {
        const text = fs.readFileSync(findEulaPath(), 'utf8');
        sendJSON(res, { text });
    } catch (e) {
        sendJSON(res, { text: '' });
    }
}

function parseChangelog(text) {
    if (!text) return [];
    const out = [];
    const lines = text.split(/\r?\n/);
    let current = null;
    for (const line of lines) {
        const m = line.match(/^##\s+v(\d+\.\d+\.\d+)\s*(?:[-\u2013\u2014]\s*([^\s].*?))?\s*$/);
        if (m) {
            if (current) out.push(current);
            current = { version: m[1], date: (m[2] || '').trim(), body: '' };
            continue;
        }
        if (current) current.body += line + '\n';
    }
    if (current) out.push(current);
    return out.map(e => Object.assign(e, { body: e.body.trim() }));
}

function fetchGithubReleases() {
    if (githubReleasesCache && (Date.now() - githubReleasesCache.fetchedAt) < 6 * 60 * 60 * 1000) {
        return Promise.resolve(githubReleasesCache.byTag);
    }
    return new Promise((resolve) => {
        const req = https.get({
            hostname: 'api.github.com',
            path: '/repos/KLS-Digital-Solutions/Smart-Workshop/releases',
            headers: { 'User-Agent': 'SmartWorkspace-App', 'Accept': 'application/vnd.github+json' },
            timeout: 3000
        }, (resp) => {
            if (resp.statusCode !== 200) { resp.resume(); return resolve(new Map()); }
            const chunks = [];
            let total = 0;
            const cap = 256 * 1024;
            resp.on('data', c => { total += c.length; if (total <= cap) chunks.push(c); else resp.destroy(); });
            resp.on('end', () => {
                try {
                    const arr = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    const map = new Map();
                    if (Array.isArray(arr)) {
                        for (const r of arr) {
                            if (r && typeof r.tag_name === 'string') {
                                map.set(r.tag_name.replace(/^v/, ''), r.body || '');
                            }
                        }
                    }
                    githubReleasesCache = { fetchedAt: Date.now(), byTag: map };
                    resolve(map);
                } catch (e) { resolve(new Map()); }
            });
            resp.on('error', () => resolve(new Map()));
        });
        req.on('timeout', () => { req.destroy(); resolve(new Map()); });
        req.on('error', () => resolve(new Map()));
    });
}

async function handleGetChangelog(req, res) {
    let entries = [];
    try {
        const text = fs.readFileSync(findChangelogPath(), 'utf8');
        entries = parseChangelog(text);
    } catch (e) {
        // No bundled changelog; return empty list.
    }
    let githubMap = new Map();
    try { githubMap = await fetchGithubReleases(); } catch (e) {}
    for (const e of entries) {
        const gh = githubMap.get(e.version);
        if (gh) e.githubBody = gh;
    }
    sendJSON(res, { currentVersion: appVersion, entries });
}

async function handleAddSuggested(req, res) {
    const body = await parseBody(req);
    const items = Array.isArray(body && body.sites) ? body.sites : [];
    if (!items.length) return sendJSON(res, { added: 0, failed: [] });
    const config = await loadConfig();
    const failed = [];
    let added = 0;
    let idCounter = Date.now();
    for (const s of items) {
        if (!s || typeof s.url !== 'string' || typeof s.name !== 'string') { failed.push(s && s.name); continue; }
        let url = s.url.trim();
        if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
        const category = (typeof s.category === 'string' && s.category.trim()) ? s.category.trim() : 'General';
        if (category && !config.categories.includes(category)) config.categories.push(category);
        // Best-effort favicon fetch; failure leaves emoji fallback.
        let iconBase64 = '';
        try {
            const meta = await fetchLinkMeta(url);
            if (meta && meta.iconDataUrl) iconBase64 = meta.iconDataUrl;
        } catch (e) {}
        const item = {
            id: String(++idCounter),
            type: 'link',
            name: s.name.trim(),
            url,
            category,
            icon: typeof s.emoji === 'string' && s.emoji ? s.emoji : '\uD83C\uDF10'
        };
        if (iconBase64) item.iconBase64 = iconBase64;
        config.webLinks.push(item);
        added++;
    }
    await saveConfig(config);
    sendJSON(res, { added, failed });
}

async function handleWizardComplete(req, res) {
    const body = await parseBody(req) || {};
    const config = await loadConfig();
    if (typeof body.fullscreenOnStart === 'boolean') config.settings.fullscreenOnStart = body.fullscreenOnStart;
    if (typeof body.startup === 'boolean') {
        try { await applyStartupSetting(!!body.startup); } catch (e) {}
        config.settings.startup = !!body.startup;
    }
    if (typeof body.simpleMode === 'boolean') {
        config.settings.simpleMode = body.simpleMode;
        if (body.simpleMode && !config.categories.includes('Family')) config.categories.push('Family');
    }
    if (typeof body.simplePin === 'string') {
        const newPin = body.simplePin.trim();
        if (newPin) {
            if (!/^\d{4,8}$/.test(newPin)) return sendError(res, 400, 'PIN must be 4\u20138 digits');
            config.settings.simplePinHash = sha256(newPin);
        } else {
            config.settings.simplePinHash = '';
        }
    }
    config.settings.onboarded = true;
    await saveConfig(config);
    sendJSON(res, { success: true });
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

    // Harden: drop items missing required fields
    let skipped = 0;
    const beforeApps = config.localApps.length;
    const beforeLinks = config.webLinks.length;
    const beforeWorkflows = config.workflows.length;

    config.localApps = config.localApps.filter(a => a && typeof a.command === 'string' && a.command.trim() && typeof a.name === 'string' && a.name.trim());
    config.webLinks = config.webLinks.filter(l => l && typeof l.url === 'string' && isValidUrl(l.url) && typeof l.name === 'string' && l.name.trim());
    config.workflows = config.workflows.filter(w => w && Array.isArray(w.items) && typeof w.name === 'string' && w.name.trim());

    skipped = (beforeApps - config.localApps.length) + (beforeLinks - config.webLinks.length) + (beforeWorkflows - config.workflows.length);

    await saveConfig(config);
    log('info', `Config imported (skipped ${skipped} invalid entries)`);
    sendJSON(res, { success: true, skipped, imported: config.localApps.length + config.webLinks.length + config.workflows.length });
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
        // Throttle: only hit the API if we haven't validated recently.
        // Otherwise trust the cached active status \u2014 prevents per-render API hits
        // and limits damage from any single bad response.
        const lastMs = lic.last_validated ? new Date(lic.last_validated).getTime() : 0;
        const stale = !lastMs || (Date.now() - lastMs) > ONLINE_REVALIDATE_INTERVAL_MS;
        const valid = stale ? await validateLicenseOnline(lic) : (lic.status === 'active');
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
    const expiryDate = new Date(new Date(lic.trial_start).getTime() + TRIAL_DAYS * 86400000).toISOString();
    if (daysRemaining > 0) {
        sendJSON(res, {
            status: 'trial',
            days_remaining: daysRemaining,
            trial_total_days: TRIAL_DAYS,
            expiry_date: expiryDate,
            offline_grace_days: OFFLINE_GRACE_DAYS,
            store_url: storeUrl
        });
    } else {
        sendJSON(res, { status: 'expired', expiry_date: expiryDate, store_url: storeUrl });
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

async function handleGetUpdateStatus(req, res) {
    const state = global.smartUpdateState || { status: 'idle', version: null, checkedAt: null, error: null };
    sendJSON(res, state);
}

async function handleCheckForUpdates(req, res) {
    if (typeof global.smartCheckForUpdates === 'function') {
        try { global.smartCheckForUpdates(); } catch (e) {}
        sendJSON(res, { success: true });
    } else {
        sendError(res, 503, 'Updater unavailable (dev mode)');
    }
}

async function handleQuitAndInstall(req, res) {
    const state = global.smartUpdateState || {};
    if (state.status !== 'downloaded') {
        return sendError(res, 409, 'No update is ready to install');
    }
    sendJSON(res, { success: true });
    setTimeout(() => {
        if (typeof global.smartQuitAndInstall === 'function') {
            global.smartQuitAndInstall();
        }
    }, 200);
}

// --- Route Table ---

const routes = {
    'GET /': handleServeHTML,
    'GET /index.html': handleServeHTML,
    'GET /logo.png': handleServeLogo,
    'GET /api/config': handleGetConfig,
    'GET /api/settings': handleGetSettings,
    'POST /api/settings': handlePostSettings,
    'POST /api/simple-mode': handleSimpleMode,
    'POST /api/simple-pin/verify': handleVerifySimplePin,
    'GET /api/stats': handleGetStats,
    'GET /api/system-apps': handleGetSystemApps,
    'POST /api/extract-icon': handleExtractIcon,
    'POST /api/fetch-link-meta': handleFetchLinkMeta,
    'GET /api/suggested-sites': handleGetSuggestedSites,
    'GET /api/changelog': handleGetChangelog,
    'GET /api/eula': handleGetEula,
    'POST /api/add-suggested': handleAddSuggested,
    'POST /api/wizard/complete': handleWizardComplete,
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
    'GET /api/update-status': handleGetUpdateStatus,
    'POST /api/quit-and-install': handleQuitAndInstall,
    'POST /api/check-for-updates': handleCheckForUpdates,
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
const serverReady = new Promise((resolve, reject) => {
    server.once('error', (err) => {
        log('error', `Server listen error: ${err.message}`);
        reject(err);
    });
    server.listen(PORT, '127.0.0.1', () => {
        console.log(`Smart Workspace server running on http://127.0.0.1:${PORT}`);
        log('info', `Server started on http://127.0.0.1:${PORT}`);
        resolve();
    });
});

module.exports = { serverReady };
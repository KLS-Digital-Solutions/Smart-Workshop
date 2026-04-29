// Build with obfuscation
// Usage:
//   node scripts/build.js            -> electron-builder --win --publish never
//   node scripts/build.js --publish  -> electron-builder --win --publish always
//
// Obfuscates server.js in place before packaging, then restores the original
// source afterward (even if the build fails). main.js is intentionally left
// untouched to avoid interfering with Electron internals.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const JavaScriptObfuscator = require('javascript-obfuscator');
const { generateChangelogEntry } = require('./changelog');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = ['server.js'];
const BACKUP_SUFFIX = '.preobf-backup';

const OBFUSCATOR_OPTIONS = {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.6,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.3,
    identifierNamesGenerator: 'hexadecimal',
    numbersToExpressions: true,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 8,
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 0.75,
    transformObjectKeys: false, // keep object keys readable so Node/HTTP APIs still work
    unicodeEscapeSequence: false,
    selfDefending: false, // off: can break Node require caching in rare cases
    disableConsoleOutput: false,
    target: 'node',
    reservedNames: [
        '^require$', '^module$', '^exports$', '^__dirname$', '^__filename$',
        '^global$', '^process$', '^Buffer$'
    ]
};

function backupAndObfuscate() {
    for (const file of TARGETS) {
        const src = path.join(ROOT, file);
        const backup = src + BACKUP_SUFFIX;
        if (fs.existsSync(backup)) {
            // Stale backup from a previous crashed run: restore it before re-obfuscating.
            console.log(`[obfuscate] restoring stale backup for ${file}`);
            fs.copyFileSync(backup, src);
            fs.unlinkSync(backup);
        }
        const original = fs.readFileSync(src, 'utf8');
        fs.writeFileSync(backup, original);
        console.log(`[obfuscate] processing ${file} (${original.length} bytes)`);
        const result = JavaScriptObfuscator.obfuscate(original, OBFUSCATOR_OPTIONS).getObfuscatedCode();
        fs.writeFileSync(src, result);
        console.log(`[obfuscate] ${file} -> ${result.length} bytes`);
    }
}

function restore() {
    for (const file of TARGETS) {
        const src = path.join(ROOT, file);
        const backup = src + BACKUP_SUFFIX;
        if (fs.existsSync(backup)) {
            fs.copyFileSync(backup, src);
            fs.unlinkSync(backup);
            console.log(`[obfuscate] restored ${file}`);
        }
    }
}

function runBuilder(publish) {
    const args = ['electron-builder', '--win', '--publish', publish ? 'always' : 'never'];
    console.log(`[build] npx ${args.join(' ')}`);
    const result = spawnSync('npx', args, { cwd: ROOT, stdio: 'inherit', shell: true });
    return result.status === 0;
}

let success = false;
try {
    const isPublish = process.argv.includes('--publish');
    try {
        const pkgVersion = require(path.join(ROOT, 'package.json')).version;
        generateChangelogEntry({ version: pkgVersion, repoRoot: ROOT, dryRun: !isPublish });
    } catch (e) {
        console.warn('[changelog] generation failed (continuing):', e.message);
    }
    backupAndObfuscate();
    success = runBuilder(isPublish);
} catch (err) {
    console.error('[build] error:', err.message);
} finally {
    restore();
}
process.exit(success ? 0 : 1);

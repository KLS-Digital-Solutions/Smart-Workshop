// Build-time changelog generator.
// Reads previous git tag, runs `git log <prevTag>..HEAD --pretty=format:%s`,
// filters noisy commits, and prepends a `## v{version} - {YYYY-MM-DD}` section
// to CHANGELOG.md. Existing version sections are NEVER overwritten so manual
// edits stick.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const FILTER_PATTERNS = [
    /^merge\b/i,
    /^wip\b/i,
    /^chore: bump\b/i,
    /^bump version\b/i,
    /^release v\d/i,
    /^\d+\.\d+\.\d+$/, // npm version commits ("1.0.31")
    /^v\d+\.\d+\.\d+$/
];

function git(args, cwd) {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) return null;
    return (r.stdout || '').trim();
}

function getPreviousTag(cwd, currentVersion) {
    // Prefer a tag that isn't the one just created by `npm version`.
    const tags = git(['tag', '--sort=-creatordate'], cwd);
    if (!tags) return null;
    const list = tags.split(/\r?\n/).filter(Boolean);
    const currentTag = `v${currentVersion}`;
    for (const t of list) {
        if (t === currentTag) continue;
        return t;
    }
    return null;
}

function collectCommits(cwd, prevTag) {
    const range = prevTag ? `${prevTag}..HEAD` : 'HEAD';
    const out = git(['log', range, '--no-merges', '--pretty=format:%s'], cwd);
    if (!out) return [];
    return out.split(/\r?\n/).map(s => s.trim()).filter(s => {
        if (!s) return false;
        return !FILTER_PATTERNS.some(re => re.test(s));
    });
}

function todayISO() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function buildSection(version, commits) {
    const lines = [`## v${version}`, ''];
    if (commits.length === 0) {
        lines.push('- Maintenance release.');
    } else {
        for (const c of commits) lines.push(`- ${c}`);
    }
    lines.push('');
    return lines.join('\n');
}

function hasVersion(content, version) {
    const re = new RegExp(`^##\\s+v${version.replace(/\./g, '\\.')}\\b`, 'm');
    return re.test(content);
}

function ensureChangelog(filePath) {
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, '# Smart Workspace - Changelog\n\n');
    }
    return fs.readFileSync(filePath, 'utf8');
}

/**
 * Generate / prepend a changelog entry for the given version.
 * @param {Object} opts
 * @param {string} opts.version - The version being released (e.g. "1.0.31").
 * @param {string} opts.repoRoot - Absolute path to the repo root.
 * @param {boolean} [opts.dryRun=false] - If true, only print would-be content.
 * @returns {{ written: boolean, skipped: string|null, section: string }}
 */
function generateChangelogEntry({ version, repoRoot, dryRun = false }) {
    const filePath = path.join(repoRoot, 'CHANGELOG.md');
    const existing = ensureChangelog(filePath);

    if (hasVersion(existing, version)) {
        return { written: false, skipped: 'already-present', section: '' };
    }

    const prevTag = getPreviousTag(repoRoot, version);
    const commits = collectCommits(repoRoot, prevTag);
    const section = buildSection(version, commits);

    if (dryRun) {
        console.log(`[changelog] DRY RUN - would prepend section for v${version}:`);
        console.log(section);
        return { written: false, skipped: 'dry-run', section };
    }

    // Insert after first top-level "# " heading if present, else at top.
    const headingMatch = existing.match(/^#\s+[^\n]*\n+/);
    let next;
    if (headingMatch) {
        const insertAt = headingMatch[0].length;
        next = existing.slice(0, insertAt) + section + '\n' + existing.slice(insertAt);
    } else {
        next = section + '\n' + existing;
    }
    fs.writeFileSync(filePath, next);
    console.log(`[changelog] prepended v${version} (${commits.length} commit${commits.length === 1 ? '' : 's'})`);
    return { written: true, skipped: null, section };
}

module.exports = { generateChangelogEntry };

// CLI: `node scripts/changelog.js [--dry-run] [--version=X.Y.Z]`
if (require.main === module) {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const versionArg = args.find(a => a.startsWith('--version='));
    const repoRoot = path.resolve(__dirname, '..');
    const version = versionArg ? versionArg.split('=')[1] : require(path.join(repoRoot, 'package.json')).version;
    generateChangelogEntry({ version, repoRoot, dryRun });
}

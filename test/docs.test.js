// The deployment guide is part of the contract: the person on the App
// Platform console during an incident needs the env var table and both
// rollback paths to be there, and nothing in the tree may carry an em dash.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

test('BC-1: DEPLOYMENT_GUIDE.md documents the env kill switches and the a171dfd redeploy as rollback paths', () => {
    const guide = read('DEPLOYMENT_GUIDE.md');
    assert.match(guide, /^#{2,4} .*Rollback/m, 'a Rollback heading');
    assert.ok(guide.includes('SONIOX_ROTATION=off'), 'rotation kill switch');
    assert.ok(guide.includes('SONIOX_STALL_WATCHDOG=off'), 'watchdog kill switch');
    assert.ok(guide.includes('a171dfd'), 'the deployed commit to redeploy');
    assert.ok(guide.includes('Soniox relay:'), 'how to confirm the old build is back');
});

test('every SONIOX_* variable relay.js reads has a row in the guide table', () => {
    const guide = read('DEPLOYMENT_GUIDE.md');
    const vars = new Set([...read('relay.js').matchAll(/env\.(SONIOX_[A-Z0-9_]+)/g)].map((m) => m[1]));
    assert.ok(vars.size >= 25, `found ${vars.size} variables`);
    for (const v of vars) assert.ok(guide.includes(`\`${v}\``), `${v} is missing from DEPLOYMENT_GUIDE.md`);
});

test('no em dashes in the relay sources, tests, or docs', () => {
    const emDash = String.fromCharCode(0x2014);
    const files = [
        'relay.js', 'upstream.js', 'server.js', 'DEPLOYMENT_GUIDE.md', 'docs/reliability-2026-10.md',
        ...readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.js')).map((f) => `test/${f}`),
    ];
    for (const f of files) {
        assert.equal(read(f).includes(emDash), false, `${f} contains an em dash`);
    }
});

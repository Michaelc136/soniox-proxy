#!/usr/bin/env node
/**
 * Builds summary.md and matrix.json from the *.summary.json files that
 * reproduce-stall.js writes.
 *
 * Usage: node summarize.js [OUT_DIR] [--smoke]
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// Not a test: when `node --test` sweeps test/**, exit cleanly instead of running the tool.
if (process.env.NODE_TEST_CONTEXT) process.exit(0);

const DEFAULT_OUT = '/private/tmp/claude-501/-Users-michaelcolley/09c687da-aa28-4f09-b63f-5172f23505f0/scratchpad/harness';

const args = process.argv.slice(2);
const smoke = args.includes('--smoke');
const dir = args.find((a) => !a.startsWith('--')) || DEFAULT_OUT;

const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.summary.json') && (smoke ? f.includes('-smoke') : !f.includes('-smoke')));
if (files.length === 0) {
    console.error(`no ${smoke ? 'smoke ' : ''}summary files in ${dir}`);
    process.exit(1);
}

const order = { A: 0, B: 1, C: 2 };
const runs = files
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .sort((a, b) => (a.strict === b.strict ? order[a.condition] - order[b.condition] : a.strict ? 1 : -1));

const finals = (p) => `${p.finals_none}/${p.finals_original}/${p.finals_translation}`;
const langs = (p) => {
    const e = Object.entries(p.languages).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`);
    return e.length ? e.join(' ') : '-';
};
const num = (v, d = 1) => (v == null ? '-' : Number(v).toFixed(d));
const yesno = (v) => (v ? 'yes' : 'no');

const header = [
    'Run', 'Gap', 'Strict', 'Pre finals (none/orig/trans)', 'Gap finals', 'Post finals',
    'Langs pre', 'Langs gap', 'Langs post', 'Translation resumed', 'First post-gap translation (s)',
    'Trans per spoken (pre -> post)', 'Errors', 'Close', 'Audio sent (min)',
];
const rows = runs.map((r) => [
    r.label, r.gap, yesno(r.strict), finals(r.phases.pre), finals(r.phases.gap), finals(r.phases.post),
    langs(r.phases.pre), langs(r.phases.gap), langs(r.phases.post), yesno(r.translation_resumed),
    num(r.seconds_to_first_post_gap_translation),
    `${num(r.pre_translation_per_spoken, 2)} -> ${num(r.post_translation_per_spoken, 2)}`,
    r.errors.length ? r.errors.map((e) => `${e.error_code ?? ''} ${e.error_type ?? ''}`.trim()).join('; ') : 'none',
    r.close ? `${r.close.code}${r.finished ? ' finished' : ''}` : '-',
    num(r.audio_seconds_sent / 60),
]);

const nostrictStalls = runs.filter((r) => !r.strict && r.stall_reproduced);
const reproduced = nostrictStalls.length > 0;
const strictPrevented = reproduced && nostrictStalls.every((r) => {
    const s = runs.find((x) => x.condition === r.condition && x.strict);
    return s && s.translation_resumed && !s.stall_reproduced;
});
const anyStall = runs.filter((r) => r.stall_reproduced);
const totalAudioMinutes = runs.reduce((a, r) => a + r.audio_seconds_sent / 60, 0);

const table = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
].join('\n');

const liveSessions = process.env.HARNESS_LIVE_SESSIONS ?? 'unknown';
const md = `# Soniox translation stall, reproduction harness${smoke ? ' (smoke)' : ''}

Generated ${new Date().toISOString()}. Live Selah sessions at start: ${liveSessions}. Runs: ${runs.length}. Total audio streamed: ${totalAudioMinutes.toFixed(1)} minutes.

Each run streams English speech, then a gap, then English speech, directly to \`${runs[0].soniox_url}\` with model \`${runs[0].model}\`, hints [en], endpoint detection, language identification, one_way translation to ${runs[0].target}. "Finals" are final tokens split by translation_status (none / original / translation); "Langs" counts the \`language\` field of final spoken (none + original) tokens.

${table}

## Verdict

- Stall reproduced (post-gap speech transcribed with zero translation tokens) in a strict-off run: **${yesno(reproduced)}**${reproduced ? ` (${nostrictStalls.map((r) => r.label).join(', ')})` : ''}.
- Any run with a stall: ${anyStall.length ? anyStall.map((r) => r.label).join(', ') : 'none'}.
- language_hints_strict prevented the stall in the matching strict-on run: **${reproduced ? yesno(strictPrevented) : 'not applicable (no stall to prevent)'}**.

## Per-run notes

${runs.map((r) => {
    const errs = r.errors.length ? r.errors.map((e) => `${e.error_code ?? ''} ${e.error_type ?? ''} ${e.error_message ?? ''}`.trim()).join('; ') : 'none';
    return `- **${r.label}**: ${r.started_at} to ${r.ended_at}, wall ${num(r.wall_seconds / 60)} min, audio ${num(r.audio_seconds_sent / 60)} min, completed audio ${yesno(r.completed_audio)}, finished frame ${yesno(r.finished)}, close ${r.close ? r.close.code : '-'}, tokens ${r.tokens_total} (${r.final_tokens_total} final, ${r.fin_tokens} fin), end tokens pre/gap/post ${r.phases.pre.end_tokens}/${r.phases.gap.end_tokens}/${r.phases.post.end_tokens}, errors: ${errs}. Tokens: \`${path.basename(r.tokens_file)}\`.`;
}).join('\n')}
`;

const mdPath = path.join(dir, smoke ? 'summary-smoke.md' : 'summary.md');
const jsonPath = path.join(dir, smoke ? 'matrix-smoke.json' : 'matrix.json');
fs.writeFileSync(mdPath, md);
fs.writeFileSync(jsonPath, `${JSON.stringify({
    generated_at: new Date().toISOString(), live_sessions_at_start: liveSessions, reproduced_stall: reproduced,
    strict_prevented_stall: strictPrevented, total_audio_minutes: totalAudioMinutes,
    runs: runs.map((r) => ({
        label: r.label, condition: r.condition, gap: r.gap, strict: r.strict, translation_resumed: r.translation_resumed,
        stall_reproduced: r.stall_reproduced, seconds_to_first_post_gap_translation: r.seconds_to_first_post_gap_translation,
        pre: r.phases.pre, gap_phase: r.phases.gap, post: r.phases.post, errors: r.errors, close: r.close, finished: r.finished,
        completed_audio: r.completed_audio, audio_seconds_sent: r.audio_seconds_sent, wall_seconds: r.wall_seconds, tokens_file: r.tokens_file,
    })),
}, null, 2)}\n`);
console.log(md);
console.error(`wrote ${mdPath} and ${jsonPath}`);

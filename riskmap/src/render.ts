/**
 * Step 8 — the output.
 *
 * ONE PAGE. Static HTML, self-contained, openable from an email attachment with no network,
 * no fonts, no scripts and no build step. The spec's instruction to resist the dashboard is
 * not an aesthetic preference: filters and drill-downs are how this turns into a two-month
 * project that never gets sent to anyone, and an artifact nobody receives has no value at all.
 *
 * EVERY FLAGGED REGION CARRIES A NEXT ACTION, and it is the same action every time. A map that
 * names a problem and stops is a poster. The action is deliberately identical across rows
 * because varying it would imply a diagnosis this tool cannot make.
 *
 * NO INDIVIDUAL IS EVER NAMED. There is no code path from here to a name — the renderer is
 * handed regions, and regions carry counts. See identity.ts, which is the only module that
 * ever holds an address and which hands out opaque keys.
 *
 * The plain-English line per region is generated from which tests fired, not from a template
 * with the numbers dropped in, so it says the same thing the table says rather than dressing
 * it up.
 */

import type { Region, RiskMap } from './types.js';
import { effectiveRule } from './dimensions.js';
import { describePercentile, type Calibration } from './calibration.js';

const ACTION =
  'This region needs a written explanation from someone who still works here.';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

function fmtDate(ms: number | null): string {
  if (ms === null) return 'never';
  return new Date(ms).toISOString().slice(0, 10);
}

function monthYear(ms: number | null): string {
  if (ms === null) return 'never';
  // timeZone MUST be pinned. Without it this renders in the generating machine's local zone
  // while fmtDate above uses UTC, so the table cell and the sentence directly beneath it
  // disagreed for any timestamp near midnight — and the page changed depending on where it was
  // generated, breaking the "same clone yields the same map" claim.
  return new Date(ms).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Why this region flagged, in a sentence a reader can act on.
 *
 * Phrased as INACTIVITY throughout, never as departure: no commits in the window is a proxy,
 * and people go on leave, change teams and work on other repositories.
 */
export function explain(r: Region, t: RiskMap['thresholds'], cal: Calibration | null): string {
  const bits: string[] = [];

  if (r.flags.includes('orphaned')) {
    const n = r.departedContributors;
    const of = r.contributors;
    bits.push(
      `${pct(r.orphanedShare)} of the files here were last changed by someone who has not ` +
        `committed anywhere in this repository in over ${t.inactivityMonths} months — ` +
        `${n} of its ${of} contributor${of === 1 ? '' : 's'}, counting only people who were ` +
        'substantially involved rather than one-off contributors'
    );
  }
  if (r.flags.includes('concentrated')) {
    bits.push(`${pct(r.concentration)} of its changes came from a single contributor`);
  }
  if (r.flags.includes('hot')) {
    bits.push(`it is still moving, at ${r.commitsPerMonth.toFixed(1)} commits a month`);
  }
  if (r.flags.includes('undocumented') && r.recordCoverage !== null && cal) {
    bits.push(`its commit records answer ${pct(r.recordCoverage)} of mechanism questions — ${describePercentile(cal, r.recordCoverage)}`);
  }

  const last =
    r.lastSubstantiveExplanation === null
      ? 'Nothing substantive has been written here in the whole window.'
      : `Nothing substantive has been written here since ${monthYear(r.lastSubstantiveExplanation)}.`;

  const head = bits.length ? `${bits.join('; ')}.` : '';
  return `${head} ${last}`.trim();
}

function flagChips(r: Region): string {
  const label: Record<string, string> = {
    orphaned: 'orphaned',
    concentrated: 'concentrated',
    hot: 'active',
    undocumented: 'undocumented',
  };
  return r.flags.map((f) => `<span class="chip chip-${f}">${label[f]}</span>`).join(' ');
}

export function renderHtml(map: RiskMap, cal: Calibration | null): string {
  const { report, thresholds: t, squash, top } = map;
  const recordShown = squash.availability !== 'unavailable';
  const rule = effectiveRule(t, recordShown && top.some((r) => r.recordCoveragePercentile !== null));

  const rows = top
    .map((r) => {
      const cov =
        r.recordCoverage === null
          ? '<td class="num na" title="not scored">—</td>'
          : `<td class="num">${pct(r.recordCoverage)}<span class="sub">p${r.recordCoveragePercentile?.toFixed(0) ?? '?'}</span></td>`;
      return `
      <tr class="${r.flagged ? 'flagged' : 'sub-threshold'}">
        <td class="region"><code>${esc(r.path)}</code>${r.findings.map((f) => `<span class="mark mark-${f}">${f}</span>`).join('')}<div class="chips">${flagChips(r)}</div></td>
        <td class="num strong">${pct(r.orphanedShare)}<span class="sub">${r.inactiveContributors}/${r.contributors} inactive</span></td>
        <td class="num">${pct(r.concentration)}</td>
        <td class="num">${r.commitsPerMonth.toFixed(1)}<span class="sub">${Math.round(r.linesPerMonth).toLocaleString('en-US')} lines</span></td>
        ${recordShown ? cov : ''}
        <td class="num">${fmtDate(r.lastSubstantiveExplanation)}</td>
      </tr>
      <tr class="why"><td colspan="${recordShown ? 6 : 5}"><p>${esc(explain(r, t, cal))}</p>${r.flagged ? `<p class="action">${esc(ACTION)}</p>` : '<p class="below">Below the line — shown for the gradient, not as a finding.</p>'}</td></tr>`;
    })
    .join('');

  const empty = `<tr><td colspan="${recordShown ? 6 : 5}" class="none">
    No region cleared ${rule.need} of the ${rule.available} available tests with an ownership signal. That is a
    result, not an error — the thresholds are printed below and this repository sits under them.
  </td></tr>`;

  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Git-history risk map — ${esc(report.repo)}</title>
<style>
  :root {
    --bg:#fff; --fg:#16181d; --muted:#5c6270; --line:#e3e6ea; --accent:#8a1c1c;
    --chip:#f1f3f5; --card:#fafbfc;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#14161a; --fg:#e8eaed; --muted:#9aa1ad; --line:#2a2e36; --accent:#ff9d9d;
            --chip:#232830; --card:#191c22; }
  }
  * { box-sizing:border-box }
  body { margin:0; padding:2.5rem 1.25rem 4rem; background:var(--bg); color:var(--fg);
         font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  main { max-width:60rem; margin:0 auto }
  h1 { font-size:1.55rem; margin:0 0 .35rem; letter-spacing:-.01em }
  .meta { color:var(--muted); font-size:.85rem; margin:0 0 1.75rem }
  .meta code { font-size:.85em }
  .lede { font-size:1.02rem; margin:0 0 1.5rem; max-width:46rem }
  .notice { background:var(--card); border:1px solid var(--line); border-left:3px solid var(--accent);
            padding:.85rem 1rem; margin:0 0 1.75rem; font-size:.9rem; border-radius:3px }
  .scroll { overflow-x:auto; -webkit-overflow-scrolling:touch }
  table { border-collapse:collapse; width:100%; min-width:44rem; font-size:.9rem }
  th { text-align:right; font-weight:600; color:var(--muted); font-size:.72rem;
       text-transform:uppercase; letter-spacing:.04em; padding:0 .6rem .5rem; white-space:nowrap }
  th:first-child { text-align:left }
  td { padding:.7rem .6rem; border-top:1px solid var(--line); vertical-align:top }
  td.num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap }
  td.strong { font-weight:600 }
  td.na { color:var(--muted) }
  .sub { display:block; color:var(--muted); font-size:.72rem; font-weight:400 }
  .region code { font-size:.88em; word-break:break-all }
  .chips { margin-top:.3rem }
  .chip { display:inline-block; background:var(--chip); color:var(--muted); border-radius:2px;
          padding:.05rem .35rem; font-size:.68rem; margin-right:.2rem; white-space:nowrap }
  .mark { display:inline-block; margin-left:.4rem; padding:.05rem .35rem; border-radius:2px;
          background:var(--accent); color:var(--bg); font-size:.66rem; font-weight:700;
          text-transform:uppercase; letter-spacing:.04em }
  .mark-concentrated { background:var(--muted) }
  tr.sub-threshold td { opacity:.62 }
  tr.why .below { font-style:italic }
  tr.why td { border-top:0; padding-top:0; color:var(--muted); font-size:.86rem }
  tr.why p { margin:.15rem 0 }
  tr.why .action { color:var(--fg); font-weight:600 }
  td.none { color:var(--muted); padding:1.25rem .6rem }
  footer { margin-top:3rem; padding-top:1.25rem; border-top:1px solid var(--line);
           color:var(--muted); font-size:.82rem }
  footer h2 { font-size:.78rem; text-transform:uppercase; letter-spacing:.05em; color:var(--muted);
              margin:1.5rem 0 .5rem }
  footer ul { margin:.4rem 0; padding-left:1.1rem }
  footer li { margin:.25rem 0 }
  footer code { background:var(--chip); padding:.05rem .25rem; border-radius:2px }
</style>
<main>
  <h1>Two questions about this codebase's ownership</h1>
  <p class="meta">
    <strong>${esc(report.repo)}</strong> · <code>${esc(report.headSha.slice(0, 10))}</code> ·
    ${Math.min(report.windowMonths, Math.round(report.spanMonths))}-month window ending ${fmtDate(report.asOf)} ·
    ${report.commitsKept.toLocaleString('en-US')} commits · ${map.regions.length} regions ·
    generated ${map.generatedAtUtc.slice(0, 10)}
  </p>

  <p class="lede">
    Two separate findings, kept separate because they are different problems.
    <strong>Departed</strong> — the people who wrote this are gone. <strong>Concentrated</strong>
    — one person does all of this. A region can be either, both, or neither.
  </p>
  <p class="lede">
    Every figure comes from this repository's git history and nothing else — no API, no access,
    no installation. Regions are directories. People appear only as counts: this is a map of
    code, and nobody is named anywhere in it, by design.
  </p>

  ${
    squash.availability !== 'available'
      ? `<div class="notice"><strong>Record coverage ${squash.availability === 'unavailable' ? 'is not reported for this repository.' : 'is weak evidence here.'}</strong> ${esc(squash.note)}</div>`
      : ''
  }

  <div class="scroll">
  <table>
    <thead>
      <tr>
        <th>Region</th>
        <th>Orphaned</th>
        <th>Concentration</th>
        <th>Churn / month</th>
        ${recordShown ? '<th>Record coverage</th>' : ''}
        <th>Last explanation</th>
      </tr>
    </thead>
    <tbody>${rows || empty}</tbody>
  </table>
  </div>

  <footer>
    <h2>How to read this</h2>
    <p>
      Five dimensions are shown rather than one risk score. A single number would invite an
      argument about weights and hide the reason a region surfaced; these can each be checked
      against the repository independently. Nothing here is summed or multiplied.
    </p>
    <ul>
      <li><strong>Departed share</strong> — of the files here now, the share whose most recent
        change came from a departed contributor. Departed means no commit <em>anywhere in the
        repository</em> in ${t.inactivityMonths} months <em>and</em> a substantial prior footprint:
        at least ${5} commits spanning at least ${90} days. That second condition matters — on the
        repositories this was calibrated against, roughly 70% of inactive contributors had made
        exactly one commit ever, and counting them as departures turns ordinary drive-by traffic
        into a false alarm.</li>
      <li><strong>Concentration</strong> — share of commits from the single largest contributor.
        High concentration together with a high orphaned share is the bus-factor case.</li>
      <li><strong>Churn</strong> — commits and lines per month over the ${report.spanMonths.toFixed(0)} months of history
        actually observed, not over the configured window. A region nobody
        touches is lower risk than a hot one with the same ownership profile.</li>
      ${recordShown ? `<li><strong>Record coverage</strong> — share of mechanism questions about a change that
        the commit records actually answer, generated and scored by the same instrument used on the
        calibration corpus. <code>p</code> is the position in that corpus.</li>` : ''}
      <li><strong>Last explanation</strong> — the most recent commit here whose message says
        anything beyond its own subject line.</li>
    </ul>

    <h2>Thresholds</h2>
    <p>
      A region is marked <strong>departed</strong> when it is still moving, still exists in the
      tree, and ${pct(t.orphanedShare)} or more of its files were last changed by a departed
      contributor. It is marked <strong>concentrated</strong> when it is still moving, still
      exists, and ${pct(t.concentration)} or more of its changes came from one person. Liveness
      and existence are preconditions for both — a deleted directory has nothing left to
      understand, and dead code is not a risk anyone needs to act on. Churn alone describes a busy region;
      ownership alone describes dead code, which nobody needs to act on. The table below shows
      the top ten regions by rank whether or not they clear the rule, because the gradient is
      more informative than the cut. ${rule.available} of the four dimensions were measurable here.
      They are printed because a reader who disagrees with them should be able to see exactly what
      they were.
    </p>
    <ul>
      <li>orphaned share ≥ ${pct(t.orphanedShare)}</li>
      <li>concentration ≥ ${pct(t.concentration)}</li>
      <li>churn ≥ ${t.commitsPerMonth} commits / month</li>
      ${recordShown ? `<li>record coverage at or below the ${t.coveragePercentile}th percentile of the calibration corpus</li>` : '<li>record coverage — <em>not available for this repository</em></li>'}
    </ul>
    <p>
      Regions are directories cut at <strong>mixed depth</strong>, from the repository root down to
      ${report.regionDepth} levels: the tree is split largest-region-first until no single region
      holds a disproportionate share of the repository, so a big subsystem is broken up while a
      small directory stays whole. This repository resolved to ${map.regions.length} regions.
      Directories with fewer than
      ${t.regionMinCommits} commits are folded into their parent. Directory rather than file
      because renames make file-level history unreliable, and because four hundred cells is a
      screenshot rather than a decision.
    </p>

    <h2>Exclusions</h2>
    <ul>
      <li>Generated, vendored and lockfile paths are removed
        (${report.pathsExcluded.generated?.toLocaleString('en-US') ?? 0} file touches).</li>
      <li>Bot authors — dependabot, renovate, release and CI accounts — are excluded entirely
        (${report.dropped['bot-author'].toLocaleString('en-US')} commits). Left in, they dominate churn.</li>
      <li>Commits touching more than ${t.maxFilesPerCommit} files are excluded from churn and
        authorship (${report.dropped['oversized-commit'].toLocaleString('en-US')} commits). An initial
        import or vendor drop would otherwise make its author look like the owner of everything.</li>
      <li>Migration, fixture, snapshot and locale directories are marked as low-meaning: high churn,
        little mechanism.</li>
      <li>Contributor identities are merged across addresses before anything is counted
        (${report.identitiesBeforeMerge} author records → ${report.identitiesAfterMerge} identities),
        because one person committing under three addresses would otherwise invent a bus factor
        that does not exist.</li>
    </ul>

    <h2>The departure proxy</h2>
    <p>
      <strong>No commits in ${t.inactivityMonths} months is an inference, not a fact.</strong> People
      go on leave, change teams, move to another repository, or commit under an identity this tool
      failed to merge. That is why every figure is aggregated to a region, why the wording is
      inactivity rather than departure, and why no individual is named. Treat a flagged region as a
      question worth asking, not as a personnel finding.
    </p>

    ${
      cal
        ? `<h2>Calibration</h2>
    <p>
      Record coverage is reported as a position against ${cal.n.toLocaleString('en-US')} merged pull
      requests from ${esc(cal.corpus.replace(/^1,000 merged pull requests from /, ''))}, scored with the
      same question generator and rubric.
    </p>
    <p>
      <strong>${(cal.shareAtZero * 100).toFixed(1)}% of that corpus scores exactly zero</strong>, so the
      bottom five deciles are all zero and a "bottom decile" claim would be fiction. Percentiles here
      are midranks, and a value inside the zero mass is reported as tied rather than ranked.
    </p>
    <p>
      Regions of different sizes are compared without normalising, because coverage was measured to be
      flat across a tenfold range of change size — under 3 points of movement, against 25-26 points for
      a measure that does respond to size.
    </p>
    <p>
      One mismatch worth knowing: the corpus scores pull-request records (description plus commit
      messages); this tool scores commit messages only, because a clone is its whole dependency and
      descriptions are not in it. A commit-only record is a subset, so these percentiles are biased
      <em>low</em>. A region that looks fine is fine; a region that looks bad may partly be the missing
      channel.
    </p>`
        : ''
    }
  </footer>
</main>
`;
}

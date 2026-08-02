/**
 * Renders the ReportModel to ONE self-contained HTML file. No build step, no CDN, no chart
 * library: the whole thing is inline CSS and a little SVG, so it opens from a file:// path,
 * survives being emailed around, and cannot break because a script host went away.
 *
 * Colour follows the data-viz method: sequential single-hue blue for magnitude (confidence),
 * a reserved four-step status palette for state, and never a status colour reused as a series.
 * Every status is icon + label + colour, never colour alone, and every chart has a table view
 * underneath it, so nothing here depends on distinguishing hues.
 */
import { FRESH_FLOOR } from '../knowledge/freshness.js';
import type { AreaSummary, DomainProfile, Finding, ReportModel, Severity } from './model.js';

// Sequential blue, light to dark, for continuous magnitude (confidence 0..1).
const SEQ_LIGHT = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];
const SEQ_DARK = ['#0d366b', '#104281', '#184f95', '#1c5cab', '#256abf', '#2a78d6', '#3987e5', '#5598e7', '#6da7ec', '#86b6ef', '#9ec5f4', '#b7d3f6', '#cde2fb'];

const esc = (s: unknown): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const pct = (n: number): string => `${Math.round(n * 100)}%`;

function ago(iso: string | null | undefined, now: Date): string {
  if (!iso) return 'never';
  const d = (now.getTime() - new Date(iso).getTime()) / 86_400_000;
  if (d < 1) return 'today';
  if (d < 2) return 'yesterday';
  if (d < 60) return `${Math.round(d)}d ago`;
  return `${Math.round(d / 30)}mo ago`;
}

/** Index into the sequential ramp. Zero is NOT step 0: an empty cell renders as surface, so
 *  "nobody has explained this" never reads as "explained a little". */
function seqIndex(v: number): number {
  return Math.min(SEQ_LIGHT.length - 1, Math.max(0, Math.round(v * (SEQ_LIGHT.length - 1))));
}

const SEVERITY_META: Record<Severity, { icon: string; label: string }> = {
  critical: { icon: '■', label: 'Critical' },
  serious: { icon: '◆', label: 'Serious' },
  warning: { icon: '▲', label: 'Warning' },
  ok: { icon: '●', label: 'OK' },
};

function statTile(value: string, label: string, sub?: string): string {
  return `<div class="tile"><div class="tile-v">${esc(value)}</div><div class="tile-l">${esc(label)}</div>${sub ? `<div class="tile-s">${esc(sub)}</div>` : ''}</div>`;
}

// ── Sections ───────────────────────────────────────────────────────────────────────────────

function renderHealth(findings: Finding[]): string {
  const rows = findings.map((f) => {
    const m = SEVERITY_META[f.severity];
    return `<li class="finding sev-${f.severity}">
      <div class="finding-head"><span class="sev-badge" aria-hidden="true">${m.icon}</span><span class="sev-name">${m.label}</span><span class="finding-title">${esc(f.title)}</span>${f.count ? `<span class="finding-count">${f.count}</span>` : ''}</div>
      <p class="finding-detail">${esc(f.detail)}</p>
      ${f.fix ? `<p class="finding-fix"><span class="fix-label">Fix</span> ${esc(f.fix)}</p>` : ''}
    </li>`;
  }).join('');
  const worst = findings[0]?.severity ?? 'ok';
  return `<section id="health">
    <h2>Collection health</h2>
    <p class="lede">Derived checks only. A dropped write leaves no error row anywhere, so the way to find one after the fact is to look for its shadow in the data that did land: a passed gate with no record, a passing explanation on a gate that never opened, a record whose owner has no identity.</p>
    <div class="banner sev-${worst}"><span aria-hidden="true">${SEVERITY_META[worst as Severity].icon}</span> ${findings.length === 1 && worst === 'ok' ? 'All checks passed' : `${findings.length} finding${findings.length === 1 ? '' : 's'}, worst severity ${SEVERITY_META[worst as Severity].label.toLowerCase()}`}</div>
    <ul class="findings">${rows}</ul>
  </section>`;
}

function renderFunnel(m: ReportModel): string {
  const f = m.funnel;
  const stages = [
    { label: 'PRs seen', n: f.seen, hint: 'every PR head Reckon reached a decision on' },
    { label: 'Gated', n: f.gated, hint: 'opened a comprehension gate' },
    { label: 'Answered', n: f.answered, hint: 'at least one explanation arrived' },
    { label: 'Passed', n: f.passed, hint: 'gate cleared' },
  ];
  const max = Math.max(1, ...stages.map((s) => s.n));
  const bars = stages.map((s, i) => `
    <div class="fun-row" title="${esc(s.hint)}">
      <div class="fun-label">${esc(s.label)}</div>
      <div class="fun-track"><div class="fun-bar step-${i}" style="width:${Math.max(1.5, (s.n / max) * 100)}%"></div></div>
      <div class="fun-n">${s.n}</div>
      <div class="fun-rate">${(() => {
        if (i === 0) return '';
        const prev = stages[i - 1].n;
        if (!prev) return '';
        // A stage can only exceed the one above it if a row is missing upstream, which is a
        // data-integrity finding, not a conversion rate. Say so rather than printing "633%".
        if (s.n > prev) return `<span class="warn">exceeds previous, see health</span>`;
        return `${pct(s.n / prev)} of previous`;
      })()}</div>
    </div>`).join('');

  const skips = f.skipReasons.length
    ? `<table class="tbl"><caption>Why a PR was not gated</caption><thead><tr><th>Reason</th><th class="num">Count</th></tr></thead><tbody>${
        f.skipReasons.map((r) => `<tr><td>${esc(r.reason)}</td><td class="num">${r.n}</td></tr>`).join('')}</tbody></table>`
    : `<p class="empty">No skip reasons recorded yet. Until skipped PRs are written, "PRs seen" counts only gates and the funnel has no real denominator.</p>`;

  return `<section id="funnel">
    <h2>Usage funnel</h2>
    <p class="lede">Each stage is a subset of the one above it. The drop from seen to gated is policy working as intended; the drop from gated to answered is people ignoring the gate, which is the number that matters.</p>
    <div class="funnel">${bars}</div>
    ${skips}
  </section>`;
}

function renderAreaMap(areas: AreaSummary[], now: Date): string {
  if (!areas.length) {
    return `<section id="map"><h2>Knowledge map</h2><p class="empty">No areas yet. An area appears once a PR touches it or someone explains it.</p></section>`;
  }
  const cards = areas.map((a) => {
    const names = a.fresh.length ? a.fresh.map((p) => esc(p.login)).join(', ') : 'nobody, currently';
    return `<article class="card tone-${a.statusTone}" title="${esc(a.repo)} / ${esc(a.label)}">
      <header>
        <span class="card-status" aria-hidden="true">${a.statusIcon}</span>
        <h3>${esc(a.label)}</h3>
        <span class="card-repo">${esc(a.repo)}</span>
      </header>
      <div class="card-status-label">${esc(a.statusLabel)}</div>
      <div class="meter" role="img" aria-label="team confidence ${pct(a.teamConfidence)}">
        <div class="meter-fill" style="width:${Math.round(a.teamConfidence * 100)}%"></div>
        <div class="meter-floor" style="left:${Math.round(FRESH_FLOOR * 100)}%" title="freshness floor"></div>
      </div>
      <dl>
        <div><dt>Holds it now</dt><dd>${names}</dd></div>
        <div><dt>Ever explained</dt><dd>${a.demos} demonstration${a.demos === 1 ? '' : 's'} by ${a.people.length} ${a.people.length === 1 ? 'person' : 'people'}</dd></div>
        <div><dt>Changes</dt><dd>${a.changes} total, ${a.changes30d} in 30d</dd></div>
        <div><dt>Last explained</dt><dd>${ago(a.lastDemoAt, now)}</dd></div>
        <div><dt>Last changed</dt><dd>${ago(a.lastChangeAt, now)}</dd></div>
      </dl>
    </article>`;
  }).join('');

  const table = `<details><summary>Table view</summary><table class="tbl"><thead><tr>
      <th>Repo</th><th>Area</th><th>Status</th><th class="num">Confidence</th><th class="num">Fresh holders</th><th class="num">Demos</th><th class="num">Changes</th><th>Last explained</th><th>Last changed</th></tr></thead><tbody>${
    areas.map((a) => `<tr><td>${esc(a.repo)}</td><td>${esc(a.label)}</td><td>${a.statusIcon} ${esc(a.statusLabel)}</td><td class="num">${pct(a.teamConfidence)}</td><td class="num">${a.fresh.length}</td><td class="num">${a.demos}</td><td class="num">${a.changes}</td><td>${ago(a.lastDemoAt, now)}</td><td>${ago(a.lastChangeAt, now)}</td></tr>`).join('')
  }</tbody></table></details>`;

  return `<section id="map">
    <h2>Knowledge map: which parts are demonstrably understood</h2>
    <p class="lede">One card per subsystem, worst first. The bar is the strongest current understanding anyone holds, after decay; the notch is the floor below which we stop counting it. "Unexplained" means the area has been changed and never explained by anyone, which is the real gap.</p>
    <div class="legend">${['covered', 'single-point', 'stale', 'unexplained'].map((k) => {
      const s = areas.find((a) => a.status === k);
      const meta = { covered: ['●', 'good', 'Covered', 'two or more people hold current understanding'], 'single-point': ['▲', 'warning', 'Single point', 'exactly one person holds it'], stale: ['◆', 'serious', 'Stale', 'explained before, but time passed or the code moved'], unexplained: ['■', 'critical', 'Unexplained', 'changed here, never explained'] }[k]!;
      return `<span class="legend-item tone-${meta[1]}"><span class="legend-mark" aria-hidden="true">${meta[0]}</span>${meta[2]}<span class="legend-hint">${meta[3]}</span>${s ? '' : ''}</span>`;
    }).join('')}</div>
    <div class="cards">${cards}</div>
    ${table}
  </section>`;
}

function renderMatrix(areas: AreaSummary[], now: Date): string {
  const people = new Map<number, string>();
  for (const a of areas) for (const p of a.people) people.set(p.githubId, p.login);
  if (!people.size) {
    return `<section id="who"><h2>Who understands what</h2><p class="empty">No demonstrations yet.</p></section>`;
  }
  const ids = [...people.keys()];
  const shown = areas.filter((a) => a.people.length > 0);

  const head = `<tr><th class="rowhead">Area</th>${ids.map((id) => `<th class="colhead"><span>${esc(people.get(id))}</span></th>`).join('')}</tr>`;
  const body = shown.map((a) => {
    const cells = ids.map((id) => {
      const p = a.people.find((x) => x.githubId === id);
      if (!p) return `<td class="cell empty-cell" title="${esc(a.label)}: no demonstration by ${esc(people.get(id))}"></td>`;
      const i = seqIndex(p.confidence);
      const strong = p.confidence >= 0.62; // ink flips to light well before the ramp gets dark
      // Reference the ramp slot by variable, not by hex, so the cell re-steps itself for the
      // dark surface when the theme flips without any script running.
      return `<td class="cell" style="background:var(--seq-${i})" data-strong="${strong}" title="${esc(people.get(id))} on ${esc(a.label)}: confidence ${pct(p.confidence)}, ${p.demos} demonstration(s), best verdict ${esc(p.bestVerdict ?? 'unrecorded')}, last ${ago(p.lastAt, now)}">${pct(p.confidence)}</td>`;
    }).join('');
    return `<tr><th class="rowhead">${esc(a.label)}<span class="rowhead-repo">${esc(a.repo)}</span></th>${cells}</tr>`;
  }).join('');

  return `<section id="who">
    <h2>Who understands what</h2>
    <p class="lede">Confidence is the strongest demonstration a person has in that area, discounted twice: by age, and by how many substantive changes have landed there since they explained it. Blank means no demonstration at all, which is different from a low score.</p>
    <div class="scroll-x"><table class="matrix">${head}${body}</table></div>
    <div class="ramp"><span>0%</span><div class="ramp-bar"></div><span>100%</span><span class="ramp-note">sequential, one hue, light to dark</span></div>
  </section>`;
}

function renderProfiles(profiles: DomainProfile[], now: Date): string {
  const withDomains = profiles.filter((p) => p.domains.length);
  if (!withDomains.length) {
    return `<section id="domains"><h2>Knowledge domains</h2><p class="empty">No domain tags yet. Tags are written at closeout time, so they appear on gates passed after this shipped.</p></section>`;
  }
  const blocks = withDomains.map((p) => {
    const bars = p.domains.map((d) => `
      <div class="dom-row" title="${esc(d.label)}: ${d.n} demonstration(s), current confidence ${pct(d.confidence)}">
        <div class="dom-label">${esc(d.label)}</div>
        <div class="dom-track"><div class="dom-bar" style="width:${Math.max(2, d.confidence * 100)}%"></div></div>
        <div class="dom-n">${d.n}x</div>
        <div class="dom-c">${pct(d.confidence)}</div>
      </div>`).join('');
    return `<article class="profile">
      <header><h3>${esc(p.login)}</h3><span class="profile-meta">${p.total} demonstration${p.total === 1 ? '' : 's'} across ${p.areas} area${p.areas === 1 ? '' : 's'} and ${p.repos} repo${p.repos === 1 ? '' : 's'}, last ${ago(p.lastAt, now)}</span></header>
      <div class="doms">${bars}</div>
    </article>`;
  }).join('');
  return `<section id="domains">
    <h2>Knowledge domains, per person</h2>
    <p class="lede">The portable axis. An area says which box of one codebase someone understands; a domain says what kind of understanding it was, in vocabulary that means the same thing in any repo. Bar length is current confidence, after the same age and drift decay used everywhere else; the count beside it is how many demonstrations back it.</p>
    <div class="profiles">${blocks}</div>
  </section>`;
}

function renderScope(m: ReportModel, now: Date): string {
  const s = m.snapshot;
  const tiles = [
    statTile(String(s.installations.length), 'Installations'),
    statTile(String(s.repos.length), 'Repos'),
    statTile(String(s.checkpoints.length), 'PR outcomes'),
    statTile(String(s.attempts.length), 'Explanations'),
    statTile(String(s.demonstrations.length), 'Demonstrations'),
    statTile(String(s.users.length), 'People'),
    statTile(String(s.mcpEvents.length), 'Dev-time events', 'from reckon-mcp'),
  ].join('');
  return `<section id="scope">
    <h2>What is in the database</h2>
    <div class="tiles">${tiles}</div>
    <p class="foot">Snapshot taken ${esc(now.toISOString().replace('T', ' ').slice(0, 16))} UTC.</p>
  </section>`;
}

// ── Page ───────────────────────────────────────────────────────────────────────────────────

export function renderReport(m: ReportModel): string {
  const now = new Date(m.generatedAt);
  const seqVars = (arr: string[]): string => arr.map((c, i) => `--seq-${i}:${c};`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reckon: knowledge map and collection health</title>
<style>
:root {
  color-scheme: light;
  --plane:#f9f9f7; --surface:#fcfcfb;
  --ink:#0b0b0b; --ink-2:#52514e; --muted:#898781;
  --grid:#e1e0d9; --axis:#c3c2b7; --ring:rgba(11,11,11,0.10);
  --good:#0ca30c; --warning:#fab219; --serious:#ec835a; --critical:#d03b3b;
  --step-0:#86b6ef; --step-1:#5598e7; --step-2:#2a78d6; --step-3:#1c5cab;
  --cell-ink:#0b0b0b; --cell-ink-strong:#ffffff;
  ${seqVars(SEQ_LIGHT)}
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    color-scheme: dark;
    --plane:#0d0d0d; --surface:#1a1a19;
    --ink:#ffffff; --ink-2:#c3c2b7; --muted:#898781;
    --grid:#2c2c2a; --axis:#383835; --ring:rgba(255,255,255,0.10);
    --step-0:#9ec5f4; --step-1:#6da7ec; --step-2:#3987e5; --step-3:#256abf;
    --cell-ink:#ffffff; --cell-ink-strong:#0b0b0b;
    ${seqVars(SEQ_DARK)}
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --plane:#0d0d0d; --surface:#1a1a19;
  --ink:#ffffff; --ink-2:#c3c2b7; --muted:#898781;
  --grid:#2c2c2a; --axis:#383835; --ring:rgba(255,255,255,0.10);
  --step-0:#9ec5f4; --step-1:#6da7ec; --step-2:#3987e5; --step-3:#256abf;
  --cell-ink:#ffffff; --cell-ink-strong:#0b0b0b;
  ${seqVars(SEQ_DARK)}
}
* { box-sizing:border-box; }
body { margin:0; background:var(--plane); color:var(--ink);
  font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; }
.wrap { max-width:1120px; margin:0 auto; padding:32px 20px 80px; }
h1 { font-size:26px; margin:0 0 4px; letter-spacing:-0.01em; }
h2 { font-size:19px; margin:0 0 6px; letter-spacing:-0.01em; }
h3 { font-size:14px; margin:0; }
.sub { color:var(--ink-2); margin:0 0 28px; max-width:70ch; }
.lede { color:var(--ink-2); margin:0 0 16px; max-width:78ch; }
.empty { color:var(--muted); font-style:italic; }
section { background:var(--surface); border:1px solid var(--ring); border-radius:10px;
  padding:20px; margin-bottom:20px; }
.scroll-x { overflow-x:auto; }

/* tiles */
.tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; }
.tile { border:1px solid var(--ring); border-radius:8px; padding:12px; }
.tile-v { font-size:24px; font-weight:600; letter-spacing:-0.02em; }
.tile-l { color:var(--ink-2); font-size:12px; }
.tile-s { color:var(--muted); font-size:11px; }
.foot { color:var(--muted); font-size:12px; margin:12px 0 0; }

/* status tones: colour is always paired with an icon and a word */
.tone-good { --tone:var(--good); } .tone-warning { --tone:var(--warning); }
.tone-serious { --tone:var(--serious); } .tone-critical { --tone:var(--critical); }
.sev-critical { --tone:var(--critical); } .sev-serious { --tone:var(--serious); }
.sev-warning { --tone:var(--warning); } .sev-ok { --tone:var(--good); }

.banner { display:inline-flex; align-items:center; gap:8px; border:1px solid var(--tone);
  border-left:4px solid var(--tone); border-radius:6px; padding:8px 12px; margin-bottom:14px;
  font-weight:600; font-size:13px; }
.banner span { color:var(--tone); }
.findings { list-style:none; margin:0; padding:0; display:grid; gap:10px; }
.finding { border:1px solid var(--ring); border-left:4px solid var(--tone); border-radius:6px; padding:12px 14px; }
.finding-head { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; }
.sev-badge { color:var(--tone); }
.sev-name { color:var(--tone); font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; }
.finding-title { font-weight:600; }
.finding-count { margin-left:auto; font-variant-numeric:tabular-nums; color:var(--ink-2);
  border:1px solid var(--ring); border-radius:99px; padding:1px 9px; font-size:12px; }
.finding-detail { margin:6px 0 0; color:var(--ink-2); }
.finding-fix { margin:6px 0 0; color:var(--ink-2); font-size:13px; }
.fix-label { font-size:10px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase;
  color:var(--muted); border:1px solid var(--ring); border-radius:3px; padding:1px 5px; margin-right:6px; }

/* funnel: ordinal ramp, one hue */
.funnel { display:grid; gap:8px; margin-bottom:18px; }
.fun-row { display:grid; grid-template-columns:110px 1fr 56px 130px; align-items:center; gap:10px; }
.fun-label { color:var(--ink-2); font-size:13px; }
.fun-track { background:var(--grid); border-radius:4px; height:22px; }
.fun-bar { height:22px; border-radius:4px; }
.fun-bar.step-0 { background:var(--step-0); } .fun-bar.step-1 { background:var(--step-1); }
.fun-bar.step-2 { background:var(--step-2); } .fun-bar.step-3 { background:var(--step-3); }
.fun-n { font-variant-numeric:tabular-nums; font-weight:600; text-align:right; }
.fun-rate { color:var(--muted); font-size:12px; }
.fun-rate .warn { color:var(--serious); }

/* area cards */
.legend { display:grid; grid-template-columns:repeat(auto-fit,minmax(250px,1fr)); gap:6px 18px; margin-bottom:16px; }
.legend-item { display:flex; align-items:baseline; gap:6px; font-size:12px; color:var(--ink-2); }
.legend-mark { color:var(--tone); }
.legend-hint { color:var(--muted); font-size:11px; }
.legend-hint::before { content:"— "; }
.cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(268px,1fr)); gap:12px; margin-bottom:16px; }
.card { border:1px solid var(--ring); border-top:3px solid var(--tone); border-radius:8px; padding:14px; }
.card header { display:flex; align-items:baseline; gap:7px; }
.card-status { color:var(--tone); }
.card-repo { margin-left:auto; color:var(--muted); font-size:11px; }
.card-status-label { color:var(--tone); font-size:11px; font-weight:700; text-transform:uppercase;
  letter-spacing:0.06em; margin:2px 0 10px; }
.meter { position:relative; background:var(--grid); border-radius:4px; height:8px; margin-bottom:12px; }
.meter-fill { background:var(--seq-8); height:8px; border-radius:4px; }
.meter-floor { position:absolute; top:-3px; width:2px; height:14px; background:var(--axis); }
.card dl { margin:0; display:grid; gap:4px; }
.card dl > div { display:flex; gap:8px; font-size:12px; }
.card dt { color:var(--muted); min-width:104px; }
.card dd { margin:0; color:var(--ink-2); }

/* matrix: sequential magnitude */
.matrix { border-collapse:separate; border-spacing:2px; }
.matrix th { font-weight:500; font-size:12px; color:var(--ink-2); text-align:left; }
.matrix .colhead { vertical-align:bottom; padding:0 0 6px; }
.matrix .colhead span { display:inline-block; white-space:nowrap; }
.matrix .rowhead { padding-right:12px; white-space:nowrap; }
.rowhead-repo { display:block; color:var(--muted); font-size:10px; }
.cell { width:62px; height:34px; text-align:center; border-radius:4px;
  font-variant-numeric:tabular-nums; font-size:12px; color:var(--cell-ink); }
/* The dark ramp runs the other way (bright = high on a dark surface), so the ink that stays
   legible on a high-confidence cell inverts with the theme rather than being fixed white. */
.cell[data-strong="true"] { color:var(--cell-ink-strong); }
.empty-cell { background:transparent; border:1px dashed var(--grid); }
.ramp { display:flex; align-items:center; gap:8px; margin-top:12px; color:var(--muted); font-size:11px; }
.ramp-bar { width:180px; height:10px; border-radius:3px;
  background:linear-gradient(90deg,var(--seq-0),var(--seq-4),var(--seq-8),var(--seq-12)); }
.ramp-note { margin-left:4px; }

/* domain profiles */
.profiles { display:grid; gap:14px; }
.profile { border:1px solid var(--ring); border-radius:8px; padding:14px; }
.profile header { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; margin-bottom:10px; }
.profile-meta { color:var(--muted); font-size:12px; }
.dom-row { display:grid; grid-template-columns:190px 1fr 34px 46px; align-items:center; gap:10px; margin-bottom:5px; }
.dom-label { font-size:12px; color:var(--ink-2); }
.dom-track { background:var(--grid); border-radius:4px; height:14px; }
.dom-bar { background:var(--seq-7); height:14px; border-radius:4px; }
.dom-n, .dom-c { font-variant-numeric:tabular-nums; font-size:12px; text-align:right; color:var(--ink-2); }

/* tables */
.tbl { border-collapse:collapse; width:100%; font-size:12px; margin-top:8px; }
.tbl caption { text-align:left; color:var(--muted); font-size:12px; padding-bottom:6px; }
.tbl th, .tbl td { border-bottom:1px solid var(--grid); padding:6px 10px 6px 0; text-align:left; }
.tbl th { color:var(--muted); font-weight:500; }
.tbl .num { text-align:right; font-variant-numeric:tabular-nums; }
details { margin-top:10px; } summary { cursor:pointer; color:var(--ink-2); font-size:13px; }
[title] { cursor:help; }
@media (max-width:640px) {
  .fun-row { grid-template-columns:88px 1fr 44px; } .fun-rate { display:none; }
  .dom-row { grid-template-columns:130px 1fr 30px 42px; }
}
</style>
</head>
<body>
<div class="wrap">
<h1>Reckon: knowledge map and collection health</h1>
<p class="sub">Two questions in one page. Is the pipeline collecting what we think it is, and given what it collected, who demonstrably understands which part of the codebase, and how stale is that.</p>
${renderHealth(m.findings)}
${renderScope(m, now)}
${renderFunnel(m)}
${renderAreaMap(m.areas, now)}
${renderMatrix(m.areas, now)}
${renderProfiles(m.profiles, now)}
</div>
</body>
</html>`;
}

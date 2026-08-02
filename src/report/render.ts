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
import { layout, type LayoutNode } from './layout.js';
import { commitUrl, prUrl } from './links.js';
import type { Architecture, AreaSummary, DomainProfile, Finding, ReportModel, Severity } from './model.js';

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

/** An anchor, or plain text when there is no URL to point at. A dead link is worse than none. */
function link(url: string | null, text: string, cls = '', title = ''): string {
  const inner = esc(text);
  return url
    ? `<a href="${esc(url)}" class="${cls}" target="_blank" rel="noopener noreferrer"${title ? ` title="${esc(title)}"` : ''}>${inner}</a>`
    : `<span class="${cls}"${title ? ` title="${esc(title)}"` : ''}>${inner}</span>`;
}

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
      ${f.refs && f.refs.length ? (() => {
        const multiRepo = new Set(f.refs!.map((r) => r.repo)).size > 1;
        return `<p class="finding-refs"><span class="refs-label">Where</span> ${
          f.refs!.map((r) => link(prUrl(r.repo, r.pr), multiRepo ? `${r.repo.split('/')[1] ?? r.repo} ${r.label}` : r.label, 'ref', `${r.repo}#${r.pr}`)).join(' ')
        }${f.refsOmitted ? ` <span class="ref-more">and ${f.refsOmitted} more</span>` : ''}</p>`;
      })() : ''}
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
      ${a.evidence.length ? `<details class="evidence">
        <summary>${a.evidence.length} demonstration${a.evidence.length === 1 ? '' : 's'}</summary>
        <ul>${a.evidence.map((e) => `<li>
          <span class="ev-who">${esc(e.login)}</span>
          <span class="ev-verdict v-${esc(e.verdict ?? 'none')}">${esc(e.verdict ?? 'unverdicted')}</span>
          <span class="ev-concept" title="${esc(e.note || e.concept)}">${esc(e.concept)}</span>
          <span class="ev-when">${ago(e.at, now)}</span>
          ${link(prUrl(e.repo, e.pr), e.pr ? `#${e.pr}` : 'no PR recorded', 'ev-pr', e.pr ? `open ${e.repo}#${e.pr}` : 'this row predates provenance recording')}
        </li>`).join('')}</ul>
      </details>` : ''}
    </article>`;
  }).join('');

  const table = `<details><summary>Table view</summary><table class="tbl"><thead><tr>
      <th>Repo</th><th>Area</th><th>Status</th><th class="num">Confidence</th><th class="num">Fresh holders</th><th class="num">Demos</th><th class="num">Changes</th><th>Last explained</th><th>Last changed</th></tr></thead><tbody>${
    areas.map((a) => `<tr><td>${esc(a.repo)}</td><td>${esc(a.label)}</td><td>${a.statusIcon} ${esc(a.statusLabel)}</td><td class="num">${pct(a.teamConfidence)}</td><td class="num">${a.fresh.length}</td><td class="num">${a.demos}</td><td class="num">${a.changes}</td><td>${ago(a.lastDemoAt, now)}</td><td>${ago(a.lastChangeAt, now)}</td></tr>`).join('')
  }</tbody></table></details>`;

  // Demoted to a collapsed list. The diagram plus its panel now answers the same questions with
  // the dependency context attached, so a wall of 16 cards competing with it was noise. It stays
  // because it is the no-script, no-colour fallback and the only place every area is legible at
  // once, but it is no longer what the reader meets first.
  return `<section id="map">
    <h2>All subsystems, as a list</h2>
    <p class="lede">The same data as the diagram, flattened and sorted worst first. The bar is the strongest current understanding anyone holds, after decay; the notch is the floor below which we stop counting it.</p>
    <details class="list-view">
    <summary>${areas.length} subsystem${areas.length === 1 ? '' : 's'} across ${new Set(areas.map((a) => a.repo)).size} repo${new Set(areas.map((a) => a.repo)).size === 1 ? '' : 's'}</summary>
    <div class="legend">${['covered', 'single-point', 'stale', 'unexplained'].map((k) => {
      const s = areas.find((a) => a.status === k);
      const meta = { covered: ['●', 'good', 'Covered', 'two or more people hold current understanding'], 'single-point': ['▲', 'warning', 'Single point', 'exactly one person holds it'], stale: ['◆', 'serious', 'Stale', 'explained before, but time passed or the code moved'], unexplained: ['■', 'critical', 'Unexplained', 'changed here, never explained'] }[k]!;
      return `<span class="legend-item tone-${meta[1]}"><span class="legend-mark" aria-hidden="true">${meta[0]}</span>${meta[2]}<span class="legend-hint">${meta[3]}</span>${s ? '' : ''}</span>`;
    }).join('')}</div>
    <div class="cards">${cards}</div>
    ${table}
    </details>
  </section>`;
}


/**
 * THE ARCHITECTURE DIAGRAM: the codebase graph we already build on every gate, laid out as a
 * dependency stack with the knowledge map painted onto it.
 *
 * This is the page's headline, not an appendix, so it renders first and gets the real estate.
 * A list can say "Persistence is stale". Only this can say "Persistence is stale AND five other
 * subsystems sit on top of it", which is the sentence that makes someone act.
 *
 * Reading order is built into the layout: layer 0 is the bottom, so every arrow points DOWN into
 * what it depends on, and the foundations of the codebase are literally the foundation of the
 * picture. Box colour is comprehension status, box size is how much of the codebase it is, and
 * edge weight is how many symbols cross the boundary.
 *
 * Interaction is the point. A static 20-node graph is unreadable no matter how it is laid out,
 * so: hover isolates a subsystem and its immediate neighbours, click pins that and opens a panel
 * with the receipts, and the legend doubles as a filter. All of it is progressive enhancement,
 * plain CSS classes toggled by a small inline script; with scripting off the full graph and the
 * table view are both still there.
 *
 * Composite encoding throughout: status is colour AND an icon AND a word, so nothing depends on
 * telling two hues apart.
 */
function pathFor(points: { x: number; y: number }[]): string {
  if (points.length < 2) return '';
  if (points.length === 2) {
    // A direct edge: a vertical-tangent cubic, so it leaves and arrives square to the boxes
    // rather than at an angle that reads as pointing somewhere else.
    const [a, b] = points;
    const dy = Math.max(18, (b.y - a.y) * 0.45);
    return `M${a.x},${a.y} C${a.x},${a.y + dy} ${b.x},${b.y - dy} ${b.x},${b.y}`;
  }
  // A routed edge: smooth through its waypoints (Catmull-Rom converted to cubics) so a long
  // dependency curves cleanly around the layers it skips.
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ` C${c1.x.toFixed(1)},${c1.y.toFixed(1)} ${c2.x.toFixed(1)},${c2.y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

function renderDiagram(arch: Architecture, areas: AreaSummary[], now: Date, idx: number): string {
  const byKey = new Map(areas.filter((a) => a.repo === arch.repo).map((a) => [a.key, a]));
  const uid = `arch${idx}`;
  const maxRank = Math.max(1e-9, ...arch.nodes.map((n) => n.rank));

  const labelOf = (k: string): string => byKey.get(k)?.label ?? k;

  const nodes: LayoutNode[] = arch.nodes.map((n) => {
    const label = labelOf(n.area);
    // Width follows the label so text never overflows. Height follows importance, so the
    // load-bearing subsystems are visibly bigger without the type shrinking with them.
    const w = Math.min(186, Math.max(116, label.length * 7.0 + 30));
    const h = 48 + Math.round((n.rank / maxRank) * 20);
    return { id: n.area, w, h };
  });
  const L = layout(nodes, arch.edges);
  const placed = new Map(L.nodes.map((p) => [p.id, p]));
  const maxW = Math.max(1, ...arch.edges.map((e) => e.weight));

  const edgeSvg = L.edges.map((e) => {
    const strength = e.weight / maxW;
    const tip = `${labelOf(e.from)} depends on ${labelOf(e.to)} (${e.weight} symbol${e.weight === 1 ? '' : 's'})${e.cyclic ? ', part of an import cycle' : ''}`;
    return `<path d="${pathFor(e.points)}" class="dep${e.cyclic ? ' dep-cyclic' : ''}"
      data-from="${esc(e.from)}" data-to="${esc(e.to)}"
      stroke-width="${(1.1 + strength * 2.6).toFixed(2)}"
      marker-end="url(#${uid}-arrow)"><title>${esc(tip)}</title></path>`;
  }).join('');

  const nodeSvg = arch.nodes.map((n) => {
    const p = placed.get(n.area)!;
    const a = byKey.get(n.area);
    const label = labelOf(n.area);
    const tone = a?.statusTone ?? 'critical';
    const holders = a?.fresh.length ? a.fresh.map((f) => f.login).join(', ') : 'nobody currently';
    return `<g class="gnode tone-${tone}" data-id="${esc(n.area)}" tabindex="0" role="button"
        aria-label="${esc(`${label}: ${a?.statusLabel ?? 'Unexplained'}, held by ${holders}`)}"
        transform="translate(${p.x - p.w / 2},${p.y - p.h / 2})">
      <rect class="gnode-box" width="${p.w}" height="${p.h}" rx="9"/>
      <rect class="gnode-accent" width="4" height="${p.h}" rx="2"/>
      <text class="gnode-label" x="${p.w / 2}" y="${p.h / 2 - 3}">${esc(label)}</text>
      <text class="gnode-sub" x="${p.w / 2}" y="${p.h / 2 + 14}">${a?.statusIcon ?? '■'} ${esc(a?.statusLabel ?? 'Unexplained')}</text>
    </g>`;
  }).join('');

  // Detail panels are pre-rendered and hidden, so the script only toggles a class. Nothing is
  // built from strings at runtime, which keeps every value escaped here at render time.
  const panels = arch.nodes.map((n) => {
    const a = byKey.get(n.area);
    const dependsOn = arch.edges.filter((e) => e.from === n.area).sort((x, y) => y.weight - x.weight);
    const usedBy = arch.edges.filter((e) => e.to === n.area).sort((x, y) => y.weight - x.weight);
    const chips = (list: typeof dependsOn, dir: 'to' | 'from'): string =>
      list.length
        ? list.map((e) => `<button class="nav-chip" data-goto="${esc(dir === 'to' ? e.to : e.from)}">${esc(labelOf(dir === 'to' ? e.to : e.from))}<span>${e.weight}</span></button>`).join('')
        : '<span class="empty">none</span>';

    return `<div class="panel-body" data-panel="${esc(n.area)}" hidden>
      <header class="tone-${a?.statusTone ?? 'critical'}">
        <h4>${esc(labelOf(n.area))}</h4>
        <span class="panel-status">${a?.statusIcon ?? '■'} ${esc(a?.statusLabel ?? 'Unexplained')}</span>
      </header>
      <dl class="panel-stats">
        <div><dt>Holds it now</dt><dd>${a?.fresh.length ? a.fresh.map((f) => esc(f.login)).join(', ') : '<span class="empty">nobody</span>'}</dd></div>
        <div><dt>Size</dt><dd>${n.files} file${n.files === 1 ? '' : 's'}, ${n.defs} symbol${n.defs === 1 ? '' : 's'}</dd></div>
        <div><dt>Depended on by</dt><dd>${n.fanIn} file${n.fanIn === 1 ? '' : 's'} outside it</dd></div>
        <div><dt>Changes</dt><dd>${a?.changes ?? 0} total, ${a?.changes30d ?? 0} in 30d</dd></div>
        <div><dt>Last explained</dt><dd>${ago(a?.lastDemoAt, now)}</dd></div>
      </dl>
      <div class="panel-nav">
        <div><span class="nav-label">Depends on</span><div class="chips">${chips(dependsOn, 'to')}</div></div>
        <div><span class="nav-label">Used by</span><div class="chips">${chips(usedBy, 'from')}</div></div>
      </div>
      ${a?.evidence.length ? `<div class="panel-ev"><span class="nav-label">Demonstrations</span><ul>${
        a.evidence.map((e) => `<li>
          <span class="ev-who">${esc(e.login)}</span>
          <span class="ev-verdict v-${esc(e.verdict ?? 'none')}">${esc(e.verdict ?? 'unverdicted')}</span>
          <span class="ev-concept" title="${esc(e.note || e.concept)}">${esc(e.concept)}</span>
          <span class="ev-when">${ago(e.at, now)}</span>
          ${link(prUrl(e.repo, e.pr), e.pr ? `#${e.pr}` : 'no PR', 'ev-pr', e.pr ? `open ${e.repo}#${e.pr}` : 'predates provenance recording')}
        </li>`).join('')}</ul></div>`
        : `<p class="panel-none">Nobody has explained this subsystem. ${n.fanIn > 0 ? `${n.fanIn} file${n.fanIn === 1 ? '' : 's'} outside it depend${n.fanIn === 1 ? 's' : ''} on it.` : ''}</p>`}
    </div>`;
  }).join('');

  // The counts the legend filters by, so a filter with nothing behind it reads as empty rather
  // than looking broken.
  const counts = { covered: 0, 'single-point': 0, stale: 0, unexplained: 0 } as Record<string, number>;
  for (const n of arch.nodes) counts[byKey.get(n.area)?.status ?? 'unexplained']++;
  const LEGEND: [string, string, string, string][] = [
    ['unexplained', 'critical', '■', 'Unexplained'],
    ['stale', 'serious', '◆', 'Stale'],
    ['single-point', 'warning', '▲', 'Single point'],
    ['covered', 'good', '●', 'Covered'],
  ];

  return `<figure class="diagram" id="${uid}">
    <figcaption>
      <span class="diag-repo">${esc(arch.repo)}</span>
      <span class="diag-meta">${arch.nodes.length} subsystems, ${arch.edges.length} dependencies, ${L.layers} layers deep, from the graph built at ${link(commitUrl(arch.repo, arch.headSha), arch.headSha.slice(0, 7), 'sha', `open commit ${arch.headSha.slice(0, 7)}`)}</span>
    </figcaption>

    <div class="diag-toolbar">
      <div class="filters" role="group" aria-label="Filter subsystems by comprehension status">
        ${LEGEND.map(([key, tone, icon, label]) => `<button class="filter tone-${tone}" data-filter="${key}" aria-pressed="false" ${counts[key] ? '' : 'disabled'}>
          <span class="filter-mark" aria-hidden="true">${icon}</span>${label}<span class="filter-n">${counts[key]}</span>
        </button>`).join('')}
      </div>
      <div class="zoom" role="group" aria-label="Zoom">
        <button data-zoom="out" aria-label="Zoom out">&minus;</button>
        <button data-zoom="fit" aria-label="Fit to width">Fit</button>
        <button data-zoom="in" aria-label="Zoom in">+</button>
      </div>
    </div>

    <div class="diag-body">
      <div class="diag-canvas" tabindex="0">
        <svg viewBox="0 0 ${L.width} ${L.height}" width="${L.width}" height="${L.height}" role="img"
          aria-label="Dependency stack of ${esc(arch.repo)}: ${arch.nodes.length} subsystems, coloured by comprehension status. Arrows point downward from a subsystem to what it depends on.">
          <defs>
            <marker id="${uid}-arrow" viewBox="0 0 10 10" refX="9.2" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" class="dep-head"/>
            </marker>
          </defs>
          <g class="edges">${edgeSvg}</g>
          <g class="nodes">${nodeSvg}</g>
        </svg>
      </div>
      <aside class="diag-panel">
        <div class="panel-hint">
          <strong>Hover</strong> a subsystem to isolate it and what it touches.<br>
          <strong>Click</strong> to pin it and see who understands it.
        </div>
        ${panels}
      </aside>
    </div>

    <p class="diag-note">Arrows point down, from a subsystem to what it depends on, so the bottom row is what the rest of the codebase rests on. Box height is how load-bearing the subsystem is; edge thickness is how many symbols cross the boundary. Dashed edges are part of an import cycle. Edges are name-based, so coupling is a lower bound, never a ceiling.${
      arch.truncated ? ' The graph was built over a bounded subset of this repo, so it is partial.' : ''
    }${arch.omitted ? ` ${arch.omitted} smaller subsystem(s) are not drawn.` : ''}</p>
  </figure>`;
}

function renderArchitecture(m: ReportModel, now: Date): string {
  if (!m.architectures.length) {
    return `<section id="arch"><h2>Architecture</h2><p class="empty">No codebase graph has been persisted yet. It is captured on the next gate that builds one, which needs a repo in a language the extractor supports (TypeScript and JavaScript today).</p></section>`;
  }

  // The headline: the single fact worth acting on, stated before the picture rather than left for
  // the reader to find in it. A load-bearing subsystem nobody can explain is the whole point.
  const risky = m.areas
    .filter((a) => a.status === 'unexplained' && (a.node?.fanIn ?? 0) > 0)
    .sort((a, b) => (b.node?.fanIn ?? 0) - (a.node?.fanIn ?? 0));
  const headline = risky.length
    ? `<p class="headline"><strong>${risky.length} load-bearing subsystem${risky.length === 1 ? '' : 's'} nobody has explained.</strong> Worst first: ${
        risky.slice(0, 3).map((a) => `${esc(a.label)} (${a.node!.fanIn} file${a.node!.fanIn === 1 ? '' : 's'} depend on it)`).join(', ')
      }.</p>`
    : `<p class="headline good"><strong>Every subsystem other files depend on has been explained by someone.</strong></p>`;

  return `<section id="arch">
    <h2>Architecture, coloured by who understands it</h2>
    <p class="lede">Not hand-drawn. This is the def/ref graph Reckon builds on every gate, rolled up from files to subsystems. The shape comes from the code; the colour comes from the demonstrations.</p>
    ${headline}
    ${m.architectures.map((a, i) => renderDiagram(a, m.areas, now, i)).join('')}
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
      const tip = `${people.get(id)} on ${a.label}: confidence ${pct(p.confidence)}, ${p.demos} demonstration(s), best verdict ${p.bestVerdict ?? 'unrecorded'} on "${p.bestConcept}", last ${ago(p.lastAt, now)}${p.bestPr ? `. Opens PR #${p.bestPr}.` : ''}`;
      // The cell links to the PR behind the STRONGEST demonstration, so the number that drives
      // the score is one click from the conversation that earned it.
      return `<td class="cell" style="background:var(--seq-${i})" data-strong="${strong}">${
        link(prUrl(a.repo, p.bestPr), pct(p.confidence), 'cell-link', tip)
      }</td>`;
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
  --tint-good:#eef7ee; --tint-warning:#fdf5e4; --tint-serious:#fdf0ea; --tint-critical:#fbeeee;
  --line-good:#9dd39d; --line-warning:#e7cd8c; --line-serious:#f0b79c; --line-critical:#e8a3a3;
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
    --tint-good:#13230f; --tint-warning:#2a2312; --tint-serious:#2b1d15; --tint-critical:#2a1616;
    --line-good:#2f6b2f; --line-warning:#7a642a; --line-serious:#8a5741; --line-critical:#7f3b3b;
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
  --tint-good:#13230f; --tint-warning:#2a2312; --tint-serious:#2b1d15; --tint-critical:#2a1616;
  --line-good:#2f6b2f; --line-warning:#7a642a; --line-serious:#8a5741; --line-critical:#7f3b3b;
  ${seqVars(SEQ_DARK)}
}
* { box-sizing:border-box; }
body { margin:0; background:var(--plane); color:var(--ink);
  font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; }
.wrap { max-width:1280px; margin:0 auto; padding:32px 20px 80px; }
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
.tone-good { --tone:var(--good); --tone-tint:var(--tint-good); --tone-line:var(--line-good); }
.tone-warning { --tone:var(--warning); --tone-tint:var(--tint-warning); --tone-line:var(--line-warning); }
.tone-serious { --tone:var(--serious); --tone-tint:var(--tint-serious); --tone-line:var(--line-serious); }
.tone-critical { --tone:var(--critical); --tone-tint:var(--tint-critical); --tone-line:var(--line-critical); }
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

/* ── architecture diagram ─────────────────────────────────────────────────────────────── */
.headline { border:1px solid var(--ring); border-left:4px solid var(--critical); border-radius:6px;
  padding:10px 14px; margin:0 0 16px; font-size:13px; color:var(--ink-2); }
.headline strong { color:var(--ink); }
.headline.good { border-left-color:var(--good); }

.diagram { margin:0 0 8px; }
.diagram figcaption { display:flex; flex-wrap:wrap; align-items:baseline; gap:10px; margin-bottom:10px; }
.diag-repo { font-size:13px; font-weight:600; }
.diag-meta { color:var(--muted); font-size:12px; }

.diag-toolbar { display:flex; flex-wrap:wrap; gap:10px; align-items:center;
  justify-content:space-between; margin-bottom:10px; }
.filters { display:flex; flex-wrap:wrap; gap:6px; }
.filter, .zoom button { font:inherit; font-size:11.5px; cursor:pointer; background:var(--surface);
  color:var(--ink-2); border:1px solid var(--ring); border-radius:99px; padding:4px 11px;
  display:inline-flex; align-items:center; gap:6px; }
.filter-mark { color:var(--tone); }
.filter-n { font-variant-numeric:tabular-nums; color:var(--muted); font-size:10.5px; }
.filter:hover:not(:disabled) { border-color:var(--tone); }
.filter[aria-pressed="true"] { border-color:var(--tone); color:var(--ink);
  box-shadow:inset 0 0 0 1px var(--tone); }
.filter:disabled { opacity:0.4; cursor:default; }
.zoom { display:flex; gap:4px; }
.zoom button { border-radius:6px; padding:4px 10px; min-width:32px; justify-content:center; }
.zoom button:hover { border-color:var(--ink-2); color:var(--ink); }

.diag-body { display:grid; grid-template-columns:minmax(0,1fr) 264px; gap:14px; align-items:start; }
.diag-canvas { overflow:auto; border:1px solid var(--ring); border-radius:8px;
  background:var(--plane); max-height:640px; }
.diag-canvas:focus-visible { outline:2px solid var(--seq-8); outline-offset:2px; }
.diag-canvas svg { display:block; transform-origin:0 0; }

/* Focus mode: dim everything, then light up the selection and its immediate neighbours. The
   whole interaction is class toggles, so it degrades to a plain full graph without script. */
.diagram.is-focused .gnode { opacity:0.18; }
.diagram.is-focused .dep { opacity:0.06; }
.diagram.is-focused .gnode.hi { opacity:1; }
.diagram.is-focused .gnode.hi-near { opacity:0.92; }
.diagram.is-focused .dep.hi { opacity:1; }
.diagram.is-filtered .gnode.out { opacity:0.12; }
.diagram.is-filtered .dep.out { opacity:0.05; }

.gnode { cursor:pointer; }
.gnode-box { fill:var(--tone-tint); stroke:var(--tone-line); stroke-width:1.25; }
.gnode-accent { fill:var(--tone); }
.gnode-label { fill:var(--ink); font-size:12.5px; font-weight:600; text-anchor:middle; }
.gnode-sub { fill:var(--tone); font-size:9.5px; font-weight:700; text-anchor:middle;
  letter-spacing:0.05em; text-transform:uppercase; }
.gnode:hover .gnode-box, .gnode:focus-visible .gnode-box,
.gnode.hi .gnode-box { stroke:var(--tone); stroke-width:2.25; }
.gnode:focus-visible { outline:none; }
.gnode.sel .gnode-box { stroke:var(--tone); stroke-width:2.75; }

.dep { stroke:var(--muted); fill:none; opacity:0.55; transition:opacity .12s ease; }
.dep-cyclic { stroke-dasharray:5 4; }
.dep-head { fill:var(--muted); }
.dep.hi { stroke:var(--ink-2); }

.diag-panel { border:1px solid var(--ring); border-radius:8px; padding:14px; min-height:220px;
  position:sticky; top:14px; }
.panel-hint { color:var(--muted); font-size:12px; line-height:1.7; }
.panel-hint strong { color:var(--ink-2); }
.panel-body header { display:flex; flex-wrap:wrap; align-items:baseline; gap:8px;
  border-bottom:1px solid var(--grid); padding-bottom:8px; margin-bottom:10px; }
.panel-body h4 { margin:0; font-size:14px; }
.panel-status { color:var(--tone); font-size:10px; font-weight:700; letter-spacing:0.06em;
  text-transform:uppercase; margin-left:auto; }
.panel-stats { margin:0 0 12px; display:grid; gap:4px; }
.panel-stats > div { display:flex; gap:8px; font-size:11.5px; }
.panel-stats dt { color:var(--muted); min-width:106px; flex:none; }
.panel-stats dd { margin:0; color:var(--ink-2); }
.panel-nav { display:grid; gap:9px; margin-bottom:12px; }
.nav-label { display:block; font-size:9.5px; font-weight:700; letter-spacing:0.08em;
  text-transform:uppercase; color:var(--muted); margin-bottom:5px; }
.chips { display:flex; flex-wrap:wrap; gap:4px; }
.nav-chip { font:inherit; font-size:11px; cursor:pointer; background:var(--plane); color:var(--ink-2);
  border:1px solid var(--ring); border-radius:5px; padding:2px 7px; display:inline-flex; gap:5px; }
.nav-chip:hover { border-color:var(--seq-8); color:var(--seq-8); }
.nav-chip span { color:var(--muted); font-variant-numeric:tabular-nums; }
.panel-ev ul { list-style:none; margin:0; padding:0; display:grid; gap:6px; }
.panel-ev li { display:flex; flex-wrap:wrap; gap:5px; align-items:center; font-size:11px; }
.panel-none { color:var(--muted); font-size:11.5px; margin:0; }
.diag-note { color:var(--muted); font-size:11.5px; margin:10px 0 0; max-width:88ch; }

@media (max-width:820px) {
  .diag-body { grid-template-columns:minmax(0,1fr); }
  .diag-panel { position:static; }
}

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

/* links back to the source: recessive by default, obvious on hover */
a { color:inherit; }
.ref, .ev-pr, .sha {
  display:inline-block; font-variant-numeric:tabular-nums; font-size:11px;
  border:1px solid var(--ring); border-radius:4px; padding:0 6px; text-decoration:none;
  color:var(--ink-2); background:var(--plane); white-space:nowrap;
}
a.ref:hover, a.ev-pr:hover, a.sha:hover { border-color:var(--seq-8); color:var(--seq-8); }
span.ref, span.ev-pr, span.sha { opacity:0.55; } /* no URL to point at */
.finding-refs { margin:6px 0 0; display:flex; flex-wrap:wrap; gap:5px; align-items:center; }
.refs-label { font-size:10px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase;
  color:var(--muted); border:1px solid var(--ring); border-radius:3px; padding:1px 5px; }
.ref-more { color:var(--muted); font-size:11px; }
.cell-link { display:block; line-height:34px; text-decoration:none; color:inherit; }
a.cell-link:hover { text-decoration:underline; }

/* evidence: the receipts behind an area's status */
.evidence { margin-top:10px; border-top:1px solid var(--grid); padding-top:8px; }
.evidence summary { font-size:11px; color:var(--muted); }
.evidence ul { list-style:none; margin:8px 0 0; padding:0; display:grid; gap:6px; }
.evidence li { display:flex; flex-wrap:wrap; gap:6px; align-items:center; font-size:11px; }
.ev-who { font-weight:600; }
.ev-verdict { font-size:9.5px; font-weight:700; text-transform:uppercase; letter-spacing:0.05em;
  border-radius:3px; padding:1px 5px; border:1px solid currentColor; }
.v-strong { color:var(--good); } .v-solid { color:var(--seq-8); }
.v-thin { color:var(--serious); } .v-none { color:var(--muted); }
.ev-concept { color:var(--ink-2); flex:1 1 60px; min-width:0; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; }
.ev-when { color:var(--muted); white-space:nowrap; }

/* tables */
.tbl { border-collapse:collapse; width:100%; font-size:12px; margin-top:8px; }
.tbl caption { text-align:left; color:var(--muted); font-size:12px; padding-bottom:6px; }
.tbl th, .tbl td { border-bottom:1px solid var(--grid); padding:6px 10px 6px 0; text-align:left; }
.tbl th { color:var(--muted); font-weight:500; }
.tbl .num { text-align:right; font-variant-numeric:tabular-nums; }
details { margin-top:10px; } summary { cursor:pointer; color:var(--ink-2); font-size:13px; }
.list-view > summary { padding:8px 0; }
.list-view[open] > summary { margin-bottom:10px; border-bottom:1px solid var(--grid); }
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
${renderArchitecture(m, now)}
${renderMatrix(m.areas, now)}
${renderProfiles(m.profiles, now)}
${renderAreaMap(m.areas, now)}
${renderHealth(m.findings)}
${renderFunnel(m)}
${renderScope(m, now)}
</div>

<script>
/* Diagram interaction. Progressive enhancement only: every class this toggles has a sane default,
   so with scripting off the full graph, the panel hint and the table views are all still there.
   Scoped per <figure>, since a multi-repo report draws more than one. */
for (const fig of document.querySelectorAll('.diagram')) {
  const svg = fig.querySelector('svg');
  const canvas = fig.querySelector('.diag-canvas');
  const panel = fig.querySelector('.diag-panel');
  const hint = fig.querySelector('.panel-hint');
  if (!svg || !canvas || !panel) continue;

  const nodes = [...fig.querySelectorAll('.gnode')];
  const edges = [...fig.querySelectorAll('.dep')];
  const panels = [...fig.querySelectorAll('.panel-body')];
  const byId = new Map(nodes.map((n) => [n.dataset.id, n]));

  /* Adjacency straight off the rendered edges, so the highlight can never disagree with what is
     drawn. */
  const near = new Map(nodes.map((n) => [n.dataset.id, new Set([n.dataset.id])]));
  for (const e of edges) {
    near.get(e.dataset.from)?.add(e.dataset.to);
    near.get(e.dataset.to)?.add(e.dataset.from);
  }

  let pinned = null;

  function showPanel(id) {
    hint.hidden = !!id;
    for (const p of panels) p.hidden = p.dataset.panel !== id;
  }

  function focus(id) {
    if (!id) {
      fig.classList.remove('is-focused');
      for (const n of nodes) n.classList.remove('hi', 'hi-near', 'sel');
      for (const e of edges) e.classList.remove('hi');
      showPanel(pinned);
      if (pinned) applyFocus(pinned);
      return;
    }
    applyFocus(id);
    showPanel(id);
  }

  function applyFocus(id) {
    const set = near.get(id) || new Set([id]);
    fig.classList.add('is-focused');
    for (const n of nodes) {
      const isSelf = n.dataset.id === id;
      n.classList.toggle('hi', isSelf);
      n.classList.toggle('hi-near', !isSelf && set.has(n.dataset.id));
      n.classList.toggle('sel', n.dataset.id === pinned);
    }
    for (const e of edges) e.classList.toggle('hi', e.dataset.from === id || e.dataset.to === id);
  }

  function pin(id) {
    pinned = pinned === id ? null : id;
    if (pinned) { applyFocus(pinned); showPanel(pinned); }
    else { fig.classList.remove('is-focused');
           for (const n of nodes) n.classList.remove('hi', 'hi-near', 'sel');
           for (const e of edges) e.classList.remove('hi');
           showPanel(null); }
  }

  for (const n of nodes) {
    n.addEventListener('mouseenter', () => { if (!pinned) focus(n.dataset.id); });
    n.addEventListener('mouseleave', () => { if (!pinned) focus(null); });
    n.addEventListener('focus', () => focus(pinned || n.dataset.id));
    n.addEventListener('click', (ev) => { ev.stopPropagation(); pin(n.dataset.id); });
    n.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pin(n.dataset.id); }
    });
  }

  /* Panel chips walk the graph: click a dependency to jump to it and scroll it into view. */
  panel.addEventListener('click', (ev) => {
    const chip = ev.target.closest('[data-goto]');
    if (!chip) return;
    const target = byId.get(chip.dataset.goto);
    if (!target) return;
    pinned = chip.dataset.goto;
    applyFocus(pinned);
    showPanel(pinned);
    target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  });

  canvas.addEventListener('click', (ev) => { if (!ev.target.closest('.gnode')) pin(null); });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && pinned) pin(null); });

  /* Status filters. Additive: no button pressed means show everything. */
  const active = new Set();
  for (const btn of fig.querySelectorAll('.filter')) {
    btn.addEventListener('click', () => {
      const k = btn.dataset.filter;
      if (active.has(k)) active.delete(k); else active.add(k);
      btn.setAttribute('aria-pressed', String(active.has(k)));
      fig.classList.toggle('is-filtered', active.size > 0);
      const keep = new Set();
      for (const n of nodes) {
        const tone = [...n.classList].find((c) => c.startsWith('tone-'));
        const status = ({ 'tone-critical': 'unexplained', 'tone-serious': 'stale',
                          'tone-warning': 'single-point', 'tone-good': 'covered' })[tone];
        const on = active.size === 0 || active.has(status);
        n.classList.toggle('out', !on);
        if (on) keep.add(n.dataset.id);
      }
      for (const e of edges) e.classList.toggle('out', !(keep.has(e.dataset.from) && keep.has(e.dataset.to)));
    });
  }

  /* Zoom. The SVG keeps its intrinsic size and is scaled, so the scroll container keeps working
     and nothing reflows. */
  const baseW = svg.viewBox.baseVal.width, baseH = svg.viewBox.baseVal.height;
  let scale = 1;
  function apply() {
    svg.style.transform = 'scale(' + scale + ')';
    svg.style.width = baseW + 'px';
    svg.style.height = baseH + 'px';
    canvas.style.setProperty('--zh', (baseH * scale) + 'px');
    svg.parentElement.style.height = (baseH * scale) + 'px';
    svg.parentElement.style.width = (baseW * scale) + 'px';
  }
  const MIN_FIT = 0.7;
  function fit() {
    scale = Math.max(MIN_FIT, Math.min(1, (canvas.clientWidth - 8) / baseW));
    apply();
  }
  for (const b of fig.querySelectorAll('[data-zoom]')) {
    b.addEventListener('click', () => {
      const k = b.dataset.zoom;
      if (k === 'in') scale = Math.min(2.5, scale * 1.25);
      else if (k === 'out') scale = Math.max(0.25, scale / 1.25);
      else return fit();
      apply();
    });
  }
  fit();
  addEventListener('resize', fit);
}
</script>
</body>
</html>`;
}

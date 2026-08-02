/**
 * Deterministic force-directed layout for the architecture diagram.
 *
 * Deterministic is the requirement, not a nicety: `Math.random()` would move every box on every
 * run, so two reports of the same unchanged codebase would look like different systems and
 * nobody could compare them. Seeding is positional instead (rank order around a circle, hubs
 * nearer the middle), which also gives the simulation a sane starting shape rather than asking
 * it to untangle a random pile.
 *
 * Fruchterman-Reingold with a fixed iteration count and linear cooling, then a short separation
 * pass that pushes overlapping BOXES apart. The separation pass matters because FR treats nodes
 * as points, and a point-perfect layout still collides once every node is a labelled rectangle.
 */

export interface LayoutNode {
  id: string;
  w: number;
  h: number;
  /** Pulls a node toward the centre. Hubs belong in the middle of an architecture diagram. */
  weight: number;
}

export interface LayoutEdge {
  from: string;
  to: string;
  weight: number;
}

export interface Placed {
  id: string;
  x: number; // centre
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  nodes: Placed[];
  width: number;
  height: number;
}

const ITERATIONS = 320;
const SEPARATION_PASSES = 60;
const PAD = 26; // margin around the drawing
const GAP = 16; // minimum clear space between two boxes

export function layout(nodes: LayoutNode[], edges: LayoutEdge[], targetW = 980): Layout {
  const n = nodes.length;
  if (n === 0) return { nodes: [], width: targetW, height: 120 };
  if (n === 1) {
    const only = nodes[0];
    return {
      nodes: [{ id: only.id, x: targetW / 2, y: only.h / 2 + PAD, w: only.w, h: only.h }],
      width: targetW, height: only.h + PAD * 2,
    };
  }

  // Area of the boxes sets the canvas: too small and the simulation cannot separate them, too
  // large and everything drifts into a sparse ring.
  const boxArea = nodes.reduce((s, d) => s + (d.w + GAP) * (d.h + GAP), 0);
  const side = Math.sqrt(boxArea * 2.1);
  const W = Math.max(targetW, side);
  const H = Math.max(280, side * 0.62);
  const k = Math.sqrt((W * H) / n); // FR's ideal edge length

  // Seed: rank order around a spiral, strongest nearest the centre. Deterministic, and already
  // close to the answer for a dependency graph, whose hubs really are central.
  const order = [...nodes].sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  const pos = new Map<string, { x: number; y: number }>();
  const GOLDEN = 2.399963; // golden-angle increment: even spread without clumping
  order.forEach((d, i) => {
    const t = (i + 0.5) / n;
    const r = Math.sqrt(t) * Math.min(W, H) * 0.42;
    pos.set(d.id, { x: W / 2 + r * Math.cos(i * GOLDEN), y: H / 2 + r * Math.sin(i * GOLDEN) });
  });

  const byId = new Map(nodes.map((d) => [d.id, d]));
  const live = edges.filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to);
  const maxEdge = Math.max(1, ...live.map((e) => e.weight));

  for (let it = 0; it < ITERATIONS; it++) {
    const temp = k * 0.1 * (1 - it / ITERATIONS); // linear cooling
    const disp = new Map<string, { x: number; y: number }>(nodes.map((d) => [d.id, { x: 0, y: 0 }]));

    // Repulsion, every pair.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = pos.get(nodes[i].id)!, b = pos.get(nodes[j].id)!;
        let dx = a.x - b.x, dy = a.y - b.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.01) { dx = (i - j) * 0.01 || 0.01; dy = 0.01; dist = 0.014; }
        const f = (k * k) / dist;
        const ux = (dx / dist) * f, uy = (dy / dist) * f;
        const da = disp.get(nodes[i].id)!, db = disp.get(nodes[j].id)!;
        da.x += ux; da.y += uy; db.x -= ux; db.y -= uy;
      }
    }

    // Attraction along edges, scaled by how much code actually crosses the boundary.
    for (const e of live) {
      const a = pos.get(e.from)!, b = pos.get(e.to)!;
      const dx = a.x - b.x, dy = a.y - b.y;
      const dist = Math.max(0.01, Math.hypot(dx, dy));
      const f = ((dist * dist) / k) * (0.35 + 0.65 * (e.weight / maxEdge));
      const ux = (dx / dist) * f, uy = (dy / dist) * f;
      const da = disp.get(e.from)!, db = disp.get(e.to)!;
      da.x -= ux; da.y -= uy; db.x += ux; db.y += uy;
    }

    // Gravity toward the centre, stronger for load-bearing subsystems.
    for (const d of nodes) {
      const p = pos.get(d.id)!, dd = disp.get(d.id)!;
      dd.x += (W / 2 - p.x) * 0.012 * (0.5 + d.weight);
      dd.y += (H / 2 - p.y) * 0.012 * (0.5 + d.weight);
    }

    for (const d of nodes) {
      const p = pos.get(d.id)!, dd = disp.get(d.id)!;
      const mag = Math.max(0.01, Math.hypot(dd.x, dd.y));
      p.x += (dd.x / mag) * Math.min(mag, temp);
      p.y += (dd.y / mag) * Math.min(mag, temp);
    }
  }

  // Separation: FR laid out points, but these are labelled rectangles. Push overlapping boxes
  // apart along the axis of least penetration until nothing collides.
  for (let pass = 0; pass < SEPARATION_PASSES; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const A = nodes[i], B = nodes[j];
        const a = pos.get(A.id)!, b = pos.get(B.id)!;
        const minX = (A.w + B.w) / 2 + GAP;
        const minY = (A.h + B.h) / 2 + GAP;
        const dx = b.x - a.x, dy = b.y - a.y;
        const ox = minX - Math.abs(dx), oy = minY - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue; // not overlapping
        moved = true;
        if (ox < oy) {
          const s = (Math.sign(dx) || 1) * ox * 0.5;
          a.x -= s; b.x += s;
        } else {
          const s = (Math.sign(dy) || 1) * oy * 0.5;
          a.y -= s; b.y += s;
        }
      }
    }
    if (!moved) break;
  }

  // Normalize into a tight viewBox around whatever the simulation settled on.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const d of nodes) {
    const p = pos.get(d.id)!;
    minX = Math.min(minX, p.x - d.w / 2); maxX = Math.max(maxX, p.x + d.w / 2);
    minY = Math.min(minY, p.y - d.h / 2); maxY = Math.max(maxY, p.y + d.h / 2);
  }
  const placed: Placed[] = nodes.map((d) => {
    const p = pos.get(d.id)!;
    return { id: d.id, x: Math.round(p.x - minX + PAD), y: Math.round(p.y - minY + PAD), w: d.w, h: d.h };
  });
  return {
    nodes: placed,
    width: Math.round(maxX - minX + PAD * 2),
    height: Math.round(maxY - minY + PAD * 2),
  };
}

/**
 * Where an edge meets a box: the intersection of the centre-to-centre line with the target's
 * rectangle, so an arrowhead lands on the border instead of vanishing under the box.
 */
export function edgePoint(from: Placed, to: Placed, inset = 0): { x: number; y: number } {
  const dx = from.x - to.x, dy = from.y - to.y;
  if (dx === 0 && dy === 0) return { x: to.x, y: to.y };
  const hw = to.w / 2 + inset, hh = to.h / 2 + inset;
  const scale = Math.min(Math.abs(dx) > 1e-6 ? hw / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-6 ? hh / Math.abs(dy) : Infinity);
  return { x: to.x + dx * scale, y: to.y + dy * scale };
}

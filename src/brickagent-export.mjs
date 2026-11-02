// A build program as a BrickAgent script: plain Python against BrickAgent's own API (MIT, Kulits 2026) that runs with
// nothing but `pip install brickagent`, and builds the same parts at the same poses (test/brickagent-export.test.mjs
// holds it to scripts/brickagent-fixtures.py's run of each script). Our ops are BrickAgent's calls, one to one:
//
//   add      → m.add(part, pose=…, color=…)          attach → m.attach(part, to=…, by=…, yaw=…, …)
//   define … end → an Assembly of its own, its returns a dict    mirror → .mirror(axis, about=…), added
//   contact  → contacts, passed to check()                       base   → each part added at its exact pose
//
// Parts are written as BrickNet stems and colours as LDraw codes, so nothing depends on how a name resolves. Hoses
// (flex) have no BrickAgent counterpart and are left out with a comment. Pure: `T` is lib/bricknet.mjs's tables;
// `bases`: revision → LDraw text, as runProgram takes them; `baseParts`: lib/program.mjs baseParts (passed in, so this
// file needs no renderer).
import { resolve } from './bricknet.mjs';
import { colour } from './assembly.mjs';

const num = (v) => String(+(+v).toFixed(9) + 0);
const vec = (v) => `(${v.map(num).join(', ')})`;
const str = (s) => JSON.stringify(String(s));
// A name as a Python identifier, unique in the script.
function namer() {
  const used = new Set(['m', 'contacts', 'check', 'parts', 'Assembly', 'Pose', 'ID', 'UP', 'at', 'move', 'spin']);
  return (want) => {
    let base = String(want ?? 'part').replace(/[^A-Za-z0-9_]/g, '_').replace(/^(?=\d)/, '_') || 'part';
    if (/^(and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield)$/.test(base)) base += '_';
    let name = base, k = 2;
    while (used.has(name)) name = `${base}_${k++}`;
    used.add(name);
    return name;
  };
}

function pose(spec) {
  if (!spec?.length) return null;
  return spec.map((step) => {
    if (step.at) return `at(${step.at.map(num).join(', ')})`;
    if (step.move) return `move(${step.move.map(num).join(', ')})`;
    if (step.spin) {
      const [axis, deg, about] = step.spin;
      return `spin(${axis === 'up' ? 'UP' : vec(axis)}, ${num(deg)}${about ? `, ${vec(about)}` : ''})`;
    }
    if (step.ldraw) { const n = step.ldraw; return `Pose(${vec(n.slice(3, 12))}, ${vec(n.slice(0, 3))})`; }
    throw new Error('A pose step is { at }, { move }, { spin } or { ldraw }.');
  }).join(' @ ');
}

// → the script's text. Throws on a program that does not run (the caller runs it first).
export function brickAgentScript(program, T, { bases = {}, baseParts = null } = {}) {
  const name = namer(), lines = [], notes = [];
  const defs = new Map();                       // definition → { v: its variable, names: Map, returns: Map, mirrors: Set }
  const root = { v: 'm', names: new Map() };
  const stack = [root];
  const scope = () => stack.at(-1);
  const part = (p) => str(resolve(T, p));
  const col = (c) => { const code = colour(T, c ?? null); return code === null ? '' : `, color=${code}`; };
  const occOf = (n) => { const v = scope().names.get(n); if (!v) throw new Error(`No placement named ${n}.`); return v; };
  const ref = (text) => {
    const s = String(text);
    let r = /^([^./:\s]+)\/([^./\s]+)\.([a-z]+)\[(-?\d+)\]$/.exec(s);
    if (r) {
      const occ = occOf(r[1]), def = defs.get(occ.def);
      const inner = def?.names.get(r[2]);
      if (!inner) throw new Error(`${r[1]} has no part named ${r[2]}.`);
      return `${occ.v}.connector(${inner.v}.${r[3]}[${r[4]}])`;
    }
    r = /^([^.:\s]+):([^.\s]+)$/.exec(s);
    if (r) { const occ = occOf(r[1]); return `${occ.v}.connector(${defs.get(occ.def).v}_returns[${str(r[2])}])`; }
    r = /^([^.\s]+)\.([a-z]+)(?:\[(-?\d+)\]|\.near\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\))$/.exec(s);
    if (!r) throw new Error(`Not a connector: ${s}`);
    const v = occOf(r[1]).v;
    return r[3] !== undefined ? `${v}.${r[2]}[${r[3]}]` : `${v}.${r[2]}.near(${vec([r[4], r[5], r[6]])})`;
  };
  const keep = (o, expr, extra = {}) => {
    const v = name(o.name ?? (extra.def ? o.use : 'part'));
    lines.push(`${v} = ${scope().v}.${expr}`);
    if (o.name !== undefined) scope().names.set(String(o.name), { v, ...extra });
    return v;
  };
  program.ops.forEach((o, n) => {
    const here = scope();
    switch (o.op) {
      case 'add': {
        const p = pose(o.pose), at = p ? `, pose=${p}` : '';
        if (o.use !== undefined) keep(o, `add(${defs.get(o.use).v}${at}${col(o.color)})`, { def: o.use });
        else keep(o, `add(${part(o.part)}${at}${col(o.color)})`);
        break;
      }
      case 'attach': {
        const args = [`to=${ref(o.to)}`];
        if (o.use !== undefined) args.push(`by=${defs.get(o.use).v}_returns[${str(o.by)}]`);
        else if (o.by) args.push(`by=(${str(o.by[0])}, ${num(o.by[1])})`);
        if (o.flip !== undefined && o.flip !== null) args.push(`flip=${o.flip ? 'True' : 'False'}`);
        if (o.slide) args.push(`slide=${num(o.slide)}`);
        if (o.yaw) args.push(`yaw=${num(o.yaw)}`);
        if (o.seat && o.seat !== 'auto') args.push(`seat=${str(o.seat)}`);
        if (o.align) args.push(`align=(${vec(o.align[0])}, ${vec(o.align[1])})`);
        if (o.orient !== undefined) args.push(`orient=${pose(o.orient) ?? 'ID'}`);
        const what = o.use !== undefined ? defs.get(o.use).v : part(o.part);
        keep(o, `attach(${what}, ${args.join(', ')}${col(o.color)})`, o.use !== undefined ? { def: o.use } : {});
        break;
      }
      case 'define': {
        const v = name(o.name);
        lines.push('', `${v} = Assembly(${str(o.name)})`);
        stack.push({ v, names: new Map(), def: String(o.name) });
        break;
      }
      case 'end': {
        const returns = Object.entries(o.returns ?? {}).map(([k, r]) => `${str(k)}: ${ref(r)}`);
        lines.push(`${here.v}_returns = {${returns.join(', ')}}`, '');
        stack.pop();
        defs.set(here.def, here);
        break;
      }
      case 'mirror': {
        const about = o.about && o.about.some((x) => x !== 0) ? `, about=${vec(o.about)}` : '';
        const axis = Array.isArray(o.axis) ? vec(o.axis) : str(o.axis ?? 'x');
        const occ = here.names.get(o.of);
        if (occ) { keep(o, `add(${occ.v}.mirror(${axis}${about}))`, occ.def ? { def: occ.def } : {}); break; }
        const def = defs.get(o.of);
        if (!def) throw new Error(`No placement or definition named ${o.of}.`);
        const image = name(`${o.of}_mirror`);
        lines.push(`${image} = ${def.v}.mirror(${axis}${about})`);
        // (its parts' connectors map through the source definition's references, as BrickAgent maps them)
        const p = pose(o.pose);
        keep(o, `add(${image}${p ? `, pose=${p}` : ''})`, { def: o.of });
        break;
      }
      case 'contact': lines.push(`contacts.append((${ref(o.a)}, ${ref(o.b)}))`); break;
      case 'flex': notes.push(`op ${n}: a ${o.kind ?? 'flexible'} hose or string, which BrickAgent has no part for, is left out`); lines.push(`# (op ${n}: a hose or string, left out: BrickAgent has none)`); break;
      case 'base': {
        if (!baseParts && !Array.isArray(o.parts)) throw new Error('A base revision needs its parts to export.');
        const list = Array.isArray(o.parts)
          ? o.parts.filter((p) => !(o.removed ?? []).includes(p.key)).map((p) => (p.fixed ? { fixed: true, id: p.id } : { stem: p.stem, color: p.color, ldraw: p.pose }))
          : baseParts(T, bases[o.revision], { strict: true }).map((p) => (p.fixed ? { fixed: true, id: p.id } : { stem: p.stem, color: p.color, ldraw: [...p.pose.t, ...p.pose.r] }));
        lines.push(`# The saved build this started from (${o.revision ?? 'its parts'}), each part where it was`);
        list.forEach((p, k) => {
          if (p.fixed) { lines.push(`# p${k}: ${p.id}, which BrickAgent has no connector data for, is left out`); return; }
          const v = name(`p${k}`);
          lines.push(`${v} = m.add(${str(p.stem)}, pose=Pose(${vec(p.ldraw.slice(3, 12))}, ${vec(p.ldraw.slice(0, 3))}), color=${p.color})`);
          root.names.set(`p${k}`, { v });
        });
        lines.push('');
        break;
      }
      default: throw new Error(`Unknown op ${o.op}.`);
    }
  });
  const title = String(program.name ?? 'model').slice(0, 80);
  const body = lines.filter((l, i, a) => !(l === '' && (i === 0 || a[i - 1] === '' || i === a.length - 1)));
  return [
    `"""${title.replace(/"""|\\/g, '')}: a Nooks build program as a BrickAgent script.`,
    '',
    'pip install brickagent, then run this file: it builds the same parts at the same poses and checks them.',
    ...notes.map((t) => `Note: ${t}.`),
    '"""',
    'from brickagent import ID, UP, Assembly, Pose, at, check, move, spin',
    '',
    `m = Assembly(${str(title)})`,
    'contacts = []',
    '',
    ...body,
    '',
    'if __name__ == "__main__":',
    '    check(m, contacts=contacts)',
    '',
  ].join('\n');
}

// main.ts is mend, the CLI SPEC.md specifies. It does all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write, plus matching lines at
// three tiers (section 5), unified diffs (section 6), SEARCH/REPLACE blocks (section 7) and V4A patches
// (section 8), including the R move output lines of section 2. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, as [old, new] pairs, for the R output lines of section 2. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ---------- files: lines, line breaks, final breaks (SPEC.md section 3) ---------- */

function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

const leadingWS = (s: string): string => {
  const m = s.match(/^[ \t]*/);
  return m === null ? '' : m[0];
};
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/* ---------- matching lines (SPEC.md section 5) ---------- */

/** A body line of a unified hunk or a V4A chunk. `bs` is a `\` line, which carries no content. */
interface BodyLine {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
}

/** A line of N: `ctx` is the index into O of the context line it repeats, -1 for a new line. */
interface NLine {
  text: string;
  ctx: number;
}

/** Split a hunk/chunk body into its old lines O and its new lines N (context lines keep their O index). */
function splitBody(body: BodyLine[]): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      O.push(b.text);
      N.push({ text: b.text, ctx: O.length - 1 });
    } else if (b.kind === 'del') {
      O.push(b.text);
    } else if (b.kind === 'add') {
      N.push({ text: b.text, ctx: -1 });
    }
  }
  return { O, N };
}

/** Positions at or after `from` where O occurs in the file's lines at one tier. */
function occurrencesAt(fileLines: string[], O: string[], tier: number, from: number): number[] {
  const norm = tier === 0 ? (s: string): string => s : tier === 1 ? stripTrail : stripBoth;
  const nO = O.map(norm);
  const res: number[] = [];
  for (let i = Math.max(0, from); i + O.length <= fileLines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < O.length; k += 1) {
      if (norm(fileLines[i + k]!) !== nO[k]) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

/** The first tier (0, 1, 2; with --strict only 0) at which O occurs at or after `from`, with its positions. */
function findTier(fileLines: string[], O: string[], strict: boolean, from: number): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const p = occurrencesAt(fileLines, O, t, from);
    if (p.length > 0) return { tier: t, positions: p };
  }
  return null;
}

/** The first line at or after `from` equal to `line` at the first tier with one (single-line matching). */
function findSingle(fileLines: string[], line: string, strict: boolean, from: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const p = occurrencesAt(fileLines, [line], t, from);
    if (p.length > 0) return p[0]!;
  }
  return null;
}

/** Build the replacement lines for an occurrence of O at `pos`: context lines are the file's own matched
 * lines, and at tier 2 every other line is re-indented from O's first line to the file's first matched line. */
function buildN(fileLines: string[], O: string[], N: NLine[], tier: number, pos: number): string[] {
  const F = pos < fileLines.length ? leadingWS(fileLines[pos]!) : '';
  const P = leadingWS(O[0]!);
  return N.map((e) => {
    if (e.ctx >= 0) return fileLines[pos + e.ctx]!;
    if (tier === 2) {
      const t = e.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(P)) return F + t.slice(P.length);
    }
    return e.text;
  });
}

/* ---------- unified diffs (SPEC.md section 6) ---------- */

interface Hunk {
  a: number;
  body: BodyLine[];
  /** A `\` line immediately follows the hunk's last context or `+` line. */
  bsAfterLastCtxAdd: boolean;
  /** A `\` line immediately follows the hunk's last `+` line. */
  bsAfterLastAdd: boolean;
}

interface UniSection {
  gitOld: string | null;
  gitNew: string | null;
  dashOld: string | null;
  dashNew: string | null;
  hasDashPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
  hasHunk: boolean;
}

/** The path a `--- ` or `+++ ` line names, or null for /dev/null. A leading a/ or b/ is removed. */
function dashPath(line: string): string | null {
  let raw = line.slice(4).split('\t')[0]!.trim();
  if (raw.startsWith('a/') || raw.startsWith('b/')) raw = raw.slice(2);
  return raw === '/dev/null' ? null : raw;
}

function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = lines[i]!.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const a = Number(m[1]);
  const body: BodyLine[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    // The body ends at a `--- ` line followed by a `+++ ` line, even though it starts with `-`.
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: 'ctx', text: '' });
      j += 1;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      body.push({ kind: 'ctx', text: l.slice(1) });
      j += 1;
      continue;
    }
    if (c === '-') {
      body.push({ kind: 'del', text: l.slice(1) });
      j += 1;
      continue;
    }
    if (c === '+') {
      body.push({ kind: 'add', text: l.slice(1) });
      j += 1;
      continue;
    }
    if (c === '\\') {
      body.push({ kind: 'bs', text: l.slice(1) });
      j += 1;
      continue;
    }
    break;
  }
  // Empty lines at the end of a body are not part of it.
  while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') body.pop();
  let lastCtxAdd = -1;
  let lastAdd = -1;
  for (let k = 0; k < body.length; k += 1) {
    if (body[k]!.kind === 'ctx' || body[k]!.kind === 'add') lastCtxAdd = k;
    if (body[k]!.kind === 'add') lastAdd = k;
  }
  const bsAfterLastCtxAdd = lastCtxAdd >= 0 && body[lastCtxAdd + 1]?.kind === 'bs';
  const bsAfterLastAdd = lastAdd >= 0 && body[lastAdd + 1]?.kind === 'bs';
  return { hunk: { a, body, bsAfterLastCtxAdd, bsAfterLastAdd }, next: j };
}

function uniSectionEdit(sec: UniSection, strict: boolean): Edit {
  const oldFile = sec.hasDashPair ? sec.dashOld : sec.renameFrom ?? sec.gitOld;
  const newFile = sec.hasDashPair ? sec.dashNew : sec.renameTo ?? sec.gitNew;
  const isCreate = oldFile === null || sec.isCreate;
  const isDelete = !isCreate && (newFile === null || sec.isDelete);
  const isMove = !isCreate && !isDelete && oldFile !== newFile;
  return (tree) => {
    if (isCreate) {
      const target = newFile ?? '/dev/null';
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const content: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.kind === 'add') content.push(b.text);
      let finalBreak = true;
      for (let k = sec.hunks.length - 1; k >= 0; k -= 1) {
        if (sec.hunks[k]!.body.some((b) => b.kind === 'add')) {
          finalBreak = !sec.hunks[k]!.bsAfterLastAdd;
          break;
        }
      }
      tree.now.set(target, content.length === 0 ? '' : content.join('\n') + (finalBreak ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const target = oldFile ?? '/dev/null';
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    const target = oldFile!;
    if (!safe(target)) throw new Fail('unsafe', target);
    if (isMove && !safe(newFile!)) throw new Fail('unsafe', newFile!);
    const before = tree.get(target);
    if (before === null) throw new Fail('missing', target);
    if (isMove && tree.get(newFile!) !== null) throw new Fail('exists', newFile!);
    const sf = splitFile(before);
    const lines = sf.lines;
    let final = sf.final;
    let d = 0;
    for (const h of sec.hunks) {
      const { O, N } = splitBody(h.body);
      if (O.length === 0) {
        const pos = Math.max(0, Math.min(h.a + d, lines.length));
        const atEnd = pos === lines.length;
        lines.splice(pos, 0, ...N.map((e) => e.text));
        if (atEnd) final = !h.bsAfterLastCtxAdd;
        d += N.length;
      } else {
        const found = findTier(lines, O, strict, 0);
        if (found === null) throw new Fail('no-match', target);
        const want = h.a - 1 + d;
        let best = found.positions[0]!;
        for (const p of found.positions) {
          if (Math.abs(p - want) < Math.abs(best - want)) best = p;
        }
        const runsToEnd = best + O.length === lines.length;
        const rep = buildN(lines, O, N, found.tier, best);
        lines.splice(best, O.length, ...rep);
        if (runsToEnd) final = !h.bsAfterLastCtxAdd;
        d += N.length - O.length;
      }
    }
    const out = joinFile(lines, sf.br, final);
    if (isMove) {
      tree.now.set(newFile!, out);
      tree.now.set(target, null);
      tree.moves.push([target, newFile!]);
    } else {
      tree.now.set(target, out);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let sec: UniSection | null = null;
  const flush = (): void => {
    if (sec !== null) {
      edits.push(uniSectionEdit(sec, strict));
      sec = null;
    }
  };
  const fresh = (gitOld: string | null, gitNew: string | null): UniSection => ({
    gitOld,
    gitNew,
    dashOld: null,
    dashNew: null,
    hasDashPair: false,
    renameFrom: null,
    renameTo: null,
    isCreate: false,
    isDelete: false,
    hunks: [],
    hasHunk: false,
  });
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git')) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      flush();
      sec = fresh(m[1]!, m[2]!);
      i += 1;
      continue;
    }
    if (sec !== null && !sec.hasHunk && line.startsWith('--- ')) {
      if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
      sec.dashOld = dashPath(line);
      sec.dashNew = dashPath(lines[i + 1]!);
      sec.hasDashPair = true;
      i += 2;
      continue;
    }
    if ((sec === null || sec.hasHunk) && line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      flush();
      sec = fresh(null, null);
      sec.dashOld = dashPath(line);
      sec.dashNew = dashPath(lines[i + 1]!);
      sec.hasDashPair = true;
      i += 2;
      continue;
    }
    if (sec === null) {
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (!sec.hasHunk) {
      if (line.startsWith('@@')) {
        const r = parseHunk(lines, i);
        sec.hunks.push(r.hunk);
        sec.hasHunk = true;
        i = r.next;
        continue;
      }
      if (line.startsWith('rename from ')) {
        sec.renameFrom = line.slice(12).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.renameTo = line.slice(10).trim();
        i += 1;
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        sec.isCreate = true;
        i += 1;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        sec.isDelete = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const r = parseHunk(lines, i);
      sec.hunks.push(r.hunk);
      i = r.next;
      continue;
    }
    i += 1;
  }
  flush();
  return edits;
}

/* ---------- SEARCH/REPLACE blocks (SPEC.md section 7) ---------- */

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  for (;;) {
    let s = -1;
    for (let k = prevEnd; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') {
        s = k;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let k = s - 1; k >= prevEnd; k -= 1) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let k = s + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let k = eq + 1; k < lines.length; k += 1) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = k;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const sf = splitFile(before);
    const lines = sf.lines;
    const found = findTier(lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    let rep = newLines;
    if (found.tier === 2) {
      const F = leadingWS(lines[pos]!);
      const P = leadingWS(oldLines[0]!);
      rep = newLines.map((t) => (t !== '' && t.trim() !== '' && t.startsWith(P) ? F + t.slice(P.length) : t));
    }
    lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, joinFile(lines, sf.br, sf.final));
  };
}

/* ---------- V4A patches (SPEC.md section 8) ---------- */

/** Collect one chunk's body lines starting at raw[k]; stops at `@@`, `*** End of File` or a non-body line. */
function v4aBody(raw: string[], k: number): { body: BodyLine[]; eof: boolean; next: number } {
  const body: BodyLine[] = [];
  let eof = false;
  while (k < raw.length) {
    const b = raw[k]!;
    if (b === '*** End of File') {
      eof = true;
      k += 1;
      break;
    }
    if (b.startsWith('@@')) break;
    if (b === '') {
      body.push({ kind: 'ctx', text: '' });
      k += 1;
      continue;
    }
    if (b[0] === ' ') {
      body.push({ kind: 'ctx', text: b.slice(1) });
      k += 1;
      continue;
    }
    if (b[0] === '-') {
      body.push({ kind: 'del', text: b.slice(1) });
      k += 1;
      continue;
    }
    if (b[0] === '+') {
      body.push({ kind: 'add', text: b.slice(1) });
      k += 1;
      continue;
    }
    break;
  }
  return { body, eof, next: k };
}

interface V4aChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function updateEdit(path: string, raw: string[], start: number, updateLine: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let k = 0;
  if (k < raw.length && raw[k]!.startsWith('*** Move to: ')) {
    moveTo = raw[k]!.slice('*** Move to: '.length).trim();
    k += 1;
  }
  const chunks: V4aChunk[] = [];
  let first = true;
  while (k < raw.length) {
    const l = raw[k]!;
    if (l.startsWith('@@')) {
      const anchorText = l.slice(2).trim();
      k += 1;
      const r = v4aBody(raw, k);
      chunks.push({ anchor: anchorText === '' ? null : anchorText, body: r.body, eof: r.eof });
      k = r.next;
      first = false;
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (!first) throw new Exit2(`error: parse ${start + k + 1}`);
      const r = v4aBody(raw, k);
      chunks.push({ anchor: null, body: r.body, eof: r.eof });
      k = r.next;
      first = false;
      continue;
    }
    throw new Exit2(`error: parse ${start + k + 1}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const sf = splitFile(before);
    const lines = sf.lines;
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const at = findSingle(lines, chunk.anchor, strict, cursor);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { O, N } = splitBody(chunk.body);
      if (O.length === 0) {
        const pos = chunk.eof ? lines.length : cursor;
        const ins = N.map((e) => e.text);
        lines.splice(pos, 0, ...ins);
        cursor = pos + ins.length;
      } else {
        let found: { tier: number; pos: number } | null = null;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          const occ = occurrencesAt(lines, O, t, cursor).filter((p) => !chunk.eof || p + O.length === lines.length);
          if (occ.length > 0) {
            found = { tier: t, pos: occ[0]! };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', path);
        const rep = buildN(lines, O, N, found.tier, found.pos);
        lines.splice(found.pos, O.length, ...rep);
        cursor = found.pos + rep.length;
      }
    }
    const out = joinFile(lines, sf.br, sf.final);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isStart = (l: string): boolean => /^\*\*\* (Add File|Delete File|Update File): /.test(l);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let m = line.match(/^\*\*\* Add File: (.*)$/);
    if (m !== null) {
      const path = m[1]!.trim();
      i += 1;
      const base = i;
      const raw: string[] = [];
      while (i < last && !isStart(lines[i]!)) {
        raw.push(lines[i]!);
        i += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k += 1) {
        const l = raw[k]!;
        if (l === '') fileLines.push('');
        else if (l.startsWith('+')) fileLines.push(l.slice(1));
        else throw new Exit2(`error: parse ${base + k + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      continue;
    }
    m = line.match(/^\*\*\* Delete File: (.*)$/);
    if (m !== null) {
      const path = m[1]!.trim();
      i += 1;
      while (i < last && !isStart(lines[i]!)) {
        if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    m = line.match(/^\*\*\* Update File: (.*)$/);
    if (m !== null) {
      const path = m[1]!.trim();
      const updateLine = i + 1;
      i += 1;
      const base = i;
      const raw: string[] = [];
      while (i < last && !isStart(lines[i]!)) {
        raw.push(lines[i]!);
        i += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      edits.push(updateEdit(path, raw, base, updateLine, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

/* ---------- JSON edits (SPEC.md section 9) ---------- */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---------- running (SPEC.md sections 1, 2 and 10) ---------- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  // A successful move replaces its D and A lines with one R line, sorted by <new>.
  const drop = new Set<number>();
  for (const [old, nw] of tree.moves) {
    if (tree.original(old) !== null && tree.get(old) === null && tree.original(nw) === null && tree.get(nw) !== null) {
      const di = rows.findIndex((r) => r.line === `D ${old}`);
      const ai = rows.findIndex((r) => r.line === `A ${nw}`);
      if (di >= 0 && ai >= 0) {
        drop.add(di);
        drop.add(ai);
        rows.push({ key: nw, line: `R ${old} -> ${nw}` });
      }
    }
  }
  const finalRows = rows.filter((_, idx) => !drop.has(idx)).sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...finalRows.map((r) => r.line), `ok: ${finalRows.length} ${finalRows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

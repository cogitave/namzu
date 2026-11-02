import { IGNORE_SOURCE } from './ignore-source.js'

/** Stable guest code: host bundlers must never rewrite a function we serialize. */
export const FILE_WALK_PROGRAM = `${IGNORE_SOURCE}${String.raw`
const fs = require('node:fs/promises');
const path = require('node:path');
const plan = JSON.parse(process.argv[1]);
const missing = error => ['ENOENT', 'ENOTDIR'].includes(error.code);
const write = async value => {
  if (!process.stdout.write(JSON.stringify(value) + '\n')) {
    await new Promise(resolve => process.stdout.once('drain', resolve));
  }
};
let stopped;
let visitedTotal = 0;
let ignoredDirs = 0;
const visit = count => {
  visitedTotal = count;
  if (count <= plan.maxVisitedEntries) return true;
  if (plan.failOnLimit) {
    throw Object.assign(new Error('File search stopped after examining ' + plan.maxVisitedEntries + ' entries; narrow its root or pattern.'), {code:'ERR_FILE_WALK_LIMIT'});
  }
  stopped = 'entry-limit';
  return false;
};
const patterns = plan.patterns.map(set => set.map(part =>
  typeof part === 'object' && part !== null ? new RegExp(part.source, part.flags + 's') : part));
const canDescend = relative => patterns.some(pattern => {
  const closure = states => {
    for (const index of states) if (pattern[index] === null) states.add(index + 1);
    return states;
  };
  let states = closure(new Set([0]));
  for (const name of relative.split('/')) {
    const next = new Set();
    for (const index of states) {
      const segment = pattern[index];
      if (segment === null) {
        if (plan.includeHidden || !name.startsWith('.')) next.add(index);
      } else if (typeof segment === 'string' ? segment === name : segment?.test(name)) next.add(index + 1);
    }
    states = closure(next);
    if (states.size === 0) return false;
  }
  return [...states].some(index => index < pattern.length);
});
async function run() {
  const stack = [];
  let visited = 0;
  let emitted = 0;
  const matchers = plan.expressions.map(({source, flags}) => new RegExp(source, flags + 's'));
  const maxDepth = plan.maxDepth === null ? Infinity : plan.maxDepth;
  const ignore = plan.respectIgnore ? ignCreate({fs, path, extraFiles: []}) : null;
  const open = async (absolute, relative, depth, layered) => {
    try {
      const dir = await fs.opendir(absolute);
      if (layered && ignore) await ignore.enter(absolute);
      stack.push({dir, relative, depth, layered});
    } catch (error) { if (!missing(error)) throw error; }
  };
  try {
    if (plan.patterns.length === 0) return;
    let canonicalRoot;
    try { canonicalRoot = await fs.realpath(plan.root); }
    catch (error) { if (missing(error)) return; throw error; }
    if (canonicalRoot !== path.resolve(plan.root)) throw new Error('File walk root follows a symbolic link; use its authorized real directory');
    const rootInfo = await fs.lstat(plan.root);
    if (rootInfo.isFile()) {
      if (!visit(++visited)) return;
      if (matchers.some(matcher => matcher.test(path.basename(plan.root)))) {
        await write({type:'entry', path:plan.root, size:rootInfo.size});
      }
      return;
    }
    if (ignore) { await ignore.init(plan.root); await ignore.enter(plan.root); }
    let start = plan.root;
    for (const part of plan.prefix) {
      start = path.join(start, part);
      let info;
      try { info = await fs.lstat(start); }
      catch (error) { if (missing(error)) return; throw error; }
      if (!visit(++visited)) return;
      if (!info.isDirectory()) return;
      if (ignore) await ignore.enter(start);
    }
    if (plan.prefix.length >= maxDepth) return;
    await open(start, plan.prefix.join('/'), plan.prefix.length, false);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const entry = await frame.dir.read();
      if (!entry) { stack.pop(); if (frame.layered && ignore) ignore.leave(); await frame.dir.close(); continue; }
      if (!visit(++visited)) return;
      if (IGN_VCS.includes(entry.name)) continue;
      const relative = frame.relative ? frame.relative + '/' + entry.name : entry.name;
      const absolute = path.join(plan.root, relative);
      const depth = frame.depth + 1;
      if (entry.isDirectory()) {
        if (depth >= maxDepth || !canDescend(relative)) continue;
        if (ignore && ignore.isIgnored(absolute, true)) { ignoredDirs++; continue; }
        await open(absolute, relative, depth, true);
        continue;
      }
      if (!entry.isFile() || !matchers.some(matcher => matcher.test(relative))) continue;
      if (ignore && ignore.isIgnored(absolute, false)) continue;
      let info;
      try { info = await fs.lstat(absolute); }
      catch (error) { if (missing(error)) continue; throw error; }
      if (!info.isFile()) continue;
      await write({type:'entry', path:absolute, size:info.size});
      if (++emitted >= plan.maxEntries) return;
    }
  } finally {
    for (const {dir} of stack.reverse()) await dir.close();
  }
}
run().then(
  () => write({type:'done', visited:visitedTotal, ignoredDirs, stopped}),
  async error => { await write({type:'error', message:error.message, code:error.code}); process.exitCode = 1; },
);
`}`

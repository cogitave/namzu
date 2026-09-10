/** Stable guest code: host bundlers must never rewrite a function we serialize. */
export const FILE_WALK_PROGRAM = String.raw`
const fs = require('node:fs/promises');
const path = require('node:path');
const plan = JSON.parse(process.argv[1]);
const missing = error => ['ENOENT', 'ENOTDIR'].includes(error.code);
const write = async value => {
  if (!process.stdout.write(JSON.stringify(value) + '\n')) {
    await new Promise(resolve => process.stdout.once('drain', resolve));
  }
};
const visit = count => {
  if (count > plan.maxVisitedEntries) {
    throw Object.assign(new Error('File search stopped after examining ' + plan.maxVisitedEntries + ' entries; narrow its root or pattern.'), {code:'ERR_FILE_WALK_LIMIT'});
  }
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
  const open = async (absolute, relative, depth) => {
    try { stack.push({dir: await fs.opendir(absolute), relative, depth}); }
    catch (error) { if (!missing(error)) throw error; }
  };
  try {
    if (plan.patterns.length === 0) return;
    let canonicalRoot;
    try { canonicalRoot = await fs.realpath(plan.root); }
    catch (error) { if (missing(error)) return; throw error; }
    if (canonicalRoot !== path.resolve(plan.root)) throw new Error('File walk root follows a symbolic link; use its authorized real directory');
    const rootInfo = await fs.lstat(plan.root);
    if (rootInfo.isFile()) {
      visit(++visited);
      if (matchers.some(matcher => matcher.test(path.basename(plan.root)))) {
        await write({type:'entry', path:plan.root, size:rootInfo.size});
      }
      return;
    }
    let start = plan.root;
    for (const part of plan.prefix) {
      start = path.join(start, part);
      let info;
      try { info = await fs.lstat(start); }
      catch (error) { if (missing(error)) return; throw error; }
      visit(++visited);
      if (!info.isDirectory()) return;
    }
    if (plan.prefix.length >= maxDepth) return;
    await open(start, plan.prefix.join('/'), plan.prefix.length);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const entry = await frame.dir.read();
      if (!entry) { stack.pop(); await frame.dir.close(); continue; }
      visit(++visited);
      const relative = frame.relative ? frame.relative + '/' + entry.name : entry.name;
      const absolute = path.join(plan.root, relative);
      const depth = frame.depth + 1;
      if (entry.isDirectory()) {
        if (depth < maxDepth && canDescend(relative)) await open(absolute, relative, depth);
        continue;
      }
      if (!entry.isFile() || !matchers.some(matcher => matcher.test(relative))) continue;
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
  () => write({type:'done'}),
  async error => { await write({type:'error', message:error.message, code:error.code}); process.exitCode = 1; },
);
`

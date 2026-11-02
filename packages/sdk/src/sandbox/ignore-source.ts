/**
 * The ignore-file matcher, as plain JavaScript source text.
 *
 * One implementation serves two runtimes. The host walker evaluates this text
 * once (see `ignore-matcher.ts`); the guest program (`file-walk-program.ts`)
 * embeds the same text, because that program travels as a single `node -e`
 * argument with stdin closed and cannot import a package. Keeping it as
 * source text, not a serialised function, means a host bundler cannot rewrite
 * it, and the two walks cannot drift apart.
 *
 * Rules follow the gitignore format: `#` comments, `\#` and `\!` escapes,
 * unescaped trailing spaces dropped, `!` negation, a leading or inner `/`
 * anchors a rule to the file that holds it, a trailing `/` matches
 * directories only, and `*`, `?`, `[...]`, `**` as git defines them. A deeper
 * file beats a shallower one, `.ignore` beats `.gitignore` in the same
 * directory, and the last matching line of a file wins. A rule this matcher
 * does not understand is dropped (an unclosed `[`, or more than three
 * separate `*` in one rule, which could backtrack for seconds), so a visible
 * file is never hidden by one.
 *
 * Nothing here is allowed to contain a backtick or a `${`: it lives inside a
 * template literal. Every helper is prefixed `ign` so that, inlined into the
 * guest program, it cannot collide with that program's own names.
 */
export const IGNORE_SOURCE = String.raw`
const IGN_MAX_BYTES = 262144;
const IGN_MAX_RULES = 10000;
const IGN_MAX_PATTERN = 1024;
const IGN_MAX_STARS = 3;
const IGN_VCS = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'];
const IGN_POSIX_CLASSES = {
  alpha: 'a-zA-Z', digit: '0-9', alnum: 'a-zA-Z0-9', upper: 'A-Z', lower: 'a-z',
  space: ' \\t\\n\\r\\f\\v', punct: '!-\\/:-@\\[-\`{-~', xdigit: '0-9A-Fa-f',
};
function ignEscape(c) { return /[\\^$.*+?()[\]{}|\/-]/.test(c) ? '\\' + c : c; }
function ignClass(body) {
  let negate = false;
  if (body[0] === '!' || body[0] === '^') { negate = true; body = body.slice(1); }
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '[' && body[i + 1] === ':') {
      const end = body.indexOf(':]', i + 2);
      const name = end < 0 ? '' : body.slice(i + 2, end);
      if (IGN_POSIX_CLASSES[name]) { out += IGN_POSIX_CLASSES[name]; i = end + 1; continue; }
    }
    if (c === '\\') { i++; if (i < body.length) out += ignEscape(body[i]); continue; }
    if (c === '-') { out += (out === '' || i === body.length - 1) ? '\\-' : '-'; continue; }
    out += (c === '[' || c === ']' || c === '^') ? '\\' + c : c;
  }
  if (out === '') return null;
  return '[' + (negate ? '^/' : '') + out + ']';
}
function ignTranslate(p) {
  let out = '';
  let i = 0;
  let stars = 0;
  while (i < p.length) {
    const c = p[i];
    if (c === '\\') {
      if (i + 1 >= p.length) return null;
      out += ignEscape(p[i + 1]); i += 2; continue;
    }
    if (c === '*') {
      let j = i;
      while (p[j] === '*') j++;
      if (j - i >= 2 && (i === 0 || p[i - 1] === '/') && (j === p.length || p[j] === '/')) {
        if (j === p.length) out += '.*';
        else { out += '(?:.*/)?'; j++; }
        i = j; continue;
      }
      stars++;
      out += '[^/]*'; i = j; continue;
    }
    if (c === '?') { out += '[^/]'; i++; continue; }
    if (c === '[') {
      let j = i + 1;
      if (p[j] === '!' || p[j] === '^') j++;
      if (p[j] === ']') j++;
      while (j < p.length && p[j] !== ']') { if (p[j] === '\\') j++; j++; }
      if (j >= p.length) return null;
      const cls = ignClass(p.slice(i + 1, j));
      if (cls === null) return null;
      out += cls; i = j + 1; continue;
    }
    out += ignEscape(c); i++;
  }
  // Each separate star can backtrack against the others: a rule with many of
  // them takes time exponential in their number on one long name. Real rules
  // use one or two; a rule past the cap is dropped, like any rule not understood.
  if (stars > IGN_MAX_STARS) return null;
  return out;
}
/** One line to one rule, or null when the line holds none. */
function ignRule(raw) {
  let line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  while (line.endsWith(' ') && !line.endsWith('\\ ')) line = line.slice(0, -1);
  if (line === '' || line[0] === '#' || line.length > IGN_MAX_PATTERN) return null;
  let negate = false;
  if (line[0] === '!') { negate = true; line = line.slice(1); }
  let dirOnly = false;
  while (line.length > 1 && line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
  if (line === '/' || line === '') return null;
  const anchored = line.indexOf('/') >= 0;
  if (line[0] === '/') line = line.slice(1);
  line = line.replace(/(\*\*\/)+/g, '**/');
  if ((line.match(/\*\*/g) || []).length > 4) return null;
  let body;
  try { body = ignTranslate(line); } catch (error) { return null; }
  if (body === null) return null;
  try {
    return { negate, dirOnly, re: new RegExp((anchored ? '^' : '^(?:.*/)?') + body + '$') };
  } catch (error) { return null; }
}
function ignParse(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  if (text.length > IGN_MAX_BYTES) text = text.slice(0, text.lastIndexOf('\n', IGN_MAX_BYTES) + 1);
  const rules = [];
  for (const line of text.split('\n')) {
    const rule = ignRule(line);
    if (rule) rules.push(rule);
    if (rules.length >= IGN_MAX_RULES) break;
  }
  return rules;
}
/** 0: no rule matches. 1: ignored. 2: re-included. The last matching rule wins. */
function ignDecide(rules, relative, isDirectory) {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i];
    if (rule.dirOnly && !isDirectory) continue;
    if (rule.re.test(relative)) return rule.negate ? 2 : 1;
  }
  return 0;
}
/**
 * The layered rules for one walk. The caller enters a directory before it
 * reads it and leaves it after, so the layers follow the depth-first stack.
 * deps: fs (promises), path, extraFiles (global exclude files, host only).
 */
function ignCreate(deps) {
  const fs = deps.fs;
  const path = deps.path;
  const layers = [];
  const frames = [];
  let ancestorsInRepo = false;
  const posix = value => path.sep === '/' ? value : value.split(path.sep).join('/');
  const lstat = async file => { try { return await fs.lstat(file); } catch (error) { return null; } };
  const load = async file => {
    const info = await lstat(file);
    if (!info || !info.isFile() || info.size > IGN_MAX_BYTES * 4) return [];
    try { return ignParse(await fs.readFile(file, 'utf8')); } catch (error) { return []; }
  };
  const loadDirectory = async (directory, inRepo) => {
    const rules = [];
    if (inRepo) rules.push(...await load(path.join(directory, '.gitignore')));
    rules.push(...await load(path.join(directory, '.ignore')));
    return rules;
  };
  const push = (directory, rules) => {
    layers.push({ base: posix(directory).replace(/\/$/, ''), rules });
  };
  return {
    /** Find the enclosing repository and load the layers above the root. */
    async init(root) {
      let directory = root;
      let repo = null;
      for (;;) {
        const info = await lstat(path.join(directory, '.git'));
        if (info) { repo = { directory, isDirectory: info.isDirectory() }; break; }
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
      if (!repo || repo.directory === root) return;
      ancestorsInRepo = true;
      const chain = [];
      for (let up = path.dirname(root); ; up = path.dirname(up)) {
        chain.unshift(up);
        if (up === repo.directory || path.dirname(up) === up) break;
      }
      for (const [index, directory] of chain.entries()) {
        const rules = [];
        if (index === 0) {
          for (const file of deps.extraFiles || []) rules.push(...await load(file));
          if (repo.isDirectory) rules.push(...await load(path.join(directory, '.git', 'info', 'exclude')));
        }
        rules.push(...await loadDirectory(directory, true));
        push(directory, rules);
      }
    },
    async enter(directory) {
      const parentInRepo = frames.length ? frames[frames.length - 1] : ancestorsInRepo;
      let inRepo = parentInRepo;
      const rules = [];
      if (!parentInRepo) {
        const info = await lstat(path.join(directory, '.git'));
        if (info) {
          inRepo = true;
          for (const file of deps.extraFiles || []) rules.push(...await load(file));
          if (info.isDirectory()) rules.push(...await load(path.join(directory, '.git', 'info', 'exclude')));
        }
      }
      rules.push(...await loadDirectory(directory, inRepo));
      frames.push(inRepo);
      push(directory, rules);
    },
    leave() { frames.pop(); layers.pop(); },
    isIgnored(absolute, isDirectory) {
      const target = posix(absolute);
      for (let i = layers.length - 1; i >= 0; i--) {
        const layer = layers[i];
        if (layer.rules.length === 0 || !target.startsWith(layer.base + '/')) continue;
        const decision = ignDecide(layer.rules, target.slice(layer.base.length + 1), isDirectory);
        if (decision) return decision === 1;
      }
      return false;
    },
  };
}
`

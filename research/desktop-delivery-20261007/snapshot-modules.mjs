// Collects the npm packages the Desktop main process and preload import at run time into
// <snapshotDir>/desktop-modules/<name>/ plus manifest.json, so native-update.cjs can add the ones
// the installed app lacks. WSL side. Simple path only: a package with dependencies is refused.
//   node snapshot-modules.mjs <snapshotDir>
import { builtinModules } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktopModules = path.join(repo, 'packages', 'desktop', 'node_modules');
const builtins = new Set(builtinModules);

export function bareSpecifiers(code) {
  const text = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const found = new Set();
  const patterns = [
    /\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) found.add(m[1]);
  return found;
}
export function packageName(spec) {
  if (/^(\.|\/|[A-Za-z]:|file:|data:|https?:)/.test(spec) || spec.startsWith('node:')) return null;
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  if (builtins.has(spec) || builtins.has(name) || name === 'electron') return null;
  return name;
}
export function requiredPackages(desktopDist) {
  const names = new Map(); // name -> files
  const visit = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (e.name !== '__fixtures__') visit(path.join(dir, e.name), r); continue; }
      if (!e.isFile() || !/\.(js|cjs|mjs)$/.test(e.name) || /\.test\.(js|cjs|mjs)$/.test(e.name)) continue;
      for (const spec of bareSpecifiers(fs.readFileSync(path.join(dir, e.name), 'utf8'))) {
        const name = packageName(spec);
        if (name) names.set(name, [...(names.get(name) ?? []), r]);
      }
    }
  };
  if (fs.existsSync(path.join(desktopDist, 'main'))) visit(path.join(desktopDist, 'main'), 'main');
  const preload = path.join(desktopDist, 'preload.cjs');
  if (fs.existsSync(preload))
    for (const spec of bareSpecifiers(fs.readFileSync(preload, 'utf8'))) {
      const name = packageName(spec);
      if (name) names.set(name, [...(names.get(name) ?? []), 'preload.cjs']);
    }
  return names;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const snapshot = process.argv[2] && path.resolve(process.argv[2]);
  if (!snapshot) { console.error('usage: node snapshot-modules.mjs <snapshotDir>'); process.exit(2); }
  const out = path.join(snapshot, 'desktop-modules');
  const tmp = `${out}.tmp-${process.pid}`;
  try {
    if (!fs.existsSync(path.join(snapshot, 'desktop-dist'))) throw new Error(`${snapshot} has no desktop-dist`);
    if (fs.existsSync(out)) throw new Error(`${out} already exists; remove it deliberately to regenerate`);
    const required = requiredPackages(path.join(snapshot, 'desktop-dist'));
    const rows = [], problems = [];
    fs.mkdirSync(tmp);
    for (const [name, files] of [...required].sort((a, b) => a[0].localeCompare(b[0]))) {
      const link = path.join(desktopModules, ...name.split('/'));
      if (!fs.existsSync(link)) { problems.push(`${name} (imported by ${[...new Set(files)].join(', ')}) is not installed in packages/desktop/node_modules`); continue; }
      const dir = fs.realpathSync(link);
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) };
      if (Object.keys(deps).length) { problems.push(`${name}@${pkg.version} has dependencies (${Object.keys(deps).join(', ')}); transitive dependencies are not supported by this simple path`); continue; }
      fs.cpSync(dir, path.join(tmp, ...name.split('/')), { recursive: true, dereference: true });
      rows.push({ name, version: pkg.version, dependencies: pkg.dependencies ?? {} });
    }
    if (problems.length) throw new Error(problems.join('\n'));
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(rows, null, 2) + '\n');
    fs.renameSync(tmp, out);
    for (const r of rows) console.log(`${r.name}@${r.version} dependencies=${Object.keys(r.dependencies).length}`);
    console.log(`wrote ${path.join(out, 'manifest.json')} (${rows.length} package(s))`);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    console.error(`Refused: ${e.message}`);
    process.exit(1);
  }
}

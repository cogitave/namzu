// Snapshot already-installed, built runtime packages into an isolated Windows
// test directory. This does not install packages or modify a user's npm shims.
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

const [rootArg, destinationArg] = process.argv.slice(2)
if (!rootArg || !destinationArg) throw new Error('Pass the built repository and a new Windows temp directory.')
const root = realpathSync(rootArg)
const destination = resolve(destinationArg)
if (!destination.startsWith('/mnt/c/Users/') || !destination.includes('/AppData/Local/Temp/') ||
    !basename(destination).startsWith('namzu-native-consumer-')) {
  throw new Error('Choose a separate namzu-native-consumer-* directory under Windows user Temp.')
}
if (existsSync(destination)) throw new Error('The snapshot destination already exists.')

function dependencyRoot(from, name) {
  for (let parent = from; ; parent = dirname(parent)) {
    const candidate = join(parent, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    if (dirname(parent) === parent) return null
  }
}
const packages = new Map()
function visit(path) {
  if (packages.has(path)) return packages.get(path)
  const json = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'))
  const item = { source: path, relative: `packages/p${packages.size}`, name: json.name, version: json.version, links: {} }
  packages.set(path, item)
  for (const name of new Set([
    ...Object.keys(json.dependencies ?? {}), ...Object.keys(json.peerDependencies ?? {}),
    ...Object.keys(json.optionalDependencies ?? {}),
  ])) {
    const found = dependencyRoot(path, name)
    if (!found) {
      if (json.optionalDependencies?.[name] || json.peerDependenciesMeta?.[name]?.optional) continue
      throw new Error(`Missing installed dependency ${name} for ${json.name}`)
    }
    item.links[name] = visit(found).relative
  }
  return item
}
const entry = visit(join(root, 'packages/cli'))
mkdirSync(destination)
for (const item of packages.values()) {
  const workspace = item.source.startsWith(`${root}${sep}packages${sep}`)
  cpSync(item.source, join(destination, item.relative), {
    recursive: true,
    dereference: true,
    filter(path) {
      const relative = path.slice(item.source.length + 1)
      if (!relative) return true
      const parts = relative.split(sep)
      if (parts.some((part) => ['node_modules', '.git', '__tests__', '__fixtures__'].includes(part))) return false
      if (!workspace) return true
      if (parts[0] === 'src') return false
      if (parts[0] === 'dist' && (/\.(?:map|d\.ts|d\.cts)$/.test(relative) || /\.(?:test|proc-test)\./.test(relative))) return false
      return ['dist', 'skills', 'worker', 'local-computer', 'package.json', 'README.md', 'LICENSE.md', 'LICENSE', 'CHANGELOG.md'].includes(parts[0])
    },
  })
}
writeFileSync(join(destination, 'manifest.json'), JSON.stringify({
  v: 1, purpose: 'Local built consumer fixture; not a published npm install',
  cli: `${entry.relative}/dist/bin.js`,
  packages: [...packages.values()].map(({ source, ...item }) => item),
}, null, 2))
writeFileSync(join(destination, 'link-native.mjs'), `import {readFileSync,mkdirSync,symlinkSync} from 'node:fs';
import {dirname,join} from 'node:path';import {fileURLToPath} from 'node:url';
if(process.platform!=='win32')throw new Error('Run with native Windows Node.');
const root=dirname(fileURLToPath(import.meta.url));
const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));
for(const pkg of manifest.packages)for(const [name,target]of Object.entries(pkg.links)){
 const link=join(root,pkg.relative,'node_modules',name);mkdirSync(dirname(link),{recursive:true});
 symlinkSync(join(root,target),link,'junction');
}
process.stdout.write(JSON.stringify({linked:manifest.packages.length,cli:join(root,manifest.cli)})+'\\n');
`)
process.stdout.write(JSON.stringify({ packages: packages.size, destination, cli: entry.relative + '/dist/bin.js' }) + '\n')

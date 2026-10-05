// Reuse installed native external dependencies, copying every Namzu runtime package in the fixture.
// A partly copied workspace splits SDK registries through old provider junctions.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'

const [rootArg, priorArg, destinationArg, mode] = process.argv.slice(2)
if (!rootArg || !priorArg || !destinationArg) throw new Error('Pass repository, prior native fixture and fresh destination.')
if (mode && !['--refresh-unlinked', '--check'].includes(mode)) throw new Error('Only --refresh-unlinked and --check are supported.')
const root = realpathSync(rootArg)
const prior = resolve(priorArg)
const destination = resolve(destinationArg)
for (const path of [prior, destination]) {
  if (!path.startsWith('/mnt/c/Users/') || !path.includes('/AppData/Local/Temp/') ||
      !basename(path).startsWith('namzu-native-consumer-')) throw new Error('Use native consumer directories under Windows user Temp.')
}
const refresh = mode === '--refresh-unlinked'
if (existsSync(destination) !== refresh) throw new Error(refresh ? 'Refresh requires an existing unlinked snapshot.' : 'The snapshot destination must be fresh.')
const workspace = new Map(JSON.parse(execFileSync('pnpm', ['-r', 'list', '--depth', '-1', '--json'],
  { cwd: root, encoding: 'utf8' })).map(item => [item.name, item.path]))
const manifest = JSON.parse(readFileSync(join(prior, 'manifest.json'), 'utf8'))
if (manifest.v !== 1 || !Array.isArray(manifest.packages)) throw new Error('Invalid native fixture manifest.')
const packages = new Map(manifest.packages.map(item => [item.name, item]))
if (refresh) {
  const existing = JSON.parse(readFileSync(join(destination, 'manifest.json'), 'utf8'))
  if (JSON.stringify(existing.packages.map(({ name, relative }) => [name, relative])) !==
      JSON.stringify(manifest.packages.map(({ name, relative }) => [name, relative])) ||
      manifest.packages.some(item => existsSync(join(destination, item.relative, 'node_modules'))))
    throw new Error('Only an unchanged, not yet linked package layout can be refreshed.')
}
const copied = []
for (const item of manifest.packages) {
  if (!item.name.startsWith('@namzu/')) continue
  const source = workspace.get(item.name)
  if (!source) throw new Error(`Missing workspace source: ${item.name}`)
  const json = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  const links = {}
  for (const name of new Set([...Object.keys(json.dependencies ?? {}), ...Object.keys(json.peerDependencies ?? {}), ...Object.keys(json.optionalDependencies ?? {})])) {
    const installedPath = join(source, 'node_modules', name, 'package.json')
    const installed = !name.startsWith('@namzu/') && existsSync(installedPath)
      ? JSON.parse(readFileSync(installedPath, 'utf8')).version : undefined
    const dependency = installed
      ? manifest.packages.find(candidate => candidate.name === name && candidate.version === installed)
      : packages.get(name)
    if (!dependency && !json.optionalDependencies?.[name] && !json.peerDependenciesMeta?.[name]?.optional)
      throw new Error(`The prior native fixture lacks ${name} for ${item.name}; prepare compatible native dependencies first.`)
    if (dependency) links[name] = dependency.relative
  }
  item.links = links
  item.version = json.version
  const publishedRoots = new Set((json.files ?? []).filter(path => !path.startsWith('!')).map(path => path.split('/')[0]))
  copied.push({ item, source, publishedRoots })
}
if (!copied.some(({ item }) => item.name === '@namzu/cli') || !copied.some(({ item }) => item.name === '@namzu/sdk'))
  throw new Error('The fixture must contain CLI and SDK.')
if (mode === '--check') {
  process.stdout.write(JSON.stringify({ preflightPassed: true, copiedWorkspacePackages: copied.map(({ item }) => item.name), noFilesWritten: true }) + '\n')
  process.exit(0)
}
if (!refresh) mkdirSync(destination)
for (const { item, source, publishedRoots } of copied) {
  cpSync(source, join(destination, item.relative), { recursive: true, dereference: true, filter(path) {
    const relative = path.slice(source.length + 1)
    if (!relative) return true
    const parts = relative.split(sep)
    if (parts.some(part => ['node_modules', '__tests__', '__fixtures__'].includes(part))) return false
    if (/\.(?:map|d\.ts|d\.cts)$/.test(relative) || /\.(?:test|proc-test)\./.test(relative)) return false
    return publishedRoots.has(parts[0]) || ['package.json', 'README.md', 'LICENSE.md', 'LICENSE', 'CHANGELOG.md'].includes(parts[0])
  } })
}
const windowsPath = path => path.replace(/^\/mnt\/c\//, 'C:/')
const copiedNames = copied.map(({ item }) => item.name)
writeFileSync(join(destination, 'manifest.json'), JSON.stringify({ ...manifest,
  purpose: 'Coherent local built consumer fixture; native external dependencies reused; not a published install',
  nativeDependencyFixture: windowsPath(prior), copiedWorkspacePackages: copiedNames }, null, 2))
writeFileSync(join(destination, 'link-native.mjs'), `import{readFileSync,mkdirSync,symlinkSync,realpathSync,cpSync}from'node:fs';
import{dirname,join}from'node:path';import{fileURLToPath}from'node:url';import{createRequire}from'node:module';
if(process.platform!=='win32')throw Error('Run with native Windows Node.');
const root=dirname(fileURLToPath(import.meta.url)),m=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));
const copied=new Set(m.copiedWorkspacePackages);
for(const p of m.packages){const dest=join(root,p.relative);if(!copied.has(p.name)){const source=join(m.nativeDependencyFixture,p.relative);mkdirSync(dirname(dest),{recursive:true});cpSync(source,dest,{recursive:true,filter:path=>!path.slice(source.length+1).split(/[\\\\/]/).includes('node_modules')});}}
for(const p of m.packages){const dest=join(root,p.relative);
for(const[name,target]of Object.entries(p.links)){const link=join(dest,'node_modules',name);mkdirSync(dirname(link),{recursive:true});symlinkSync(join(root,target),link,'junction');}}
const sdk=m.packages.find(p=>p.name==='@namzu/sdk'),expected=realpathSync(join(root,sdk.relative));let sdkUsers=0;
for(const p of m.packages){if(!p.links['@namzu/sdk'])continue;const from=createRequire(join(root,p.relative,'package.json'));const actual=realpathSync(dirname(dirname(from.resolve('@namzu/sdk'))));if(actual!==expected)throw Error('Split SDK registry for '+p.name);sdkUsers++;}
process.stdout.write(JSON.stringify({linked:true,copiedWorkspacePackages:copied.size,sdkUsers,singleSdkRoot:true,cli:join(root,m.cli)})+'\\n');
`)
process.stdout.write(JSON.stringify({ destination, copiedWorkspacePackages: copiedNames }) + '\n')

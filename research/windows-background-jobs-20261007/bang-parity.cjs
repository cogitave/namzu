const { spawn } = require('node:child_process')
const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe'
const run = (file, args, env, opts = {}) => new Promise((res) => {
  const c = spawn(file, args, { env, windowsHide: true, windowsVerbatimArguments: opts.verbatim, shell: opts.shell, cwd: process.env.TEMP })
  let out = Buffer.alloc(0); c.stdout.on('data', (d) => (out = Buffer.concat([out, d]))); c.stderr.on('data', (d) => (out = Buffer.concat([out, d])))
  c.on('close', (code) => res({ code, out: out.toString('utf8').replace(/\r/g, '').trim() }))
})
const cases = ['echo hello!', 'echo a!b!c', 'echo caret^^ and ^& amp', 'echo %ComSpec:~0,3%', 'echo "quoted!" & echo second', 'echo 100%% done!', 'git --version 2>nul & echo bang! done', 'echo !PATH:~0,3!']
;(async () => {
  for (const cmd of cases) {
    const direct = await run(cmd, [], process.env, { shell: true })
    const env = { ...process.env, NAMZU_HOST_COMSPEC: comspec, NAMZU_HOST_COMMAND: cmd }
    const wrapped = await run(comspec, ['/d', '/v:on', '/s', '/c', `"chcp 65001>nul & "!NAMZU_HOST_COMSPEC!" /d /s /c "!NAMZU_HOST_COMMAND!""`], env, { verbatim: true })
    console.log(JSON.stringify({ cmd, same: direct.out === wrapped.out && direct.code === wrapped.code, direct, wrapped }))
  }
})()

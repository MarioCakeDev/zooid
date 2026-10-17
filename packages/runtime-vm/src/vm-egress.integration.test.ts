import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SMOLVM_BIN, defaultVmExec, ensureVmMachine, stopVmMachine } from './vm-machine.js'

function smolvmAvailable(): boolean {
  try {
    execSync('smolvm --version', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe.skipIf(!smolvmAvailable())('egress allowlist and operator mounts — real smolvm machine', () => {
  const machine = `zooid-it-egress-${process.pid}`
  let root: string
  let rw: string
  let ro: string

  const guest = (script: string, timeout = '20s') =>
    defaultVmExec(SMOLVM_BIN, ['machine', 'exec', '--timeout', timeout, '--name', machine, '--', 'node', '-e', script])

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'zod128-it-'))
    const workdir = join(root, 'workdir')
    mkdirSync(workdir)
    rw = join(root, 'login')
    ro = join(root, 'ref')
    mkdirSync(rw)
    mkdirSync(ro)
    writeFileSync(join(rw, 'auth.json'), '{"token":"t1"}')
    writeFileSync(join(ro, 'ref.txt'), 'ref')
    await ensureVmMachine({
      spec: {
        name: machine,
        image: 'node:22-alpine',
        workdir,
        cpus: 1,
        memoryMib: 1024,
        allowHosts: ['registry.npmjs.org'],
        mounts: [
          { host: rw, guest: '/login', readOnly: false },
          { host: ro, guest: '/ref', readOnly: true },
        ],
      },
      exec: defaultVmExec,
      stateFile: join(root, 'vm.json'),
      log: () => {},
    })
  }, 300_000)

  afterAll(async () => {
    await stopVmMachine(machine, defaultVmExec).catch(() => {})
    await defaultVmExec(SMOLVM_BIN, ['machine', 'delete', '--name', machine, '--force']).catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }, 120_000)

  it('reaches an allowed host', async () => {
    const r = await guest("fetch('https://registry.npmjs.org/-/ping').then(r=>console.log(r.status))")
    expect(r).toMatchObject({ stdout: '200\n' })
  }, 60_000)

  it('cannot reach any other host', async () => {
    const r = await guest(
      "fetch('https://example.com',{signal:AbortSignal.timeout(15000)}).then(r=>console.log('LEAK',r.status),e=>{console.log('blocked');process.exit(3)})",
    )
    expect(r.stdout).not.toContain('LEAK')
    expect(r.code).not.toBe(0)
  }, 60_000)

  it('a rw mount reads the host file and writes back to the host, as a refreshing login does', async () => {
    const r = await guest(
      "const fs=require('fs');console.log(fs.readFileSync('/login/auth.json','utf8'));fs.writeFileSync('/login/auth.json',JSON.stringify({token:'t2'}))",
    )
    expect(r).toMatchObject({ code: 0, stdout: '{"token":"t1"}\n' })
    expect(readFileSync(join(rw, 'auth.json'), 'utf8')).toBe('{"token":"t2"}')
  }, 60_000)

  it('a ro mount is readable and refuses writes', async () => {
    const r = await guest(
      "const fs=require('fs');console.log(fs.readFileSync('/ref/ref.txt','utf8'));try{fs.writeFileSync('/ref/new.txt','x');console.log('WROTE')}catch(e){console.log(e.code)}",
    )
    expect(r.stdout).toContain('ref')
    expect(r.stdout).not.toContain('WROTE')
    expect(existsSync(join(ro, 'new.txt'))).toBe(false)
  }, 60_000)
})

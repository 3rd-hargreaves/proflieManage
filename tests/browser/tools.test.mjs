import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { launchBrowser } from '../helpers/browser.mjs'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
async function bounded(promise, milliseconds) {
    let timer
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Browser operation did not settle promptly')), milliseconds)
        })])
    } finally { clearTimeout(timer) }
}

test('local browser shares evaluation, protocol events and bounded condition waits', { timeout: 45000 }, async () => {
    const browser = await launchBrowser()
    try {
        await browser.cdp('Runtime.enable')
        let removeListener
        const consoleEvent = new Promise(resolve => {
            removeListener = browser.onEvent(message => {
                if (message.method === 'Runtime.consoleAPICalled') resolve(message.params)
            })
        })
        assert.equal(await browser.js(`document.body.innerHTML='<p>Local browser check</p>';console.log('local-event');document.querySelector('p').textContent`), 'Local browser check')
        assert.equal((await bounded(consoleEvent, 2000)).args[0].value, 'local-event')
        removeListener()
        await browser.until(`document.querySelector('p')?.textContent==='Local browser check'`, 'local content')
        await assert.rejects(browser.until('false', 'intentional unmet condition', 25), /intentional unmet condition/)
        await assert.rejects(browser.js(`throw new Error('visible evaluation failure')`), /visible evaluation failure/)
    } finally { await browser.close() }
    await browser.close()
    await assert.rejects(fs.access(browser.diagnostics.profileDirectory), { code: 'ENOENT' })
})

test('browser disconnect promptly rejects pending commands and repeated cleanup is safe', { timeout: 45000 }, async () => {
    const browser = await launchBrowser({ commandTimeout: 10000 })
    try {
        await browser.cdp('Runtime.enable')
        const rejected = assert.rejects(browser.js('new Promise(() => {})'))
        await browser.cdp('Browser.close').catch(() => {})
        await bounded(rejected, 2000)
    } finally { await browser.close() }
    await browser.close()
    await assert.rejects(fs.access(browser.diagnostics.profileDirectory), { code: 'ENOENT' })
    await bounded(assert.rejects(browser.cdp('Runtime.evaluate', { expression: '1' })), 1000)
})

test('cleanup still closes Chrome after the caller deadline expires', { timeout: 45000 }, async () => {
    let expired = false
    const browser = await launchBrowser({ checkDeadline: () => { if (expired) throw new Error('Caller deadline expired') } })
    try {
        expired = true
        await assert.rejects(browser.cdp('Runtime.evaluate', { expression: '1' }), /Caller deadline expired/)
    } finally { await browser.close() }
    await assert.rejects(fs.access(browser.diagnostics.profileDirectory), { code: 'ENOENT' })
})

test('early Chrome exit reports diagnostics and removes its temporary profile', { timeout: 15000 }, async () => {
    const previous = process.env.CHROME_PATH
    const diagnostics = {}
    process.env.CHROME_PATH = process.execPath
    try {
        await assert.rejects(bounded(launchBrowser({ diagnostics }), 8000), /Chrome exited/)
        assert.notEqual(diagnostics.exitCode, null)
        assert.match(diagnostics.stderr, /bad option|unknown|invalid/i)
        await assert.rejects(fs.access(diagnostics.profileDirectory), { code: 'ENOENT' })
    } finally {
        if (previous === undefined) delete process.env.CHROME_PATH
        else process.env.CHROME_PATH = previous
    }
})

test('production targets and write approval are rejected before network or browser startup', { timeout: 45000 }, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-browser-tools-'))
    try {
        const marker = path.join(directory, 'network-attempted')
        const preload = path.join(directory, 'block-network.mjs')
        await fs.writeFile(preload, `import fs from 'node:fs';globalThis.fetch=()=>{fs.writeFileSync(process.env.BROWSER_TOOLS_NETWORK_MARKER,'attempted');throw new Error('Network forbidden in guard checks')}`)
        const base = {
            productionProjectRef: 'nvunhhyxbbjqgzdhodrw', apiUrl: 'https://nvunhhyxbbjqgzdhodrw.supabase.co',
            appUrl: 'https://proflie-manage.vercel.app', expectedAppOrigin: 'https://proflie-manage.vercel.app',
            publishableKey: 'test-publishable-key', allowProductionWrites: true, backupVerified: true,
            adminUserId: 'f711da08-9c0b-42ee-a20c-a4f83ad46473', adminEmail: 'admin@example.test', adminPassword: 'test-only-password',
        }
        for (const [changes, expected] of [
            [{ appUrl: 'https://not-allowed.example', expectedAppOrigin: 'https://not-allowed.example' }, /deployment origin must be explicitly allowlisted/],
            [{ allowProductionWrites: false }, /Explicit live-write approval is required/],
            [{ backupVerified: false }, /Verified production backups are required/],
        ]) {
            const config = path.join(directory, 'config.json')
            await fs.writeFile(config, JSON.stringify({ ...base, ...changes }))
            const result = await new Promise(resolve => execFile(process.execPath, [
                '--import', pathToFileURL(preload).href, path.join(project, 'tests/integration/production.mjs'), config, '--write',
            ], { cwd: project, windowsHide: true, timeout: 10000, env: {
                ...process.env, CHROME_PATH: path.join(directory, 'missing-chrome'), BROWSER_TOOLS_NETWORK_MARKER: marker,
            } }, (error, stdout, stderr) => resolve({ error, output: stdout + stderr })))
            assert.equal(result.error?.code, 1)
            assert.match(result.output, expected)
            await assert.rejects(fs.access(marker), { code: 'ENOENT' })
        }
    } finally {
        const resolved = path.resolve(directory)
        assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('profile-browser-tools-'))
        await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
})

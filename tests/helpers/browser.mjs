import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

export const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

async function findChrome() {
    const candidates = process.env.CHROME_PATH ? [process.env.CHROME_PATH] : process.platform === 'win32'
        ? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')]
        : process.platform === 'darwin'
            ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
            : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/google/chrome/chrome']
    for (const file of candidates) { try { await fs.access(file); return file } catch {} }
    throw new Error('Chrome/Chromium executable not found. Set CHROME_PATH to its installed executable.')
}

async function debugPort() {
    const server = http.createServer()
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const port = server.address().port
    await new Promise(resolve => server.close(resolve))
    return port
}

export async function launchBrowser({ args = [], checkDeadline = () => {}, commandTimeout = 15000, diagnostics = {} } = {}) {
    const pending = new Map(), listeners = new Set()
    let chrome, ws, profile, launchError, sequence = 0, closing = false, closePromise
    Object.assign(diagnostics, { executable: null, exitCode: null, signal: null, stderr: '', profileDirectory: null })
    const rejectPending = error => {
        for (const entry of pending.values()) entry.reject(error)
        pending.clear()
    }
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        if (ws?.readyState !== WebSocket.OPEN) { reject(new Error(`CDP disconnected before ${method}`)); return }
        const id = ++sequence
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)) }, commandTimeout)
        const entry = { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } }
        pending.set(id, entry)
        try { ws.send(JSON.stringify({ id, method, params })) } catch (error) { pending.delete(id); entry.reject(error) }
    })
    const cdp = (method, params) => {
        try { checkDeadline() } catch (error) { return Promise.reject(error) }
        if (closing) return Promise.reject(new Error('Browser is closing'))
        return send(method, params)
    }
    const close = () => {
        if (closePromise) return closePromise
        closing = true
        listeners.clear()
        closePromise = (async () => {
            if (ws?.readyState === WebSocket.OPEN) {
                try { await Promise.race([send('Browser.close'), pause(1000)]) } catch {}
            }
            rejectPending(new Error('CDP browser closed'))
            ws?.close()
            if (chrome?.pid && chrome.exitCode === null && chrome.signalCode === null) {
                const exited = new Promise(resolve => chrome.once('exit', resolve))
                chrome.kill()
                await Promise.race([exited, pause(2000)])
                assert(chrome.exitCode !== null || chrome.signalCode !== null, 'Chrome did not exit during cleanup')
            }
            if (profile) {
                const target = path.resolve(profile)
                assert(target.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(target).startsWith('profile-browser-check-'))
                await fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
            }
        })()
        return closePromise
    }
    try {
        checkDeadline()
        diagnostics.executable = await findChrome()
        profile = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-browser-check-'))
        diagnostics.profileDirectory = profile
        const port = await debugPort()
        chrome = spawn(diagnostics.executable, [
            '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
            '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
            ...args, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
        ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
        chrome.stderr.on('data', chunk => { diagnostics.stderr = (diagnostics.stderr + chunk.toString()).slice(-6000) })
        chrome.on('error', error => { launchError = error })
        chrome.on('exit', (code, signal) => {
            diagnostics.exitCode = code; diagnostics.signal = signal
            rejectPending(new Error('CDP Chrome exited'))
        })
        let target
        const deadline = Date.now() + 30000
        while (Date.now() < deadline) {
            checkDeadline()
            if (launchError) throw launchError
            if (chrome.exitCode !== null || chrome.signalCode !== null) throw new Error('Chrome exited before its debugging endpoint was ready')
            try {
                target = (await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) })).json()).find(entry => entry.type === 'page')
                if (target) break
            } catch {}
            await pause(100)
        }
        assert(target, 'Chrome did not start; set CHROME_PATH to a Chromium executable')
        ws = new WebSocket(target.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('CDP connection timed out')), 10000)
            ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
            ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')) }, { once: true })
            ws.addEventListener('close', () => { clearTimeout(timer); reject(new Error('CDP connection closed')) }, { once: true })
        })
        const disconnect = () => rejectPending(new Error('CDP connection closed'))
        ws.addEventListener('close', disconnect); ws.addEventListener('error', disconnect)
        ws.addEventListener('message', event => {
            const message = JSON.parse(event.data)
            if (message.id) {
                const entry = pending.get(message.id); pending.delete(message.id)
                if (entry) { if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result) }
            } else if (!closing) for (const listener of listeners) listener(message)
        })
        const js = async expression => {
            const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
            if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
            return result.result.value
        }
        const until = async (expression, label, timeout = 20000) => {
            const deadline = Date.now() + timeout
            while (Date.now() < deadline) { checkDeadline(); if (await js(expression)) return; await pause(75) }
            throw new Error(`Timed out: ${label}`)
        }
        return { cdp, js, until, close, diagnostics, onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener) } }
    } catch (error) {
        await close()
        throw error
    }
}

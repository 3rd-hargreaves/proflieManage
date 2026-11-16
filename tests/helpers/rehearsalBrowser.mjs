import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const listen = server => new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address().port) })
})

async function findChrome() {
    const candidates = process.env.CHROME_PATH ? [process.env.CHROME_PATH] : process.platform === 'win32'
        ? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')]
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/opt/google/chrome/chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    for (const file of candidates) { try { await fs.access(file); return file } catch {} }
    throw new Error('Chrome/Chromium is required for real Supabase browser checks.')
}

export async function createRehearsalBrowser({ project, dist, headers, rewrites, apiOrigin }) {
    const errors = [], violations = [], unexpectedRequests = [], apiRequests = []
    const pending = new Map(), handlers = new Set()
    let server, chrome, ws, cdp, appUrl, temp
    const stop = async () => {
        if (cdp) { try { await Promise.race([cdp('Browser.close'), pause(1000)]) } catch {} }
        for (const entry of pending.values()) entry.reject(new Error('Rehearsal browser finished'))
        pending.clear(); ws?.close(); chrome?.kill()
        if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
        if (temp) {
            const target = path.resolve(temp)
            assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(target).startsWith('profile-rehearsal-browser-'))
            await fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
        }
    }
    try {
        temp = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-rehearsal-browser-'))
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' }
        server = http.createServer(async (request, response) => {
            try {
                const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
                for (const { key, value } of headers) response.setHeader(key, value)
                const rewritten = rewrites.find(rule => rule.source === pathname || (rule.source.endsWith('/:path*')
                    && (pathname === rule.source.slice(0, -7) || pathname.startsWith(rule.source.slice(0, -7) + '/'))))?.destination
                const destination = rewritten || (pathname === '/' ? '/index.html' : pathname)
                const file = path.resolve(dist, `.${destination}`)
                if (!file.startsWith(path.resolve(dist) + path.sep)) { response.writeHead(403); response.end(); return }
                let bytes
                try { bytes = await fs.readFile(file) } catch { response.writeHead(404); response.end(); return }
                response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' })
                response.end(bytes)
            } catch (error) {
                errors.push(`Static test server: ${error.message}`)
                if (!response.headersSent) response.writeHead(500)
                response.end()
            }
        })
        appUrl = `http://127.0.0.1:${await listen(server)}`
        const portServer = http.createServer(), debugPort = await listen(portServer)
        await new Promise(resolve => portServer.close(resolve))
        const chromePath = await findChrome()
        chrome = spawn(chromePath, [
            '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
            '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
            '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
            `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(temp, 'chrome')}`, 'about:blank',
        ], { cwd: project, windowsHide: true, stdio: 'ignore' })
        let launchError, target
        chrome.on('error', error => { launchError = error })
        for (let attempt = 0; attempt < 100; attempt++) {
            if (launchError) throw launchError
            try {
                const response = await fetch(`http://127.0.0.1:${debugPort}/json`, { signal: AbortSignal.timeout(1500) })
                target = (await response.json()).find(entry => entry.type === 'page')
                if (target) break
            } catch {}
            await pause(100)
        }
        if (!target) throw new Error('Rehearsal Chrome did not start.')
        ws = new WebSocket(target.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Rehearsal CDP connection timed out')), 10000)
            ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
            ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Rehearsal CDP failed')) }, { once: true })
        })
        let sequence = 0
        cdp = (method, params = {}) => new Promise((resolve, reject) => {
            const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)) }, 20000)
            pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
            ws.send(JSON.stringify({ id, method, params }))
        })
        ws.addEventListener('message', event => {
            const message = JSON.parse(event.data)
            if (message.id) {
                const entry = pending.get(message.id); pending.delete(message.id)
                if (entry) { if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result) }
            }
            if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text)
            if (message.method === 'Log.entryAdded' && message.params.entry.source === 'security') violations.push(message.params.entry.text)
            if (message.method === 'Page.javascriptDialogOpening') void cdp('Page.handleJavaScriptDialog', { accept: true }).catch(error => errors.push(error.message))
            if (message.method === 'Fetch.requestPaused') {
                const task = (async () => {
                    const { requestId, request } = message.params
                    const url = new URL(request.url)
                    if (url.origin === appUrl || ['about:', 'blob:', 'data:'].includes(url.protocol)) return cdp('Fetch.continueRequest', { requestId })
                    if (url.origin === apiOrigin) {
                        // No Auth, REST or Storage response is mocked or proxied.
                        apiRequests.push({ method: request.method, path: url.pathname })
                        return cdp('Fetch.continueRequest', { requestId })
                    }
                    if (url.origin === 'https://cdn.jsdelivr.net' && url.pathname.endsWith('.css')) return cdp('Fetch.fulfillRequest', {
                        requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/css' }], body: '',
                    })
                    unexpectedRequests.push({ origin: url.origin, path: url.pathname })
                    return cdp('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
                })().catch(error => errors.push(`Request interception: ${error.message}`))
                handlers.add(task); void task.finally(() => handlers.delete(task))
            }
        })
        ws.addEventListener('close', () => { for (const entry of pending.values()) entry.reject(new Error('Rehearsal CDP closed')); pending.clear() })
        const js = async expression => {
            const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
            if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
            return result.result.value
        }
        await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('DOM.enable'); await cdp('Log.enable')
        await cdp('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
        await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `window.__rehearsalViolations=[];document.addEventListener('securitypolicyviolation',event=>window.__rehearsalViolations.push({directive:event.effectiveDirective,blocked:event.blockedURI}));` })
        const until = async (expression, label, timeout = 20000) => {
            const deadline = Date.now() + timeout
            while (Date.now() < deadline) { if (await js(expression)) return; await pause(75) }
            throw new Error(`Timed out: ${label}`)
        }
        return {
            appUrl, cdp, js, until, errors, violations, unexpectedRequests, apiRequests, close: stop,
            navigate: async route => { assert.ok(route.startsWith('/') && !route.startsWith('//')); await cdp('Page.navigate', { url: appUrl + route }); await pause(100) },
            set: (selector, value) => js(`(()=>{const field=document.querySelector(${JSON.stringify(selector)});const proto=field instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(field,${JSON.stringify(value)});field.dispatchEvent(new Event('input',{bubbles:true}));})()`),
            click: selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`),
            button: label => js(`(()=>{const button=[...document.querySelectorAll('button')].find(entry=>entry.textContent.trim()===${JSON.stringify(label)});if(!button)throw new Error('Button unavailable');button.click()})()`),
            key: async (code, key = code) => {
                const virtual = { Space: 32, Enter: 13, ArrowDown: 40, ArrowUp: 38, Escape: 27 }[code]
                await cdp('Input.dispatchKeyEvent', { type: 'keyDown', code, key, windowsVirtualKeyCode: virtual })
                await cdp('Input.dispatchKeyEvent', { type: 'keyUp', code, key, windowsVirtualKeyCode: virtual })
                await pause(200)
            },
            file: async (selector, files) => {
                const { root } = await cdp('DOM.getDocument')
                const { nodeId } = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector })
                await cdp('DOM.setFileInputFiles', { nodeId, files })
                await pause(100)
            },
            screenshot: async file => {
                const capture = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
                await fs.writeFile(file, Buffer.from(capture.data, 'base64'))
            },
        }
    } catch (error) {
        await stop()
        throw error
    }
}

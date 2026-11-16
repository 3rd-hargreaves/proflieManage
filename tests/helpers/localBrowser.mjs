import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { launchBrowser, pause } from './browser.mjs'

const listen = server => new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address().port) })
})

export async function createLocalBrowser({ dist, headers, rewrites, apiOrigin }) {
    const errors = [], violations = [], unexpectedRequests = [], apiRequests = []
    const handlers = new Set()
    let server, browser, appUrl
    const stop = async () => {
        try { await Promise.allSettled([...handlers]); await browser?.close() } finally {
            if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
        }
    }
    try {
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
        browser = await launchBrowser({ commandTimeout: 20000, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'] })
        const { cdp, js, until, onEvent } = browser
        onEvent(message => {
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
        await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('DOM.enable'); await cdp('Log.enable')
        await cdp('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
        await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `window.__rehearsalViolations=[];document.addEventListener('securitypolicyviolation',event=>window.__rehearsalViolations.push({directive:event.effectiveDirective,blocked:event.blockedURI}));` })
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

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Only an isolated production build, fresh browser profile, and mocked API are used.
// CDP intercepts all non-local requests; DNS is also disabled for external hosts.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const deadline = Date.now() + 180000
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const checkDeadline = () => {
    if (Date.now() > deadline) throw new Error('Production security checks exceeded their 3 minute deadline')
}
const passed = [], errors = [], requests = [], securityLogs = [], mockedExternal = [], unexpectedExternal = []
const pending = new Map(), handlers = new Set()
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=', 'base64')
const user = {
    id: '11111111-1111-4111-8111-111111111111', email: 'admin@example.test',
    aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email' },
    user_metadata: {}, created_at: '2026-01-01T00:00:00Z',
}
const token = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({
    sub: user.id, aud: 'authenticated', role: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000),
})).toString('base64url')}.test-only-signature`
const session = {
    access_token: token, refresh_token: 'security-test-refresh-token', token_type: 'bearer',
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user,
}
const site = {
    profile: { id: 1, name: '보안 검증 프로필', status_message: '모의 데이터', profile_image_path: 'profile/security-test.png' },
    theme: { id: 1, main_color: '#7841ab', background_color: '#fce8ef', card_background_color: '#ffffff', typo_color: '#26232a' },
    sections: [{ id: 10, sort_order: 1, title: '보안 검증 섹션', content: '*정상 표시*' }],
    keywords: [{ id: 30, sort_order: 1, content: '보안 검증' }],
    feed: [{ id: 20, sort_order: 1, image_path: 'feed/security-test.png' }],
}
const check = (condition, label) => { assert.ok(condition, label); passed.push(label) }
async function findChrome() {
    const candidates = process.env.CHROME_PATH ? [process.env.CHROME_PATH] : process.platform === 'win32'
        ? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')]
        : process.platform === 'darwin'
            ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
            : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/google/chrome/chrome']
    for (const candidate of candidates) {
        try { await fs.access(candidate); return candidate } catch {}
    }
    throw new Error('Chrome/Chromium executable not found. Set CHROME_PATH to its installed executable.')
}
const listen = server => new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address().port) })
})
const freePort = async () => {
    const server = http.createServer(), port = await listen(server)
    await new Promise(resolve => server.close(resolve))
    return port
}
async function stopProcess(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    child.kill()
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(2000)])
}
let temp, build, chrome, server, ws, cdp, js, appUrl, launchError
let buildLogs = ''
try {
    const chromePath = await findChrome()
    const config = JSON.parse(await fs.readFile(path.join(project, 'vercel.json'), 'utf8'))
    const globalHeaders = config.headers.find(rule => rule.source === '/(.*)')?.headers
    assert.ok(globalHeaders, 'vercel.json must apply security headers to every path')
    const configured = new Map(globalHeaders.map(header => [header.key.toLowerCase(), header.value]))
    const policy = configured.get('content-security-policy')
    assert.ok(policy, 'Missing Content-Security-Policy')
    const directives = new Map(policy.split(';').map(part => part.trim().split(/\s+/)).filter(([name]) => name).map(([name, ...values]) => [name, values]))
    const connect = directives.get('connect-src') || []
    const apiOrigin = connect.find(value => /^https:\/\/[^/]+\.supabase\.co$/.test(value))
    check(!!apiOrigin && connect.length === 2 && connect.includes("'self'"), 'CSP connect-src는 self와 정확한 Supabase 호스트만 허용')
    check(JSON.stringify(directives.get('script-src')) === JSON.stringify(["'self'"]), 'CSP script-src는 inline·eval·외부 스크립트를 허용하지 않음')
    check(JSON.stringify(directives.get('frame-ancestors')) === JSON.stringify(["'none'"])
        && JSON.stringify(directives.get('object-src')) === JSON.stringify(["'none'"])
        && JSON.stringify(directives.get('base-uri')) === JSON.stringify(["'none'"])
        && JSON.stringify(directives.get('form-action')) === JSON.stringify(["'self'"]), 'CSP 프레임·객체·base·폼 제한 설정')

    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-security-check-'))
    const dist = path.join(temp, 'dist'), picture = path.join(temp, 'security-test.png')
    await fs.writeFile(picture, image)
    // envDir:false prevents Vite from reading actual .env files.
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITE_')))
    build = spawn(process.execPath, ['--input-type=module', '--eval', `
        import { build } from 'vite';
        await build({ envDir: false, build: { outDir: process.env.SECURITY_TEST_DIST, emptyOutDir: true } });
    `], {
        cwd: project, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...cleanEnv, SECURITY_TEST_DIST: dist,
            VITE_SUPABASE_URL: apiOrigin, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_security_test_only',
            VITE_ADMIN_EMAIL: user.email, VITE_ADMIN_USER_ID: user.id, VITE_SUPABASE_STORAGE_BUCKET: 'site-images',
        },
    })
    for (const stream of [build.stdout, build.stderr]) stream.on('data', chunk => { buildLogs = (buildLogs + chunk).slice(-4000) })
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { build.kill(); reject(new Error('Isolated production build timed out')) }, 60000)
        build.once('error', error => { clearTimeout(timer); reject(error) })
        build.once('exit', code => {
            clearTimeout(timer)
            if (code === 0) resolve()
            else reject(new Error(`Production build failed (${code}): ${buildLogs}`))
        })
    })
    const index = await fs.readFile(path.join(dist, 'index.html'), 'utf8')
    const bundlePath = index.match(/<script[^>]+src="([^"]+)"/)?.[1]
    assert.ok(bundlePath, 'Production index must reference its module bundle')
    const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' }
    server = http.createServer(async (request, response) => {
        try {
            const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
            requests.push({ method: request.method, path: pathname })
            for (const { key, value } of globalHeaders) response.setHeader(key, value)
            // A real same-origin script checks unsafe-eval without CDP's eval bypass.
            if (pathname === '/__security-eval.js') {
                response.writeHead(200, { 'Content-Type': contentTypes['.js'] })
                response.end("window.__selfScriptRan=true;try{Function('window.__unsafeEvalRan=true')()}catch(error){window.__unsafeEvalBlocked=error.name}")
                return
            }
            const rewrite = config.rewrites?.find(rule => rule.source === pathname)?.destination
            const destination = rewrite || (pathname === '/' ? '/index.html' : pathname)
            const filename = path.resolve(dist, `.${destination}`)
            if (!filename.startsWith(path.resolve(dist) + path.sep)) { response.writeHead(403); response.end(); return }
            let bytes
            try { bytes = await fs.readFile(filename) } catch { response.writeHead(404, { 'Content-Type': 'text/plain' }); response.end('Not found'); return }
            response.writeHead(200, { 'Content-Type': contentTypes[path.extname(filename)] || 'application/octet-stream' })
            response.end(bytes)
        } catch (error) {
            errors.push(`Local server: ${error.message}`)
            if (!response.headersSent) response.writeHead(500)
            response.end()
        }
    })
    appUrl = `http://127.0.0.1:${await listen(server)}`
    const requiredHeaders = {
        'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
        'referrer-policy': 'strict-origin-when-cross-origin',
        'permissions-policy': 'camera=(), microphone=(), geolocation=()',
        'content-security-policy': policy,
    }
    for (const route of ['/', '/edit', '/edit/', '/manage.html', '/manage.html/', bundlePath]) {
        const response = await fetch(appUrl + route, { signal: AbortSignal.timeout(3000) }), body = await response.text()
        check(response.status === 200 && Object.entries(requiredHeaders).every(([key, value]) => response.headers.get(key) === value)
            && (route === bundlePath ? response.headers.get('content-type')?.startsWith('application/javascript') && !body.startsWith('<') : body === index), `${route} 프로덕션 응답·보안 헤더·rewrite 정상`)
    }
    const debugPort = await freePort()
    chrome = spawn(chromePath, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
        `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(temp, 'chrome')}`, 'about:blank',
    ], { windowsHide: true, stdio: 'ignore' })
    chrome.on('error', error => { launchError = error })
    let target
    for (let attempt = 0; attempt < 100; attempt++) {
        checkDeadline()
        if (launchError) throw launchError
        try {
            target = (await (await fetch(`http://127.0.0.1:${debugPort}/json`, { signal: AbortSignal.timeout(2000) })).json()).find(entry => entry.type === 'page')
            if (target) break
        } catch {}
        await pause(100)
    }
    if (!target) throw new Error('Chrome did not start; set CHROME_PATH to a Chromium executable')
    ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CDP connection timed out')), 10000)
        ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
        ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')) }, { once: true })
    })
    let sequence = 0
    cdp = (method, params = {}) => new Promise((resolve, reject) => {
        try { checkDeadline() } catch (error) { reject(error); return }
        if (ws.readyState !== WebSocket.OPEN) { reject(new Error(`CDP disconnected before ${method}`)); return }
        const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)) }, 15000)
        pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
        ws.send(JSON.stringify({ id, method, params }))
    })
    const mockRequest = async params => {
        const { requestId, request } = params, url = new URL(request.url)
        if (url.origin === appUrl || ['about:', 'blob:', 'data:'].includes(url.protocol)) { await cdp('Fetch.continueRequest', { requestId }); return }
        mockedExternal.push({ origin: url.origin, method: request.method, path: url.pathname })
        const headers = [
            { name: 'Access-Control-Allow-Origin', value: appUrl }, { name: 'Access-Control-Allow-Headers', value: '*' },
            { name: 'Access-Control-Allow-Methods', value: 'GET,POST,DELETE,OPTIONS' },
        ]
        const fulfill = (status, type, bytes) => cdp('Fetch.fulfillRequest', {
            requestId, responseCode: status, responseHeaders: [...headers, { name: 'Content-Type', value: type }],
            ...(bytes ? { body: Buffer.from(bytes).toString('base64') } : {}),
        })
        if (url.origin === apiOrigin) {
            if (request.method === 'OPTIONS') { await fulfill(204, 'text/plain'); return }
            if (request.method === 'POST' && url.pathname === '/rest/v1/rpc/load_site') { await fulfill(200, 'application/json', JSON.stringify(site)); return }
            if (request.method === 'POST' && url.pathname === '/auth/v1/token') { await fulfill(200, 'application/json', JSON.stringify(session)); return }
            if (request.method === 'GET' && url.pathname === '/auth/v1/user') { await fulfill(200, 'application/json', JSON.stringify(user)); return }
            if (request.method === 'GET' && url.pathname.startsWith('/storage/v1/object/public/site-images/')) { await fulfill(200, 'image/png', image); return }
        }
        if (url.origin === 'https://cdn.jsdelivr.net' && request.method === 'GET' && url.pathname.endsWith('.css')) { await fulfill(200, 'text/css', ':root{--security-cdn-css:loaded}'); return }
        unexpectedExternal.push({ method: request.method, url: request.url })
        await cdp('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
    }
    ws.addEventListener('message', event => {
        const message = JSON.parse(event.data)
        if (message.id) {
            const task = pending.get(message.id); pending.delete(message.id)
            if (task) { if (message.error) task.reject(new Error(JSON.stringify(message.error))); else task.resolve(message.result) }
        }
        if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text)
        if (message.method === 'Log.entryAdded' && message.params.entry.source === 'security') securityLogs.push(message.params.entry.text)
        if (message.method === 'Page.javascriptDialogOpening') void cdp('Page.handleJavaScriptDialog', { accept: true }).catch(error => errors.push(error.message))
        if (message.method === 'Fetch.requestPaused') {
            const task = mockRequest(message.params).catch(error => errors.push(`Mock interception: ${error.message}`))
            handlers.add(task); void task.finally(() => handlers.delete(task))
        }
    })
    const disconnect = () => { for (const task of pending.values()) task.reject(new Error('CDP connection closed')); pending.clear() }
    ws.addEventListener('close', disconnect); ws.addEventListener('error', disconnect)
    js = async expression => {
        const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
        return result.result.value
    }
    const until = async (expression, label, timeout = 15000) => {
        const started = Date.now()
        while (Date.now() - started < timeout) { checkDeadline(); if (await js(expression)) return; await pause(50) }
        throw new Error(`Timed out: ${label}`)
    }
    const navigate = async route => { await cdp('Page.navigate', { url: appUrl + route }); await pause(150) }
    const setInput = (selector, value) => js(`(() => {const field=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(value)});field.dispatchEvent(new Event('input',{bubbles:true}));})()`)
    await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('DOM.enable'); await cdp('Log.enable')
    await cdp('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
    await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `window.__policyViolations=[];document.addEventListener('securitypolicyviolation',event=>window.__policyViolations.push({directive:event.effectiveDirective,blocked:event.blockedURI}));` })
    await navigate('/')
    await until(`document.querySelector('.profileName')?.textContent === ${JSON.stringify(site.profile.name)}`, 'main RPC content')
    check(await js(`document.title === ${JSON.stringify(site.profile.name)} && document.querySelector('.sectionContent strong')?.textContent === '정상 표시'`)
        && mockedExternal.some(request => request.path === '/rest/v1/rpc/load_site'), 'CSP 아래 production bundle·Supabase 메인 RPC·서식 표시 정상')
    await until(`getComputedStyle(document.documentElement).getPropertyValue('--security-cdn-css').trim() === 'loaded'`, 'CDN stylesheet')
    check(mockedExternal.some(request => request.origin === 'https://cdn.jsdelivr.net'), '허용된 CDN CSS가 실제 브라우저에서 적용됨')
    await until(`document.querySelector('.profileImg')?.naturalWidth === 1`, 'Supabase image')
    check(await js(`getComputedStyle(document.documentElement).getPropertyValue('--main-color').trim() === '#7841ab'`), 'Supabase 공개 이미지와 inline 테마 CSS 허용')
    check(await js(`new Promise(resolve=>{const image=new Image();image.onload=()=>resolve(image.naturalWidth===1);image.onerror=()=>resolve(false);image.src='data:image/png;base64,${image.toString('base64')}';document.body.append(image)})`), 'data 이미지 허용')
    check(await js('window.__policyViolations.length === 0'), '정상 메인 화면에 CSP 위반 없음')

    await js(`(async()=>{
        const inline=document.createElement('script');inline.textContent='window.__inlineScriptRan=true';document.body.append(inline);
        const button=document.createElement('button');button.setAttribute('onclick','window.__inlineHandlerRan=true');document.body.append(button);button.click();
        const script=src=>new Promise(resolve=>{const node=document.createElement('script');node.src=src;node.onload=node.onerror=resolve;document.body.append(node)});
        await Promise.all([script('/__security-eval.js'),script('https://blocked.example.test/probe.js'),fetch('https://blocked.example.test/connect').then(()=>{window.__externalConnectRan=true}).catch(()=>{})]);
        const frame=document.createElement('iframe');frame.src='https://blocked.example.test/frame';document.body.append(frame);
    })()`)
    await until(`window.__selfScriptRan && window.__policyViolations.some(entry=>entry.directive==='frame-src')`, 'script/connect/frame CSP events')
    const violations = await js('window.__policyViolations')
    check(await js('window.__inlineScriptRan !== true && window.__inlineHandlerRan !== true') && violations.some(entry => entry.blocked === 'inline' && entry.directive.startsWith('script-src')), 'inline script·이벤트 handler 실행 차단')
    check(await js('window.__selfScriptRan === true && window.__unsafeEvalRan !== true && window.__unsafeEvalBlocked === "EvalError"') && violations.some(entry => entry.blocked === 'eval'), 'self 스크립트는 허용하고 실제 script 안의 unsafe-eval은 차단')
    check(violations.some(entry => entry.directive.startsWith('script-src') && entry.blocked.startsWith('https://blocked.example.test')), '허용되지 않은 외부 script 차단')
    check(await js('window.__externalConnectRan !== true') && violations.some(entry => entry.directive === 'connect-src'), '허용되지 않은 외부 connect 차단')
    check(violations.some(entry => entry.directive === 'frame-src'), '허용되지 않은 외부 iframe 차단')
    await js(`(()=>{const frame=document.createElement('iframe');frame.id='ancestor-probe';frame.src='/';document.body.append(frame)})()`)
    await until(`(()=>{const frame=document.querySelector('#ancestor-probe');try{return !frame.contentDocument || !frame.contentWindow.location.href.startsWith(location.origin)}catch{return true}})()`, 'frame ancestor rejection')
    const ancestorStarted = Date.now()
    while (!securityLogs.some(text => /frame-ancestors|X-Frame-Options/i.test(text)) && Date.now() - ancestorStarted < 5000) await pause(50)
    check(securityLogs.some(text => /frame-ancestors|X-Frame-Options/i.test(text)), 'frame-ancestors·X-Frame-Options로 동일 출처의 iframe 삽입도 차단')
    check(unexpectedExternal.length === 0, '차단 대상 외부 요청은 네트워크 mock 단계에도 도달하지 않음')
    for (const route of ['/edit', '/manage.html']) {
        await navigate(route)
        await until(`location.pathname === '/' && document.querySelector('.edit')?.getAttribute('aria-label') === '관리자 로그인 열기'`, `${route} signed-out guard`)
        check(await js('!document.querySelector("#profileName")'), `${route} 직접 진입은 bundle 로드 후 미인증 편집을 차단`)
    }
    await js('document.querySelector(".edit").click()')
    await until('!!document.querySelector("#loginModal input")', 'production login modal')
    await setInput('#loginModal input', 'security-test-password')
    await js('document.querySelector("#loginModal button[type=submit]").click()')
    await until('!!document.querySelector("#profileName") && !document.querySelector("#loginModal")', 'production mocked login')
    check(mockedExternal.some(request => request.method === 'POST' && request.path === '/auth/v1/token') && mockedExternal.some(request => request.path === '/auth/v1/user')
        && await js(`document.querySelector('#profileName').value === ${JSON.stringify(site.profile.name)}`), 'production CSP 아래 모의 로그인·서버 사용자 확인·편집 lazy bundle 정상')
    for (const route of ['/edit', '/manage.html']) {
        await navigate(route); await until('!!document.querySelector("#profileName")', `${route} authenticated direct entry`)
        check(await js(`location.pathname === ${JSON.stringify(route)} && document.querySelector('#profileName').value === ${JSON.stringify(site.profile.name)}`), `${route} 인증된 직접 진입은 rewrite와 편집 bundle 정상`)
    }
    const { root } = await cdp('DOM.getDocument'), { nodeId } = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector: '#profileFile' })
    await cdp('DOM.setFileInputFiles', { nodeId, files: [picture] })
    await until(`document.querySelector('img[alt="프로필 이미지 미리보기"]')?.src.startsWith('blob:') && document.querySelector('img[alt="프로필 이미지 미리보기"]').naturalWidth === 1`, 'blob profile preview')
    check(await js('window.__policyViolations.length === 0'), '실제 편집 파일의 blob 미리보기가 CSP 위반 없이 표시됨')
    await Promise.all(handlers)
    check(unexpectedExternal.length === 0 && !mockedExternal.some(request => /save_site|\/storage\/v1\/object\//.test(request.path) && request.method !== 'GET'), '실제 외부 연결·DB 저장·Storage 쓰기 없이 허용 요청을 모두 mock 처리')
    check(errors.length === 0, 'production 브라우저 실행 예외 없음')
    console.log(JSON.stringify({ passed: passed.length, checks: passed, mockedExternal: mockedExternal.length, unexpectedExternal, errors }, null, 2))
} catch (error) {
    const diagnostics = js ? await js('({path:location.pathname,text:document.body.innerText,violations:window.__policyViolations})').catch(() => null) : null
    console.error(JSON.stringify({ passed: passed.length, checks: passed, errors, diagnostics, unexpectedExternal, securityLogs, buildLogs, failure: error.stack, cause: error.cause?.message }, null, 2))
    process.exitCode = 1
} finally {
    if (cdp) { try { await Promise.race([cdp('Browser.close'), pause(1000)]) } catch {} }
    for (const task of pending.values()) task.reject(new Error('Production security test finished'))
    pending.clear(); ws?.close()
    await stopProcess(chrome); await stopProcess(build)
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    if (temp) {
        const resolved = path.resolve(temp)
        if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('profile-security-check-')) { console.error('Unsafe temporary cleanup path'); process.exitCode = 1 }
        else { await pause(300); await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
    }
}

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const apiOrigin = 'https://nvunhhyxbbjqgzdhodrw.supabase.co'
const allowedAppOrigins = new Set(['https://proflie-manage.vercel.app'])
const writeMode = process.argv.includes('--write')
const checks = [], original = new Map(), imageHashes = new Map(), owned = new Set(), ownedFiles = new Set()
const runName = `운영 검증 ${Date.now()}-${randomUUID().slice(0, 8)}`
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=', 'base64')
const fingerprint = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const check = (condition, label) => { assert.ok(condition, label); checks.push(label) }
let config, anon, admin, browser, temp, baseline

function safeError(error) {
    return [config?.adminPassword, config?.publishableKey].filter(Boolean)
        .reduce((message, secret) => message.split(secret).join('[redacted]'), error instanceof Error ? error.message : String(error))
}

async function rpc(client, name, parameters = {}) {
    const { data, error } = await client.rpc(name, parameters).abortSignal(AbortSignal.timeout(20000))
    if (error) throw new Error(`${name} failed (${error.code || 'request'})`)
    return data
}

async function publicBytes(file) {
    const target = new URL(anon.storage.from(config.storageBucket || 'site-images').getPublicUrl(file).data.publicUrl)
    assert.equal(target.origin, apiOrigin)
    target.searchParams.set('verify', randomUUID())
    const response = await fetch(target, { redirect: 'error', headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15000) })
    if (response.status === 404) return null
    if (!response.ok) {
        const failure = await response.json().catch(() => null)
        if (response.status === 400 && Number(failure?.statusCode) === 404) return null
        throw new Error(`Production image read failed (${response.status})`)
    }
    return Buffer.from(await response.arrayBuffer())
}

async function cleanFiles(files) {
    if (!files.length) return
    assert(writeMode && config.allowProductionWrites === true)
    const references = new Set(await rpc(admin, 'load_image_references'))
    const candidates = files.filter(file => ownedFiles.has(file) && !references.has(file))
    if (!candidates.length) return
    const { error } = await admin.storage.from(config.storageBucket || 'site-images').remove(candidates)
    if (error) throw new Error(`Production test-image cleanup failed (${error.statusCode || 'request'})`)
    for (const file of candidates) {
        const separator = file.lastIndexOf('/')
        const { data, error: listError } = await admin.storage.from(config.storageBucket || 'site-images').list(file.slice(0, separator), { search: file.slice(separator + 1) })
        assert(!listError && Array.isArray(data) && !data.some(entry => entry.name === file.slice(separator + 1)), 'A test file remains after cleanup')
    }
}

async function launchBrowser(appOrigin) {
    const debugServer = http.createServer()
    await new Promise(resolve => debugServer.listen(0, '127.0.0.1', resolve))
    const port = debugServer.address().port
    await new Promise(resolve => debugServer.close(resolve))
    const candidates = process.env.CHROME_PATH ? [process.env.CHROME_PATH] : process.platform === 'win32'
        ? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    let executable
    for (const file of candidates) { try { await fs.access(file); executable = file; break } catch {} }
    assert(executable, 'Chrome is required for production browser verification')
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-production-browser-'))
    const child = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
        `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
    const pending = new Map(), errors = [], violations = [], unexpected = [], requests = []
    let ws, call, target, launchError
    child.on('error', error => { launchError = error })
    const close = async () => {
        if (call) { try { await Promise.race([call('Browser.close'), pause(1000)]) } catch {} }
        for (const entry of pending.values()) entry.reject(new Error('Production browser finished'))
        pending.clear(); ws?.close(); child.kill()
        const resolved = path.resolve(profile)
        assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('profile-production-browser-'))
        await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
    try {
        for (let attempt = 0; attempt < 100; attempt++) {
            if (launchError) throw launchError
            try { target = (await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) })).json()).find(entry => entry.type === 'page'); if (target) break } catch {}
            await pause(100)
        }
        assert(target, 'Production verification Chrome did not start')
        ws = new WebSocket(target.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Production CDP connection timed out')), 10000)
            ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
            ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Production CDP failed')) }, { once: true })
        })
        let sequence = 0
        call = (method, params = {}) => new Promise((resolve, reject) => {
            const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 20000)
            pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result) }, reject: error => { clearTimeout(timer); reject(error) } })
            ws.send(JSON.stringify({ id, method, params }))
        })
        ws.addEventListener('message', event => {
            const message = JSON.parse(event.data)
            if (message.id) { const entry = pending.get(message.id); pending.delete(message.id); if (entry) { if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result) } }
            if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text)
            if (message.method === 'Log.entryAdded' && message.params.entry.source === 'security') violations.push(message.params.entry.text)
            if (message.method === 'Page.javascriptDialogOpening') void call('Page.handleJavaScriptDialog', { accept: true }).catch(error => errors.push(safeError(error)))
            if (message.method === 'Fetch.requestPaused') {
                const { requestId, request } = message.params, url = new URL(request.url)
                const permitted = ['about:', 'blob:', 'data:'].includes(url.protocol) || [appOrigin, apiOrigin, 'https://cdn.jsdelivr.net'].includes(url.origin)
                if (url.origin === apiOrigin) {
                    requests.push({ method: request.method, path: url.pathname })
                    const prefix = '/storage/v1/object/site-images/'
                    if (writeMode && request.method === 'POST' && url.pathname.startsWith(prefix)) {
                        const file = decodeURIComponent(url.pathname.slice(prefix.length))
                        const match = /^(profile|feed)\/([1-9]\d*)\/.+/.exec(file)
                        if (match && owned.has(Number(match[2]))) ownedFiles.add(file)
                    }
                }
                if (!permitted) unexpected.push({ origin: url.origin, path: url.pathname })
                void call(permitted ? 'Fetch.continueRequest' : 'Fetch.failRequest', permitted ? { requestId } : { requestId, errorReason: 'BlockedByClient' }).catch(error => errors.push(safeError(error)))
            }
        })
        ws.addEventListener('close', () => { for (const entry of pending.values()) entry.reject(new Error('Production CDP closed')); pending.clear() })
        const js = async expression => {
            const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
            if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
            return result.result.value
        }
        await call('Runtime.enable'); await call('Page.enable'); await call('DOM.enable'); await call('Log.enable')
        await call('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
        await call('Page.addScriptToEvaluateOnNewDocument', { source: `window.__productionViolations=[];document.addEventListener('securitypolicyviolation',event=>window.__productionViolations.push({directive:event.effectiveDirective,blocked:event.blockedURI}));` })
        const until = async (expression, label, timeout = 30000) => {
            const deadline = Date.now() + timeout
            while (Date.now() < deadline) { if (await js(expression)) return; await pause(100) }
            throw new Error(`Timed out: ${label}`)
        }
        return {
            js, until, call, errors, violations, unexpected, requests, close,
            navigate: async route => { assert(route.startsWith('/') && !route.startsWith('//')); await call('Page.navigate', { url: appOrigin + route }); await pause(100) },
            set: (selector, value) => js(`(()=>{const field=document.querySelector(${JSON.stringify(selector)});const proto=field instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(field,${JSON.stringify(value)});field.dispatchEvent(new Event('input',{bubbles:true}));})()`),
            click: selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`),
            button: label => js(`(()=>{const node=[...document.querySelectorAll('button')].find(button=>button.textContent.trim()===${JSON.stringify(label)});if(!node)throw new Error('Expected production button missing');node.click()})()`),
            file: async (selector, files) => { const { root } = await call('DOM.getDocument'); const { nodeId } = await call('DOM.querySelector', { nodeId: root.nodeId, selector }); await call('DOM.setFileInputFiles', { nodeId, files }); await pause(100) },
            key: async (code, key = code) => { const windowsVirtualKeyCode = { Space: 32, Enter: 13, ArrowDown: 40, ArrowUp: 38, Escape: 27 }[code]; await call('Input.dispatchKeyEvent', { type: 'keyDown', code, key, windowsVirtualKeyCode }); await call('Input.dispatchKeyEvent', { type: 'keyUp', code, key, windowsVirtualKeyCode }); await pause(200) },
        }
    } catch (error) { await close(); throw error }
}

try {
    assert(process.argv[2] && process.argv[2] !== '--write', 'Pass an explicit ignored production verification config')
    config = JSON.parse(await fs.readFile(path.resolve(process.argv[2]), 'utf8'))
    assert.equal(config.productionProjectRef, 'nvunhhyxbbjqgzdhodrw')
    assert.equal(new URL(config.apiUrl).origin, apiOrigin)
    assert.equal(config.storageBucket || 'site-images', 'site-images')
    const appOrigin = new URL(config.appUrl).origin
    assert(allowedAppOrigins.has(appOrigin), 'The deployment origin must be explicitly allowlisted in this script')
    assert.equal(config.expectedAppOrigin, appOrigin)
    assert(typeof config.publishableKey === 'string' && config.publishableKey)
    if (writeMode) {
        assert.equal(config.allowProductionWrites, true, 'Explicit live-write approval is required')
        assert.equal(config.backupVerified, true, 'Verified production backups are required before write checks')
        assert.equal(config.adminUserId, 'f711da08-9c0b-42ee-a20c-a4f83ad46473')
        assert(config.adminEmail && config.adminPassword)
    }
    const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
    anon = createClient(apiOrigin, config.publishableKey, options)
    baseline = await rpc(anon, 'load_main')
    assert(Array.isArray(baseline.characters) && baseline.characters.length > 0, 'Migrated production data must exist')
    for (const character of baseline.characters) {
        const site = await rpc(anon, 'load_character', { p_character_id: character.id })
        assert(site?.profile.id === character.id)
        original.set(character.id, fingerprint(site))
        for (const file of [site.profile.profile_image_path, ...site.feed.map(row => row.image_path)].filter(Boolean)) {
            if (imageHashes.has(file)) continue
            const bytes = await publicBytes(file)
            assert(bytes?.length > 0, 'An original production image is unavailable')
            imageHashes.set(file, fingerprint(bytes))
        }
    }
    check(original.size === baseline.characters.length && imageHashes.size > 0, '운영 공개 API와 기존 모든 캐릭터·원본 이미지 다운로드 확인')
    for (const route of ['/', `/characters/${baseline.characters[0].id}`, '/characters/new', `/characters/${baseline.characters[0].id}/edit`, '/edit', '/manage.html']) {
        const response = await fetch(appOrigin + route, { signal: AbortSignal.timeout(20000) })
        assert.equal(new URL(response.url).origin, appOrigin)
        const policy = response.headers.get('content-security-policy')
        check(response.ok && policy?.includes(apiOrigin) && policy.includes("frame-ancestors 'none'") && response.headers.get('x-content-type-options') === 'nosniff', `${route} 운영 rewrite·보안 헤더 응답`)
    }
    browser = await launchBrowser(appOrigin)
    const { js, until, navigate, call } = browser
    await navigate('/')
    await until(`document.querySelectorAll('.character').length===${baseline.characters.length} && !!document.querySelector('.headerLoginButton:not(:disabled)')`, 'production public main')
    check(await js(`!document.querySelector('main .dragHandle') && !document.querySelector('[data-theme]')`), '운영 비로그인 메인에 관리 기능 없음')
    for (const [width, height] of [[1280, 1000], [768, 1024], [390, 844]]) {
        await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width === 390 })
        await navigate(`/characters/${baseline.characters[0].id}`)
        await until(`!!document.querySelector('.profileName') && document.querySelector('main')?.getAttribute('aria-busy')!=='true'`, 'production character loaded')
        check(await js(`document.documentElement.scrollWidth<=innerWidth && !document.querySelector('[role="alert"]') && document.title===document.querySelector('.profileName').textContent`), `운영 프로필 ${width}px 표시·이름 제목 연동·가로 넘침 없음`)
    }
    await navigate(`/characters/${baseline.characters[0].id}/edit`)
    await until(`location.pathname==='/' && !!document.querySelector('.headerLoginButton:not(:disabled)')`, 'production anonymous edit redirect')
    check(!await js(`!!document.querySelector('#profileName')`), '운영 비로그인 수정 경로 보호')

    if (writeMode) {
        admin = createClient(apiOrigin, config.publishableKey, options)
        const signed = await admin.auth.signInWithPassword({ email: config.adminEmail, password: config.adminPassword })
        assert(!signed.error && signed.data.user.id === config.adminUserId, 'Existing production admin authentication must match')
        const order = baseline.characters.map(row => row.id), { id: ignored, ...theme } = baseline.theme
        void ignored
        assert.deepEqual(await rpc(admin, 'save_character_order', { p_expected: order, p_order: order }), order)
        assert.equal(fingerprint(await rpc(admin, 'save_main_theme', { p_expected: baseline.theme, p_data: theme })), fingerprint(baseline.theme))
        check(true, '운영 메인 순서·테마 저장 RPC를 동일 값으로 검사해 기존 표시 유지')
        const requestId = randomUUID(), id = await rpc(admin, 'reserve_character_id', { p_request_id: requestId })
        assert(Number.isSafeInteger(id) && id > 0 && !original.has(id))
        owned.add(id)
        const payload = {
            profile: { name: runName, status_message: '배포 검증 전용 · 검사 후 삭제', profile_image_path: null }, theme,
            sections: [{ id: null, title: '검증 섹션', content: '  *볼드* _밑줄_ /기울임/\n| 검증 | 표 | ' }],
            keywords: [{ id: null, content: '배포검증' }], feed: [],
        }
        await rpc(admin, 'create_character', { p_character_id: id, p_request_id: requestId, p_data: payload })
        check((await rpc(anon, 'load_character', { p_character_id: id })).profile.name === runName, '운영 API 신규 캐릭터 원자 생성·재조회')
        await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false })
        await browser.click('.headerLoginButton'); await until(`!!document.querySelector('#loginModal input')`, 'production login modal')
        await browser.set('#loginModal input', config.adminPassword); await browser.click('#loginModal button[type=submit]')
        await until(`!!document.querySelector('.headerLogoutButton:not(:disabled)')`, 'production admin login')
        check(true, '운영 배포 브라우저에서 기존 관리자 비밀번호 로그인')
        temp = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-production-check-'))
        const picture = path.join(temp, '배포 검증.png')
        await fs.writeFile(picture, png)
        await navigate(`/characters/${id}/edit`)
        await until(`!!document.querySelector('#profileName') && document.querySelector('#profileName').value===${JSON.stringify(runName)}`, 'production test character editor')
        await browser.set('#profileMessage', '배포 검증 저장 완료')
        await browser.file('#profileFile', [picture]); await browser.file('#feedFiles', [picture])
        await until(`document.querySelector('img[alt="프로필 이미지 미리보기"]')?.naturalWidth>0`, 'production File preview')
        check(true, '운영 CSP에서 새 테스트 이미지 blob 미리보기')
        await js(`document.querySelector('main form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`)
        await until(`document.body.innerText.includes('저장 성공')`, 'production test editor save', 45000)
        const saved = await rpc(anon, 'load_character', { p_character_id: id })
        assert.equal(saved.profile.name, runName)
        assert.equal(saved.profile.status_message, '배포 검증 저장 완료')
        for (const file of [saved.profile.profile_image_path, ...saved.feed.map(row => row.image_path)]) {
            assert(file && (file.startsWith(`profile/${id}/`) || file.startsWith(`feed/${id}/`)))
            ownedFiles.add(file)
            assert.equal(fingerprint(await publicBytes(file)), fingerprint(png))
        }
        check(saved.feed.length === 1 && ownedFiles.size === 2, '운영 브라우저 수정·원본 PNG 업로드·namespace·공개 bytes 일치')
        await navigate(`/characters/${id}`)
        await until(`document.querySelector('.profileName')?.textContent===${JSON.stringify(runName)}`, 'production saved profile display')
        check(await js(`!!document.querySelector('.sectionContent strong') && !!document.querySelector('.sectionContent table')`), '운영 저장 후 본문 서식과 프로필 재조회')
        await navigate(`/characters/${id}/edit`); await until(`!!document.querySelector('#profileName')`, 'production delete editor')
        await browser.button('캐릭터 삭제'); await until(`location.pathname==='/' && !!document.querySelector('.headerLogoutButton:not(:disabled)')`, 'production test character delete')
        assert.equal(await rpc(anon, 'load_character', { p_character_id: id }), null)
        owned.delete(id)
        await cleanFiles([...ownedFiles])
        check(true, '운영 확인 삭제·자식 제거·테스트 파일 정리 후 메인 이동')
        await browser.click('.headerLogoutButton'); await until(`!!document.querySelector('.headerLoginButton:not(:disabled)')`, 'production test logout')
        check(!await js(`!!document.querySelector('main .dragHandle') || !!document.querySelector('[data-theme]')`), '운영 검증 세션만 로그아웃 후 관리 기능 숨김')
    }
    for (const [id, hash] of original) assert.equal(fingerprint(await rpc(anon, 'load_character', { p_character_id: id })), hash, 'An existing production character changed during verification')
    for (const [file, hash] of imageHashes) assert.equal(fingerprint(await publicBytes(file)), hash, 'An original image changed during verification')
    const after = await rpc(anon, 'load_main')
    assert.deepEqual(after.characters.map(row => row.id), baseline.characters.map(row => row.id))
    assert.equal(fingerprint(after.characters), fingerprint(baseline.characters), 'Existing card data and numeric order must be preserved')
    assert.equal(fingerprint(after.theme), fingerprint(baseline.theme))
    check(true, '검사 후 기존 모든 캐릭터·원본 이미지 hash·메인 순서·테마 보존')
    check(browser.errors.length === 0 && browser.violations.length === 0 && browser.unexpected.length === 0, '운영 브라우저 실행 예외·CSP 위반·예상 밖 외부 요청 없음')
    console.log(JSON.stringify({ passed: checks.length, mode: writeMode ? 'production-write-approved' : 'read-only', checks, apiRequests: browser.requests.length, originalCharacters: original.size, originalImages: imageHashes.size, apiMocked: false }, null, 2))
} catch (error) {
    console.error(JSON.stringify({ passed: checks.length, mode: writeMode ? 'production-write-approved' : 'read-only', checks, failure: safeError(error), browserErrors: browser?.errors.map(safeError), unexpectedRequests: browser?.unexpected }, null, 2))
    process.exitCode = 1
} finally {
    if (writeMode && admin && config?.allowProductionWrites === true) {
        for (const id of owned) {
            try {
                const site = await rpc(anon, 'load_character', { p_character_id: id })
                if (!site) continue
                assert.equal(site.profile.name, runName, 'Cleanup may delete only this run\'s marked test character')
                for (const file of [site.profile.profile_image_path, ...site.feed.map(row => row.image_path)].filter(Boolean)) {
                    assert(file.startsWith(`profile/${id}/`) || file.startsWith(`feed/${id}/`))
                    ownedFiles.add(file)
                }
                await rpc(admin, 'delete_character', { p_character_id: id, p_expected: site })
            } catch (error) { console.error(`Production test cleanup failed: ${safeError(error)}`); process.exitCode = 1 }
        }
        try { await cleanFiles([...ownedFiles]) } catch (error) { console.error(`Production test-image cleanup failed: ${safeError(error)}`); process.exitCode = 1 }
    }
    await browser?.close()
    if (admin) {
        try {
            const result = await admin.auth.signOut({ scope: 'local' })
            if (result.error) { console.error('Could not revoke the production verification SDK session'); process.exitCode = 1 }
        } catch (error) { console.error(safeError(error)); process.exitCode = 1 }
    }
    if (temp) { const target = path.resolve(temp); assert(target.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(target).startsWith('profile-production-check-')); await fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
}

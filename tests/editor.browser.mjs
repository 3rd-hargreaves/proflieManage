import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const phase = 6
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
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const fetchJson = async url => (await fetch(url, { signal: AbortSignal.timeout(3000) })).json()
const deadline = Date.now() + 240000
const checkDeadline = () => { if (Date.now() > deadline) throw new Error('Browser regression exceeded its 4 minute deadline') }
const passed = []
const errors = []
const user = { id: '11111111-1111-4111-8111-111111111111', email: 'admin@example.test', aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email' }, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' }
const jwt = n => `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: user.id, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now()/1000)+3600, iat: Math.floor(Date.now()/1000), n })).toString('base64url')}.test-only-signature`
let tokenSequence = 0
const session = () => ({ access_token: jwt(++tokenSequence), refresh_token: 'test-refresh-token', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now()/1000)+3600, user })
const initial = (id = 1) => ({
    profile: { id, name: id === 1 ? '첫 캐릭터' : '둘째 캐릭터', status_message: `캐릭터 ${id} 상태`, profile_image_path: `profile/${id}/image.png` },
    theme: { id, main_color: id === 1 ? '#7841ab' : '#2468ac', background_color: id === 1 ? '#fce8ef' : '#cdefff', card_background_color: '#ffffff', typo_color: '#26232a' },
    sections: [{ id: id * 100 + 10, sort_order: 1, title: `캐릭터 ${id} 첫 섹션`, content: '  *볼드* _밑줄_ /기울임/ -취소-\n| 표 |\n원문  ' }, { id: id * 100 + 11, sort_order: 2, title: `캐릭터 ${id} 둘째 섹션`, content: '둘째 내용' }],
    keywords: [{ id: id * 100 + 30, sort_order: 1, content: `키워드${id}` }],
    feed: [{ id: id * 100 + 20, sort_order: 1, image_path: `feed/${id}/first.png` }, { id: id * 100 + 21, sort_order: 2, image_path: `feed/${id}/second.png` }],
})
const initialMainTheme = { id: 1, main_color: '#c34f78', background_color: '#ffedf4', card_background_color: '#fffafc', typo_color: '#221122' }
let mainTheme = structuredClone(initialMainTheme)
let sites = new Map([[1, initial(1)], [2, initial(2)]])
let mode = { userStatus: 200, userDelay: 0, tokenDelay: 0 }
let order = [2, 1], nextCharacterId = 3, nextChildId = 1000
let reservations = new Map(), creations = new Map(), deletions = new Map()
const references = () => [...new Set([...sites.values()].flatMap(site => [site.profile.profile_image_path, ...site.feed.map(row => row.image_path)]).filter(Boolean))]
let objects = new Set(references())
const dataContent = data => JSON.stringify({
    profile: { name: data.profile.name, status_message: data.profile.status_message, profile_image_path: data.profile.profile_image_path },
    theme: Object.fromEntries(Object.entries(data.theme).filter(([key]) => key !== 'id')),
    ...Object.fromEntries(['sections', 'keywords', 'feed'].map(key => [key, data[key].map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !['id', 'sort_order'].includes(key))))])),
})
const writtenSite = (id, data) => ({
    profile: { id, ...data.profile }, theme: { id, ...data.theme },
    ...Object.fromEntries(['sections', 'keywords', 'feed'].map(key => [key, data[key].map((row, index) => ({ ...row, id: row.id ?? nextChildId++, sort_order: index + 1 }))])),
})
const candidates = before => [...new Set([before.profile.profile_image_path, ...before.feed.map(row => row.image_path)].filter(Boolean))].filter(path => !references().includes(path))
const requests = []
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=', 'base64')
const api = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString()
    const entry = { method: req.method, path: url.pathname, body: null }; requests.push(entry)
    if (raw) { try { entry.body = JSON.parse(raw) } catch {} }
    res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    const send = (status, data) => { if (res.destroyed) return; res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(data === undefined ? undefined : JSON.stringify(data)) }
    const loseResponse = async () => {
        // Send headers first so Chromium cannot transparently replay a closed
        // keep-alive socket before exposing the ambiguous result to the app.
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{')
        await pause(20); res.destroy()
    }
    if (url.pathname === '/auth/v1/user') { const status = mode.userStatus; await pause(mode.userDelay); send(status, status === 200 ? user : { code: status === 401 ? 'bad_jwt' : 'unexpected_failure', msg: 'Mock verification failure' }); return }
    if (url.pathname === '/auth/v1/token') { const status = mode.tokenStatus ?? 200; await pause(mode.tokenDelay); send(status, status === 200 ? session() : { error: 'invalid_grant', error_code: 'invalid_credentials', msg: 'Invalid login credentials' }); return }
    if (url.pathname === '/auth/v1/logout') { send(204); return }
    if (url.pathname === '/rest/v1/rpc/load_main' || url.pathname === '/rest/v1/rpc/load_character') {
        const id = Number(entry.body?.p_character_id)
        const isMain = url.pathname.endsWith('/load_main')
        const data = structuredClone(isMain ? { characters: mode.empty ? [] : order.filter(id => sites.has(id)).map((id, index) => ({ ...sites.get(id).profile, sort_order: index + 1 })), theme: mainTheme } : sites.get(id) ?? null)
        const status = isMain ? mode.mainStatus ?? 200 : mode.characterStatus?.[id] ?? 200
        const delay = isMain ? mode.mainDelay ?? 0 : mode.characterDelay?.[id] ?? 0
        entry.characterId = isMain ? null : id
        entry.snapshotName = isMain ? 'main' : data?.profile.name
        res.once('close', () => { if (!res.writableEnded) entry.cancelled = true })
        await pause(delay)
        send(status, status === 200 ? data : { code: 'unexpected_failure', message: 'Mock snapshot failure' })
        return
    }
    if (url.pathname === '/rest/v1/rpc/load_image_references') { send(mode.refStatus ?? 200, mode.refStatus ? { message: 'Mock reference failure' } : references()); return }
    if (url.pathname === '/rest/v1/rpc/save_character_order') {
        await pause(mode.orderDelay ?? 0)
        const { p_expected: expected, p_order: next } = entry.body
        const current = order.filter(id => sites.has(id))
        const sameOrder = JSON.stringify(current) === JSON.stringify(next)
        const sameMembers = JSON.stringify([...current].sort()) === JSON.stringify([...next].sort())
        if (mode.orderFailure || !sameMembers || (!sameOrder && JSON.stringify(current) !== JSON.stringify(expected))) {
            send(400, { code: 'P0001', message: mode.orderFailure || 'character_order_conflict' }); return
        }
        order = [...next]
        if (mode.orderDropResponse) { mode.orderDropResponse = false; await loseResponse(); return }
        send(200, order); return
    }
    if (url.pathname === '/rest/v1/rpc/save_main_theme') {
        await pause(mode.themeDelay ?? 0)
        const { p_expected: expected, p_data: next } = entry.body
        const sameColors = (first, second) => ['main_color', 'background_color', 'card_background_color', 'typo_color'].every(key => first[key] === second[key])
        if (mode.themeFailure || (!sameColors(mainTheme, next) && (!sameColors(mainTheme, expected) || expected.id !== 1))) {
            send(400, { code: 'P0001', message: mode.themeFailure || 'main_theme_conflict' }); return
        }
        mainTheme = { id: 1, ...next }
        if (mode.themeDropResponse) { mode.themeDropResponse = false; await loseResponse(); return }
        send(200, mainTheme); return
    }
    if (url.pathname === '/rest/v1/rpc/reserve_character_id') {
        const requestId = entry.body.p_request_id
        if (!reservations.has(requestId)) reservations.set(requestId, nextCharacterId++)
        send(200, reservations.get(requestId)); return
    }
    if (url.pathname === '/rest/v1/rpc/create_character') {
        await pause(mode.createDelay ?? 0)
        const { p_character_id: rawId, p_request_id: requestId, p_data: data } = entry.body
        const id = Number(rawId), receipt = creations.get(requestId)
        if (receipt) { send(receipt.payload === JSON.stringify(data) ? 200 : 400, receipt.payload === JSON.stringify(data) ? receipt.result : { code: 'P0001', message: 'creation_request_conflict' }); return }
        if (reservations.get(requestId) !== id) { send(400, { code: '22023', message: 'invalid_creation_request' }); return }
        const site = writtenSite(id, data); sites.set(id, site); order.push(id)
        const result = { character: site, cleanup_candidates: [] }
        creations.set(requestId, { payload: JSON.stringify(data), result: structuredClone(result) })
        if (mode.createDropResponse) { mode.createDropResponse = false; await loseResponse(); return }
        send(200, result); return
    }
    if (url.pathname === '/rest/v1/rpc/save_character') {
        await pause(mode.saveDelay ?? 0)
        const id = Number(entry.body.p_character_id), current = sites.get(id), data = entry.body.p_data
        if (!current) { send(400, { code: 'P0001', message: 'character_not_found' }); return }
        if (mode.saveFailure || (JSON.stringify(current) !== JSON.stringify(entry.body.p_expected) && dataContent(current) !== dataContent(data))) { send(400, { code: 'P0001', message: mode.saveFailure || 'character_conflict' }); return }
        if (dataContent(current) !== dataContent(data)) sites.set(id, writtenSite(id, data))
        const result = { character: sites.get(id), cleanup_candidates: candidates(entry.body.p_expected) }
        if (mode.saveDropResponse) { mode.saveDropResponse = false; await loseResponse(); return }
        send(200, result); return
    }
    if (url.pathname === '/rest/v1/rpc/delete_character') {
        await pause(mode.deleteDelay ?? 0)
        const id = Number(entry.body.p_character_id), receipt = deletions.get(id), current = sites.get(id)
        if (receipt) { send(200, receipt); return }
        if (!current || JSON.stringify(current) !== JSON.stringify(entry.body.p_expected)) { send(400, { code: 'P0001', message: current ? 'character_conflict' : 'character_not_found' }); return }
        sites.delete(id); order = order.filter(entry => entry !== id)
        const result = { character_id: id, cleanup_candidates: candidates(current) }; deletions.set(id, result)
        if (mode.deleteDropResponse) { mode.deleteDropResponse = false; await loseResponse(); return }
        send(200, result); return
    }
    if (url.pathname.startsWith('/storage/v1/object/site-images/') && req.method === 'POST') {
        const imagePath = decodeURIComponent(url.pathname.split('/site-images/')[1]); entry.uploadPath = imagePath
        entry.uploadBytes = Buffer.concat(chunks)
        await pause(mode.uploadDelay ?? 0)
        if (mode.uploadFailure) { mode.uploadFailure = false; send(500, { error: 'Mock upload failure' }); return }
        objects.add(imagePath); send(200, { Key: `site-images/${imagePath}` }); return
    }
    if (url.pathname === '/storage/v1/object/site-images' && req.method === 'DELETE') {
        await pause(mode.cleanupDelay ?? 0)
        if (mode.cleanupFailure) { send(500, { error: 'Mock cleanup failure' }); return }
        const paths = entry.body.prefixes ?? []
        const retained = references()
        if (paths.some(path => retained.includes(path))) { send(400, { error: 'Attempted referenced-file deletion' }); return }
        for (const path of paths) objects.delete(path)
        send(200, paths.map(name => ({ name }))); return
    }
    if (url.pathname === '/storage/v1/object/list/site-images' && req.method === 'POST') {
        const { prefix = '', search = '', limit = 100, offset = 0 } = entry.body
        const names = [...objects].filter(path => path.startsWith(`${prefix}/`)).map(path => path.slice(prefix.length + 1)).filter(name => !name.includes('/') && name.includes(search)).sort()
        send(200, names.slice(offset, offset + limit).map(name => ({ name }))); return
    }
    if (url.pathname.startsWith('/storage/v1/object/public/') && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(image); return }
    send(500, { error: 'Unexpected write or legacy request' })
})
const listen = server => new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)))
const freePort = async()=>{const server=http.createServer();const port=await listen(server);await new Promise(r=>server.close(r));return port}
let vite,chrome,ws,temp
let launchError
const chromeDiagnostics = { executable: '', exitCode: null, signal: null, stderr: '' }
const pending = new Map()
let viteLogs=''
let cdp,js
const dialogs=[]
let acceptDialog=false
const check=(condition,label)=>{assert.ok(condition,label);passed.push(label)}
try {
    const chromePath = await findChrome()
    temp=await fs.mkdtemp(path.join(os.tmpdir(),'profile-editor-check-'))
    const picture=path.join(temp,'선택 이미지.png');await fs.writeFile(picture,image)
    const apiPort=await listen(api),vitePort=await freePort(),debugPort=await freePort()
    const appUrl=`http://127.0.0.1:${vitePort}`
    vite=spawn(process.execPath,[path.join(project,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(vitePort),'--strictPort'],{cwd:project,env:{...process.env,VITE_SUPABASE_URL:`http://127.0.0.1:${apiPort}`,VITE_SUPABASE_PUBLISHABLE_KEY:'test-publishable-key',VITE_ADMIN_EMAIL:user.email,VITE_ADMIN_USER_ID:user.id,VITE_SUPABASE_STORAGE_BUCKET:'site-images'},windowsHide:true,stdio:['ignore','pipe','pipe']})
    vite.on('error',error=>{launchError=error})
    for(const stream of [vite.stdout,vite.stderr])stream.on('data',chunk=>{viteLogs=(viteLogs+chunk.toString()).slice(-3000)})
    for(let i=0;i<100;i++){checkDeadline();if(launchError)throw launchError;try{if((await fetch(appUrl,{signal:AbortSignal.timeout(3000)})).ok)break}catch{} await pause(100);if(i===99)throw new Error(`Vite did not start: ${viteLogs}`)}
    chromeDiagnostics.executable = chromePath
    chrome=spawn(chromePath,['--headless=new','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${path.join(temp,'chrome')}`,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']})
    chrome.stderr.on('data', chunk => { chromeDiagnostics.stderr = (chromeDiagnostics.stderr + chunk.toString()).slice(-6000) })
    chrome.on('error',error=>{launchError=error})
    chrome.on('exit', (code, signal) => { chromeDiagnostics.exitCode = code; chromeDiagnostics.signal = signal })
    let target
    const chromeDeadline = Date.now() + 30000
    while(Date.now()<chromeDeadline){checkDeadline();if(launchError)throw launchError;if(chrome.exitCode!==null||chrome.signalCode!==null)throw new Error('Chrome exited before its debugging endpoint was ready');try{target=(await fetchJson(`http://127.0.0.1:${debugPort}/json`)).find(t=>t.type==='page');if(target)break}catch{}await pause(100)}
    if(!target)throw new Error('Chrome did not start; set CHROME_PATH to a Chromium executable')
    ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('CDP connection timed out')),10000);ws.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});ws.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('CDP connection failed'))},{once:true})})
    let sequence=0
    cdp=(method,params={})=>new Promise((resolve,reject)=>{
        try{checkDeadline()}catch(error){reject(error);return}
        if(ws.readyState!==WebSocket.OPEN){reject(new Error(`CDP disconnected before ${method}`));return}
        const id=++sequence
        const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timed out: ${method}`))},15000)
        pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value)},reject:error=>{clearTimeout(timer);reject(error)}})
        ws.send(JSON.stringify({id,method,params}))
    })
    ws.addEventListener('close',()=>{for(const task of pending.values())task.reject(new Error('CDP connection closed'));pending.clear()})
    ws.addEventListener('error',()=>{for(const task of pending.values())task.reject(new Error('CDP connection error'));pending.clear()})
    ws.addEventListener('message',event=>{
        const message=JSON.parse(event.data)
        if(message.id){const task=pending.get(message.id);pending.delete(message.id);if(task){if(message.error)task.reject(new Error(JSON.stringify(message.error)));else task.resolve(message.result)}}
        if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text)
        if(message.method==='Page.javascriptDialogOpening'){
            dialogs.push({...message.params,accepted:acceptDialog})
            void cdp('Page.handleJavaScriptDialog',{accept:acceptDialog}).catch(error=>errors.push(error.message))
        }
    })
    js=async expression=>{const result=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value}
    const until=async(expression,label,timeout=20000)=>{const start=Date.now();while(Date.now()-start<timeout){if(await js(expression))return;await pause(70)}throw new Error(`Timed out: ${label}\n${await js('document.body.innerText')}`)}
    const untilRequests=async(condition,label)=>{const start=Date.now();while(Date.now()-start<5000){checkDeadline();if(condition())return;await pause(20)}throw new Error(`Timed out waiting for mock request: ${label}`)}
    const hasEditor=()=>js('!!document.querySelector("#profileName")')
    const button=async pattern=>js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>new RegExp(${JSON.stringify(pattern)}).test(b.textContent));if(!b)throw new Error('Missing button '+${JSON.stringify(pattern)});b.click();return true})()`)
    const set=async(selector,value,index=0)=>js(`(()=>{const el=document.querySelectorAll(${JSON.stringify(selector)})[${index}];const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`)
    const nativeClick=async selector=>{const point=await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);await cdp('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1})}
    const clickWithoutScroll=async selector=>{const point=await js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);await cdp('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1})}
    const key=async(code,key=code,modifiers=0)=>{await cdp('Input.dispatchKeyEvent',{type:'keyDown',code,key,modifiers,windowsVirtualKeyCode:code==='Space'?32:code==='Enter'?13:code==='Escape'?27:code==='Tab'?9:code==='ArrowDown'?40:code==='ArrowUp'?38:0});await cdp('Input.dispatchKeyEvent',{type:'keyUp',code,key,modifiers});await pause(180)}
    const focus=async(selector,index=0)=>{await js(`document.querySelectorAll(${JSON.stringify(selector)})[${index}].focus()`);await pause(100)}
    const sessionValue=session()
    await cdp('Runtime.enable');await cdp('Page.enable');await cdp('DOM.enable')
    await cdp('Emulation.setDeviceMetricsOverride',{width:1280,height:1100,deviceScaleFactor:1,mobile:false})
    await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`if(sessionStorage.getItem('editor-test-no-session')==='1')localStorage.removeItem('sb-127-auth-token');else localStorage.setItem('sb-127-auth-token',${JSON.stringify(JSON.stringify(sessionValue))});`})
    const navigate=async destination=>{await cdp('Page.navigate',{url:appUrl+destination});await pause(400)}
    const spa = async destination => {
        await js(`history.pushState(null,'',${JSON.stringify(destination)});window.dispatchEvent(new PopStateEvent('popstate'))`)
        await pause(80)
    }
    const reset = async (authenticated = true, destination = '/characters/1/edit') => {
        mode = { userStatus: 200, userDelay: 0, tokenDelay: 0 }
        sites = new Map([[1, initial(1)], [2, initial(2)]])
        mainTheme = structuredClone(initialMainTheme)
        order = [2, 1]; nextCharacterId = 3; nextChildId = 1000; reservations = new Map(); creations = new Map(); deletions = new Map(); objects = new Set(references())
        acceptDialog = true
        await js(`Object.keys(localStorage).filter(key=>key.startsWith('profileManage:cleanup:')).forEach(key=>localStorage.removeItem(key))`)
        await js(`sessionStorage.setItem('editor-test-no-session',${JSON.stringify(authenticated ? '0' : '1')})`)
        await navigate(destination)
        acceptDialog = false
        await until(authenticated ? `!!document.querySelector('.headerLogoutButton')` : `!!document.querySelector('.headerLoginButton:not(:disabled)')`, 'auth ready')
        if (authenticated && ['/characters/1/edit','/characters/2/edit'].includes(destination)) await until(`!!document.querySelector('#profileName')`, 'editor ready')
        dialogs.length = 0
    }
    const refresh = () => js(`void import('/src/lib/supabase.ts').then(({supabase})=>supabase.auth.refreshSession())`)
    const externalSignout = () => js(`void import('/src/lib/supabase.ts').then(({supabase})=>supabase.auth.signOut({scope:'local'}))`)
    const selectFile = async (selector, files = [picture]) => { const { root } = await cdp('DOM.getDocument'); const { nodeId } = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector }); await cdp('DOM.setFileInputFiles', { nodeId, files }); await pause(100) }
    const submit = () => js(`document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`)
    const saveReady = () => until(`!!document.querySelector('button[type=submit]:not(:disabled)')`, 'save unlocked')
    const writeCalls = name => requests.filter(r => r.method === 'POST' && r.path.endsWith('/rpc/'+name))
    const selectedColor = () => js(`getComputedStyle(document.documentElement).getPropertyValue('--main-color').trim()`)
    const readRequests = () => requests.filter(r => r.method === 'POST' && /\/rpc\/load_(main|character)$/.test(r.path))

    await navigate('/')
    await reset(false, '/')
    await until(`document.querySelectorAll('.character').length===2`, 'public collection')
    check(await js(`[...document.querySelectorAll('.character')].map(a=>a.getAttribute('href')).join('|')==='/characters/2|/characters/1'`), '메인 카드가 RPC의 여러 캐릭터·저장 순서와 주소를 사용')
    check(await selectedColor() === mainTheme.main_color, '메인 화면이 캐릭터와 별개의 저장된 메인 테마 사용')
    check(await js(`!document.querySelector('.headerEditLink') && ![...document.querySelectorAll('button,a')].some(e=>/^(순서 저장|캐릭터 추가|테마 저장)$/.test(e.textContent.trim()))`), '방문자에게 관리자 컨트롤 숨김')
    check(await js(`!document.querySelector('main .dragHandle') && !document.querySelector('[data-theme]')`)
        && !requests.some(request => /\/rpc\/save_(character_order|main_theme)$/.test(request.path)), '비로그인 메인은 드래그·테마 입력·쓰기 요청 없음')
    check(await js(`getComputedStyle(document.querySelector('.siteHeader')).height==='50px' && getComputedStyle(document.querySelector('.headerLoginButton')).height==='30px'`), '데스크톱 헤더와 버튼 높이 유지')
    await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    check(await js(`getComputedStyle(document.querySelector('.siteHeader')).height==='40px' && getComputedStyle(document.body).paddingTop==='40px' && getComputedStyle(document.querySelector('.headerLoginButton')).height==='24px'`), '모바일 고정 헤더·본문 오프셋 일치')
    sites.get(2).profile.name = '긴이름'.repeat(70); sites.get(2).profile.status_message = '긴상태메시지'.repeat(70)
    await navigate('/')
    await until(`document.querySelector('.character')?.textContent.includes('긴이름')`, 'long card loaded')
    check(await js(`(()=>{const c=document.querySelector('.character'),i=c.querySelector('.profileImg'),t=c.querySelector('div');return i.getBoundingClientRect().width===100 && t.getBoundingClientRect().width<c.getBoundingClientRect().width-100 && document.documentElement.scrollWidth<=innerWidth})()`), '긴 카드 텍스트는 이미지가 차지하고 남은 너비 안에서 줄바꿈')
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1100, deviceScaleFactor: 1, mobile: false })

    await reset(false, '/characters/2')
    await until(`document.querySelector('.profileName')?.textContent==='둘째 캐릭터'`, 'second character')
    check(await js(`document.title==='둘째 캐릭터' && document.querySelector('.sectionContent strong')?.textContent==='볼드'`), '개별 캐릭터 제목·본문 서식 표시')
    check(await selectedColor() === initial(2).theme.main_color, '개별 캐릭터 ID의 저장된 테마 표시')
    check(readRequests().some(r => r.path.endsWith('/load_character') && r.characterId === 2), '개별 조회 RPC에 실제 경로 ID 전달')
    await nativeClick('#feedOpenBtn')
    await until(`document.querySelector('.picList img')?.naturalWidth===1`, 'feed image loaded')
    await focus('.picList img'); await key('Enter')
    await until(`document.querySelector('#imgModal')?.matches(':modal')`, 'image modal')
    check(await js(`document.activeElement?.closest('#imgModal') && document.body.style.position==='fixed'`), '피드 이미지 모달의 포커스·스크롤 잠금 유지')
    await key('Escape'); await until(`!document.querySelector('#imgModal')`, 'image modal closed')
    check(await js(`document.activeElement===document.querySelector('.picList img') && document.body.style.position===''`), '이미지 모달 닫기 후 호출 요소·스크롤 복구')
    await spa('/characters/1'); await until(`document.querySelector('.profileName')?.textContent==='첫 캐릭터'`, 'switch to first')
    check(await selectedColor() === initial(1).theme.main_color && await js(`document.title==='첫 캐릭터' && document.querySelector('#feedOpenBtn').style.display!=='none'`), 'ID 전환 시 제목·테마·피드 펼침 상태 초기화')
    await nativeClick('.homeButton'); await until(`document.querySelectorAll('.character').length===2`, 'return collection')
    check(await selectedColor() === mainTheme.main_color, '프로필 이탈 후 메인 테마로 복원')

    mode.characterDelay = { 1: 1000 }
    const pendingStart = requests.length
    await spa('/characters/1')
    await untilRequests(() => requests.slice(pendingStart).some(r => r.characterId === 1), 'delayed first started')
    await spa('/characters/2'); await until(`document.querySelector('.profileName')?.textContent==='둘째 캐릭터'`, 'newer second response')
    await pause(1150)
    check(await js(`document.querySelector('.profileName').textContent==='둘째 캐릭터' && document.title==='둘째 캐릭터'`) && await selectedColor() === initial(2).theme.main_color, '늦은 이전 캐릭터 응답이 현재 데이터·제목·테마를 덮어쓰지 않음')
    check(requests.slice(pendingStart).some(r => r.characterId === 1 && r.cancelled), '경로 전환 시 진행 중인 이전 조회를 취소')
    mode.characterDelay = {}; mode.characterStatus = { 1: 503 }
    await spa('/characters/1'); await until(`!!document.querySelector('[role=alert]')`, 'character error')
    check(await js(`!document.querySelector('.profileName') && !document.querySelector('.sectionContent')`), '새 ID 조회 실패 시 이전 캐릭터 내용을 남기지 않음')
    mode.characterStatus = {}; await button('다시 시도'); await until(`document.querySelector('.profileName')?.textContent==='첫 캐릭터'`, 'retry character')
    check(await selectedColor() === initial(1).theme.main_color, '조회 재시도 후 해당 캐릭터 데이터·테마 복원')
    await spa('/characters/999'); await until(`document.body.innerText.includes('찾을 수')`, 'unknown character')
    check(await js(`!document.querySelector('.profileName') && !document.querySelector('.headerEditLink')`), '없는 ID는 첫 캐릭터로 대체하지 않고 찾을 수 없음 표시')
    for (const route of ['/characters/0', '/characters/-1', '/characters/abc', '/characters/9007199254740992']) {
        const start = requests.length
        await spa(route); await until(`document.body.innerText.includes('찾을 수')`, `invalid ${route}`)
        check(!requests.slice(start).some(r => r.path.endsWith('/load_character')), `${route} 잘못된 ID는 조회하지 않음`)
    }
    mode.empty = true; await spa('/'); await until(`document.body.innerText.includes('등록된 캐릭터가 없습니다')`, 'empty collection')
    check(await js(`document.querySelectorAll('.character').length===0`), '빈 메인 목록에 가짜 카드나 이전 캐릭터가 남지 않음')
    mode.empty = false; mode.mainStatus = 503; await navigate('/'); await until(`!!document.querySelector('[role=alert]')`, 'main error')
    check(await js(`document.querySelectorAll('.character').length===0`), '메인 RPC 실패 시 이전 카드 미표시')
    mode.mainStatus = 200; await button('다시 시도'); await until(`document.querySelectorAll('.character').length===2`, 'retry main')
    check(await selectedColor() === mainTheme.main_color, '메인 재시도 후 저장된 테마·목록 표시')

    await reset(true, '/characters/2')
    await until(`document.querySelector('.profileName')?.textContent==='둘째 캐릭터'`, 'admin second profile')
    check(await js(`document.querySelector('.headerEditLink').getAttribute('href')==='/characters/2/edit'`), '수정 링크가 현재 캐릭터 ID로 연결')
    await nativeClick('.headerEditLink'); await until(`document.querySelector('#profileName')?.value==='둘째 캐릭터'`, 'second editor')
    check(await js(`document.querySelector('[data-section] textarea').value===${JSON.stringify(initial(2).sections[0].content)} && !document.querySelector('button[type=submit]').matches(':disabled')`), '수정 조회는 대상 ID·원문을 유지하고 저장 활성화')
    check(await selectedColor() === initial(2).theme.main_color, '수정 화면도 캐릭터별 테마 적용')
    check(await js(`[...document.querySelectorAll('main button')].at(-1)?.textContent.trim()==='캐릭터 삭제' && ![...document.querySelectorAll('main button')].at(-1).matches(':disabled')`), '수정 화면 최하단 캐릭터 삭제 버튼 활성화')
    await set('#profileName', '둘째 편집 초안'); await selectFile('#profileFile')
    const preview = await js(`document.querySelector('img[alt="프로필 이미지 미리보기"]').src`)
    check(preview.startsWith('blob:'), '로컬 이미지 미리보기 유지')
    await nativeClick('.homeButton'); await pause(80)
    check(await js(`location.pathname==='/characters/2/edit' && document.querySelector('#profileName').value==='둘째 편집 초안'`), '헤더 홈 이탈 취소 시 대상 캐릭터 초안 유지')
    const unload = await js(`(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented})()`)
    check(unload, '캐릭터 수정 초안은 새로고침 이탈 경고 대상')
    mode.userStatus = 503; await refresh(); await until(`document.body.innerText.includes('로그인 상태 확인 실패')`, 'auth failure preserves editor')
    check(await js(`document.querySelector('#profileName').value==='둘째 편집 초안' && document.querySelector('fieldset').disabled && document.querySelector('img[alt="프로필 이미지 미리보기"]').src===${JSON.stringify(preview)}`), '인증 확인 실패에도 같은 ID 초안·File을 보존하고 필드 잠금')
    mode.userStatus = 200; await button('다시 확인'); await until(`!document.querySelector('fieldset').disabled`, 'auth recovery')
    check(await js(`document.querySelector('#profileName').value==='둘째 편집 초안'`), '인증 복구가 조회 초안으로 덮어쓰지 않음')
    await externalSignout(); await until(`document.body.innerText.includes('다시 로그인') && document.querySelector('fieldset').disabled`, 'expired session')
    await button('다시 로그인'); await until(`!!document.querySelector('#loginModal')`, 'reauth modal')
    await set('#loginModal input', 'test-only-password'); await nativeClick('#loginModal button[type=submit]')
    await until(`!document.querySelector('#loginModal') && !document.querySelector('fieldset').disabled`, 'reauth success')
    check(await js(`location.pathname==='/characters/2/edit' && document.querySelector('#profileName').value==='둘째 편집 초안' && document.querySelector('img[alt="프로필 이미지 미리보기"]').src===${JSON.stringify(preview)}`), '재로그인 후 같은 캐릭터 주소·텍스트·File 유지')
    await js(`window.__revoked=[];const revoke=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=url=>{window.__revoked.push(url);revoke(url)}`)
    acceptDialog = true; await spa('/characters/1/edit'); acceptDialog = false
    await until(`document.querySelector('#profileName')?.value==='첫 캐릭터'`, 'editor id switch')
    check(await js(`document.querySelector('img[alt="프로필 이미지 미리보기"]').src.includes('/profile/1/image.png') && window.__revoked.includes(${JSON.stringify(preview)})`) && await selectedColor() === initial(1).theme.main_color, '다른 ID 수정으로 전환하면 이전 File·URL·테마·초안 정리')
    await focus('[data-section] .dragHandle'); await key('Space', ' '); await key('ArrowDown'); await key('Space', ' ')
    check(await js(`document.querySelector('[data-section] input').value==='캐릭터 1 둘째 섹션'`), '로컬 편집의 키보드 섹션 정렬 유지')
    await js(`document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`)
    await until(`document.body.innerText.includes('저장 성공')`, 'keyboard sorted save');check(sites.get(1).sections[0].id===111 && sites.get(2).profile.name==='둘째 캐릭터', '키보드 섹션 정렬을 대상 캐릭터에만 저장')
    acceptDialog = true; await nativeClick('.homeButton'); acceptDialog = false
    await until(`document.querySelectorAll('.character').length===2`, 'admin collection')
    check(await js(`[...document.querySelectorAll('button,a')].filter(e=>/^(순서 저장|캐릭터 추가|테마 저장)$/.test(e.textContent.trim())).length===3 && !document.querySelector('.headerEditLink')`), '관리자 모음에만 관리 컨트롤 표시')
    await nativeClick('a[href="/characters/new"]'); await until(`!!document.querySelector('#profileName')`, 'new blank form')
    check(await js(`document.querySelector('#profileName').value==='' && document.querySelector('#profileMessage').value==='' && document.querySelector('#keywords').value==='' && document.querySelectorAll('[data-section]').length===0 && !document.querySelector('button[type=submit]').matches(':disabled')`), '신규 폼은 빈 정보·목록으로 열리고 저장 검증 가능')
    check(await selectedColor() === mainTheme.main_color, '신규 폼 초기 테마가 저장된 메인 테마를 복사')
    await set('#profileName', '새 초안'); await button('^섹션 추가$'); await selectFile('#profileFile')
    check(await js(`document.querySelectorAll('[data-section]').length===1 && document.querySelector('img[alt="프로필 이미지 미리보기"]').src.startsWith('blob:')`), '신규 폼의 로컬 섹션·File 미리보기 유지')
    await nativeClick('.homeButton'); await pause(80)
    check(await js(`location.pathname==='/characters/new' && document.querySelector('#profileName').value==='새 초안'`), '신규 작성 이탈 취소 시 초안 유지')
    acceptDialog = true; await nativeClick('.homeButton'); acceptDialog = false
    for (const route of ['/edit', '/manage.html', '/edit/', '/manage.html/']) {
        await navigate(route); await until(`document.querySelector('#profileName')?.value==='첫 캐릭터'`, `legacy ${route}`)
        check(await js(`document.querySelector('[data-section] input').value===${JSON.stringify(sites.get(1).sections[0].title)}`), `${route} 기존 별칭은 첫 캐릭터 조회로 연결`)
    }
    await reset(true, '/characters/2/edit')
    const firstBeforeSave = structuredClone(sites.get(1)), saveStart = writeCalls('save_character').length
    await set('#profileName', '둘째 저장 이름'); await set('#profileMessage', '수정한 상태'); await set('#keywords', '새 키워드,둘째')
    await set('[data-section] textarea', '  *저장 원문*\n_그대로_  '); await selectFile('#profileFile'); await selectFile('#feedFiles')
    await focus('#feedItems .sortableItem:last-child .dragHandle'); await key('Space', ' '); await key('ArrowUp'); await key('ArrowUp'); await key('Space', ' ')
    mode.saveDelay = 700
    await submit(); await submit()
    await untilRequests(() => writeCalls('save_character').length > saveStart, 'scoped save request')
    check(await js(`document.querySelector('fieldset').disabled && document.querySelector('.headerLogoutButton').disabled`), '저장 중 필드·헤더 로그아웃 잠금')
    await until(`document.body.innerText.includes('저장 성공')`, 'scoped save success'); await saveReady(); mode.saveDelay = 0
    check(writeCalls('save_character').length === saveStart + 1 && sites.get(2).profile.name === '둘째 저장 이름', '동기 중복 제출은 대상 캐릭터 RPC 한 번으로 저장')
    check(JSON.stringify(sites.get(1)) === JSON.stringify(firstBeforeSave), '다른 캐릭터 데이터는 수정·이미지 저장의 영향을 받지 않음')
    check(sites.get(2).profile.profile_image_path.startsWith('profile/2/') && sites.get(2).feed[0].image_path.startsWith('feed/2/') && sites.get(2).feed[1].id === 220 && sites.get(2).feed[2].id === 221, '프로필·피드 새 이미지가 대상 namespace에 저장되고 바뀐 피드 순서·기존 ID 보존')
    check(requests.filter(r => r.uploadBytes).every(r => r.uploadBytes.includes(image)), '이미지는 재인코딩하지 않고 선택한 원본 바이트로 업로드')
    check(sites.get(2).sections[0].content === '  *저장 원문*\n_그대로_  ' && sites.get(2).sections[0].id === 210, '기존 섹션 ID와 서식 원문 공백을 보존')
    check(!objects.has('profile/2/image.png') && objects.has('profile/1/image.png'), '확정 저장 후 미사용 이전 이미지만 정리')

    await reset(true, '/characters/2/edit')
    const invalidStart = writeCalls('save_character').length
    await set('#profileName', ''); await submit(); await pause(80)
    check(writeCalls('save_character').length === invalidStart && await js(`document.querySelector('#profileName').validationMessage.length>0`), '빈 이름은 저장 API 호출 전에 공통 검증 차단')
    await set('#profileName', '유효 이름'); await set('#profileMessage', ' '); await submit(); await pause(80)
    check(writeCalls('save_character').length === invalidStart && await js(`document.querySelector('#profileMessage').validationMessage.length>0`), '빈 상태 메시지도 저장 API 호출 전 차단')
    await set('#profileMessage', '유효 상태'); await set('#keywords', ', ,'); await submit(); await pause(80)
    check(writeCalls('save_character').length === invalidStart && await js(`document.querySelector('#keywords').validationMessage.length>0`), '빈 키워드는 저장 API 호출 전 차단')
    await set('#keywords', '유효'); await set('[data-section] textarea', ' '); await submit(); await pause(80)
    check(writeCalls('save_character').length === invalidStart && await js(`document.querySelector('[data-section] textarea').validationMessage.length>0`), '빈 섹션 내용은 저장 API 호출 전 차단')
    await set('[data-section] textarea', '유효 내용'); await set('[data-theme]', '#badhex'); await submit(); await pause(80)
    check(writeCalls('save_character').length === invalidStart && await js(`document.querySelector('[data-theme]').validationMessage.length>0`), '잘못된 테마색은 저장 API 호출 전 차단')

    await reset(true, '/characters/2/edit'); await set('#profileName', '충돌 보존'); await selectFile('#profileFile')
    const conflictPreview = await js(`document.querySelector('img[alt="프로필 이미지 미리보기"]').src`)
    mode.saveFailure = 'character_conflict'; await submit()
    await until(`document.body.innerText.includes('다른 창') && !document.querySelector('fieldset').disabled`, 'CAS conflict')
    check(await js(`document.querySelector('#profileName').value==='충돌 보존' && document.querySelector('img[alt="프로필 이미지 미리보기"]').src===${JSON.stringify(conflictPreview)}`), 'CAS 충돌에도 텍스트·선택 File 초안 유지')
    mode.saveFailure = null; await submit(); await until(`document.body.innerText.includes('저장 성공')`, 'conflict corrected retry')

    await reset(true, '/characters/2/edit'); await set('#profileName', '응답 유실 저장'); await selectFile('#profileFile')
    const lostStart = requests.length; mode.saveDropResponse = true; await submit()
    await until(`!!document.querySelector('[role=alert]') && !document.querySelector('fieldset').disabled`, 'lost save response')
    check(sites.get(2).profile.name === '응답 유실 저장' && !requests.slice(lostStart).some(r => r.method==='DELETE'), '저장 응답 유실 시 커밋 가능 이미지를 삭제하지 않음')
    const lostUploads = requests.slice(lostStart).filter(r => r.uploadPath).length
    await submit(); await until(`document.body.innerText.includes('저장 성공')`, 'lost save retry')
    check(requests.slice(lostStart).filter(r => r.uploadPath).length === lostUploads && sites.size === 2, '응답 유실 재시도는 같은 불변 업로드 경로를 재사용')

    await reset(true, '/characters/2/edit'); await set('#profileName', '업로드 재시도'); await selectFile('#profileFile')
    const uploadStart = writeCalls('save_character').length; mode.uploadFailure = true; mode.refStatus = 503; const uploadRequestStart = requests.length
    await submit(); await until(`!!document.querySelector('[role=alert]') && !document.querySelector('fieldset').disabled`, 'upload failure')
    check(writeCalls('save_character').length === uploadStart && await js(`document.querySelector('#profileName').value==='업로드 재시도'`), '이미지 업로드 실패 시 DB 저장 차단과 입력 유지')
    check(!requests.slice(uploadRequestStart).some(r=>r.method==='DELETE'), '전체 이미지 참조 조회 실패 시 정리 삭제를 중단')
    mode.refStatus = 200; await submit(); await until(`document.body.innerText.includes('저장 성공')`, 'upload retry success')
    check(sites.get(2).profile.name === '업로드 재시도', '업로드 실패 후 같은 File과 초안으로 재시도 가능')

    await reset(true, '/characters/2/edit')
    sites.get(1).profile.profile_image_path = sites.get(2).profile.profile_image_path
    await selectFile('#profileFile'); await nativeClick('#feedItems .picEditItem > button:last-child')
    mode.cleanupFailure = true; await submit()
    await until(`document.body.innerText.includes('이미지 정리') && !document.querySelector('fieldset').disabled`, 'cleanup warning after save')
    const savedCount = writeCalls('save_character').length
    check(objects.has('profile/2/image.png'), '다른 캐릭터가 참조하는 옛 프로필 이미지는 정리하지 않음')
    mode.cleanupFailure = false; await button('이미지 정리 다시 시도')
    await until(`!document.body.innerText.includes('이미지 정리 다시 시도') && !document.body.innerText.includes('이미지 정리 중') && !document.querySelector('fieldset').disabled`, 'cleanup retry success')
    check(writeCalls('save_character').length === savedCount && !objects.has('feed/2/first.png') && objects.has('profile/2/image.png'), '정리 재시도는 본문 재저장 없이 미참조 파일만 삭제')

    await reset(true, '/characters/2/edit'); await set('#profileName', '업로드 중 인증 종료'); await selectFile('#profileFile')
    const authUploadStart = requests.length, authSaveStart = writeCalls('save_character').length
    mode.uploadDelay = 900; await submit()
    await untilRequests(() => requests.slice(authUploadStart).some(r => r.uploadPath), 'delayed upload')
    await externalSignout(); await until(`document.body.innerText.includes('다시 로그인')`, 'upload session invalidation'); await pause(1100)
    check(writeCalls('save_character').length === authSaveStart && await js(`document.querySelector('#profileName').value==='업로드 중 인증 종료'`), '업로드 대기 중 인증 종료 후에는 저장 RPC를 진행하지 않고 초안 보존')
    await button('다시 로그인'); await until(`!!document.querySelector('#loginModal')`, 'upload reauth modal')
    await set('#loginModal input', 'test-only-password'); await nativeClick('#loginModal button[type=submit]')
    await until(`!document.querySelector('#loginModal') && !document.querySelector('fieldset').disabled`, 'upload reauth success')
    mode.uploadDelay = 0; await submit(); await until(`document.body.innerText.includes('저장 성공')`, 'auth recovered save')

    await reset(true, '/characters/new'); await until(`!!document.querySelector('#profileName')`, 'new create ready')
    const reservationStart = writeCalls('reserve_character_id').length
    await submit(); await pause(80)
    check(writeCalls('reserve_character_id').length === reservationStart && sites.size === 2, '신규 화면 진입·공란 제출만으로 예약이나 빈 캐릭터 생성 없음')
    await set('#profileName', '새 캐릭터 저장'); await set('#profileMessage', '새 상태'); await set('#keywords', '신규,테스트')
    await selectFile('#profileFile'); await selectFile('#feedFiles'); await button('^섹션 추가$'); await set('[data-section] input', '새 섹션'); await set('[data-section] textarea', ' *새 원문* ')
    mode.uploadFailure = true; mode.cleanupFailure = true; await submit()
    await until(`!!document.querySelector('[role=alert]') && !document.querySelector('fieldset').disabled`, 'new upload failure')
    check(sites.size === 2 && writeCalls('create_character').length === 0, '신규 업로드 실패에는 빈 캐릭터가 생성되지 않음')
    mode.createDelay = 700; const createStart = writeCalls('create_character').length
    await submit(); await submit(); await untilRequests(() => writeCalls('create_character').length > createStart, 'new create request')
    check(await js(`document.querySelector('fieldset').disabled && document.querySelector('.headerLogoutButton').disabled`), '신규 생성 중 중복 저장·로그아웃 잠금')
    await until(`location.pathname==='/characters/3' && document.querySelector('.profileName')?.textContent==='새 캐릭터 저장'`, 'new create navigate')
    check(sites.size === 3 && writeCalls('create_character').length === createStart + 1 && order.at(-1) === 3, '첫 저장이 관련 행과 마지막 순서를 만들고 실제 프로필 주소로 이동')
    check(sites.get(3).profile.profile_image_path.startsWith('profile/3/') && sites.get(3).feed[0].image_path.startsWith('feed/3/'), '신규 예약 ID 아래 이미지 업로드 후 생성')
    check(await js(`document.body.innerText.includes('이미지 정리 다시 시도')`), '생성 성공 후 프로필로 이동해도 남은 이미지 정리 재시도 표시')
    const createdWrites = writeCalls('create_character').length
    mode.cleanupFailure = false; mode.cleanupDelay = 700; await button('이미지 정리 다시 시도')
    await until(`document.body.innerText.includes('이미지 정리 중')`, 'new public cleanup busy')
    check(await js(`document.querySelector('.headerLogoutButton').disabled`), '이동한 프로필의 정리 작업도 로그아웃 차단')
    await until(`!document.body.innerText.includes('이미지 정리')`, 'new public cleanup success')
    check(writeCalls('create_character').length === createdWrites && sites.size === 3, '프로필에서 정리 재시도는 캐릭터 생성·저장을 반복하지 않음')

    await reset(true, '/characters/new'); await until(`!!document.querySelector('#profileName')`, 'lost create form')
    await set('#profileName', '생성 전 원문'); await set('#profileMessage', '첫 상태'); await set('#keywords', '신규'); await selectFile('#profileFile')
    mode.createDropResponse = true; const lostCreateStart = requests.length; await submit()
    await until(`!!document.querySelector('[role=alert]') && !document.querySelector('fieldset').disabled`, 'lost create response')
    check(sites.size === 3 && await js(`location.pathname==='/characters/new' && document.querySelector('#profileName').value==='생성 전 원문'`), '생성 응답 유실에도 새 폼과 초안을 보존')
    await set('#profileName', '유실 후 바뀐 이름'); await set('#profileMessage', '바뀐 상태'); await submit()
    await until(`location.pathname==='/characters/3' && document.querySelector('.profileName')?.textContent==='유실 후 바뀐 이름'`, 'lost create edited retry')
    const creationAttempts = requests.slice(lostCreateStart).filter(r => r.method === 'POST' && r.path.endsWith('/create_character'))
    check(sites.size === 3 && new Set(creationAttempts.map(r=>r.body.p_request_id)).size === 1 && creationAttempts.every(r=>r.body.p_character_id===3), '생성 재시도는 같은 UUID·예약 ID를 사용해 중복 캐릭터를 만들지 않음')
    check(writeCalls('save_character').some(r=>r.body.p_character_id===3 && r.body.p_data.profile.name==='유실 후 바뀐 이름'), '최초 생성 결과 확인 후 바뀐 초안은 해당 캐릭터 수정으로 저장')

    await reset(true, '/characters/2/edit'); const deleteStart = writeCalls('delete_character').length
    await button('^캐릭터 삭제$'); await pause(80)
    check(sites.has(2) && writeCalls('delete_character').length === deleteStart, '삭제 확인 취소 시 DB·이미지 변경 없음')
    acceptDialog = true; mode.deleteDropResponse = true; mode.deleteDelay = 700; await button('^캐릭터 삭제$'); acceptDialog = false
    await untilRequests(() => writeCalls('delete_character').length > deleteStart, 'pending delete');check(await js(`document.querySelector('fieldset').disabled && document.querySelector('.headerLogoutButton').disabled`), '삭제 중 필드·다른 저장·로그아웃 잠금')
    await until(`!!document.querySelector('[role=alert]') && !document.querySelector('fieldset').disabled`, 'lost delete response')
    check(!sites.has(2) && await js(`location.pathname==='/characters/2/edit' && document.querySelector('#profileName').value==='둘째 캐릭터'`), '삭제 응답 유실 시 기존 화면을 유지하고 재시도 가능')
    mode.cleanupFailure = true; acceptDialog = true; await button('^캐릭터 삭제$'); acceptDialog = false
    await until(`location.pathname==='/' && document.querySelectorAll('.character').length===1`, 'delete retry navigate')
    check(sites.has(1) && !sites.has(2), '삭제 결과 재시도는 다른 캐릭터를 보존하고 메인으로 이동')
    check(await js(`document.body.innerText.includes('이미지 정리 다시 시도')`), '삭제 완료 후 메인으로 이동해도 미완료 이미지 정리 재시도 표시')
    await navigate('/'); await until(`document.querySelectorAll('.character').length===1 && document.body.innerText.includes('이미지 정리 다시 시도')`, 'cleanup journal restored')
    const deletedWrites = writeCalls('delete_character').length
    mode.cleanupFailure = false; mode.cleanupDelay = 700; await button('이미지 정리 다시 시도')
    await until(`document.body.innerText.includes('이미지 정리 중')`, 'deleted public cleanup busy')
    check(await js(`document.querySelector('.headerLogoutButton').disabled`), '복원된 정리 기록 처리 중에도 로그아웃 차단')
    await until(`!document.body.innerText.includes('이미지 정리')`, 'deleted public cleanup done')
    check(writeCalls('delete_character').length === deletedWrites && !objects.has('profile/2/image.png') && objects.has('profile/1/image.png'), '새로고침 후 정리 기록을 복원하고 재삭제 RPC 없이 삭제 대상 이미지만 정리')
    mode.cleanupDelay = 0
    await spa('/characters/1/edit'); await until(`!!document.querySelector('#profileName')`, 'last character editor')
    acceptDialog = true; await button('^캐릭터 삭제$'); acceptDialog = false
    await until(`location.pathname==='/' && document.body.innerText.includes('등록된 캐릭터가 없습니다')`, 'last character deletion')
    check(sites.size === 0 && await js(`document.querySelectorAll('.character').length===0`), '마지막 캐릭터 삭제 후 빈 메인 목록 표시')

    await reset(true, '/characters/999/edit'); await until(`document.body.innerText.includes('찾을 수')`, 'missing editor')
    check(!await hasEditor(), '없는 캐릭터 수정 경로가 다른 캐릭터 편집기로 대체되지 않음')

    const cardOrder = () => js(`[...document.querySelectorAll('.character')].map(card=>Number(card.getAttribute('href').split('/').at(-1)))`)
    const mainReady = async () => {
        await until(`document.querySelectorAll('.character').length===2 && document.querySelectorAll('main .dragHandle').length===2 && document.querySelectorAll('[data-theme]').length===4`, 'main management ready')
    }
    const mainUnlocked = () => until(`document.querySelector('main')?.getAttribute('aria-busy')!=='true' && !!document.querySelector('.headerLogoutButton:not(:disabled)')`, 'main mutation completed')
    const orderButton = `[...document.querySelectorAll('main button')].find(button=>button.textContent.trim()==='순서 저장')`
    const reorderMainKeyboard = async (direction = 'ArrowDown', cancel = false) => {
        await focus('main .dragHandle'); await key('Space', ' '); await key(direction); await key(cancel ? 'Escape' : 'Space', cancel ? 'Escape' : ' ')
    }
    const pointerReorderMain = async (touch = false) => {
        await js(`document.querySelector('main .sortableList').scrollIntoView({block:'center'})`)
        const points = await js(`[...document.querySelectorAll('main .dragHandle')].slice(0,2).map(button=>{const r=button.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})`)
        const [start, end] = points
        if (touch) await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, ...start }] })
        else await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', buttons: 1, clickCount: 1 })
        for (let step = 1; step <= 6; step++) {
            const point = { x: start.x, y: start.y + (end.y - start.y) * step / 6 }
            if (touch) await cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, ...point }] })
            else await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, buttons: 1 })
            await pause(70)
        }
        if (touch) await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        else await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, button: 'left', buttons: 0, clickCount: 1 })
        await pause(250)
    }

    await reset(true, '/'); await mainReady()
    const mainWriteStart = writeCalls('save_character_order').length + writeCalls('save_main_theme').length
    check(await js(`!(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented})()`), '메인 초기 조회 상태는 미저장 이탈 경고 없음')
    await reorderMainKeyboard('ArrowDown', true)
    check(JSON.stringify(await cardOrder()) === '[2,1]' && order.join() === '2,1', '메인 키보드 정렬 취소는 화면·DB 순서를 유지')
    await reorderMainKeyboard()
    check(JSON.stringify(await cardOrder()) === '[1,2]' && order.join() === '2,1'
        && writeCalls('save_character_order').length + writeCalls('save_main_theme').length === mainWriteStart, '메인 키보드 드래그는 저장 버튼 전까지 로컬 순서만 변경')
    await set('[data-theme="--main-color"]', '#112233')
    check(await selectedColor() === '#112233' && mainTheme.main_color === initialMainTheme.main_color, '메인 테마 편집은 CSS 미리보기만 적용하고 DB 저장은 대기')
    check(await js(`(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented})()`), '메인 순서·테마 초안도 새로고침 이탈 경고 대상')
    const beforeOrderTheme = structuredClone(mainTheme), beforeCharacters = JSON.stringify([...sites])
    await button('^순서 저장$'); await untilRequests(() => order.join() === '1,2', 'main order save'); await mainUnlocked()
    const orderCall = writeCalls('save_character_order').at(-1)
    check(JSON.stringify(orderCall.body) === JSON.stringify({ p_expected: [2, 1], p_order: [1, 2] }), '메인 순서 저장은 기준·변경 ID 배열만 새 RPC에 전달')
    check(mainTheme.main_color === beforeOrderTheme.main_color && await js(`document.querySelector('[data-theme="--main-color"]').value==='#112233'`), '순서 저장이 미저장 메인 테마 초안을 초기화하거나 저장하지 않음')
    await reorderMainKeyboard()
    check(JSON.stringify(await cardOrder()) === '[2,1]', '순서 저장 후 새 기준으로 다시 순서 편집 가능')
    await button('^테마 저장$'); await untilRequests(() => mainTheme.main_color === '#112233', 'main theme save'); await mainUnlocked()
    check(JSON.stringify(await cardOrder()) === '[2,1]' && order.join() === '1,2', '메인 테마 저장이 미저장 카드 순서를 초기화하거나 저장하지 않음')
    const themeCall = writeCalls('save_main_theme').at(-1)
    check(themeCall.body.p_expected.id === 1 && themeCall.body.p_expected.main_color === initialMainTheme.main_color
        && themeCall.body.p_data.main_color === '#112233' && !('id' in themeCall.body.p_data) && JSON.stringify([...sites]) === beforeCharacters, '메인 테마 RPC는 메인 기준·4색상만 저장하고 캐릭터 내용·테마는 독립 유지')
    await button('^순서 저장$'); await untilRequests(() => order.join() === '2,1', 'second main order save'); await mainUnlocked()
    check(await js(`!(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented})()`), '각각 저장을 마친 메인 초안은 이탈 경고 해제')
    await navigate('/'); await mainReady()
    check(JSON.stringify(await cardOrder()) === '[2,1]' && await selectedColor() === '#112233', '메인 순서·테마는 재조회 후에도 저장 상태 유지')
    await nativeClick('a[href="/characters/2"]'); await until(`!!document.querySelector('.profileName')`, 'profile after main save')
    check(await selectedColor() === initial(2).theme.main_color, '저장된 메인 테마가 개별 캐릭터 테마를 덮어쓰지 않음')
    await nativeClick('.homeButton'); await mainReady(); await nativeClick('a[href="/characters/new"]'); await until(`!!document.querySelector('#profileName')`, 'new character inherits saved main theme')
    check(await selectedColor() === '#112233', '신규 캐릭터 폼은 저장된 최신 메인 테마를 초기값으로 복사')

    await reset(true, '/'); await mainReady(); await pointerReorderMain()
    check(JSON.stringify(await cardOrder()) === '[1,2]' && order.join() === '2,1', '메인 카드 포인터 드래그가 카드 이동 없이 로컬 순서 변경')
    const mainDialogs = dialogs.length
    await nativeClick('a[href="/characters/new"]'); await pause(100)
    check(await js(`location.pathname==='/'`) && dialogs.length === mainDialogs + 1 && JSON.stringify(await cardOrder()) === '[1,2]', '미저장 순서 상태에서 캐릭터 추가 이동 취소 시 메인 초안 유지')
    await nativeClick('a[href="/characters/1"]'); await pause(100)
    check(await js(`location.pathname==='/'`) && JSON.stringify(await cardOrder()) === '[1,2]', '미저장 순서 상태에서 카드 링크 이동 취소 시 초안 유지')
    const touchWriteStart = writeCalls('save_character_order').length
    await reset(true, '/'); await mainReady()
    await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
    await pointerReorderMain(true)
    check(JSON.stringify(await cardOrder()) === '[1,2]' && writeCalls('save_character_order').length === touchWriteStart, '모바일 터치 드래그도 저장 전까지 로컬 순서만 변경')
    check(await js(`document.documentElement.scrollWidth<=innerWidth && !document.querySelector('.character button')`), '관리자 모바일 카드·일반 이동 버튼에 가로 넘침·중첩 버튼 없음')
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: false })
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1100, deviceScaleFactor: 1, mobile: false })

    await reset(true, '/'); await mainReady(); await reorderMainKeyboard(); await set('[data-theme="--main-color"]', '#334455')
    mode.orderDelay = 1000
    const busyOrderStart = writeCalls('save_character_order').length, busyThemeStart = writeCalls('save_main_theme').length
    await button('^순서 저장'); await button('^순서 저장')
    await untilRequests(() => writeCalls('save_character_order').length > busyOrderStart, 'main busy order')
    check(await js(`document.querySelector('.headerLogoutButton').disabled && [...document.querySelectorAll('main .dragHandle,main [data-theme]')].every(element=>element.matches(':disabled'))`), '메인 순서 저장 중 드래그·테마 입력·로그아웃 잠금')
    await button('^테마 저장'); await nativeClick('a[href="/characters/new"]'); await pause(100)
    check(await js(`location.pathname==='/'`) && writeCalls('save_main_theme').length === busyThemeStart, '순서 저장 중 테마 저장·캐릭터 추가가 동시에 실행되지 않음')
    await untilRequests(() => order.join() === '1,2', 'busy main order finish'); await mainUnlocked(); mode.orderDelay = 0
    check(writeCalls('save_character_order').length === busyOrderStart + 1 && await js(`document.querySelector('[data-theme="--main-color"]').value==='#334455'`), '같은 틱 중복 순서 저장 차단과 별도 테마 초안 보존')
    mode.themeDelay = 800
    await button('^테마 저장'); await button('^테마 저장')
    await untilRequests(() => writeCalls('save_main_theme').length > busyThemeStart, 'busy main theme')
    check(await js(`document.querySelector('.headerLogoutButton').disabled && document.querySelector('main .dragHandle').matches(':disabled')`), '메인 테마 저장 중에도 순서 조작·로그아웃 잠금')
    await untilRequests(() => mainTheme.main_color === '#334455', 'busy main theme finish'); await mainUnlocked(); mode.themeDelay = 0
    check(writeCalls('save_main_theme').length === busyThemeStart + 1, '같은 틱 중복 메인 테마 저장은 RPC 한 번만 실행')

    await reset(true, '/'); await mainReady()
    const sortingWriteStart = writeCalls('save_character_order').length + writeCalls('save_main_theme').length
    await focus('main .dragHandle'); await key('Space', ' '); await key('ArrowDown')
    await button('^순서 저장'); await button('^테마 저장'); await nativeClick('a[href="/characters/new"]')
    check(await js(`location.pathname==='/'`) && writeCalls('save_character_order').length + writeCalls('save_main_theme').length === sortingWriteStart, '메인 드래그 진행 중 저장·캐릭터 추가가 동시에 실행되지 않음')
    await key('Escape'); await mainUnlocked()
    check(JSON.stringify(await cardOrder()) === '[2,1]', '메인 드래그 취소 후 동기 잠금 해제와 원래 순서 복원')

    await reset(true, '/'); await mainReady()
    const invalidThemeStart = writeCalls('save_main_theme').length
    await set('[data-theme="--main-color"]', 'not-a-color'); await button('^테마 저장'); await pause(100)
    check(writeCalls('save_main_theme').length === invalidThemeStart && await js(`document.querySelector('[data-theme="--main-color"]').validationMessage.length>0`), '잘못된 메인 헥스코드는 저장 RPC 호출 전 차단')
    await reorderMainKeyboard(); await button('^순서 저장$'); await untilRequests(() => order.join() === '1,2', 'order independent of invalid theme'); await mainUnlocked()
    check(await js(`document.querySelector('[data-theme="--main-color"]').value==='not-a-color'`), '메인 테마가 잘못되어도 독립 순서 저장 가능하고 잘못된 초안은 유지')

    await reset(true, '/'); await mainReady(); await reorderMainKeyboard(); await set('[data-theme="--main-color"]', '#667788')
    sites.set(3, { ...initial(3), profile: { ...initial(3).profile, name: '다른 창 추가' } }); order.push(3)
    await button('^순서 저장$'); await until(`!!document.querySelector('main [role=alert]')`, 'main membership conflict'); await mainUnlocked()
    check(order.join() === '2,1,3' && JSON.stringify(await cardOrder()) === '[1,2]' && await js(`document.querySelector('[data-theme="--main-color"]').value==='#667788'`), '다른 창의 캐릭터 추가와 순서 저장 충돌 시 새 카드를 누락시키지 않고 두 초안 보존')
    await button('편집 내용을 버리고 DB에서 다시 불러오기'); await pause(100)
    check(JSON.stringify(await cardOrder()) === '[1,2]', '충돌 후 DB 재조회 취소 시 메인 초안 유지')
    acceptDialog = true; await button('편집 내용을 버리고 DB에서 다시 불러오기'); acceptDialog = false
    await until(`document.querySelectorAll('.character').length===3`, 'main conflict reload')
    check(JSON.stringify(await cardOrder()) === '[2,1,3]' && await selectedColor() === initialMainTheme.main_color && !await js(`!!document.querySelector('main [role=alert]')`), '명시적 재조회 승인 후 최신 멤버십·테마 복원과 이전 충돌 안내 초기화')

    await reset(true, '/'); await mainReady(); await set('[data-theme="--main-color"]', '#556677'); await reorderMainKeyboard()
    mainTheme.main_color = '#fedcba'
    await button('^테마 저장$'); await until(`!!document.querySelector('main [role=alert]')`, 'main theme conflict'); await mainUnlocked()
    check(mainTheme.main_color === '#fedcba' && await selectedColor() === '#556677' && JSON.stringify(await cardOrder()) === '[1,2]', '다른 창의 메인 테마 변경을 CAS로 보호하고 테마·순서 초안 보존')

    await reset(true, '/'); await mainReady(); await reorderMainKeyboard()
    const lostOrderStart = writeCalls('save_character_order').length
    mode.orderDropResponse = true; await button('^순서 저장$'); await until(`!!document.querySelector('main [role=alert]')`, 'lost main order response'); await mainUnlocked()
    check(order.join() === '1,2' && JSON.stringify(await cardOrder()) === '[1,2]', '순서 응답 유실에도 서버 반영 가능 결과와 로컬 초안 보존')
    await button('^순서 저장$'); await mainUnlocked()
    await untilRequests(() => writeCalls('save_character_order').length === lostOrderStart + 2, 'main order retry')
    check(JSON.stringify(writeCalls('save_character_order').at(-1).body) === JSON.stringify(writeCalls('save_character_order').at(-2).body), '순서 응답 유실 재시도는 같은 기준·ID 순서로 확인')
    const lostThemeStart = writeCalls('save_main_theme').length
    await set('[data-theme="--main-color"]', '#789abc'); mode.themeDropResponse = true; await button('^테마 저장$')
    await until(`!!document.querySelector('main [role=alert]')`, 'lost main theme response'); await mainUnlocked()
    check(mainTheme.main_color === '#789abc' && await selectedColor() === '#789abc', '메인 테마 응답 유실 시 CSS·입력 초안 유지')
    await button('^테마 저장$'); await mainUnlocked()
    await untilRequests(() => writeCalls('save_main_theme').length === lostThemeStart + 2, 'main theme retry')
    check(JSON.stringify(writeCalls('save_main_theme').at(-1).body) === JSON.stringify(writeCalls('save_main_theme').at(-2).body), '메인 테마 응답 유실 재시도도 같은 메인 기준·색상으로 확인')

    await reset(true, '/'); await mainReady(); await reorderMainKeyboard(); await set('[data-theme="--main-color"]', '#abcdef')
    const expiredMainStart = writeCalls('save_character_order').length + writeCalls('save_main_theme').length
    mode.userStatus = 503; await refresh(); await until(`document.body.innerText.includes('로그인 상태 확인 실패')`, 'main auth verification failed')
    check(await js(`[...document.querySelectorAll('main .dragHandle,main [data-theme]')].every(element=>element.matches(':disabled'))`)
        && writeCalls('save_character_order').length + writeCalls('save_main_theme').length === expiredMainStart, '메인 인증 재확인 실패 시 관리 조작·자동 저장 차단')
    mode.userStatus = 200; await button('다시 확인'); await mainUnlocked()
    check(JSON.stringify(await cardOrder()) === '[1,2]' && await selectedColor() === '#abcdef', '메인 인증 복구가 미저장 순서·테마를 서버 값으로 덮어쓰지 않음')
    await externalSignout(); await until(`document.body.innerText.includes('다시 로그인')`, 'main session expired')
    check(await js(`[...document.querySelectorAll('main .dragHandle,main [data-theme]')].every(element=>element.matches(':disabled'))`), '메인 인증 만료 상태에서는 관리 조작을 숨기거나 잠금')
    await button('다시 로그인'); await until(`!!document.querySelector('#loginModal')`, 'main reauth modal')
    await set('#loginModal input', 'test-only-password'); await nativeClick('#loginModal button[type=submit]'); await mainUnlocked()
    check(JSON.stringify(await cardOrder()) === '[1,2]' && await selectedColor() === '#abcdef'
        && writeCalls('save_character_order').length + writeCalls('save_main_theme').length === expiredMainStart, '메인 재로그인 복구 후 두 초안 유지·자동 저장 없음')
    const explicitLogoutMainLoads = requests.filter(request => request.path === '/rest/v1/rpc/load_main').length
    acceptDialog = true; await nativeClick('.headerLogoutButton'); acceptDialog = false
    await until(`!!document.querySelector('.headerLoginButton:not(:disabled)')`, 'main explicit logout')
    await untilRequests(() => requests.filter(request => request.path === '/rest/v1/rpc/load_main').length > explicitLogoutMainLoads, 'new public main query after explicit logout')
    await until(`location.pathname==='/' && document.title==='캐릭터 모음' && document.querySelector('main')?.getAttribute('aria-busy')==='false'
        && !document.querySelector('main .dragHandle') && !document.querySelector('[data-theme]')
        && JSON.stringify([...document.querySelectorAll('.character')].map(card=>Number(card.getAttribute('href').split('/').at(-1))))==='[2,1]'
        && getComputedStyle(document.documentElement).getPropertyValue('--main-color').trim()===${JSON.stringify(initialMainTheme.main_color)}`, 'public main query and saved theme settled after logout')
    check(JSON.stringify(await cardOrder()) === '[2,1]' && await selectedColor() === initialMainTheme.main_color
        && !await js(`!!document.querySelector('main .dragHandle') || !!document.querySelector('[data-theme]')`), '명시적 로그아웃 승인 시 메인 초안 폐기하고 저장된 공개 순서·테마만 표시')

    await reset(true, '/'); sites.delete(2); order = [1]; await navigate('/')
    await until(`document.querySelectorAll('.character').length===1 && !!document.querySelector('main .dragHandle')`, 'single main character and lazy sorting controls')
    check(await js(`document.querySelector('main .dragHandle')?.disabled===true && ${orderButton}?.disabled`), '캐릭터 한 개에서는 순서 이동·불필요한 순서 저장 비활성')
    sites.clear(); order = []; await navigate('/'); await until(`document.body.innerText.includes('등록된 캐릭터가 없습니다') && !!document.querySelector('[data-theme]')`, 'empty admin collection')
    check(await js(`!document.querySelector('.character') && !!document.querySelector('a[href="/characters/new"]')`), '빈 관리자 메인도 캐릭터 추가·메인 테마 편집 접근 가능')
    await set('[data-theme="--main-color"]', '#224466'); await button('^테마 저장$'); await untilRequests(() => mainTheme.main_color === '#224466', 'empty main theme save'); await mainUnlocked()
    check(sites.size === 0 && mainTheme.main_color === '#224466', '캐릭터가 없어도 메인 테마 저장을 독립 지원')

    await reset(false, '/')
    for (const route of ['/characters/2/edit', '/characters/new', '/edit', '/manage.html']) {
        await navigate(route); await until(`location.pathname==='/' && !!document.querySelector('.headerLoginButton:not(:disabled)')`, `protected ${route}`)
        check(!await hasEditor(), `${route} 미인증 편집 접근 차단`)
    }
    await nativeClick('.headerLoginButton'); await until(`document.querySelector('#loginModal')?.matches(':modal')`, 'login modal open')
    await set('#loginModal input', 'cancelled-password'); await key('Tab'); await key('Tab', 'Tab', 8)
    check(await js(`!!document.activeElement?.closest('#loginModal') && document.body.style.position==='fixed'`), '로그인 모달 키보드 포커스·배경 스크롤 잠금')
    await key('Escape'); await until(`!document.querySelector('#loginModal')`, 'login modal closed')
    check(await js(`document.activeElement===document.querySelector('.headerLoginButton') && document.body.style.position===''`), '로그인 모달 닫기 후 호출 버튼 포커스 복원')
    await nativeClick('.headerLoginButton'); await until(`!!document.querySelector('#loginModal')`, 'reopen login')
    check(await js(`document.querySelector('#loginModal input').value===''`), '로그인 재열기 시 비밀번호 초기화')
    mode.tokenStatus = 400; await set('#loginModal input', 'bad-password'); await nativeClick('#loginModal button[type=submit]')
    await until(`!!document.querySelector('#loginModal [role=alert]')`, 'login failure')
    check(await js(`!document.querySelector('#loginModal button[type=submit]').matches(':disabled')`), '로그인 실패 후 재시도 가능')
    mode.tokenStatus = 200; mode.tokenDelay = 900; await set('#loginModal input', 'test-only-password'); await nativeClick('#loginModal button[type=submit]'); await key('Escape'); await clickWithoutScroll('.headerLoginButton')
    check(await js(`!!document.querySelector('#loginModal')`), '로그인 요청 중 Escape·바깥 닫기 차단')
    await until(`!document.querySelector('#loginModal') && !!document.querySelector('.headerLogoutButton')`, 'login completed')
    check(await js(`location.pathname==='/' && !document.querySelector('#profileName')`), '헤더 로그인 후 현재 메인 주소 유지')
    const legacy = requests.filter(r => /\/rpc\/(load_site|save_site)$/.test(r.path))
    const writes = requests.filter(r => r.path.startsWith('/storage/') && r.method !== 'GET' && r.method !== 'OPTIONS'
        || r.path.startsWith('/rest/v1/') && r.method !== 'OPTIONS' && !/\/rpc\/load_(main|character)$/.test(r.path))
    check(legacy.length === 0 && !writes.some(r => r.path.startsWith('/rest/v1/') && !r.path.startsWith('/rest/v1/rpc/')), '모든 쓰기는 새 캐릭터 RPC·격리 Storage mock을 사용하고 구 RPC·직접 테이블 요청 없음')
    check(errors.length===0,'브라우저 실행 예외 없음')
    console.log(JSON.stringify({phase,passed:passed.length,checks:passed,errors},null,2))
} catch(error) {
    const diagnostics=js?await js(`({url:location.pathname,buttons:[...document.querySelectorAll('button')].map(b=>({text:b.textContent,disabled:b.matches(':disabled')}))})`).catch(()=>null):null;console.error(JSON.stringify({phase,passed:passed.length,checks:passed,errors,diagnostics,dialogs,viteLogs,chromeDiagnostics,requests:requests.slice(-12).map(r=>({method:r.method,path:r.path,body:r.body,cancelled:r.cancelled})),failure:error.stack},null,2));process.exitCode=1
} finally {
    if(cdp){try{await Promise.race([cdp('Browser.close'),pause(1000)])}catch{}}
    for(const task of pending.values())task.reject(new Error('Browser test finished'))
    pending.clear()
    ws?.close();chrome?.kill();vite?.kill();api.closeAllConnections();await new Promise(resolve=>api.close(resolve))
    if(temp){const resolved=path.resolve(temp);if(!resolved.startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(resolved).startsWith('profile-editor-check-')){console.error('Unsafe temporary cleanup path');process.exitCode=1}else{await pause(300);await fs.rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200})}}
}

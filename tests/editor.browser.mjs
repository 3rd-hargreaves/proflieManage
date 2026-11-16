import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const phase = 4
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
const deadline = Date.now() + 180000
const checkDeadline = () => { if (Date.now() > deadline) throw new Error('Browser regression exceeded its 3 minute deadline') }
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
const mainTheme = { id: 1, main_color: '#c34f78', background_color: '#ffedf4', card_background_color: '#fffafc', typo_color: '#221122' }
let sites = new Map([[1, initial(1)], [2, initial(2)]])
let mode = { userStatus: 200, userDelay: 0, tokenDelay: 0 }
const requests = []
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=', 'base64')
const api = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString()
    const entry = { method: req.method, path: url.pathname, body: null }; requests.push(entry)
    if (raw) { try { entry.body = JSON.parse(raw) } catch {} }
    res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    const send = (status, data) => { if (res.destroyed) return; res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(data === undefined ? undefined : JSON.stringify(data)) }
    if (url.pathname === '/auth/v1/user') { const status = mode.userStatus; await pause(mode.userDelay); send(status, status === 200 ? user : { code: status === 401 ? 'bad_jwt' : 'unexpected_failure', msg: 'Mock verification failure' }); return }
    if (url.pathname === '/auth/v1/token') { const status = mode.tokenStatus ?? 200; await pause(mode.tokenDelay); send(status, status === 200 ? session() : { error: 'invalid_grant', error_code: 'invalid_credentials', msg: 'Invalid login credentials' }); return }
    if (url.pathname === '/auth/v1/logout') { send(204); return }
    if (url.pathname === '/rest/v1/rpc/load_main' || url.pathname === '/rest/v1/rpc/load_character') {
        const id = Number(entry.body?.p_character_id)
        const isMain = url.pathname.endsWith('/load_main')
        const data = structuredClone(isMain ? { characters: mode.empty ? [] : [2, 1].filter(id => sites.has(id)).map(id => ({ ...sites.get(id).profile, sort_order: id === 2 ? 1 : 2 })), theme: mainTheme } : sites.get(id) ?? null)
        const status = isMain ? mode.mainStatus ?? 200 : mode.characterStatus?.[id] ?? 200
        const delay = isMain ? mode.mainDelay ?? 0 : mode.characterDelay?.[id] ?? 0
        entry.characterId = isMain ? null : id
        entry.snapshotName = isMain ? 'main' : data?.profile.name
        res.once('close', () => { if (!res.writableEnded) entry.cancelled = true })
        await pause(delay)
        send(status, status === 200 ? data : { code: 'unexpected_failure', message: 'Mock snapshot failure' })
        return
    }
    if (url.pathname.startsWith('/storage/v1/object/public/') && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(image); return }
    send(500, { error: 'Unexpected write or legacy request' })
})
const listen = server => new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)))
const freePort = async()=>{const server=http.createServer();const port=await listen(server);await new Promise(r=>server.close(r));return port}
let vite,chrome,ws,temp
let launchError
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
    chrome=spawn(chromePath,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${path.join(temp,'chrome')}`,'about:blank'],{windowsHide:true,stdio:'ignore'})
    chrome.on('error',error=>{launchError=error})
    let target
    for(let i=0;i<100;i++){checkDeadline();if(launchError)throw launchError;try{target=(await fetchJson(`http://127.0.0.1:${debugPort}/json`)).find(t=>t.type==='page');if(target)break}catch{}await pause(100)}
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
        acceptDialog = true
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
    const selectedColor = () => js(`getComputedStyle(document.documentElement).getPropertyValue('--main-color').trim()`)
    const readRequests = () => requests.filter(r => r.method === 'POST' && /\/rpc\/load_(main|character)$/.test(r.path))

    await navigate('/')
    await reset(false, '/')
    await until(`document.querySelectorAll('.character').length===2`, 'public collection')
    check(await js(`[...document.querySelectorAll('.character')].map(a=>a.getAttribute('href')).join('|')==='/characters/2|/characters/1'`), '메인 카드가 RPC의 여러 캐릭터·저장 순서와 주소를 사용')
    check(await selectedColor() === mainTheme.main_color, '메인 화면이 캐릭터와 별개의 저장된 메인 테마 사용')
    check(await js(`!document.querySelector('.headerEditLink') && ![...document.querySelectorAll('button,a')].some(e=>/^(순서 저장|캐릭터 추가|테마 저장)$/.test(e.textContent.trim()))`), '방문자에게 관리자 컨트롤 숨김')
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
    check(await js(`document.querySelector('[data-section] textarea').value===${JSON.stringify(initial(2).sections[0].content)} && document.querySelector('button[type=submit]').matches(':disabled')`), '수정 조회는 대상 ID·원문을 유지하고 저장 연결 전 제출 비활성화')
    check(await selectedColor() === initial(2).theme.main_color, '수정 화면도 캐릭터별 테마 적용')
    check(await js(`[...document.querySelectorAll('main button')].at(-1)?.textContent.trim()==='캐릭터 삭제' && [...document.querySelectorAll('main button')].at(-1).matches(':disabled')`), '수정 화면 최하단 삭제 버튼도 후속 저장 연결 전 비활성화')
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
    check(await js(`document.querySelector('button[type=submit]').matches(':disabled')`), '강제 submit도 저장 API 연결 전 차단')
    acceptDialog = true; await nativeClick('.homeButton'); acceptDialog = false
    await until(`document.querySelectorAll('.character').length===2`, 'admin collection')
    check(await js(`[...document.querySelectorAll('button,a')].filter(e=>/^(순서 저장|캐릭터 추가|테마 저장)$/.test(e.textContent.trim())).length===3 && !document.querySelector('.headerEditLink')`), '관리자 모음에만 관리 컨트롤 표시')
    await nativeClick('a[href="/characters/new"]'); await until(`!!document.querySelector('#profileName')`, 'new blank form')
    check(await js(`document.querySelector('#profileName').value==='' && document.querySelector('#profileMessage').value==='' && document.querySelector('#keywords').value==='' && document.querySelectorAll('[data-section]').length===0 && document.querySelector('button[type=submit]').matches(':disabled')`), '신규 폼은 빈 정보·목록으로 열리고 저장 비활성화')
    check(await selectedColor() === mainTheme.main_color, '신규 폼 초기 테마가 저장된 메인 테마를 복사')
    await set('#profileName', '새 초안'); await button('^섹션 추가$'); await selectFile('#profileFile')
    check(await js(`document.querySelectorAll('[data-section]').length===1 && document.querySelector('img[alt="프로필 이미지 미리보기"]').src.startsWith('blob:')`), '신규 폼의 로컬 섹션·File 미리보기 유지')
    await nativeClick('.homeButton'); await pause(80)
    check(await js(`location.pathname==='/characters/new' && document.querySelector('#profileName').value==='새 초안'`), '신규 작성 이탈 취소 시 초안 유지')
    acceptDialog = true; await nativeClick('.homeButton'); acceptDialog = false
    for (const route of ['/edit', '/manage.html', '/edit/', '/manage.html/']) {
        await navigate(route); await until(`document.querySelector('#profileName')?.value==='첫 캐릭터'`, `legacy ${route}`)
        check(await js(`document.querySelector('[data-section] input').value==='캐릭터 1 첫 섹션'`), `${route} 기존 별칭은 첫 캐릭터 조회로 연결`)
    }
    await reset(true, '/characters/999/edit'); await until(`document.body.innerText.includes('찾을 수')`, 'missing editor')
    check(!await hasEditor(), '없는 캐릭터 수정 경로가 다른 캐릭터 편집기로 대체되지 않음')

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
    check(legacy.length === 0 && writes.length === 0, '전체 동선에서 구 RPC·직접 테이블 조회·DB/Storage 쓰기 없음')
    check(errors.length===0,'브라우저 실행 예외 없음')
    console.log(JSON.stringify({phase,passed:passed.length,checks:passed,errors},null,2))
} catch(error) {
    const diagnostics=js?await js(`({url:location.pathname,buttons:[...document.querySelectorAll('button')].map(b=>({text:b.textContent,disabled:b.matches(':disabled')}))})`).catch(()=>null):null;console.error(JSON.stringify({phase,passed:passed.length,checks:passed,errors,diagnostics,dialogs,viteLogs,requests:requests.slice(-12).map(r=>({method:r.method,path:r.path,body:r.body,cancelled:r.cancelled})),failure:error.stack},null,2));process.exitCode=1
} finally {
    if(cdp){try{await Promise.race([cdp('Browser.close'),pause(1000)])}catch{}}
    for(const task of pending.values())task.reject(new Error('Browser test finished'))
    pending.clear()
    ws?.close();chrome?.kill();vite?.kill();api.closeAllConnections();await new Promise(resolve=>api.close(resolve))
    if(temp){const resolved=path.resolve(temp);if(!resolved.startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(resolved).startsWith('profile-editor-check-')){console.error('Unsafe temporary cleanup path');process.exitCode=1}else{await pause(300);await fs.rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200})}}
}

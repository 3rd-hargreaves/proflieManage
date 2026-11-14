import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const phase = process.argv.includes('--phase1') ? 1 : 2
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
const initial = () => ({ profile: { id: 1, name: '검증 이름', status_message: '검증 상태', profile_image_path: null }, theme: { id: 1, main_color: '#7841ab', background_color: '#fce8ef', card_background_color: '#ffffff', typo_color: '#26232a' }, sections: [{ id: 10, sort_order: 1, title: '첫 섹션', content: '첫 내용' },{ id: 11, sort_order: 2, title: '둘째 섹션', content: '둘째 내용' }], keywords: [{ id: 30, sort_order: 1, content: '검증' }], feed: [{id:20,sort_order:1,image_path:'feed/first.png'},{id:21,sort_order:2,image_path:'feed/second.png'}] })
const snapshot = tag => ({
    profile: { id: 1, name: `${tag} 이름`, status_message: `${tag} 상태`, profile_image_path: null },
    theme: { id: 1, main_color: { snapshot: '#2468ac', stale: '#ac6824', current: '#13579b', fresh: '#97531b' }[tag], background_color: '#cdefff', card_background_color: '#fffaf0', typo_color: '#123456' },
    sections: [{ id: 11, sort_order: 1, title: `${tag} 둘째`, content: `${tag} 둘째 내용` }, { id: 10, sort_order: 2, title: `${tag} 첫째`, content: `${tag} 첫째 내용` }],
    keywords: [{ id: 32, sort_order: 1, content: `${tag}-second` }, { id: 31, sort_order: 2, content: `${tag}-first` }],
    feed: [{ id: 21, sort_order: 1, image_path: `feed/${tag}-second.png` }, { id: 20, sort_order: 2, image_path: `feed/${tag}-first.png` }],
})
let site = initial()
let mode = { userStatus: 200, userDelay: 0, tokenDelay: 0, saveDelay: 0 }
const requests = []
let nextId = 100
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=', 'base64')
const imageHash = bytes => createHash('sha256').update(bytes).digest('hex')
const api = http.createServer(async (req,res) => {
    const url = new URL(req.url, 'http://localhost')
    const chunks=[]; for await(const chunk of req)chunks.push(chunk)
    const bytes=Buffer.concat(chunks),raw=bytes.toString()
    const entry={method:req.method,path:url.pathname,body:null}; requests.push(entry)
    if(raw && !req.headers['content-type']?.includes('multipart')){try{entry.body=JSON.parse(raw)}catch{}}
    if(req.method==='POST' && url.pathname.startsWith('/storage/') && req.headers['content-type']?.includes('multipart')){
        const form=await new Response(bytes,{headers:{'Content-Type':req.headers['content-type']}}).formData()
        for(const value of form.values())if(value instanceof File)entry.upload={name:value.name,size:value.size,hash:imageHash(Buffer.from(await value.arrayBuffer()))}
    }
    res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Expose-Headers','Content-Range');res.setHeader('Access-Control-Allow-Headers','*');res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS')
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return}
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(data===undefined?undefined:JSON.stringify(data))}
    if(url.pathname==='/auth/v1/user') {const status=mode.userStatus;await pause(mode.userDelay);send(status,status===200?user:{code:status===401?'bad_jwt':'unexpected_failure',msg:'Mock verification failure'});return}
    if(url.pathname==='/auth/v1/token'){await pause(mode.tokenDelay);const status=mode.tokenStatus??200;send(status,status===200?session():{error:'invalid_grant',error_code:'invalid_credentials',msg:'Invalid login credentials'});return}
    if(url.pathname==='/auth/v1/logout'){send(204);return}
    if(url.pathname==='/rest/v1/rpc/load_site' && req.method==='POST') {
        const data=structuredClone(site),status=mode.loadStatus??200,delay=mode.loadDelay??0
        entry.snapshotName=data.profile.name
        res.once('close',()=>{if(!res.writableEnded)entry.cancelled=true})
        await pause(delay)
        if(!res.destroyed)send(status,status===200?data:{code:'unexpected_failure',message:'Mock snapshot failure'})
        return
    }
    if(url.pathname==='/rest/v1/rpc/save_site') {
        await pause(mode.saveDelay)
        if(mode.saveFailure){send(400,{code:'P0001',message:mode.saveFailure});return}
        const d=entry.body.p_data
        site={profile:{id:1,...d.profile},theme:{id:1,...d.theme},sections:d.sections.map((r,i)=>({...r,id:r.id??nextId++,sort_order:i+1})),keywords:d.keywords.map((r,i)=>({...r,id:r.id??nextId++,sort_order:i+1})),feed:d.feed.map((r,i)=>({...r,id:r.id??nextId++,sort_order:i+1}))}
        send(200,site);return
    }
    if(url.pathname.startsWith('/rest/v1/')){
        const name=url.pathname.split('/').at(-1); const data=site[name==='feed_images'?'feed':name]
        if(Array.isArray(data)){const offset=Number(url.searchParams.get('offset')||0);const limit=Number(url.searchParams.get('limit')||100);const page=data.slice(offset,offset+limit);res.setHeader('Content-Range',`${offset}-${offset+page.length-1}/${data.length}`);send(200,page)}else send(200,data);return
    }
    if(url.pathname.startsWith('/storage/v1/object/public/')){res.writeHead(200,{'Content-Type':'image/png'});res.end(image);return}
    if(url.pathname.startsWith('/storage/v1/object/')&&req.method==='POST'){send(200,{Key:url.pathname.split('/object/')[1]});return}
    if(url.pathname.startsWith('/storage/v1/object/')&&req.method==='DELETE'){const failure=mode.deleteFailure;await pause(mode.deleteDelay??0);send(failure?500:200,failure?{statusCode:'500',error:'InternalError',message:'Mock cleanup failure'}:[]);return}
    send(404,{error:'unknown mock request'})
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
    const maxImageBytes=10*1024*1024,boundaryImage=Buffer.alloc(maxImageBytes);image.copy(boundaryImage)
    const boundaryPicture=path.join(temp,'경계 이미지.png'),invalidPicture=path.join(temp,'지원하지 않는 이미지.gif')
    await fs.writeFile(boundaryPicture,boundaryImage);await fs.writeFile(invalidPicture,image)
    const apiPort=await listen(api),vitePort=await freePort(),debugPort=await freePort()
    const appUrl=`http://127.0.0.1:${vitePort}`
    const cleanupPrefix=`profileManage:cleanup:v1:${encodeURIComponent(`http://127.0.0.1:${apiPort}/site-images`)}:`
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
    const saveDisabled=()=>js('document.querySelector("button[type=submit]")?.matches(":disabled")')
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
    const reset=async(authenticated=true,feedCount=null,preserveCleanup=false)=>{mode={userStatus:200,userDelay:0,tokenDelay:0,saveDelay:0};site=initial();if(feedCount!==null)site.feed=Array.from({length:feedCount},(_,i)=>({id:2000+i,sort_order:i+1,image_path:`feed/saved-${i+1}.png`}));acceptDialog=true;await js(`try{sessionStorage.setItem('editor-test-no-session',${JSON.stringify(authenticated?'0':'1')});if(!${JSON.stringify(preserveCleanup)})for(const key of Object.keys(localStorage))if(key.startsWith(${JSON.stringify(cleanupPrefix)}))localStorage.removeItem(key)}catch{}`);await navigate('/');acceptDialog=false;await until('!!document.querySelector(".edit")','main ready');if(authenticated){await until("document.querySelector('.edit')?.getAttribute('aria-label')==='수정 화면 열기'",'verified main');await nativeClick('.edit');await until('!!document.querySelector("#profileName")','editor ready')}dialogs.length=0;requests.length=0}
    const refresh=()=>js(`void import('/src/lib/supabase.ts').then(({supabase})=>supabase.auth.refreshSession())`)
    const externalSignout=()=>js(`void import('/src/lib/supabase.ts').then(({supabase})=>supabase.auth.signOut({scope:'local'}))`)
    const save=async()=>{await js('document.querySelector("button[type=submit]").click()');await until('/저장했습니다|저장 성공/.test(document.body.innerText) && !document.querySelector("button[type=submit]").matches(":disabled")','save complete')}
    const selectFile=async(selector,files=[picture])=>{const {root}=await cdp('DOM.getDocument');const {nodeId}=await cdp('DOM.querySelector',{nodeId:root.nodeId,selector});await cdp('DOM.setFileInputFiles',{nodeId,files});await pause(100)}
    const selectVirtualFile=async(selector,file)=>{await js(`(()=>{const input=document.querySelector(${JSON.stringify(selector)}),file=${JSON.stringify(file)},transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array(file.size)],file.name,{type:file.type}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`);await pause(100)}
    const loadRequests=()=>requests.filter(r=>r.path==='/rest/v1/rpc/load_site'&&r.method==='POST')
    const directTableRequests=()=>requests.filter(r=>/^\/rest\/v1\/(profile|theme|sections|keywords|feed_images)$/.test(r.path))
    const cleanupRecords=()=>js(`Object.keys(localStorage).filter(key=>key.startsWith(${JSON.stringify(cleanupPrefix)})).map(key=>JSON.parse(localStorage.getItem(key)))`)
    await navigate('/');await reset()
    check(await hasEditor(),'검증된 관리자만 수정 화면 열기')
    check(await js(`(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return !e.defaultPrevented})()`),'변경 전에는 이탈 경고 없음')
    await set('#profileName','보존할 이름');await set('[data-section] textarea','보존할 *원문*');await selectFile('#profileFile')
    const preview=await js(`document.querySelector('img[alt="프로필 이미지 미리보기"]').src`)
    check(preview.startsWith('blob:'),'선택한 이미지가 편집 상태에 존재')
    check(await js(`(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented})()`),'미저장 내용은 beforeunload 경고 대상')
    await nativeClick('#profileName');const reloadDialogs=dialogs.length;await cdp('Page.reload');await pause(250);check(dialogs.slice(reloadDialogs).some(d=>d.type==='beforeunload') && await js(`document.querySelector('#profileName')?.value==='보존할 이름'`),'실제 새로고침 취소 시 편집 유지');
    mode.userStatus=503;await refresh();await until('document.body.innerText.includes("로그인 상태 확인 실패")','verification network failure')
    check(await hasEditor() && await saveDisabled(),'인증 통신 오류에 편집기 유지·저장 잠금')
    check(await js(`document.querySelector('#profileName').value==='보존할 이름' && document.querySelector('[data-section] textarea').value==='보존할 *원문*'`),'인증 통신 오류에 텍스트 원문 유지')
    check(await js(`document.querySelector('img[alt="프로필 이미지 미리보기"]').src===${JSON.stringify(preview)}`),'인증 통신 오류에 선택 File 유지')
    await js(`document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);await pause(100)
    check(!requests.some(r=>r.path==='/rest/v1/rpc/save_site'),'인증 미확인 상태의 강제 submit도 저장 차단')
    mode.userStatus=200;await button('다시 확인|다시 시도');await until('document.querySelector("button[type=submit]") && !document.querySelector("button[type=submit]").matches(":disabled")','auth retry')
    check(await js(`document.querySelector('#profileName').value==='보존할 이름' && document.querySelector('img[alt="프로필 이미지 미리보기"]').src===${JSON.stringify(preview)}`),'인증 재시도 성공 후 편집 내용·File 유지')
    await save();check(site.profile.name==='보존할 이름' && requests.filter(r=>r.path.startsWith('/storage/')&&r.method==='POST').length===1,'복구 후 선택 이미지와 수정 내용 저장')
    check(await js(`(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return !e.defaultPrevented})()`),'저장 성공 후 이탈 경고 해제')
    await reset();await set('#profileName','뒤로가기 보존');const historyLength=await js('history.length')
    await js('history.back()');await until('location.pathname==="/edit" && document.querySelector("#profileName")?.value==="뒤로가기 보존"','cancelled back restored')
    check(dialogs.some(d=>d.type==='confirm'),'뒤로가기 시 미저장 변경 확인')
    check(await js('history.length')===historyLength,'뒤로가기 취소 시 이력 개수 유지')
    dialogs.length=0;await js('history.back()');await until('location.pathname==="/edit"','second cancelled back');await pause(150)
    check(dialogs.length===1,'이동 취소 후 뒤로가기를 다시 시도 가능')
    acceptDialog=true;await js('history.back()');await until('location.pathname==="/" && !document.querySelector("#profileName")','confirmed back');acceptDialog=false
    check(!await hasEditor(),'이탈 승인 시 메인으로 이동')
    await reset();await set('#profileName','로그아웃 보존');await until(`!document.querySelector('main > button').matches(':disabled')`,'logout ready');await nativeClick('main > button');await pause(150)
    check(await hasEditor() && !requests.some(r=>r.path==='/auth/v1/logout'),'로그아웃 취소 시 편집·세션 유지')
    acceptDialog=true;await nativeClick('main > button');await until('location.pathname==="/" && !document.querySelector("#profileName")','confirmed logout');acceptDialog=false
    check(requests.filter(r=>r.path==='/auth/v1/logout' && r.method==='POST').length===1,'이탈 승인 후에만 로그아웃 요청')
    await reset();await set('#profileName','만료 후 보존');await selectFile('#profileFile');await externalSignout();await until('document.querySelector("button[type=submit]")?.matches(":disabled")','expired lock')
    check(await js(`document.querySelector('#profileName')?.value==='만료 후 보존' && !!document.querySelector('img[alt="프로필 이미지 미리보기"]')`),'세션 종료 후 기존 편집 내용 유지·저장 차단')
    await button('다시 로그인|로그인하기');await until('!!document.querySelector("input[type=password]")','reauth modal');await set('input[type=password]','test-only-password');await nativeClick('#loginModal button[type=submit]');await until('!document.querySelector("#loginModal") && !document.querySelector("button[type=submit]").matches(":disabled")','reauth restored')
    check(await js(`document.querySelector('#profileName').value==='만료 후 보존'`),'재로그인 후 기존 편집기와 원문 복원')
    await reset();await set('#profileName','401 보존');mode.userStatus=401;await refresh();await until(`document.querySelector('#profileName')?.value==='401 보존' && document.querySelector('button[type=submit]').matches(':disabled') && document.body.innerText.includes('다시 로그인')`,'invalid JWT preserves draft');check(!requests.some(r=>r.path==='/rest/v1/rpc/save_site'),'401 세션 만료에도 편집 유지·저장 요청 차단')
    await reset();await set('#profileName','동기 잠금');await js(`void import('/src/lib/supabase.ts').then(({supabase})=>{const {data}=supabase.auth.onAuthStateChange(event=>{if(event==='SIGNED_OUT'){document.querySelector('form')?.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));data.subscription.unsubscribe()}});return supabase.auth.signOut({scope:'local'})})`);await pause(350);check(!requests.some(r=>r.path==='/rest/v1/rpc/save_site'),'인증 종료 이벤트 직후 React 렌더 전 submit도 차단')
    await reset();mode.userDelay=1500;await refresh();await pause(200);await js(`localStorage.removeItem('sb-127-auth-token');const logoutChannel=new BroadcastChannel('sb-127-auth-token');logoutChannel.postMessage({event:'SIGNED_OUT',session:null});logoutChannel.close()`);await pause(2000)
    check(await hasEditor() && await saveDisabled(),'세션 종료 뒤 늦은 인증 응답이 저장 권한을 복원하지 않음')
    await reset(false);await navigate('/edit');await pause(700)
    check(!await hasEditor(),'새 미인증 방문자는 편집 폼에 접근 불가')

    if(phase===2){
        for(const legacyPath of ['/manage.html','/edit/']){
            await reset();await navigate(legacyPath);await until('!!document.querySelector("#profileName")','legacy editor ready');await set('#profileName','주소 보존 편집');await externalSignout();await until(`document.querySelector('button[type=submit]').matches(':disabled') && document.body.innerText.includes('다시 로그인')`,'legacy reauth lock');dialogs.length=0;await button('다시 로그인');await until('!!document.querySelector("#loginModal")','legacy reauth modal');await set('#loginModal input','test-only-password');await nativeClick('#loginModal button[type=submit]');await until(`!document.querySelector('#loginModal') && !document.querySelector('button[type=submit]').matches(':disabled')`,'legacy reauth success');check(await js(`location.pathname===${JSON.stringify(legacyPath)} && document.querySelector('#profileName').value==='주소 보존 편집'`),`${legacyPath} 재로그인 후 주소·편집 유지`);check(dialogs.length===0,`${legacyPath} 재로그인이 이탈 확인을 만들지 않음`)
        }
        await reset(false);await nativeClick('.edit');await until('!!document.querySelector("#loginModal")','login modal')
        await set('input[type=password]','cancelled-password');await key('Escape');await until('!document.querySelector("#loginModal")','login closed');await nativeClick('.edit');await until('!!document.querySelector("#loginModal")','login reopened')
        check(await js('document.querySelector("input[type=password]").value===""'),'로그인 취소·재열기 시 비밀번호 초기화')
        mode.tokenStatus=400;await set('input[type=password]','bad-test-password');await nativeClick('#loginModal button[type=submit]');await until(`document.querySelector('#loginModal [role=alert]')?.textContent.includes('비밀번호')`,'login error');check(await js(`!document.querySelector('#loginModal button[type=submit]').matches(':disabled')`),'로그인 실패 후 재시도 가능');await key('Escape');await nativeClick('.edit');await until('!!document.querySelector("#loginModal")','reopen after failure');check(await js(`document.querySelector('#loginModal input').value==='' && !document.querySelector('#loginModal [role=alert]')`),'실패 후 닫기·재열기 시 비밀번호와 오류 초기화');mode.tokenStatus=200;const tokensBefore=requests.filter(r=>r.path==='/auth/v1/token' && r.method==='POST').length;mode.tokenDelay=1000;await set('input[type=password]','test-only-password');await nativeClick('#loginModal button[type=submit]');await js(`document.querySelector('#loginModal form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);await key('Escape');await js(`document.querySelector('#loginModal').click()`)
        check(await js('!!document.querySelector("#loginModal")'),'로그인 요청 중 Escape·배경 닫힘 차단')
        await until('!!document.querySelector("#profileName")','login success');mode.tokenDelay=0
        check(requests.filter(r=>r.path==='/auth/v1/token' && r.method==='POST').length===tokensBefore+1,'로그인 중 중복 submit도 요청 한 번으로 정상 이동')
        const sectionSelector='[data-section] .dragHandle',feedSelector='#feedItems .feedDragHandle'
        await nativeClick(sectionSelector);await pause(150);check(!await saveDisabled() && await js(`!document.querySelector('.sortableDragging') && [...document.querySelectorAll('#feedItems .feedDragHandle')].every(b=>!b.matches(':disabled'))`),'6px 미만 클릭 종료 시 드래그 잠금 해제')
        await focus(sectionSelector);await key('Space',' ')
        check(await js(`document.querySelector('button[type=submit]').matches(':disabled') && [...document.querySelectorAll('#feedItems .feedDragHandle')].every(b=>b.matches(':disabled'))`),'섹션 정렬 중 피드 시작·저장 차단')
        await nativeClick(feedSelector);check(await saveDisabled(),'다른 목록 클릭으로 현재 드래그 잠금이 해제되지 않음')
        await key('Escape');await until('!document.querySelector("button[type=submit]").matches(":disabled")','drag cancel unlocked')
        check(await js(`![...document.querySelectorAll('.dragHandle')].some(b=>b.matches(':disabled'))`),'취소 후 두 목록의 드래그 다시 활성화')
        await focus(feedSelector);await key('Space',' ')
        check(await js(`[...document.querySelectorAll('[data-section] .dragHandle')].every(b=>b.matches(':disabled'))`),'피드 정렬 중 섹션 시작 차단')
        await key('ArrowDown');await key('Space',' ');await pause(250)
        await save();const payload=requests.filter(r=>r.path==='/rest/v1/rpc/save_site').at(-1).body
        check(payload.p_data.feed[0].id===21 && payload.p_data.feed[1].id===20,'잠금 적용 후 기존 ID 순서 저장 유지')
        await reset();await set('#profileName','충돌 후 재시도');await selectFile('#profileFile')
        const conflictPreview=await js(`document.querySelector('img[alt="프로필 이미지 미리보기"]').src`)
        mode.saveFailure='site_conflict';await js(`document.querySelector('button[type=submit]').click()`)
        await until(`document.body.innerText.includes('다른 창에서') && !document.querySelector('button[type=submit]').matches(':disabled')`,'save conflict')
        check(await js(`document.querySelector('#profileName').value==='충돌 후 재시도' && document.querySelector('img[alt="프로필 이미지 미리보기"]').src===${JSON.stringify(conflictPreview)}`),'저장 충돌 응답에 원문·선택 File 유지')
        check(site.profile.name==='검증 이름' && !requests.some(r=>r.path.startsWith('/storage/')&&r.method==='DELETE'),'저장 실패 시 기존 DB·파일 삭제 없음')
        const uploadCount=requests.filter(r=>r.path.startsWith('/storage/')&&r.method==='POST').length
        mode.saveFailure=null;await save()
        check(site.profile.name==='충돌 후 재시도' && uploadCount===1 && requests.filter(r=>r.path.startsWith('/storage/')&&r.method==='POST').length===1,'저장 재시도는 업로드 경로를 재사용')
        await reset();await nativeClick('#feedItems .picEditItem .btn');mode.deleteFailure=true;await save()
        check(site.feed.length===1 && await js(`document.body.innerText.includes('내용은 저장됐지만')`),'파일 정리 실패를 DB 저장 성공과 구별')
        const savedRequests=requests.filter(r=>r.path==='/rest/v1/rpc/save_site'&&r.method==='POST').length
        mode.deleteFailure=false;await button('이미지 정리 다시 시도');await until(`!document.body.innerText.includes('내용은 저장됐지만')`,'cleanup retry')
        check(requests.filter(r=>r.path==='/rest/v1/rpc/save_site'&&r.method==='POST').length===savedRequests,'파일 정리 재시도는 DB를 다시 저장하지 않음')
        await focus(sectionSelector);await key('Space',' ');await externalSignout();await until(`![...document.querySelectorAll('.dragHandle')].some(b=>!b.matches(':disabled')) && !document.querySelector('.sortableDragging')`,'auth locks drag')
        check(await js(`[...document.querySelectorAll('.dragHandle')].every(b=>b.matches(':disabled'))`),'인증 잠금 중 활성 드래그 종료·다른 목록 시작 차단')

        await reset();await set('#profileName','업로드 검증 초안');await selectFile('#profileFile',[boundaryPicture])
        const boundaryPreview=await js(`document.querySelector('img[alt="프로필 이미지 미리보기"]').src`)
        check(boundaryPreview.startsWith('blob:') && await js(`document.querySelector('#profileFile').value==='' && document.querySelector('#profileFile').files.length===0 && document.querySelector('#profileFile').closest('.card').querySelector('.picTitle').textContent==='경계 이미지.png'`),'정확히 10MiB인 프로필 이미지 허용·파일 입력 초기화')
        await selectVirtualFile('#profileFile',{name:'크기 초과.png',type:'image/png',size:maxImageBytes+1})
        check(await js(`document.querySelector('#profileFile').closest('.card').querySelector('[role=alert]')?.textContent.includes('용량 제한 초과') && document.querySelector('img[alt="프로필 이미지 미리보기"]').src===${JSON.stringify(boundaryPreview)} && document.querySelector('#profileFile').value==='' && document.querySelector('#profileFile').files.length===0`),'10MiB 초과 프로필 즉시 거절·기존 선택 유지·입력 초기화')
        await selectVirtualFile('#profileFile',{name:'빈 이미지.png',type:'image/png',size:0})
        check(await js(`document.querySelector('#profileFile').closest('.card').querySelector('[role=alert]')?.textContent.includes('비어 있는 파일') && document.querySelector('img[alt="프로필 이미지 미리보기"]').src===${JSON.stringify(boundaryPreview)}`),'빈 프로필 이미지 거절 후 기존 미리보기 유지')
        await selectVirtualFile('#profileFile',{name:'유형 오류.png',type:'text/html',size:image.length})
        check(await js(`document.querySelector('#profileFile').closest('.card').querySelector('[role=alert]')?.textContent.includes('지원하지 않는 형식') && document.querySelector('img[alt="프로필 이미지 미리보기"]').src===${JSON.stringify(boundaryPreview)} && document.querySelector('#profileName').value==='업로드 검증 초안' && document.querySelector('#profileFile').closest('.card').querySelector('.picTitle').textContent==='경계 이미지.png' && document.querySelector('#profileFile').files.length===0`) && !requests.some(r=>(r.path.startsWith('/storage/')&&r.method==='POST')||r.path==='/rest/v1/rpc/save_site'),'MIME 오류 프로필 거절 후 초안·파일 제목 유지 및 저장 요청 없음')
        await save();const boundaryUpload=requests.find(r=>r.path.startsWith('/storage/')&&r.method==='POST')?.upload
        check(boundaryUpload?.name==='경계 이미지.png' && boundaryUpload.size===maxImageBytes && boundaryUpload.hash===imageHash(boundaryImage) && site.profile.name==='업로드 검증 초안','검증 오류 뒤 저장은 기존 선택 이미지 원본 바이트 유지')

        await reset();await selectFile('#feedFiles')
        const selectedFeed=await js(`document.querySelector('#feedItems').textContent`)
        await selectFile('#feedFiles',[picture,invalidPicture])
        check(await js(`document.querySelector('#feedFiles').closest('.card').querySelector('[role=alert]')?.textContent.includes('지원하지 않는 형식') && document.querySelector('#feedItems').textContent===${JSON.stringify(selectedFeed)} && document.querySelector('#feedFiles').closest('.card').querySelector('.picTitle').textContent==='선택 이미지.png' && document.querySelector('#feedFiles').value==='' && document.querySelector('#feedFiles').files.length===0`),'피드 혼합 배치 전체 거절·기존 선택과 제목 유지·입력 초기화')
        check(!requests.some(r=>(r.path.startsWith('/storage/')&&r.method==='POST')||r.path==='/rest/v1/rpc/save_site'),'피드 파일 선택 검증 실패는 업로드·DB 요청 없음')
        await save();const feedUploads=requests.filter(r=>r.path.startsWith('/storage/')&&r.method==='POST')
        check(site.feed.length===3 && feedUploads.length===1 && feedUploads[0].upload?.name==='선택 이미지.png' && feedUploads[0].upload?.hash===imageHash(image),'거절한 배치를 제외하고 기존 선택 피드 원본만 저장')

        await reset(true,49);await selectFile('#feedFiles')
        check(await js(`document.querySelectorAll('#feedItems .picEditItem').length===50 && !document.querySelector('#feedFiles').closest('.card').querySelector('[role=alert]')`),'저장된 49장에 한 장을 추가해 피드 이미지 수량 제한(50) 허용')
        await selectFile('#feedFiles')
        check(await js(`document.querySelectorAll('#feedItems .picEditItem').length===50 && document.querySelector('#feedFiles').closest('.card').querySelector('[role=alert]')?.textContent.includes('피드 이미지 수량 제한(50)') && document.querySelector('#feedFiles').files.length===0`) && !requests.some(r=>(r.path.startsWith('/storage/')&&r.method==='POST')||r.path==='/rest/v1/rpc/save_site'),'51번째 피드 즉시 거절·기존 50장과 입력 초기화 유지')
        await save();check(site.feed.length===50 && requests.filter(r=>r.path.startsWith('/storage/')&&r.method==='POST').length===1,'허용된 50장 피드 순서·내용 저장')

        await reset(true,51);await set('#profileName','기존 51장 보존');await selectFile('#feedFiles')
        check(await js(`document.querySelectorAll('#feedItems .picEditItem').length===51 && document.querySelector('#feedFiles').closest('.card').querySelector('[role=alert]')?.textContent.includes('피드 이미지 수량 제한(51)') && document.querySelector('#feedFiles').files.length===0`),'기존 51장 피드는 보존하고 추가 증가는 거절')
        await save();check(site.profile.name==='기존 51장 보존' && site.feed.length===51 && !requests.some(r=>r.path.startsWith('/storage/')&&r.method==='POST'),'기존 51장 피드가 있어도 다른 내용 수정 저장 가능')
        await nativeClick('#feedItems .picEditItem .btn');await selectFile('#feedFiles')
        check(await js(`document.querySelectorAll('#feedItems .picEditItem').length===51 && !document.querySelector('#feedFiles').closest('.card').querySelector('[role=alert]')`),'기존 제한 초과 피드는 삭제한 한 장의 교체 허용')
        await save();check(site.feed.length===51 && requests.filter(r=>r.path.startsWith('/storage/')&&r.method==='POST').length===1,'기존 제한 초과 피드 교체도 원래 개수로 저장')

        site=snapshot('snapshot');requests.length=0;await navigate('/')
        await until(`document.querySelector('.profileName')?.textContent==='snapshot 이름'`,'single snapshot main')
        check(loadRequests().length===1 && loadRequests().every(r=>Object.keys(r.body??{}).length===0) && directTableRequests().length===0,'메인 조회는 인자 없는 load_site RPC 한 번만 사용')
        check(await js(`document.title==='snapshot 이름' && document.querySelector('.profileMessage span').textContent==='snapshot 상태' && [...document.querySelectorAll('.sectionText')].map(e=>e.textContent).join('|')==='snapshot 둘째|snapshot 첫째' && [...document.querySelectorAll('.sectionContent')].map(e=>e.textContent).join('|')==='snapshot 둘째 내용|snapshot 첫째 내용' && [...document.querySelectorAll('.keywordList .keyword')].map(e=>e.textContent).join('|')==='#snapshot-second|#snapshot-first' && [...document.querySelectorAll('.picList img')].map(e=>new URL(e.src).pathname.split('/').at(-1)).join('|')==='snapshot-second.png|snapshot-first.png' && getComputedStyle(document.documentElement).getPropertyValue('--main-color').trim()==='#2468ac'`),'메인 프로필·테마·섹션·키워드·피드가 같은 스냅샷 순서로 표시')
        requests.length=0;await nativeClick('.edit');await until(`document.querySelector('#profileName')?.value==='snapshot 이름'`,'single snapshot editor')
        check(loadRequests().length===1 && directTableRequests().length===0,'수정 화면 진입도 load_site RPC 한 번만 사용')
        check(await js(`document.querySelector('#profileMessage').value==='snapshot 상태' && [...document.querySelectorAll('[data-section] input')].map(e=>e.value).join('|')==='snapshot 둘째|snapshot 첫째' && [...document.querySelectorAll('[data-section] textarea')].map(e=>e.value).join('|')==='snapshot 둘째 내용|snapshot 첫째 내용' && document.querySelector('#keywords').value==='snapshot-second, snapshot-first' && [...document.querySelectorAll('#feedItems .dragLabel')].map(e=>e.textContent).join('|')==='snapshot-second.png|snapshot-first.png' && getComputedStyle(document.documentElement).getPropertyValue('--main-color').trim()==='#2468ac'`),'수정 원문·키워드·피드 순서도 단일 스냅샷과 일치')

        mode.loadStatus=503;requests.length=0;await navigate('/')
        await until(`document.querySelector('main [role=alert]')?.textContent.includes('불러오지 못')`,'main snapshot error')
        check(loadRequests().length===1 && directTableRequests().length===0 && !await hasEditor(),'메인 스냅샷 조회 실패 시 오류 표시·직접 테이블 재조회 없음')
        mode.loadStatus=200;await button('^다시 시도$');await until(`document.querySelector('.profileName')?.textContent==='snapshot 이름'`,'main snapshot retry')
        check(loadRequests().length===2 && directTableRequests().length===0,'메인 다시 시도는 RPC 한 번 추가 후 정상 복구')
        mode.loadStatus=503;requests.length=0;await nativeClick('.edit')
        await until(`document.querySelector('main [role=alert]')?.textContent.includes('불러오지 못')`,'editor snapshot error')
        check(loadRequests().length===1 && !await hasEditor() && directTableRequests().length===0,'수정 스냅샷 조회 실패 시 빈 편집 폼 대신 오류 표시')
        mode.loadStatus=200;await button('^다시 시도$');await until(`document.querySelector('#profileName')?.value==='snapshot 이름'`,'editor snapshot retry')
        check(loadRequests().length===2 && directTableRequests().length===0,'수정 화면 다시 시도도 RPC 한 번 추가 후 정상 복구')

        site=snapshot('stale');mode.loadDelay=1600;requests.length=0;await navigate('/')
        await until(`document.querySelector('.edit')?.getAttribute('aria-label')==='수정 화면 열기'`,'delayed main verified')
        const delayedMain=loadRequests()[0]
        site=snapshot('current');mode.loadDelay=0;await nativeClick('.edit');await until(`document.querySelector('#profileName')?.value==='current 이름'`,'new editor snapshot')
        await pause(1800)
        check(delayedMain?.snapshotName==='stale 이름' && delayedMain.cancelled && loadRequests().length===2 && directTableRequests().length===0 && await js(`document.querySelector('#profileName')?.value==='current 이름' && document.querySelector('[data-section] textarea').value==='current 둘째 내용' && document.title==='관리자' && getComputedStyle(document.documentElement).getPropertyValue('--main-color').trim()==='#13579b'`),'이탈한 메인의 지연 스냅샷 취소·최신 수정 화면 오염 방지')
        await js('history.back()');await until(`document.querySelector('.profileName')?.textContent==='current 이름'`,'return to current main')
        site=snapshot('stale');mode.loadDelay=1600;requests.length=0;await nativeClick('.edit')
        await until(`document.querySelector('main [role=status]')?.textContent.includes('수정할 정보를 불러오는 중')`,'delayed editor loading');await pause(100)
        const delayedEditor=loadRequests()[0]
        site=snapshot('fresh');mode.loadDelay=0;await js('history.back()');await until(`document.querySelector('.profileName')?.textContent==='fresh 이름'`,'fresh main snapshot')
        await pause(1800)
        check(delayedEditor?.snapshotName==='stale 이름' && delayedEditor.cancelled && loadRequests().length===2 && directTableRequests().length===0 && await js(`!document.querySelector('#profileName') && document.title==='fresh 이름' && document.querySelector('.sectionText').textContent==='fresh 둘째' && getComputedStyle(document.documentElement).getPropertyValue('--main-color').trim()==='#97531b'`),'이탈한 수정 화면의 지연 스냅샷 취소·최신 메인 화면 오염 방지')

        await reset();await selectFile('#profileFile')
        const invalidFields=[
            {selector:'#profileName',value:' \t ',message:'이름 항목 입력 바람',label:'이름 공란'},
            {selector:'#profileMessage',value:' \t ',message:'상태 메시지 항목 입력 바람',label:'상태 메시지 공란'},
            {selector:'[data-section] input',index:1,value:'  ',message:'섹션 제목 항목 입력 바람',label:'둘째 섹션 제목 공란'},
            {selector:'[data-section] textarea',index:1,value:'\n \t ',message:'섹션 내용 항목 입력 바람',label:'둘째 섹션 내용 공란'},
            {selector:'[data-theme="--main-color"]',value:' \t ',message:'헥스코드 항목 입력 바람',label:'테마 색상 공란'},
            {selector:'[data-theme="--sub-color"]',value:'#12',message:'색상코드 형식 불일치',label:'잘못된 테마 색상'},
            {selector:'#keywords',value:', ,',message:'키워드 한 개 이상 입력 필수',label:'쉼표만 있는 키워드'},
            {selector:'#keywords',value:' \t ',message:'키워드 한 개 이상 입력 필수',label:'공백만 있는 키워드'},
        ]
        for(const invalid of invalidFields){
            const index=invalid.index??0,field=`document.querySelectorAll(${JSON.stringify(invalid.selector)})[${index}]`
            const original=await js(`${field}.value`)
            await set(invalid.selector,invalid.value,index);await js(`document.querySelector('button[type=submit]').click()`);await pause(70)
            const rejected=await js(`document.activeElement===${field} && ${field}.validationMessage===${JSON.stringify(invalid.message)} && ${field}.validity.customError`)
                && !requests.some(r=>(r.path.startsWith('/storage/')&&r.method==='POST')||r.path==='/rest/v1/rpc/save_site')
            await set(invalid.selector,original,index)
            check(rejected && await js(`${field}.validationMessage==='' && !${field}.validity.customError`),`${invalid.label}: 대상 포커스·메시지·저장 차단과 수정 후 오류 해제`)
        }
        await save()
        check(requests.filter(r=>r.path==='/rest/v1/rpc/save_site'&&r.method==='POST').length===1 && requests.filter(r=>r.path.startsWith('/storage/')&&r.method==='POST').length===1 && await js(`[...document.querySelectorAll('form input:not([type=file]), form textarea')].every(field=>!field.validity.customError)`),'공통 검증 오류를 수정하면 선택 이미지와 내용을 한 번 저장')

        const sectionSource='\r\n  *원문* _밑줄_ /기울임/ -가로줄-\r\n| 제목 | 값 |\r\n| 자료 | 보존 |\r\n  '
        const secondSource=' \r\n둘째 /원문/\r\n '
        site=initial();site.sections[0].content=sectionSource;site.sections[1].content=secondSource
        site.keywords=[{id:30,sort_order:1,content:'기존 첫째'},{id:31,sort_order:2,content:'기존 둘째'}]
        await navigate('/edit');await until(`document.querySelector('[data-section] textarea')?.value===${JSON.stringify(sectionSource.replace(/\r\n/g,'\n'))}`,'source editor loaded')
        check(await js(`document.querySelector('[data-section] textarea').value.includes('*원문* _밑줄_ /기울임/ -가로줄-') && !document.querySelector('[data-section] textarea strong')`),'CRLF 저장 원문은 편집 화면에서 브라우저 기본 LF 원문으로 표시')
        await set('#profileName','  공통 이름  ');await set('#profileMessage','  공통 상태  ');await set('[data-section] input','  공통 제목  ');await set('#keywords','  둘째 , , 첫째  , 둘째  ')
        const sharedColors=[
            {variable:'--main-color',column:'main_color',value:'#AbC'},
            {variable:'--sub-color',column:'background_color',value:'#1234'},
            {variable:'--background-color',column:'card_background_color',value:'#A1b2C3'},
            {variable:'--typo-color',column:'typo_color',value:'#11223344'},
        ]
        for(const color of sharedColors)await set(`[data-theme="${color.variable}"]`,` ${color.value} `)
        await focus('[data-section] .dragHandle');await key('Space',' ');await key('ArrowDown');await key('Space',' ');await pause(250)
        await focus('#feedItems .feedDragHandle');await key('Space',' ');await key('ArrowDown');await key('Space',' ');await pause(250)
        requests.length=0;await save()
        const sharedPayload=requests.filter(r=>r.path==='/rest/v1/rpc/save_site'&&r.method==='POST').at(-1).body.p_data
        check(sharedPayload.sections.map(row=>row.id).join(',')==='11,10' && sharedPayload.feed.map(row=>row.id).join(',')==='21,20' && sharedPayload.sections[0].content===secondSource && sharedPayload.sections[1].content===sectionSource && site.sections[1].content===sectionSource,'공통 변환 저장은 섹션·피드 순서와 ID·CRLF 원문을 보존')
        check(sharedPayload.profile.name==='공통 이름' && sharedPayload.profile.status_message==='공통 상태' && sharedPayload.sections[1].title==='공통 제목' && sharedPayload.keywords.map(row=>row.content).join('|')==='둘째|첫째|둘째' && sharedPayload.keywords[0].id===30 && sharedPayload.keywords[1].id===31 && sharedPayload.keywords[2].id===null,'이름·상태·제목·키워드 공백 정리와 중복·순서·기존 ID 규칙 유지')
        check(Object.keys(sharedPayload.theme).length===4 && sharedColors.every(({column,value})=>sharedPayload.theme[column]===value),'테마 4색의 CSS 변수·DB 컬럼 대응과 공백 정리 유지')
        const savedKeywordIds=site.keywords.map(row=>row.id)
        requests.length=0;await navigate('/edit');await until(`document.querySelector('#profileName')?.value==='공통 이름'`,'shared values reload')
        check(loadRequests().length===1 && await js(`document.querySelector('#profileMessage').value==='공통 상태' && document.querySelector('#keywords').value==='둘째, 첫째, 둘째' && [...document.querySelectorAll('[data-section] input')].map(field=>field.value).join('|')==='둘째 섹션|공통 제목' && [...document.querySelectorAll('[data-section] textarea')].map(field=>field.value).join('|')===${JSON.stringify([secondSource,sectionSource].map(source=>source.replace(/\r\n/g,'\n')).join('|'))} && [...document.querySelectorAll('#feedItems .dragLabel')].map(field=>field.textContent).join('|')==='second.png|first.png' && ${JSON.stringify(sharedColors)}.every(({variable,value})=>document.querySelector('[data-theme="'+variable+'"]').value===value && getComputedStyle(document.documentElement).getPropertyValue(variable).trim()===value)`),'저장 후 재조회에서도 원문·목록 순서·정리된 키워드·4색 입력과 미리보기 유지')
        await set('#profileMessage','재조회 상태');await save()
        const reloadedPayload=requests.filter(r=>r.path==='/rest/v1/rpc/save_site'&&r.method==='POST').at(-1).body.p_data
        check(reloadedPayload.sections.map(row=>row.id).join(',')==='11,10' && reloadedPayload.feed.map(row=>row.id).join(',')==='21,20' && reloadedPayload.keywords.map(row=>row.id).join(',')===savedKeywordIds.join(',') && reloadedPayload.sections[0].content===secondSource && reloadedPayload.sections[1].content===sectionSource,'재조회 후 다시 저장해도 기존 ID와 CRLF 원문 유지')
        await navigate('/');await until(`document.querySelector('.profileName')?.textContent==='공통 이름'`,'shared values public reload')
        check(await js(`document.title==='공통 이름' && document.querySelector('.profileMessage span').textContent==='재조회 상태' && [...document.querySelectorAll('.sectionText')].map(field=>field.textContent).join('|')==='둘째 섹션|공통 제목' && document.querySelector('.sectionContent strong')?.textContent==='원문' && document.querySelector('.sectionContent u')?.textContent==='밑줄' && [...document.querySelectorAll('.keywordList .keyword')].map(field=>field.textContent).join('|')==='#둘째|#첫째|#둘째' && ${JSON.stringify(sharedColors)}.every(({variable,value})=>getComputedStyle(document.documentElement).getPropertyValue(variable).trim()===value)`),'공통 변환으로 저장한 내용은 메인 재조회에서도 서식·키워드·테마로 표시')

        await reset();await set('#profileName','동시 저장 보호');await selectFile('#profileFile');mode.saveDelay=900
        await js(`(()=>{const form=document.querySelector('form');for(let i=0;i<2;i++)form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))})()`)
        await untilRequests(()=>requests.some(r=>r.path==='/rest/v1/rpc/save_site'),'duplicate submit save started')
        await until(`document.body.innerText.includes('저장 성공') && !document.querySelector('button[type=submit]').matches(':disabled')`,'duplicate submit saved')
        check(site.profile.name==='동시 저장 보호' && requests.filter(r=>r.path==='/rest/v1/rpc/save_site'&&r.method==='POST').length===1 && requests.filter(r=>r.path.startsWith('/storage/')&&r.method==='POST').length===1,'같은 틱의 중복 submit은 이미지 업로드·DB 저장 각각 한 번')

        await reset();mode.saveDelay=900;await js(`document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`)
        await untilRequests(()=>requests.some(r=>r.path==='/rest/v1/rpc/save_site'),'unchanged save started')
        dialogs.length=0;await js('history.back()');await pause(150)
        check(dialogs.some(dialog=>dialog.type==='confirm') && await hasEditor(),'수정 내용이 없는 저장 중에도 뒤로가기 취소로 편집 화면 유지')
        await until(`document.body.innerText.includes('저장 성공') && !document.querySelector('button[type=submit]').matches(':disabled')`,'unchanged save completed')
        check(await js(`(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return !event.defaultPrevented})()`),'변경 없는 저장 완료 후에도 이탈 잠금 정상 해제')

        await reset();await nativeClick('#feedItems .picEditItem .btn');mode.deleteFailure=true;await save()
        requests.length=0;await focus('[data-section] .dragHandle');await key('Space',' ')
        await js(`document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);await pause(100)
        check(await saveDisabled() && !requests.some(r=>r.path==='/rest/v1/rpc/save_site'||(r.path.startsWith('/storage/')&&r.method==='DELETE')),'정리 경고가 남은 정렬 중 강제 submit도 저장·정리 요청 차단')
        await key('Escape');mode.deleteFailure=false;mode.deleteDelay=900
        await js(`(()=>{const retry=[...document.querySelectorAll('button')].find(button=>button.textContent.includes('이미지 정리 다시 시도'));retry.click();retry.click();document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))})()`)
        await untilRequests(()=>requests.some(r=>r.path.startsWith('/storage/')&&r.method==='DELETE'),'cleanup retry started');await pause(100)
        check(await saveDisabled() && requests.filter(r=>r.path.startsWith('/storage/')&&r.method==='DELETE').length===1 && !requests.some(r=>r.path==='/rest/v1/rpc/save_site'),'같은 틱의 정리 재시도 2회와 submit은 정리 1회·DB 저장 0회')
        await until(`!document.body.innerText.includes('내용은 저장됐지만') && !document.querySelector('button[type=submit]').matches(':disabled')`,'duplicate cleanup completed')
        check(requests.filter(r=>r.path.startsWith('/storage/')&&r.method==='DELETE').length===1 && !requests.some(r=>r.path==='/rest/v1/rpc/save_site'),'정리 완료 후에도 중복 요청과 지연된 DB 저장 없음')
        await set('#profileName','정리 후 저장');await save()
        check(site.profile.name==='정리 후 저장' && requests.filter(r=>r.path==='/rest/v1/rpc/save_site'&&r.method==='POST').length===1,'정리 잠금 해제 후 새 편집 내용은 정상 저장')

        await reset()
        const sameTickChange=await js(`(()=>{const field=document.querySelector('#profileName');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'같은 틱 변경');field.dispatchEvent(new Event('input',{bubbles:true}));const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented})()`)
        check(sameTickChange,'React 재렌더 전 입력 직후에도 최신 초안으로 미저장 이탈 차단')
        const sameTickRevert=await js(`(()=>{const field=document.querySelector('#profileName');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'검증 이름');field.dispatchEvent(new Event('input',{bubbles:true}));const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return !event.defaultPrevented})()`)
        check(sameTickRevert,'React 재렌더 전 원상복구 직후에도 미저장 이탈 잠금 해제')

        mode.loadStatus=503;requests.length=0;await navigate('/')
        await until(`document.querySelector('main [role=alert]')?.textContent.includes('불러오지 못')`,'consecutive query first failure')
        mode.loadDelay=250
        await js(`(()=>{const retry=[...document.querySelectorAll('button')].find(button=>button.textContent==='다시 시도');retry.click();retry.click()})()`)
        await untilRequests(()=>loadRequests().length===2,'consecutive query retry started')
        await until(`document.querySelector('main [role=alert]')?.textContent.includes('불러오지 못') && document.querySelector('main').getAttribute('aria-busy')==='false'`,'consecutive query second failure')
        check(loadRequests().length===2 && directTableRequests().length===0,'조회 오류 후 같은 틱의 중복 재시도도 새 RPC 한 번으로 오류 상태 복귀')
        site=snapshot('stale');mode.loadStatus=200;mode.loadDelay=1600
        await js(`(()=>{const retry=[...document.querySelectorAll('button')].find(button=>button.textContent==='다시 시도');retry.click();retry.click()})()`)
        await untilRequests(()=>loadRequests().length===3,'consecutive query delayed retry started')
        const cancelledRetry=loadRequests()[2]
        site=snapshot('current');mode.loadDelay=0;await nativeClick('.edit');await until(`document.querySelector('#profileName')?.value==='current 이름'`,'editor after repeated query failure')
        await pause(1800)
        check(cancelledRetry.cancelled && loadRequests().length===4 && await js(`document.querySelector('#profileName').value==='current 이름' && document.querySelector('[data-section] textarea').value==='current 둘째 내용' && !document.querySelector('main [role=alert]')`),'연속 조회 실패 뒤 재시도도 이탈 시 취소되어 최신 편집 내용을 보존')
        await js('history.back()');await until(`document.querySelector('.profileName')?.textContent==='current 이름'`,'query after repeated errors and cancellation')
        check(loadRequests().length===5 && directTableRequests().length===0 && await js(`document.title==='current 이름' && document.querySelector('main').getAttribute('aria-busy')==='false'`),'조회 실패·재시도·취소를 반복한 뒤에도 다음 메인 조회 정상 복구')

        await cdp('Emulation.setDeviceMetricsOverride',{width:1280,height:600,deviceScaleFactor:1,mobile:false})
        await reset(false);await until(`document.querySelector('.profileName')?.textContent==='검증 이름'`,'modal main ready')
        await js(`(()=>{const style=document.body.style;style.setProperty('overflow-y','auto','important');style.setProperty('padding-right','7px');window.scrollTo({top:250,behavior:'instant'});document.querySelector('.edit').focus({preventScroll:true});window.__modalScroll={x:scrollX,y:scrollY};window.__modalStyles=['position','top','left','width','overflow-x','overflow-y','padding-right'].map(property=>({property,value:style.getPropertyValue(property),priority:style.getPropertyPriority(property)}));window.__backgroundClicks=0;document.querySelector('.edit').addEventListener('click',()=>window.__backgroundClicks++)})()`)
        await clickWithoutScroll('.edit');await until(`document.querySelector('#loginModal')?.matches(':modal')`,'native login dialog')
        check(await js(`document.querySelector('#loginModal').tagName==='DIALOG' && document.activeElement===document.querySelector('#loginModal input[type=password]') && !document.querySelector('#loginModal button[type=submit]').matches(':disabled')`),'로그인 native dialog의 최초 포커스와 닫기 버튼 없이 로그인 제공')
        await focus('#loginModal button[type=submit]');await key('Tab')
        const tabWrapped=await js(`document.activeElement===document.querySelector('#loginModal input[type=password]')`)
        await key('Tab','Tab',8)
        check(tabWrapped && await js(`document.activeElement===document.querySelector('#loginModal button[type=submit]')`),'로그인 Tab·Shift+Tab이 모달 안에서 양방향 순환')
        await js(`document.querySelector('.edit').focus()`)
        const lockedScroll=await js('scrollY')
        await cdp('Input.dispatchMouseEvent',{type:'mouseWheel',x:5,y:5,deltaX:0,deltaY:250});await pause(100)
        check(await js(`document.querySelector('#loginModal').contains(document.activeElement) && document.activeElement!==document.querySelector('.edit') && document.body.style.position==='fixed' && scrollY===${JSON.stringify(lockedScroll)} && window.__modalScroll.y>0`),'로그인 중 실제 배경 포커스 이동과 휠 스크롤 차단')
        await clickWithoutScroll('.edit');await until(`!document.querySelector('#loginModal')`,'login explicit close')
        check(await js(`document.activeElement===document.querySelector('.edit') && Math.abs(scrollY-window.__modalScroll.y)<=1 && window.__modalStyles.every(({property,value,priority})=>document.body.style.getPropertyValue(property)===value && document.body.style.getPropertyPriority(property)===priority)`),'로그인 닫기 후 호출 버튼 포커스·스크롤 좌표·인라인 스타일 복원')
        await clickWithoutScroll('.edit');await until(`document.querySelector('#loginModal')?.matches(':modal')`,'login backdrop ready');await js('window.__backgroundClicks=0')
        await clickWithoutScroll('.edit');await until(`!document.querySelector('#loginModal')`,'native login backdrop close')
        check(await js(`window.__backgroundClicks===0 && document.activeElement===document.querySelector('.edit') && Math.abs(scrollY-window.__modalScroll.y)<=1`),'로그인 바깥 실제 클릭은 모달만 닫고 배경 버튼 실행 차단')

        await reset(false);await nativeClick('.edit');await until(`document.querySelector('#loginModal')?.matches(':modal')`,'pending modal ready')
        mode.tokenStatus=400;mode.tokenDelay=1600;await set('#loginModal input','test-only-password');await nativeClick('#loginModal button[type=submit]')
        await until(`document.querySelector('#loginModal form')?.getAttribute('aria-busy')==='true'`,'pending login dialog')
        await nativeClick('#loginModal button[type=submit]');await key('Escape');await clickWithoutScroll('.edit');await key('Tab')
        await js(`document.querySelector('.edit').focus()`)
        check(await js(`document.querySelector('#loginModal')?.matches(':modal') && [...document.querySelectorAll('#loginModal input, #loginModal button')].every(field=>field.matches(':disabled')) && document.querySelector('#loginModal').contains(document.activeElement) && document.body.style.position==='fixed'`) && requests.filter(r=>r.path==='/auth/v1/token'&&r.method==='POST').length===1,'로그인 pending은 닫기·Escape·배경 클릭·포커스 이탈을 차단')
        await until(`document.querySelector('#loginModal [role=alert]')?.textContent.includes('비밀번호') && !document.querySelector('#loginModal button[type=submit]').matches(':disabled')`,'pending login failed')
        await clickWithoutScroll('.edit');await until(`!document.querySelector('#loginModal')`,'pending login close after failure')
        check(await js(`document.activeElement===document.querySelector('.edit') && document.body.style.position===''`),'로그인 실패 후 닫기 재활성화와 포커스·스크롤 잠금 복구')

        await reset(false);await until(`!!document.querySelector('#feedOpenBtn')`,'gallery main ready');await nativeClick('#feedOpenBtn')
        await js(`(()=>{const image=document.querySelector('.picList img');image.scrollIntoView({block:'center'});image.focus({preventScroll:true});window.__imageOpener=image;window.__imageScroll=scrollY;window.__backgroundClicks=0;document.querySelector('.edit').addEventListener('click',()=>window.__backgroundClicks++)})()`)
        await clickWithoutScroll('.picList img');await until(`document.querySelector('#imgModal')?.matches(':modal')`,'native image dialog')
        await key('Tab');await key('Tab','Tab',8);await js(`document.querySelector('.edit').focus()`)
        check(await js(`document.querySelector('#imgModal').tagName==='DIALOG' && document.activeElement===document.querySelector('#imgModal') && document.body.style.position==='fixed'`),'이미지 확대 native dialog는 닫기에 포커스를 두고 Tab·배경 포커스를 가둠')
        await clickWithoutScroll('.edit');await until(`!document.querySelector('#imgModal')`,'image explicit close')
        check(await js(`document.activeElement===window.__imageOpener && Math.abs(scrollY-window.__imageScroll)<=1 && document.body.style.position===''`),'이미지 바깥 클릭은 원래 사진 포커스와 스크롤 복원')
        await key('Enter');await until(`document.querySelector('#imgModal')?.matches(':modal')`,'image keyboard open');await key('Escape');await until(`!document.querySelector('#imgModal')`,'image keyboard close')
        check(await js(`document.activeElement===window.__imageOpener && document.body.style.position===''`),'이미지 확대 Enter 열기·Escape 닫기와 포커스 복원')
        await clickWithoutScroll('.picList img');await until(`document.querySelector('#imgModal')?.matches(':modal')`,'image backdrop ready');await clickWithoutScroll('.edit');await until(`!document.querySelector('#imgModal')`,'image native backdrop close')
        check(await js(`window.__backgroundClicks===0 && !document.querySelector('#loginModal') && document.activeElement===window.__imageOpener && Math.abs(scrollY-window.__imageScroll)<=1`),'이미지 모달 바깥 클릭도 배경 로그인 실행 없이 사진 포커스 복원')

        await cdp('Emulation.setDeviceMetricsOverride',{width:1280,height:1100,deviceScaleFactor:1,mobile:false});await reset()
        await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
        check(await js(`(()=>{const item=document.querySelector('.sortableItem'),previous=item.style.transition;item.style.transition='transform 2s';const style=getComputedStyle(item),reduced=matchMedia('(prefers-reduced-motion: reduce)').matches && style.transitionDuration.split(',').every(value=>parseFloat(value)===0) && style.animationName==='none' && style.scrollBehavior==='auto';item.style.transition=previous;return reduced})()`),'reduced-motion 환경에서 inline 드래그 transition·animation·부드러운 스크롤 제거')
        await focus('[data-section] .dragHandle');await key('Space',' ');await key('ArrowDown');await key('Space',' ');await save()
        check(requests.filter(r=>r.path==='/rest/v1/rpc/save_site'&&r.method==='POST').at(-1).body.p_data.sections.map(row=>row.id).join(',')==='11,10','reduced-motion에서도 키보드 정렬과 순서 저장 유지')
        await cdp('Emulation.setEmulatedMedia',{features:[]})

        await reset();await nativeClick('#feedItems .picEditItem .btn');mode.deleteFailure=true;await save()
        const journal=await cleanupRecords()
        check(journal.length===1 && journal[0].path==='feed/first.png' && Number.isSafeInteger(journal[0].queuedAt),'삭제 실패한 이미지 정리 경로와 시각을 브라우저에 기록')
        mode.deleteFailure=false;requests.length=0;await navigate('/edit')
        await until(`[...document.querySelectorAll('button')].some(button=>button.textContent==='이미지 정리 다시 시도')`,'cleanup journal recovered')
        check((await cleanupRecords()).length===1 && !requests.some(r=>(r.path.startsWith('/storage/')&&r.method==='DELETE')||r.path==='/rest/v1/rpc/save_site'),'새로고침 후 정리 기록과 수동 재시도 복구·자동 삭제 없음')
        mode.loadStatus=503;requests.length=0;await button('^이미지 정리 다시 시도$')
        await untilRequests(()=>loadRequests().length===1,'cleanup reference check failed')
        await until(`[...document.querySelectorAll('button')].some(button=>button.textContent==='이미지 정리 다시 시도' && !button.matches(':disabled'))`,'cleanup reference failure complete')
        check((await cleanupRecords()).length===1 && !requests.some(r=>(r.path.startsWith('/storage/')&&r.method==='DELETE')||r.path==='/rest/v1/rpc/save_site'),'현재 참조 조회 실패 시 삭제를 막고 정리 기록 유지')
        mode.loadStatus=200;requests.length=0;await button('^이미지 정리 다시 시도$')
        await until(`![...document.querySelectorAll('button')].some(button=>button.textContent.includes('이미지 정리 다시 시도') || button.textContent.includes('이미지 정리 중'))`,'recovered cleanup success')
        const referenceIndex=requests.findIndex(r=>r.path==='/rest/v1/rpc/load_site'&&r.method==='POST'),deleteIndex=requests.findIndex(r=>r.path.startsWith('/storage/')&&r.method==='DELETE')
        check(referenceIndex>=0 && deleteIndex>referenceIndex && requests[deleteIndex].body.prefixes.join('|')==='feed/first.png' && !requests.some(r=>r.path==='/rest/v1/rpc/save_site') && (await cleanupRecords()).length===0 && site.feed.length===1,'복구한 수동 정리는 최신 참조 확인 후 미참조 파일만 삭제·기록 해제')

        await reset();await nativeClick('#feedItems .picEditItem .btn');mode.deleteFailure=true;await save()
        site.feed=[{id:20,sort_order:1,image_path:'feed/first.png'},...site.feed.map((row,index)=>({...row,sort_order:index+2}))]
        mode.deleteFailure=false;requests.length=0;await navigate('/edit')
        await until(`[...document.querySelectorAll('button')].some(button=>button.textContent==='이미지 정리 다시 시도')`,'referenced cleanup recovered')
        await button('^이미지 정리 다시 시도$');await until(`![...document.querySelectorAll('button')].some(button=>button.textContent.includes('이미지 정리 다시 시도') || button.textContent.includes('이미지 정리 중'))`,'referenced cleanup cancelled')
        check(loadRequests().length===2 && (await cleanupRecords()).length===0 && !requests.some(r=>(r.path.startsWith('/storage/')&&r.method==='DELETE')||r.path==='/rest/v1/rpc/save_site') && site.feed.some(row=>row.image_path==='feed/first.png'),'복구 기록의 파일이 다시 참조 중이면 삭제를 취소하고 기록만 해제')
    }
    check(errors.length===0,'브라우저 실행 예외 없음')
    console.log(JSON.stringify({phase,passed:passed.length,checks:passed,errors},null,2))
} catch(error) {
    const diagnostics=js?await js(`({url:location.pathname,buttons:[...document.querySelectorAll('button')].map(b=>({text:b.textContent,disabled:b.matches(':disabled')}))})`).catch(()=>null):null;console.error(JSON.stringify({phase,passed:passed.length,checks:passed,errors,diagnostics,dialogs,viteLogs,requests:requests.slice(-12).map(r=>({method:r.method,path:r.path})),failure:error.stack},null,2));process.exitCode=1
} finally {
    if(cdp){try{await Promise.race([cdp('Browser.close'),pause(1000)])}catch{}}
    for(const task of pending.values())task.reject(new Error('Browser test finished'))
    pending.clear()
    ws?.close();chrome?.kill();vite?.kill();api.closeAllConnections();await new Promise(resolve=>api.close(resolve))
    if(temp){const resolved=path.resolve(temp);if(!resolved.startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(resolved).startsWith('profile-editor-check-')){console.error('Unsafe temporary cleanup path');process.exitCode=1}else{await pause(300);await fs.rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200})}}
}

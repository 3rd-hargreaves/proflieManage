import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const phase = process.argv.includes('--phase1') ? 1 : 2
const chromePath = process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const passed = []
const errors = []
const user = { id: '11111111-1111-4111-8111-111111111111', email: 'admin@example.test', aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email' }, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' }
const jwt = n => `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: user.id, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now()/1000)+3600, iat: Math.floor(Date.now()/1000), n })).toString('base64url')}.test-only-signature`
let tokenSequence = 0
const session = () => ({ access_token: jwt(++tokenSequence), refresh_token: 'test-refresh-token', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now()/1000)+3600, user })
const initial = () => ({ profile: { id: 1, name: '검증 이름', status_message: '검증 상태', profile_image_path: null }, theme: { id: 1, main_color: '#7841ab', background_color: '#fce8ef', card_background_color: '#ffffff', typo_color: '#26232a' }, sections: [{ id: 10, sort_order: 1, title: '첫 섹션', content: '첫 내용' },{ id: 11, sort_order: 2, title: '둘째 섹션', content: '둘째 내용' }], keywords: [{ id: 30, sort_order: 1, content: '검증' }], feed: [{id:20,sort_order:1,image_path:'feed/first.png'},{id:21,sort_order:2,image_path:'feed/second.png'}] })
let site = initial()
let mode = { userStatus: 200, userDelay: 0, tokenDelay: 0, saveDelay: 0 }
const requests = []
let nextId = 100
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=', 'base64')
const api = http.createServer(async (req,res) => {
    const url = new URL(req.url, 'http://localhost')
    const chunks=[]; for await(const chunk of req)chunks.push(chunk)
    const raw=Buffer.concat(chunks).toString()
    const entry={method:req.method,path:url.pathname,body:null}; requests.push(entry)
    if(raw && !req.headers['content-type']?.includes('multipart')){try{entry.body=JSON.parse(raw)}catch{}}
    res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Expose-Headers','Content-Range');res.setHeader('Access-Control-Allow-Headers','*');res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS')
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return}
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(data===undefined?undefined:JSON.stringify(data))}
    if(url.pathname==='/auth/v1/user') {const status=mode.userStatus;await pause(mode.userDelay);send(status,status===200?user:{code:status===401?'bad_jwt':'unexpected_failure',msg:'Mock verification failure'});return}
    if(url.pathname==='/auth/v1/token'){await pause(mode.tokenDelay);const status=mode.tokenStatus??200;send(status,status===200?session():{error:'invalid_grant',error_code:'invalid_credentials',msg:'Invalid login credentials'});return}
    if(url.pathname==='/auth/v1/logout'){send(204);return}
    if(url.pathname==='/rest/v1/rpc/save_site') {
        await pause(mode.saveDelay)
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
    if(url.pathname.startsWith('/storage/v1/object/')&&req.method==='DELETE'){send(200,[]);return}
    send(404,{error:'unknown mock request'})
})
const listen = server => new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)))
const freePort = async()=>{const server=http.createServer();const port=await listen(server);await new Promise(r=>server.close(r));return port}
let vite,chrome,ws,temp
let viteLogs=''
let cdp,js
const dialogs=[]
let acceptDialog=false
const check=(condition,label)=>{assert.ok(condition,label);passed.push(label)}
try {
    await fs.access(chromePath)
    temp=await fs.mkdtemp(path.join(os.tmpdir(),'profile-editor-check-'))
    const picture=path.join(temp,'선택 이미지.png');await fs.writeFile(picture,image)
    const apiPort=await listen(api),vitePort=await freePort(),debugPort=await freePort()
    const appUrl=`http://127.0.0.1:${vitePort}`
    vite=spawn(process.execPath,[path.join(project,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(vitePort),'--strictPort'],{cwd:project,env:{...process.env,VITE_SUPABASE_URL:`http://127.0.0.1:${apiPort}`,VITE_SUPABASE_PUBLISHABLE_KEY:'test-publishable-key',VITE_ADMIN_EMAIL:user.email,VITE_ADMIN_USER_ID:user.id,VITE_SUPABASE_STORAGE_BUCKET:'site-images'},windowsHide:true,stdio:['ignore','pipe','pipe']})
    for(const stream of [vite.stdout,vite.stderr])stream.on('data',chunk=>{viteLogs=(viteLogs+chunk.toString()).slice(-3000)})
    for(let i=0;i<100;i++){try{if((await fetch(appUrl)).ok)break}catch{} await pause(100);if(i===99)throw new Error('Vite did not start')}
    chrome=spawn(chromePath,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${path.join(temp,'chrome')}`,'about:blank'],{windowsHide:true,stdio:'ignore'})
    let target
    for(let i=0;i<100;i++){try{target=(await(await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find(t=>t.type==='page');if(target)break}catch{}await pause(100)}
    if(!target)throw new Error('Chrome did not start; set CHROME_PATH to a Chromium executable')
    ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})})
    let sequence=0;const pending=new Map()
    cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))})
    ws.addEventListener('message',event=>{
        const message=JSON.parse(event.data)
        if(message.id){const task=pending.get(message.id);pending.delete(message.id);if(message.error)task.reject(new Error(JSON.stringify(message.error)));else task.resolve(message.result)}
        if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text)
        if(message.method==='Page.javascriptDialogOpening'){
            dialogs.push({...message.params,accepted:acceptDialog})
            void cdp('Page.handleJavaScriptDialog',{accept:acceptDialog}).catch(error=>errors.push(error.message))
        }
    })
    js=async expression=>{const result=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value}
    const until=async(expression,label,timeout=20000)=>{const start=Date.now();while(Date.now()-start<timeout){if(await js(expression))return;await pause(70)}throw new Error(`Timed out: ${label}\n${await js('document.body.innerText')}`)}
    const hasEditor=()=>js('!!document.querySelector("#profileName")')
    const saveDisabled=()=>js('document.querySelector("button[type=submit]")?.matches(":disabled")')
    const button=async pattern=>js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>new RegExp(${JSON.stringify(pattern)}).test(b.textContent));if(!b)throw new Error('Missing button '+${JSON.stringify(pattern)});b.click();return true})()`)
    const set=async(selector,value)=>js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`)
    const nativeClick=async selector=>{const point=await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);await cdp('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1})}
    const key=async(code,key=code)=>{await cdp('Input.dispatchKeyEvent',{type:'keyDown',code,key,windowsVirtualKeyCode:code==='Space'?32:code==='Enter'?13:code==='Escape'?27:code==='ArrowDown'?40:code==='ArrowUp'?38:0});await cdp('Input.dispatchKeyEvent',{type:'keyUp',code,key});await pause(180)}
    const focus=async(selector,index=0)=>{await js(`document.querySelectorAll(${JSON.stringify(selector)})[${index}].focus()`);await pause(100)}
    const sessionValue=session()
    await cdp('Runtime.enable');await cdp('Page.enable');await cdp('DOM.enable')
    await cdp('Emulation.setDeviceMetricsOverride',{width:1280,height:1100,deviceScaleFactor:1,mobile:false})
    await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`if(sessionStorage.getItem('editor-test-no-session')==='1')localStorage.removeItem('sb-127-auth-token');else localStorage.setItem('sb-127-auth-token',${JSON.stringify(JSON.stringify(sessionValue))});`})
    const navigate=async destination=>{await cdp('Page.navigate',{url:appUrl+destination});await pause(400)}
    const reset=async(authenticated=true)=>{mode={userStatus:200,userDelay:0,tokenDelay:0,saveDelay:0};site=initial();acceptDialog=true;await js(`try{sessionStorage.setItem('editor-test-no-session',${JSON.stringify(authenticated?'0':'1')})}catch{}`);await navigate('/');acceptDialog=false;await until('!!document.querySelector(".edit")','main ready');if(authenticated){await until("document.querySelector('.edit')?.getAttribute('aria-label')==='수정 화면 열기'",'verified main');await nativeClick('.edit');await until('!!document.querySelector("#profileName")','editor ready')}dialogs.length=0;requests.length=0}
    const refresh=()=>js(`void import('/src/lib/supabase.ts').then(({supabase})=>supabase.auth.refreshSession())`)
    const externalSignout=()=>js(`void import('/src/lib/supabase.ts').then(({supabase})=>supabase.auth.signOut({scope:'local'}))`)
    const save=async()=>{await js('document.querySelector("button[type=submit]").click()');await until('/저장했습니다|저장 성공/.test(document.body.innerText) && !document.querySelector("button[type=submit]").matches(":disabled")','save complete')}
    const selectFile=async selector=>{const {root}=await cdp('DOM.getDocument');const {nodeId}=await cdp('DOM.querySelector',{nodeId:root.nodeId,selector});await cdp('DOM.setFileInputFiles',{nodeId,files:[picture]});await pause(100)}
    await navigate('/');await reset()
    check(await hasEditor(),'검증된 관리자만 수정 화면 열기')
    check(await js(`(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return !e.defaultPrevented})()`),'변경 전에는 이탈 경고 없음')
    await set('#profileName','보존할 이름');await set('[data-section] textarea','보존할 *원문*');await selectFile('#profileFile')
    const preview=await js(`document.querySelector('img[alt="프로필 이미지 미리보기"]').src`)
    check(preview.startsWith('blob:'),'선택한 이미지가 편집 상태에 존재')
    check(await js(`(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented})()`),'미저장 내용은 beforeunload 경고 대상')
    await nativeClick('#profileName');const reloadDialogs=dialogs.length;await cdp('Page.reload');await pause(250);check(dialogs.slice(reloadDialogs).some(d=>d.type==='beforeunload') && await js(`document.querySelector('#profileName')?.value==='보존할 이름'`),'실제 새로고침 취소 시 편집 유지');
    mode.userStatus=503;await refresh();await until('document.body.innerText.includes("확인하지 못")','verification network failure')
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
        await focus(sectionSelector);await key('Space',' ');await externalSignout();await until(`![...document.querySelectorAll('.dragHandle')].some(b=>!b.matches(':disabled')) && !document.querySelector('.sortableDragging')`,'auth locks drag')
        check(await js(`[...document.querySelectorAll('.dragHandle')].every(b=>b.matches(':disabled'))`),'인증 잠금 중 활성 드래그 종료·다른 목록 시작 차단')
    }
    check(errors.length===0,'브라우저 실행 예외 없음')
    console.log(JSON.stringify({phase,passed:passed.length,checks:passed,errors},null,2))
} catch(error) {
    const diagnostics=js?await js(`({url:location.pathname,buttons:[...document.querySelectorAll('button')].map(b=>({text:b.textContent,disabled:b.matches(':disabled')}))})`).catch(()=>null):null;console.error(JSON.stringify({phase,passed:passed.length,checks:passed,errors,diagnostics,dialogs,viteLogs,requests:requests.slice(-12).map(r=>({method:r.method,path:r.path})),failure:error.stack},null,2));process.exitCode=1
} finally {
    if(cdp){try{await Promise.race([cdp('Browser.close'),pause(1000)])}catch{}}
    ws?.close();chrome?.kill();vite?.kill();api.closeAllConnections();await new Promise(resolve=>api.close(resolve))
    if(temp){const resolved=path.resolve(temp);if(!resolved.startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(resolved).startsWith('profile-editor-check-')){console.error('Unsafe temporary cleanup path');process.exitCode=1}else{await pause(300);await fs.rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200})}}
}

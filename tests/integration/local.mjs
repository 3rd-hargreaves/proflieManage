import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { createLocalBrowser } from '../helpers/localBrowser.mjs'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const productionRef = 'nvunhhyxbbjqgzdhodrw'
const passed = []
const check = (condition, label) => { assert.ok(condition, label); passed.push(label) }
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=', 'base64')
const markup = '  *실제 볼드* _밑줄_ /기울임/ -가로줄-\n| 실제 | 표 |\n원문 보존  '
let browser, temp, build, admin, anon, other, config
const created = new Set()
let baseline


function safeError(error) {
    const message = error instanceof Error ? error.message : String(error)
    return [config?.adminPassword, config?.otherPassword, config?.publishableKey].filter(Boolean)
        .reduce((text, secret) => text.split(secret).join('[redacted]'), message)
}

async function rpc(client, name, parameters = {}) {
    const { data, error } = await client.rpc(name, parameters).abortSignal(AbortSignal.timeout(20000))
    if (error) throw new Error(`${name} failed (${error.code || 'request'}): ${error.message}`)
    return data
}

async function publicBytes(file) {
    const url = anon.storage.from(config.storageBucket || 'site-images').getPublicUrl(file).data.publicUrl
    assert.equal(new URL(url).origin, new URL(config.apiUrl).origin)
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10000) })
    if (!response.ok) {
        const failure = await response.json().catch(() => null)
        if (response.status === 404 || (response.status === 400 && Number(failure?.statusCode) === 404)) return null
        throw new Error(`Public rehearsal Storage request failed (${response.status}).`)
    }
    return Buffer.from(await response.arrayBuffer())
}

async function removeUnused(files) {
    if (!files.length) return
    const references = new Set(await rpc(admin, 'load_image_references'))
    const candidates = files.filter(file => !references.has(file))
    if (!candidates.length) return
    const { error } = await admin.storage.from(config.storageBucket || 'site-images').remove(candidates)
    if (error) throw new Error(`Rehearsal Storage cleanup failed: ${error.message}`)
    for (const file of candidates) assert.equal(await publicBytes(file), null, 'A cleanup candidate must really be absent after Storage removal.')
}

async function buildProduction(dist, environment) {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITE_')))
    let output = ''
    build = spawn(process.execPath, ['--input-type=module', '--eval', `
        import { build } from 'vite';
        await build({ envDir: false, build: { outDir: process.env.REHEARSAL_DIST, emptyOutDir: true } });
    `], { cwd: project, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...clean, ...environment, REHEARSAL_DIST: dist } })
    for (const stream of [build.stdout, build.stderr]) stream.on('data', bytes => { output = (output + bytes).slice(-5000) })
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { build.kill(); reject(new Error('Rehearsal production build timed out')) }, 60000)
        build.once('error', error => { clearTimeout(timer); reject(error) })
        build.once('exit', code => {
            clearTimeout(timer)
            if (code === 0) resolve()
            else reject(new Error(`Rehearsal production build failed (${code}): ${output}`))
        })
    })
}

try {
    assert.ok(process.argv[2], 'Pass the explicit ignored rehearsal JSON config path. Production .env files are never read.')
    config = JSON.parse(await fs.readFile(path.resolve(process.argv[2]), 'utf8'))
    const api = new URL(config.apiUrl)
    assert.equal(config.rehearsal, true, 'The target must be explicitly marked as rehearsal.')
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname) && ['http:', 'https:'].includes(api.protocol), 'Real integration writes are restricted to a local isolated Supabase.')
    assert.ok(!config.apiUrl.includes(productionRef), 'Production Supabase is forbidden.')
    for (const key of ['publishableKey', 'adminEmail', 'adminUserId', 'adminPassword', 'otherEmail', 'otherPassword']) assert.ok(typeof config[key] === 'string' && config[key], `Missing rehearsal configuration: ${key}`)
    const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
    anon = createClient(api.origin, config.publishableKey, options)
    admin = createClient(api.origin, config.publishableKey, options)
    other = createClient(api.origin, config.publishableKey, options)
    const signed = await admin.auth.signInWithPassword({ email: config.adminEmail, password: config.adminPassword })
    assert.equal(signed.error, null, 'Rehearsal admin must be able to log in.')
    assert.equal(signed.data.user.id, config.adminUserId, 'Admin UUID must match the rehearsal policy and frontend configuration.')
    const otherSigned = await other.auth.signInWithPassword({ email: config.otherEmail, password: config.otherPassword })
    assert.equal(otherSigned.error, null, 'A non-admin test user must exist.')
    check(otherSigned.data.user.id !== config.adminUserId, '실제 Auth 관리자·일반 사용자 계정을 분리')
    baseline = await rpc(anon, 'load_main')
    const initialId = config.initialCharacterId || baseline.characters[0]?.id
    assert.ok(Number.isSafeInteger(initialId), 'An initial rehearsal character must exist.')
    const original = await rpc(anon, 'load_character', { p_character_id: initialId })
    assert.ok(original, 'The initial rehearsal character must be publicly readable.')
    check(baseline.characters.some(row => row.id === initialId), '실제 REST 공개 조회가 기존 캐릭터·메인 테마 반환')
    const baselineImagePath = original.profile.profile_image_path || original.feed[0]?.image_path
    if (baselineImagePath) check((await publicBytes(baselineImagePath))?.length > 0, '기존 이미지 경로의 실제 Storage 공개 URL 다운로드 가능')
    for (const [name, client] of [['anon', anon], ['other-user', other]]) {
        const { error } = await client.rpc('save_main_theme', { p_expected: baseline.theme, p_data: {
            main_color: '#102030', background_color: '#ffffff', card_background_color: '#ffffff', typo_color: '#111111',
        } })
        check(!!error, `${name}의 실제 메인 테마 쓰기는 RPC 권한/RLS로 거절`)
        const deniedUpload = await client.storage.from(config.storageBucket || 'site-images').upload(`profile/${initialId}/${crypto.randomUUID()}--forbidden.png`, image, { contentType: 'image/png' })
        check(!!deniedUpload.error, `${name}의 실제 Storage 업로드 거절`)
    }

    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-rehearsal-integration-'))
    const dist = path.join(temp, 'dist'), picture = path.join(temp, '실제 업로드.png'), secondPicture = path.join(temp, '둘째 사진.png')
    await fs.writeFile(picture, image); await fs.writeFile(secondPicture, image)
    await buildProduction(dist, {
        VITE_SUPABASE_URL: api.origin, VITE_SUPABASE_PUBLISHABLE_KEY: config.publishableKey,
        VITE_ADMIN_EMAIL: config.adminEmail, VITE_ADMIN_USER_ID: config.adminUserId,
        VITE_SUPABASE_STORAGE_BUCKET: config.storageBucket || 'site-images',
    })
    const deployment = JSON.parse(await fs.readFile(path.join(project, 'vercel.json'), 'utf8'))
    const sourceHeaders = deployment.headers.find(rule => rule.source === '/(.*)')?.headers
    assert.ok(sourceHeaders, 'Global production security headers are required.')
    const sourcePolicy = sourceHeaders.find(header => header.key.toLowerCase() === 'content-security-policy')?.value
    assert.ok(sourcePolicy?.includes(`https://${productionRef}.supabase.co`))
    const headers = sourceHeaders.map(header => header.key.toLowerCase() === 'content-security-policy'
        ? { ...header, value: header.value.replaceAll(`https://${productionRef}.supabase.co`, api.origin) } : header)
    browser = await createLocalBrowser({ dist, headers, rewrites: deployment.rewrites, apiOrigin: api.origin })
    const { js, until, navigate, set, click, button, cdp } = browser
    const ready = () => until(`!!document.querySelector('.headerLogoutButton:not(:disabled)') && document.querySelector('main')?.getAttribute('aria-busy')!=='true'`, 'authenticated UI unlocked')
    const submit = () => js(`document.querySelector('main form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`)
    const read = id => rpc(anon, 'load_character', { p_character_id: id })
    const cardOrder = () => js(`[...document.querySelectorAll('.character')].map(card=>Number(card.getAttribute('href').split('/').at(-1)))`)
    const createUi = async (name, withFiles) => {
        await navigate('/characters/new')
        await until(`!!document.querySelector('#profileName') && !!document.querySelector('.headerLogoutButton:not(:disabled)')`, 'new character form')
        await set('#profileName', name); await set('#profileMessage', '검증 전용 상태 메시지'); await set('#keywords', '통합, 실제 저장')
        await click('#addSectionBtn')
        await set('[data-section] input', '실제 첫 섹션'); await set('[data-section] textarea', markup)
        await click('#addSectionBtn')
        await js(`(()=>{const field=document.querySelectorAll('[data-section] input')[1];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'실제 둘째 섹션');field.dispatchEvent(new Event('input',{bubbles:true}))})()`)
        await js(`(()=>{const field=document.querySelectorAll('[data-section] textarea')[1];Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'둘째 본문');field.dispatchEvent(new Event('input',{bubbles:true}))})()`)
        if (withFiles) {
            await browser.file('#profileFile', [picture]); await browser.file('#feedFiles', [picture, secondPicture])
            await until(`document.querySelector('img[alt="프로필 이미지 미리보기"]')?.src.startsWith('blob:')`, 'real File preview')
            check(await js(`document.querySelector('img[alt="프로필 이미지 미리보기"]').naturalWidth>0`), '실제 원본 File의 blob 미리보기 표시')
        }
        await submit()
        await until(`location.pathname.split('/').length===3 && Number.isSafeInteger(Number(location.pathname.split('/').at(-1))) && document.querySelector('.profileName')?.textContent===${JSON.stringify(name)}`, 'new character committed and routed', 30000)
        const id = await js(`Number(location.pathname.split('/').at(-1))`)
        created.add(id)
        return id
    }

    for (const route of ['/', `/characters/${initialId}`, '/characters/new', `/characters/${initialId}/edit`, '/edit', '/manage.html']) {
        const response = await fetch(browser.appUrl + route)
        check(response.status === 200 && response.headers.get('content-security-policy') === headers.find(header => header.key.toLowerCase() === 'content-security-policy').value, `${route} 실제 production 파일·rewrite·CSP 응답`)
    }
    await navigate('/')
    await until(`!!document.querySelector('.character') && !!document.querySelector('.headerLoginButton:not(:disabled)')`, 'public browser connected to real DB')
    check(await js(`!document.querySelector('main .dragHandle') && !document.querySelector('[data-theme]')`), '실제 비로그인 브라우저에는 메인 관리 도구 없음')
    await click('.headerLoginButton'); await until(`!!document.querySelector('#loginModal input')`, 'login dialog')
    await set('#loginModal input', config.adminPassword); await click('#loginModal button[type=submit]'); await ready()
    check(await js(`!!document.querySelector('a[href="/characters/new"]')`), '브라우저 비밀번호 로그인 후 실제 Auth 관리자 확인')

    const uniqueName = `리허설-${Date.now()}`
    const firstId = await createUi(uniqueName, true)
    const first = await read(firstId)
    check(first.profile.name === uniqueName && first.sections[0].content === markup && first.keywords.length === 2 && first.feed.length === 2, '브라우저 신규 생성이 실제 DB에 원문·키워드·피드 원자 저장')
    check(first.profile.profile_image_path.startsWith(`profile/${firstId}/`) && first.feed.every(row => row.image_path.startsWith(`feed/${firstId}/`)), '실제 Storage 신규 파일이 예약 캐릭터 ID 경로에 저장')
    check((await publicBytes(first.profile.profile_image_path))?.equals(image) && (await publicBytes(first.feed[0].image_path))?.equals(image), '프로필·피드의 실제 업로드 bytes와 공개 다운로드가 원본과 동일')
    check(await js(`document.title===${JSON.stringify(uniqueName)} && document.querySelector('.sectionContent strong')?.textContent==='실제 볼드' && !!document.querySelector('.sectionContent table')`), '실제 저장 재조회에서 제목·본문 서식 표시')

    await navigate(`/characters/${firstId}/edit`); await until(`!!document.querySelector('#profileName')`, 'saved character edit loaded')
    check(await js(`document.querySelector('[data-section] textarea').value===${JSON.stringify(markup)}`), '실제 DB를 읽은 편집 화면은 서식 원문 유지')
    await set('#profileMessage', '실제 수정 상태'); await set('[data-theme="--main-color"]', '#2468ac')
    await js(`document.querySelector('[data-section] .dragHandle').focus()`)
    await browser.key('Space', ' '); await browser.key('ArrowDown'); await browser.key('Space', ' ')
    await js(`document.querySelector('#feedItems .dragHandle').focus()`)
    await browser.key('Space', ' '); await browser.key('ArrowDown'); await browser.key('Space', ' ')
    await browser.file('#profileFile', [secondPicture]); await submit(); await until(`document.body.innerText.includes('저장 성공')`, 'edit committed', 30000)
    const updated = await read(firstId)
    check(updated.profile.status_message === '실제 수정 상태' && updated.theme.main_color === '#2468ac' && updated.sections[0].id === first.sections[1].id
        && updated.feed[0].id === first.feed[1].id, '실제 캐릭터 수정·섹션/피드 순서·테마 저장 및 기존 ID 보존')
    check(updated.profile.profile_image_path !== first.profile.profile_image_path && await publicBytes(first.profile.profile_image_path) === null,
        '이미지 교체 커밋 후 실제 Storage의 미사용 이전 프로필 정리')
    const originalAfter = await read(initialId)
    check(JSON.stringify(originalAfter) === JSON.stringify(original), '다른 캐릭터 수정·이미지 정리가 기존 캐릭터 내용에 영향 없음')

    const secondId = await createUi(`${uniqueName}-둘째`, false)
    await navigate('/'); await until(`document.querySelectorAll('main .dragHandle').length>=3`, 'main ordering tools')
    const beforeMain = await rpc(anon, 'load_main')
    await set('[data-theme="--main-color"]', '#315a73')
    await js(`document.querySelector('main .dragHandle').focus()`)
    await browser.key('Space', ' '); await browser.key('ArrowDown'); await browser.key('Space', ' ')
    const wantedOrder = await cardOrder()
    check(JSON.stringify((await rpc(anon, 'load_main')).characters.map(row => row.id)) === JSON.stringify(beforeMain.characters.map(row => row.id)), '메인 드래그는 실제 DB 저장 전에 로컬 순서만 변경')
    await button('순서 저장'); await until(`document.body.innerText.includes('순서 저장 완료')`, 'main order committed')
    const ordered = await rpc(anon, 'load_main')
    check(JSON.stringify(ordered.characters.map(row => row.id)) === JSON.stringify(wantedOrder) && ordered.theme.main_color === beforeMain.theme.main_color,
        '실제 메인 순서 RPC가 색상을 저장하지 않고 ID 순서만 확정')
    await button('테마 저장'); await until(`document.body.innerText.includes('테마 저장 완료')`, 'main theme committed')
    const themed = await rpc(anon, 'load_main')
    check(themed.theme.main_color === '#315a73' && JSON.stringify(themed.characters.map(row => row.id)) === JSON.stringify(wantedOrder)
        && (await read(firstId)).theme.main_color === '#2468ac', '실제 메인 테마 RPC가 순서·캐릭터 테마와 독립 저장')
    await navigate('/'); await until(`getComputedStyle(document.documentElement).getPropertyValue('--main-color').trim()==='#315a73'`, 'persisted main loaded')

    const shots = process.env.REHEARSAL_SCREENSHOT_DIR
    if (shots) await fs.mkdir(shots, { recursive: true })
    for (const width of [1280, 768, 390]) {
        await cdp('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width <= 768 })
        await navigate('/'); await ready()
        check(await js(`document.documentElement.scrollWidth<=innerWidth && !!document.querySelector('[data-theme]')`), `${width}px 실제 메인 관리 화면의 가로 넘침 없음`)
        if (shots) await browser.screenshot(path.join(shots, `main-${width}.png`))
        await navigate(`/characters/${firstId}`); await until(`document.querySelector('.profileName')?.textContent===${JSON.stringify(uniqueName)}`, 'profile at viewport')
        check(await js(`document.documentElement.scrollWidth<=innerWidth && document.querySelector('.profileImg img, img.profileImg')?.naturalWidth>0`), `${width}px 실제 프로필·Storage 이미지 표시`)
        if (shots) await browser.screenshot(path.join(shots, `profile-${width}.png`))
        await navigate(`/characters/${firstId}/edit`); await until(`!!document.querySelector('#profileName')`, 'editor at viewport')
        check(await js(`document.documentElement.scrollWidth<=innerWidth && document.querySelector('#profileName').value===${JSON.stringify(uniqueName)}`), `${width}px 실제 편집 폼 재조회·배치 정상`)
        if (shots) await browser.screenshot(path.join(shots, `editor-${width}.png`))
        const policyErrors = await js('window.__rehearsalViolations')
        check(policyErrors.length === 0, `${width}px 실제 API·이미지·미리보기 경로의 CSP 위반 없음`)
    }

    const deletionPaths = [updated.profile.profile_image_path, ...updated.feed.map(row => row.image_path)]
    const beforeDeletion = await rpc(anon, 'load_main')
    const baselineIds = baseline.characters.map(row => row.id)
    await rpc(admin, 'save_character_order', { p_expected: beforeDeletion.characters.map(row => row.id),
        p_order: [...baselineIds, ...beforeDeletion.characters.map(row => row.id).filter(id => !baselineIds.includes(id))] })
    for (const id of [secondId, firstId]) {
        await navigate(`/characters/${id}/edit`); await until(`!!document.querySelector('#profileName')`, 'delete target ready')
        await button('캐릭터 삭제'); await until(`location.pathname==='/' && !!document.querySelector('[data-theme]')`, 'deletion returned to main', 30000)
        check(await read(id) === null, '브라우저 확인 삭제가 실제 캐릭터·자식 행 제거 후 메인 이동')
        created.delete(id)
    }
    check((await rpc(admin, 'load_image_references')).every(file => !deletionPaths.includes(file)) && (await Promise.all(deletionPaths.map(publicBytes))).every(bytes => bytes === null),
        '삭제된 테스트 캐릭터의 프로필·피드 실파일 정리와 전역 참조 해제')
    if (baselineImagePath) check((await publicBytes(baselineImagePath))?.length > 0, '다른 캐릭터 삭제 후 기존 이미지 공개 URL 계속 보존')
    await click('.headerLogoutButton'); await until(`!!document.querySelector('.headerLoginButton:not(:disabled)')`, 'real logout')
    check(await js(`!document.querySelector('[data-theme]') && !document.querySelector('main .dragHandle')`), '실제 Auth 로그아웃 후 메인 관리 기능 숨김')
    await navigate(`/characters/${initialId}/edit`); await until(`location.pathname==='/' && !!document.querySelector('.headerLoginButton:not(:disabled)')`, 'unauthenticated route guard')
    check(!await js(`!!document.querySelector('#profileName')`), '실제 비로그인 편집 주소 접근 차단')
    check(browser.apiRequests.some(request => request.path === '/auth/v1/token') && browser.apiRequests.some(request => request.path === '/rest/v1/rpc/create_character')
        && browser.apiRequests.some(request => request.method === 'POST' && request.path.startsWith('/storage/v1/object/')), '브라우저 실제 Auth·REST·Storage HTTP 요청을 모두 실행')
    check(browser.errors.length === 0 && browser.violations.length === 0 && browser.unexpectedRequests.length === 0, '실행 예외·전 경로 CSP 위반·운영/예상 밖 외부 요청 0건')
    console.log(JSON.stringify({ passed: passed.length, checks: passed, realApiRequests: browser.apiRequests.length, apiMocked: false, productionAccessed: false }, null, 2))
} catch (error) {
    const page = browser ? await browser.js(`({path:location.pathname,alerts:[...document.querySelectorAll('[role="alert"]')].map(node=>node.textContent),violations:window.__rehearsalViolations})`).catch(() => null) : null
    console.error(JSON.stringify({ passed: passed.length, checks: passed, failure: safeError(error), browserErrors: browser?.errors.map(safeError),
        unexpectedRequests: browser?.unexpectedRequests, lastApiRequests: browser?.apiRequests.slice(-12), page }, null, 2))
    process.exitCode = 1
} finally {
    if (admin && anon) {
        if (baseline && created.size) {
            try {
                const current = await rpc(anon, 'load_main')
                const ids = baseline.characters.map(row => row.id)
                const present = new Set(current.characters.map(row => row.id))
                const order = [...ids.filter(id => present.has(id)), ...current.characters.map(row => row.id).filter(id => !ids.includes(id))]
                await rpc(admin, 'save_character_order', { p_expected: current.characters.map(row => row.id), p_order: order })
            } catch (error) { console.error(`Rehearsal order cleanup failed: ${safeError(error)}`); process.exitCode = 1 }
        }
        for (const id of created) {
            try {
                const expected = await rpc(anon, 'load_character', { p_character_id: id })
                if (!expected) continue
                const result = await rpc(admin, 'delete_character', { p_character_id: id, p_expected: expected })
                await removeUnused(result.cleanup_candidates)
            } catch (error) { console.error(`Rehearsal character cleanup failed: ${safeError(error)}`); process.exitCode = 1 }
        }
        if (baseline) {
            try {
                const current = await rpc(anon, 'load_main')
                const ids = baseline.characters.map(row => row.id)
                if (current.characters.length === ids.length && current.characters.every(row => ids.includes(row.id))) await rpc(admin, 'save_character_order', { p_expected: current.characters.map(row => row.id), p_order: ids })
                const { id: ignored, ...theme } = baseline.theme
                void ignored
                await rpc(admin, 'save_main_theme', { p_expected: current.theme, p_data: theme })
            } catch (error) { console.error(`Rehearsal baseline restoration failed: ${safeError(error)}`); process.exitCode = 1 }
        }
    }
    await browser?.close()
    build?.kill()
    await admin?.auth.signOut({ scope: 'local' }); await other?.auth.signOut({ scope: 'local' })
    if (temp) {
        const target = path.resolve(temp)
        assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(target).startsWith('profile-rehearsal-integration-'))
        await fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SiteData, SiteEditDraft } from '../src/types/site'
import type { SiteSaveData } from '../src/utils/siteDraft'

const api = vi.hoisted(() => ({ rpc: vi.fn(), write: vi.fn(), reserve: vi.fn(), refs: vi.fn(), upload: vi.fn(), remove: vi.fn(), list: vi.fn(), from: vi.fn() }))
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc: api.rpc, storage: { from: api.from } } }))
let sites: Map<number, SiteData>
let nextId = 100
interface WritePayload { p_character_id: number, p_expected: SiteData, p_data: SiteSaveData, p_request_id?: string }
function paths(site: SiteData) { return [...site.feed.map(row => row.image_path), ...(site.profile.profile_image_path ? [site.profile.profile_image_path] : [])] }
function response(payload: WritePayload): SiteData {
    const d = payload.p_data, id = payload.p_character_id
    return { profile: { id, ...d.profile }, theme: { id, ...d.theme },
        sections: d.sections.map((row,i) => ({ ...row,id:row.id ?? nextId++,sort_order:i+1 })),
        keywords: d.keywords.map((row,i) => ({ ...row,id:row.id ?? nextId++,sort_order:i+1 })),
        feed: d.feed.map((row,i) => ({ ...row,id:row.id ?? nextId++,sort_order:i+1 })) }
}
function writes(name='save_character') { return api.write.mock.calls.filter(([method]) => method === name) }
function newDraft() { const {draft}=fixture(); draft.profile.imagePath=null; draft.feed=[]; draft.sections=draft.sections.map(row=>({...row,databaseId:undefined})); return draft }

function fixture(): { expected: SiteData, draft: SiteEditDraft } {
    return {
        expected: {
            profile: { id: 1, name: '이름', status_message: '상태', profile_image_path: 'profile/old.png' },
            theme: { id: 1, main_color: '#123', background_color: '#fff', card_background_color: '#fff', typo_color: '#222' },
            sections: [{ id: 10, sort_order: 1, title: 'A', content: '*원문*' }, { id: 11, sort_order: 2, title: 'B', content: '두 번째' }],
            keywords: [{ id: 30, sort_order: 1, content: '키워드' }],
            feed: [{ id: 20, sort_order: 1, image_path: 'feed/first.png' }, { id: 21, sort_order: 2, image_path: 'feed/second.png' }],
        },
        draft: {
            profile: { name: '이름', statusMessage: '상태', imagePath: 'profile/old.png', file: null },
            theme: { mainColor: '#123', backgroundColor: '#fff', cardBackgroundColor: '#fff', typoColor: '#222' },
            sections: [{ id: 'section-a', databaseId: 10, title: 'A', content: '*원문*' }, { id: 'section-b', databaseId: 11, title: 'B', content: '두 번째' }],
            keywords: '키워드',
            feed: [{ id: 'feed-a', databaseId: 20, name: 'first.png', path: 'feed/first.png' }, { id: 'feed-b', databaseId: 21, name: 'second.png', path: 'feed/second.png' }],
        },
    }
}

function png(name = '새 이미지.png'): File {
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=', 'base64')
    return new File([bytes], name, { type: 'image/png' })
}

function memoryStorage() {
    const values = new Map<string, string>()
    return {
        values,
        get length() { return values.size },
        key: (index: number) => Array.from(values.keys())[index] ?? null,
        getItem: (key: string) => values.get(key) ?? null,
        setItem: vi.fn((key: string, value: string) => { values.set(key, value) }),
        removeItem: vi.fn((key: string) => { values.delete(key) }),
    }
}

function feedFixture(count: number): ReturnType<typeof fixture> {
    const state = fixture()
    state.expected.feed = Array.from({ length: count }, (_, index) => ({
        id: 20 + index,
        sort_order: index + 1,
        image_path: `feed/existing-${index + 1}.png`,
    }))
    state.draft.feed = state.expected.feed.map(row => ({
        id: `feed-${row.id}`,
        databaseId: row.id,
        name: row.image_path.split('/').at(-1)!,
        path: row.image_path,
    }))
    return state
}

beforeEach(() => {
    vi.resetModules()
    for (const mock of Object.values(api)) mock.mockReset()
    vi.stubEnv('VITE_SUPABASE_STORAGE_BUCKET','site-images')
    vi.stubEnv('VITE_SUPABASE_URL','https://cleanup-test.example')
    vi.stubGlobal('window',{localStorage:memoryStorage()})
    sites=new Map([[1,fixture().expected]]); nextId=100
    api.from.mockReturnValue({upload:api.upload,remove:api.remove,list:api.list})
    api.upload.mockResolvedValue({data:{},error:null})
    api.remove.mockImplementation(async (batch:string[])=>({data:batch.map(name=>({name})),error:null}))
    api.list.mockResolvedValue({data:[],error:null})
    api.refs.mockImplementation(async()=>({data:Array.from(new Set([...sites.values()].flatMap(paths))),error:null}))
    api.reserve.mockResolvedValue({data:2,error:null})
    api.write.mockImplementation(async(name:string,payload:WritePayload)=>{
        if(name==='delete_character') {
            sites.delete(payload.p_character_id)
            return {data:{character_id:payload.p_character_id,cleanup_candidates:paths(payload.p_expected)},error:null}
        }
        const site=response(payload);sites.set(site.profile.id,site)
        return {data:{character:site,cleanup_candidates:[]},error:null}
    })
    api.rpc.mockImplementation((name:string,args:WritePayload)=>{
        const result=Promise.resolve().then(()=>name==='load_image_references'?api.refs():name==='reserve_character_id'?api.reserve(args):api.write(name,args))
        return Object.assign(result,{abortSignal:()=>result})
    })
})
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals()})

describe('character save boundaries',()=>{
    it('uploads immutable character-scoped original Files before atomically saving and cleaning',async()=>{
        const {saveCharacter}=await import('../src/services/save')
        const {draft,expected}=fixture();draft.profile.file=png();const feed=png('피드.png')
        draft.feed=[draft.feed[1],{id:'new',name:feed.name,file:feed}]
        const result=await saveCharacter(1,draft,expected)
        expect(api.upload.mock.calls.map(call=>call[0])).toEqual([expect.stringMatching(/^profile\/1\//),expect.stringMatching(/^feed\/1\//)])
        expect(api.upload.mock.calls[0][1]).toBe(draft.profile.file)
        expect(api.upload.mock.calls[1][1]).toBe(feed)
        expect(api.upload.mock.calls.every(call=>call[2].upsert===false)).toBe(true)
        expect(writes()[0][1]).toMatchObject({p_character_id:1,p_expected:expected})
        expect(result.site.feed[0].id).toBe(21)
        expect(api.remove).toHaveBeenCalledWith(['feed/first.png','profile/old.png'])
        expect(result.cleanupWarning).toBeNull()
        expect(api.rpc.mock.calls.some(([name])=>name==='save_site'||name==='load_site')).toBe(false)
    })
    it('retains raw section content and existing IDs without mutating the draft or baseline',async()=>{
        const {saveCharacter}=await import('../src/services/save');const {draft,expected}=fixture()
        draft.sections.reverse();draft.feed.reverse();draft.sections[0].content='  *원문*\r\n| 표 |\n'
        const before=structuredClone(draft);const baseline=structuredClone(expected)
        await saveCharacter(1,draft,expected)
        expect(writes()[0][1].p_data.sections.map((r:{id:number})=>r.id)).toEqual([11,10])
        expect(writes()[0][1].p_data.sections[0].content).toBe(draft.sections[0].content)
        expect(draft).toEqual(before);expect(expected).toEqual(baseline)
        expect(api.upload).not.toHaveBeenCalled();expect(api.remove).not.toHaveBeenCalled()
    })
    it('rejects another target before any network or storage operation',async()=>{
        const {saveCharacter,deleteCharacter}=await import('../src/services/save');const {draft,expected}=fixture()
        await expect(saveCharacter(2,draft,expected)).rejects.toThrow('캐릭터')
        await expect(deleteCharacter(2,expected)).rejects.toThrow('캐릭터')
        expect(api.rpc).not.toHaveBeenCalled();expect(api.upload).not.toHaveBeenCalled()
    })
    it('reuses identical image paths after a committed response is lost',async()=>{
        const {saveCharacter,getPendingImageCleanupCount}=await import('../src/services/save');const {draft,expected}=fixture();draft.profile.file=png()
        let committed:SiteData
        api.write.mockImplementationOnce(async(_name:string,p:WritePayload)=>{committed=response(p);sites.set(1,committed);throw new TypeError('lost')})
            .mockImplementationOnce(async()=>({data:{character:committed,cleanup_candidates:['profile/old.png']},error:null}))
        await expect(saveCharacter(1,draft,expected)).rejects.toThrow('결과')
        expect(getPendingImageCleanupCount()).toBe(0);expect(api.remove).not.toHaveBeenCalled()
        await saveCharacter(1,draft,expected)
        expect(api.upload).toHaveBeenCalledTimes(1)
        expect(writes()[0][1]).toEqual(writes()[1][1])
    })
    it('treats malformed or wrong-target success as ambiguous and retains upload paths',async()=>{
        const {saveCharacter,getPendingImageCleanupCount}=await import('../src/services/save');const {draft,expected}=fixture();draft.profile.file=png()
        api.write.mockResolvedValueOnce({data:{character:{...expected,profile:{...expected.profile,id:2}},cleanup_candidates:[]},error:null})
        await expect(saveCharacter(1,draft,expected)).rejects.toThrow('결과')
        expect(getPendingImageCleanupCount()).toBe(0);expect(api.remove).not.toHaveBeenCalled()
    })
    it('cleans only this attempt uploads when a later upload fails and invalidates cleaned cache entries',async()=>{
        const {saveCharacter}=await import('../src/services/save');const {draft,expected}=fixture();draft.profile.file=png()
        draft.feed=[{id:'new',name:'b.png',file:png('b.png')}]
        api.upload.mockResolvedValueOnce({error:null}).mockRejectedValueOnce(new Error('upload failure'))
        await expect(saveCharacter(1,draft,expected)).rejects.toThrow('업로드 실패')
        expect(api.write).not.toHaveBeenCalled();expect(api.remove).toHaveBeenCalled()
        const first=api.upload.mock.calls[0][0]
        await saveCharacter(1,draft,expected)
        expect(api.upload.mock.calls[2][0]).not.toBe(first)
    })
    it('does not clean cached paths from an earlier ambiguous save during a later partial upload failure',async()=>{
        const {saveCharacter}=await import('../src/services/save');const {draft,expected}=fixture();draft.profile.file=png()
        api.write.mockRejectedValueOnce(new TypeError('unknown save'))
        await expect(saveCharacter(1,draft,expected)).rejects.toThrow()
        const uncertain=api.upload.mock.calls[0][0]
        draft.feed=[{id:'new',name:'b.png',file:png('b.png')}]
        api.upload.mockRejectedValueOnce(new Error('later upload failed'))
        await expect(saveCharacter(1,draft,expected)).rejects.toThrow()
        expect(api.remove.mock.calls.flatMap(([batch])=>batch)).not.toContain(uncertain)
    })
    it('rechecks synchronous auth before every upload and before RPC',async()=>{
        const {saveCharacter}=await import('../src/services/save');const {draft,expected}=fixture();draft.profile.file=png()
        let permitted=true;api.upload.mockImplementationOnce(async()=>{permitted=false;return{error:null}})
        await expect(saveCharacter(1,draft,expected,()=>permitted)).rejects.toThrow('로그인')
        expect(api.write).not.toHaveBeenCalled();expect(api.remove).not.toHaveBeenCalled()
    })
    it('validates every file before the first upload',async()=>{
        const {saveCharacter}=await import('../src/services/save');const {draft,expected}=fixture();draft.profile.file=png()
        draft.feed=[{id:'bad',name:'bad.gif',file:new File(['x'],'bad.gif',{type:'image/gif'})}]
        await expect(saveCharacter(1,draft,expected)).rejects.toThrow()
        expect(api.rpc).not.toHaveBeenCalled();expect(api.upload).not.toHaveBeenCalled()
    })
    it('blocks feed growth above the current grandfathered count',async()=>{
        const {saveCharacter}=await import('../src/services/save');const {draft,expected}=feedFixture(51)
        draft.feed.push({id:'new',name:'new.png',file:png()})
        await expect(saveCharacter(1,draft,expected)).rejects.toThrow('제한')
        expect(api.rpc).not.toHaveBeenCalled()
        draft.feed.pop();await saveCharacter(1,draft,expected);expect(writes()[0][1].p_data.feed).toHaveLength(51)
    })
    it.each(['character_conflict','character_not_found'])('cleans fresh uploads after %s without discarding the File or draft',async(reason)=>{
        const {saveCharacter}=await import('../src/services/save');const {draft,expected}=fixture();const file=png();draft.profile.file=file
        api.write.mockResolvedValueOnce({data:null,error:{code:'P0001',message:reason}})
        await expect(saveCharacter(1,draft,expected)).rejects.toThrow(reason==='character_conflict'?'다른 창':'존재하지')
        expect(draft.profile.file).toBe(file);expect(api.remove).toHaveBeenCalledWith([api.upload.mock.calls[0][0]])
        const firstPath=api.upload.mock.calls[0][0]
        await saveCharacter(1,draft,expected)
        expect(api.upload.mock.calls[1][0]).not.toBe(firstPath)
    })
    it('does not classify a cached ambiguous upload as unused after a later conflict',async()=>{
        const {saveCharacter,getPendingImageCleanupCount}=await import('../src/services/save');const {draft,expected}=fixture();draft.profile.file=png()
        api.write.mockRejectedValueOnce(new TypeError('lost'))
            .mockResolvedValueOnce({data:null,error:{code:'P0001',message:'character_conflict'}})
        await expect(saveCharacter(1,draft,expected)).rejects.toThrow('결과')
        await expect(saveCharacter(1,draft,expected)).rejects.toThrow('다른 창')
        expect(api.upload).toHaveBeenCalledTimes(1);expect(api.remove).not.toHaveBeenCalled();expect(getPendingImageCleanupCount()).toBe(0)
    })
})
describe('creation and deletion retries',()=>{
    it.each(['42501','22023','23514'])('keeps an uncertain creation payload across a later %s rejection',async(code)=>{
        const {createCharacter,createCharacterContext}=await import('../src/services/save');const draft=newDraft();const ctx=createCharacterContext();let original:SiteData
        draft.profile.file=png()
        api.write.mockImplementationOnce(async(_name:string,p:WritePayload)=>{original=response(p);throw new TypeError('lost')})
            .mockResolvedValueOnce({data:null,error:{code,message:code==='42501'?'character_admin_required':'invalid_character_data'}})
            .mockImplementationOnce(async()=>({data:{character:original,cleanup_candidates:[]},error:null}))
        await expect(createCharacter(draft,ctx)).rejects.toThrow()
        const pending=structuredClone(ctx.pendingPayload)
        draft.profile.name='새 로그인 후 수정'
        await expect(createCharacter(draft,ctx)).rejects.toThrow(code==='42501'?'권한':'올바르지')
        expect(ctx.pendingPayload).toEqual(pending)
        expect(api.remove).not.toHaveBeenCalled()
        const result=await createCharacter(draft,ctx)
        expect(result.site.profile.name).toBe('새 로그인 후 수정');expect(api.reserve).toHaveBeenCalledTimes(1)
        expect(api.upload).toHaveBeenCalledTimes(1)
        expect(writes('create_character').every(([,args])=>JSON.stringify(args.p_data)===JSON.stringify(pending))).toBe(true)
    })
    it('validates before reservation and creates the reserved character with null child IDs',async()=>{
        const {createCharacter,createCharacterContext}=await import('../src/services/save');const draft=newDraft();const ctx=createCharacterContext()
        const bad={...draft,profile:{...draft.profile,name:' '}}
        await expect(createCharacter(bad,ctx)).rejects.toThrow('이름');expect(api.rpc).not.toHaveBeenCalled()
        draft.profile.file=png();draft.sections[0].databaseId=999
        const result=await createCharacter(draft,ctx)
        expect(api.reserve).toHaveBeenCalledWith({p_request_id:ctx.requestId})
        expect(api.upload.mock.calls[0][0]).toMatch(/^profile\/2\//)
        expect(writes('create_character')[0][1].p_data.sections.every((row:{id:unknown})=>row.id===null)).toBe(true)
        expect(result.site.profile.id).toBe(2);expect(writes()).toHaveLength(0)
    })
    it('replays the immutable creation payload, then saves edits made after the lost response',async()=>{
        const {createCharacter,createCharacterContext}=await import('../src/services/save');const draft=newDraft();draft.profile.file=png();const ctx=createCharacterContext()
        let original:SiteData
        api.write.mockImplementationOnce(async(_name:string,p:WritePayload)=>{original=response(p);sites.set(2,original);throw new TypeError('lost')})
            .mockImplementationOnce(async()=>({data:{character:original,cleanup_candidates:[]},error:null}))
        await expect(createCharacter(draft,ctx)).rejects.toThrow('결과')
        const initialPayload=structuredClone(writes('create_character')[0][1])
        draft.profile.name='바뀐 이름';draft.sections.reverse()
        const result=await createCharacter(draft,ctx)
        expect(writes('create_character')[1][1]).toEqual(initialPayload)
        expect(api.reserve).toHaveBeenCalledTimes(1);expect(api.upload).toHaveBeenCalledTimes(1)
        expect(result.site.profile.name).toBe('바뀐 이름')
        expect(writes()[0][1].p_expected).toEqual(original!)
        expect(writes()[0][1].p_data.sections.map((row:{id:number})=>row.id)).toEqual(original!.sections.map(row=>row.id).reverse())
        const count=writes().length;await createCharacter(draft,ctx);expect(writes()).toHaveLength(count)
    })
    it('confirms a lost creation before validating a newly invalid local draft',async()=>{
        const {createCharacter,createCharacterContext}=await import('../src/services/save');const draft=newDraft();const ctx=createCharacterContext();let original:SiteData
        api.write.mockImplementationOnce(async(_name:string,p:WritePayload)=>{original=response(p);throw new TypeError('lost')})
            .mockImplementationOnce(async()=>({data:{character:original,cleanup_candidates:[]},error:null}))
        await expect(createCharacter(draft,ctx)).rejects.toThrow()
        draft.profile.name=' '
        await expect(createCharacter(draft,ctx)).rejects.toThrow('이름')
        expect(writes('create_character')).toHaveLength(2);expect(writes()).toHaveLength(0)
        expect(ctx.confirmedSite?.profile.id).toBe(2);expect(draft.profile.name).toBe(' ')
    })
    it('permits corrected input after a definite transaction rejection while retaining the reservation',async()=>{
        const {createCharacter,createCharacterContext}=await import('../src/services/save');const draft=newDraft();const ctx=createCharacterContext()
        api.write.mockResolvedValueOnce({data:null,error:{code:'22023',message:'invalid_character_data'}})
        await expect(createCharacter(draft,ctx)).rejects.toThrow('올바르지')
        draft.profile.name='고친 이름';const result=await createCharacter(draft,ctx)
        expect(result.site.profile.name).toBe('고친 이름');expect(api.reserve).toHaveBeenCalledTimes(1)
    })
    it.each(['22023','23514'])('journals rejected creation uploads and invalidates their cache after %s',async(code)=>{
        const {createCharacter,createCharacterContext,getPendingImageCleanupCount}=await import('../src/services/save');const draft=newDraft();const ctx=createCharacterContext()
        const profile=png('rejected-profile.png');draft.profile.file=profile;draft.feed=[{id:'new',name:'rejected-feed.png',file:png('rejected-feed.png')}]
        api.write.mockResolvedValueOnce({data:null,error:{code,message:'invalid_character_data'}})
        api.remove.mockResolvedValueOnce({data:null,error:{message:'offline'}})
        await expect(createCharacter(draft,ctx)).rejects.toThrow('올바르지')
        const rejectedPaths=api.upload.mock.calls.map(([path])=>path)
        expect(ctx.pendingPayload).toBeNull();expect(getPendingImageCleanupCount()).toBe(2)
        expect(api.remove).toHaveBeenCalledWith(rejectedPaths)
        draft.profile.file=code==='22023'?png('replacement.png'):profile;draft.feed=[]
        const result=await createCharacter(draft,ctx)
        expect(api.reserve).toHaveBeenCalledTimes(1);expect(api.upload).toHaveBeenCalledTimes(3)
        expect(rejectedPaths).not.toContain(result.site.profile.profile_image_path)
        expect(result.site.feed).toEqual([]);expect(getPendingImageCleanupCount()).toBe(0)
        expect(api.remove.mock.calls[1][0]).toEqual(rejectedPaths)
    })
    it('keeps changed creation draft when the subsequent CAS detects an intervening edit',async()=>{
        const {createCharacter,createCharacterContext}=await import('../src/services/save');const draft=newDraft();const ctx=createCharacterContext();let original:SiteData
        api.write.mockImplementationOnce(async(_name:string,p:WritePayload)=>{original=response(p);throw new TypeError('lost')})
            .mockImplementationOnce(async()=>({data:{character:original,cleanup_candidates:[]},error:null}))
            .mockResolvedValueOnce({data:null,error:{code:'P0001',message:'character_conflict'}})
        await expect(createCharacter(draft,ctx)).rejects.toThrow();draft.profile.name='보존할 수정'
        await expect(createCharacter(draft,ctx)).rejects.toThrow('다른 창')
        expect(draft.profile.name).toBe('보존할 수정');expect(ctx.confirmedSite?.profile.id).toBe(2)
    })
    it('retains deletion baseline after response loss and cleans only the confirmed receipt paths',async()=>{
        const {deleteCharacter,getPendingImageCleanupCount}=await import('../src/services/save');const {expected}=fixture()
        api.write.mockRejectedValueOnce(new TypeError('delete response lost'))
        await expect(deleteCharacter(1,expected)).rejects.toThrow('결과')
        expect(getPendingImageCleanupCount()).toBe(0);expect(api.remove).not.toHaveBeenCalled()
        const result=await deleteCharacter(1,expected)
        expect(writes('delete_character')[0][1]).toEqual(writes('delete_character')[1][1])
        expect(result.cleanupWarning).toBeNull();expect(api.remove).toHaveBeenCalled()
    })
    it('returns confirmed deletion with a cleanup warning instead of treating it as a failed delete',async()=>{
        const {deleteCharacter,getPendingImageCleanupCount}=await import('../src/services/save');api.remove.mockResolvedValue({data:null,error:{message:'offline'}})
        const result=await deleteCharacter(1,fixture().expected)
        expect(result.cleanupWarning).toContain('삭제됐지만');expect(getPendingImageCleanupCount()).toBe(3)
    })
    it('rejects malformed deletion envelopes without queuing unrelated cleanup paths',async()=>{
        const {deleteCharacter,getPendingImageCleanupCount}=await import('../src/services/save')
        api.write.mockResolvedValueOnce({data:{character_id:1,cleanup_candidates:['feed/unrelated.png']},error:null})
        await expect(deleteCharacter(1,fixture().expected)).rejects.toThrow('결과')
        expect(getPendingImageCleanupCount()).toBe(0);expect(api.remove).not.toHaveBeenCalled()
    })
})

describe('global cleanup and scoped upload cache',()=>{
    it('stops before deleting if auth ends during global reference lookup',async()=>{
        const {queueImageCleanup,retryImageCleanup,getPendingImageCleanupCount}=await import('../src/services/storage')
        let permitted=true;queueImageCleanup(['feed/old.png'])
        api.refs.mockImplementationOnce(async()=>{permitted=false;return{data:[],error:null}})
        expect(await retryImageCleanup(()=>permitted)).toBe(false)
        expect(api.remove).not.toHaveBeenCalled();expect(getPendingImageCleanupCount()).toBe(1)
    })
    it('retains only failed batches for a later cleanup retry',async()=>{
        const {queueImageCleanup,retryImageCleanup,getPendingImageCleanupCount}=await import('../src/services/storage')
        queueImageCleanup(Array.from({length:101},(_,i)=>`feed/${i}.png`))
        api.remove.mockResolvedValueOnce({data:null,error:{message:'temporary'}})
        expect(await retryImageCleanup()).toBe(false);expect(getPendingImageCleanupCount()).toBe(100)
        expect(await retryImageCleanup()).toBe(true)
    })
    it('keeps cleanup records when empty-delete existence verification fails',async()=>{
        const {queueImageCleanup,retryImageCleanup,getPendingImageCleanupCount}=await import('../src/services/storage')
        queueImageCleanup(['feed/old.png']);api.remove.mockResolvedValueOnce({data:[],error:null});api.list.mockRejectedValueOnce(new Error('offline'))
        expect(await retryImageCleanup()).toBe(false);expect(getPendingImageCleanupCount()).toBe(1)
    })
    it('protects every character reference and revalidates recovered legacy records',async()=>{
        const {queueImageCleanup,retryImageCleanup,getPendingImageCleanupCount}=await import('../src/services/storage')
        api.refs.mockResolvedValue({data:['feed/other-character.png','profile/old.png'],error:null})
        queueImageCleanup(['feed/other-character.png','profile/old.png','feed/unreferenced.png'])
        expect(await retryImageCleanup()).toBe(true)
        expect(api.remove).toHaveBeenCalledWith(['feed/unreferenced.png']);expect(getPendingImageCleanupCount()).toBe(0)
        expect(api.rpc.mock.calls.some(([name])=>name==='load_site')).toBe(false)
    })
    it('keeps every candidate if global references are unavailable or malformed',async()=>{
        const {queueImageCleanup,retryImageCleanup,getPendingImageCleanupCount}=await import('../src/services/storage')
        queueImageCleanup(['feed/old.png']);api.refs.mockResolvedValueOnce({data:['other/invalid.png'],error:null})
        expect(await retryImageCleanup()).toBe(false);expect(api.remove).not.toHaveBeenCalled()
        api.refs.mockRejectedValueOnce(new Error('offline'));expect(await retryImageCleanup()).toBe(false)
        expect(getPendingImageCleanupCount()).toBe(1)
    })
    it('does not mistake an RLS-filtered empty deletion response for deletion',async()=>{
        const {queueImageCleanup,retryImageCleanup,getPendingImageCleanupCount}=await import('../src/services/storage')
        queueImageCleanup(['feed/old.png']);api.remove.mockResolvedValue({data:[],error:null})
        api.list.mockResolvedValueOnce({data:[{name:'old.png'}],error:null})
        expect(await retryImageCleanup()).toBe(false);expect(getPendingImageCleanupCount()).toBe(1)
        api.list.mockResolvedValueOnce({data:[],error:null})
        expect(await retryImageCleanup()).toBe(true)
    })
    it('batches confirmed deletes and deduplicates concurrent retries',async()=>{
        const {queueImageCleanup,retryImageCleanup}=await import('../src/services/storage')
        queueImageCleanup(Array.from({length:205},(_,i)=>`feed/${i}.png`))
        const [a,b]=await Promise.all([retryImageCleanup(),retryImageCleanup()])
        expect(a&&b).toBe(true);expect(api.refs).toHaveBeenCalledTimes(1)
        expect(api.remove.mock.calls.map(([batch])=>batch.length)).toEqual([100,100,5])
    })
    it('recovers persisted cleanup candidates without triggering deletion at import',async()=>{
        const first=await import('../src/services/storage');first.queueImageCleanup(['feed/legacy.png'])
        vi.resetModules();const second=await import('../src/services/storage')
        expect(second.getPendingImageCleanupCount()).toBe(1);expect(api.remove).not.toHaveBeenCalled()
        expect(await second.retryImageCleanup()).toBe(true)
    })
    it('scopes cached immutable paths by File, folder and character ID',async()=>{
        const {uploadImage}=await import('../src/services/storage');const file=png()
        const a=await uploadImage(file,'profile',1),b=await uploadImage(file,'profile',2),c=await uploadImage(file,'feed',1)
        expect(new Set([a.path,b.path,c.path]).size).toBe(3)
        expect(await uploadImage(file,'profile',1)).toEqual({path:a.path,newlyUploaded:false})
        expect(api.upload).toHaveBeenCalledTimes(3)
    })
    it('retains path ownership in new cleanup records without assigning it to legacy records',async()=>{
        const {queueImageCleanup}=await import('../src/services/storage');queueImageCleanup(['feed/2/new.png'],2)
        const storage=window.localStorage
        const records=Array.from({length:storage.length},(_,i)=>JSON.parse(storage.getItem(storage.key(i)!)!))
        expect(records).toContainEqual(expect.objectContaining({path:'feed/2/new.png',characterId:2}))
    })
})

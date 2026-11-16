import { lazy, Suspense, useEffect, useRef } from 'react'
import SiteImage from '../components/SiteImage'
import SiteLink from '../components/SiteLink'
import ThemeEditor from '../components/ThemeEditor'
import EditorAuthNotice from '../components/EditorAuthNotice'
import type { AuthNotice } from '../components/EditorAuthNotice'
import { useMainEditor } from '../hooks/useMainEditor'
import type { LeaveGuard } from '../hooks/useGuardedNavigation'
import { getImageUrl } from '../services/storage'
import { applyTheme, toThemeData } from '../utils/theme'
import type { CharacterSummary } from '../types/site'
import type { SortLock } from '../utils/sortLock'
import { characterPath } from '../utils/routes'
import { hexColorMessage, isHexColor } from '../utils/validation'

interface CharacterItem {
    id: string
    character: CharacterSummary
}

const SortableCharacters = lazy(() => import('../components/SortableList').then(module => ({ default: module.default<CharacterItem> })))

interface MainPageProps {
    isAdmin: boolean
    signingOut: boolean
    navigate: (path: string) => void
    workLock: SortLock
    sortLock: SortLock
    canWrite: () => boolean
    onLeaveGuardChange: (guard: LeaveGuard) => void
    authNotice: AuthNotice | null
    onRetryAuth: () => void
    onReauthenticate: () => void
}

function CharacterCard({ character, navigate, blocked }: { character: CharacterSummary, navigate: (path: string) => void, blocked: boolean }) {
    return (
        <SiteLink className="character card flex pdLg gapMd" href={characterPath(character.id)} navigate={navigate}
            aria-disabled={blocked || undefined} tabIndex={blocked ? -1 : undefined} onClick={event => { if (blocked) event.preventDefault() }}>
            <SiteImage className="profileImg" src={getImageUrl(character.profile_image_path)} alt={`${character.name} 프로필 이미지`} fallbackText={character.profile_image_path ? undefined : '이미지 없음'} />
            <div className="flexColumn gapSm">
                <p className="text1 bold">{character.name}</p>
                <p className="text3">{character.status_message}</p>
            </div>
        </SiteLink>
    )
}

export default function MainPage({ isAdmin, signingOut, navigate, workLock, sortLock, canWrite, onLeaveGuardChange, authNotice, onRetryAuth, onReauthenticate }: MainPageProps) {
    const form = useRef<HTMLFormElement>(null)
    const {
        query: state, characters, savedTheme, theme, dirty, orderDirty, themeDirty, orderFeedback, themeFeedback,
        saving, busy, sorting, disabled, canStart, changeOrder, changeTheme, saveOrder, saveTheme, reload,
    } = useMainEditor({ isAdmin, signingOut, workLock, sortLock, canWrite, onLeaveGuardChange })

    useEffect(() => {
        const previous = document.title
        document.title = '캐릭터 모음'
        return () => { document.title = previous }
    }, [])
    useEffect(() => {
        if (!savedTheme) return
        return applyTheme(isAdmin && theme && Object.values(theme).every(isHexColor)
            ? { id: 1, ...toThemeData(theme) } : savedTheme)
    }, [savedTheme, isAdmin, theme])

    const cardBlocked = busy || sorting || signingOut

    return (
        <main className="flexColumn gapLg" aria-busy={state.status === 'loading' || busy}>
            <EditorAuthNotice notice={dirty ? authNotice : null} disabled={busy || sorting || signingOut} onRetry={onRetryAuth} onLogin={onReauthenticate} />
            {state.status === 'loading' && <p className="card pdLg text3" role="status">불러오는 중…</p>}
            {state.status === 'error' && (
                <div className="card pdLg flexColumn gapMd">
                    <p className="text3" role="alert">{state.message}</p>
                    <button className="btn h30 border borderRad" type="button" onClick={reload}>다시 시도</button>
                </div>
            )}
            {isAdmin ? (
                <Suspense fallback={characters.map(character => <CharacterCard key={character.id} character={character} navigate={navigate} blocked={cardBlocked} />)}>
                    <SortableCharacters items={characters.map(character => ({ id: String(character.id), character }))}
                        label="캐릭터 순서" className="flexColumn gapLg" listId="main-characters" sortLock={sortLock}
                        disabled={signingOut || busy} canActivate={canStart} getLabel={item => item.character.name}
                        onChange={items => changeOrder(items.map(item => item.character.id))}>
                        {(item, handleProps) => (
                            <div className="flexColumn gapSm">
                                <CharacterCard character={item.character} navigate={navigate} blocked={cardBlocked} />
                                <button {...handleProps} className="btn dragHandle h30 widthFull border borderRad pdSide"><span aria-hidden="true">↕</span> 순서 이동</button>
                            </div>
                        )}
                    </SortableCharacters>
                </Suspense>
            ) : characters.map(character => <CharacterCard key={character.id} character={character} navigate={navigate} blocked={cardBlocked} />)}
            {state.status === 'ready' && characters.length === 0 && <p className="card pdLg text3">등록된 캐릭터가 없습니다.</p>}
            {isAdmin && (
                <>
                    <p className="text3">드래그 앤 드롭으로 순서 변경</p>
                    {orderDirty && <p className="text3" role="status">저장하지 않은 순서 변경이 있습니다.</p>}
                    <button className="btn h30 border borderRad widthFull" type="button" disabled={disabled || !orderDirty} onClick={() => void saveOrder()}>
                        {saving === 'order' ? '순서 저장 중…' : '순서 저장'}
                    </button>
                    {orderFeedback.saved && <p role="status">순서 저장 완료</p>}
                    {orderFeedback.error && <p className="card pdLg text3" role="alert">{orderFeedback.error}</p>}
                    <SiteLink className="btn h30 border borderRad widthFull flex alignCenter justifyCenter" href="/characters/new" navigate={navigate}
                        aria-disabled={disabled || state.status !== 'ready'} tabIndex={disabled || state.status !== 'ready' ? -1 : undefined}
                        onClick={event => { if (state.status !== 'ready' || !canStart()) event.preventDefault() }}>캐릭터 추가</SiteLink>
                    {state.status === 'ready' && theme && (
                        <form ref={form} noValidate onSubmit={event => {
                            event.preventDefault()
                            if (!canStart() || !form.current) return
                            for (const field of form.current.querySelectorAll<HTMLInputElement>('input[data-theme]')) field.setCustomValidity(hexColorMessage(field.value))
                            if (form.current.reportValidity()) void saveTheme()
                        }}>
                            <fieldset className="editorFields flexColumn gapSm" disabled={disabled}>
                                <ThemeEditor title="메인 테마" value={theme} onChange={changeTheme}>
                                    {themeDirty && <p className="text3 widthFull" role="status">저장하지 않은 테마 변경이 있습니다.</p>}
                                    <button className="btn h30 border borderRad widthFull" type="submit" disabled={!themeDirty}>
                                        {saving === 'theme' ? '테마 저장 중…' : '테마 저장'}
                                    </button>
                                </ThemeEditor>
                            </fieldset>
                        </form>
                    )}
                    {themeFeedback.saved && <p role="status">테마 저장 완료</p>}
                    {themeFeedback.error && <p className="card pdLg text3" role="alert">{themeFeedback.error}</p>}
                </>
            )}
            {(dirty || orderFeedback.error || themeFeedback.error) && (
                <button className="btn border borderRad pdSm" type="button" disabled={busy || sorting || signingOut} onClick={reload}>편집 내용을 버리고 DB에서 다시 불러오기</button>
            )}
        </main>
    )
}

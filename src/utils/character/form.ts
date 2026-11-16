import type { Draft } from '../../types/models'
import type { DraftIssue } from './draft'
import { validateDraft } from './draft'
import { themeFields } from '../theme'

function validationField(form: HTMLFormElement, issue: DraftIssue): HTMLInputElement | HTMLTextAreaElement | null {
    switch (issue.field) {
        case 'profile.name': return form.querySelector('#profileName')
        case 'profile.statusMessage': return form.querySelector('#profileMessage')
        case 'keywords': return form.querySelector('#keywords')
        case 'theme': {
            const variable = themeFields.find(field => field.key === issue.key)?.variable
            return variable ? form.querySelector(`[data-theme="${variable}"]`) : null
        }
        case 'section': return form.querySelectorAll('[data-section]')[issue.index]?.querySelector(issue.key === 'title' ? 'input' : 'textarea') ?? null
        case 'feed': return null
    }
}

export function validateForm(form: HTMLFormElement, draft: Draft, savedFeedCount: number, onError: (message: string) => void): boolean {
    for (const field of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input:not([type="file"]), textarea')) field.setCustomValidity('')
    const issues = validateDraft(draft, savedFeedCount)
    for (const issue of issues) validationField(form, issue)?.setCustomValidity(issue.message)
    if (!issues.length) return true
    const field = validationField(form, issues[0])
    if (field) field.reportValidity()
    else onError(issues[0].message)
    return false
}

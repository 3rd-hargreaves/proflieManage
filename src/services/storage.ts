import { supabase } from '../lib/supabase'

const imageBucket = import.meta.env.VITE_SUPABASE_STORAGE_BUCKET?.trim() || 'site-images'

export function getImageUrl(path: string | null): string | undefined {
  if (!path || !supabase) return undefined
  return supabase.storage.from(imageBucket).getPublicUrl(path).data.publicUrl
}

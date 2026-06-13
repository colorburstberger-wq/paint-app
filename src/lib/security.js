export function escapeHtml(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function getAuthRedirectUrl(origin) {
  const base = origin || (typeof window !== 'undefined' ? window.location.origin : '');
  if (!base) return undefined;
  return String(base).replace(/\/$/, '');
}

export function isValidSupabaseUrl(value = '') {
  const url = String(value || '').trim();
  return /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url);
}

export function isValidSupabasePublicKey(value = '') {
  const key = String(value || '').trim();
  return key.startsWith('sb_publishable_') || key.startsWith('eyJ');
}

export function assertValidSupabaseSettings(settings = {}) {
  const url = String(settings.supabaseUrl || '').trim();
  const anonKey = String(settings.supabaseAnonKey || '').trim();
  if (!isValidSupabaseUrl(url)) throw new Error('Enter a valid Supabase Project URL ending in .supabase.co');
  if (!isValidSupabasePublicKey(anonKey)) throw new Error('Enter a valid Supabase publishable/anon public key. Do not use secret/service role keys.');
  return { url, anonKey };
}

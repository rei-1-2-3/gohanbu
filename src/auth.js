import { supabase } from './lib/supabaseClient.js';

const AGREED_AT_KEY = 'gohanbu_agreed_at';

// Supabaseは「メール確認」設定がONの場合、既に登録済み(確認済み)のメールアドレスへの
// signUpをメール列挙対策のため成功扱いで返す(data.user.identitiesが空配列になる)。
// 設定がOFFの場合はエラー(message例:"User already registered")で返る。両方を重複登録として検知する。
export class DuplicateEmailError extends Error {}

export async function signUp(email, password) {
  const agreedAt = new Date().toISOString();
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) {
    if (/already registered|already exists|already been registered/i.test(error.message)) {
      throw new DuplicateEmailError(error.message);
    }
    throw error;
  }
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    throw new DuplicateEmailError('duplicate email (obfuscated by Supabase)');
  }
  // 18歳同意は登録画面でのみ確認する(SPEC.md 6章・7章)。
  // profilesへの記録はプロフィール登録画面で行うため、同意日時を一時的に保持しておく
  localStorage.setItem(AGREED_AT_KEY, agreedAt);
  return data;
}

export function takeAgreedAt() {
  const v = localStorage.getItem(AGREED_AT_KEY);
  return v || new Date().toISOString();
}

export function clearAgreedAt() {
  localStorage.removeItem(AGREED_AT_KEY);
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function resetPassword(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + import.meta.env.BASE_URL,
  });
  if (error) throw error;
}

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export function onAuthStateChange(cb) {
  return supabase.auth.onAuthStateChange((_event, session) => cb(session));
}

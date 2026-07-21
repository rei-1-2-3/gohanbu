import { supabase } from './lib/supabaseClient.js';

export class DuplicateNicknameError extends Error {}

function throwIfDuplicateNickname(error) {
  if (error && error.code === '23505' && /profiles_nickname_key/.test(error.message || '')) {
    throw new DuplicateNicknameError(error.message);
  }
  if (error) throw error;
}

export async function getMyProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function createProfile(profile) {
  const { data, error } = await supabase
    .from('profiles')
    .insert(profile)
    .select()
    .single();
  if (error) throwIfDuplicateNickname(error);
  return data;
}

export async function updateProfile(userId, updates) {
  const { data, error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('id', userId)
    .select()
    .single();
  if (error) throwIfDuplicateNickname(error);
  return data;
}

// 退会(本人のauth.usersごと完全削除。profiles/recruitments/applications等は
// on delete cascadeで連鎖的に削除される。supabase/migrations/20260720000005参照)
export async function withdrawAccount() {
  const { error } = await supabase.rpc('withdraw_account');
  if (error) throw error;
}

export async function listRecruitments() {
  const { data, error } = await supabase
    .from('recruitments')
    .select('*, host:profiles!recruitments_host_id_fkey(nickname, age_band)')
    .neq('status', 'cancelled')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

// マイページ: 自分が主催する募集(取消済みも含めて全件、履歴として表示)
export async function listMyRecruitments(hostId) {
  const { data, error } = await supabase
    .from('recruitments')
    .select('*')
    .eq('host_id', hostId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

// マイページ: 自分が参加予定・応募中(pending/approved)の募集
export async function listMyApplications(applicantId) {
  const { data, error } = await supabase
    .from('applications')
    .select('*, recruitment:recruitments(id, title, status, event_at)')
    .eq('applicant_id', applicantId)
    .in('status', ['pending', 'approved'])
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function getRecruitment(id) {
  const { data, error } = await supabase
    .from('recruitments')
    .select('*, host:profiles!recruitments_host_id_fkey(nickname, age_band)')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function createRecruitment(recruitment) {
  const { data, error } = await supabase
    .from('recruitments')
    .insert(recruitment)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// 主催者による募集の取り消し(承認済み参加者がいない場合のみ。DBトリガーでも二重に担保)。
// 物理削除ではなくstatus='cancelled'への更新とし、マイページの履歴に残す
export async function cancelRecruitment(id) {
  const { error } = await supabase.from('recruitments').update({ status: 'cancelled' }).eq('id', id);
  if (error) throw error;
}

// ===== 参加表明・承認(最小限、Phase 2で公開コメント等を拡張予定) =====

export async function listApplications(recruitmentId) {
  const { data, error } = await supabase
    .from('applications')
    .select('*, applicant:profiles!applications_applicant_id_fkey(nickname, age_band, alcohol, tobacco, payment, intro)')
    .eq('recruitment_id', recruitmentId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

export async function getMyApplication(recruitmentId, userId) {
  const { data, error } = await supabase
    .from('applications')
    .select('*')
    .eq('recruitment_id', recruitmentId)
    .eq('applicant_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function applyToRecruitment(recruitmentId, applicantId) {
  const { error } = await supabase
    .from('applications')
    .insert({ recruitment_id: recruitmentId, applicant_id: applicantId });
  if (error) throw error;
}

export async function approveApplication(id) {
  const { error } = await supabase.from('applications').update({ status: 'approved' }).eq('id', id);
  if (error) throw error;
}

export async function declineApplication(id) {
  const { error } = await supabase.from('applications').update({ status: 'declined' }).eq('id', id);
  if (error) throw error;
}

// 応募者による参加の取り消し(承認前後どちらでも可)。物理削除ではなくstatus='cancelled'への
// 更新とし、主催者のマイページで内容を確認できるようにする(退会時のみ従来どおり物理削除される)
export async function cancelApplication(id) {
  const { error } = await supabase.from('applications').update({ status: 'cancelled' }).eq('id', id);
  if (error) throw error;
}

// DM送信(応募者⇔主催者のみ閲覧可。取り消し時の一言コメントを主催者にだけ届ける用途)
export async function sendDm({ recruitmentId, senderId, applicantId, body }) {
  const { error } = await supabase.from('dms').insert({
    recruitment_id: recruitmentId, sender_id: senderId, applicant_id: applicantId, body,
  });
  if (error) throw error;
}

// マイページ(主催者向け): 自分の募集群にまたがる応募・コメントをまとめて取得
export async function listApplicationsForHost(recruitmentIds) {
  if (!recruitmentIds.length) return [];
  const { data, error } = await supabase
    .from('applications')
    .select('*, applicant:profiles!applications_applicant_id_fkey(nickname)')
    .in('recruitment_id', recruitmentIds)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}
export async function listCommentsForHost(recruitmentIds) {
  if (!recruitmentIds.length) return [];
  const { data, error } = await supabase
    .from('comments')
    .select('*, author:profiles!comments_author_id_fkey(nickname)')
    .in('recruitment_id', recruitmentIds)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

// ===== 運営者向け管理画面(is_admin限定。RLSでも保護。閲覧専用) =====
export async function adminListRecruitments() {
  const { data, error } = await supabase
    .from('recruitments')
    .select('*, host:profiles!recruitments_host_id_fkey(nickname)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}
export async function adminListApplications() {
  const { data, error } = await supabase
    .from('applications')
    .select('*, applicant:profiles!applications_applicant_id_fkey(nickname), recruitment:recruitments(title, host_id, host:profiles!recruitments_host_id_fkey(nickname))')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}
export async function adminListReports() {
  const { data, error } = await supabase
    .from('reports')
    .select('*, reporter:profiles!reports_reporter_id_fkey(nickname)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}
export async function adminListComments() {
  const { data, error } = await supabase
    .from('comments')
    .select('*, author:profiles!comments_author_id_fkey(nickname), recruitment:recruitments(title)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

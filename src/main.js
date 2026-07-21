import './style.css';
import { supabase } from './lib/supabaseClient.js';
import { signUp, signIn, signOut, resetPassword, getSession, onAuthStateChange, takeAgreedAt, clearAgreedAt, DuplicateEmailError } from './auth.js';
import {
  getMyProfile, getProfile, createProfile, updateProfile, DuplicateNicknameError,
  listRecruitments, getRecruitment, createRecruitment, updateRecruitment, cancelRecruitment,
  listMyRecruitments, listMyApplications, listApplicationsForHost, listCommentsForHost,
  listApplications, getMyApplication, applyToRecruitment, approveApplication, declineApplication, cancelApplication,
  sendDm, withdrawAccount,
  adminListRecruitments, adminListApplications, adminListReports, adminListComments,
} from './api.js';
import { AREAS, GENRES, BUDGETS, PREF, ICON, AGE_BANDS, capacityLabel } from './constants.js';

// ===== 状態 =====
let session = null;
let myProfile = null;
let allRecruitments = [];
let currentDetailId = null;
let editingRecruitmentId = null;

const NG_PATTERN = /[0-9]{6,}|@|line|instagram|http|tiktok|x\.com|twitter/i;
function hasNgWord(t) { return NG_PATTERN.test(t || ''); }

// ===== 開催日(event_date)の経過判定 =====
// event_dateが無い(旧データ)場合は自動終了の対象外とし、従来どおりstatusのみで判定する。
// DB側(RLS)でも同じ基準(JSTの当日まで参加表明可)でapplications insertを拒否するため、
// ここはあくまで表示用の判定(締め切り自体はDB側が最終的に担保する)
function todayJST() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}
function isExpired(r) {
  return r.status === 'open' && !!r.event_date && r.event_date < todayJST();
}
function effectiveStatus(r) {
  return isExpired(r) ? 'expired' : r.status;
}
function formatEventDate(d) {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00+09:00');
  const w = ['日', '月', '火', '水', '木', '金', '土'][dt.getDay()];
  return `${dt.getMonth() + 1}/${dt.getDate()}(${w})`;
}
function eventLabel(r) {
  const dateStr = formatEventDate(r.event_date);
  if (dateStr && r.event_at) return `${dateStr} ${r.event_at}`;
  return dateStr || r.event_at || '';
}

// ===== ページ切替 =====
const pages = document.querySelectorAll('.page');
const navBtns = document.querySelectorAll('nav.kg button');
const authRequiredPages = new Set(['create', 'profile']);

function clearMessages() {
  document.querySelectorAll('.form-msg').forEach(el => { el.textContent = ''; el.className = 'form-msg'; });
}
function go(id) {
  if (authRequiredPages.has(id) && !session) {
    alert('ログインが必要です。先にログイン/新規登録をお済ませください。');
    id = 'auth';
  }
  // 管理画面はフロントの導線を隠すだけでなく、直接呼び出されても弾く
  // (実際のアクセス制御はRLS/is_admin列権限がDB側で担保する)
  if (id === 'admin' && !(myProfile && myProfile.is_admin)) {
    alert('管理画面へのアクセス権がありません。');
    id = 'top';
  }
  clearMessages();
  pages.forEach(p => p.classList.toggle('on', p.id === 'page-' + id));
  const navId = (id === 'detail') ? 'list' : id;
  navBtns.forEach(b => b.classList.toggle('on', b.dataset.page === navId));
  document.querySelector('.kg-app').classList.toggle('graybg', id === 'list');
  window.scrollTo({ top: 0, behavior: 'auto' });
  if (id === 'list') renderList();
  if (id === 'profile') loadProfileForm();
  if (id === 'admin') renderAdminPage();
  if (id === 'auth') initAuthForm();
}
navBtns.forEach(b => b.addEventListener('click', () => {
  if (b.dataset.page === 'create') resetCreateForm();
  go(b.dataset.page);
}));
document.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', e => { e.preventDefault(); go(el.dataset.go); }));

// ===== チップ生成(募集作成・プロフィール) =====
function chips(el, items, type, name) {
  el.innerHTML = items.map(v => `<label class="chip"><input type="${type}"${name ? ` name="${name}"` : ''} value="${v}"><span>${v}</span></label>`).join('');
}
chips(document.getElementById('c-area'), AREAS, 'radio', 'carea');
chips(document.getElementById('c-genre'), GENRES, 'radio', 'cgenre');
chips(document.getElementById('p-genre'), GENRES, 'checkbox');
chips(document.getElementById('p-area'), AREAS, 'checkbox');

// ===== 募集一覧: 絞り込みタグ =====
const fsort = document.getElementById('f-sort');
const SLOTS = [
  { k: 'size', v: null, def: '1', name: '2人で行く' },
  { k: 'budget', v: null, def: '〜3,000円', name: '〜3,000円' },
  { k: 'genre', v: null, def: 'カフェ・喫茶', name: 'カフェ・喫茶' },
  { k: 'area', v: null, def: '梅田', name: '梅田' },
];
const OPTS = {
  size: [{ v: '1', t: '2人で行く(あと1名)' }, { v: '2+', t: '3人以上で行く' }],
  budget: BUDGETS.map(x => ({ v: x, t: x })),
  genre: GENRES.map(x => ({ v: x, t: x })),
  area: AREAS.map(x => ({ v: x, t: x })),
};
const dispV = v => v === '1' ? '2人で行く' : v === '2+' ? '3人以上' : v;
function clearF() { SLOTS.forEach(s => s.v = null); }
let popEl = null, ovEl = null;
function closePicker() { if (popEl) { popEl.remove(); ovEl.remove(); popEl = ovEl = null; } }
function openPicker(slot, anchor) {
  closePicker();
  const cur = slot.v || slot.def;
  ovEl = document.createElement('div'); ovEl.className = 'pop-ov'; ovEl.onclick = closePicker;
  popEl = document.createElement('div'); popEl.className = 'pop';
  popEl.innerHTML = [{ v: '', t: '指定なし(解除)' }].concat(OPTS[slot.k])
    .map(o => `<button class="${o.v === cur ? 'sel' : ''}" data-v="${o.v}"><span class="r"></span>${o.t}</button>`).join('');
  popEl.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    slot.v = b.dataset.v || null;
    closePicker(); renderListBody();
  });
  document.body.appendChild(ovEl); document.body.appendChild(popEl);
  const r = anchor.getBoundingClientRect();
  let top = r.bottom + 6;
  if (top + popEl.offsetHeight > innerHeight - 10) top = Math.max(10, innerHeight - popEl.offsetHeight - 10);
  let left = r.left;
  if (left + popEl.offsetWidth > innerWidth - 10) left = innerWidth - popEl.offsetWidth - 10;
  popEl.style.top = top + 'px'; popEl.style.left = Math.max(10, left) + 'px';
}
const qwrap = document.getElementById('qchips');
function renderTags() {
  const none = SLOTS.every(s => !s.v);
  qwrap.innerHTML = `<button class="qchip${none ? ' on' : ''}" data-all="1">すべて</button>` +
    SLOTS.map((s, i) => `<button class="qchip${s.v ? ' on' : ''}" data-i="${i}">${s.v ? dispV(s.v) : s.name} ▾</button>`).join('');
}
qwrap.addEventListener('click', e => {
  const c = e.target.closest('.qchip'); if (!c) return;
  if (c.dataset.all) { clearF(); closePicker(); renderListBody(); return; }
  openPicker(SLOTS[+c.dataset.i], c);
});
fsort.addEventListener('change', renderListBody);

// ===== 募集カード =====
function hostDisplayName(r) {
  // profilesはログインユーザーのみselect可(SPEC.md 5章)のため、未ログイン時はjoinがRLSで隠される。
  // 「ユーザーが存在しない」わけではないので誤解を招く表示にしない
  if (r.host?.nickname) return r.host.nickname;
  return session ? '(削除されたユーザー)' : '主催者(ログインで表示)';
}
function cardHTML(r) {
  const hostName = hostDisplayName(r);
  const st = effectiveStatus(r);
  const closed = st !== 'open';
  return `<article class="bosyu">
    <div class="thumb" aria-hidden="true"><svg><use href="#${ICON[r.genre] || 'i-izakaya'}"/></svg></div>
    <div class="date"><b>${escapeHtml(eventLabel(r))}</b></div>
    <div class="body"><h3 data-open="${r.id}">${escapeHtml(r.title)}</h3>
      <div class="tags">
        <span class="tag ai">${escapeHtml(r.area)}</span>
        <span class="tag">${escapeHtml(r.genre)}</span>
        ${closed ? `<span class="tag closed">${st === 'expired' ? '募集終了(開催済み)' : '募集終了'}</span>` : `<span class="tag gold">${capacityLabel(r.capacity)}</span>`}
        <span class="tag">${escapeHtml(r.who)}</span>
        <span class="tag">${escapeHtml(r.budget)}</span>
        <span class="tag">${escapeHtml(hostName)}</span>
      </div></div>
    <div class="join"><button class="btn btn-ai" data-open="${r.id}">詳細を見る</button></div>
  </article>`;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
document.addEventListener('click', e => {
  const t = e.target.closest('[data-open]');
  if (t) openDetail(+t.dataset.open);
});

// ===== 一覧描画(絞り込み・並び替え) =====
const list = document.getElementById('bosyu-list');
const newList = document.getElementById('new-bosyu');
function budgetSort(r) { return { '〜3,000円': 0, '3,000〜5,000円': 1, '5,000円〜': 2 }[r.budget] ?? 9; }
function dateSortKey(r) {
  if (r.event_date) {
    const t = Date.parse(r.event_date);
    if (!Number.isNaN(t)) return t;
  }
  // event_dateが無い旧データ用のフォールバック(event_atの自由記述から"M/D"を推測)
  const m = (r.event_at || '').match(/(\d+)\s*\/\s*(\d+)/);
  if (!m) return Infinity;
  const now = new Date();
  const guess = new Date(now.getFullYear(), +m[1] - 1, +m[2]);
  if (guess < now) guess.setFullYear(guess.getFullYear() + 1);
  return guess.getTime();
}
function renderListBody() {
  const sel = { size: null, budget: null, genre: null, area: null };
  SLOTS.forEach(s => { if (s.v) sel[s.k] = s.v; });
  const areaOK = r => !sel.area || (PREF[sel.area] ? PREF[sel.area].includes(r.area) : r.area === sel.area);
  let rows = allRecruitments.filter(r =>
    areaOK(r) &&
    (!sel.genre || r.genre === sel.genre) &&
    (!sel.budget || r.budget === sel.budget) &&
    (!sel.size || (sel.size === '1' ? r.capacity === 1 : r.capacity !== 1))
  );
  const sort = fsort.value;
  if (sort === 'date') rows = [...rows].sort((x, y) => dateSortKey(x) - dateSortKey(y));
  else if (sort === 'budget') rows = [...rows].sort((x, y) => budgetSort(x) - budgetSort(y));
  renderTags();
  if (!rows.length) { list.innerHTML = '<div class="empty">条件に合う募集がまだありません。<br>「募集をつくる」から最初の一件を出してみませんか?</div>'; return; }
  list.innerHTML = rows.map(cardHTML).join('');
}
function renderNew() {
  newList.innerHTML = allRecruitments.slice(0, 3).map(cardHTML).join('') ||
    '<div class="empty">まだ募集がありません。</div>';
}
async function refreshRecruitments() {
  try {
    allRecruitments = await listRecruitments();
  } catch (err) {
    console.error(err);
    allRecruitments = [];
  }
  renderNew();
}
async function renderList() {
  await refreshRecruitments();
  renderListBody();
}

// ギャラリー → 一覧へ絞り込み遷移
document.querySelectorAll('.gallery .g').forEach(t => t.addEventListener('click', () => {
  clearF(); SLOTS[2].v = t.dataset.genre;
  go('list');
}));

// ===== 募集詳細(公開コメント・通報はPhase 2で実装) =====
function statusTagHTML(r) {
  const st = effectiveStatus(r);
  if (st === 'cancelled') return '<span class="tag closed">取消</span>';
  if (st === 'expired') return '<span class="tag closed">募集終了(開催済み)</span>';
  if (st === 'closed') return '<span class="tag closed">募集終了</span>';
  return `<span class="tag gold">${capacityLabel(r.capacity)}</span>`;
}
function applicantCardHTML(a) {
  const p = a.applicant || {};
  return `<div class="app-card" style="border:1px solid #E5DFCF;border-radius:8px;padding:10px 12px;margin-bottom:10px">
    <div style="font-weight:700">${escapeHtml(p.nickname || '(削除されたユーザー)')}</div>
    <div class="tags" style="margin:6px 0">
      <span class="tag">${escapeHtml(p.age_band || '未設定')}</span>
      <span class="tag">お酒:${escapeHtml(p.alcohol || '未設定')}</span>
      <span class="tag">タバコ:${escapeHtml(p.tobacco || '未設定')}</span>
      <span class="tag">会計:${escapeHtml(p.payment || '未設定')}</span>
    </div>
    ${p.intro ? `<p class="hint2">${escapeHtml(p.intro)}</p>` : ''}
    <button class="btn btn-ai" data-app-approve="${a.id}">承認する</button>
    <button class="btn btn-ghost" data-app-decline="${a.id}">見送る</button>
  </div>`;
}
function memberListHTML(approved) {
  if (!approved.length) return '<p class="hint2">まだ参加が確定したメンバーはいません。</p>';
  return `<div class="tags">` + approved.map(a => {
    const p = a.applicant || {};
    return `<button class="tag p-link" data-uid="${a.applicant_id}" style="border:none">${escapeHtml(p.nickname || '(削除されたユーザー)')}</button>`;
  }).join('') + `</div>`;
}
function cancelAppFormHTML() {
  return `<div id="d-cancel-app-form" hidden style="margin-top:10px">
    <textarea id="d-cancel-comment" maxlength="200" placeholder="主催者への一言(任意・主催者にのみ届きます)"></textarea>
    <div class="form-msg" id="d-cancel-msg" role="status"></div>
    <button class="btn btn-ai" id="d-cancel-app-send">取り消す</button>
    <button class="btn btn-ghost" id="d-cancel-app-back">やめる</button>
  </div>`;
}
async function openDetail(id) {
  currentDetailId = id;
  go('detail');
  const body = document.getElementById('detail-body');
  body.innerHTML = '<p class="hint2">読み込み中...</p>';
  let r;
  try {
    r = await getRecruitment(id);
  } catch (err) {
    body.innerHTML = `<p class="hint2">読み込みに失敗しました。</p>`;
    return;
  }
  if (!r) { body.innerHTML = '<p class="hint2">この募集は見つかりませんでした。</p>'; return; }
  const hostName = hostDisplayName(r);
  const st = effectiveStatus(r);
  const expired = st === 'expired';
  const closed = st === 'closed' || expired;
  const cancelled = st === 'cancelled';
  const isHost = !!(session && session.user.id === r.host_id);

  // ログイン中なら一度だけ取得。RLS上、host以外には承認済み(approved)行のみ返る
  // (pending/declinedは申請者本人かhostにしか見えない)ため、これで
  // 「承認待ちリスト(host専用)」と「参加メンバー(誰でも閲覧可)」の両方をまかなえる
  let apps = [];
  if (session) {
    try { apps = await listApplications(r.id); } catch (err) { console.error(err); }
  }
  const approved = apps.filter(a => a.status === 'approved');
  const pending = apps.filter(a => a.status === 'pending');
  const myApp = session ? (apps.find(a => a.applicant_id === session.user.id) || null) : null;

  const memberSection = session ? `
    <h3 style="margin-top:18px">参加メンバー${approved.length ? `(${approved.length}名)` : ''}</h3>
    ${memberListHTML(approved)}
  ` : '';

  let joinSection = '';
  if (isHost) {
    joinSection = `
      <div class="agree" style="margin-top:18px"><span>あなたが主催の募集です。</span></div>
      <h3 style="margin-top:18px">承認待ちの応募${pending.length ? `(${pending.length}件)` : ''}</h3>
      ${pending.length ? pending.map(applicantCardHTML).join('') : '<p class="hint2">承認待ちの応募はまだありません。</p>'}
      <div style="margin-top:12px">
        <button class="btn btn-ghost" id="d-edit-recruit" ${(approved.length || cancelled) ? 'disabled' : ''}>編集する</button>
        <button class="btn btn-ghost" id="d-cancel-recruit" ${(approved.length || cancelled) ? 'disabled' : ''} style="color:#B23A2B">募集を取り消す</button>
        ${approved.length ? '<p class="hint2">承認済みの参加者がいるため編集・取り消しができません(約束を守るため)。</p>' : ''}
        ${cancelled ? '<p class="hint2">この募集はすでに取り消し済みです。</p>' : ''}
      </div>
    `;
  } else if (session) {
    if (!myApp) {
      joinSection = (closed || cancelled)
        ? `<div class="agree" style="margin-top:18px"><span>${cancelled ? 'この募集は主催者により取り消されました。' : expired ? '開催日を過ぎたため、この募集は終了しました。' : 'この募集は終了しました。'}</span></div>`
        : (myProfile
            ? '<div style="margin-top:18px"><button class="btn btn-ai" id="d-apply">参加表明する</button></div>'
            : '<p class="hint2" style="margin-top:18px">参加表明には先に「プロフィール」タブでプロフィールを登録してください。</p>');
    } else if (myApp.status === 'pending') {
      joinSection = `
        <div class="agree" style="margin-top:18px"><span>承認待ち(主催者が確認しています)。</span></div>
        <div style="margin-top:12px"><button class="btn btn-ghost" id="d-cancel-app" style="color:#B23A2B">参加を取り消す</button></div>
        ${cancelAppFormHTML()}
      `;
    } else if (myApp.status === 'approved') {
      joinSection = `
        <div class="agree" style="margin-top:18px"><span>参加が承認されました。当日はお店の前で!</span></div>
        <div style="margin-top:12px"><button class="btn btn-ghost" id="d-cancel-app" style="color:#B23A2B">参加を取り消す</button></div>
        ${cancelAppFormHTML()}
      `;
    } else if (myApp.status === 'cancelled') {
      // applications はrecruitment_id+applicant_idでunique制約があるため、取り消し後の再応募は不可
      joinSection = '<div class="agree" style="margin-top:18px"><span>この募集への参加を取り消しました。</span></div>';
    } else {
      joinSection = '<div class="agree" style="margin-top:18px"><span>今回は見送りとなりました。</span></div>';
    }
  } else {
    joinSection = (closed || cancelled)
      ? `<div class="agree" style="margin-top:18px"><span>${cancelled ? 'この募集は取り消されました。' : expired ? '開催日を過ぎたため、この募集は終了しました。' : 'この募集は終了しました。'}</span></div>`
      : '<div class="agree" style="margin-top:18px"><span>参加表明にはログインが必要です。</span> <button class="btn btn-ai" id="d-login" style="margin-left:8px">ログイン/新規登録</button></div>';
  }

  body.innerHTML = `
    <button class="btn btn-ghost" style="padding:8px 18px" id="d-back">← 募集一覧にもどる</button>
    <div class="d-head">
      <div class="thumb big" aria-hidden="true"><svg><use href="#${ICON[r.genre] || 'i-other'}"/></svg></div>
      <div><h3>${escapeHtml(r.title)}</h3>
        <div class="tags"><span class="tag ai">${escapeHtml(r.area)}</span><span class="tag">${escapeHtml(r.genre)}</span>${statusTagHTML(r)}<span class="tag">${escapeHtml(r.who)}</span></div>
      </div>
    </div>
    <dl class="d-info">
      <dt>開催日</dt><dd>${escapeHtml(eventLabel(r)) || '未設定'}</dd>
      <dt>エリア</dt><dd>${escapeHtml(r.area)}</dd>
      <dt>ジャンル</dt><dd>${escapeHtml(r.genre)}</dd>
      <dt>募集人数</dt><dd>${capacityLabel(r.capacity)}</dd>
      <dt>参加できる人</dt><dd>${escapeHtml(r.who)}</dd>
      <dt>予算のめやす</dt><dd>${escapeHtml(r.budget)}</dd>
      <dt>主催</dt><dd><button class="tag p-link" data-uid="${r.host_id}" style="border:none">${escapeHtml(hostName)}</button></dd>
    </dl>
    ${r.note ? `<p class="d-note">${escapeHtml(r.note)}</p>` : ''}
    <div class="agree" style="margin-top:18px"><span>当日は<b>お店の前で現地集合</b>です。連絡先の交換は不要。目印(服装・持ち物など)は主催者とご確認ください。</span></div>
    ${memberSection}
    ${joinSection}
    <p class="hint2" style="margin-top:18px">コメント・通報機能はPhase 2で実装予定です。</p>
  `;
  document.getElementById('d-back').addEventListener('click', () => go('list'));
  body.querySelectorAll('.p-link').forEach(el => {
    el.addEventListener('click', () => showProfileModal(el.dataset.uid, el.textContent.trim()));
  });

  body.querySelectorAll('[data-app-approve]').forEach(b => b.addEventListener('click', async () => {
    try { await approveApplication(+b.dataset.appApprove); openDetail(id); }
    catch (err) { alert('承認に失敗しました: ' + (err.message || err)); }
  }));
  body.querySelectorAll('[data-app-decline]').forEach(b => b.addEventListener('click', async () => {
    try { await declineApplication(+b.dataset.appDecline); openDetail(id); }
    catch (err) { alert('見送りに失敗しました: ' + (err.message || err)); }
  }));
  const editRecruitBtn = document.getElementById('d-edit-recruit');
  if (editRecruitBtn) editRecruitBtn.addEventListener('click', () => startEditRecruitment(r));
  const cancelRecruitBtn = document.getElementById('d-cancel-recruit');
  if (cancelRecruitBtn) cancelRecruitBtn.addEventListener('click', async () => {
    if (!confirm('この募集を取り消しますか?')) return;
    try { await cancelRecruitment(r.id); go('list'); }
    catch (err) { alert('取り消しに失敗しました: ' + (err.message || err)); }
  });
  const applyBtn = document.getElementById('d-apply');
  if (applyBtn) applyBtn.addEventListener('click', async () => {
    try { await applyToRecruitment(r.id, session.user.id); openDetail(id); }
    catch (err) { alert('参加表明に失敗しました: ' + (err.message || err)); }
  });
  const cancelAppBtn = document.getElementById('d-cancel-app');
  if (cancelAppBtn) cancelAppBtn.addEventListener('click', () => {
    document.getElementById('d-cancel-app-form').hidden = false;
  });
  const cancelAppBack = document.getElementById('d-cancel-app-back');
  if (cancelAppBack) cancelAppBack.addEventListener('click', () => {
    document.getElementById('d-cancel-app-form').hidden = true;
  });
  const cancelAppSend = document.getElementById('d-cancel-app-send');
  if (cancelAppSend) cancelAppSend.addEventListener('click', async () => {
    const msg = document.getElementById('d-cancel-msg');
    const comment = document.getElementById('d-cancel-comment').value.trim();
    if (hasNgWord(comment)) { msg.textContent = '連絡先やIDらしき文字列は書けません。'; msg.className = 'form-msg ng'; return; }
    try {
      const myApp = await getMyApplication(r.id, session.user.id);
      if (!myApp) throw new Error('応募情報が見つかりませんでした。');
      if (comment) await sendDm({ recruitmentId: r.id, senderId: session.user.id, applicantId: session.user.id, body: comment });
      await cancelApplication(myApp.id);
      openDetail(id);
    } catch (err) {
      msg.textContent = '取り消しに失敗しました: ' + (err.message || err); msg.className = 'form-msg ng';
    }
  });
  const loginBtn = document.getElementById('d-login');
  if (loginBtn) loginBtn.addEventListener('click', () => go('auth'));
}

// ===== プロフィール閲覧モーダル =====
async function showProfileModal(uid, displayName) {
  if (!session) { alert('プロフィールの閲覧にはログインが必要です。'); return; }
  const bd = document.getElementById('pm-body');
  document.getElementById('pm-name').textContent = displayName || '';
  bd.innerHTML = '<dd>読み込み中...</dd>';
  document.getElementById('pmodal').hidden = false;
  try {
    const p = await getProfile(uid);
    if (!p) { bd.innerHTML = '<dd>このユーザーのプロフィールはまだ登録されていません。</dd>'; return; }
    bd.innerHTML = `
      <dt>年代</dt><dd>${escapeHtml(p.age_band)}</dd>
      <dt>性別</dt><dd>${escapeHtml(p.gender || '未設定')}</dd>
      <dt>好きなジャンル</dt><dd>${(p.genres || []).join('・') || '未設定'}</dd>
      <dt>行きたいエリア</dt><dd>${(p.areas || []).join('・') || '未設定'}</dd>
      <dt>参加しやすい時間</dt><dd>${(p.slots || []).join('・') || '未設定'}</dd>
      <dt>お酒</dt><dd>${escapeHtml(p.alcohol || '未設定')}</dd>
      <dt>タバコ</dt><dd>${escapeHtml(p.tobacco || '未設定')}</dd>
      <dt>会計</dt><dd>${escapeHtml(p.payment || '未設定')}</dd>
      <dt>ひとこと</dt><dd>${escapeHtml(p.intro || '')}</dd>
    `;
  } catch (err) {
    bd.innerHTML = '<dd>読み込みに失敗しました。</dd>';
  }
}
window._kgProfClose = function () { document.getElementById('pmodal').hidden = true; };
document.getElementById('pmodal').addEventListener('click', (e) => { if (e.target.id === 'pmodal') window._kgProfClose(); });
document.querySelector('.pmodal-close').addEventListener('click', window._kgProfClose);

// ===== 募集作成・編集(同じフォームを使い回す) =====
const createHeading = document.querySelector('#page-create h2');
const createSubmitBtn = document.getElementById('c-submit');

function resetCreateForm() {
  editingRecruitmentId = null;
  document.getElementById('form-create').reset();
  createHeading.textContent = '募集をつくる';
  createSubmitBtn.textContent = 'この内容で募集する';
}
function sizeValueForCapacity(capacity) {
  return capacity >= 4 ? 'あと4名以上' : `あと${capacity}名`;
}
// 主催者が「編集する」を押したときに、既存の募集内容をフォームへ流し込んで編集モードにする
// (承認済み参加者がいない募集のみ呼ばれる。ボタン自体がそれ以外では無効化されている)
function startEditRecruitment(r) {
  editingRecruitmentId = r.id;
  document.getElementById('c-title').value = r.title;
  setRadio('carea', r.area);
  setRadio('cgenre', r.genre);
  document.getElementById('c-event-date').value = r.event_date || '';
  document.getElementById('c-date').value = r.event_at || '';
  setRadio('size', sizeValueForCapacity(r.capacity));
  setRadio('who', r.who);
  setRadio('budget', r.budget);
  document.getElementById('c-note').value = r.note || '';
  const msg = document.getElementById('c-msg');
  msg.textContent = ''; msg.className = 'form-msg';
  createHeading.textContent = '募集を編集する';
  createSubmitBtn.textContent = 'この内容で更新する';
  go('create');
}
document.getElementById('c-submit').addEventListener('click', async () => {
  const msg = document.getElementById('c-msg');
  const isEdit = !!editingRecruitmentId;
  if (!session) { msg.textContent = 'ログインが必要です。'; msg.className = 'form-msg ng'; return; }
  if (!myProfile) { msg.textContent = '先に「プロフィール」タブでプロフィールを登録してください。'; msg.className = 'form-msg ng'; return; }
  const title = document.getElementById('c-title').value.trim();
  const area = document.querySelector('input[name=carea]:checked');
  const genre = document.querySelector('input[name=cgenre]:checked');
  const eventDate = document.getElementById('c-event-date').value;
  const date = document.getElementById('c-date').value.trim();
  if (!title || !area || !genre || !eventDate) { msg.textContent = 'タイトル・エリア・ジャンル・開催日を入力してください。'; msg.className = 'form-msg ng'; return; }
  if (eventDate < todayJST()) { msg.textContent = '開催日は今日以降の日付を指定してください。'; msg.className = 'form-msg ng'; return; }
  const sizeVal = document.querySelector('input[name=size]:checked').value;
  const capacity = sizeVal.indexOf('4') > -1 ? 4 : (parseInt(sizeVal.replace(/[^0-9]/g, ''), 10) || 1);
  const who = document.querySelector('input[name=who]:checked').value;
  const budget = document.querySelector('input[name=budget]:checked').value;
  const note = document.getElementById('c-note').value.trim();
  if (hasNgWord(note)) { msg.textContent = 'ひとことに連絡先やIDらしき文字列は書けません。'; msg.className = 'form-msg ng'; return; }
  try {
    if (isEdit) {
      const editedId = editingRecruitmentId;
      await updateRecruitment(editedId, {
        title, area: area.value, genre: genre.value,
        event_at: date, event_date: eventDate, capacity, who, budget, note: note || null,
      });
      msg.textContent = '募集を更新しました。'; msg.className = 'form-msg ok';
      resetCreateForm();
      openDetail(editedId);
    } else {
      await createRecruitment({
        host_id: session.user.id, title, area: area.value, genre: genre.value,
        event_at: date, event_date: eventDate, capacity, who, budget, note: note || null,
      });
      msg.textContent = '募集を掲載しました。'; msg.className = 'form-msg ok';
      resetCreateForm();
      go('list');
    }
  } catch (err) {
    console.error(err);
    msg.textContent = (isEdit ? '更新' : '登録') + 'に失敗しました: ' + (err.message || err); msg.className = 'form-msg ng';
  }
});

// ===== プロフィール登録・編集 =====
function checkedValues(container, selector) {
  return Array.from(container.querySelectorAll(selector)).filter(el => el.checked).map(el => el.value);
}
// 現在ログイン中の本人のprofileだけを表示する。profileがnullの場合は全項目を空にクリアする
// (別アカウントへの切り替え時やログアウト時に、前のユーザーの入力が残らないようにするため)
function renderProfileForm(profile) {
  document.getElementById('p-name').value = profile ? profile.nickname : '';
  document.getElementById('p-intro').value = profile ? (profile.intro || '') : '';
  setRadio('age', profile ? profile.age_band : null);
  setRadio('sex', profile ? profile.gender : null);
  setRadio('sake', profile ? profile.alcohol : null);
  setRadio('tobacco', profile ? profile.tobacco : null);
  setRadio('pay', profile ? profile.payment : null);
  setChecked(document.getElementById('p-genre'), profile ? (profile.genres || []) : []);
  setChecked(document.getElementById('p-area'), profile ? (profile.areas || []) : []);
  setChecked(document.getElementById('p-slots'), profile ? (profile.slots || []) : []);
  document.getElementById('p-submit').textContent = profile ? 'この内容で更新する' : 'この内容で登録する';
}
async function loadProfileForm() {
  document.getElementById('p-withdraw-block').hidden = !session;
  document.getElementById('p-mypage').hidden = !session;
  if (!session) {
    myProfile = null;
    renderProfileForm(null);
    await renderMyPage();
    return;
  }
  try {
    myProfile = await getMyProfile(session.user.id);
  } catch (err) {
    console.error(err);
    myProfile = null;
  }
  renderProfileForm(myProfile);
  await renderMyPage();
}
// name属性が一致するラジオボタン群を、value以外すべて明示的にオフにしてから対象だけをオンにする
function setRadio(name, value) {
  document.querySelectorAll(`input[name=${name}]`).forEach(el => { el.checked = (value != null && el.value === value); });
}
function setChecked(container, values) {
  container.querySelectorAll('input[type=checkbox]').forEach(el => { el.checked = values.includes(el.value); });
}

// ===== マイページ(主催募集・参加予定/応募中) =====
function myStatusLabel(status) {
  if (status === 'cancelled') return '取消';
  if (status === 'expired') return '終了(開催済み)';
  if (status === 'closed') return '終了';
  return '募集中';
}
function truncate(s, n) {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) + '…' : t;
}
function myHostedCardHTML(r, apps, comments) {
  const st = effectiveStatus(r);
  const pending = apps.filter(a => a.recruitment_id === r.id && a.status === 'pending');
  const cancelledApps = apps.filter(a => a.recruitment_id === r.id && a.status === 'cancelled');
  const cs = comments.filter(c => c.recruitment_id === r.id);
  const names = list => list.map(a => escapeHtml(a.applicant?.nickname || '(削除されたユーザー)')).join('・');
  return `<div class="app-card" style="border:1px solid #E5DFCF;border-radius:8px;padding:10px 12px;margin-bottom:8px">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
      <a href="#" data-open="${r.id}" style="font-weight:700">${escapeHtml(r.title)}</a>
      <span class="tag${st !== 'open' ? ' closed' : ''}">${myStatusLabel(st)}</span>
    </div>
    <p class="hint2" style="margin-top:6px">
      承認待ちの応募: ${pending.length}件${pending.length ? `(${names(pending)})` : ''}<br>
      取り消された応募: ${cancelledApps.length}件${cancelledApps.length ? `(${names(cancelledApps)})` : ''}<br>
      コメント: ${cs.length}件${cs.length ? `(最新:「${escapeHtml(truncate(cs[0].body, 30))}」${escapeHtml(cs[0].author?.nickname || '')})` : ''}
    </p>
  </div>`;
}
function myJoinedCardHTML(a) {
  const r = a.recruitment || {};
  return `<div class="app-card" style="border:1px solid #E5DFCF;border-radius:8px;padding:10px 12px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:10px">
    <a href="#" data-open="${r.id}" style="font-weight:700">${escapeHtml(r.title || '(削除された募集)')}</a>
    <span class="tag${a.status === 'approved' ? ' gold' : ''}">${a.status === 'approved' ? '承認済み' : '承認待ち'}</span>
  </div>`;
}
async function renderMyPage() {
  const hostedEl = document.getElementById('my-hosted-list');
  const joinedEl = document.getElementById('my-joined-list');
  if (!session) { hostedEl.innerHTML = ''; joinedEl.innerHTML = ''; return; }
  try {
    const hosted = await listMyRecruitments(session.user.id);
    if (!hosted.length) {
      hostedEl.innerHTML = '<p class="hint2">主催した募集はまだありません。</p>';
    } else {
      const ids = hosted.map(r => r.id);
      const [apps, comments] = await Promise.all([
        listApplicationsForHost(ids).catch(err => { console.error(err); return []; }),
        listCommentsForHost(ids).catch(err => { console.error(err); return []; }),
      ]);
      hostedEl.innerHTML = hosted.map(r => myHostedCardHTML(r, apps, comments)).join('');
    }
  } catch (err) {
    console.error(err);
    hostedEl.innerHTML = '<p class="hint2">読み込みに失敗しました。</p>';
  }
  try {
    const joined = await listMyApplications(session.user.id);
    joinedEl.innerHTML = joined.length ? joined.map(myJoinedCardHTML).join('') : '<p class="hint2">参加表明した募集はまだありません。</p>';
  } catch (err) {
    console.error(err);
    joinedEl.innerHTML = '<p class="hint2">読み込みに失敗しました。</p>';
  }
}
document.getElementById('p-submit').addEventListener('click', async () => {
  const msg = document.getElementById('p-msg');
  if (!session) { msg.textContent = 'ログインが必要です。'; msg.className = 'form-msg ng'; return; }
  const nickname = document.getElementById('p-name').value.trim();
  const intro = document.getElementById('p-intro').value.trim();
  const ageEl = document.querySelector('input[name=age]:checked');
  if (!nickname) { msg.textContent = 'ニックネームを入力してください。'; msg.className = 'form-msg ng'; return; }
  if (!ageEl) { msg.textContent = '年代を選択してください。'; msg.className = 'form-msg ng'; return; }
  if (hasNgWord(intro)) { msg.textContent = '自己紹介に連絡先やIDらしき文字列は書けません。'; msg.className = 'form-msg ng'; return; }
  const sexEl = document.querySelector('input[name=sex]:checked');
  const sakeEl = document.querySelector('input[name=sake]:checked');
  const tobaccoEl = document.querySelector('input[name=tobacco]:checked');
  const payEl = document.querySelector('input[name=pay]:checked');
  const payload = {
    nickname,
    age_band: ageEl.value,
    gender: sexEl ? sexEl.value : null,
    genres: checkedValues(document.getElementById('p-genre'), 'input[type=checkbox]'),
    areas: checkedValues(document.getElementById('p-area'), 'input[type=checkbox]'),
    slots: checkedValues(document.getElementById('p-slots'), 'input[type=checkbox]'),
    alcohol: sakeEl ? sakeEl.value : null,
    tobacco: tobaccoEl ? tobaccoEl.value : null,
    payment: payEl ? payEl.value : null,
    intro: intro || null,
  };
  try {
    if (myProfile) {
      myProfile = await updateProfile(session.user.id, payload);
      updateAuthUI();
      msg.textContent = 'プロフィールを更新しました。'; msg.className = 'form-msg ok';
    } else {
      payload.id = session.user.id;
      payload.agreed_at = takeAgreedAt();
      myProfile = await createProfile(payload);
      clearAgreedAt();
      updateAuthUI();
      msg.textContent = '登録が完了しました。「募集をさがす」からごはんの仲間をさがせます。'; msg.className = 'form-msg ok';
      go('top');
    }
  } catch (err) {
    console.error(err);
    if (err instanceof DuplicateNicknameError) {
      msg.textContent = 'このニックネームは既に使われています。別の名前をご入力ください。'; msg.className = 'form-msg ng';
    } else {
      msg.textContent = '保存に失敗しました: ' + (err.message || err); msg.className = 'form-msg ng';
    }
  }
});

// ===== 退会 =====
document.getElementById('p-withdraw').addEventListener('click', async () => {
  const msg = document.getElementById('p-withdraw-msg');
  if (!session) return;
  if (!confirm('本当に退会しますか?この操作は取り消せません。')) return;
  try {
    await withdrawAccount();
    await signOut();
    alert('退会が完了しました。ご利用ありがとうございました。');
    go('top');
  } catch (err) {
    console.error(err);
    msg.textContent = '退会処理に失敗しました: ' + (err.message || err); msg.className = 'form-msg ng';
  }
});

// ===== ログイン/新規登録/パスワード再設定 =====
const okMail = v => /.+@.+\..+/.test(v);
const REMEMBER_EMAIL_KEY = 'gohanbu_remember_email';
// 認証画面を開くたびに呼ぶ。パスワードは保存しないため常に空にし、メールアドレスは
// 「ログイン情報を保持する」がチェックされていた場合のみ前回値を引き継ぐ。
// 新規登録フォームは前のユーザーの入力が残らないよう常にクリアする
function initAuthForm() {
  const remembered = localStorage.getItem(REMEMBER_EMAIL_KEY);
  document.getElementById('l-mail').value = remembered || '';
  document.getElementById('l-pass').value = '';
  document.getElementById('l-remember').checked = !!remembered;
  document.getElementById('s-mail').value = '';
  document.getElementById('s-pass').value = '';
  document.getElementById('s-pass2').value = '';
  document.getElementById('s-age18').checked = false;
}
document.getElementById('l-submit').addEventListener('click', async () => {
  const m = document.getElementById('l-mail').value.trim();
  const p = document.getElementById('l-pass').value;
  const msg = document.getElementById('l-msg');
  if (!okMail(m)) { msg.textContent = 'メールアドレスの形式を確認してください。'; msg.className = 'form-msg ng'; return; }
  if (p.length < 8) { msg.textContent = 'パスワードは8文字以上です。'; msg.className = 'form-msg ng'; return; }
  try {
    const data = await signIn(m, p);
    session = data.session;
    try { myProfile = await getMyProfile(session.user.id); } catch (err) { console.error(err); myProfile = null; }
    updateAuthUI();
    if (document.getElementById('l-remember').checked) {
      localStorage.setItem(REMEMBER_EMAIL_KEY, m);
    } else {
      localStorage.removeItem(REMEMBER_EMAIL_KEY);
    }
    msg.textContent = 'ログインしました。'; msg.className = 'form-msg ok';
    // 初回ログイン(プロフィール未登録)は登録画面へ、2回目以降は通常どおりトップへ
    go(myProfile ? 'top' : 'profile');
  } catch (err) {
    msg.textContent = 'ログインに失敗しました: ' + (err.message || err); msg.className = 'form-msg ng';
  }
});
document.getElementById('l-reset').addEventListener('click', async () => {
  const m = document.getElementById('l-mail').value.trim();
  const msg = document.getElementById('l-msg');
  if (!okMail(m)) { msg.textContent = 'パスワード再設定にはメールアドレスの入力が必要です。'; msg.className = 'form-msg ng'; return; }
  try {
    await resetPassword(m);
    msg.textContent = '再設定用のメールを送信しました。メール内のリンクからパスワードを再設定してください。'; msg.className = 'form-msg ok';
  } catch (err) {
    msg.textContent = '送信に失敗しました: ' + (err.message || err); msg.className = 'form-msg ng';
  }
});
document.getElementById('s-submit').addEventListener('click', async () => {
  const m = document.getElementById('s-mail').value.trim();
  const p = document.getElementById('s-pass').value, p2 = document.getElementById('s-pass2').value;
  const a = document.getElementById('s-age18').checked, msg = document.getElementById('s-msg');
  if (!okMail(m)) { msg.textContent = 'メールアドレスの形式を確認してください。'; msg.className = 'form-msg ng'; return; }
  if (p.length < 8) { msg.textContent = 'パスワードは8文字以上にしてください。'; msg.className = 'form-msg ng'; return; }
  if (p !== p2) { msg.textContent = 'パスワード(確認)が一致しません。'; msg.className = 'form-msg ng'; return; }
  if (!a) { msg.textContent = '18歳以上であることの確認と規約への同意が必要です。'; msg.className = 'form-msg ng'; return; }
  try {
    const data = await signUp(m, p);
    if (data.session) {
      msg.textContent = '登録が完了しました。「プロフィール」タブで自己紹介を設定しましょう。'; msg.className = 'form-msg ok';
      go('profile');
    } else {
      msg.textContent = '確認メールを送信しました。メール内のリンクを開いて登録を完了してください。'; msg.className = 'form-msg ok';
    }
  } catch (err) {
    if (err instanceof DuplicateEmailError) {
      msg.textContent = 'このメールアドレスは登録済みです。ログインしてください。'; msg.className = 'form-msg ng';
    } else {
      msg.textContent = '登録に失敗しました: ' + (err.message || err); msg.className = 'form-msg ng';
    }
  }
});

// ===== 認証状態の反映 =====
function updateAuthUI() {
  const btn = document.getElementById('auth-nav-btn');
  const nick = document.getElementById('auth-nickname');
  document.getElementById('nav-admin').hidden = !(myProfile && myProfile.is_admin);
  if (session) {
    btn.textContent = 'ログアウト';
    btn.dataset.go = '';
    btn.onclick = async (e) => { e.preventDefault(); await signOut(); };
    nick.hidden = false;
    nick.textContent = myProfile ? `${myProfile.nickname} さん` : 'プロフィール未設定';
  } else {
    btn.textContent = 'ログイン';
    btn.dataset.go = 'auth';
    btn.onclick = null;
    nick.hidden = true;
  }
}
onAuthStateChange(async (s) => {
  session = s;
  myProfile = null;
  updateAuthUI();
  if (session) {
    try { myProfile = await getMyProfile(session.user.id); } catch (err) { console.error(err); }
    updateAuthUI();
  } else {
    // ログアウト時: 画面に残ったプロフィール状態(前のユーザーの入力)を必ずクリアする
    clearMessages();
    renderProfileForm(null);
    document.getElementById('p-withdraw-block').hidden = true;
    document.getElementById('p-mypage').hidden = true;
    document.getElementById('my-hosted-list').innerHTML = '';
    document.getElementById('my-joined-list').innerHTML = '';
  }
});

// ===== 管理画面(is_admin限定・閲覧専用) =====
function adminTableHTML(headers, rows) {
  if (!rows.length) return '<p class="hint2">データはありません。</p>';
  return `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.85rem">
    <thead><tr>${headers.map(h => `<th style="text-align:left;border-bottom:1px solid #E5DFCF;padding:6px 8px;white-space:nowrap">${escapeHtml(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(cols => `<tr>${cols.map(c => `<td style="border-bottom:1px solid #F0EBDD;padding:6px 8px;vertical-align:top">${c}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}
function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  return isNaN(d) ? escapeHtml(s) : d.toLocaleString('ja-JP');
}
async function renderAdminPage() {
  const el = document.getElementById('admin-body');
  el.innerHTML = '<p class="hint2">読み込み中...</p>';
  try {
    const [recruitments, applications, reports, comments] = await Promise.all([
      adminListRecruitments(), adminListApplications(), adminListReports(), adminListComments(),
    ]);
    const pendingApps = applications.filter(a => a.status === 'pending');
    const cancelledApps = applications.filter(a => a.status === 'cancelled');
    const cancelledRecruitments = recruitments.filter(r => r.status === 'cancelled');

    const recruitRows = recruitments.map(r => [
      `<a href="#" data-open="${r.id}">${escapeHtml(r.title)}</a>`,
      escapeHtml(myStatusLabel(r.status)),
      escapeHtml(r.host?.nickname || '?'),
      escapeHtml(r.area), escapeHtml(r.genre), fmtDate(r.created_at),
    ]);
    const pendingRows = pendingApps.map(a => [
      `<a href="#" data-open="${a.recruitment_id}">${escapeHtml(a.recruitment?.title || '?')}</a>`,
      escapeHtml(a.recruitment?.host?.nickname || '?'),
      escapeHtml(a.applicant?.nickname || '?'),
      fmtDate(a.created_at),
    ]);
    const cancelledAppRows = cancelledApps.map(a => [
      `<a href="#" data-open="${a.recruitment_id}">${escapeHtml(a.recruitment?.title || '?')}</a>`,
      escapeHtml(a.recruitment?.host?.nickname || '?'),
      escapeHtml(a.applicant?.nickname || '?'),
      fmtDate(a.created_at),
    ]);
    const cancelledRecruitRows = cancelledRecruitments.map(r => [
      `<a href="#" data-open="${r.id}">${escapeHtml(r.title)}</a>`,
      escapeHtml(r.host?.nickname || '?'),
      fmtDate(r.created_at),
    ]);
    const reportRows = reports.map(rp => [
      escapeHtml(rp.reporter?.nickname || '(匿名/削除済み)'),
      escapeHtml(rp.target_type), escapeHtml(rp.target_id),
      escapeHtml(rp.reason || ''), fmtDate(rp.created_at),
    ]);
    const commentRows = comments.map(c => [
      `<a href="#" data-open="${c.recruitment_id}">${escapeHtml(c.recruitment?.title || '?')}</a>`,
      escapeHtml(c.author?.nickname || '?'),
      escapeHtml(c.body), fmtDate(c.created_at),
    ]);

    el.innerHTML = `
      <h3>全募集(${recruitments.length}件)</h3>
      ${adminTableHTML(['タイトル', '状態', '主催者', 'エリア', 'ジャンル', '作成日時'], recruitRows)}
      <h3 style="margin-top:24px">承認待ちの応募(${pendingApps.length}件)</h3>
      ${adminTableHTML(['募集', '主催者', '応募者', '応募日時'], pendingRows)}
      <h3 style="margin-top:24px">取り消された応募(${cancelledApps.length}件)</h3>
      ${adminTableHTML(['募集', '主催者', '応募者', '応募日時'], cancelledAppRows)}
      <h3 style="margin-top:24px">取り消された募集(${cancelledRecruitments.length}件)</h3>
      ${adminTableHTML(['募集', '主催者', '作成日時'], cancelledRecruitRows)}
      <h3 style="margin-top:24px">通報(${reports.length}件)</h3>
      ${adminTableHTML(['通報者', '対象種別', '対象ID', '理由', '通報日時'], reportRows)}
      <h3 style="margin-top:24px">コメント(${comments.length}件)</h3>
      ${adminTableHTML(['募集', '投稿者', '本文', '投稿日時'], commentRows)}
    `;
  } catch (err) {
    console.error(err);
    el.innerHTML = '<p class="hint2">読み込みに失敗しました(管理者権限が無い可能性があります)。</p>';
  }
}

// ===== 初期化 =====
(async function init() {
  session = await getSession();
  updateAuthUI();
  if (session) {
    try { myProfile = await getMyProfile(session.user.id); } catch (err) { console.error(err); }
    updateAuthUI();
  }
  await renderList();
  go('top');
})();

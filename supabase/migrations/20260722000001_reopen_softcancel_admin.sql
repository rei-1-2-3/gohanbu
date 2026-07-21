-- 1. 空きが出たら募集を自動再開
-- 2. 応募の取り消しを物理削除からソフト取消(status='cancelled')に変更(主催者のマイページで内容を確認できるようにするため)
-- 3. 運営者向け管理画面のための is_admin 追加とRLS

-- ---- 1. applications.status に 'cancelled' を追加(ソフト取消) ----
alter table applications drop constraint applications_status_check;
alter table applications add constraint applications_status_check
  check (status in ('pending', 'approved', 'declined', 'cancelled'));

-- 応募者本人が自分の応募を'cancelled'にするUPDATEのみ許可(他のstatusへは変更不可)。
-- 承認/見送りは引き続きhostのみ(既存のapplications_updateポリシー)
create policy applications_update_self_cancel on applications
  for update to authenticated
  using (applicant_id = auth.uid())
  with check (applicant_id = auth.uid() and status = 'cancelled');

-- 物理削除による取消は廃止(取消はapplications_update_self_cancel経由のUPDATEで行う)。
-- 退会時は auth.users の削除に伴うon delete cascadeで引き続き物理削除される
drop policy if exists applications_delete on applications;

-- ---- 1続き. 承認済み参加者が減って定員を下回ったら自動でopenに戻す ----
-- 対象: 応募者本人によるソフト取消(UPDATE→'cancelled')、および退会によるON DELETE CASCADE(DELETE)。
-- 主催者が意図的に取り消した募集(status='cancelled')は対象外(closedの場合のみ再開する)
create or replace function reopen_recruitment_if_below_capacity(p_recruitment_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_capacity int;
  v_status text;
  v_approved_count int;
begin
  select capacity, status into v_capacity, v_status from recruitments where id = p_recruitment_id;
  if v_status = 'closed' then
    select count(*) into v_approved_count from applications
      where recruitment_id = p_recruitment_id and status = 'approved';
    if v_approved_count < v_capacity then
      update recruitments set status = 'open' where id = p_recruitment_id and status = 'closed';
    end if;
  end if;
end;
$$;

create or replace function handle_application_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status = 'approved' and new.status is distinct from 'approved' then
    perform reopen_recruitment_if_below_capacity(old.recruitment_id);
  end if;
  return new;
end;
$$;

create trigger trg_application_status_change
after update on applications
for each row execute function handle_application_status_change();

create or replace function handle_application_removed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status = 'approved' then
    perform reopen_recruitment_if_below_capacity(old.recruitment_id);
  end if;
  return old;
end;
$$;

create trigger trg_application_removed
after delete on applications
for each row execute function handle_application_removed();

-- ---- 3. 運営者向け管理画面 ----
alter table profiles add column is_admin boolean not null default false;

-- is_adminは通常ユーザーが自分自身のUPDATEで書き換えられないよう、列単位で権限を剥奪する。
-- RLSは行単位の制御のためこれだけでは不十分(本人のprofiles行はupdate可能なため)、
-- 列権限で二重に保護する。is_adminの付与はダッシュボードまたはCLIから直接SQLで行う運用とする
revoke update (is_admin) on profiles from authenticated;

-- is_bannedと同様、profilesは全ログインユーザーがselect可(RLS)なのでsecurity definerは不要
create or replace function is_admin_user(uid uuid)
returns boolean
language sql
stable
as $$
  select coalesce((select is_admin from profiles where id = uid), false);
$$;

-- applications: 運営(is_admin)は全件閲覧可(承認待ち・取消の横断確認用)
create policy applications_select_admin on applications
  for select to authenticated
  using (is_admin_user(auth.uid()));

-- reports: 運営(is_admin)のみ閲覧可(これまで閲覧ポリシーが無くダッシュボード限定だった)
create policy reports_select_admin on reports
  for select to authenticated
  using (is_admin_user(auth.uid()));

-- recruitments・comments は既に全ユーザーに公開されているため(cancelled状態やDM除く)、
-- 管理画面用の追加ポリシーは不要。DMは既存の秘匿方針(HANDOVER.md 3章)を変更しないため、
-- 管理画面の対象に含めない

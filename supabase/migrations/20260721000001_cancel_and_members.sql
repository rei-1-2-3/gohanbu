-- マイページ・参加メンバー表示対応
-- 1. 主催者による募集の取り消しを「行の物理削除」から「status='cancelled'への更新」に変更する。
--    (マイページの主催募集一覧に取消済みも残す必要があるため。20260720000005で追加した
--    recruitments_delete ポリシーによる物理削除は廃止する)
-- 2. 承認済み参加者がいる募集は取り消せない、という制約をUPDATE経路でもDBレベルで担保する
-- 3. 「参加メンバー」表示のため、承認済み(approved)のapplicationsは全ログインユーザーが閲覧できるようにする

-- ---- 1. status に 'cancelled' を追加 ----
alter table recruitments drop constraint recruitments_status_check;
alter table recruitments add constraint recruitments_status_check
  check (status in ('open', 'closed', 'cancelled'));

-- 物理削除による取り消しは廃止(取り消しはrecruitments_updateポリシー経由のUPDATEで行う)
drop policy if exists recruitments_delete on recruitments;

-- ---- 2. 承認済み参加者がいる募集をcancelledにする更新を拒否 ----
create or replace function prevent_cancel_with_approved_applicants()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    if exists (
      select 1 from applications
      where recruitment_id = new.id and status = 'approved'
    ) then
      raise exception 'cannot cancel a recruitment with approved applicants';
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_prevent_cancel_with_approved
before update on recruitments
for each row execute function prevent_cancel_with_approved_applicants();

-- ---- 3. 承認済みapplicationsの公開閲覧(参加メンバー表示用) ----
-- 既存の applications_select(申請者本人 or host)に加え、承認済み行に限り
-- 全ログインユーザーが閲覧できるポリシーを追加する(未ログインには非公開のまま)。
-- pending/declinedは従来どおり本人とhost以外には見えない
create policy applications_select_approved_public on applications
  for select to authenticated
  using (status = 'approved');

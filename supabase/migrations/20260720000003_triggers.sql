-- ビジネスロジック: 承認と募集終了の自動化(SPEC.md 6章)
-- 1. applicationがapprovedに更新されたら承認済み人数を集計
-- 2. capacity以上になったらrecruitmentをclosedにし、残りのpendingを一括declined
-- 3. closedの募集への新規applicationはRLS側(20260720000004_rls.sql)でブロック

create or replace function handle_application_approval()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_capacity int;
  v_approved_count int;
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    select capacity into v_capacity from recruitments where id = new.recruitment_id;
    select count(*) into v_approved_count from applications
      where recruitment_id = new.recruitment_id and status = 'approved';

    if v_approved_count >= v_capacity then
      update recruitments set status = 'closed'
        where id = new.recruitment_id and status = 'open';
      update applications set status = 'declined'
        where recruitment_id = new.recruitment_id and status = 'pending';
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_application_approval
after update on applications
for each row execute function handle_application_approval();

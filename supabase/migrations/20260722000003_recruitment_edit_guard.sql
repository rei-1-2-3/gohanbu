-- 募集の編集機能: 承認済み参加者が1人でもいる募集は主催者でも編集不可とする。
-- 既存の「主催者による取り消し」(prevent_cancel_with_approved_applicants)と同じ判断基準
-- (承認済み(approved)のapplicationが存在するか)に揃える。
-- status列だけを書き換える自動遷移(承認による自動close、取消/退会による自動reopen、
-- 主催者によるcancelledへの更新)は対象外とし、内容(title/area/genre/event_at/event_date/
-- capacity/who/budget/note)が変わる更新だけをブロックする

create or replace function prevent_edit_with_approved_applicants()
returns trigger
language plpgsql
as $$
begin
  if (
    new.title is distinct from old.title or
    new.area is distinct from old.area or
    new.genre is distinct from old.genre or
    new.event_at is distinct from old.event_at or
    new.event_date is distinct from old.event_date or
    new.capacity is distinct from old.capacity or
    new.who is distinct from old.who or
    new.budget is distinct from old.budget or
    new.note is distinct from old.note
  ) then
    if exists (
      select 1 from applications a
      where a.recruitment_id = old.id and a.status = 'approved'
    ) then
      raise exception 'cannot edit a recruitment with approved applicants';
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_prevent_edit_with_approved
before update on recruitments
for each row execute function prevent_edit_with_approved_applicants();

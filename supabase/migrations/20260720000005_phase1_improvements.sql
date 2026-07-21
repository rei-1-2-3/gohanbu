-- Phase 1 改善(6項目)対応のスキーマ・RLS追加
-- 1. 登録済みメールでの重複登録メッセージ → フロント(auth.js)のみで対応、DB変更なし
-- 2. ニックネーム重複禁止 → unique制約を追加
-- 3. 退会 → withdraw_account()(security definer)で本人のauth.usersを削除。
--    profiles/recruitments/applications/comments/dms は既存のon delete cascadeで連鎖的に削除される
--    (「本当に退会しますか?この操作は取り消せません」の文言どおり、元に戻せない完全削除として実装する)
-- 4. 主催者による募集の取り消し(承認済み参加者がいない場合のみ) → recruitments_delete ポリシー
-- 5. 応募者による参加の取り消し(承認前後どちらでも) → applications_delete ポリシー

-- ---- 2. ニックネーム重複禁止 ----
alter table profiles add constraint profiles_nickname_key unique (nickname);

-- ---- 3. 退会(本人のアカウントを完全削除) ----
-- security definer で作成することで、通常は権限のない auth.users テーブルへの delete を
-- 本人(auth.uid())の行に限定して許可する。呼び出しは authenticated ロールのみに限定。
create or replace function withdraw_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;

revoke all on function withdraw_account() from public;
grant execute on function withdraw_account() to authenticated;

-- ---- 4. 主催者による募集の取り消し ----
-- 承認済み(approved)の参加者が1人もいない場合のみ削除可(約束を守るための制約)。
-- 削除時、その募集に紐づく pending の applications・comments・dms は recruitment_id の
-- on delete cascade で連動して削除される
create policy recruitments_delete on recruitments
  for delete to authenticated
  using (
    host_id = auth.uid()
    and not exists (
      select 1 from applications a
      where a.recruitment_id = recruitments.id and a.status = 'approved'
    )
  );

-- ---- 5. 応募者による参加の取り消し ----
-- 承認前(pending)・承認後(approved)のどちらでも本人の応募行を削除できる
create policy applications_delete on applications
  for delete to authenticated
  using (applicant_id = auth.uid());

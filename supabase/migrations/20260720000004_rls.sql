-- RLS(SPEC.md 5章 + 13章のBAN条件)
-- 方針確認済み: 募集一覧・詳細・公開コメントは未ログインでも閲覧可(SPEC 10章優先)。
-- profilesは未ログイン非公開(スクレイピング対策、SPEC 5章のまま)。
-- 参加表明・DM送信・コメント投稿はログイン必須。

-- 対象ユーザーがBAN済みかどうか(profiles.banned を参照)。
-- profilesテーブル作成後のこのファイルで定義する(schema.sql時点ではprofilesが未作成のため)
create or replace function is_banned(uid uuid)
returns boolean
language sql
stable
as $$
  select coalesce((select banned from profiles where id = uid), false);
$$;

alter table profiles enable row level security;
alter table recruitments enable row level security;
alter table applications enable row level security;
alter table comments enable row level security;
alter table dms enable row level security;
alter table reports enable row level security;

-- profiles: 全ログインユーザーがselect可(未ログインは不可)。insert/updateは本人のみ
create policy profiles_select on profiles
  for select to authenticated
  using (true);

create policy profiles_insert on profiles
  for insert to authenticated
  with check (auth.uid() = id and not is_banned(auth.uid()));

create policy profiles_update on profiles
  for update to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id and not is_banned(auth.uid()));

-- recruitments: selectは未ログイン含め全員可。insert/updateはhostのみ
create policy recruitments_select on recruitments
  for select to anon, authenticated
  using (true);

create policy recruitments_insert on recruitments
  for insert to authenticated
  with check (host_id = auth.uid() and not is_banned(auth.uid()));

create policy recruitments_update on recruitments
  for update to authenticated
  using (host_id = auth.uid())
  with check (host_id = auth.uid() and not is_banned(auth.uid()));

-- applications: selectは申請者本人またはhost。insertはログインユーザー本人。
-- 募集がopenであること、「同性のみ」の場合は申請者とhostの性別が一致することをwith checkで担保
create policy applications_select on applications
  for select to authenticated
  using (
    applicant_id = auth.uid()
    or exists (
      select 1 from recruitments r
      where r.id = applications.recruitment_id and r.host_id = auth.uid()
    )
  );

create policy applications_insert on applications
  for insert to authenticated
  with check (
    applicant_id = auth.uid()
    and not is_banned(auth.uid())
    and exists (
      select 1 from recruitments r
      join profiles host on host.id = r.host_id
      join profiles applicant on applicant.id = auth.uid()
      where r.id = applications.recruitment_id
        and r.status = 'open'
        and (
          r.who = 'どなたでも'
          or (r.who = '同性のみ' and applicant.gender = host.gender)
        )
    )
  );

create policy applications_update on applications
  for update to authenticated
  using (
    exists (
      select 1 from recruitments r
      where r.id = applications.recruitment_id and r.host_id = auth.uid()
    )
  )
  with check (not is_banned(auth.uid()));

-- comments: selectは未ログイン含め全員可(公開)。insertはログイン必須の本人。deleteは本人
create policy comments_select on comments
  for select to anon, authenticated
  using (true);

create policy comments_insert on comments
  for insert to authenticated
  with check (author_id = auth.uid() and not is_banned(auth.uid()));

create policy comments_delete on comments
  for delete to authenticated
  using (author_id = auth.uid());

-- dms: selectはスレッド当事者(応募者本人 or 該当募集のhost)のみ。
-- applicant_idでスレッドを識別するため、応募者は自分が絡む全メッセージ(自分の送信+hostの返信)を閲覧できる
create policy dms_select on dms
  for select to authenticated
  using (
    applicant_id = auth.uid()
    or exists (
      select 1 from recruitments r
      where r.id = dms.recruitment_id and r.host_id = auth.uid()
    )
  );

-- insert: 応募者本人が送る場合は applicant_id = 自分。hostが返信する場合は
-- applicant_id = 送信先の応募者(そのrecruitmentへの応募実績があること)を指定
create policy dms_insert on dms
  for insert to authenticated
  with check (
    sender_id = auth.uid()
    and not is_banned(auth.uid())
    and (
      applicant_id = auth.uid()
      or exists (
        select 1 from recruitments r
        join applications a on a.recruitment_id = r.id and a.applicant_id = dms.applicant_id
        where r.id = dms.recruitment_id and r.host_id = auth.uid()
      )
    )
  );

-- reports: insertは全ログインユーザー。selectポリシーは作らない(運営はダッシュボードで確認)
create policy reports_insert on reports
  for insert to authenticated
  with check (reporter_id = auth.uid());

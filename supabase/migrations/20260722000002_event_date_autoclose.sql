-- 開催日時が過ぎた募集の自動終了対応(SPEC.md 7章の追加要件)
-- 1. recruitments.event_date を追加(実データとして扱える開催日)。既存行はNULLのままとし
--    (互換性維持。自由記述event_atのみの旧データは自動終了の対象外とする)、
--    表示用の自由記述(event_at、時間帯・集合時間など)は従来どおり残す
-- 2. 「参加表明を締め切る」の実体は、applications insertのRLSに event_date 条件を追加して
--    DBレベルで拒否する形で担保する(statusカラム自体は書き換えない。無料枠でcron等の
--    スケジュール実行に頼らずに済み、閲覧のたびに正しく判定できる)。
--    一覧・詳細の「募集終了(開催済み)」表示はフロント側でevent_dateと当日(JST)を比較して算出する

alter table recruitments add column event_date date;

drop policy applications_insert on applications;
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
        and (r.event_date is null or r.event_date >= (now() at time zone 'Asia/Tokyo')::date)
        and (
          r.who = 'どなたでも'
          or (r.who = '同性のみ' and applicant.gender = host.gender)
        )
    )
  );

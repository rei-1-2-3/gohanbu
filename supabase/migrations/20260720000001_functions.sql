-- 共通関数: NGワードチェック
-- SPEC.md 6章「NGワードフィルタ」に対応

-- 連絡先交換に繋がるNGワード(URL・SNS名・@・6桁以上の数字等)を含まないかをチェック
-- profiles.intro / comments.body / dms.body / recruitments.note の check制約から呼び出す
-- (profilesテーブル作成前でも定義できるようテーブル非依存にしている)
create or replace function ng_word_free(t text)
returns boolean
language sql
immutable
as $$
  select t !~* '[0-9]{6,}|@|line|instagram|http|tiktok|x\.com|twitter';
$$;

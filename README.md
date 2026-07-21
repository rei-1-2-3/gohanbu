# 京阪神ごはん部

京都・大阪・神戸の飲食店に「一緒に行く仲間」を募集する掲示板サイト。
詳細な設計は [SPEC.md](./SPEC.md)、経緯は [HANDOVER.md](./HANDOVER.md) を参照。

## 構成

```
/
├── prototype/index.html      # 参照用プロトタイプ(デザイン・文言の正、変更しない)
├── src/                      # 本実装(Vite + Vanilla JS)
├── supabase/migrations/      # スキーマ・RLS・トリガーのSQL
├── .github/workflows/deploy.yml  # GitHub Pagesデプロイ
└── index.html                # Viteエントリ
```

## ローカル開発

```bash
npm install
cp .env.local.example .env.local  # 値はSupabaseダッシュボード > Settings > API を参照
npm run dev
```

`.env.local` に以下を設定(値は `.env.local` に既に保存済み、`.gitignore` 対象でコミットされません):

```
VITE_SUPABASE_URL=https://bcdvulcobmmzptmpfuvy.supabase.co
VITE_SUPABASE_ANON_KEY=...
```

## GitHub Pagesデプロイ

1. リポジトリの Settings > Pages で Source を「GitHub Actions」に設定
2. Settings > Secrets and variables > Actions で以下を登録:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
3. `main` ブランチへのpushで自動デプロイ(`.github/workflows/deploy.yml`)

## Supabase

- プロジェクトref: `bcdvulcobmmzptmpfuvy`(東京リージョン)
- マイグレーション適用: `npx supabase db push`(要 `npx supabase login`)
- Auth設定(Site URL・Redirect URLs)はダッシュボード Authentication > URL Configuration で
  `https://rei-1-2-3.github.io/gohanbu/` を設定してください(自動設定は未実施。理由: ローカル開発用の
  設定一式を丸ごと本番に上書きするリスクを避けたため)

## Phase 1 動作確認手順

1. `npm run dev` を実行し、表示されたURLをブラウザで開く
2. 「募集をさがす」で一覧が表示されること(未ログインでも閲覧可能)
3. 「ログイン」→「新規登録」でメールアドレス・パスワード・18歳/規約同意チェックを入力して登録
   - メール確認が必要な場合は確認メールのリンクを開いてからログイン
4. ログイン後「プロフィール」タブでニックネーム等を登録
5. 「募集をつくる」からタイトル・エリア・ジャンル・日どり等を入力して募集を作成
6. 「募集をさがす」に戻り、作成した募集がカードに表示されること
7. カードの「詳細を見る」から詳細ページに遷移し、内容が表示されること
8. 主催者名をタップし、プロフィール(年代・お酒・タバコ・会計・自己紹介等)がモーダルで表示されること
9. 「規約・免責」ページが表示されること
10. 「ログアウト」でログイン前の状態に戻ること

Phase 1では参加表明・コメント・DM・通報機能はまだ実装されていません(Phase 2で実装予定)。

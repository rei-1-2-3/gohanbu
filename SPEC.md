# 京阪神ごはん部 実装指示書(Claude Code用)

このドキュメントに従って、プロトタイプ `prototype/index.html` を本番実装に移行してください。
不明点・矛盾があれば実装前に質問すること。**このSPECとプロトタイプが矛盾する場合はこのSPECを優先。**

---

## 1. プロジェクト概要

京都・大阪・神戸の飲食店に「一緒に行く仲間」を募集する掲示板サイト。

- 本名・住所・電話番号・顔写真などの個人情報を**一切収集しない**(メールアドレスは認証専用)
- 連絡先交換なしで完結:サイト内コメント/DMでやりとりし、当日はお店の前で現地集合
- 18歳以上限定(登録時に自己申告チェック)
- 将来的にマッチング機能へ拡張予定(本SPECの範囲外)

## 2. 参照物

- `prototype/index.html` … 画面デザイン・文言・配色・イラスト(SVG)の正。UIはこれを忠実に再現する
- 配色: クリームベース(#FBF1E1)、オレンジ(#E4611F)はアクセント。CSS変数はプロトタイプから流用
- フォント: Shippori Mincho(見出し)+ Zen Kaku Gothic New(本文)

## 3. 技術スタック

| 層 | 技術 | 理由 |
|---|---|---|
| フロントエンド | Vite + Vanilla JS(プロトタイプのHTML/CSS/JSを移植) | プロトタイプ資産を最大活用、ビルドが軽い |
| バックエンド/DB | Supabase(PostgreSQL + Auth + RLS) | サーバー実装不要、無料枠で開始可能 |
| 認証 | Supabase Auth(メールアドレス+パスワード) | パスワード再設定メールが標準機能 |
| ホスティング | GitHub Pages(GitHub Actionsでビルド&デプロイ) | 既存デモと同じ運用 |

- Supabaseの接続情報は `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` を環境変数で注入(anon keyは公開前提の値なのでビルドに含めて可)
- SPA構成。ルーティングはハッシュ(`#/list`, `#/detail/:id` など)で可

## 4. データモデル(PostgreSQL)

```sql
-- プロフィール(auth.users と 1:1)
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nickname text not null check (char_length(nickname) <= 12),
  age_band text not null check (age_band in ('20代','30代','40代','50代','60代〜')),
  gender text check (gender in ('男性','女性','回答しない')),
  genres text[] default '{}',        -- 好きなジャンル(複数)
  areas text[] default '{}',         -- 行きたいエリア(複数)
  slots text[] default '{}',         -- 平日昼/平日夜/土日昼/土日夜
  alcohol text check (alcohol in ('飲む','少し','飲まない')),
  tobacco text check (tobacco in ('喫煙','嫌煙','どちらでも可')),
  payment text check (payment in ('多め負担','応相談','割り勘')),
  intro text check (char_length(intro) <= 100),
  created_at timestamptz default now()
);

-- 募集
create table recruitments (
  id bigint generated always as identity primary key,
  host_id uuid not null references profiles(id) on delete cascade,
  title text not null check (char_length(title) <= 40),
  area text not null,
  genre text not null,               -- 「その他」を含む11ジャンル
  event_at text not null,            -- 日どり・時間帯(自由記述。将来date型に移行可)
  capacity int not null check (capacity between 1 and 4),  -- あと◯名(4=4名以上)
  who text not null check (who in ('どなたでも','同性のみ')),
  budget text not null check (budget in ('〜3,000円','3,000〜5,000円','5,000円〜')),
  note text check (char_length(note) <= 120),
  status text not null default 'open' check (status in ('open','closed')),
  created_at timestamptz default now()
);

-- 参加希望(承認制)
create table applications (
  id bigint generated always as identity primary key,
  recruitment_id bigint not null references recruitments(id) on delete cascade,
  applicant_id uuid not null references profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','approved','declined')),
  created_at timestamptz default now(),
  unique (recruitment_id, applicant_id)
);

-- 公開コメント(返信は parent_id で1階層のみ)
create table comments (
  id bigint generated always as identity primary key,
  recruitment_id bigint not null references recruitments(id) on delete cascade,
  author_id uuid not null references profiles(id) on delete cascade,
  parent_id bigint references comments(id) on delete cascade,
  body text not null check (char_length(body) <= 200),
  created_at timestamptz default now()
);

-- DM(募集単位で、送信者⇔主催者のみ)
create table dms (
  id bigint generated always as identity primary key,
  recruitment_id bigint not null references recruitments(id) on delete cascade,
  sender_id uuid not null references profiles(id) on delete cascade,
  body text not null check (char_length(body) <= 200),
  created_at timestamptz default now()
);

-- 通報
create table reports (
  id bigint generated always as identity primary key,
  reporter_id uuid references profiles(id) on delete set null,
  target_type text not null check (target_type in ('recruitment','comment','dm','profile')),
  target_id text not null,
  reason text check (char_length(reason) <= 300),
  created_at timestamptz default now()
);
```

### エリアマスタ(2階層)

- エリアは「府県」と「駅・繁華街」の2階層。対応表:
  - 大阪 = [大阪, 梅田, 難波・心斎橋, 天満, 福島, 京橋]
  - 兵庫 = [兵庫, 三宮, 元町]
  - 京都 = [京都, 河原町, 烏丸, 伏見]
- 募集には任意の1エリア(府県または駅)を設定できる
- 一覧の絞り込みで府県が選ばれた場合、配下エリアの募集もすべて対象にする(当面は定数マップで実装、将来テーブル化してよい)

## 5. アクセス制御(RLS)— 最重要

すべてのテーブルでRLSを有効化。**プライバシー保証はフロントではなくRLSで行う。**

- **profiles**: 全ログインユーザーがselect可(**全項目公開の方針**。未ログインには非公開)。insert/updateは本人(`auth.uid() = id`)のみ。参加メンバー・コメント投稿者・主催者の名前タップでプロフィールを閲覧できる導線をUIに用意する
- **recruitments**: selectは全ログインユーザー。insertはログインユーザー(host_id = auth.uid())。update(status変更等)はhostのみ
- **applications**:
  - select: 申請者本人(`applicant_id = auth.uid()`)、または該当募集のhost
  - insert: ログインユーザー本人の申請のみ。募集が `open` の場合のみ(トリガーorポリシーで担保)
  - update(承認/見送り): 該当募集のhostのみ
- **comments**: selectは全ログインユーザー(公開)。insertは本人。deleteは本人と(将来)運営
- **dms**: **selectは `sender_id = auth.uid()` または該当募集のhostのみ**。insertは本人。他人のDMは一切読めないことをテストで必ず確認
- **reports**: insertは全ログインユーザー。selectは運営のみ(当面はSupabaseダッシュボードで確認するため、一般ユーザーのselectポリシーは作らない)

## 6. ビジネスロジック

### 承認と募集終了(DBトリガーで実装)
1. applicationが `approved` に更新されたら、承認済み人数を集計
2. 承認済み人数 >= capacity になったら:
   - recruitment.status を `closed` に更新
   - 残りの `pending` applicationを一括で `declined` に更新(自動見送り)
3. `closed` の募集には新規applicationを受け付けない

### NGワードフィルタ(連絡先ブロック)
- 対象: プロフィールintro、コメント、DM、募集note
- ルール: `/[0-9]{6,}|@|line|instagram|http|tiktok|x\.com|twitter/i` にマッチしたら保存拒否
- フロントで即時エラー表示+DB側でもcheck制約またはトリガーで二重に拒否(フロント回避対策)

### 18歳確認
- 新規登録フォームに「18歳以上・規約同意」チェックボックス必須(未チェックは登録不可)
- 同意日時を `profiles` に記録するカラム(`agreed_at timestamptz`)を追加してよい

## 7. 画面と機能(プロトタイプ準拠)

| 画面 | 主な機能 |
|---|---|
| トップ | ヒーロー(全面料理写真+暗色オーバーレイ+中央見出し)、オレンジ線画アイコン付き3ステップ、新着募集3件、ジャンルギャラリー(タップで絞り込み遷移)、安心ポイント、やくそく |
| 募集一覧 | クイックタグ絞り込み:「すべて」+4カテゴリタグ(人数/予算/ジャンル/エリア、代表値をデフォルト表示)。タグをタップするとそのカテゴリのラジオ選択肢がポップオーバーで開き、表示中の値が既定選択。ラジオをタップした瞬間に反映して閉じ、タグ表示は選んだ値に置き換わる。各カテゴリ先頭に「指定なし(解除)」。カテゴリ間の条件は保持、「すべて」で全クリア。府県(大阪/兵庫/京都)選択時は配下エリアの募集もすべて対象。並び替え(新着順/開催日が近い順/予算が安い順)を一覧右上に小さく配置。一覧ページの背景は極薄グレー(#F5F4F2)。募集終了はグレーのタグ表示 |
| 募集詳細 | 基本情報、参加メンバー、参加表明(承認制)、承認待ち/参加確定/募集終了の状態表示、主催者向け承認UI(応募者のプロフィール表示付き)、メンバー/コメント投稿者名タップでプロフィール閲覧、DM、コメント+返信(1階層)、現地集合の案内、通報 |
| 募集作成 | プロトタイプの項目。ログイン必須 |
| プロフィール | プロトタイプの項目(ニックネーム/年代/性別/ジャンル/エリア/曜日/お酒/タバコ/会計/自己紹介)。18歳チェックは登録画面に一本化し、この画面からは削除 |
| ログイン/新規登録 | メール+パスワード。パスワード再設定。登録完了→プロフィール設定へ誘導 |
| 規約・免責 | プロトタイプの文面を移植 |

### 状態表示の仕様(募集詳細)
- 主催者本人: 「あなたが主催の募集です」+承認待ちリスト(承認/見送りボタン、応募者の 年代・お酒・タバコ・会計・自己紹介 を表示)。「参加表明済み」等の通知系表示は出さない
- 承認済み参加者: 「参加が承認されました。当日はお店の前で!」
- 承認待ち: 「承認待ち(主催者が確認しています)」
- 募集終了(未参加者): 「この募集は終了しました」(参加表明不可)

## 8. リポジトリ構成

```
/
├── prototype/index.html      # 参照用プロトタイプ(変更しない)
├── src/                      # 本実装
├── supabase/migrations/      # スキーマ・RLS・トリガーのSQL
├── .github/workflows/deploy.yml  # GitHub Pagesデプロイ
├── SPEC.md                   # 本ドキュメント
└── README.md                 # セットアップ手順(Supabaseプロジェクト作成含む)
```

## 9. 実装フェーズ

- **Phase 1**: Supabaseセットアップ、認証(登録/ログイン/再設定/18歳同意)、プロフィールCRUD、募集CRUD、一覧+絞り込み、GitHub Pagesデプロイ
- **Phase 2**: 承認制(申請/承認/自動見送り/自動募集終了)、コメント+返信、DM(RLS検証込み)、NGワードフィルタ、通報
- **Phase 3**(将来・今回は実装しない): 通知(メール/画面内)、プロフィール検索、条件一致のおすすめ表示(マッチング)、有料化対応

Phase単位でPRを分け、各Phase完了時に動作確認手順をREADMEに追記すること。

## 10. 受け入れチェックリスト

- [ ] 未ログインでも一覧・詳細の閲覧は可能(参加表明・コメント・DMはログイン要求)
- [ ] 他人のDMがAPIから取得できない(別アカウントで検証)
- [ ] 承認で定員到達→募集が自動closed、残pendingが自動declined
- [ ] 「同性のみ」募集に異なる性別で申請するとエラー
- [ ] NGワード(LINE/URL/6桁以上の数字等)が全入力欄で二重ブロックされる
- [ ] 18歳チェック未同意では登録できない
- [ ] スマホ幅(375px)でレイアウト崩れなし
- [ ] Lighthouse アクセシビリティ 90以上

## 11. やらないこと(明確に範囲外)

- 本名・住所・電話番号・生年月日・位置情報の収集
- 異性限定の募集オプション(「どなたでも/同性のみ」の2択を維持)
- 外部SNS連携ログイン
- 決済機能

## 12. Supabaseセットアップ(Claude Codeが自動実行)

### 12-1. 事前にユーザーが行うこと(初回のみ・約3分)

1. https://supabase.com でアカウント作成(GitHubアカウントでのログイン推奨)
2. ダッシュボード右上のアイコン → **Account Settings → Access Tokens** → **Generate new token**(名前は `claude-code` 等)
3. 表示されたトークンをコピーし、Claude Codeのターミナルで環境変数に設定:
   ```
   # Windows (PowerShell)
   $env:SUPABASE_ACCESS_TOKEN = "sbp_xxxxxxxx"
   ```

**トークンの取り扱い**: このトークンはアカウント全体を操作できる強い権限を持つ。絶対にリポジトリにコミットしない(`.gitignore` に `.env*` を必ず含める)。セットアップ完了後はダッシュボードから無効化(Revoke)してよい — 以降の開発はプロジェクト単位のキーだけで足りる。

### 12-2. Claude Codeが実行する手順

```bash
# 1. CLI確認(npx利用でインストール不要)
npx supabase --version

# 2. 認証
npx supabase login --token $env:SUPABASE_ACCESS_TOKEN

# 3. 組織IDを確認
npx supabase orgs list

# 4. プロジェクト作成(東京リージョン)
#    DBパスワードはランダム生成し .env.local(gitignore対象)に記録すること
npx supabase projects create gohanbu --org-id <org_id> --region ap-northeast-1 --db-password <生成したパスワード>

# 5. プロジェクトref(ID)を確認
npx supabase projects list

# 6. ローカル初期化とリンク
npx supabase init
npx supabase link --project-ref <ref>

# 7. マイグレーション作成と適用
#    本SPECの4章(スキーマ)・5章(RLS)・6章(トリガー)のSQLを
#    supabase/migrations/ に分割して配置し、リモートに反映
npx supabase db push

# 8. APIキー取得 → フロントのビルド設定へ
npx supabase projects api-keys --project-ref <ref>
#    anon key と URL(https://<ref>.supabase.co)を
#    .env.local と GitHub Actions のビルド環境変数(VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)に設定
```

補足:
- CLIのコマンド体系が変わっている場合は `npx supabase --help` で現行の書式を確認してから進めること。CLIで不可能な操作はSupabase Management API(https://api.supabase.com、認証は同じアクセストークン)で代替してよい
- **Auth設定**: パスワード再設定メールのリダイレクト先として、Site URLにGitHub Pagesの公開URLを設定する(Management APIの auth config 更新、不可ならユーザーにダッシュボードでの設定箇所を案内する)
- 完了後、「プロジェクトURL・anon keyの設定場所」「DBパスワードの保管場所」「トークンをRevokeしてよいこと」をユーザーに報告すること

### 12-3. ユーザーがClaude Codeに出す指示の例

```
SPEC.mdの12章に従ってSupabaseプロジェクトを作成して。
アクセストークンは環境変数 SUPABASE_ACCESS_TOKEN に設定済み。
完了したら続けてPhase 1の実装に進んで。
```

## 13. 通報後の運営対応

- 通報ボタンは理由(選択式: 個人情報の掲載/金銭の要求/出会い・勧誘目的/その他+自由記述)を `reports` に保存するUIにする
- 当面、専用の管理画面は作らない。運営はSupabaseダッシュボードで通報を確認し、以下の措置をダッシュボード/SQLで実行できる設計にする:
  - **コンテンツ削除**: 該当する募集・コメント・DMの行を削除
  - **アカウント停止**: `profiles` に `banned boolean not null default false` カラムを追加し、全テーブルのinsert/updateポリシーに `banned = false` 条件を含める(BANされたユーザーは閲覧のみ可)。悪質な場合はSupabase Auth側でユーザーをBan(ログイン自体を不可)にする
  - **登録者への連絡**: 認証用メールアドレス宛に運営からメールを送る(規約の「重要なお知らせ」に該当する運用)。サイト内での運営からの通知機能はPhase 3の管理画面とあわせて実装
- 運営者自身のアカウントは通常ユーザーと同じテーブル構成とし、特権はダッシュボード(service_role)側でのみ行使する。フロントに管理者用の裏口を作らない


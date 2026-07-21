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
| 認証 | Supabase Auth(メールアドレス+パスワード) | パスワード再設定メールが標準機能。メールテンプレートは日本語化(7章「認証メールの日本語化」参照) |
| ホスティング | GitHub Pages(GitHub Actionsでビルド&デプロイ) | 既存デモと同じ運用 |

- Supabaseの接続情報は `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` を環境変数で注入(anon keyは公開前提の値なのでビルドに含めて可)
- SPA構成。ルーティングはハッシュ(`#/list`, `#/detail/:id` など)で可

## 4. データモデル(PostgreSQL)

```sql
-- プロフィール(auth.users と 1:1)
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nickname text not null unique check (char_length(nickname) <= 12),  -- 重複登録・変更不可
  age_band text not null check (age_band in ('20代','30代','40代','50代','60代〜')),
  gender text check (gender in ('男性','女性','回答しない')),
  genres text[] default '{}',        -- 好きなジャンル(複数)
  areas text[] default '{}',         -- 行きたいエリア(複数)
  slots text[] default '{}',         -- 平日昼/平日夜/土日昼/土日夜
  alcohol text check (alcohol in ('飲む','少し','飲まない')),
  tobacco text check (tobacco in ('喫煙','嫌煙','どちらでも可')),
  payment text check (payment in ('多め負担','応相談','割り勘')),
  intro text check (char_length(intro) <= 100),
  is_admin boolean not null default false,  -- 運営者フラグ。列単位でUPDATE権限を剥奪し本人でも書き換え不可(5章参照)
  created_at timestamptz default now()
);

-- 募集
create table recruitments (
  id bigint generated always as identity primary key,
  host_id uuid not null references profiles(id) on delete cascade,
  title text not null check (char_length(title) <= 40),
  area text not null,
  genre text not null,               -- 「その他」を含む11ジャンル
  event_at text not null,            -- 時間帯・集合時間など補足の自由記述(任意入力。空文字可)
  event_date date,                   -- 開催日(実データ)。既存募集(旧データ)はNULLのままで自動終了の対象外
  capacity int not null check (capacity between 1 and 4),  -- あと◯名(4=4名以上)
  who text not null check (who in ('どなたでも','同性のみ')),
  budget text not null check (budget in ('〜3,000円','3,000〜5,000円','5,000円〜')),
  note text check (char_length(note) <= 120),
  status text not null default 'open' check (status in ('open','closed','cancelled')),  -- cancelled=主催者による取り消し(物理削除しない)
  created_at timestamptz default now()
);

-- 参加希望(承認制)
create table applications (
  id bigint generated always as identity primary key,
  recruitment_id bigint not null references recruitments(id) on delete cascade,
  applicant_id uuid not null references profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','approved','declined','cancelled')),  -- cancelled=応募者本人による取り消し(物理削除しない)
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

- **profiles**: 全ログインユーザーがselect可(**全項目公開の方針**。未ログインには非公開)。insert/updateは本人(`auth.uid() = id`)のみ。参加メンバー・コメント投稿者・主催者の名前タップでプロフィールを閲覧できる導線をUIに用意する。nicknameはunique制約(重複登録・変更を拒否)。**is_admin列は`revoke update (is_admin) on profiles from authenticated`で列単位のUPDATE権限を剥奪**し、本人を含め通常ユーザーが自分のリクエストで書き換えることを不可能にする(RLSは行単位の制御のためこれだけでは不十分。付与はダッシュボード/CLIから直接SQLで行う。14章参照)
- **recruitments**: selectは全ログインユーザー。insertはログインユーザー(host_id = auth.uid())。update(status変更・主催者による取り消し等)はhostのみ。**主催者による取り消しは物理削除ではなく`status='cancelled'`へのUPDATE**とし、マイページの履歴に残す(削除ではないため専用のdeleteポリシーは無い)。承認済み(`approved`)のapplicationが1件でもある場合はcancelledにできないことを、UPDATE用のBEFOREトリガー(`prevent_cancel_with_approved_applicants`)でDBレベルにも担保する(フロントのボタン無効化と二重に保証)。**開催日(`event_date`)を過ぎた募集への新規参加表明は、statusを書き換えるのではなく`applications`のinsertポリシー側でDBレベルに拒否する**(下記applications insertの条件参照。一覧・詳細の「募集終了(開催済み)」表示はフロントでevent_dateと当日(JST)を比較して算出する、無料枠でcron等に依存しない方式)
- **applications**:
  - select: 申請者本人(`applicant_id = auth.uid()`)、該当募集のhost、**status='approved'の行に限り全ログインユーザー**(募集詳細の「参加メンバー」表示のため。pending/declinedは本人とhost以外には見えない)、または**is_admin**(14章の管理画面用。全件閲覧可)
  - insert: ログインユーザー本人の申請のみ。募集が `open` の場合のみ(トリガーorポリシーで担保)。**加えて`event_date`が設定されている場合は当日(JST)まで**(`event_date is null or event_date >= 当日`)
  - update(承認/見送り): 該当募集のhostのみ。**加えて、申請者本人が自分の行を`status='cancelled'`にするUPDATEのみ許可**(`with check`で遷移先を'cancelled'に限定し、承認への自己昇格を防ぐ)。取り消しは物理削除ではなくこのUPDATEで行う(専用のdeleteポリシーは廃止済み。退会時のみ`on delete cascade`で物理削除される)
- **comments**: selectは全ログインユーザー(公開)。insertは本人。deleteは本人と(将来)運営
- **dms**: **selectは `sender_id = auth.uid()` または該当募集のhostのみ**。insertは本人。他人のDMは一切読めないことをテストで必ず確認。**14章の管理画面もDMは対象外**(HANDOVER.md 3章の秘匿方針を変更しないため)
- **reports**: insertは全ログインユーザー。select は**is_admin**のみ(以前はダッシュボード限定で一般ユーザー・運営とも専用policyが無かったが、14章の管理画面のためis_admin限定のselect policyを追加した)
- **退会(アカウント削除)**: `withdraw_account()` という `security definer` 関数を用意し、`auth.uid()` 自身の `auth.users` 行のみを削除できるようにする(authenticatedにのみEXECUTE権限を付与)。profiles/recruitments/applications/comments/dmsは既存の`on delete cascade`で連鎖的に削除される。**この処理は不可逆**(取り消し不可)であることをフロントの確認ダイアログで明示する

## 6. ビジネスロジック

### 承認と募集終了(DBトリガーで実装)
1. applicationが `approved` に更新されたら、承認済み人数を集計
2. 承認済み人数 >= capacity になったら:
   - recruitment.status を `closed` に更新
   - 残りの `pending` applicationを一括で `declined` に更新(自動見送り)
3. `closed` の募集には新規applicationを受け付けない

### 空きが出たら自動で再募集(DBトリガーで実装)
- `closed`の募集で、承認済み(`approved`)のapplicationが**取り消し(status→'cancelled'へのUPDATE)**または**退会(ON DELETE CASCADEによる物理削除)**によって減り、承認済み人数が`capacity`を下回ったら、recruitment.statusを自動で`open`に戻す
- **主催者が意図的に取り消した募集(`status='cancelled'`)は対象外**(`closed`の場合のみ再開する。`cancelled`から`open`に戻すことはない)
- 実装は`reopen_recruitment_if_below_capacity(recruitment_id)`関数を、applications の AFTER UPDATE(承認済み→他状態への遷移)とAFTER DELETE(退会によるcascade delete)の両方のトリガーから呼び出す形にする。どちらの操作も申請者本人が主体であり、host以外はrecruitmentsをUPDATEできないため、トリガー関数は`security definer`とする
- 自動見送り(declined)になった応募は自動では復活しない。再度あき枠に応募したい場合は、host側の再承認操作(見送りからの巻き戻しは現状UIになし)ではなく、新たな応募者がpendingから承認される形を想定

### 開催日を過ぎた募集の自動終了
- 募集作成フォームの「開催日」(`event_date`、必須)を過ぎた`open`の募集は、実質的に終了扱いとする。既存の`status`列は書き換えない(cron等のスケジュール実行を使わないため)
- 参加表明の締め切りはDBレベルで担保する: `applications`のinsertポリシーに`event_date is null or event_date >= 当日(JST)`を追加(5章参照)。この条件が無ければ`open`のままなので締切後も承認・見送り等の既存応募の管理はhostが引き続き行える
- 一覧・詳細の「募集終了(開催済み)」表示はフロントで`event_date`と当日(JST)を比較して算出する(`effectiveStatus`)。判定に失敗しても表示が古くなるだけで、実際の参加表明締め切りはRLS側で別途保証されているため、フロント判定はあくまで表示用
- **旧データとの互換性**: `event_date`はnullable。この機能追加前に作成された募集は`event_date`が無いため自動終了の対象外とし、従来どおり`status`のみで開閉を判定する(自由記述の`event_at`のみ表示される)

### NGワードフィルタ(連絡先ブロック)
- 対象: プロフィールintro、コメント、DM、募集note
- ルール: `/[0-9]{6,}|@|line|instagram|http|tiktok|x\.com|twitter/i` にマッチしたら保存拒否
- フロントで即時エラー表示+DB側でもcheck制約またはトリガーで二重に拒否(フロント回避対策)

### 18歳確認
- 新規登録フォームに「18歳以上・規約同意」チェックボックス必須(未チェックは登録不可)
- 同意日時を `profiles` に記録するカラム(`agreed_at timestamptz`)を追加してよい

### 重複登録・重複ニックネームの明示
- **メールアドレス重複**: Supabase Authは「メール確認」設定がONの場合、確認済みの既存メールアドレスへの新規登録をメール列挙対策のため成功扱いで返す(`data.user.identities` が空配列になる)。設定がOFFの場合はエラー(`User already registered` 等)で返る。フロントはどちらのケースも重複登録として検知し、「このメールアドレスは登録済みです。ログインしてください。」と表示する
- **ニックネーム重複**: `profiles.nickname` のunique制約違反(Postgresエラーコード `23505`)を検知し、「このニックネームは既に使われています。別の名前をご入力ください。」と表示する

### 主催者による募集の取り消し
- 該当募集に承認済み(`approved`)の参加者が1人でもいる場合は取り消せない(約束を守るため)。フロントはボタンをdisabledにし理由を表示、DB側も`recruitments`のBEFORE UPDATEトリガーで同条件を担保(cancelledへの更新を拒否)
- 取り消しは行の削除ではなく`status='cancelled'`への更新とする。募集一覧(`募集をさがす`)には出さない(`listRecruitments`は`status <> 'cancelled'`で除外)が、主催者自身のマイページ(4章参照)には履歴として残す。詳細ページへの直接アクセスは可能で、「取消」であることを明示する

### 応募者による参加の取り消し
- 承認前(`pending`)・承認後(`approved`)のどちらの状態でも本人が取り消せる。**物理削除ではなく`status='cancelled'`へのUPDATE**とし、主催者のマイページ(7章)で内容を確認できるようにする
- 取り消し時に主催者への一言コメント(任意・200文字まで)を添えられる。コメントは`dms`テーブルへの挿入として扱い、送信者=応募者本人・スレッド識別子(`applicant_id`)=応募者本人とすることで、RLS上「応募者本人」と「該当募集のhost」だけが読める(公開コメントには出さない)
- 承認済みの参加者が取り消した場合、承認済み人数が定員を下回れば募集は自動で`open`に戻る(前項「空きが出たら自動で再募集」参照)
- **既知の制約**: applicationsは`(recruitment_id, applicant_id)`のunique制約により1組につき1行しか持てない。取り消し後の行は`cancelled`として残るため、同じ募集への再応募は現状できない(unique制約違反になる)。再応募を許可する場合は将来的に「cancelledの行をpendingへ戻す」再申請APIの追加を検討すること(今回は未実装)

### 退会
- プロフィール画面下部の「退会する」ボタン→確認ダイアログ(「本当に退会しますか?この操作は取り消せません」)→OKで`withdraw_account()`(RLS節参照)を呼び出し、本人のアカウントを完全削除する
- 削除に伴い、主催していた募集・自身の応募・自身が投稿したコメント/DMはすべて連鎖的に削除される(整合性は`on delete cascade`のFK構成で担保)。**既知の制約**: 自分が投稿した公開コメントに他ユーザーが返信していた場合、その返信も`comments.parent_id`の`on delete cascade`により連動して消える。Phase 2で公開コメント機能を実装する際は、返信保持が必要かどうかを再検討すること(例:`author_id`を匿名化して本文を残す設計に変更する等)
- 退会後もSupabase Authの認証情報(メール確認用トークン等)自体を無効化する手段はクライアント単体では持たない(service_roleが必要なため)。`auth.users`行そのものを削除することで実質的にログイン不可になる

## 7. 画面と機能(プロトタイプ準拠)

| 画面 | 主な機能 |
|---|---|
| トップ | ヒーロー(全面料理写真+暗色オーバーレイ+中央見出し)、オレンジ線画アイコン付き3ステップ、新着募集3件、ジャンルギャラリー(タップで絞り込み遷移)、安心ポイント、やくそく |
| 募集一覧 | クイックタグ絞り込み:「すべて」+4カテゴリタグ(人数/予算/ジャンル/エリア、代表値をデフォルト表示)。タグをタップするとそのカテゴリのラジオ選択肢がポップオーバーで開き、表示中の値が既定選択。ラジオをタップした瞬間に反映して閉じ、タグ表示は選んだ値に置き換わる。各カテゴリ先頭に「指定なし(解除)」。カテゴリ間の条件は保持、「すべて」で全クリア。府県(大阪/兵庫/京都)選択時は配下エリアの募集もすべて対象。並び替え(新着順/開催日が近い順/予算が安い順)を一覧右上に小さく配置。一覧ページの背景は極薄グレー(#F5F4F2)。募集終了はグレーのタグ表示 |
| 募集詳細 | 基本情報、**参加メンバー**(承認済み参加者。ログイン中は誰でも閲覧可、名前タップでプロフィール閲覧)、参加表明(承認制)、承認待ち/参加確定/見送り/募集終了/取消の状態表示、主催者向け承認UI(応募者のプロフィール表示付き。承認すると承認待ちリストから参加メンバーへ移動)、主催者による「募集を取り消す」ボタン(承認済み参加者がいれば無効化)、応募者による「参加を取り消す」ボタン(取り消し時に主催者宛の一言コメントを添付可)、主催者名タップでプロフィール閲覧、現地集合の案内。**公開コメント+返信・通報はPhase 2で実装** |
| 募集作成 | プロトタイプの項目。ログイン必須。登録は成功した場合にのみ完了メッセージを表示する(送信前や失敗時に表示しない) |
| プロフィール | プロトタイプの項目(ニックネーム/年代/性別/ジャンル/エリア/曜日/お酒/タバコ/会計/自己紹介)。18歳チェックは登録画面に一本化し、この画面からは削除。ニックネーム重複時はエラー表示。**常にログイン中の本人のprofilesだけを読み直して表示し、未登録なら全項目を空にする**(別アカウントでの再ログイン時に前のユーザーの入力が残らないようにするため)。**マイページ**: 自分が主催する募集の一覧(状態=募集中/終了/取消、各募集detailへのリンク付き。各募集について**承認待ちの応募・取り消された応募・寄せられたコメント**の件数と概要を表示)、自分が参加予定・応募中の募集の一覧(承認待ち/承認済みの区別、各募集detailへのリンク付き)。画面下部に「退会する」ボタン |
| ログイン/新規登録 | メール+パスワード。パスワード再設定。ログイン後、profilesに行が無ければ自動でプロフィール登録画面へ遷移し(初回オンボーディング)、保存後トップへ。2回目以降のログインはprofilesが存在するため通常どおりトップへ。登録済みメールで新規登録した場合は専用エラーメッセージを表示。**「ログイン情報を保持する」チェックボックス**: チェックした場合のみログイン成功時にメールアドレスをlocalStorageへ保存し、次回この画面を開いたときに引き継ぐ。未チェックならログイン画面を開くたびにメールアドレス欄は空。パスワードは**いかなる場合も保存しない** |
| 規約・免責 | プロトタイプの文面を移植 |
| 管理画面(新規) | `is_admin=true`のユーザーにのみナビゲーションに表示。全募集(状態別)・承認待ちの応募・取り消された応募・取り消された募集・通報・コメントを横断的な一覧表示(閲覧専用)。詳細は14章 |

### 状態表示の仕様(募集詳細)
- 主催者本人: 「あなたが主催の募集です」+承認待ちリスト(承認/見送りボタン、応募者の 年代・お酒・タバコ・会計・自己紹介 を表示)。「参加表明済み」等の通知系表示は出さない。「募集を取り消す」ボタンを表示し、承認済み参加者が1人でもいれば無効化+理由表示(約束を守るため)
- 承認済み参加者: 「参加が承認されました。当日はお店の前で!」+「参加を取り消す」ボタン
- 承認待ち: 「承認待ち(主催者が確認しています)」+「参加を取り消す」ボタン
- 見送り済み: 「今回は見送りとなりました」(再応募は不可。applications の unique制約(recruitment_id, applicant_id)により同一募集への再申請はできない)
- 募集終了(未参加者): 「この募集は終了しました」(参加表明不可)
- 未ログイン: 「参加表明にはログインが必要です」+ログイン導線。ただし一覧・詳細の閲覧自体は未ログインでも可能
- 取消済み: 主催者には「この募集はすでに取り消し済みです」+取り消しボタンは無効化、それ以外には「この募集は主催者により取り消されました」(参加表明不可)
- 「参加を取り消す」押下時: 主催者への一言コメント欄(任意・200文字まで、NGワードチェックあり)を表示し、送信すると取り消し前にDMとして主催者にのみ送られる

### ヘッダー表示
- ログイン中はログアウトボタンの隣にニックネームを表示(例:「たこやき係長 さん」)。プロフィール未登録の間は「プロフィール未設定」と表示
- 未ログイン時はニックネーム表示欄を非表示にする

### 通知メッセージ・フォーム状態のクリア
- 各フォームの結果メッセージ(`.form-msg`)は、実際の処理が成功/失敗した後にのみ表示する(ボタン押下前や無関係な画面遷移で表示されてはならない)
- 画面遷移(タブ切り替え・詳細から一覧へ戻る等)のたびに、すべての`.form-msg`をクリアする。前の画面で出た通知(例:「ログインしました」)が別画面に持ち越されないようにする
- ログアウト時は、通知メッセージに加えてプロフィール編集フォームの入力内容も必ずクリアする(前のユーザーが入力した内容を残さない)
- プロフィール編集フォームは画面表示のたびに**ログイン中の本人**のprofilesを読み直し、取得結果(未登録ならnull)で全項目を無条件に上書きする。一部の項目だけ条件付きで上書きするような実装は、別アカウントへの切り替え時に前のユーザーの入力が残る事故につながるため避けること

### 認証メールの日本語化
- Supabase Authのメールテンプレート(登録確認メール・パスワード再設定メール等)は日本語で運用する
- 件名例:「【京阪神ごはん部】メールアドレスの確認」「【京阪神ごはん部】パスワード再設定のご案内」
- 設定はSupabaseダッシュボード Authentication > Emails > Templates で行う(Management APIでの自動設定はアクセストークンが必要なため、都度状況に応じて自動実行または手動設定の案内とする)
- 実施タイミングは公開準備の段階(カスタムSMTP接続後)とする。開発中はデフォルトのSupabase送信メール(英語)のままでよい。詳細はHANDOVER.md 8章「公開前TODO」参照
- 開発中、動作確認を容易にするため`supabase/config.toml`の`[auth.email] enable_confirmations`を`false`にして`supabase config push`で反映し、メール確認を一時的にオフにすることがある(ダッシュボードのトグルでは設定箇所が見当たらなかったため、config経由で変更)。**公開運用前に必ず`true`に戻して再度pushすること**(オフのままだと他人のメールアドレスで誰でも登録できてしまうため)
- `config push`は`config.toml`全体をリモートに反映する仕様のため、変更時は`site_url`/`additional_redirect_urls`など無関係な項目が意図せずローカル開発用の値に戻っていないか、pushの差分表示を必ず確認すること

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

- **Phase 1**: Supabaseセットアップ、認証(登録/ログイン/再設定/18歳同意/重複メール検知/ログイン情報保持)、プロフィールCRUD(ニックネーム重複禁止・退会・マイページ)、募集CRUD(主催者による取り消し・自動再開含む)、一覧+絞り込み、GitHub Pagesデプロイ、参加表明・承認/見送り・参加メンバー表示・自動募集終了/自動再開(トリガー)・応募の取り消し(コメント付きDM送信込み)の最小限UI
- **Phase 2**: 公開コメント+返信、通報の投稿UI。(承認制・DM(取消コメント分)・NGワードフィルタ・**運営者向け管理画面(14章、閲覧専用)**はPhase 1で前倒し実装済み)
- **Phase 3**(将来・今回は実装しない): 通知(メール/画面内)、プロフィール検索、条件一致のおすすめ表示(マッチング)、有料化対応、管理画面への削除・BAN操作の追加、bannedカラムの実装(13章)

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
- [ ] 登録済みメールで新規登録すると「このメールアドレスは登録済みです。ログインしてください。」と表示される
- [ ] 既に使われているニックネームで登録・変更するとエラーになる(DB unique制約+フロント表示)
- [ ] 退会すると本人のアカウントが削除され、主催していた募集・自身の応募が連鎖的に消える(整合性が保たれる)
- [ ] 承認済み参加者が1人でもいる募集は、主催者でも取り消せない(ボタン無効化+トリガーでも拒否されることをAPI直叩きで確認)
- [ ] 応募は承認前・承認後どちらでも本人が取り消せ、添えたコメントは主催者にのみDMとして届く(他の応募者からは見えないことを別アカウントで確認)
- [ ] 別アカウントでログインし直してプロフィール画面に移動すると、常に本人のプロフィールだけが表示される(前のユーザーの入力が残らない。未登録なら全項目が空)。ログアウト時も同様にクリアされる
- [ ] 募集作成の完了メッセージは、登録が実際に成功した後にだけ表示される(ボタン押下前や画面再訪問時に残っていない)
- [ ] ログアウト後にログイン画面へ戻ると、前回の「ログインしました」等の通知が残っていない
- [ ] マイページに「自分が主催する募集」(募集中/終了/取消)と「参加予定・応募中の募集」(承認待ち/承認済み)が正しく表示され、各項目から詳細画面に遷移できる
- [ ] 主催者が応募を承認すると、募集詳細の「参加メンバー」に承認済み参加者が表示され、承認待ちリストから消える(他の閲覧者・別アカウントからも参加メンバーが見えることを確認)
- [ ] 定員に達してclosedになった募集で、承認済み参加者が取り消す(または退会する)と、承認済み人数が定員未満に戻った時点で自動的にopenへ戻る
- [ ] 主催者が意図的に取り消した募集(cancelled)は、上記の操作を行ってもopenに戻らない
- [ ] マイページ(主催者向け)に、各募集の承認待ちの応募・取り消された応募・寄せられたコメントの件数と内容が表示される
- [ ] 開催日(event_date)を過ぎた`open`の募集は、一覧・詳細で「募集終了(開催済み)」と表示され、新規の参加表明ができない(API直叩きでも拒否されることを確認)
- [ ] event_dateが未設定(この機能追加前からある旧データ)の募集は、開催日による自動終了の対象外のまま従来どおり動作する
- [ ] is_admin=falseのユーザーには管理画面へのナビゲーションが表示されず、URLを直接叩く/コンソールから`go('admin')`を呼んでも入れない
- [ ] is_admin=falseのユーザーが管理画面用のAPI(applications全件・reports)を直接叩いても、RLSにより自分に関係する行以外は取得できない
- [ ] 一般ユーザーが`profiles.is_admin`を自分自身のUPDATEリクエストに含めて送信しても、列権限により拒否される(自己昇格できないことを直接API呼び出しで確認)
- [ ] is_admin=trueのユーザーには管理画面が表示され、全募集・承認待ちの応募・取り消された応募/募集・通報・コメントが横断的に閲覧できる。DMは表示されない
- [ ] ログイン画面で「ログイン情報を保持する」を未チェックのままログインすると、次回ログイン画面を開いたときメールアドレス欄は空。チェックしてログインすると次回は前回のメールアドレスが入力済みになる(パスワードは常に空)
- [ ] ログアウト後にログイン画面へ戻ると、(保持設定が無い限り)前回入力したメールアドレスが残っていない

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
- 通報一覧は14章の管理画面(閲覧専用)で横断的に確認できる。**削除・BAN等の操作はまだ実装していない**(次段階)。当面、実際の措置はSupabaseダッシュボードで以下を実行する:
  - **コンテンツ削除**: 該当する募集・コメント・DMの行を削除
  - **アカウント停止**: `profiles` に `banned boolean not null default false` カラムを追加し、全テーブルのinsert/updateポリシーに `banned = false` 条件を含める(BANされたユーザーは閲覧のみ可)。悪質な場合はSupabase Auth側でユーザーをBan(ログイン自体を不可)にする。**このbannedカラム・ポリシーは未実装**(is_bannedチェック関数はis_bannedという名前で既にRLS各所に組み込み済みだが、参照先のbannedカラム自体・値を立てる手段が無い状態。14章の管理画面に操作を追加する際に合わせて実装する)
  - **登録者への連絡**: 認証用メールアドレス宛に運営からメールを送る(規約の「重要なお知らせ」に該当する運用)。サイト内での運営からの通知機能はPhase 3とあわせて実装
- 運営者自身のアカウントは通常ユーザーと同じテーブル構成とし、閲覧専用の管理画面(14章)を除く特権操作はダッシュボード(service_role)側でのみ行使する

## 14. 運営者向け管理画面(is_admin限定・閲覧専用)

### 目的とスコープ
- 不正監視が目的。**現時点では閲覧のみ**で、削除・BAN等の操作機能は次段階で追加する
- 対象データ: 全募集(状態別)、承認待ちの応募、取り消された応募、取り消された募集、通報、コメント(横断表示)
- **対象外**: DM。HANDOVER.md 3章・SPEC.md 5章の秘匿方針(送信者本人と該当募集のhostのみ閲覧可)を変更しないため、運営であってもDMは管理画面から見えない設計とする(不正の疑いがある場合は、通報内容や公開コメント・応募状況などDM以外の情報で判断する運用とする)

### アクセス制御(多重防御)
1. **DBスキーマ**: `profiles.is_admin boolean not null default false`
2. **列権限**: `revoke update (is_admin) on profiles from authenticated` により、一般ユーザーは自分自身のprofiles更新であってもis_admin列だけは書き換え不可(アプリのUPDATE文にis_adminを含めなくても、悪意ある直接API呼び出しに対する防御として必須)
3. **RLS**: `applications`・`reports`にis_admin限定のselectポリシーを追加(5章参照)。`recruitments`・`comments`は元々公開範囲のため追加ポリシー不要
4. **フロント**: `myProfile.is_admin`がtrueの場合のみナビゲーションに「管理」ボタンを表示。管理画面への遷移処理でも`myProfile.is_admin`を再チェックし、falseならトップへ強制的に戻す(URLを直接叩く・コンソール操作などの迂回を防ぐための多重防御であり、**実際のアクセス制御はあくまでDB側のRLS・列権限が担保する**)

### is_adminを付与する手順(運営アカウントのみ)
アプリからは付与できない(意図的に権限を剥奪しているため)。以下のいずれかで、Supabaseの管理者権限(service_role/postgres接続)から直接SQLを実行する:

- **Supabase CLI**(推奨・本プロジェクトで利用中の方法):
  ```bash
  npx supabase db query --linked "update profiles set is_admin = true where id = '<運営アカウントのuser id>';"
  ```
  `<運営アカウントのuser id>` はSupabaseダッシュボードの Authentication > Users で対象アカウントのメールアドレスから調べるか、以下で調べる:
  ```bash
  npx supabase db query --linked "select id, email from auth.users where email = '<運営アカウントのメールアドレス>';"
  ```
- **Supabaseダッシュボード**: SQL Editor で上記と同じUPDATE文を実行、またはTable Editorでprofilesテーブルの対象行のis_adminをtrueに直接編集

### 実装状況
- 一覧は各セクションごとに件数と表形式で表示。募集・コメントの行からは対応する募集詳細へのリンクあり
- 次段階で追加予定: 通報からの直接BAN・コンテンツ削除、bannedカラムの実装(13章参照)


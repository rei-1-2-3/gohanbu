-- スキーマ本体(SPEC.md 4章 + 6章の18歳同意 + 13章のBANカラム)

-- プロフィール(auth.users と 1:1)
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nickname text not null check (char_length(nickname) <= 12),
  age_band text not null check (age_band in ('20代','30代','40代','50代','60代〜')),
  gender text check (gender in ('男性','女性','回答しない')),
  genres text[] default '{}',
  areas text[] default '{}',
  slots text[] default '{}',
  alcohol text check (alcohol in ('飲む','少し','飲まない')),
  tobacco text check (tobacco in ('喫煙','嫌煙','どちらでも可')),
  payment text check (payment in ('多め負担','応相談','割り勘')),
  intro text check (char_length(intro) <= 100 and (intro is null or ng_word_free(intro))),
  agreed_at timestamptz not null,
  banned boolean not null default false,
  created_at timestamptz default now()
);

-- 募集
create table recruitments (
  id bigint generated always as identity primary key,
  host_id uuid not null references profiles(id) on delete cascade,
  title text not null check (char_length(title) <= 40),
  area text not null,
  genre text not null,
  event_at text not null,
  capacity int not null check (capacity between 1 and 4),
  who text not null check (who in ('どなたでも','同性のみ')),
  budget text not null check (budget in ('〜3,000円','3,000〜5,000円','5,000円〜')),
  note text check (char_length(note) <= 120 and (note is null or ng_word_free(note))),
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
  body text not null check (char_length(body) <= 200 and ng_word_free(body)),
  created_at timestamptz default now()
);

-- DM(募集単位・応募者ごとのスレッドで、送信者⇔主催者のみ)
-- applicant_id: このメッセージが属する「応募者⇔主催者」スレッドの応募者を表す
--   (SPEC.md 4章の元定義は sender_id のみで、複数応募者が同じ募集にDMした場合に
--    応募者が主催者からの返信を判別できない欠陥があったため、db push前に追加した)
create table dms (
  id bigint generated always as identity primary key,
  recruitment_id bigint not null references recruitments(id) on delete cascade,
  sender_id uuid not null references profiles(id) on delete cascade,
  applicant_id uuid not null references profiles(id) on delete cascade,
  body text not null check (char_length(body) <= 200 and ng_word_free(body)),
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

create index on recruitments (status, created_at desc);
create index on recruitments (area);
create index on recruitments (genre);
create index on applications (recruitment_id, status);
create index on comments (recruitment_id, created_at);
create index on dms (recruitment_id, applicant_id, created_at);

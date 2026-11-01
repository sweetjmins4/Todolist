-- =============================================================
-- 사내 TODO 리스트 - Supabase 전체 스키마 (01~07 통합본)
-- SQL Editor 에 전체를 붙여넣고 한 번에 Run 하세요.
-- 빈 프로젝트에 한 번만 실행 (재실행 시 '이미 존재' 오류 발생)
-- =============================================================

begin;


-- >>>>>>>>>> 20261101000001_create_profiles.sql >>>>>>>>>>

-- =============================================================
-- 01. 공통 함수 + 사용자 프로필
--   - auth.users(Supabase 로그인 계정)와 1:1로 연결되는 profiles
--   - 회원가입 시 profiles 행 자동 생성
--   - 첫 관리자는 SQL Editor에서 직접 지정:
--       update public.profiles set role = 'admin' where email = '관리자@회사.com';
-- =============================================================

-- updated_at 자동 갱신 (여러 테이블에서 공통 사용)
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- -------------------------------------------------------------
-- profiles
-- -------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  name        text not null,
  department  text,
  role        text not null default 'member' check (role in ('admin', 'member')),
  is_active   boolean not null default true,   -- 퇴사자는 false (행 삭제 X)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.profiles is '구성원 프로필 (auth.users와 1:1)';

create trigger trg_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- 사용자가 관리자인지 (인자를 생략하면 현재 로그인 사용자)
create or replace function public.is_admin(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = p_user_id
      and role = 'admin'
      and is_active
  );
$$;

-- 회원가입 시 profiles 자동 생성
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 일반 사용자가 자기 role / is_active / email 을 바꾸지 못하게 막음
-- (SQL Editor·서버 키처럼 로그인 사용자가 없는 경우는 허용)
create or replace function public.protect_profile_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null and not public.is_admin() then
    if new.role      is distinct from old.role
    or new.is_active is distinct from old.is_active
    or new.email     is distinct from old.email then
      raise exception '권한이 없습니다: role, is_active, email 은 관리자만 변경할 수 있습니다.';
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_profiles_protect_fields
  before update on public.profiles
  for each row execute function public.protect_profile_fields();

-- -------------------------------------------------------------
-- RLS
-- -------------------------------------------------------------
alter table public.profiles enable row level security;

-- 사내 도구이므로 로그인한 구성원끼리는 서로 조회 가능
create policy "profiles: 로그인 사용자 조회"
  on public.profiles for select
  to authenticated
  using (true);

-- 본인 프로필 수정 (이름·부서), 관리자는 전체 수정
create policy "profiles: 본인 또는 관리자 수정"
  on public.profiles for update
  to authenticated
  using (id = (select auth.uid()) or public.is_admin())
  with check (id = (select auth.uid()) or public.is_admin());

-- insert 는 가입 트리거가, delete 는 auth.users 삭제(cascade)가 담당 → 정책 없음


-- >>>>>>>>>> 20261101000002_create_teams.sql >>>>>>>>>>

-- =============================================================
-- 02. 팀 / 팀원
--   - 팀 생성·삭제: 관리자
--   - 팀원 추가·제거·역할 변경: 관리자 또는 해당 팀의 팀장
-- =============================================================

create table public.teams (
  id          bigint generated always as identity primary key,
  name        text not null unique,
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.teams is '팀';

create trigger trg_teams_updated_at
  before update on public.teams
  for each row execute function public.set_updated_at();

create table public.team_members (
  team_id    bigint not null references public.teams (id) on delete cascade,
  user_id    uuid   not null references public.profiles (id) on delete cascade,
  role       text   not null default 'member' check (role in ('leader', 'member')),
  joined_at  timestamptz not null default now(),
  primary key (team_id, user_id)
);

comment on table public.team_members is '팀 소속 (사용자 N : 팀 M)';

-- PK가 (team_id, user_id) 라서 team_id 조회는 PK 인덱스로 처리됨.
-- "이 사용자가 속한 팀" 조회용으로 user_id 인덱스만 추가.
create index idx_team_members_user_id on public.team_members (user_id);

-- -------------------------------------------------------------
-- 권한 확인 함수
--   security definer: team_members 정책 안에서 team_members를 다시
--   조회할 때 생기는 RLS 무한 재귀를 피하기 위해 사용
-- -------------------------------------------------------------
create or replace function public.is_team_member(p_team_id bigint, p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.team_members
    where team_id = p_team_id and user_id = p_user_id
  );
$$;

create or replace function public.is_team_leader(p_team_id bigint, p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.team_members
    where team_id = p_team_id and user_id = p_user_id and role = 'leader'
  );
$$;

-- -------------------------------------------------------------
-- RLS: teams
-- -------------------------------------------------------------
alter table public.teams enable row level security;

create policy "teams: 로그인 사용자 조회"
  on public.teams for select
  to authenticated
  using (true);

create policy "teams: 관리자 생성"
  on public.teams for insert
  to authenticated
  with check (public.is_admin());

create policy "teams: 관리자 또는 팀장 수정"
  on public.teams for update
  to authenticated
  using (public.is_admin() or public.is_team_leader(id))
  with check (public.is_admin() or public.is_team_leader(id));

create policy "teams: 관리자 삭제"
  on public.teams for delete
  to authenticated
  using (public.is_admin());

-- -------------------------------------------------------------
-- RLS: team_members
-- -------------------------------------------------------------
alter table public.team_members enable row level security;

create policy "team_members: 로그인 사용자 조회"
  on public.team_members for select
  to authenticated
  using (true);

create policy "team_members: 관리자 또는 팀장 추가"
  on public.team_members for insert
  to authenticated
  with check (public.is_admin() or public.is_team_leader(team_id));

create policy "team_members: 관리자 또는 팀장 수정"
  on public.team_members for update
  to authenticated
  using (public.is_admin() or public.is_team_leader(team_id))
  with check (public.is_admin() or public.is_team_leader(team_id));

-- 팀장·관리자는 팀원 제거, 본인은 스스로 탈퇴 가능
create policy "team_members: 관리자·팀장 제거 또는 본인 탈퇴"
  on public.team_members for delete
  to authenticated
  using (
    public.is_admin()
    or public.is_team_leader(team_id)
    or user_id = (select auth.uid())
  );


-- >>>>>>>>>> 20261101000003_create_projects.sql >>>>>>>>>>

-- =============================================================
-- 03. 프로젝트 (할 일 묶음)
--   visibility
--     private : 소유자만 조회·편집 (개인 업무용, team_id 없음)
--     team    : 팀원이 조회·편집
--     company : 전 직원 조회, 편집은 소유자·팀원
--   관리(이름 변경·보관·삭제): 소유자, 팀장, 관리자
-- =============================================================

create table public.projects (
  id           bigint generated always as identity primary key,
  team_id      bigint references public.teams (id) on delete restrict,  -- null 이면 개인 프로젝트
  owner_id     uuid   not null references public.profiles (id),
  name         text   not null,
  description  text,
  visibility   text   not null default 'team'
               check (visibility in ('private', 'team', 'company')),
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- 팀 공개 프로젝트는 반드시 팀이 있어야 함
  constraint projects_team_visibility_check
    check (visibility <> 'team' or team_id is not null),
  -- 개인 프로젝트(팀 없음)는 private 또는 company 만 가능
  constraint projects_private_no_team_check
    check (visibility <> 'private' or team_id is null)
);

comment on table public.projects is '프로젝트 (할 일 묶음)';

create index idx_projects_team_id  on public.projects (team_id);
create index idx_projects_owner_id on public.projects (owner_id);

create trigger trg_projects_updated_at
  before update on public.projects
  for each row execute function public.set_updated_at();

-- -------------------------------------------------------------
-- 권한 확인 함수 (tasks 등 하위 테이블 정책에서도 재사용)
-- -------------------------------------------------------------

-- 조회 가능 여부
create or replace function public.can_view_project(p_project_id bigint, p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.projects p
    where p.id = p_project_id
      and (
        p.owner_id = p_user_id
        or p.visibility = 'company'
        or (p.visibility = 'team' and public.is_team_member(p.team_id, p_user_id))
        or (p.visibility <> 'private' and public.is_admin(p_user_id))
      )
  );
$$;

-- 할 일 작성·수정 가능 여부 (담당자로 지정될 수 있는지 판단에도 사용)
create or replace function public.can_edit_project(p_project_id bigint, p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.projects p
    where p.id = p_project_id
      and (
        p.owner_id = p_user_id
        or (p.team_id is not null and public.is_team_member(p.team_id, p_user_id))
        or (p.visibility <> 'private' and public.is_admin(p_user_id))
      )
  );
$$;

-- 프로젝트 관리 가능 여부 (설정 변경·보관·삭제, 남의 할 일 삭제)
create or replace function public.can_manage_project(p_project_id bigint, p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.projects p
    where p.id = p_project_id
      and (
        p.owner_id = p_user_id
        or (p.team_id is not null and public.is_team_leader(p.team_id, p_user_id))
        or (p.visibility <> 'private' and public.is_admin(p_user_id))
      )
  );
$$;

-- -------------------------------------------------------------
-- RLS
-- -------------------------------------------------------------
alter table public.projects enable row level security;

create policy "projects: 공개 범위에 따라 조회"
  on public.projects for select
  to authenticated
  using (
    owner_id = (select auth.uid())
    or visibility = 'company'
    or (visibility = 'team' and public.is_team_member(team_id))
    or (visibility <> 'private' and public.is_admin())
  );

-- 본인 명의로만 생성, 팀 프로젝트는 그 팀의 팀원만 생성
create policy "projects: 본인 명의로 생성"
  on public.projects for insert
  to authenticated
  with check (
    owner_id = (select auth.uid())
    and (team_id is null or public.is_team_member(team_id))
  );

create policy "projects: 소유자·팀장·관리자 수정"
  on public.projects for update
  to authenticated
  using (public.can_manage_project(id))
  with check (
    team_id is null
    or public.is_team_member(team_id)
    or public.is_admin()
  );

create policy "projects: 소유자·팀장·관리자 삭제"
  on public.projects for delete
  to authenticated
  using (public.can_manage_project(id));


-- >>>>>>>>>> 20261101000004_create_tasks.sql >>>>>>>>>>

-- =============================================================
-- 04. 할 일 / 담당자
--   - 하위 작업은 parent_id 로 1단계까지만 허용 (같은 프로젝트 안에서만)
--   - status 가 done 이 되면 completed_at, completed_by 자동 기록
--   - 삭제는 deleted_at 을 채우는 소프트 삭제를 기본으로 사용
--     (조회 시 앱에서 deleted_at is null 조건을 붙일 것)
-- =============================================================

create table public.tasks (
  id            bigint generated always as identity primary key,
  project_id    bigint not null references public.projects (id) on delete cascade,
  parent_id     bigint references public.tasks (id) on delete cascade,
  title         text   not null check (char_length(title) between 1 and 300),
  description   text,
  status        text   not null default 'todo'
                check (status in ('todo', 'in_progress', 'done', 'canceled')),
  priority      smallint not null default 2 check (priority in (1, 2, 3)),  -- 1 높음 / 2 보통 / 3 낮음
  due_date      date,
  sort_order    integer not null default 0,
  created_by    uuid   not null default auth.uid() references public.profiles (id),
  completed_by  uuid   references public.profiles (id) on delete set null,
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,

  constraint tasks_not_own_parent check (parent_id is null or parent_id <> id)
);

comment on table public.tasks is '할 일 (parent_id 로 하위 작업 표현)';
comment on column public.tasks.priority is '1 높음 / 2 보통 / 3 낮음';

-- FK 인덱스
create index idx_tasks_project_id   on public.tasks (project_id);
create index idx_tasks_parent_id    on public.tasks (parent_id);
create index idx_tasks_created_by   on public.tasks (created_by);
create index idx_tasks_completed_by on public.tasks (completed_by);
-- 자주 쓰는 조회: 프로젝트별 상태, 마감일
create index idx_tasks_project_status on public.tasks (project_id, status) where deleted_at is null;
create index idx_tasks_due_date       on public.tasks (due_date)           where deleted_at is null;

create trigger trg_tasks_updated_at
  before update on public.tasks
  for each row execute function public.set_updated_at();

-- -------------------------------------------------------------
-- 저장 전 규칙 검사 / 자동 값 채우기
-- -------------------------------------------------------------
create or replace function public.tasks_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_parent public.tasks%rowtype;
begin
  -- 작성자는 바꿀 수 없음
  if tg_op = 'UPDATE' then
    new.created_by := old.created_by;
  end if;

  -- 하위 작업 규칙
  if new.parent_id is not null then
    select * into v_parent from public.tasks where id = new.parent_id;

    if v_parent.project_id is distinct from new.project_id then
      raise exception '하위 작업은 상위 할 일과 같은 프로젝트에 있어야 합니다.';
    end if;
    if v_parent.parent_id is not null then
      raise exception '하위 작업은 1단계까지만 만들 수 있습니다.';
    end if;
    if tg_op = 'UPDATE' and exists (select 1 from public.tasks where parent_id = new.id) then
      raise exception '하위 작업이 있는 할 일은 다른 할 일의 하위로 옮길 수 없습니다.';
    end if;
  end if;

  -- 완료 처리 자동 기록
  if new.status = 'done'
     and (tg_op = 'INSERT' or old.status is distinct from 'done') then
    new.completed_at := now();
    new.completed_by := coalesce((select auth.uid()), new.completed_by);
  elsif new.status <> 'done' then
    new.completed_at := null;
    new.completed_by := null;
  end if;

  return new;
end;
$$;

create trigger trg_tasks_before_write
  before insert or update on public.tasks
  for each row execute function public.tasks_before_write();

-- -------------------------------------------------------------
-- 담당자 (할 일 N : 사용자 M)
-- -------------------------------------------------------------
create table public.task_assignees (
  task_id      bigint not null references public.tasks (id) on delete cascade,
  user_id      uuid   not null references public.profiles (id) on delete cascade,
  assigned_by  uuid   default auth.uid() references public.profiles (id) on delete set null,
  assigned_at  timestamptz not null default now(),
  primary key (task_id, user_id)
);

comment on table public.task_assignees is '할 일 담당자';

create index idx_task_assignees_user_id     on public.task_assignees (user_id);
create index idx_task_assignees_assigned_by on public.task_assignees (assigned_by);

-- -------------------------------------------------------------
-- 권한 확인 함수 (댓글·첨부·라벨 등에서 재사용)
-- -------------------------------------------------------------
create or replace function public.can_view_task(p_task_id bigint, p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.tasks t
    where t.id = p_task_id
      and public.can_view_project(t.project_id, p_user_id)
  );
$$;

create or replace function public.can_edit_task(p_task_id bigint, p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.tasks t
    where t.id = p_task_id
      and public.can_edit_project(t.project_id, p_user_id)
  );
$$;

create or replace function public.can_manage_task(p_task_id bigint, p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.tasks t
    where t.id = p_task_id
      and public.can_manage_project(t.project_id, p_user_id)
  );
$$;

-- -------------------------------------------------------------
-- RLS: tasks
-- -------------------------------------------------------------
alter table public.tasks enable row level security;

create policy "tasks: 프로젝트 조회 권한자 조회"
  on public.tasks for select
  to authenticated
  using (public.can_view_project(project_id));

create policy "tasks: 프로젝트 편집 권한자 생성"
  on public.tasks for insert
  to authenticated
  with check (
    created_by = (select auth.uid())
    and public.can_edit_project(project_id)
  );

-- 상태 변경·소프트 삭제(deleted_at)도 여기 해당
create policy "tasks: 프로젝트 편집 권한자 수정"
  on public.tasks for update
  to authenticated
  using (public.can_edit_project(project_id))
  with check (public.can_edit_project(project_id));

-- 완전 삭제는 작성자 또는 프로젝트 관리자만
create policy "tasks: 작성자·관리자 완전 삭제"
  on public.tasks for delete
  to authenticated
  using (
    created_by = (select auth.uid())
    or public.can_manage_project(project_id)
  );

-- -------------------------------------------------------------
-- RLS: task_assignees
-- -------------------------------------------------------------
alter table public.task_assignees enable row level security;

create policy "task_assignees: 할 일 조회 권한자 조회"
  on public.task_assignees for select
  to authenticated
  using (public.can_view_task(task_id));

-- 배정하는 사람도, 배정받는 사람도 그 프로젝트 편집 권한이 있어야 함
create policy "task_assignees: 편집 권한자가 팀원에게 배정"
  on public.task_assignees for insert
  to authenticated
  with check (
    public.can_edit_task(task_id)
    and public.can_edit_task(task_id, user_id)
  );

create policy "task_assignees: 편집 권한자 배정 해제"
  on public.task_assignees for delete
  to authenticated
  using (public.can_edit_task(task_id));


-- >>>>>>>>>> 20261101000005_create_task_comments_attachments.sql >>>>>>>>>>

-- =============================================================
-- 05. 댓글 / 첨부파일
--   - 댓글: 할 일을 볼 수 있으면 작성 가능, 수정·삭제는 본인만
--   - 첨부: 파일 본체는 Storage 버킷 'task-attachments' 에,
--           DB 에는 파일 정보(경로·이름·크기)만 저장
--           업로드 경로 규칙:  {task_id}/{파일명}
-- =============================================================

-- -------------------------------------------------------------
-- 댓글
-- -------------------------------------------------------------
create table public.task_comments (
  id          bigint generated always as identity primary key,
  task_id     bigint not null references public.tasks (id) on delete cascade,
  user_id     uuid   not null default auth.uid() references public.profiles (id),
  content     text   not null check (char_length(content) between 1 and 5000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

comment on table public.task_comments is '할 일 댓글';

create index idx_task_comments_task_id on public.task_comments (task_id, created_at);
create index idx_task_comments_user_id on public.task_comments (user_id);

create trigger trg_task_comments_updated_at
  before update on public.task_comments
  for each row execute function public.set_updated_at();

alter table public.task_comments enable row level security;

create policy "task_comments: 할 일 조회 권한자 조회"
  on public.task_comments for select
  to authenticated
  using (public.can_view_task(task_id));

create policy "task_comments: 할 일 조회 권한자 작성"
  on public.task_comments for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and public.can_view_task(task_id)
  );

create policy "task_comments: 본인 수정"
  on public.task_comments for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "task_comments: 본인 또는 프로젝트 관리자 삭제"
  on public.task_comments for delete
  to authenticated
  using (
    user_id = (select auth.uid())
    or public.can_manage_task(task_id)
  );

-- -------------------------------------------------------------
-- 첨부파일 정보
-- -------------------------------------------------------------
create table public.task_attachments (
  id            bigint generated always as identity primary key,
  task_id       bigint not null references public.tasks (id) on delete cascade,
  uploaded_by   uuid   not null default auth.uid() references public.profiles (id),
  file_name     text   not null,                 -- 화면에 보여줄 원래 파일명
  storage_path  text   not null unique,          -- Storage 내부 경로: {task_id}/{uuid}.{확장자}
  mime_type     text,
  file_size     bigint check (file_size is null or file_size >= 0),
  created_at    timestamptz not null default now(),

  -- 경로가 반드시 자기 task_id 폴더 아래에 있어야 함
  constraint task_attachments_path_check
    check (storage_path like task_id::text || '/%')
);

comment on table public.task_attachments is '할 일 첨부파일 정보 (본체는 Storage)';

create index idx_task_attachments_task_id     on public.task_attachments (task_id);
create index idx_task_attachments_uploaded_by on public.task_attachments (uploaded_by);

alter table public.task_attachments enable row level security;

create policy "task_attachments: 할 일 조회 권한자 조회"
  on public.task_attachments for select
  to authenticated
  using (public.can_view_task(task_id));

create policy "task_attachments: 할 일 편집 권한자 업로드"
  on public.task_attachments for insert
  to authenticated
  with check (
    uploaded_by = (select auth.uid())
    and public.can_edit_task(task_id)
  );

create policy "task_attachments: 업로더·관리자 삭제"
  on public.task_attachments for delete
  to authenticated
  using (
    uploaded_by = (select auth.uid())
    or public.can_manage_task(task_id)
  );

-- -------------------------------------------------------------
-- Storage 버킷 (비공개) + 정책
--   경로 첫 폴더를 task_id 로 보고 할 일 권한으로 접근 제어
-- -------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('task-attachments', 'task-attachments', false, 52428800)   -- 50MB
on conflict (id) do nothing;

-- 경로 첫 폴더에서 task_id 추출 (숫자가 아니면 null)
create or replace function public.storage_path_task_id(p_name text)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case
    when split_part(p_name, '/', 1) ~ '^[0-9]+$'
    then split_part(p_name, '/', 1)::bigint
  end;
$$;

create policy "task-attachments: 할 일 조회 권한자 다운로드"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'task-attachments'
    and public.can_view_task(public.storage_path_task_id(name))
  );

create policy "task-attachments: 할 일 편집 권한자 업로드"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'task-attachments'
    and public.can_edit_task(public.storage_path_task_id(name))
  );

create policy "task-attachments: 업로더·관리자 삭제"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'task-attachments'
    and (
      owner_id = (select auth.uid())::text
      or public.can_manage_task(public.storage_path_task_id(name))
    )
  );


-- >>>>>>>>>> 20261101000006_create_labels.sql >>>>>>>>>>

-- =============================================================
-- 06. 라벨 / 할 일-라벨 연결
--   - team_id 가 있으면 그 팀 전용 라벨 (팀장·관리자가 관리)
--   - team_id 가 null 이면 전사 공통 라벨 (관리자가 관리)
--   - 할 일에는 전사 라벨 또는 그 프로젝트 팀의 라벨만 붙일 수 있음
-- =============================================================

create table public.labels (
  id          bigint generated always as identity primary key,
  team_id     bigint references public.teams (id) on delete cascade,
  name        text   not null check (char_length(name) between 1 and 50),
  color       text   not null default '#9E9E9E' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  created_at  timestamptz not null default now()
);

comment on table public.labels is '라벨 (team_id null = 전사 공통)';

-- 같은 팀 안에서 라벨 이름 중복 금지 (전사 라벨끼리도 중복 금지)
create unique index uq_labels_team_name   on public.labels (team_id, name) where team_id is not null;
create unique index uq_labels_global_name on public.labels (name)          where team_id is null;
create index idx_labels_team_id on public.labels (team_id);

create table public.task_labels (
  task_id   bigint not null references public.tasks (id)  on delete cascade,
  label_id  bigint not null references public.labels (id) on delete cascade,
  primary key (task_id, label_id)
);

comment on table public.task_labels is '할 일에 붙은 라벨 (할 일 N : 라벨 M)';

create index idx_task_labels_label_id on public.task_labels (label_id);

-- 이 라벨을 이 할 일에 붙일 수 있는지 (전사 라벨이거나 프로젝트 팀의 라벨)
create or replace function public.label_fits_task(p_label_id bigint, p_task_id bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.labels l
    join public.tasks t    on t.id = p_task_id
    join public.projects p on p.id = t.project_id
    where l.id = p_label_id
      and (l.team_id is null or l.team_id = p.team_id)
  );
$$;

-- -------------------------------------------------------------
-- RLS: labels
-- -------------------------------------------------------------
alter table public.labels enable row level security;

create policy "labels: 로그인 사용자 조회"
  on public.labels for select
  to authenticated
  using (true);

create policy "labels: 팀장·관리자 생성"
  on public.labels for insert
  to authenticated
  with check (
    public.is_admin()
    or (team_id is not null and public.is_team_leader(team_id))
  );

create policy "labels: 팀장·관리자 수정"
  on public.labels for update
  to authenticated
  using (
    public.is_admin()
    or (team_id is not null and public.is_team_leader(team_id))
  )
  with check (
    public.is_admin()
    or (team_id is not null and public.is_team_leader(team_id))
  );

create policy "labels: 팀장·관리자 삭제"
  on public.labels for delete
  to authenticated
  using (
    public.is_admin()
    or (team_id is not null and public.is_team_leader(team_id))
  );

-- -------------------------------------------------------------
-- RLS: task_labels
-- -------------------------------------------------------------
alter table public.task_labels enable row level security;

create policy "task_labels: 할 일 조회 권한자 조회"
  on public.task_labels for select
  to authenticated
  using (public.can_view_task(task_id));

create policy "task_labels: 할 일 편집 권한자 추가"
  on public.task_labels for insert
  to authenticated
  with check (
    public.can_edit_task(task_id)
    and public.label_fits_task(label_id, task_id)
  );

create policy "task_labels: 할 일 편집 권한자 제거"
  on public.task_labels for delete
  to authenticated
  using (public.can_edit_task(task_id));


-- >>>>>>>>>> 20261101000007_create_task_activities.sql >>>>>>>>>>

-- =============================================================
-- 07. 변경 이력
--   - 앱에서 직접 쓰지 않고, 트리거가 자동으로 기록
--   - 기록 대상: 할 일 생성 / 상태·제목·마감일·우선순위·프로젝트 변경 /
--               삭제·복구 / 담당자 배정·해제
--   - 조회만 가능 (insert/update/delete 정책 없음 → 클라이언트에서 수정 불가)
-- =============================================================

create table public.task_activities (
  id          bigint generated always as identity primary key,
  task_id     bigint not null references public.tasks (id) on delete cascade,
  user_id     uuid   references public.profiles (id) on delete set null,  -- null = 시스템/서버 작업
  action      text   not null check (action in (
                'created', 'status_changed', 'title_changed', 'due_date_changed',
                'priority_changed', 'project_changed', 'deleted', 'restored',
                'assigned', 'unassigned'
              )),
  old_value   jsonb,
  new_value   jsonb,
  created_at  timestamptz not null default now()
);

comment on table public.task_activities is '할 일 변경 이력 (트리거로 자동 기록)';

create index idx_task_activities_task_id on public.task_activities (task_id, created_at desc);
create index idx_task_activities_user_id on public.task_activities (user_id);

alter table public.task_activities enable row level security;

create policy "task_activities: 할 일 조회 권한자 조회"
  on public.task_activities for select
  to authenticated
  using (public.can_view_task(task_id));

-- -------------------------------------------------------------
-- 기록용 함수 (security definer: RLS 를 거치지 않고 기록)
-- -------------------------------------------------------------
create or replace function public.log_task_activity(
  p_task_id bigint, p_action text, p_old jsonb, p_new jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.task_activities (task_id, user_id, action, old_value, new_value)
  values (p_task_id, (select auth.uid()), p_action, p_old, p_new);
$$;

-- 클라이언트가 직접 호출해서 가짜 이력을 남기지 못하게 함
revoke execute on function public.log_task_activity(bigint, text, jsonb, jsonb) from public, anon, authenticated;

-- -------------------------------------------------------------
-- tasks 변경 감지
-- -------------------------------------------------------------
create or replace function public.tasks_log_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_task_activity(new.id, 'created', null,
      jsonb_build_object('title', new.title, 'status', new.status));
    return new;
  end if;

  if new.status is distinct from old.status then
    perform public.log_task_activity(new.id, 'status_changed',
      to_jsonb(old.status), to_jsonb(new.status));
  end if;

  if new.title is distinct from old.title then
    perform public.log_task_activity(new.id, 'title_changed',
      to_jsonb(old.title), to_jsonb(new.title));
  end if;

  if new.due_date is distinct from old.due_date then
    perform public.log_task_activity(new.id, 'due_date_changed',
      to_jsonb(old.due_date), to_jsonb(new.due_date));
  end if;

  if new.priority is distinct from old.priority then
    perform public.log_task_activity(new.id, 'priority_changed',
      to_jsonb(old.priority), to_jsonb(new.priority));
  end if;

  if new.project_id is distinct from old.project_id then
    perform public.log_task_activity(new.id, 'project_changed',
      to_jsonb(old.project_id), to_jsonb(new.project_id));
  end if;

  if old.deleted_at is null and new.deleted_at is not null then
    perform public.log_task_activity(new.id, 'deleted', null, null);
  elsif old.deleted_at is not null and new.deleted_at is null then
    perform public.log_task_activity(new.id, 'restored', null, null);
  end if;

  return new;
end;
$$;

create trigger trg_tasks_log_activity
  after insert or update on public.tasks
  for each row execute function public.tasks_log_activity();

-- -------------------------------------------------------------
-- 담당자 배정/해제 감지
-- -------------------------------------------------------------
create or replace function public.task_assignees_log_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_task_activity(new.task_id, 'assigned', null,
      jsonb_build_object('user_id', new.user_id));
    return new;
  end if;

  -- 할 일 자체가 삭제되면서 담당자가 함께 지워지는 경우는 기록하지 않음
  if exists (select 1 from public.tasks where id = old.task_id) then
    perform public.log_task_activity(old.task_id, 'unassigned',
      jsonb_build_object('user_id', old.user_id), null);
  end if;
  return old;
end;
$$;

create trigger trg_task_assignees_log_activity
  after insert or delete on public.task_assignees
  for each row execute function public.task_assignees_log_activity();

commit;

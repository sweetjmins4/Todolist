// =============================================================
// 사내 TODO 리스트 - 프론트엔드 (Vanilla JS + supabase-js)
// =============================================================
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

const sb = createClient(
  SUPABASE_URL.replace(/\/+$/, '').replace(/\/rest\/v1$/, ''),
  SUPABASE_PUBLISHABLE_KEY,
);

const BUCKET = 'task-attachments';
const MAX_FILE = 50 * 1024 * 1024;
const TASK_SELECT = '*, task_assignees(user_id), task_labels(label_id)';

const STATUS = { todo: '할 일', in_progress: '진행 중', done: '완료', canceled: '취소' };
const PRIORITY = { 1: '높음', 2: '보통', 3: '낮음' };
const VIS = { private: '비공개', team: '팀', company: '전사' };
const STATUS_FILTERS = [
  ['open', '진행 중인 일'], ['all', '전체'], ['todo', '할 일'],
  ['in_progress', '진행 중'], ['done', '완료'], ['canceled', '취소'],
];

// -------------------------------------------------------------
// 상태
// -------------------------------------------------------------
const state = {
  user: null, me: null, loaded: false, booting: null, recovery: false,
  profiles: new Map(), teams: [], members: [], labels: [], projects: [],
  view: { type: 'my' },
  tasks: [],
  filter: { status: 'open', q: '', sort: 'default' },
  projectView: 'list',
  canceledCollapsed: true,
  showArchived: false,
  detail: null, // { id, task, subtasks, comments, attachments, activities }
  organizationHistory: [],
  organizationHistoryAvailable: true,
};

// -------------------------------------------------------------
// 유틸
// -------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toLocaleDateString('sv-SE');
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv-SE'); };
const fmtDateTime = (ts) => new Date(ts).toLocaleString('ko-KR', {
  year: '2-digit', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
});
const fmtSize = (n) => n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

function dueLabel(d) {
  if (!d) return '';
  if (d === today()) return '오늘';
  if (d === addDays(1)) return '내일';
  if (d === addDays(-1)) return '어제';
  const [y, m, day] = d.split('-');
  return y === String(new Date().getFullYear()) ? `${+m}/${+day}` : `${y.slice(2)}.${+m}.${+day}`;
}

const userName = (id) => state.profiles.get(id)?.name ?? '알 수 없음';
const projectById = (id) => state.projects.find((p) => p.id === id);
const teamById = (id) => state.teams.find((t) => t.id === id);
const labelById = (id) => state.labels.find((l) => l.id === id);

function avatar(uid) {
  const name = userName(uid);
  let h = 0;
  for (const c of String(uid)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `<span class="avatar" style="--h:${h}" title="${esc(name)}">${esc(name.trim().slice(0, 1))}</span>`;
}
const labelChip = (l, removable = false) => `<span class="label-chip" style="--c:${esc(l.color)}">${esc(l.name)}${
  removable ? `<button type="button" class="x" data-action="remove-label" data-id="${l.id}" aria-label="라벨 제거">×</button>` : ''}</span>`;
const empty = (msg) => `<div class="empty">${msg}</div>`;
const menuBtn = () => '<button class="icon-btn menu-btn" data-action="open-sidebar" aria-label="메뉴">☰</button>';

// -------------------------------------------------------------
// 권한 (화면 표시용 — 실제 보호는 DB RLS 가 담당)
// -------------------------------------------------------------
const isAdmin = () => state.me?.role === 'admin' && state.me?.is_active;
const isMember = (teamId) => state.members.some((m) => m.team_id === teamId && m.user_id === state.me.id);
const isLeader = (teamId) => state.members.some((m) => m.team_id === teamId && m.user_id === state.me.id && m.role === 'leader');
const canEditProject = (p) => !!p && (p.owner_id === state.me.id
  || (p.team_id != null && isMember(p.team_id))
  || (p.visibility !== 'private' && isAdmin()));
const canManageProject = (p) => !!p && (p.owner_id === state.me.id
  || (p.team_id != null && isLeader(p.team_id))
  || (p.visibility !== 'private' && isAdmin()));

function assigneeCandidates(p) {
  const ids = new Set([p.owner_id]);
  if (p.team_id) state.members.filter((m) => m.team_id === p.team_id).forEach((m) => ids.add(m.user_id));
  return [...ids].map((id) => state.profiles.get(id)).filter((u) => u && u.is_active)
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}
const labelCandidates = (p) => state.labels.filter((l) => l.team_id == null || l.team_id === p.team_id);

// -------------------------------------------------------------
// 알림 / 오류
// -------------------------------------------------------------
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toast-root').append(el);
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3600);
}

const ERROR_MAP = [
  [/Invalid login credentials/i, '이메일 또는 비밀번호가 올바르지 않습니다.'],
  [/Email not confirmed/i, '이메일 인증이 필요합니다. 받은 메일함을 확인하세요.'],
  [/User already registered/i, '이미 가입된 이메일입니다.'],
  [/Password should be at least/i, '비밀번호는 6자 이상이어야 합니다.'],
  [/rate limit/i, '요청이 너무 많습니다. 잠시 후 다시 시도하세요.'],
  [/row-level security/i, '권한이 없습니다.'],
  [/duplicate key/i, '이미 존재하는 이름입니다.'],
  [/violates foreign key/i, '연결된 데이터가 있어 처리할 수 없습니다.'],
  [/Failed to fetch/i, '서버에 연결할 수 없습니다. 네트워크를 확인하세요.'],
];
function fail(err) {
  console.error(err);
  let msg = err?.message || '요청을 처리하지 못했습니다.';
  if (err?.code === 'PGRST116') msg = '권한이 없거나 항목을 찾을 수 없습니다.';
  else if (err?.code === '42501') msg = '권한이 없습니다.';
  else for (const [re, ko] of ERROR_MAP) if (re.test(msg)) { msg = ko; break; }
  toast(msg, 'error');
}
async function q(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}
const guard = (fn) => async (...args) => { try { await fn(...args); } catch (e) { fail(e); } };

// -------------------------------------------------------------
// 모달
// -------------------------------------------------------------
function openModal({ title, body, submitText = '저장', danger = false, extra = '', onSubmit, wide = false }) {
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="modal-backdrop">
      <form class="modal${wide ? ' wide' : ''}" novalidate>
        <div class="modal-head"><h3>${esc(title)}</h3>
          <button type="button" class="icon-btn" data-action="modal-close" aria-label="닫기">✕</button></div>
        <div class="modal-body">${body}</div>
        <div class="modal-foot">
          <div class="modal-extra">${extra}</div>
          <button type="button" class="btn ghost" data-action="modal-close">취소</button>
          <button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${esc(submitText)}</button>
        </div>
      </form>
    </div>`;
  const backdrop = root.firstElementChild;
  const form = $('form', root);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) closeModal(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.checkValidity()) { form.reportValidity(); return; }
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try {
      const ok = await onSubmit(new FormData(form), form);
      if (ok !== false) closeModal();
    } catch (err) { fail(err); } finally { btn.disabled = false; }
  });
  setTimeout(() => $('input:not([type=hidden]), textarea, select', form)?.focus(), 30);
  return form;
}
function closeModal() { $('#modal-root').innerHTML = ''; }
function confirmModal(title, message, onOk, submitText = '확인') {
  openModal({ title, body: `<p class="confirm-msg">${message}</p>`, submitText, danger: true, onSubmit: onOk });
}

// -------------------------------------------------------------
// 인증
// -------------------------------------------------------------
function showAuth(mode = 'login') {
  state.loaded = false;
  $('#boot').hidden = true;
  $('#app').hidden = true;
  closeModal();
  const el = $('#auth-screen');
  el.hidden = false;
  const titles = { login: '로그인', signup: '회원가입', forgot: '비밀번호 재설정', reset: '새 비밀번호 설정' };
  const btn = { login: '로그인', signup: '가입하기', forgot: '재설정 메일 보내기', reset: '비밀번호 변경' };
  el.innerHTML = `
    <form class="auth-card" data-form="auth" data-mode="${mode}">
      <div class="brand big"><span class="logo">✓</span> 사내 TODO</div>
      <h2>${titles[mode]}</h2>
      ${mode === 'forgot' ? '<p class="muted">가입한 이메일로 비밀번호 재설정 링크를 보내드립니다.</p>' : ''}
      ${mode === 'signup' ? `<label class="field"><span>이름</span>
        <input name="name" class="input" required maxlength="50" autocomplete="name" placeholder="홍길동"></label>` : ''}
      ${mode !== 'reset' ? `<label class="field"><span>이메일</span>
        <input name="email" type="email" class="input" required autocomplete="email" placeholder="name@company.com"></label>` : ''}
      ${mode !== 'forgot' ? `<label class="field"><span>${mode === 'reset' ? '새 비밀번호' : '비밀번호'}</span>
        <input name="password" type="password" class="input" required minlength="6"
          autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" placeholder="6자 이상"></label>` : ''}
      <button class="btn primary block" type="submit">${btn[mode]}</button>
      <div class="auth-links">
        ${mode === 'login'
          ? `<button type="button" class="link" data-action="auth-mode" data-mode="signup">계정 만들기</button>
             <span class="dot">·</span>
             <button type="button" class="link" data-action="auth-mode" data-mode="forgot">비밀번호를 잊으셨나요?</button>`
          : mode === 'reset' ? ''
          : '<button type="button" class="link" data-action="auth-mode" data-mode="login">← 로그인으로 돌아가기</button>'}
      </div>
    </form>`;
  setTimeout(() => $('input', el)?.focus(), 30);
}

const redirectUrl = () => location.origin + location.pathname;

async function submitAuth(form) {
  const mode = form.dataset.mode;
  const fd = new FormData(form);
  const email = String(fd.get('email') || '').trim();
  const password = String(fd.get('password') || '');
  if (mode === 'login') {
    await q(sb.auth.signInWithPassword({ email, password }));
  } else if (mode === 'signup') {
    const name = String(fd.get('name') || '').trim();
    const data = await q(sb.auth.signUp({
      email, password, options: { data: { name }, emailRedirectTo: redirectUrl() },
    }));
    if (!data.session) {
      toast('확인 메일을 보냈습니다. 메일의 링크를 누른 뒤 로그인하세요.');
      showAuth('login');
    }
  } else if (mode === 'forgot') {
    await q(sb.auth.resetPasswordForEmail(email, { redirectTo: redirectUrl() }));
    toast('재설정 메일을 보냈습니다. 받은 메일함을 확인하세요.');
    showAuth('login');
  } else if (mode === 'reset') {
    await q(sb.auth.updateUser({ password }));
    state.recovery = false;
    toast('비밀번호를 변경했습니다.');
    const { data } = await sb.auth.getSession();
    await onAuth('SIGNED_IN', data.session);
  }
}

async function onAuth(event, session) {
  if (event === 'PASSWORD_RECOVERY') { state.recovery = true; showAuth('reset'); return; }
  if (state.recovery) return;
  if (!session) {
    state.user = null; state.me = null; state.booting = null; state.detail = null;
    showAuth('login');
    return;
  }
  if ((state.loaded && state.user?.id === session.user.id) || state.booting === session.user.id) return;
  state.user = session.user;
  state.booting = session.user.id;
  try { await bootApp(); } catch (e) { fail(e); } finally { state.booting = null; }
}

async function bootApp() {
  await loadBase();
  if (!state.me) throw new Error('프로필을 찾을 수 없습니다. 관리자에게 문의하세요.');
  if (!state.me.is_active) {
    toast('비활성화된 계정입니다. 관리자에게 문의하세요.', 'error');
    await sb.auth.signOut();
    return;
  }
  state.loaded = true;
  $('#boot').hidden = true;
  $('#auth-screen').hidden = true;
  $('#app').hidden = false;
  await route();
}

// -------------------------------------------------------------
// 데이터 로드
// -------------------------------------------------------------
async function loadBase() {
  const [profiles, teams, members, labels, projects] = await Promise.all([
    q(sb.from('profiles').select('*').order('name')),
    q(sb.from('teams').select('*').order('name')),
    q(sb.from('team_members').select('*')),
    q(sb.from('labels').select('*').order('name')),
    q(sb.from('projects').select('*').order('created_at')),
  ]);
  state.profiles = new Map(profiles.map((p) => [p.id, p]));
  state.teams = teams;
  state.members = members;
  state.labels = labels;
  state.projects = projects;
  state.me = state.profiles.get(state.user.id) || null;
}
async function refreshBase() {
  await loadBase();
  if (state.view.type === 'teams') await loadOrganizationHistory();
  renderSidebar();
}

async function loadOrganizationHistory() {
  const { data, error } = await sb.from('organization_history').select('*')
    .order('created_at', { ascending: false }).limit(200);
  state.organizationHistoryAvailable = !error;
  state.organizationHistory = error ? [] : data;
}

const norm = (t) => ({
  ...t,
  assignee_ids: (t.task_assignees || []).map((a) => a.user_id),
  label_ids: (t.task_labels || []).map((l) => l.label_id),
});

async function loadProjectTasks(projectId, trash = false) {
  let qb = sb.from('tasks').select(TASK_SELECT).eq('project_id', projectId);
  qb = trash
    ? qb.not('deleted_at', 'is', null).order('deleted_at', { ascending: false })
    : qb.is('deleted_at', null).order('sort_order').order('created_at');
  state.tasks = (await q(qb)).map(norm);
}

async function loadMyTasks() {
  const rows = await q(sb.from('task_assignees').select('task_id').eq('user_id', state.me.id));
  const ids = [...new Set(rows.map((r) => r.task_id))];
  state.tasks = ids.length
    ? (await q(sb.from('tasks').select(TASK_SELECT).in('id', ids).is('deleted_at', null))).map(norm)
    : [];
}

// -------------------------------------------------------------
// 라우팅  (#/my, #/teams, #/project/:id, #/trash/:id)
// -------------------------------------------------------------
async function route() {
  const [type, rawId] = location.hash.replace(/^#\/?/, '').split('/');
  const id = Number(rawId);
  state.detail = null;
  renderDrawer();
  $('#app').classList.remove('sidebar-open');
  $('#main').innerHTML = '<div class="loading"><div class="spinner"></div></div>';

  if ((type === 'project' || type === 'trash') && id) {
    state.view = { type, id };
    if (projectById(id)) await loadProjectTasks(id, type === 'trash');
    else state.tasks = [];
  } else if (type === 'teams') {
    state.view = { type: 'teams' };
    state.tasks = [];
    await loadOrganizationHistory();
  } else {
    state.view = { type: 'my' };
    await loadMyTasks();
  }
  renderSidebar();
  renderMain();
}
function navigate(hash) {
  if (location.hash === hash) guard(route)();
  else location.hash = hash;
}

// -------------------------------------------------------------
// 사이드바
// -------------------------------------------------------------
function renderSidebar() {
  const me = state.me;
  const v = state.view;
  const projects = state.projects.filter((p) => state.showArchived || !p.archived_at);
  const groups = new Map();
  const add = (key, title, p) => {
    if (!groups.has(key)) groups.set(key, { title, items: [] });
    groups.get(key).items.push(p);
  };
  for (const p of projects) {
    if (p.team_id) add(`t${p.team_id}`, teamById(p.team_id)?.name ?? '팀', p);
    else if (p.owner_id === me.id) add('mine', '개인', p);
    else add('others', '전사 공개', p);
  }
  const ordered = [
    groups.get('mine'),
    ...[...groups.entries()].filter(([k]) => k.startsWith('t'))
      .map(([, g]) => g).sort((a, b) => a.title.localeCompare(b.title, 'ko')),
    groups.get('others'),
  ].filter(Boolean);

  const projectLink = (p) => {
    const active = (v.type === 'project' || v.type === 'trash') && v.id === p.id;
    return `<a class="nav-item${active ? ' active' : ''}${p.archived_at ? ' archived' : ''}" href="#/project/${p.id}">
      <span class="vis-dot ${p.visibility}" title="${VIS[p.visibility]}"></span>
      <span class="nav-text">${esc(p.name)}</span>
      ${p.archived_at ? '<span class="mini-badge">보관</span>' : ''}</a>`;
  };

  $('#sidebar').innerHTML = `
    <div class="brand"><span class="logo">✓</span> 사내 TODO</div>
    <div class="me-card">
      ${avatar(me.id)}
      <div class="me-info">
        <div class="me-name">${esc(me.name)} ${isAdmin() ? '<span class="mini-badge admin">관리자</span>' : ''}</div>
        <div class="me-sub">${esc(me.department || me.email)}</div>
      </div>
      <div class="me-actions">
        <button class="icon-btn" data-action="edit-profile" title="프로필 수정" aria-label="프로필 수정">⚙</button>
        <button class="icon-btn" data-action="logout" title="로그아웃" aria-label="로그아웃">⎋</button>
      </div>
    </div>
    <nav class="nav">
      <a class="nav-item${v.type === 'my' ? ' active' : ''}" href="#/my"><span class="nav-ico">◎</span><span class="nav-text">내 할 일</span></a>
      <a class="nav-item${v.type === 'teams' ? ' active' : ''}" href="#/teams"><span class="nav-ico">◇</span><span class="nav-text">팀 · 구성원</span></a>
    </nav>
    <div class="side-section">
      <span>프로젝트</span>
      <button class="icon-btn sm" data-action="new-project" title="새 프로젝트" aria-label="새 프로젝트">＋</button>
    </div>
    <div class="project-groups">
      ${ordered.length ? ordered.map((g) => `
        <div class="group-title">${esc(g.title)}</div>
        ${g.items.map(projectLink).join('')}`).join('')
        : '<p class="side-empty">아직 프로젝트가 없습니다.<br><button class="link" data-action="new-project">프로젝트 만들기</button></p>'}
    </div>
    <label class="side-toggle"><input type="checkbox" data-change="toggle-archived" ${state.showArchived ? 'checked' : ''}> 보관된 프로젝트 표시</label>`;
}

// -------------------------------------------------------------
// 메인 화면
// -------------------------------------------------------------
function renderMain() {
  const t = state.view.type;
  if (t === 'teams') renderTeamsView();
  else if (t === 'project' || t === 'trash') renderProjectView();
  else renderMyView();
}

function filterBar() {
  // 보드는 상태별 칸 자체가 필터 역할을 하므로 중복 도구 모음을 숨깁니다.
  if (state.view.type === 'project' && state.projectView === 'board') return '';
  const f = state.filter;
  return `<div class="toolbar">
    <div class="chips">${STATUS_FILTERS.map(([k, l]) =>
      `<button class="chip${f.status === k ? ' on' : ''}" data-action="filter-status" data-v="${k}">${l}</button>`).join('')}</div>
    <div class="toolbar-right">
      <input type="search" class="input sm" placeholder="검색" value="${esc(f.q)}" data-input="search" aria-label="검색">
      <select class="input sm" data-change="sort" aria-label="정렬">
        <option value="default"${f.sort === 'default' ? ' selected' : ''}>등록순</option>
        <option value="due"${f.sort === 'due' ? ' selected' : ''}>마감일순</option>
        <option value="priority"${f.sort === 'priority' ? ' selected' : ''}>우선순위순</option>
      </select>
    </div>
  </div>`;
}

function renderMyView() {
  const open = state.tasks.filter((t) => t.status === 'todo' || t.status === 'in_progress');
  const td = today();
  const stats = [
    ['진행 중인 일', open.length, ''],
    ['오늘 마감', open.filter((t) => t.due_date === td).length, 'today'],
    ['기한 지남', open.filter((t) => t.due_date && t.due_date < td).length, 'overdue'],
    ['완료', state.tasks.filter((t) => t.status === 'done').length, 'done'],
  ];
  $('#main').innerHTML = `
    <header class="main-head">${menuBtn()}
      <div class="head-title"><h1>내 할 일</h1>
        <div class="head-sub">나에게 배정된 모든 프로젝트의 할 일</div></div>
    </header>
    <div class="stats">${stats.map(([l, n, c]) => `<div class="stat ${c}"><div class="stat-n">${n}</div><div class="stat-l">${l}</div></div>`).join('')}</div>
    ${filterBar()}
    <div id="task-list" class="task-list"></div>`;
  renderTaskList();
}

function renderProjectView() {
  const p = projectById(state.view.id);
  if (!p) {
    $('#main').innerHTML = `<header class="main-head">${menuBtn()}<div class="head-title"><h1>프로젝트를 찾을 수 없습니다</h1></div></header>
      ${empty('접근 권한이 없거나 삭제된 프로젝트입니다.')}`;
    return;
  }
  const trash = state.view.type === 'trash';
  const canEdit = canEditProject(p);
  const team = p.team_id ? teamById(p.team_id) : null;
  $('#main').innerHTML = `
    <header class="main-head">${menuBtn()}
      <div class="head-title">
        <h1>${esc(p.name)}${trash ? ' <span class="muted">· 휴지통</span>' : ''}</h1>
        <div class="head-sub">
          <span class="vis-badge ${p.visibility}">${VIS[p.visibility]}</span>
          <span>${team ? esc(team.name) : '개인 프로젝트'}</span><span class="dot">·</span>
          <span>소유자 ${esc(userName(p.owner_id))}</span>
          ${p.archived_at ? '<span class="vis-badge archived">보관됨</span>' : ''}
          ${!canEdit ? '<span class="vis-badge readonly">읽기 전용</span>' : ''}
        </div>
        ${p.description ? `<p class="head-desc">${esc(p.description)}</p>` : ''}
      </div>
      <div class="head-actions">
        ${trash ? `<a class="btn ghost" href="#/project/${p.id}">← 목록으로</a>`
                : `<a class="btn ghost" href="#/trash/${p.id}">휴지통</a>`}
        ${canManageProject(p) ? `<button class="btn ghost" data-action="edit-project" data-id="${p.id}">설정</button>` : ''}
      </div>
    </header>
    ${trash ? '<p class="hint pad">휴지통의 할 일은 복구하거나 영구 삭제할 수 있습니다.</p>' : filterBar()}
    ${!trash ? projectViewSwitch() : ''}
    ${!trash && canEdit && !p.archived_at ? addTaskForm(p) : ''}
    <div id="task-list" class="task-list"></div>`;
  renderTaskList();
}

function addTaskForm(p) {
  const cands = assigneeCandidates(p);
  const meIn = cands.some((u) => u.id === state.me.id);
  return `<form class="add-task" data-form="add-task" autocomplete="off">
    <input name="title" class="input grow" placeholder="+ 새 할 일을 입력하고 Enter" maxlength="300" required aria-label="할 일 제목">
    <select name="priority" class="input sm" aria-label="우선순위">
      <option value="1">우선 높음</option><option value="2" selected>우선 보통</option><option value="3">우선 낮음</option></select>
    <input type="date" name="due_date" class="input sm" aria-label="마감일">
    <select name="assignee" class="input sm" aria-label="담당자">
      <option value="">담당자 없음</option>
      ${cands.map((u) => `<option value="${u.id}"${meIn && u.id === state.me.id ? ' selected' : ''}>${esc(u.name)}${u.id === state.me.id ? ' (나)' : ''}</option>`).join('')}
    </select>
    <button class="btn primary" type="submit">추가</button>
  </form>`;
}

function projectViewSwitch() {
  return `<div class="view-switch" role="group" aria-label="프로젝트 보기 방식">
    <button class="view-button${state.projectView === 'list' ? ' on' : ''}" data-action="set-project-view" data-view="list">목록</button>
    <button class="view-button${state.projectView === 'board' ? ' on' : ''}" data-action="set-project-view" data-view="board">보드</button>
  </div>`;
}

function statusMatch(s) {
  const f = state.filter.status;
  if (f === 'all') return true;
  if (f === 'open') return s === 'todo' || s === 'in_progress';
  return s === f;
}
function textMatch(t) {
  const qq = state.filter.q.trim().toLowerCase();
  return !qq || t.title.toLowerCase().includes(qq) || (t.description || '').toLowerCase().includes(qq);
}
function sortTasks(list) {
  const s = state.filter.sort;
  const by = {
    default: (a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at),
    due: (a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999') || a.priority - b.priority,
    priority: (a, b) => a.priority - b.priority || (a.due_date || '9999').localeCompare(b.due_date || '9999'),
  }[s];
  return [...list].sort(by);
}

function taskRow(t, { child = false, showProject = false } = {}) {
  const p = projectById(t.project_id);
  const canEdit = canEditProject(p);
  const subs = state.tasks.filter((s) => s.parent_id === t.id);
  const subDone = subs.filter((s) => s.status === 'done').length;
  const td = today();
  const open = t.status === 'todo' || t.status === 'in_progress';
  const dueCls = !t.due_date || !open ? '' : t.due_date < td ? 'overdue' : t.due_date === td ? 'today' : '';
  const labels = t.label_ids.map(labelById).filter(Boolean);
  const parent = t.parent_id ? state.tasks.find((x) => x.id === t.parent_id) : null;
  const meta = [
    showProject && p ? `<span class="tag">${esc(p.name)}</span>` : '',
    showProject && parent ? `<span class="meta-item">↳ ${esc(parent.title)}</span>` : '',
    t.status === 'in_progress' || t.status === 'canceled' ? `<span class="status s-${t.status}">${STATUS[t.status]}</span>` : '',
    subs.length ? `<span class="meta-item">☑ ${subDone}/${subs.length}</span>` : '',
    ...labels.map((l) => labelChip(l)),
  ].filter(Boolean).join('');
  return `<div class="task-row${child ? ' child' : ''} st-${t.status}${state.detail?.id === t.id ? ' active' : ''}"
      data-action="open-task" data-id="${t.id}" tabindex="0">
    <input type="checkbox" class="check" data-action="toggle-done" data-id="${t.id}"
      ${t.status === 'done' ? 'checked' : ''} ${canEdit ? '' : 'disabled'} aria-label="완료 표시">
    <div class="task-main">
      <div class="task-title"><span class="prio p${t.priority}" title="우선순위 ${PRIORITY[t.priority]}"></span>${esc(t.title)}</div>
      ${meta ? `<div class="task-meta">${meta}</div>` : ''}
    </div>
    ${t.due_date ? `<span class="due ${dueCls}" title="마감 ${t.due_date}">${dueLabel(t.due_date)}</span>` : ''}
    <div class="avatars">${t.assignee_ids.slice(0, 3).map(avatar).join('')}${
      t.assignee_ids.length > 3 ? `<span class="avatar more">+${t.assignee_ids.length - 3}</span>` : ''}</div>
  </div>`;
}

function renderTaskList() {
  const el = $('#task-list');
  if (!el) return;
  const v = state.view.type;

  if (v === 'project' && state.projectView === 'board') {
    renderBoard(el);
    return;
  }

  if (v === 'trash') {
    const p = projectById(state.view.id);
    const canManage = canManageProject(p);
    const canEdit = canEditProject(p);
    el.innerHTML = state.tasks.length ? state.tasks.map((t) => `
      <div class="task-row trash">
        <div class="task-main">
          <div class="task-title">${t.parent_id ? '<span class="muted">↳ </span>' : ''}${esc(t.title)}</div>
          <div class="task-meta"><span class="meta-item">삭제 ${fmtDateTime(t.deleted_at)}</span>
            <span class="meta-item">작성 ${esc(userName(t.created_by))}</span></div>
        </div>
        ${canEdit ? `<button class="btn ghost sm" data-action="restore" data-id="${t.id}">복구</button>` : ''}
        ${canManage || t.created_by === state.me.id ? `<button class="btn ghost sm danger-text" data-action="hard-delete" data-id="${t.id}">영구 삭제</button>` : ''}
      </div>`).join('') : empty('휴지통이 비어 있습니다.');
    return;
  }

  const match = (t) => statusMatch(t.status) && textMatch(t);
  const rows = [];
  if (v === 'my') {
    sortTasks(state.tasks.filter(match)).forEach((t) => rows.push(taskRow(t, { showProject: true })));
  } else {
    const ids = new Set(state.tasks.map((t) => t.id));
    const tops = sortTasks(state.tasks.filter((t) => !t.parent_id || !ids.has(t.parent_id)));
    for (const t of tops) {
      const kids = sortTasks(state.tasks.filter((c) => c.parent_id === t.id)).filter(match);
      if (!match(t) && !kids.length) continue;
      rows.push(taskRow(t));
      kids.forEach((k) => rows.push(taskRow(k, { child: true })));
    }
  }
  if (rows.length) { el.innerHTML = rows.join(''); return; }
  const filtered = state.filter.status !== 'all' || state.filter.q;
  el.innerHTML = empty(state.tasks.length && filtered
    ? '조건에 맞는 할 일이 없습니다.'
    : v === 'my' ? '배정된 할 일이 없습니다. 🎉' : '아직 할 일이 없습니다. 위 입력창에서 추가해 보세요.');
}

function boardCard(t) {
  const labels = t.label_ids.map(labelById).filter(Boolean);
  return `<article class="board-card st-${t.status}" draggable="true" data-action="open-task" data-id="${t.id}">
    <div class="board-card-top"><span class="prio p${t.priority}"></span><span class="board-card-title">${esc(t.title)}</span></div>
    ${labels.length ? `<div class="task-meta">${labels.map((l) => labelChip(l)).join('')}</div>` : ''}
    <div class="board-card-foot">${t.due_date ? `<span class="due">${dueLabel(t.due_date)}</span>` : '<span></span>'}<span class="avatars">${t.assignee_ids.slice(0, 3).map(avatar).join('')}</span></div>
  </article>`;
}

function renderBoard(el) {
  const topTasks = state.tasks.filter((t) => !t.parent_id);
  const columns = [['todo', '할 일'], ['in_progress', '진행 중'], ['done', '완료'], ['canceled', '취소']];
  el.className = 'board';
  el.innerHTML = columns.map(([status, title]) => {
    const tasks = sortTasks(topTasks.filter((t) => t.status === status));
    const collapsed = status === 'canceled' && state.canceledCollapsed;
    return `<section class="board-column${collapsed ? ' collapsed' : ''}" data-status="${status}">
      <header class="board-column-head"><h2>${title}<span>${tasks.length}</span></h2>${status === 'canceled' ? `<button class="icon-btn sm" data-action="toggle-canceled" aria-label="취소 칸 ${collapsed ? '펼치기' : '접기'}">${collapsed ? '⌄' : '⌃'}</button>` : ''}</header>
      <div class="board-dropzone" data-status="${status}">${collapsed ? '' : (tasks.map(boardCard).join('') || '<p class="board-empty">카드를 끌어오세요</p>')}</div>
    </section>`;
  }).join('');
}

async function saveBoardDrop(taskId, nextStatus, orderedIds) {
  const task = findTask(taskId);
  if (!task || !canEditProject(projectById(task.project_id))) return;
  const writes = [];
  if (task.status !== nextStatus) writes.push(q(sb.from('tasks').update({ status: nextStatus }).eq('id', task.id).select().single()));
  orderedIds.forEach((id, index) => writes.push(q(sb.from('tasks').update({ sort_order: (index + 1) * 10 }).eq('id', id))));
  await Promise.all(writes);
  await loadProjectTasks(state.view.id);
  renderTaskList();
}

// -------------------------------------------------------------
// 할 일 상세 (오른쪽 패널)
// -------------------------------------------------------------
function findTask(id) {
  const d = state.detail;
  return state.tasks.find((t) => t.id === id)
    || (d?.task?.id === id ? d.task : null)
    || d?.subtasks.find((s) => s.id === id) || null;
}
function upsertLocal(row) {
  const i = state.tasks.findIndex((t) => t.id === row.id);
  if (i >= 0) state.tasks[i] = row;
  const d = state.detail;
  if (d) {
    if (d.task?.id === row.id) d.task = row;
    const j = d.subtasks.findIndex((s) => s.id === row.id);
    if (j >= 0) d.subtasks[j] = row;
  }
}

async function openTask(id) {
  state.detail = { id, task: findTask(id), subtasks: [], comments: [], attachments: [], activities: [], loading: true };
  renderDrawer();
  renderTaskList();
  await loadDetail();
}

const DETAIL_QUERIES = {
  task: (id) => sb.from('tasks').select(TASK_SELECT).eq('id', id).single(),
  subtasks: (id) => sb.from('tasks').select(TASK_SELECT).eq('parent_id', id).is('deleted_at', null).order('sort_order').order('created_at'),
  comments: (id) => sb.from('task_comments').select('*').eq('task_id', id).is('deleted_at', null).order('created_at'),
  attachments: (id) => sb.from('task_attachments').select('*').eq('task_id', id).order('created_at'),
  activities: (id) => sb.from('task_activities').select('*').eq('task_id', id).order('created_at', { ascending: false }).limit(50),
};

async function loadDetail() {
  const id = state.detail.id;
  const keys = Object.keys(DETAIL_QUERIES);
  const results = await Promise.all(keys.map((k) => q(DETAIL_QUERIES[k](id))));
  if (state.detail?.id !== id) return;
  keys.forEach((k, i) => { state.detail[k] = results[i]; });
  state.detail.task = norm(state.detail.task);
  state.detail.subtasks = state.detail.subtasks.map(norm);
  state.detail.loading = false;
  upsertLocal(state.detail.task);
  renderDrawer();
}

const PART_RENDER = { comments: commentsHtml, attachments: attachmentsHtml, activities: activitiesHtml };
async function reloadPart(part) {
  const d = state.detail;
  if (!d) return;
  const id = d.id;
  const data = await q(DETAIL_QUERIES[part](id));
  if (state.detail?.id !== id) return;
  d[part] = data;
  const el = $(`#part-${part}`);
  if (el) el.innerHTML = PART_RENDER[part]();
}

function closeDrawer() {
  state.detail = null;
  renderDrawer();
  renderTaskList();
}

function renderDrawer() {
  const el = $('#drawer');
  const d = state.detail;
  $('#app').classList.toggle('drawer-open', !!d);
  if (!d) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  const t = d.task;
  const closeBtn = '<button class="icon-btn" data-action="close-drawer" aria-label="닫기">✕</button>';
  if (!t) {
    el.innerHTML = `<div class="drawer-head"><span class="muted">불러오는 중…</span>${closeBtn}</div>`;
    return;
  }
  const p = projectById(t.project_id);
  const canEdit = canEditProject(p) && !t.deleted_at;
  const dis = canEdit ? '' : 'disabled';
  const parent = t.parent_id ? findTask(t.parent_id) : null;

  const assCands = p ? assigneeCandidates(p).filter((u) => !t.assignee_ids.includes(u.id)) : [];
  const labCands = p ? labelCandidates(p).filter((l) => !t.label_ids.includes(l.id)) : [];
  const labels = t.label_ids.map(labelById).filter(Boolean);

  el.innerHTML = `
    <div class="drawer-head">
      <div class="crumb">${p ? `<a href="#/project/${p.id}">${esc(p.name)}</a>` : ''}
        ${t.parent_id ? ` <span class="muted">›</span> <button class="link" data-action="open-task" data-id="${t.parent_id}">${esc(parent?.title ?? '상위 할 일')}</button>` : ''}</div>
      ${closeBtn}
    </div>
    <div class="drawer-body">
      <textarea class="title-input" data-change="task-field" data-field="title" rows="1" maxlength="300" ${dis}
        aria-label="제목">${esc(t.title)}</textarea>

      <div class="prop-grid">
        <label>상태</label>
        <select class="input sm" data-change="task-field" data-field="status" ${dis}>
          ${Object.entries(STATUS).map(([k, l]) => `<option value="${k}"${t.status === k ? ' selected' : ''}>${l}</option>`).join('')}
        </select>
        <label>우선순위</label>
        <select class="input sm" data-change="task-field" data-field="priority" ${dis}>
          ${Object.entries(PRIORITY).map(([k, l]) => `<option value="${k}"${t.priority === +k ? ' selected' : ''}>${l}</option>`).join('')}
        </select>
        <label>마감일</label>
        <input type="date" class="input sm" value="${t.due_date ?? ''}" data-change="task-field" data-field="due_date" ${dis}>
        <label>담당자</label>
        <div class="chips-wrap">
          ${t.assignee_ids.map((uid) => `<span class="person-chip">${avatar(uid)}${esc(userName(uid))}${
            canEdit ? `<button type="button" class="x" data-action="unassign" data-user="${uid}" aria-label="배정 해제">×</button>` : ''}</span>`).join('')
            || (canEdit && assCands.length ? '' : '<span class="muted">없음</span>')}
          ${canEdit && assCands.length ? `<select class="input xs" data-change="assign" aria-label="담당자 추가">
            <option value="">+ 추가</option>${assCands.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select>` : ''}
        </div>
        <label>라벨</label>
        <div class="chips-wrap">
          ${labels.map((l) => labelChip(l, canEdit)).join('') || (canEdit && labCands.length ? '' : '<span class="muted">없음</span>')}
          ${canEdit && labCands.length ? `<select class="input xs" data-change="add-label" aria-label="라벨 추가">
            <option value="">+ 추가</option>${labCands.map((l) => `<option value="${l.id}">${esc(l.name)}${l.team_id ? '' : ' (전사)'}</option>`).join('')}</select>` : ''}
        </div>
      </div>

      <div class="section">
        <div class="section-label">설명</div>
        <textarea class="input desc-input" rows="4" placeholder="${canEdit ? '설명을 입력하세요' : '설명 없음'}"
          data-change="task-field" data-field="description" ${dis}>${esc(t.description ?? '')}</textarea>
      </div>

      ${!t.parent_id ? `<div class="section">
        <div class="section-label">하위 작업 ${d.subtasks.length ? `<span class="muted">${d.subtasks.filter((s) => s.status === 'done').length}/${d.subtasks.length}</span>` : ''}</div>
        <div class="sub-list">${d.subtasks.map((s) => `
          <div class="sub-row st-${s.status}">
            <input type="checkbox" class="check" data-action="toggle-done" data-id="${s.id}" ${s.status === 'done' ? 'checked' : ''} ${dis}>
            <button class="link sub-title" data-action="open-task" data-id="${s.id}">${esc(s.title)}</button>
            ${s.assignee_ids.slice(0, 2).map(avatar).join('')}
          </div>`).join('') || (d.loading ? '<span class="muted">불러오는 중…</span>' : '')}</div>
        ${canEdit ? `<form class="inline-form" data-form="add-subtask" autocomplete="off">
          <input name="title" class="input sm grow" placeholder="+ 하위 작업 추가" maxlength="300" required>
          <button class="btn sm" type="submit">추가</button></form>` : ''}
      </div>` : ''}

      <div class="section">
        <div class="section-label">첨부파일</div>
        <div id="part-attachments">${attachmentsHtml()}</div>
        ${canEdit ? `<label class="btn ghost sm file-btn">파일 첨부 (최대 50MB)
          <input type="file" multiple data-change="upload" hidden></label>` : ''}
      </div>

      <div class="section">
        <div class="section-label">댓글</div>
        <div id="part-comments">${commentsHtml()}</div>
        <form class="comment-form" data-form="add-comment">
          <textarea name="content" class="input" rows="2" maxlength="5000" placeholder="댓글을 입력하세요 (Ctrl+Enter 등록)" required></textarea>
          <button class="btn primary sm" type="submit">등록</button>
        </form>
      </div>

      <div class="section">
        <div class="section-label">활동 기록</div>
        <div id="part-activities">${activitiesHtml()}</div>
      </div>

      <div class="drawer-foot">
        <div class="muted small">
          작성 ${esc(userName(t.created_by))} · ${fmtDateTime(t.created_at)}
          ${t.completed_at ? `<br>완료 ${esc(t.completed_by ? userName(t.completed_by) : '')} · ${fmtDateTime(t.completed_at)}` : ''}
        </div>
        ${canEdit ? '<button class="btn ghost sm danger-text" data-action="soft-delete">휴지통으로 이동</button>' : ''}
      </div>
    </div>`;
  autoGrow($('.title-input', el));
}

function attachmentsHtml() {
  const d = state.detail;
  const p = projectById(d.task?.project_id);
  if (!d.attachments.length) return d.loading ? '<span class="muted">불러오는 중…</span>' : '<span class="muted small">첨부파일 없음</span>';
  return `<div class="file-list">${d.attachments.map((a) => `
    <div class="file-row">
      <span class="file-ico">📎</span>
      <button class="link file-name" data-action="download" data-id="${a.id}" title="다운로드">${esc(a.file_name)}</button>
      <span class="muted small">${fmtSize(a.file_size)} · ${esc(userName(a.uploaded_by))}</span>
      ${a.uploaded_by === state.me.id || canManageProject(p)
        ? `<button class="x" data-action="delete-attachment" data-id="${a.id}" aria-label="첨부 삭제">×</button>` : ''}
    </div>`).join('')}</div>`;
}

function commentsHtml() {
  const d = state.detail;
  const p = projectById(d.task?.project_id);
  if (!d.comments.length) return d.loading ? '<span class="muted">불러오는 중…</span>' : '<span class="muted small">첫 댓글을 남겨 보세요.</span>';
  return d.comments.map((c) => {
    const mine = c.user_id === state.me.id;
    const edited = c.updated_at && new Date(c.updated_at) - new Date(c.created_at) > 1000;
    return `<div class="comment">
      <div class="comment-head">${avatar(c.user_id)}<b>${esc(userName(c.user_id))}</b>
        <span class="muted small">${fmtDateTime(c.created_at)}${edited ? ' (수정됨)' : ''}</span>
        <span class="spacer"></span>
        ${mine ? `<button class="link small" data-action="edit-comment" data-id="${c.id}">수정</button>` : ''}
        ${mine || canManageProject(p) ? `<button class="link small danger-text" data-action="delete-comment" data-id="${c.id}">삭제</button>` : ''}
      </div>
      <div class="comment-body">${esc(c.content)}</div>
    </div>`;
  }).join('');
}

function activityText(a) {
  const who = a.user_id ? userName(a.user_id) : '시스템';
  const o = a.old_value; const n = a.new_value;
  switch (a.action) {
    case 'created': return `<b>${esc(who)}</b>님이 할 일을 만들었습니다`;
    case 'status_changed': return `<b>${esc(who)}</b>님이 상태를 ${STATUS[o] ?? o} → <b>${STATUS[n] ?? n}</b>(으)로 변경`;
    case 'title_changed': return `<b>${esc(who)}</b>님이 제목을 변경: “${esc(o)}” → “${esc(n)}”`;
    case 'due_date_changed': return `<b>${esc(who)}</b>님이 마감일을 ${o ?? '없음'} → <b>${n ?? '없음'}</b>(으)로 변경`;
    case 'priority_changed': return `<b>${esc(who)}</b>님이 우선순위를 ${PRIORITY[o] ?? o} → <b>${PRIORITY[n] ?? n}</b>(으)로 변경`;
    case 'project_changed': return `<b>${esc(who)}</b>님이 프로젝트를 이동: ${esc(projectById(o)?.name ?? o)} → ${esc(projectById(n)?.name ?? n)}`;
    case 'deleted': return `<b>${esc(who)}</b>님이 휴지통으로 이동`;
    case 'restored': return `<b>${esc(who)}</b>님이 복구`;
    case 'assigned': return `<b>${esc(who)}</b>님이 <b>${esc(userName(n?.user_id))}</b>님을 담당자로 지정`;
    case 'unassigned': return `<b>${esc(who)}</b>님이 <b>${esc(userName(o?.user_id))}</b>님의 배정을 해제`;
    default: return esc(a.action);
  }
}
function activitiesHtml() {
  const d = state.detail;
  if (!d.activities.length) return d.loading ? '<span class="muted">불러오는 중…</span>' : '<span class="muted small">기록 없음</span>';
  return `<ul class="activity">${d.activities.map((a) =>
    `<li><span>${activityText(a)}</span><span class="muted small">${fmtDateTime(a.created_at)}</span></li>`).join('')}</ul>`;
}

function autoGrow(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

async function updateTask(id, patch, { redraw = true } = {}) {
  const row = norm(await q(sb.from('tasks').update(patch).eq('id', id).select(TASK_SELECT).single()));
  upsertLocal(row);
  renderTaskList();
  if (state.detail) {
    if (redraw) renderDrawer();
    if (state.detail.id === id) reloadPart('activities').catch(() => {});
  }
  return row;
}
async function refreshTask(id) {
  const row = norm(await q(DETAIL_QUERIES.task(id)));
  upsertLocal(row);
  renderTaskList();
  renderDrawer();
  reloadPart('activities').catch(() => {});
}

// -------------------------------------------------------------
// 팀 · 구성원 화면
// -------------------------------------------------------------
function renderTeamsView() {
  const admin = isAdmin();
  $('#main').innerHTML = `
    <header class="main-head">${menuBtn()}
      <div class="head-title"><h1>팀 · 구성원</h1>
        <div class="head-sub">팀 구성과 라벨을 관리합니다${admin ? '' : ' · 팀 생성은 관리자만 가능합니다'}</div></div>
      <div class="head-actions">${admin ? '<button class="btn primary" data-action="new-team">+ 팀 만들기</button>' : ''}</div>
    </header>
    <div class="page">
      <h2 class="section-title">팀</h2>
      <div class="cards">${state.teams.map(teamCard).join('') || empty(`아직 팀이 없습니다.${admin ? ' 팀을 만들어 보세요.' : ''}`)}</div>

      <h2 class="section-title">전사 공통 라벨</h2>
      <div class="card">${labelEditor(null, admin)}
        ${admin ? '' : '<p class="hint">전사 라벨은 관리자만 추가·삭제할 수 있습니다.</p>'}</div>

      <h2 class="section-title">구성원</h2>
      <div class="card table-card">${peopleTable(admin)}</div>

      <h2 class="section-title">조직 변경 이력</h2>
      <div class="card table-card">${organizationHistoryTable()}</div>
    </div>`;
}

function teamCard(team) {
  const admin = isAdmin();
  const canMng = admin || isLeader(team.id);
  const members = state.members.filter((m) => m.team_id === team.id)
    .map((m) => ({ ...m, p: state.profiles.get(m.user_id) }))
    .filter((m) => m.p)
    .sort((a, b) => (a.role === 'leader' ? 0 : 1) - (b.role === 'leader' ? 0 : 1) || a.p.name.localeCompare(b.p.name, 'ko'));
  const memberIds = new Set(members.map((m) => m.user_id));
  const nonMembers = [...state.profiles.values()].filter((u) => u.is_active && !memberIds.has(u.id))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  return `<div class="card">
    <div class="card-head">
      <div><h3>${esc(team.name)}</h3>${team.description ? `<p class="muted small">${esc(team.description)}</p>` : ''}</div>
      <div class="card-actions">
        ${canMng ? `<button class="btn ghost xs" data-action="edit-team" data-id="${team.id}">수정</button>` : ''}
        ${admin ? `<button class="btn ghost xs danger-text" data-action="delete-team" data-id="${team.id}">삭제</button>` : ''}
      </div>
    </div>
    <ul class="member-list">${members.map((m) => `
      <li class="${m.p.is_active ? '' : 'inactive'}">${avatar(m.user_id)}
        <span class="m-name">${esc(m.p.name)}</span>
        ${m.role === 'leader' ? '<span class="mini-badge leader">팀장</span>' : ''}
        <span class="muted small">${esc([m.p.department, m.p.position].filter(Boolean).join(' · '))}</span>
        <span class="spacer"></span>
        ${canMng ? `<button class="btn ghost xs" data-action="toggle-leader" data-team="${team.id}" data-user="${m.user_id}">${m.role === 'leader' ? '팀원으로' : '팀장으로'}</button>
          <button class="btn ghost xs danger-text" data-action="remove-member" data-team="${team.id}" data-user="${m.user_id}">${m.user_id === state.me.id ? '탈퇴' : '제거'}</button>`
          : m.user_id === state.me.id ? `<button class="btn ghost xs danger-text" data-action="remove-member" data-team="${team.id}" data-user="${m.user_id}">탈퇴</button>` : ''}
      </li>`).join('') || '<li class="muted small">팀원이 없습니다.</li>'}
    </ul>
    ${canMng && nonMembers.length ? `<form class="inline-form" data-form="add-member" data-team="${team.id}">
      <select name="user_id" class="input sm grow" required aria-label="추가할 구성원">
        <option value="">구성원 선택…</option>
        ${nonMembers.map((u) => `<option value="${u.id}">${esc(u.name)}${u.department ? ` · ${esc(u.department)}` : ''}</option>`).join('')}
      </select>
      <select name="role" class="input sm" aria-label="역할"><option value="member">팀원</option><option value="leader">팀장</option></select>
      <button class="btn sm" type="submit">추가</button>
    </form>` : ''}
    <div class="sub-title">팀 라벨</div>
    ${labelEditor(team.id, canMng)}
  </div>`;
}

function labelEditor(teamId, can) {
  const ls = state.labels.filter((l) => (l.team_id ?? null) === teamId);
  return `<div class="chips-wrap">${ls.map((l) => `<span class="label-chip" style="--c:${esc(l.color)}">${esc(l.name)}${
    can ? `<button type="button" class="x" data-action="delete-label" data-id="${l.id}" aria-label="라벨 삭제">×</button>` : ''}</span>`).join('')
    || '<span class="muted small">라벨 없음</span>'}</div>
  ${can ? `<form class="inline-form" data-form="add-label-def" data-team="${teamId ?? ''}" autocomplete="off">
    <input name="name" class="input sm grow" placeholder="새 라벨 이름" maxlength="50" required>
    <input type="color" name="color" value="#3b5bfd" class="color-input" aria-label="라벨 색상">
    <button class="btn sm" type="submit">추가</button></form>` : ''}`;
}

function peopleTable(admin) {
  const people = [...state.profiles.values()].sort((a, b) =>
    (b.is_active - a.is_active) || a.name.localeCompare(b.name, 'ko'));
  const teamsOf = (uid) => state.members.filter((m) => m.user_id === uid).map((m) => teamById(m.team_id)?.name).filter(Boolean);
  return `<table class="table">
    <thead><tr><th>이름</th><th>이메일</th><th>부서</th><th>직급</th><th>팀</th><th>권한</th><th>상태</th></tr></thead>
    <tbody>${people.map((u) => {
      const self = u.id === state.me.id;
      return `<tr class="${u.is_active ? '' : 'inactive'}">
        <td><div class="cell-user">${avatar(u.id)}${esc(u.name)}${self ? ' <span class="muted small">(나)</span>' : ''}</div></td>
        <td class="muted">${esc(u.email)}</td>
        <td>${admin ? `<input class="input xs history-field" data-change="admin-department" data-user="${u.id}" value="${esc(u.department ?? '')}" placeholder="부서">` : esc(u.department ?? '')}</td>
        <td>${admin ? `<input class="input xs history-field" data-change="admin-position" data-user="${u.id}" value="${esc(u.position ?? '')}" placeholder="직급">` : esc(u.position ?? '')}</td>
        <td class="small">${teamsOf(u.id).map(esc).join(', ')}</td>
        <td>${admin && !self ? `<select class="input xs" data-change="admin-role" data-user="${u.id}">
            <option value="member"${u.role === 'member' ? ' selected' : ''}>구성원</option>
            <option value="admin"${u.role === 'admin' ? ' selected' : ''}>관리자</option></select>`
          : (u.role === 'admin' ? '<span class="mini-badge admin">관리자</span>' : '구성원')}</td>
        <td>${admin && !self ? `<label class="switch"><input type="checkbox" data-change="admin-active" data-user="${u.id}" ${u.is_active ? 'checked' : ''}><span>${u.is_active ? '재직' : '비활성'}</span></label>`
          : (u.is_active ? '재직' : '비활성')}</td>
      </tr>`;
    }).join('')}</tbody></table>`;
}

function historyScalar(value) {
  if (value == null) return '없음';
  if (typeof value === 'boolean') return value ? '재직' : '비활성';
  if (typeof value === 'object') return value.name ?? value.role ?? JSON.stringify(value);
  return String(value);
}

function historyRole(value) {
  const role = value?.role ?? value;
  return role === 'leader' ? '팀장' : role === 'member' ? '팀원' : role === 'admin' ? '관리자' : historyScalar(role);
}

function organizationHistoryText(row) {
  const oldValue = row.old_value;
  const newValue = row.new_value;
  const teamName = teamById(row.team_id)?.name ?? oldValue?.name ?? newValue?.name ?? `팀 #${row.team_id}`;
  const person = row.user_id ? userName(row.user_id) : '';
  switch (row.action) {
    case 'team_created': return `팀 생성: ${historyScalar(newValue?.name)}`;
    case 'team_deleted': return `팀 삭제: ${historyScalar(oldValue?.name)}`;
    case 'team_updated': return oldValue?.name !== newValue?.name
      ? `팀 이름 변경: ${historyScalar(oldValue?.name)} → ${historyScalar(newValue?.name)}`
      : `${teamName} 설명 변경`;
    case 'team_member_added': return `${person}님을 ${teamName}에 추가 (${historyRole(newValue)})`;
    case 'team_member_removed': return `${person}님이 ${teamName}에서 제외됨`;
    case 'team_role_changed': return `${person}님의 ${teamName} 역할: ${historyRole(oldValue)} → ${historyRole(newValue)}`;
    case 'name_changed': return `이름 변경: ${historyScalar(oldValue)} → ${historyScalar(newValue)}`;
    case 'department_changed': return `${person}님의 부서: ${historyScalar(oldValue)} → ${historyScalar(newValue)}`;
    case 'position_changed': return `${person}님의 직급: ${historyScalar(oldValue)} → ${historyScalar(newValue)}`;
    case 'account_role_changed': return `${person}님의 권한: ${historyRole(oldValue)} → ${historyRole(newValue)}`;
    case 'active_status_changed': return `${person}님의 재직 상태: ${historyScalar(oldValue)} → ${historyScalar(newValue)}`;
    default: return row.action;
  }
}

function organizationHistoryTable() {
  if (!state.organizationHistoryAvailable) {
    return '<div class="empty">조직 이력 SQL을 먼저 실행하면 이력이 표시됩니다.</div>';
  }
  if (!state.organizationHistory.length) return '<div class="empty">아직 기록된 변경 이력이 없습니다.</div>';
  return `<table class="table history-table">
    <thead><tr><th>일시</th><th>변경 내용</th><th>변경한 사람</th></tr></thead>
    <tbody>${state.organizationHistory.map((row) => `<tr>
      <td class="muted small">${fmtDateTime(row.created_at)}</td>
      <td>${esc(organizationHistoryText(row))}</td>
      <td>${esc(row.changed_by ? userName(row.changed_by) : '시스템')}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

// -------------------------------------------------------------
// 모달: 프로젝트 / 팀 / 프로필
// -------------------------------------------------------------
function openProjectModal(p = null) {
  const myTeamIds = new Set(state.members.filter((m) => m.user_id === state.me.id).map((m) => m.team_id));
  const teams = state.teams.filter((t) => myTeamIds.has(t.id) || (p && (t.id === p.team_id || isAdmin())));
  const teamId = p ? p.team_id : (teams[0]?.id ?? null);
  const vis = p ? p.visibility : (teamId ? 'team' : 'private');
  const extra = p ? `
    <button type="button" class="btn ghost sm" data-action="archive-project" data-id="${p.id}">${p.archived_at ? '보관 해제' : '보관'}</button>
    <button type="button" class="btn ghost sm danger-text" data-action="delete-project" data-id="${p.id}">삭제</button>` : '';

  const form = openModal({
    title: p ? '프로젝트 설정' : '새 프로젝트',
    submitText: p ? '저장' : '만들기',
    extra,
    body: `
      <label class="field"><span>이름</span><input name="name" class="input" required maxlength="100" value="${esc(p?.name ?? '')}"></label>
      <label class="field"><span>설명</span><textarea name="description" class="input" rows="3">${esc(p?.description ?? '')}</textarea></label>
      <label class="field"><span>팀</span>
        <select name="team_id" class="input">
          <option value="">없음 (개인 프로젝트)</option>
          ${teams.map((t) => `<option value="${t.id}"${t.id === teamId ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}
        </select></label>
      <label class="field"><span>공개 범위</span>
        <select name="visibility" class="input">
          <option value="private"${vis === 'private' ? ' selected' : ''}>비공개 — 나만 보고 편집</option>
          <option value="team"${vis === 'team' ? ' selected' : ''}>팀 — 팀원이 보고 편집</option>
          <option value="company"${vis === 'company' ? ' selected' : ''}>전사 — 전 직원 조회, 편집은 소유자·팀원</option>
        </select></label>
      <p class="hint">비공개는 팀 없이, ‘팀’ 공개는 팀을 선택해야 합니다.${teams.length ? '' : ' 소속된 팀이 없어 개인 프로젝트만 만들 수 있습니다.'}</p>`,
    onSubmit: async (fd) => {
      const team_id = fd.get('team_id') ? Number(fd.get('team_id')) : null;
      const visibility = fd.get('visibility');
      if (visibility === 'team' && !team_id) { toast('‘팀’ 공개 프로젝트는 팀을 선택해야 합니다.', 'error'); return false; }
      if (visibility === 'private' && team_id) { toast('비공개 프로젝트는 팀을 지정할 수 없습니다.', 'error'); return false; }
      const payload = {
        name: String(fd.get('name')).trim(),
        description: String(fd.get('description') || '').trim() || null,
        team_id, visibility,
      };
      const row = p
        ? await q(sb.from('projects').update(payload).eq('id', p.id).select().single())
        : await q(sb.from('projects').insert({ ...payload, owner_id: state.me.id }).select().single());
      await refreshBase();
      toast(p ? '저장했습니다.' : '프로젝트를 만들었습니다.');
      closeModal();
      navigate(`#/project/${row.id}`);
    },
  });
  // 팀 ↔ 공개 범위 자동 맞춤
  const teamSel = form.elements.team_id;
  const visSel = form.elements.visibility;
  teamSel.addEventListener('change', () => {
    if (teamSel.value && visSel.value === 'private') visSel.value = 'team';
    if (!teamSel.value && visSel.value === 'team') visSel.value = 'private';
  });
  visSel.addEventListener('change', () => {
    if (visSel.value === 'private') teamSel.value = '';
    if (visSel.value === 'team' && !teamSel.value && teamSel.options.length > 1) teamSel.selectedIndex = 1;
  });
}

function openTeamModal(team = null) {
  openModal({
    title: team ? '팀 수정' : '새 팀',
    submitText: team ? '저장' : '만들기',
    body: `
      <label class="field"><span>팀 이름</span><input name="name" class="input" required maxlength="100" value="${esc(team?.name ?? '')}"></label>
      <label class="field"><span>설명</span><textarea name="description" class="input" rows="3">${esc(team?.description ?? '')}</textarea></label>`,
    onSubmit: async (fd) => {
      const payload = { name: String(fd.get('name')).trim(), description: String(fd.get('description') || '').trim() || null };
      if (team) await q(sb.from('teams').update(payload).eq('id', team.id).select().single());
      else await q(sb.from('teams').insert(payload));
      await refreshBase();
      renderTeamsView();
      toast(team ? '저장했습니다.' : '팀을 만들었습니다. 팀원을 추가하세요.');
    },
  });
}

function openProfileModal() {
  const me = state.me;
  openModal({
    title: '내 프로필',
    body: `
      <label class="field"><span>이메일</span><input class="input" value="${esc(me.email)}" disabled></label>
      <label class="field"><span>이름</span><input name="name" class="input" required maxlength="50" value="${esc(me.name)}"></label>
      <label class="field"><span>부서</span><input name="department" class="input" maxlength="100" value="${esc(me.department ?? '')}" placeholder="예: 개발팀"></label>
      <label class="field"><span>직급</span><input class="input" value="${esc(me.position ?? '')}" placeholder="관리자가 설정합니다" disabled></label>`,
    onSubmit: async (fd) => {
      await q(sb.from('profiles').update({
        name: String(fd.get('name')).trim(),
        department: String(fd.get('department') || '').trim() || null,
      }).eq('id', me.id).select().single());
      await refreshBase();
      renderMain();
      toast('프로필을 저장했습니다.');
    },
  });
}

// -------------------------------------------------------------
// 이벤트: 클릭
// -------------------------------------------------------------
const actions = {
  'auth-mode': (el) => showAuth(el.dataset.mode),
  'open-sidebar': () => $('#app').classList.add('sidebar-open'),
  'close-sidebar': () => $('#app').classList.remove('sidebar-open'),
  'modal-close': closeModal,
  logout: async () => { await sb.auth.signOut(); },
  'edit-profile': openProfileModal,

  'new-project': () => openProjectModal(),
  'edit-project': (el) => openProjectModal(projectById(+el.dataset.id)),
  'archive-project': async (el) => {
    const p = projectById(+el.dataset.id);
    await q(sb.from('projects').update({ archived_at: p.archived_at ? null : new Date().toISOString() }).eq('id', p.id).select().single());
    closeModal();
    await refreshBase();
    renderMain();
    toast(p.archived_at ? '보관을 해제했습니다.' : '프로젝트를 보관했습니다.');
  },
  'delete-project': (el) => {
    const p = projectById(+el.dataset.id);
    confirmModal('프로젝트 삭제', `<b>${esc(p.name)}</b> 프로젝트와 그 안의 모든 할 일·댓글·첨부 정보가 영구 삭제됩니다.<br>되돌릴 수 없습니다. 계속할까요?`, async () => {
      await q(sb.from('projects').delete().eq('id', p.id));
      await refreshBase();
      toast('프로젝트를 삭제했습니다.');
      closeModal();
      navigate('#/my');
    }, '영구 삭제');
  },

  'filter-status': (el) => {
    state.filter.status = el.dataset.v;
    document.querySelectorAll('.chip[data-action="filter-status"]').forEach((c) => c.classList.toggle('on', c === el));
    renderTaskList();
  },
  'set-project-view': (el) => {
    state.projectView = el.dataset.view;
    renderProjectView();
  },
  'toggle-canceled': () => {
    state.canceledCollapsed = !state.canceledCollapsed;
    renderTaskList();
  },
  'open-task': (el) => openTask(+el.dataset.id),
  'close-drawer': closeDrawer,
  'toggle-done': async (el) => {
    const t = findTask(+el.dataset.id);
    if (!t) return;
    await updateTask(t.id, { status: t.status === 'done' ? 'todo' : 'done' }).catch((e) => { el.checked = t.status === 'done'; throw e; });
  },
  unassign: async (el) => {
    const t = state.detail.task;
    await q(sb.from('task_assignees').delete().eq('task_id', t.id).eq('user_id', el.dataset.user));
    await refreshTask(t.id);
  },
  'remove-label': async (el) => {
    const t = state.detail?.task;
    if (!t) return;
    await q(sb.from('task_labels').delete().eq('task_id', t.id).eq('label_id', +el.dataset.id));
    await refreshTask(t.id);
  },
  download: async (el) => {
    const a = state.detail.attachments.find((x) => x.id === +el.dataset.id);
    const data = await q(sb.storage.from(BUCKET).createSignedUrl(a.storage_path, 60, { download: a.file_name }));
    const link = document.createElement('a');
    link.href = data.signedUrl;
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
  },
  'delete-attachment': (el) => {
    const a = state.detail.attachments.find((x) => x.id === +el.dataset.id);
    confirmModal('첨부 삭제', `<b>${esc(a.file_name)}</b> 파일을 삭제할까요?`, async () => {
      await q(sb.storage.from(BUCKET).remove([a.storage_path]));
      await q(sb.from('task_attachments').delete().eq('id', a.id));
      await reloadPart('attachments');
    }, '삭제');
  },
  'edit-comment': (el) => {
    const c = state.detail.comments.find((x) => x.id === +el.dataset.id);
    openModal({
      title: '댓글 수정',
      body: `<textarea name="content" class="input" rows="5" maxlength="5000" required>${esc(c.content)}</textarea>`,
      onSubmit: async (fd) => {
        await q(sb.from('task_comments').update({ content: String(fd.get('content')).trim() }).eq('id', c.id).select().single());
        await reloadPart('comments');
      },
    });
  },
  'delete-comment': (el) => {
    confirmModal('댓글 삭제', '이 댓글을 삭제할까요?', async () => {
      await q(sb.from('task_comments').delete().eq('id', +el.dataset.id));
      await reloadPart('comments');
    }, '삭제');
  },
  'soft-delete': () => {
    const t = state.detail.task;
    confirmModal('휴지통으로 이동', `<b>${esc(t.title)}</b>${t.parent_id ? '' : '와(과) 하위 작업'}을 휴지통으로 옮깁니다. 휴지통에서 복구할 수 있습니다.`, async () => {
      await q(sb.from('tasks').update({ deleted_at: new Date().toISOString() }).or(`id.eq.${t.id},parent_id.eq.${t.id}`));
      state.tasks = state.tasks.filter((x) => x.id !== t.id && x.parent_id !== t.id);
      closeDrawer();
      toast('휴지통으로 이동했습니다.');
    }, '이동');
  },
  restore: async (el) => {
    const id = +el.dataset.id;
    await q(sb.from('tasks').update({ deleted_at: null }).or(`id.eq.${id},parent_id.eq.${id}`));
    state.tasks = state.tasks.filter((x) => x.id !== id && x.parent_id !== id);
    renderTaskList();
    toast('복구했습니다.');
  },
  'hard-delete': (el) => {
    const id = +el.dataset.id;
    const t = state.tasks.find((x) => x.id === id);
    confirmModal('영구 삭제', `<b>${esc(t.title)}</b>을(를) 영구 삭제합니다. 댓글·첨부·기록도 함께 사라지며 되돌릴 수 없습니다.`, async () => {
      await q(sb.from('tasks').delete().eq('id', id));
      state.tasks = state.tasks.filter((x) => x.id !== id && x.parent_id !== id);
      renderTaskList();
      toast('영구 삭제했습니다.');
    }, '영구 삭제');
  },

  'new-team': () => openTeamModal(),
  'edit-team': (el) => openTeamModal(teamById(+el.dataset.id)),
  'delete-team': (el) => {
    const team = teamById(+el.dataset.id);
    const used = state.projects.some((p) => p.team_id === team.id);
    confirmModal('팀 삭제', `<b>${esc(team.name)}</b> 팀을 삭제할까요? 팀 라벨과 팀원 정보도 삭제됩니다.${
      used ? '<br><br>⚠️ 이 팀에 속한 프로젝트가 있으면 삭제할 수 없습니다. 먼저 프로젝트를 다른 팀으로 옮기거나 삭제하세요.' : ''}`, async () => {
      await q(sb.from('teams').delete().eq('id', team.id));
      await refreshBase();
      renderTeamsView();
      toast('팀을 삭제했습니다.');
    }, '삭제');
  },
  'toggle-leader': async (el) => {
    const m = state.members.find((x) => x.team_id === +el.dataset.team && x.user_id === el.dataset.user);
    await q(sb.from('team_members').update({ role: m.role === 'leader' ? 'member' : 'leader' })
      .eq('team_id', m.team_id).eq('user_id', m.user_id).select().single());
    await refreshBase();
    renderTeamsView();
  },
  'remove-member': (el) => {
    const teamId = +el.dataset.team;
    const uid = el.dataset.user;
    const self = uid === state.me.id;
    confirmModal(self ? '팀 탈퇴' : '팀원 제거',
      self ? `<b>${esc(teamById(teamId).name)}</b> 팀에서 탈퇴할까요?` : `<b>${esc(userName(uid))}</b>님을 <b>${esc(teamById(teamId).name)}</b> 팀에서 제거할까요?`,
      async () => {
        await q(sb.from('team_members').delete().eq('team_id', teamId).eq('user_id', uid));
        await refreshBase();
        renderTeamsView();
      }, self ? '탈퇴' : '제거');
  },
  'delete-label': (el) => {
    const l = labelById(+el.dataset.id);
    confirmModal('라벨 삭제', `<b>${esc(l.name)}</b> 라벨을 삭제할까요? 할 일에 붙은 이 라벨도 모두 제거됩니다.`, async () => {
      await q(sb.from('labels').delete().eq('id', l.id));
      await refreshBase();
      renderTeamsView();
    }, '삭제');
  },
};

// -------------------------------------------------------------
// 이벤트: 값 변경
// -------------------------------------------------------------
const changes = {
  'toggle-archived': (el) => { state.showArchived = el.checked; renderSidebar(); },
  sort: (el) => { state.filter.sort = el.value; renderTaskList(); },
  'task-field': async (el) => {
    const t = state.detail?.task;
    if (!t) return;
    const f = el.dataset.field;
    let v = el.value;
    if (f === 'title') {
      v = v.replace(/\s+/g, ' ').trim();
      if (!v) { el.value = t.title; toast('제목을 입력하세요.', 'error'); return; }
    } else if (f === 'description') v = v.trim() || null;
    else if (f === 'priority') v = Number(v);
    else if (f === 'due_date') v = v || null;
    if ((t[f] ?? null) === v) return;
    await updateTask(t.id, { [f]: v }, { redraw: f !== 'title' && f !== 'description' })
      .catch((e) => { el.value = t[f] ?? ''; throw e; });
  },
  assign: async (el) => {
    if (!el.value) return;
    const t = state.detail.task;
    await q(sb.from('task_assignees').insert({ task_id: t.id, user_id: el.value }));
    await refreshTask(t.id);
  },
  'add-label': async (el) => {
    if (!el.value) return;
    const t = state.detail.task;
    await q(sb.from('task_labels').insert({ task_id: t.id, label_id: +el.value }));
    await refreshTask(t.id);
  },
  upload: async (el) => {
    const files = [...el.files];
    el.value = '';
    const t = state.detail.task;
    for (const file of files) {
      if (file.size > MAX_FILE) { toast(`${file.name}: 50MB를 초과해 올릴 수 없습니다.`, 'error'); continue; }
      const m = file.name.match(/\.([A-Za-z0-9]{1,10})$/);
      const path = `${t.id}/${crypto.randomUUID()}${m ? `.${m[1].toLowerCase()}` : ''}`;
      toast(`${file.name} 업로드 중…`);
      await q(sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || 'application/octet-stream' }));
      const { error } = await sb.from('task_attachments').insert({
        task_id: t.id, file_name: file.name, storage_path: path, mime_type: file.type || null, file_size: file.size,
      });
      if (error) { await sb.storage.from(BUCKET).remove([path]); throw error; }
    }
    await reloadPart('attachments');
    if (files.length) toast('첨부했습니다.');
  },
  'admin-department': async (el) => {
    const user = state.profiles.get(el.dataset.user);
    const value = el.value.trim() || null;
    if ((user?.department ?? null) === value) return;
    await q(sb.from('profiles').update({ department: value }).eq('id', el.dataset.user).select().single());
    await refreshBase();
    renderTeamsView();
    toast('부서를 변경했습니다.');
  },
  'admin-position': async (el) => {
    const user = state.profiles.get(el.dataset.user);
    const value = el.value.trim() || null;
    if ((user?.position ?? null) === value) return;
    await q(sb.from('profiles').update({ position: value }).eq('id', el.dataset.user).select().single());
    await refreshBase();
    renderTeamsView();
    toast('직급을 변경했습니다.');
  },
  'admin-role': async (el) => {
    await q(sb.from('profiles').update({ role: el.value }).eq('id', el.dataset.user).select().single());
    await refreshBase();
    renderTeamsView();
    toast('권한을 변경했습니다.');
  },
  'admin-active': async (el) => {
    await q(sb.from('profiles').update({ is_active: el.checked }).eq('id', el.dataset.user).select().single());
    await refreshBase();
    renderTeamsView();
    toast(el.checked ? '계정을 활성화했습니다.' : '계정을 비활성화했습니다.');
  },
};

// -------------------------------------------------------------
// 이벤트: 폼 제출
// -------------------------------------------------------------
const forms = {
  auth: submitAuth,
  'add-task': async (f) => {
    const fd = new FormData(f);
    const title = String(fd.get('title')).trim();
    if (!title) return;
    const p = projectById(state.view.id);
    const row = norm(await q(sb.from('tasks').insert({
      project_id: p.id, title, priority: Number(fd.get('priority')), due_date: fd.get('due_date') || null,
    }).select(TASK_SELECT).single()));
    const assignee = fd.get('assignee');
    if (assignee) {
      const { error } = await sb.from('task_assignees').insert({ task_id: row.id, user_id: assignee });
      if (error) fail(error); else row.assignee_ids = [assignee];
    }
    state.tasks.push(row);
    renderTaskList();
    f.elements.title.value = '';
    f.elements.due_date.value = '';
    f.elements.title.focus();
  },
  'add-subtask': async (f) => {
    const parent = state.detail.task;
    const title = String(new FormData(f).get('title')).trim();
    if (!title) return;
    const row = norm(await q(sb.from('tasks').insert({
      project_id: parent.project_id, parent_id: parent.id, title,
    }).select(TASK_SELECT).single()));
    state.detail.subtasks.push(row);
    if (state.view.type === 'project' && state.view.id === parent.project_id) state.tasks.push(row);
    renderTaskList();
    renderDrawer();
    $('#drawer form[data-form="add-subtask"] input')?.focus();
  },
  'add-comment': async (f) => {
    const content = String(new FormData(f).get('content')).trim();
    if (!content) return;
    await q(sb.from('task_comments').insert({ task_id: state.detail.task.id, content }));
    f.reset();
    await reloadPart('comments');
  },
  'add-member': async (f) => {
    const fd = new FormData(f);
    await q(sb.from('team_members').insert({ team_id: +f.dataset.team, user_id: fd.get('user_id'), role: fd.get('role') }));
    await refreshBase();
    renderTeamsView();
    toast('팀원을 추가했습니다.');
  },
  'add-label-def': async (f) => {
    const fd = new FormData(f);
    await q(sb.from('labels').insert({
      team_id: f.dataset.team ? +f.dataset.team : null,
      name: String(fd.get('name')).trim(),
      color: String(fd.get('color')),
    }));
    await refreshBase();
    renderTeamsView();
  },
};

// -------------------------------------------------------------
// 이벤트 바인딩
// -------------------------------------------------------------
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (fn) guard(fn)(el, e);
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (el && changes[el.dataset.change]) guard(changes[el.dataset.change])(el, e);
});
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset?.input === 'search') { state.filter.q = el.value; renderTaskList(); }
  if (el.classList?.contains('title-input')) autoGrow(el);
});
let draggedTaskId = null;
document.addEventListener('dragstart', (e) => {
  const card = e.target.closest('.board-card[draggable="true"]');
  if (!card) return;
  draggedTaskId = +card.dataset.id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(draggedTaskId));
  setTimeout(() => card.classList.add('dragging'), 0);
});
document.addEventListener('dragend', (e) => {
  e.target.closest('.board-card')?.classList.remove('dragging');
  document.querySelectorAll('.board-dropzone.over').forEach((el) => el.classList.remove('over'));
  draggedTaskId = null;
});
document.addEventListener('dragover', (e) => {
  const zone = e.target.closest('.board-dropzone');
  if (!zone || draggedTaskId == null) return;
  e.preventDefault();
  zone.classList.add('over');
  const after = [...zone.querySelectorAll('.board-card')].find((card) => e.clientY < card.getBoundingClientRect().top + card.offsetHeight / 2);
  const dragged = document.querySelector(`.board-card[data-id="${draggedTaskId}"]`);
  if (dragged) zone.insertBefore(dragged, after || null);
});
document.addEventListener('drop', (e) => {
  const zone = e.target.closest('.board-dropzone');
  if (!zone || draggedTaskId == null) return;
  e.preventDefault();
  const ids = [...zone.querySelectorAll('.board-card')].map((card) => +card.dataset.id);
  guard(saveBoardDrop)(draggedTaskId, zone.dataset.status, ids);
});
document.addEventListener('submit', async (e) => {
  const f = e.target.closest('[data-form]');
  if (!f) return;
  e.preventDefault();
  const fn = forms[f.dataset.form];
  if (!fn) return;
  const btns = f.querySelectorAll('button[type=submit], button:not([type])');
  btns.forEach((b) => { b.disabled = true; });
  try { await fn(f); } catch (err) { fail(err); } finally { btns.forEach((b) => { b.disabled = false; }); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if ($('#modal-root').firstElementChild) closeModal();
    else if (state.detail) closeDrawer();
    else $('#app').classList.remove('sidebar-open');
    return;
  }
  const t = e.target;
  if (t.classList?.contains('title-input') && e.key === 'Enter') { e.preventDefault(); t.blur(); }
  if (t.name === 'content' && t.closest('[data-form="add-comment"]') && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    t.form.requestSubmit();
  }
  if (t.classList?.contains('task-row') && e.key === 'Enter') t.click();
});
window.addEventListener('hashchange', () => { if (state.loaded) guard(route)(); });

// -------------------------------------------------------------
// 시작
// -------------------------------------------------------------
(function start() {
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  const s = new URLSearchParams(location.search);
  const errDesc = h.get('error_description') || s.get('error_description');
  if (errDesc) {
    toast(`인증 오류: ${errDesc.replace(/\+/g, ' ')}`, 'error');
    history.replaceState(null, '', location.pathname);
  }
  sb.auth.onAuthStateChange((event, session) => {
    // 콜백 안에서 바로 supabase 를 호출하면 교착될 수 있어 다음 틱으로 미룸
    setTimeout(() => onAuth(event, session), 0);
  });
})();

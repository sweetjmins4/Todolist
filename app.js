import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const config = window.SUPABASE_CONFIG
const supabase = createClient(config.url, config.publishableKey)
let selectedProject = null

const $ = (selector) => document.querySelector(selector)
const loginScreen = $('#loginScreen')
const appScreen = $('#appScreen')
const loginMessage = $('#loginMessage')
const taskMessage = $('#taskMessage')

function showMessage(element, text, isError = true) {
  element.textContent = text
  element.style.color = isError ? '#b42318' : '#15803d'
}

async function loadProjects() {
  const { data: projects, error } = await supabase.from('projects').select('*').is('archived_at', null).order('name')
  if (error) return showMessage(taskMessage, error.message)
  const list = $('#projectList')
  list.innerHTML = ''
  projects.forEach((project) => {
    const button = document.createElement('button')
    button.className = `project-button${selectedProject?.id === project.id ? ' active' : ''}`
    button.textContent = project.name
    button.onclick = () => selectProject(project)
    list.append(button)
  })
  if (!projects.length) list.innerHTML = '<p class="muted">프로젝트가 없습니다.</p>'
}

async function selectProject(project) {
  selectedProject = project
  $('#emptyState').classList.add('hidden')
  $('#taskArea').classList.remove('hidden')
  $('#projectName').textContent = project.name
  $('#projectDescription').textContent = project.description || ''
  await loadProjects()
  await loadTasks()
}

async function loadTasks() {
  const { data: tasks, error } = await supabase.from('tasks').select('id, title, status, due_date').eq('project_id', selectedProject.id).is('deleted_at', null).order('status').order('due_date', { nullsFirst: false })
  if (error) return showMessage(taskMessage, error.message)
  const list = $('#taskList')
  list.innerHTML = ''
  tasks.forEach((task) => {
    const row = document.createElement('div')
    row.className = `task${task.status === 'done' ? ' done' : ''}`
    const check = document.createElement('input')
    check.type = 'checkbox'; check.checked = task.status === 'done'
    check.onchange = () => updateTaskStatus(task, check.checked)
    const title = document.createElement('span'); title.className = 'task-title'; title.textContent = task.title
    row.append(check, title)
    if (task.due_date) { const due = document.createElement('span'); due.className = 'due-date'; due.textContent = `마감 ${task.due_date}`; row.append(due) }
    list.append(row)
  })
  if (!tasks.length) list.innerHTML = '<p class="muted">아직 등록된 할 일이 없습니다.</p>'
}

async function updateTaskStatus(task, done) {
  const { error } = await supabase.from('tasks').update({ status: done ? 'done' : 'todo' }).eq('id', task.id)
  if (error) return showMessage(taskMessage, error.message)
  loadTasks()
}

async function showApp(session) {
  loginScreen.classList.add('hidden'); appScreen.classList.remove('hidden')
  $('#userEmail').textContent = session.user.email
  await loadProjects()
}

$('#loginForm').onsubmit = async (event) => {
  event.preventDefault(); loginMessage.textContent = ''
  const { error } = await supabase.auth.signInWithPassword({ email: $('#email').value, password: $('#password').value })
  if (error) showMessage(loginMessage, error.message)
}

$('#signUpButton').onclick = async () => {
  loginMessage.textContent = ''
  const email = $('#email').value; const password = $('#password').value
  if (!email || !password) return showMessage(loginMessage, '이메일과 6자 이상의 비밀번호를 입력하세요.')
  const { error } = await supabase.auth.signUp({ email, password, options: { data: { name: email.split('@')[0] } } })
  showMessage(loginMessage, error ? error.message : '가입 요청을 보냈습니다. 이메일 인증 후 로그인하세요.', Boolean(error))
}

$('#signOutButton').onclick = () => supabase.auth.signOut()
$('#newProjectButton').onclick = () => $('#projectDialog').showModal()
$('#projectForm').onsubmit = async (event) => {
  event.preventDefault(); const form = $('#projectForm'); const projectMessage = $('#projectMessage')
  const { data: { user } } = await supabase.auth.getUser()
  const { error } = await supabase.from('projects').insert({ name: $('#newProjectName').value.trim(), description: $('#newProjectDescription').value.trim() || null, owner_id: user.id, visibility: 'private' })
  if (error) return showMessage(projectMessage, error.message)
  form.reset(); $('#projectDialog').close(); loadProjects()
}

$('#taskForm').onsubmit = async (event) => {
  event.preventDefault(); taskMessage.textContent = ''
  const title = $('#taskTitle').value.trim(); if (!title) return
  const { error } = await supabase.from('tasks').insert({ project_id: selectedProject.id, title, due_date: $('#taskDueDate').value || null })
  if (error) return showMessage(taskMessage, error.message)
  $('#taskForm').reset(); loadTasks()
}

supabase.auth.onAuthStateChange((_event, session) => {
  if (session) showApp(session)
  else { appScreen.classList.add('hidden'); loginScreen.classList.remove('hidden'); selectedProject = null }
})

const { data: { session } } = await supabase.auth.getSession()
if (session) showApp(session)

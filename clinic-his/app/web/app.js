'use strict';

/* ================================================================
 * 康诊云社区诊所信息系统 · 管理端（原生 JS，无第三方依赖）
 * 接口契约见 docs/02-接口契约.md；所有请求同源，Token 存 sessionStorage。
 * ================================================================ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const content = $('#content');

const state = {
  token: sessionStorage.getItem('clinic.token') || '',
  user: null,
  depts: [],
  drugs: null,
  labItems: null,
  icd: null,
  visit: null,
  rxItems: [],
  view: 'dashboard',
  selectedCharges: new Set(),
  pharmacyTab: 'SUBMITTED',
  beds: [],
  dirty: false,
  lastVisits: [],
};

/* ---------------------------------------------------------------- 工具 */

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function money(value) {
  return '¥' + Number(value || 0).toFixed(2);
}

function todayStr() {
  const now = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

function dateShift(dateStr, offset) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + offset);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const STATUS = {
  BOOKED: ['已预约', 'info'], CHECKED_IN: ['已签到', 'warn'], IN_PROGRESS: ['就诊中', 'info'],
  FINISHED: ['已完成', 'ok'], CANCELLED: ['已取消', 'danger'],
  SUBMITTED: ['待审核', 'warn'], APPROVED: ['已通过', 'info'], REJECTED: ['已驳回', 'danger'],
  DISPENSED: ['已发药', 'ok'], UNPAID: ['待收费', 'warn'], PAID: ['已收费', 'ok'],
  VOID: ['已作废', 'danger'], REFUNDED: ['已退费', 'danger'],
  APPLIED: ['已申请', 'info'], SAMPLED: ['已采样', 'warn'],
  REPORTED: ['已出报告', 'ok'], WAITING: ['等待中', 'warn'], CALLED: ['已叫号', 'info'],
  SKIPPED: ['已过号', 'danger'], SERVING: ['就诊中', 'info'], DONE: ['已完成', 'ok'],
  OPEN: ['待处理', 'warn'],
};

function badge(status) {
  const item = STATUS[status] || [status || '—', ''];
  return `<span class="badge ${item[1]}">${esc(item[0])}</span>`;
}

function table(headers, rows, emptyText) {
  if (!rows.length) return `<p class="empty">${esc(emptyText || '暂无数据')}</p>`;
  return `<div class="table-wrap"><table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function card(label, value, sub) {
  return `<div class="card"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="sub">${esc(sub || '')}</div></div>`;
}

function formVal(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : '';
}

function formNum(id) {
  const raw = formVal(id);
  if (raw === '') return undefined;
  const num = Number(raw);
  return Number.isFinite(num) ? num : undefined;
}

/* ---------------------------------------------------------------- 提示与弹窗 */

function toast(message, kind = 'ok') {
  const root = $('#toast-root');
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function openModal({ title, body = '', okText = '确定', onOk, onClose }) {
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="modal-mask">
      <div class="modal">
        <h3>${esc(title)}</h3>
        <div class="modal-body">${body}</div>
        <div class="modal-foot">
          <button class="btn ghost" id="modal-cancel">取消</button>
          <button class="btn primary" id="modal-ok">${esc(okText)}</button>
        </div>
      </div>
    </div>`;
  const close = () => { root.innerHTML = ''; if (onClose) onClose(); };
  $('#modal-cancel').onclick = close;
  root.querySelector('.modal-mask').addEventListener('click', e => {
    if (e.target.classList.contains('modal-mask')) close();
  });
  $('#modal-ok').onclick = async () => {
    const btn = $('#modal-ok');
    btn.disabled = true;
    try {
      await onOk();
      close();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  };
  return { close };
}

function confirmAction(message, onOk) {
  openModal({
    title: '请确认',
    body: `<p style="margin:0;font-size:13.5px">${esc(message)}</p>`,
    okText: '确认',
    onOk,
  });
}

/* ---------------------------------------------------------------- 接口 */

async function api(method, path, body) {
  const headers = {};
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new Error('网络异常，请检查服务是否运行');
  }
  let payload = null;
  try { payload = await res.json(); } catch (err) { payload = null; }

  if (res.status === 401) {
    state.token = '';
    state.user = null;
    sessionStorage.removeItem('clinic.token');
    showLogin();
    throw new Error((payload && payload.message) || '登录状态已失效');
  }
  if (!res.ok || (payload && payload.code && payload.code !== 'OK')) {
    throw new Error((payload && payload.message) || ('请求失败（HTTP ' + res.status + '）'));
  }
  return payload ? payload.data : null;
}


/* clinic-his print entry 2026-11-19 */
async function openDoc(kind, id, fmt = 'html') {
  try {
    const data = await api('POST', `/api/v1/documents/${kind}/${id}/grant`, {});
    const url = fmt === 'pdf' ? data.pdfUrl : data.htmlUrl;
    const win = window.open(url, '_blank');
    if (!win) toast('浏览器拦截了新窗口，请允许弹窗', 'error');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------------------------------------------------------------- 登录 */

const DEMO_ACCOUNTS = [
  ['doctor01', '医师'], ['nurse01', '分诊护士'], ['nurse10', '公共卫生'],
  ['admin03', '药师'], ['admin04', '收费员'], ['tech01', '医技'],
  ['admin01', '院长'], ['admin06', '系统管理员'],
];

function renderDemoChips() {
  $('#demo-chips').innerHTML = DEMO_ACCOUNTS
    .map(([username, label]) => `<button type="button" data-demo="${username}">${esc(label)} · ${esc(username)}</button>`)
    .join('');
}

function showLogin() {
  $('#boot').classList.add('hidden');
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  $('#login-username').focus();
}

function enterApp() {
  $('#boot').classList.add('hidden');
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  const u = state.user;
  $('#whoami').textContent = [u.name, u.roleName, u.deptName].filter(Boolean).join(' · ');
  applyNavHidden();
  renderNav();
  route();
}

async function doLogin(event) {
  event.preventDefault();
  const errorEl = $('#login-error');
  errorEl.textContent = '';
  const username = formVal('login-username');
  const password = $('#login-password').value;
  if (!username || !password) return;
  const btn = $('#login-form button[type=submit]');
  btn.disabled = true;
  try {
    const data = await api('POST', '/api/v1/auth/login', { username, password });
    state.token = data.token;
    state.user = data.user;
    sessionStorage.setItem('clinic.token', data.token);
    state.depts = [];
    $('#login-password').value = '';
    enterApp();
    if (data.user.mustChange) toast('当前为初始口令，建议立即修改', 'ok');
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

async function logout() {
  try { await api('POST', '/api/v1/auth/logout'); } catch (err) { /* 已失效则直接退出 */ }
  state.token = '';
  state.user = null;
  sessionStorage.removeItem('clinic.token');
  showLogin();
}

function openChangePassword() {
  openModal({
    title: '修改口令',
    okText: '保存',
    body: `
      <label>原口令<input type="password" id="cp-old" maxlength="64"></label>
      <label>新口令<input type="password" id="cp-new" maxlength="64" placeholder="≥10 位，含大小写/数字/符号"></label>
      <label>确认新口令<input type="password" id="cp-confirm" maxlength="64"></label>`,
    onOk: async () => {
      const oldPassword = formVal('cp-old');
      const newPassword = formVal('cp-new');
      if (!oldPassword || !newPassword) throw new Error('请填写完整');
      if (newPassword !== formVal('cp-confirm')) throw new Error('两次输入的新口令不一致');
      await api('POST', '/api/v1/auth/password', { oldPassword, newPassword });
      toast('口令已修改');
    },
  });
}

/* ---------------------------------------------------------------- 导航 */

const VIEWS = [
  { key: 'dashboard', name: '工作台', group: '门诊业务', perm: null, render: viewDashboard },
  { key: 'registration', name: '挂号登记', group: '门诊业务', perm: 'reg.read', render: viewRegistration },
  { key: 'queue', name: '分诊叫号', group: '门诊业务', perm: 'queue.read', render: viewQueue },
  { key: 'doctor', name: '医生工作站', group: '门诊业务', perm: 'visit.write', render: viewDoctor },
  { key: 'beds', name: '留观床位', group: '住院留观', perm: 'bed.read', render: viewBeds },
  { key: 'nursing', name: '护理执行', group: '住院留观', perm: 'nursing.read', render: viewNursing },
  { key: 'pharmacy', name: '处方审方', group: '药事管理', perm: 'rx.read', render: viewPharmacy },
  { key: 'drugs', name: '药品库存', group: '药事管理', perm: 'drug.read', render: viewDrugs },
  { key: 'charge', name: '收费管理', group: '门诊业务', perm: 'charge.read', render: viewCharge },
  { key: 'patients', name: '患者档案', group: '医技与公卫', perm: 'patient.read', render: viewPatients },
  { key: 'lab', name: '医技检查', group: '医技与公卫', perm: 'lab.read', render: viewLab },
  { key: 'ph', name: '公共卫生', group: '医技与公卫', perm: 'ph.read', render: viewPh },
  { key: 'reports', name: '统计报表', group: '运营与系统', perm: 'report.view', render: viewReports },
  { key: 'staff', name: '人员与排班', group: '运营与系统', perm: 'staff.read', render: viewStaff },
  { key: 'system', name: '系统管理', group: '运营与系统', perm: 'audit.view', render: viewSystem },
];

const NAV_COLLAPSE_KEY = 'clinic.nav.collapsed';
const NAV_HIDDEN_KEY = 'clinic.nav.hidden';

function navHidden() {
  return localStorage.getItem(NAV_HIDDEN_KEY) === '1';
}

/* 整体隐藏/展开顶部导航（状态存 localStorage） */
function applyNavHidden() {
  const hidden = navHidden();
  $('#app').classList.toggle('nav-hidden', hidden);
  const btn = $('#nav-toggle');
  if (btn) {
    btn.textContent = hidden ? '☰' : '«';
    btn.title = hidden ? '展开导航' : '收起导航';
    btn.setAttribute('aria-label', btn.title);
  }
}

function can(perm) {
  if (!perm) return true;
  return Boolean(state.user && state.user.perms.includes(perm));
}

function visibleViews() {
  return VIEWS.filter(v => can(v.perm));
}

function navCollapsed() {
  try {
    return JSON.parse(localStorage.getItem(NAV_COLLAPSE_KEY) || '{}') || {};
  } catch (err) {
    return {};
  }
}

function renderNav() {
  const collapsed = navCollapsed();
  const groups = [];
  visibleViews().forEach(v => {
    let g = groups.find(x => x.name === v.group);
    if (!g) { g = { name: v.group, items: [] }; groups.push(g); }
    g.items.push(v);
  });
  $('#nav').innerHTML = groups.map(g => {
    const off = Boolean(collapsed[g.name]);
    return `<div class="nav-group${off ? ' collapsed' : ''}">
      <button type="button" class="nav-group-head" data-group="${esc(g.name)}">
        <span>${esc(g.name)}</span><span class="caret">▾</span>
      </button>
      <div class="nav-group-body">
        ${g.items.map(v => `<a href="#/${v.key}" class="${v.key === state.view ? 'active' : ''}">${esc(v.name)}</a>`).join('')}
      </div>
    </div>`;
  }).join('');
}

function route() {
  const key = (location.hash.replace(/^#\/?/, '') || 'dashboard');
  const allowed = visibleViews();
  let view = allowed.find(v => v.key === key);
  if (!view) {
    view = allowed[0];
    if (!view) return;
  }
  state.view = view.key;
  $('#view-title').innerHTML = `<span class="crumb-group">${esc(view.group)}</span>`
    + '<span class="crumb-sep">/</span>'
    + `<span>${esc(view.name)}</span>`;
  renderNav();
  content.innerHTML = '<p class="empty">加载中…</p>';
  view.render().catch(err => {
    content.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  });
}

/* ---------------------------------------------------------------- 工作台 */

async function viewDashboard() {
  const [wb, d] = await Promise.all([
    api('GET', '/api/v1/workbench'),
    api('GET', '/api/v1/dashboard'),
  ]);
  const alerts = wb.alerts.length
    ? wb.alerts.map(a => `<div class="alert-line clickable" data-goto="${esc(a.view)}">${esc(a.message)} · 点击查看</div>`).join('')
    : '';
  const todos = wb.todos.length
    ? `<div class="todo-grid">${wb.todos.map(t => `<button type="button" class="todo-card" data-goto="${esc(t.view)}">
        <span class="todo-label">${esc(t.label)}</span>
        <span class="todo-count">${esc(t.count)}</span>
        <span class="todo-hint">${esc(t.hint || '点击进入')}</span>
      </button>`).join('')}</div>`
    : '<p class="empty">当前岗位暂无待办</p>';
  const costs = `
    <div class="cards">
      ${card('今日挂号', d.registrations.total, `已签到 ${d.registrations.checkedIn} · 就诊中 ${d.registrations.inProgress} · 已完成 ${d.registrations.finished}`)}
      ${card('候诊人数', d.queue.waiting, '等待叫号')}
      ${card('待审处方', d.prescriptions.pendingReview, '药师审核后计费')}
      ${card('待收费', d.charges.unpaidCount, money(d.charges.unpaidAmount))}
      ${card('今日收入', money(d.revenue.todayPaid), '已收费金额')}
      ${card('公卫任务', d.ph.open, `逾期 ${d.ph.overdue} 项`)}
    </div>
    <div class="stat-line" style="margin-top:10px">
      <span>库存预警 <strong>${d.drugs.lowStock}</strong> 种</span>
      <span>今日完成就诊 <strong>${d.visits.finished}</strong></span>
      <span>就诊中 <strong>${d.visits.inProgress}</strong></span>
    </div>`;
  content.innerHTML = `
    <div class="section-title">我的待办 · ${esc(wb.roleName)}${wb.deptName ? ' · ' + esc(wb.deptName) : ''}</div>
    ${alerts}
    ${todos}
    <div class="section-title">运营概览</div>
    ${costs}
    <details class="fold" style="margin-top:18px">
      <summary>使用提示与演示流程</summary>
      <p class="hint" style="font-size:13px;line-height:2">
        演示流程：挂号登记 → 收费处缴费 → 分诊签到取号 → 护士叫号 → 医生接诊/诊断/开方/开检查 →
        药师审方 → 收费处缴药费 → 药房发药 → 医技出报告。</p>
      <p class="hint" style="font-size:13px;line-height:2">
        系统内置 8 名医师、14 名护士（含 3 名公卫岗）、6 名行政与 2 名医技；所有操作写入审计哈希链，
        可在「系统管理」核验。对外 <code>/openapi/v1/*</code> 为模拟 HIS 受理接口，支持 HMAC 签名、幂等与撤销。</p>
    </details>`;
  content.onclick = e => {
    const el = e.target.closest('[data-goto]');
    if (el) location.hash = '#/' + el.dataset.goto;
  };
}

/* ---------------------------------------------------------------- 统一患者视图（EMPI/CDR 抽屉） */

function patientCell(id, name, mrn) {
  if (!id) return `${esc(name || '')}<br><span class="hint">${esc(mrn || '')}</span>`;
  return `<span class="link-patient" data-patient="${id}">${esc(name || '')}</span>`
    + `<br><span class="hint">${esc(mrn || '')}</span>`;
}

function overviewTable(headers, rows) {
  if (!rows.length) return '<p class="empty">暂无记录</p>';
  return `<table class="table"><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>`
    + `<tbody>${rows.join('')}</tbody></table>`;
}

async function openPatient(patientId) {
  const root = $('#drawer-root');
  root.innerHTML = '<div class="drawer-mask"><aside class="drawer"><p class="empty">加载患者全视图…</p></aside></div>';
  let d;
  try {
    d = await api('GET', `/api/v1/patients/${patientId}/overview`);
  } catch (err) {
    root.innerHTML = '';
    toast(err.message, 'error');
    return;
  }
  const p = d.patient;
  const tags = (p.chronicTags || []).map(t => `<span class="badge">${esc(t)}</span>`).join(' ');
  const allergyText = (p.allergy || '').trim();
  const allergy = allergyText && allergyText !== '无'
    ? `<div class="alert-line">过敏史：${esc(allergyText)}</div>` : '<p class="hint">过敏史：无</p>';
  const lastVisit = (d.visits[0] || {}).id;

  const todayRows = d.today.map(r => `<tr>
      <td>${esc(r.queueNo || '—')}</td><td>${esc(r.deptName)}</td><td>${esc(r.doctorName)}</td>
      <td>${badge(r.status)}</td><td>${badge(r.feeStatus)}</td></tr>`);
  const visitRows = d.visits.map(v => `<tr>
      <td>${esc(v.visitDate)}</td><td>${esc(v.deptName)}</td><td>${esc(v.doctorName)}</td>
      <td>${esc(v.diagnosisName || '—')}</td><td>${badge(v.status)}</td></tr>`);
  const rxRows = d.prescriptions.map(r => `<tr>
      <td>${esc(r.rxNo)}</td><td>${esc((r.drugNames || []).join('、') || '—')}</td>
      <td>${money(r.totalAmount)}</td><td>${badge(r.status)}</td></tr>`);
  const reportRows = d.reports.map(r => `<tr class="${r.abnormal ? 'abnormal' : ''}">
      <td>${esc(r.itemName)}</td><td>${esc(r.conclusion || '—')}</td>
      <td>${r.abnormal ? '<span class="badge danger">异常</span>' : '<span class="badge">正常</span>'}</td>
      <td>${esc(r.reportedAt || '—')}</td></tr>`);
  const stayRows = d.stays.map(s => `<tr>
      <td>${esc(s.bedNo)}</td><td>${esc(s.zone)}</td><td>${esc(s.diagnosis || '—')}</td>
      <td>${esc(s.nursingLevel || '—')}</td><td>${badge(s.status)}</td></tr>`);

  root.innerHTML = `<div class="drawer-mask">
    <aside class="drawer" role="dialog" aria-label="患者全视图">
      <div class="drawer-head">
        <h3>${esc(p.name)} <span class="hint">${esc(p.mrn)}</span></h3>
        <button type="button" class="btn ghost" data-drawer-close>关闭</button>
      </div>
      <div class="split" style="margin-bottom:12px">
        <div class="kv"><div class="k">性别</div><div class="v">${esc(p.gender)}</div></div>
        <div class="kv"><div class="k">年龄</div><div class="v">${p.birthDate ? esc(ageFromBirth(p.birthDate)) : '—'}</div></div>
        <div class="kv"><div class="k">病历号</div><div class="v">${esc(p.mrn)}</div></div>
        <div class="kv"><div class="k">电话</div><div class="v">${esc(p.phoneMask || '—')}</div></div>
      </div>
      <p class="hint">住址：${esc(p.address || '—')}</p>
      ${allergy}
      <div style="margin:8px 0 14px">${tags || '<span class="hint">无慢病标签</span>'}</div>
      <div class="section-title">今日就诊</div>
      ${overviewTable(['号序', '科室', '医生', '状态', '费用'], todayRows)}
      <div class="section-title">历次就诊</div>
      ${overviewTable(['日期', '科室', '医生', '诊断', '状态'], visitRows)}
      <div class="section-title">处方</div>
      ${overviewTable(['处方号', '药品', '金额', '状态'], rxRows)}
      <div class="section-title">检查报告${d.abnormalReports ? `（异常 ${d.abnormalReports} 项）` : ''}</div>
      ${overviewTable(['项目', '结论', '提示', '报告时间'], reportRows)}
      <div class="section-title">留观记录</div>
      ${overviewTable(['床位', '区域', '诊断', '护理级别', '状态'], stayRows)}
      <div style="margin-top:18px;display:flex;gap:8px">
        ${lastVisit ? `<button class="btn" data-doc="visit" data-id="${lastVisit}">打印病历</button>` : ''}
        <button type="button" class="btn ghost" data-drawer-close>关闭</button>
      </div>
    </aside>
  </div>`;

  root.querySelectorAll('[data-drawer-close]').forEach(btn => { btn.onclick = closeDrawer; });
  root.querySelector('.drawer-mask').addEventListener('click', e => {
    if (e.target.classList.contains('drawer-mask')) closeDrawer();
  });
}

function closeDrawer() {
  const root = $('#drawer-root');
  if (root) root.innerHTML = '';
}

/* ---------------------------------------------------------------- 通用数据 */

async function ensureDepts() {
  if (!state.depts.length) state.depts = await api('GET', '/api/v1/departments');
  return state.depts;
}

function deptOptions(selected) {
  return state.depts.map(d =>
    `<option value="${d.id}" ${String(d.id) === String(selected) ? 'selected' : ''}>${esc(d.name)}</option>`
  ).join('');
}

/* ---------------------------------------------------------------- 挂号登记 */

async function viewRegistration() {
  await ensureDepts();
  content.innerHTML = `
    <div class="panel">
      <div class="panel-head"><h3>现场挂号</h3><span class="hint">① 选患者 → ② 选号源 → ③ 提交</span></div>
      <div class="panel-body">
        <div class="reg-grid">
          <div class="reg-step">
            <div class="step-no">1</div>
            <label>就诊日期<input type="date" id="reg-date" value="${todayStr()}"></label>
            <label>患者检索
              <span class="inline-search">
                <input id="reg-patient-q" placeholder="姓名 / 病历号 / 手机尾号" autocomplete="off">
                <button type="button" class="btn small" id="reg-patient-search">搜索</button>
              </span>
            </label>
            <label>已选患者<select id="reg-patient"><option value="">加载中…</option></select></label>
          </div>
          <div class="reg-step">
            <div class="step-no">2</div>
            <label>科室<input id="reg-dept" placeholder="如 nk" autocomplete="off"></label>
            <label>号源<select id="reg-slot"><option value="">加载中…</option></select></label>
          </div>
          <div class="reg-step reg-confirm">
            <div class="step-no">3</div>
            <p class="hint">挂号成功后生成挂号费账单；患者需在收费处缴费后方可签到取号。</p>
            <button class="btn primary block" id="reg-submit" ${can('reg.write') ? '' : 'disabled'}>挂 号</button>
          </div>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><h3>挂号记录</h3>
        <button class="btn small" id="reg-refresh">刷新</button>
      </div>
      <div class="panel-body">
        <div class="filter-bar">
          <label>状态
            <select id="reg-status">
              <option value="">全部</option>
              <option value="BOOKED">已预约</option>
              <option value="CHECKED_IN">已签到</option>
              <option value="IN_PROGRESS">就诊中</option>
              <option value="FINISHED">已完成</option>
              <option value="CANCELLED">已取消</option>
            </select>
          </label>
        </div>
        <div id="reg-table"></div>
      </div>
    </div>`;

  const loadPatients = async () => {
    const q = formVal('reg-patient-q');
    const rows = await api('GET', '/api/v1/patients' + (q ? `?q=${encodeURIComponent(q)}` : ''));
    $('#reg-patient').innerHTML = rows.length
      ? rows.map(p => `<option value="${p.id}">${esc(p.mrn)} ${esc(p.name)}（${esc(p.gender)}）</option>`).join('')
      : '<option value="">无匹配患者</option>';
  };

  const loadSlots = async () => {
    const date = formVal('reg-date') || todayStr();
    const deptId = document.getElementById('reg-dept').dataset.acValue || '';
    const rows = await api('GET', `/api/v1/schedules?date=${date}${deptId ? '&deptId=' + deptId : ''}`);
    const open = rows.filter(s => s.status === 'OPEN' && s.remaining > 0);
    $('#reg-slot').innerHTML = open.length
      ? open.map(s => `<option value="${s.id}">${esc(s.doctorName)} ${esc(s.doctorTitle)} · ${s.period === 'AM' ? '上午' : '下午'} ${esc(s.startTime)}-${esc(s.endTime)} · 余 ${s.remaining}</option>`).join('')
      : '<option value="">当日无可预约号源</option>';
  };

  const loadTable = async () => {
    const date = formVal('reg-date') || todayStr();
    const status = formVal('reg-status');
    const rows = await api('GET', `/api/v1/registrations?date=${date}${status ? '&status=' + status : ''}`);
    $('#reg-table').innerHTML = table(
      ['挂号号', '患者', '科室 / 医生', '状态 / 费用', '队列号', '操作'],
      rows.map(r => {
        const actions = [];
        if (r.status === 'BOOKED' && can('reg.checkin')) actions.push(`<button class="btn small" data-checkin="${r.id}">签到</button>`);
        if (r.status === 'BOOKED' && can('reg.write')) actions.push(`<button class="btn small danger" data-cancel="${r.id}">取消</button>`);
        return `<tr>
          <td>${esc(r.regNo)}</td>
          <td>${patientCell(r.patientId, r.patientName, r.patientMrn)}</td>
          <td>${esc(r.deptName)}<br><span class="hint">${esc(r.doctorName)} · ${r.source === 'ONSITE' ? '现场' : '小程序'}</span></td>
          <td>${badge(r.status)} ${badge(r.feeStatus)}</td>
          <td>${esc(r.queueNo || '—')}</td>
          <td>${actions.join(' ') || '—'}</td>
        </tr>`;
      }),
      '当日暂无挂号记录'
    );
  };

  $('#reg-patient-search').onclick = () => loadPatients().catch(err => toast(err.message, 'error'));
  $('#reg-patient-q').onkeydown = e => { if (e.key === 'Enter' && !document.querySelector('.ac-pop:not(.hidden)')) { e.preventDefault(); loadPatients().catch(err => toast(err.message, 'error')); } };
  // IDEA 式自动补全：科室（字典）/ 患者主索引（远程检索 + 失败降级缓存）
  AutoComplete.attach($('#reg-dept'), {
    items: () => state.depts || [],
    label: d => d.name, code: d => String(d.id),
    sub: d => d.code || '',
    tabTarget: '#reg-patient-q',
    emptyHint: '无匹配科室',
    onPick: () => loadSlots().catch(err => toast(err.message, 'error')),
  });
  AutoComplete.attach($('#reg-patient-q'), {
    remote: async q => await api('GET', `/api/v1/patients?q=${encodeURIComponent(q)}`),
    label: p => p.name, code: p => p.mrn,
    sub: p => `${p.mrn} · ${p.gender || ''}${p.age != null ? ' · ' + p.age + '岁' : ''}`,
    value: p => `${p.mrn} ${p.name}`,
    emptyHint: '无匹配患者，可点「搜索」按病历号建档后重试',
    onPick: async p => {
      const qEl = $('#reg-patient-q');
      const shown = qEl.value;
      qEl.value = p.mrn;                       // 按病历号精确刷新下拉
      await loadPatients();
      const sel = $('#reg-patient');
      if ([...sel.options].some(o => o.value === String(p.id))) sel.value = String(p.id);
      qEl.value = shown;
      loadSlots().catch(() => {});
    },
  });
  $('#reg-date').onchange = () => { loadSlots(); loadTable(); };
  $('#reg-status').onchange = () => loadTable().catch(err => toast(err.message, 'error'));
  $('#reg-refresh').onclick = () => loadTable().catch(err => toast(err.message, 'error'));

  $('#reg-submit').onclick = async () => {
    const patientId = Number(formVal('reg-patient'));
    const slotId = Number(formVal('reg-slot'));
    if (!patientId || !slotId) { toast('请选择患者与号源', 'error'); return; }
    try {
      const data = await api('POST', '/api/v1/registrations', { patientId, slotId, source: 'ONSITE' });
      toast(`挂号成功：${data.regNo}，挂号费 ${money(data.feeAmount)}`);
      await Promise.all([loadSlots(), loadTable()]);
    } catch (err) { toast(err.message, 'error'); }
  };

  $('#reg-table').onclick = e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.checkin) openCheckin(Number(btn.dataset.checkin)).then(loadTable).catch(err => toast(err.message, 'error'));
    if (btn.dataset.cancel) {
      confirmAction('确认取消该挂号？挂号费未缴账单将一并作废。', async () => {
        await api('POST', `/api/v1/registrations/${btn.dataset.cancel}/cancel`);
        toast('挂号已取消');
        await Promise.all([loadSlots(), loadTable()]);
      });
    }
  };

  await Promise.all([loadPatients(), loadSlots(), loadTable()]);
}

function openCheckin(regId) {
  return new Promise((resolve, reject) => {
    openModal({
      title: '签到与预检',
      okText: '确认签到',
      body: `
        <label>体温（℃）<input id="ck-temp" type="number" step="0.1" placeholder="如 36.7"></label>
        <label>收缩压（mmHg）<input id="ck-sys" type="number" placeholder="如 120"></label>
        <label>舒张压（mmHg）<input id="ck-dia" type="number" placeholder="如 80"></label>
        <label>脉搏（次/分）<input id="ck-pulse" type="number" placeholder="如 78"></label>`,
      onOk: async () => {
        const body = {
          temperature: formNum('ck-temp'),
          systolic: formNum('ck-sys'),
          diastolic: formNum('ck-dia'),
          pulse: formNum('ck-pulse'),
        };
        Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);
        const data = await api('POST', `/api/v1/registrations/${regId}/checkin`, body);
        toast(`签到成功，队列号 ${data.queueNo}`);
        resolve(data);
      },
    });
  });
}

/* ---------------------------------------------------------------- 分诊叫号 */

async function viewQueue() {
  await ensureDepts();
  content.innerHTML = `
    <div class="panel">
      <div class="panel-head"><h3>候诊队列</h3>
        <button class="btn small primary" id="q-call" ${can('queue.call') ? '' : 'disabled'}>叫下一位</button>
      </div>
      <div class="panel-body">
        <div class="filter-bar">
          <label>日期<input type="date" id="q-date" value="${todayStr()}"></label>
          <label>科室<select id="q-dept">${deptOptions('')}</select></label>
          <button class="btn" id="q-refresh">刷新</button>
        </div>
        <div id="q-table"></div>
      </div>
    </div>`;

  const load = async () => {
    const date = formVal('q-date') || todayStr();
    const deptId = formVal('q-dept');
    const rows = await api('GET', `/api/v1/queue?date=${date}${deptId ? '&deptId=' + deptId : ''}`);
    $('#q-table').innerHTML = table(
      ['队列号', '患者', '科室', '状态', '叫号 / 完成', '操作'],
      rows.map(r => {
        const callT = r.calledAt ? esc(String(r.calledAt).slice(11, 16)) : '—';
        const doneT = r.doneAt ? esc(String(r.doneAt).slice(11, 16)) : '—';
        return `<tr>
        <td><strong>${esc(r.ticketNo)}</strong></td>
        <td>${patientCell(r.patientId, r.patientName, r.patientMrn)}</td>
        <td>${esc(r.deptName)}</td>
        <td>${badge(r.status)}</td>
        <td>${callT}${r.doneAt ? ' / ' + doneT : ''}</td>
        <td>${can('queue.call') && ['WAITING', 'CALLED'].includes(r.status)
          ? `<button class="btn small" data-skip="${r.id}">过号</button>` : '—'}</td>
      </tr>`;
      }),
      '当日暂无候诊'
    );
  };

  $('#q-refresh').onclick = () => load().catch(err => toast(err.message, 'error'));
  $('#q-date').onchange = () => load().catch(err => toast(err.message, 'error'));
  $('#q-dept').onchange = () => load().catch(err => toast(err.message, 'error'));
  $('#q-call').onclick = async () => {
    const deptId = Number(formVal('q-dept'));
    if (!deptId) { toast('请先选择科室', 'error'); return; }
    try {
      const data = await api('POST', '/api/v1/queue/call-next', { deptId });
      toast(data.called ? `请 ${data.called.ticketNo} 号就诊` : '当前科室暂无等待患者');
      await load();
    } catch (err) { toast(err.message, 'error'); }
  };
  $('#q-table').onclick = e => {
    const btn = e.target.closest('button');
    if (btn && btn.dataset.skip) {
      confirmAction('确认将本次叫号标记为过号？', async () => {
        await api('POST', `/api/v1/queue/${btn.dataset.skip}/skip`);
        toast('已过号');
        await load();
      });
    }
  };

  await load();
}

/* ---------------------------------------------------------------- 医生工作站 */

const EMR_TEMPLATES = {
  chiefComplaint: ['发热伴咳嗽 2 天', '反复腹痛 1 周', '头晕、乏力 3 天', '咽痛 3 天，吞咽时加重'],
  presentIllness: [
    '患者于 2 天前受凉后出现发热，最高体温 38.5℃，伴咳嗽、咳白色痰，自服感冒药效果欠佳，无胸痛、呼吸困难，遂来就诊。',
    '患者 1 周前无明显诱因出现腹痛，以脐周为主，呈阵发性隐痛，无恶心呕吐，无发热，二便正常。',
  ],
  pastHistory: ['既往体健，否认高血压、糖尿病、冠心病等慢性病史，否认手术外伤史。',
                '高血压 3 年，规律服用降压药，血压控制可。'],
  allergyHistory: ['否认药物及食物过敏史。', '青霉素过敏（皮试阳性）。'],
  physicalExam: ['T 36.7℃，P 78 次/分，R 18 次/分，BP 120/80 mmHg。神清，双肺呼吸音清，未闻及干湿性啰音，心律齐。',
                 '腹平软，无压痛及反跳痛，肝脾未触及，肠鸣音 4 次/分。'],
  auxiliaryExam: ['血常规、CRP 未见明显异常。', '胸部 X 线未见明显异常。'],
  treatmentAdvice: ['对症治疗，多饮水，清淡饮食，注意休息，3 天后复诊，不适随诊。',
                    '低盐低脂饮食，监测血压，1 周后复诊。'],
};

const EMR_SECTION_META = [
  { key: 'chiefComplaint', id: 'v-cc', label: '主诉', required: true },
  { key: 'presentIllness', id: 'v-pi', label: '现病史' },
  { key: 'pastHistory', id: 'v-ph', label: '既往史' },
  { key: 'allergyHistory', id: 'v-ah', label: '过敏史' },
  { key: 'physicalExam', id: 'v-pe', label: '体格检查' },
  { key: 'auxiliaryExam', id: 'v-ax', label: '辅助检查' },
  { key: 'treatmentAdvice', id: 'v-adv', label: '处理意见' },
];

const VITALS_SOURCE_TEXT = { CHECKIN: '分诊签到', DOCTOR: '医生补录', MERGED: '分诊 + 补录' };

function markDirty() {
  state.dirty = true;
}

function ageFromBirth(birth) {
  if (!birth) return '年龄未知';
  const born = new Date(birth + 'T00:00:00');
  if (Number.isNaN(born.getTime())) return '年龄未知';
  const now = new Date();
  let age = now.getFullYear() - born.getFullYear();
  const monthDiff = now.getMonth() - born.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < born.getDate())) age -= 1;
  return age >= 0 ? age + ' 岁' : '年龄未知';
}

function updateCharCount(id) {
  const ta = document.getElementById(id);
  const el = document.querySelector(`[data-count="${id}"]`);
  if (ta && el) el.textContent = ta.value.trim().length + ' 字';
}

function emrSectionHtml(meta, value, editable) {
  const tpls = EMR_TEMPLATES[meta.key] || [];
  const tplSelect = editable && tpls.length
    ? `<select class="tpl-select" data-tpl="${meta.key}"><option value="">插入模板</option>${tpls.map((t, i) =>
      `<option value="${i}">${esc(t.length > 16 ? t.slice(0, 16) + '…' : t)}</option>`).join('')}</select>`
    : '';
  return `<div class="emr-sec">
    <div class="emr-head">
      <span>${esc(meta.label)}${meta.required ? ' <b class="req">*</b>' : ''}</span>
      <span class="emr-tools"><span class="char" data-count="${meta.id}">0 字</span>${tplSelect}</span>
    </div>
    <textarea id="${meta.id}" ${editable ? '' : 'disabled'}>${esc(value || '')}</textarea>
  </div>`;
}

function vitalsCardHtml(v) {
  const vit = v.vitals || {};
  const items = [
    ['体温', vit.temperature !== undefined && vit.temperature !== '' ? vit.temperature + ' ℃' : ''],
    ['血压', vit.systolic && vit.diastolic ? `${vit.systolic}/${vit.diastolic} mmHg` : ''],
    ['脉搏', vit.pulse !== undefined && vit.pulse !== '' ? vit.pulse + ' 次/分' : ''],
    ['呼吸', vit.respiration !== undefined && vit.respiration !== '' ? vit.respiration + ' 次/分' : ''],
    ['血氧', vit.spo2 !== undefined && vit.spo2 !== '' ? vit.spo2 + ' %' : ''],
  ].filter(x => x[1]);
  const sourceText = v.vitalsSource ? (VITALS_SOURCE_TEXT[v.vitalsSource] || v.vitalsSource) : '未采集';
  return `<div class="vitals-card">
    <div class="vitals-head">
      <span class="hint">来源：${esc(sourceText)}</span>
      ${v.status === 'IN_PROGRESS' ? '<button class="btn small" id="v-vitals">补录体征</button>' : ''}
    </div>
    <div class="vitals-list">${items.length
      ? items.map(x => `<div class="vital-item"><span>${x[0]}</span><strong>${esc(x[1])}</strong></div>`).join('')
      : '<p class="hint">暂未采集生命体征</p>'}</div>
  </div>`;
}

function bindVitalsButton(v) {
  const btn = document.getElementById('v-vitals');
  if (btn) btn.onclick = () => openVitalsModal(v);
}

async function doctorMeHtml(me) {
  const days = [];
  for (let i = 0; i < 7; i++) days.push(dateShift(todayStr(), i));
  const lists = await Promise.all(
    days.map(d => api('GET', `/api/v1/schedules?date=${d}`).catch(() => []))
  );
  const rows = days.map((d, i) => {
    const mine = (lists[i] || []).filter(s => s.doctorName === me.name && s.deptName === me.deptName);
    const cell = period => {
      const s = mine.find(x => x.period === period);
      const label = period === 'AM' ? '上午' : '下午';
      if (!s) return `<span class="hint">${label} 未排班</span>`;
      return `${label} ${esc(s.startTime)}–${esc(s.endTime)} · 余 <strong>${s.remaining}</strong>/${s.capacity}`;
    };
    return `<div class="me-slot${i === 0 ? ' today' : ''}">
        <div class="me-date">${esc(d.slice(5))}${i === 0 ? ' <span class="hint">今天</span>' : ''}</div>
        <div>${cell('AM')}</div>
        <div>${cell('PM')}</div>
      </div>`;
  }).join('');
  return `
    <div class="kv me-kv">
      <div><span>姓名</span>${esc(me.name)}</div>
      <div><span>工号</span>${esc(me.staffNo || '—')}</div>
      <div><span>科室</span>${esc(me.deptName || '—')}</div>
      <div><span>职称</span>${esc(me.title || '—')}</div>
      <div><span>角色</span>${esc(me.roleName)}</div>
      <div><span>账号</span>${esc(me.username)}</div>
    </div>
    <div class="section-title" style="margin-top:14px">近 7 日号源（本人）</div>
    <div class="me-slots">${rows}</div>
    <p class="hint" style="margin-top:10px">号源由排班生成，挂号与预约均占用此处余量；调整排班请联系医务科。</p>`;
}

async function viewDoctor() {
  content.innerHTML = `
    <div id="doc-alerts"></div>
    <div class="cols3">
      <div>
        <div class="panel">
          <div class="panel-head"><h3>就诊队列</h3><button class="btn small" id="doc-refresh">刷新</button></div>
          <div class="panel-body">
            <div class="seg" id="doc-list-seg">
              <button type="button" class="seg-btn active" data-dlist="pending">待接诊</button>
              <button type="button" class="seg-btn" data-dlist="visits">今日就诊</button>
            </div>
            <div id="doc-pending" style="margin-top:12px"><p class="empty">加载中…</p></div>
            <div id="doc-visits" class="hidden"><p class="empty">加载中…</p></div>
          </div>
        </div>
      </div>
      <div>
        <div class="panel">
          <div class="panel-head"><h3>病历工作站</h3></div>
          <div class="panel-body" id="doc-detail"><p class="empty">从上方就诊队列点击「接诊」或「查看」</p></div>
        </div>
      </div>
      <div id="doc-side">
        <div class="panel">
          <div class="panel-head"><h3>诊疗操作</h3></div>
          <div class="panel-body"><p class="empty">选择就诊后显示诊断、处方与操作</p></div>
        </div>
      </div>
    </div>
    <details class="fold" id="doc-me">
      <summary>我的资料与近 7 日排班</summary>
      <div class="me-body" id="doc-me-body"><p class="hint">展开后加载</p></div>
    </details>`;
  state.dirty = false;
  state.visit = null;
  state.lastVisits = [];

  $('#doc-me').addEventListener('toggle', async () => {
    const fold = $('#doc-me');
    const body = $('#doc-me-body');
    if (!fold.open || body.dataset.loaded === '1') return;
    body.innerHTML = '<p class="hint">加载中…</p>';
    try {
      const me = await api('GET', '/api/v1/auth/me');
      body.innerHTML = await doctorMeHtml(me);
      body.dataset.loaded = '1';
    } catch (err) {
      body.innerHTML = `<p class="hint">${esc(err.message)}</p>`;
    }
  });

  const setTabCount = (key, n) => {
    const b = document.querySelector(`#doc-list-seg [data-dlist="${key}"]`);
    if (b) {
      b.innerHTML = `${key === 'pending' ? '待接诊' : '今日就诊'} <span class="seg-count">${n}</span>`;
    }
  };

  const loadPending = async () => {
    const rows = await api('GET', `/api/v1/registrations?date=${todayStr()}&status=CHECKED_IN`);
    setTabCount('pending', rows.length);
    $('#doc-pending').innerHTML = rows.length
      ? rows.map(r => `<div class="mini-row">
          <div class="mini-main"><strong>${esc(r.queueNo || '—')}</strong> <span class="link-patient" data-patient="${r.patientId}">${esc(r.patientName)}</span></div>
          <div class="mini-sub">${esc(r.patientMrn)} · ${esc(r.deptName)}</div>
          <div class="mini-actions"><button class="btn small primary" data-start="${r.id}">接诊</button></div>
        </div>`).join('')
      : '<p class="empty">暂无待接诊患者</p>';
  };

  const loadVisits = async () => {
    const rows = await api('GET', `/api/v1/visits?date=${todayStr()}`);
    setTabCount('visits', rows.length);
    $('#doc-visits').innerHTML = rows.length
      ? rows.map(r => `<div class="mini-row" data-open="${r.id}">
          <div class="mini-main"><span class="link-patient" data-patient="${r.patientId}">${esc(r.patientName)}</span> ${badge(r.status)}</div>
          <div class="mini-sub">${esc(r.visitNo)} · ${esc(r.diagnosisName || '未诊断')}</div>
          <div class="mini-actions">
            <button class="btn small" data-open="${r.id}">查看</button>
            <button class="btn small" data-doc="visit" data-id="${r.id}">打印</button>
          </div>
        </div>`).join('')
      : '<p class="empty">今日暂无就诊记录</p>';
  };

  const reloadLists = async () => {
    await Promise.all([loadPending(), loadVisits()]);
  };

  $('#doc-refresh').onclick = () => reloadLists().catch(err => toast(err.message, 'error'));
  $('#doc-list-seg').onclick = e => {
    const b = e.target.closest('[data-dlist]');
    if (!b) return;
    $$('#doc-list-seg [data-dlist]').forEach(x => x.classList.toggle('active', x === b));
    $('#doc-pending').classList.toggle('hidden', b.dataset.dlist !== 'pending');
    $('#doc-visits').classList.toggle('hidden', b.dataset.dlist !== 'visits');
  };
  $('#doc-pending').onclick = e => {
    const btn = e.target.closest('button');
    if (!btn || !btn.dataset.start) return;
    if (state.dirty && !window.confirm('当前病历有未保存的修改，确认放弃并接诊新患者？')) return;
    api('POST', '/api/v1/visits', { registrationId: Number(btn.dataset.start) })
      .then(async data => {
        toast('已开始接诊');
        await reloadLists();
        await openVisit(data.id, { force: true });
      })
      .catch(err => toast(err.message, 'error'));
  };
  $('#doc-visits').onclick = e => {
    if (e.target.closest('button[data-doc]')) return;
    const row = e.target.closest('[data-open]');
    if (row) openVisit(Number(row.dataset.open)).catch(err => toast(err.message, 'error'));
  };

  await reloadLists();
  // 顶部红条：异常/危急值检查报告提醒（复用角色工作台告警，点击跳转医技视图）
  api('GET', '/api/v1/workbench').then(wb => {
    const el = document.getElementById('doc-alerts');
    if (!el) return;
    const labAlerts = (wb.alerts || []).filter(a => a.view === 'lab');
    el.innerHTML = labAlerts.map(a =>
      `<div class="alert-line clickable" data-goto="lab">${esc(a.message)} · 点击查看医技</div>`).join('');
  }).catch(() => {});
}

async function ensureClinicalDicts() {
  const tasks = [];
  if (!state.drugs) tasks.push(api('GET', '/api/v1/drugs').then(rows => { state.drugs = rows; }));
  if (!state.labItems) tasks.push(api('GET', '/api/v1/lab-items').then(rows => { state.labItems = rows; }));
  if (!state.icd) tasks.push(api('GET', '/api/v1/icd10').then(rows => { state.icd = rows; }));
  if (tasks.length) await Promise.all(tasks);
}

async function openVisit(visitId, opts = {}) {
  const force = Boolean(opts.force);
  if (!force && state.dirty && !window.confirm('当前病历有未保存的修改，确认放弃并重新加载？')) return;
  const tasks = [api('GET', `/api/v1/visits/${visitId}`), ensureClinicalDicts(),
    api('GET', `/api/v1/visits/${visitId}/reports`).catch(() => [])];
  if (can('bed.read')) {
    tasks.push(api('GET', '/api/v1/beds').then(rows => { state.beds = rows; }));
  }
  const [v, , reports] = await Promise.all(tasks);
  state.visit = v;
  state.visitReports = reports || [];
  state.rxItems = [];
  state.dirty = false;
  state.lastVisits = [];
  renderVisitEditor(v);
  renderVisitSide(v);
  loadLastVisits(v).catch(() => {});
}

async function loadLastVisits(v) {
  const box = document.getElementById('last-visits-body');
  if (!box) return;
  const rows = await api('GET',
    `/api/v1/patients/${v.patient.id}/visits?limit=5&excludeVisitId=${v.id}`);
  state.lastVisits = Array.isArray(rows) ? rows : [];
  if (!state.lastVisits.length) {
    box.innerHTML = '<p class="empty">暂无历史就诊</p>';
    return;
  }
  box.innerHTML = state.lastVisits.map((r, i) => `<div class="last-visit">
    <div class="lv-head">${esc(r.visitDate)} · ${esc(r.deptName)} · ${esc(r.doctorName)} ${badge(r.status)}</div>
    <div class="lv-line"><span>诊断</span>${esc(r.diagnosisName || ((r.diagnoses[0] || {}).name) || '—')}</div>
    <div class="lv-line"><span>主诉</span>${esc(r.chiefComplaint || '—')}</div>
    <div class="lv-line"><span>处理</span>${esc(r.treatmentAdvice || '—')}</div>
    <button class="btn small" data-quote="${i}">引用主诉</button>
  </div>`).join('');
}

function openVitalsModal(v) {
  const vit = v.vitals || {};
  const val = key => (vit[key] !== undefined && vit[key] !== null ? esc(vit[key]) : '');
  openModal({
    title: '补录生命体征',
    okText: '保存体征',
    body: `
      <label>体温（℃）<input id="vt-temp" type="number" step="0.1" value="${val('temperature')}"></label>
      <label>脉搏（次/分）<input id="vt-pulse" type="number" value="${val('pulse')}"></label>
      <label>呼吸（次/分）<input id="vt-resp" type="number" value="${val('respiration')}"></label>
      <label>收缩压（mmHg）<input id="vt-sys" type="number" value="${val('systolic')}"></label>
      <label>舒张压（mmHg）<input id="vt-dia" type="number" value="${val('diastolic')}"></label>
      <label>血氧（%）<input id="vt-spo2" type="number" value="${val('spo2')}"></label>`,
    onOk: async () => {
      const body = {
        temperature: formNum('vt-temp'), pulse: formNum('vt-pulse'), respiration: formNum('vt-resp'),
        systolic: formNum('vt-sys'), diastolic: formNum('vt-dia'), spo2: formNum('vt-spo2'),
      };
      Object.keys(body).forEach(k => { if (body[k] === undefined) delete body[k]; });
      if (!Object.keys(body).length) throw new Error('请至少录入一项体征');
      await api('PATCH', `/api/v1/visits/${v.id}/vitals`, body);
      const fresh = await api('GET', `/api/v1/visits/${v.id}`);
      state.visit = fresh;
      const holder = document.getElementById('vitals-holder');
      if (holder) holder.innerHTML = vitalsCardHtml(fresh);
      bindVitalsButton(fresh);
      toast('体征已补录');
    },
  });
}

function renderVisitEditor(v) {
  const box = $('#doc-detail');
  if (!box) return;
  const editable = v.status === 'IN_PROGRESS';
  const allergyAlert = v.patient.allergy && v.patient.allergy !== '无'
    ? `<div class="alert-line">过敏史：${esc(v.patient.allergy)}</div>` : '';
  const chronic = (v.patient.chronicTags || []).length
    ? `<div class="hint">慢病标签：${esc(v.patient.chronicTags.join('、'))}</div>` : '';
  const amendRows = v.amendments.length
    ? `<div class="section-title">更正留痕</div>` + v.amendments.map(a =>
      `<div class="hint">${esc(a.amendedAt)} · ${esc(a.amendedBy)} · ${esc(a.reason)}</div>`).join('')
    : '';
  const reports = state.visitReports || [];
  const reportRows = reports.filter(r => r.status === 'REPORTED').map(r => `<div class="rx-item-row">
      <span class="grow">${esc(r.itemName)} ${badge(r.status)}
        ${r.critical ? '<span class="badge danger">危急值</span>'
          : (r.abnormal ? '<span class="badge danger">异常</span>' : '')}</span>
      <span class="hint">${esc(r.conclusion || '')}</span>
      ${editable ? `<button class="btn small" data-quote-report="${r.id}">引用结论</button>` : ''}
    </div>`).join('');
  const reportSection = `<details class="fold">
      <summary>检查报告（${reports.filter(r => r.status === 'REPORTED').length} 份已出，异常 ${reports.filter(r => r.abnormal || r.critical).length}）</summary>
      <div id="v-reports" class="panel-body">${reportRows || '<p class="hint">暂无已出报告</p>'}</div>
    </details>`;

  box.innerHTML = `
    <div class="patient-strip">
      <div class="ps-name">${esc(v.patient.name)} <span class="hint">${esc(v.patient.gender)} · ${esc(ageFromBirth(v.patient.birthDate))}</span></div>
      <div class="kv">
        <div><span>病历号（MRN）</span>${esc(v.patient.mrn)}</div>
        <div><span>就诊号</span>${esc(v.visitNo)}</div>
        <div><span>科室</span>${esc(v.deptName)}</div>
        <div><span>接诊医生</span>${esc(v.doctorName)} ${esc(v.doctorTitle)}</div>
        <div><span>状态</span>${badge(v.status)}</div>
        <div><span>联系电话</span>${esc(v.patient.phoneMask || '—')}</div>
      </div>
      ${allergyAlert}${chronic}
    </div>

    <div class="section-title">生命体征</div>
    <div id="vitals-holder">${vitalsCardHtml(v)}</div>

    <details class="last-visits" id="last-visits">
      <summary>上次病历（近 5 次）</summary>
      <div id="last-visits-body"><p class="hint">加载中…</p></div>
    </details>

    <div class="section-title">结构化病历</div>
    <div class="emr-grid">${EMR_SECTION_META.map(m => emrSectionHtml(m, v[m.key], editable)).join('')}</div>
    ${reportSection}
    ${amendRows}`;

  EMR_SECTION_META.forEach(m => updateCharCount(m.id));
  bindVitalsButton(v);

  const lvBox = document.getElementById('last-visits');
  if (lvBox) {
    lvBox.addEventListener('click', e => {
      const btn = e.target.closest('button[data-quote]');
      if (!btn || !editable) return;
      const item = (state.lastVisits || [])[Number(btn.dataset.quote)];
      const ta = document.getElementById('v-cc');
      if (!item || !ta) return;
      const text = item.chiefComplaint || '';
      ta.value = ta.value.trim() ? ta.value.replace(/\s+$/, '') + '\n' + text : text;
      markDirty();
      updateCharCount('v-cc');
      toast('已引用上次主诉');
    });
  }

  const reportBox = document.getElementById('v-reports');
  if (reportBox && editable) {
    reportBox.addEventListener('click', e => {
      const btn = e.target.closest('button[data-quote-report]');
      if (!btn) return;
      const report = (state.visitReports || []).find(r => String(r.id) === btn.dataset.quoteReport);
      const ta = document.getElementById('v-ax');
      if (!report || !ta) return;
      const text = `[${report.itemName}] ${report.conclusion}`;
      ta.value = ta.value.trim() ? ta.value.replace(/\s+$/, '') + '\n' + text : text;
      markDirty();
      updateCharCount('v-ax');
      toast('已引用报告结论');
    });
  }

  if (!editable) return;
  box.oninput = e => {
    if (e.target.tagName === 'TEXTAREA') {
      markDirty();
      updateCharCount(e.target.id);
    }
  };
  box.onchange = e => {
    const sel = e.target.closest('select[data-tpl]');
    if (!sel || sel.value === '') return;
    const meta = EMR_SECTION_META.find(m => m.key === sel.dataset.tpl);
    if (!meta) return;
    const text = (EMR_TEMPLATES[meta.key] || [])[Number(sel.value)] || '';
    const ta = document.getElementById(meta.id);
    if (!ta || !text) return;
    ta.value = ta.value.trim() ? ta.value.replace(/\s+$/, '') + '\n' + text : text;
    markDirty();
    updateCharCount(meta.id);
    sel.value = '';
  };
}

function renderVisitSide(v) {
  const box = $('#doc-side');
  if (!box) return;
  const editable = v.status === 'IN_PROGRESS';
  const diagnoses = v.diagnoses || [];
  const primaryName = (diagnoses.find(d => d.isPrimary) || {}).name || v.diagnosisName || '';

  const diagRows = diagnoses.length ? diagnoses.map(d => `<div class="rx-item-row">
      <span class="grow">${esc(d.code)} ${esc(d.name)}
        ${d.isPrimary ? '<span class="badge info">主诊断</span>' : ''}
        ${d.suspected ? '<span class="badge warn">疑似</span>' : ''}</span>
      ${editable ? `<button class="btn small danger" data-del-diag="${d.id}">删除</button>` : ''}
    </div>`).join('') : '<p class="hint">尚未保存诊断</p>';

  const icdOptions = (state.icd || []).map(i =>
    `<option value="${esc(i.code)}" ${i.code === v.diagnosisCode ? 'selected' : ''}>${esc(i.code)} ${esc(i.name)}</option>`
  ).join('');

  const rxRows = v.prescriptions.map(p => `<div class="rx-item-row">
      <span class="grow">${esc(p.rxNo)} · ${money(p.totalAmount)} ${badge(p.status)}</span>
      <span class="hint">${esc(p.reviewerName ? '审方：' + p.reviewerName : '')} ${esc(p.reviewComment || '')}</span>
    </div>`).join('');

  const labRows = v.labOrders.map(o => `<div class="rx-item-row">
      <span class="grow">${esc(o.itemName)} ${badge(o.status)} ${o.critical ? '<span class="badge danger">危急值</span>' : (o.abnormal ? '<span class="badge danger">异常</span>' : '')}</span>
      <span class="hint">${esc(o.conclusion || '')}</span>
    </div>`).join('');

  const stay = v.bedStay;
  const stayInfo = stay
    ? `<p class="hint">已入 ${esc(stay.bedNo)}（${esc(stay.zone)}）：${esc(stay.nursingLevel || '护理级别未定')} · ${esc(stay.diet || '普食')} · ${esc(stay.inAt)}</p>`
    : '';
  const freeBeds = (state.beds || []).filter(b => b.status === 'FREE');
  const bedOptions = freeBeds.length
    ? freeBeds.map(b => `<option value="${b.id}">${esc(b.bedNo)}（${esc(b.zone)}）</option>`).join('')
    : '<option value="">暂无空床</option>';

  box.innerHTML = `
    <div class="panel">
      <div class="panel-head"><h3>诊断</h3></div>
      <div class="panel-body">
        <div>${diagRows}</div>
        ${editable ? `
          <div class="section-title">添加诊断</div>
          <div class="form-grid">
            <label class="full">ICD-10 诊断<input id="sd-code" placeholder="拼音简码 / 名称 / 编码，如 gxy" style="min-width:230px" autocomplete="off"></label>
            <label class="full">诊断说明<input id="sd-note" maxlength="500"></label>
            <label class="check-line"><input type="checkbox" id="sd-suspected"> 设为疑似</label>
          </div>
          <div class="form-actions col-actions">
            <button class="btn primary" id="sd-primary">设为主诊断</button>
            <button class="btn" id="sd-secondary">添加次要诊断</button>
          </div>` : ''}
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><h3>处方</h3></div>
      <div class="panel-body">
        ${editable ? `
          <div class="form-grid">
            <label class="full">药品<input id="rx-drug" placeholder="拼音简码 / 名称 / 编码，如 aspl" style="min-width:230px" autocomplete="off"></label>
            <label>用法<input id="rx-dosage" placeholder="如 口服"></label>
            <label>频次<input id="rx-frequency" placeholder="如 一日三次"></label>
            <label>天数<input id="rx-days" type="number" min="1" max="30" value="3"></label>
            <label>数量<input id="rx-qty" type="number" min="1" max="99" value="1"></label>
          </div>
          <div class="form-actions"><button class="btn" id="rx-add">添加</button></div>
          <div id="rx-draft"></div>
          <div id="rx-warnings"></div>
          <div class="form-actions"><button class="btn primary" id="rx-submit">提交处方</button></div>` : ''}
        <div>${rxRows || '<p class="hint">暂无处方</p>'}</div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><h3>检查申请</h3></div>
      <div class="panel-body">
        ${editable ? `
          <div class="lab-search-row"><input id="lab-search" placeholder="检索检查项目，如 xdt / 心" autocomplete="off" style="min-width:230px"></div>
          <div class="lab-picker" id="lab-picker">
            ${(state.labItems || []).map(i => `<label class="lab-item">
              <input type="checkbox" value="${esc(i.code)}"> ${esc(i.name)} ${money(i.price)}
            </label>`).join('')}
          </div>
          <div class="form-actions"><button class="btn primary" id="lab-submit">提交检查</button></div>` : ''}
        <div>${labRows || '<p class="hint">暂无检查</p>'}</div>
      </div>
    </div>

    <details class="fold panel-fold">
      <summary>更多操作：留观 / 单据 / 质控</summary>
      <div class="panel">
        <div class="panel-head"><h3>留观开立</h3></div>
        <div class="panel-body">
          ${stayInfo}
          ${can('bed.write') && !stay ? `
            <div class="form-grid">
              <label class="full">床位<select id="stay-bed">${bedOptions}</select></label>
              <label>护理级别<select id="stay-level"><option>一级护理</option><option selected>二级护理</option><option>三级护理</option></select></label>
              <label>饮食<select id="stay-diet"><option>普食</option><option>半流质</option><option>禁食</option><option>糖尿病饮食</option></select></label>
              <label class="full">留观诊断<input id="stay-diag" maxlength="200" value="${esc(primaryName)}"></label>
            </div>
            <div class="form-actions"><button class="btn primary" id="stay-submit" ${freeBeds.length ? '' : 'disabled'}>开立留观</button></div>`
            : (!stay && can('bed.read') ? '<p class="hint">无开立留观权限</p>' : '')}
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><h3>单据与打印</h3></div>
        <div class="panel-body">
          <div class="form-actions col-actions">
            <button class="btn small" data-doc="visit" data-id="${v.id}">打印病历</button>
            <button class="btn small" data-doc="packet" data-id="${v.id}">打印单据包</button>
            <button class="btn small" data-doc="visit" data-id="${v.id}" data-fmt="pdf">病历 PDF</button>
            <button class="btn small" data-doc="packet" data-id="${v.id}" data-fmt="pdf">单据包 PDF</button>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><h3>质控提示</h3></div>
        <div class="panel-body" id="qc-box"><p class="hint">加载中…</p></div>
      </div>
    </details>

    <div class="panel">
      <div class="panel-head"><h3>病历操作</h3></div>
      <div class="panel-body">
        <div class="form-actions col-actions">
          ${editable ? '<button class="btn primary" id="v-save">保存病历</button>' : ''}
          ${editable ? '<button class="btn" id="v-finish">完成就诊</button>' : ''}
          ${v.status === 'FINISHED' ? '<button class="btn" id="v-amend">更正病历（留痕）</button>' : ''}
        </div>
      </div>
    </div>`;

  const refreshSide = async () => {
    const fresh = await api('GET', `/api/v1/visits/${v.id}`);
    state.visit = fresh;
    renderVisitSide(fresh);
  };

  if (editable) {
    // IDEA 式自动补全：诊断（ICD-10 字典）/ 药品（药品字典，选中联动用法频次）/ 检查项目检索
    AutoComplete.attach($('#sd-code'), {
      items: () => state.icd || [],
      label: d => d.name, code: d => d.code,
      sub: d => `${d.code}${d.category ? ' · ' + d.category : ''}`,
      emptyHint: '无匹配诊断，可输入编码前缀或拼音简码',
    });
    AutoComplete.attach($('#rx-drug'), {
      items: () => (state.drugs || []).filter(d => d.status === 'ACTIVE'),
      label: d => d.name, code: d => d.code,
      sub: d => `${d.spec} · ${money(d.price)}/${d.unit} · 库存${d.stock}${d.antibioticLevel ? ' · ' + d.antibioticLevel + '级抗菌' : ''}`,
      tabTarget: '#rx-dosage',
      onPick: (d, el) => {
        el.dataset.drugId = d.id;
        const dos = $('#rx-dosage'); const frq = $('#rx-frequency');
        if (dos && !dos.value) dos.value = d.defaultRoute || '';
        if (frq && !frq.value) frq.value = d.defaultFreq || '';
      },
    });
    AutoComplete.attach($('#lab-search'), {
      items: () => state.labItems || [],
      label: i => i.name, code: i => i.code,
      sub: i => `${money(i.price)}${i.category ? ' · ' + i.category : ''}`,
      emptyHint: '无匹配检查项目',
      onPick: (i, el) => {
        const cb = document.querySelector(`#lab-picker input[value="${i.code}"]`);
        if (cb) cb.checked = true;
        el.value = '';
      },
    });
    const addDiagnosis = async isPrimary => {
      const el = document.getElementById('sd-code');
      const code = el.dataset.acValue || el.value.trim();
      if (!code) { toast('请选择诊断编码', 'error'); return; }
      const suspectedEl = document.getElementById('sd-suspected');
      try {
        await api('POST', `/api/v1/visits/${v.id}/diagnoses`, {
          code,
          isPrimary,
          suspected: Boolean(suspectedEl && suspectedEl.checked),
          note: formVal('sd-note'),
        });
        toast(isPrimary ? '已设为主诊断' : '已添加次要诊断');
        await refreshSide();
      } catch (err) { toast(err.message, 'error'); }
    };
    $('#sd-primary').onclick = () => addDiagnosis(true);
    $('#sd-secondary').onclick = () => addDiagnosis(false);

    $$('#doc-side button[data-del-diag]').forEach(btn => {
      btn.onclick = () => confirmAction('确认删除该诊断？删除主诊断后系统会自动提升下一条。', async () => {
        await api('DELETE', `/api/v1/visits/${v.id}/diagnoses/${btn.dataset.delDiag}`);
        toast('诊断已删除');
        await refreshSide();
      });
    });

    $('#rx-add').onclick = () => {
      const drugId = Number(document.getElementById('rx-drug').dataset.drugId || 0);
      const dosage = formVal('rx-dosage');
      const frequency = formVal('rx-frequency');
      const days = formNum('rx-days');
      const quantity = formNum('rx-qty');
      if (!drugId || !dosage || !frequency || !days || !quantity) {
        toast('请完整填写用法、频次、天数与数量', 'error');
        return;
      }
      state.rxItems.push({ drugId, dosage, frequency, days, quantity });
      renderRxDraft();
    };
    $('#rx-submit').onclick = async () => {
      if (!state.rxItems.length) { toast('请先添加药品', 'error'); return; }
      const submit = async () => {
        const data = await api('POST', `/api/v1/visits/${v.id}/prescriptions`, { items: state.rxItems });
        toast(`处方已提交：${data.rxNo}，合计 ${money(data.totalAmount)}`);
        state.rxItems = [];
        await refreshSide();
      };
      let check;
      try {
        // 合理用药前置审核：先校验再提交
        check = await api('POST', '/api/v1/rx-check', {
          patientId: v.patient.id, items: state.rxItems,
        });
      } catch (err) { toast(err.message, 'error'); return; }
      const high = check.warnings.filter(w => w.level === 'HIGH');
      const rest = check.warnings.filter(w => w.level !== 'HIGH');
      const warnBox = document.getElementById('rx-warnings');
      if (warnBox) warnBox.innerHTML = rest.map(w => `<div class="warn-line">${esc(w.message)}</div>`).join('');
      if (!high.length && !rest.length) {
        try { await submit(); } catch (err) { toast(err.message, 'error'); }
        return;
      }
      if (high.length) {
        // 过敏冲突为服务端硬阻断：不再提供「仍要提交」，必须更换药品
        const submitBtn = document.getElementById('rx-submit');
        if (submitBtn) submitBtn.disabled = true;
        if (warnBox) {
          warnBox.innerHTML = high.map(w => `<div class="alert-line">${esc(w.message)}</div>`).join('')
            + rest.map(w => `<div class="warn-line">${esc(w.message)}</div>`).join('');
        }
        openModal({
          title: '存在过敏禁忌，请更换药品',
          okText: '我知道了',
          body: high.map(w => `<div class="alert-line">${esc(w.message)}</div>`).join('')
            + '<p class="hint">请移除或更换冲突药品后再提交，系统将拒绝存在过敏禁忌的处方。</p>',
        });
      } else {
        openModal({
          title: '合理用药提示',
          okText: '仍要提交',
          body: rest.map(w => `<div class="warn-line">${esc(w.message)}</div>`).join(''),
          onOk: submit,
        });
      }
    };
    $('#lab-submit').onclick = async () => {
      const codes = $$('#lab-picker input[type=checkbox]:checked').map(el => el.value);
      if (!codes.length) { toast('请选择检查项目', 'error'); return; }
      try {
        const data = await api('POST', `/api/v1/visits/${v.id}/lab-orders`, { items: codes });
        toast(`已提交 ${data.orders.length} 项检查`);
        await refreshSide();
      } catch (err) { toast(err.message, 'error'); }
    };

    const stayBtn = document.getElementById('stay-submit');
    if (stayBtn) {
      stayBtn.onclick = async () => {
        const bedId = Number(formVal('stay-bed'));
        if (!bedId) { toast('暂无可用空床', 'error'); return; }
        try {
          const data = await api('POST', '/api/v1/bed-stays', {
            patientId: v.patient.id,
            visitId: v.id,
            bedId,
            nursingLevel: formVal('stay-level'),
            diet: formVal('stay-diet'),
            diagnosis: formVal('stay-diag') || primaryName,
          });
          const bed = (state.beds || []).find(b => b.id === bedId) || {};
          toast(`留观已开立：${data.stayNo}，床号 ${bed.bedNo || ''}`);
          state.beds = await api('GET', '/api/v1/beds');
          await refreshSide();
        } catch (err) { toast(err.message, 'error'); }
      };
    }

    $('#v-save').onclick = async () => {
      try {
        await api('PATCH', `/api/v1/visits/${v.id}`, {
          chiefComplaint: formVal('v-cc'),
          presentIllness: formVal('v-pi'),
          pastHistory: formVal('v-ph'),
          allergyHistory: formVal('v-ah'),
          physicalExam: formVal('v-pe'),
          auxiliaryExam: formVal('v-ax'),
          treatmentAdvice: formVal('v-adv'),
        });
        state.dirty = false;
        toast('病历已保存');
        await openVisit(v.id, { force: true });
      } catch (err) { toast(err.message, 'error'); }
    };
    $('#v-finish').onclick = () => {
      const ta = document.getElementById('v-cc');
      if (!ta || !ta.value.trim()) {
        toast('请先填写主诉', 'error');
        if (ta) ta.focus();
        return;
      }
      const current = state.visit || v;
      if (!(current.diagnoses || []).length && !current.diagnosisCode) {
        toast('请先保存至少一条诊断', 'error');
        return;
      }
      confirmAction('确认完成本次就诊？完成后病历修改须走更正留痕。', async () => {
        await api('POST', `/api/v1/visits/${v.id}/finish`);
        state.dirty = false;
        toast('就诊已完成');
        await Promise.all([openVisit(v.id, { force: true }), refreshDoctorLists()]);
      });
    };
  }
  if (v.status === 'FINISHED') {
    $('#v-amend').onclick = () => {
      openModal({
        title: '更正病历',
        okText: '提交更正',
        body: `
          <label>更正原因（≥5 字）<input id="am-reason" maxlength="200"></label>
          <label>新的处理意见<textarea id="am-adv">${esc(v.treatmentAdvice)}</textarea></label>`,
        onOk: async () => {
          const reason = formVal('am-reason');
          if (reason.length < 5) throw new Error('更正原因不得少于 5 个字');
          await api('POST', `/api/v1/visits/${v.id}/amendments`, {
            reason, changes: { treatmentAdvice: formVal('am-adv') },
          });
          toast('更正已提交并留痕');
          await openVisit(v.id, { force: true });
        },
      });
    };
  }
  renderRxDraft();
  loadQc(v.id);
}

function qcHtml(qc) {
  const rows = qc.items.map(i => {
    const cls = i.ok ? 'ok' : (i.level === 'HIGH' ? 'bad' : 'warn');
    const tail = i.ok ? '通过' : (i.level === 'HIGH' ? '必填缺失' : '建议补充');
    return `<div class="qc-item ${cls}"><span>${esc(i.label)}</span><span>${tail}</span></div>`;
  }).join('');
  return `<div class="qc-rate">完整率 <strong>${esc(qc.passRate)}%</strong></div>${rows}`;
}

async function loadQc(visitId) {
  const box = document.getElementById('qc-box');
  if (!box) return;
  try {
    const qc = await api('GET', `/api/v1/visits/${visitId}/qc`);
    box.innerHTML = qcHtml(qc);
  } catch (err) {
    box.innerHTML = `<p class="hint">${esc(err.message)}</p>`;
  }
}

function renderRxDraft() {
  const box = document.getElementById('rx-draft');
  if (!box) return;
  // 药品清单变化（移除/更换）后重新开放提交，冲突判定交给下次提交前的预检
  const submitBtn = document.getElementById('rx-submit');
  if (submitBtn) submitBtn.disabled = false;
  box.innerHTML = state.rxItems.map((item, idx) => {
    const drug = (state.drugs || []).find(d => d.id === item.drugId) || {};
    return `<div class="rx-item-row">
      <span class="grow">${esc(drug.name || item.drugId)} · ${esc(item.dosage)} · ${esc(item.frequency)} · ${item.days} 天 · ${item.quantity} ${esc(drug.unit || '')}</span>
      <button class="btn small danger" data-rmrx="${idx}">移除</button>
    </div>`;
  }).join('');
  box.onclick = e => {
    const btn = e.target.closest('button');
    if (btn && btn.dataset.rmrx) {
      state.rxItems.splice(Number(btn.dataset.rmrx), 1);
      renderRxDraft();
    }
  };
}

async function refreshDoctorLists() {
  if (state.view !== 'doctor') return;
  const [pending, visits] = await Promise.all([
    api('GET', `/api/v1/registrations?date=${todayStr()}&status=CHECKED_IN`),
    api('GET', `/api/v1/visits?date=${todayStr()}`),
  ]);
  const pendingEl = document.getElementById('doc-pending');
  if (pendingEl) {
    pendingEl.innerHTML = pending.length
      ? pending.map(r => `<div class="mini-row">
          <div class="mini-main"><strong>${esc(r.queueNo || '—')}</strong> <span class="link-patient" data-patient="${r.patientId}">${esc(r.patientName)}</span></div>
          <div class="mini-sub">${esc(r.patientMrn)} · ${esc(r.deptName)}</div>
          <div class="mini-actions"><button class="btn small primary" data-start="${r.id}">接诊</button></div>
        </div>`).join('')
      : '<p class="empty">暂无待接诊患者</p>';
  }
  const visitsEl = document.getElementById('doc-visits');
  if (visitsEl) {
    visitsEl.innerHTML = visits.length
      ? visits.map(r => `<div class="mini-row" data-open="${r.id}">
          <div class="mini-main"><span class="link-patient" data-patient="${r.patientId}">${esc(r.patientName)}</span> ${badge(r.status)}</div>
          <div class="mini-sub">${esc(r.visitNo)} · ${esc(r.diagnosisName || '未诊断')}</div>
          <div class="mini-actions">
            <button class="btn small" data-open="${r.id}">查看</button>
            <button class="btn small" data-doc="visit" data-id="${r.id}">打印</button>
          </div>
        </div>`).join('')
      : '<p class="empty">今日暂无就诊记录</p>';
  }
}

/* ---------------------------------------------------------------- 留观床位 / 护理执行 */

const BED_STATUS_TEXT = { FREE: '空床', OCCUPIED: '占床', CLEANING: '待清洁', DISABLED: '停用' };
const BED_STATUS_CLASS = { FREE: 'free', OCCUPIED: 'occupied', CLEANING: 'cleaning', DISABLED: 'disabled' };
const ORDER_TYPE_TEXT = { INFUSION: '输液', INJECTION: '注射', OBSERVE: '观察', MEASURE: '测量' };
const NURSING_ROUTES = ['静脉滴注', '静脉注射', '肌内注射', '皮下注射', '口服'];

function nursingVitalText(r) {
  const parts = [];
  if (r.temperature !== null && r.temperature !== undefined) parts.push('体温 ' + r.temperature + ' ℃');
  if (r.pulse) parts.push('脉搏 ' + r.pulse + ' 次/分');
  if (r.respiration) parts.push('呼吸 ' + r.respiration + ' 次/分');
  if (r.systolic && r.diastolic) parts.push('血压 ' + r.systolic + '/' + r.diastolic + ' mmHg');
  if (r.spo2) parts.push('血氧 ' + r.spo2 + ' %');
  return parts.length ? esc(parts.join(' · ')) : '<span class="hint">未记录数值</span>';
}

function bedCardHtml(b) {
  const cls = BED_STATUS_CLASS[b.status] || '';
  const occupant = b.stayId
    ? `<div class="bed-occupant"><strong>${esc(b.patientName || '')}</strong>
        <div class="hint">${esc(b.patientMrn || '')}${b.nursingLevel ? ' · ' + esc(b.nursingLevel) : ''}</div></div>`
    : '';
  const cleanBtn = b.status === 'CLEANING' && can('bed.write')
    ? `<button class="btn small" data-clean="${b.id}">保洁完成</button>` : '';
  return `<div class="bed-card ${cls}" data-bed="${b.id}" ${b.stayId ? `data-stay="${b.stayId}"` : ''}>
    <div class="bed-top"><strong>${esc(b.bedNo)}</strong><span class="hint">${b.kind === 'CHAIR' ? '输液椅' : '观察床'}</span></div>
    <div class="bed-state">${esc(BED_STATUS_TEXT[b.status] || b.status)}</div>
    ${occupant}${cleanBtn}
  </div>`;
}

async function viewBeds() {
  const rows = await api('GET', '/api/v1/beds');
  state.beds = rows;
  const zones = [];
  rows.forEach(b => { if (!zones.includes(b.zone)) zones.push(b.zone); });
  const count = status => rows.filter(b => b.status === status).length;
  content.innerHTML = `
    <div class="panel">
      <div class="panel-head"><h3>留观床位看板</h3><button class="btn small" id="beds-refresh">刷新</button></div>
      <div class="panel-body">
        <div class="bed-legend">
          <span><i class="dot free"></i>空床 ${count('FREE')}</span>
          <span><i class="dot occupied"></i>占床 ${count('OCCUPIED')}</span>
          <span><i class="dot cleaning"></i>待清洁 ${count('CLEANING')}</span>
          <span><i class="dot disabled"></i>停用 ${count('DISABLED')}</span>
        </div>
        ${zones.map(z => `
          <div class="section-title">${esc(z)}</div>
          <div class="bed-grid">${rows.filter(b => b.zone === z).map(bedCardHtml).join('')}</div>`).join('')}
        <p class="hint">点击占床卡片查看留观详情；待清洁床位可点击「保洁完成」恢复空闲。</p>
      </div>
    </div>`;

  $('#beds-refresh').onclick = () => viewBeds().catch(err => toast(err.message, 'error'));

  $$('#content .bed-card').forEach(card => {
    card.onclick = e => {
      if (e.target.closest('button[data-clean]')) return;
      if (card.dataset.stay) {
        openStayDetail(Number(card.dataset.stay)).catch(err => toast(err.message, 'error'));
      } else if (card.querySelector('.bed-state') && card.querySelector('.bed-state').textContent === '空床') {
        toast('请在医生站为本床开立留观');
      }
    };
  });
  $$('#content button[data-clean]').forEach(btn => {
    btn.onclick = async () => {
      try {
        await api('POST', `/api/v1/beds/${btn.dataset.clean}/clean`);
        toast('床位已恢复空闲');
        await viewBeds();
      } catch (err) { toast(err.message, 'error'); }
    };
  });
}

async function openStayDetail(stayId) {
  const [detail, beds] = await Promise.all([
    api('GET', `/api/v1/bed-stays/${stayId}`),
    api('GET', '/api/v1/beds'),
  ]);
  const s = detail.stay;
  const freeBeds = beds.filter(b => b.status === 'FREE');
  const orderRows = detail.orders.length
    ? detail.orders.map(o => `<div class="rx-item-row">
        <span class="grow">${esc(ORDER_TYPE_TEXT[o.orderType] || o.orderType)} · ${esc(o.content)}
          ${o.dose ? ' · ' + esc(o.dose) : ''}${o.route ? ' · ' + esc(o.route) : ''}${o.frequency ? ' · ' + esc(o.frequency) : ''}</span>
        <span>${badge(o.status)}</span>
      </div>`).join('')
    : '<p class="hint">暂无医嘱</p>';

  const body = `
    <div class="kv">
      <div><span>留观单号</span>${esc(s.stayNo)}</div>
      <div><span>患者</span>${esc(detail.patient.name)}（${esc(detail.patient.gender)}）</div>
      <div><span>病历号</span>${esc(detail.patient.mrn)}</div>
      <div><span>床位</span>${esc(detail.bed.bedNo)}（${esc(detail.bed.zone)}）</div>
      <div><span>护理级别</span>${esc(s.nursingLevel || '—')}</div>
      <div><span>饮食</span>${esc(s.diet || '—')}</div>
      <div><span>留观诊断</span>${esc(s.diagnosis || '—')}</div>
      <div><span>入床时间</span>${esc(s.inAt)}</div>
    </div>
    ${detail.patient.allergy && detail.patient.allergy !== '无'
      ? `<div class="alert-line">过敏史：${esc(detail.patient.allergy)}</div>` : ''}
    <div class="section-title">医嘱</div>
    <div>${orderRows}</div>
    ${can('bed.write') ? `
      <div class="section-title">开立医嘱</div>
      <div class="form-grid">
        <label>类型<select id="so-type">${Object.entries(ORDER_TYPE_TEXT).map(([k, v]) =>
          `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
        <label class="full">内容<input id="so-content" maxlength="200" placeholder="如 0.9% 氯化钠 250ml"></label>
        <label>剂量<input id="so-dose" maxlength="40"></label>
        <label>途径<select id="so-route">${NURSING_ROUTES.map(r => `<option>${esc(r)}</option>`).join('')}</select></label>
        <label>频次<input id="so-freq" maxlength="40" placeholder="如 每日一次"></label>
      </div>
      <div class="form-actions"><button class="btn primary" id="so-submit">开立医嘱</button></div>

      <div class="section-title">转床</div>
      <div class="filter-bar">
        <label class="grow">目标床位<select id="so-bed">${freeBeds.length
          ? freeBeds.map(b => `<option value="${b.id}">${esc(b.bedNo)}（${esc(b.zone)}）</option>`).join('')
          : '<option value="">暂无空床</option>'}</select></label>
        <button class="btn" id="so-transfer" ${freeBeds.length ? '' : 'disabled'}>转床</button>
      </div>

      <div class="section-title">出区</div>
      <div class="filter-bar">
        <label class="grow">出区原因<input id="so-reason" maxlength="200" placeholder="如 病情稳定转门诊随访"></label>
        <button class="btn danger" id="so-discharge">办理出区</button>
      </div>` : ''}`;

  const modal = openModal({
    title: `留观详情 · ${s.stayNo}`,
    okText: '关闭',
    body,
    onOk: async () => {},
    onClose: () => { if (state.view === 'beds') viewBeds().catch(() => {}); },
  });

  const submitOrder = document.getElementById('so-submit');
  if (submitOrder) {
    submitOrder.onclick = async () => {
      const text = formVal('so-content');
      if (!text) { toast('请填写医嘱内容', 'error'); return; }
      try {
        await api('POST', `/api/v1/bed-stays/${stayId}/orders`, {
          items: [{
            orderType: formVal('so-type'), content: text,
            dose: formVal('so-dose'), route: formVal('so-route'), frequency: formVal('so-freq'),
          }],
        });
        toast('医嘱已开立');
        modal.close();
      } catch (err) { toast(err.message, 'error'); }
    };
  }
  const transferBtn = document.getElementById('so-transfer');
  if (transferBtn) {
    transferBtn.onclick = async () => {
      const bedId = Number(formVal('so-bed'));
      if (!bedId) { toast('暂无可用空床', 'error'); return; }
      try {
        const data = await api('POST', `/api/v1/bed-stays/${stayId}/transfer`, { bedId });
        toast(`已转至 ${data.bedNo}`);
        modal.close();
      } catch (err) { toast(err.message, 'error'); }
    };
  }
  const dischargeBtn = document.getElementById('so-discharge');
  if (dischargeBtn) {
    dischargeBtn.onclick = async () => {
      const reason = formVal('so-reason');
      if (!reason) { toast('请填写出区原因', 'error'); return; }
      try {
        await api('POST', `/api/v1/bed-stays/${stayId}/discharge`, { reason });
        toast('已办理出区，床位待清洁');
        modal.close();
      } catch (err) { toast(err.message, 'error'); }
    };
  }
}

async function viewNursing() {
  content.innerHTML = `
    <div class="panel">
      <div class="panel-head"><h3>待执行医嘱</h3><button class="btn small" id="nur-refresh">刷新</button></div>
      <div class="panel-body"><div id="nur-tasks"><p class="hint">加载中…</p></div></div>
    </div>
    <div class="split">
      <div class="panel">
        <div class="panel-head"><h3>在床患者</h3></div>
        <div class="panel-body" id="nur-stays"><p class="hint">加载中…</p></div>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>护理记录</h3></div>
        <div class="panel-body" id="nur-records"><p class="empty">选择上方在床患者查看护理记录</p></div>
      </div>
    </div>`;

  const loadTasks = async () => {
    const rows = await api('GET', '/api/v1/nursing-tasks?status=PENDING');
    const el = document.getElementById('nur-tasks');
    if (!el) return;
    el.innerHTML = rows.length ? table(
      ['床号', '患者', '医嘱内容', '途径 / 频次', '开立时间', '操作'],
      rows.map(r => `<tr>
        <td>${esc(r.bedNo)}<br><span class="hint">${esc(r.zone)}</span></td>
        <td>${patientCell(r.patientId, r.patientName, r.patientMrn)}</td>
        <td>${esc(ORDER_TYPE_TEXT[r.orderType] || r.orderType)} · ${esc(r.content)}${r.dose ? '<br><span class="hint">' + esc(r.dose) + '</span>' : ''}</td>
        <td>${esc([r.route, r.frequency].filter(Boolean).join(' / ') || '—')}</td>
        <td>${esc(r.orderedAt)}</td>
        <td>
          ${can('nursing.write') ? `<button class="btn small primary" data-exec="${r.id}">执行</button>` : ''}
          ${can('bed.write') ? `<button class="btn small danger" data-cancel-order="${r.id}">取消</button>` : ''}
        </td>
      </tr>`),
      '暂无待执行医嘱'
    ) : '<p class="empty">暂无待执行医嘱</p>';
  };

  const loadStays = async () => {
    const rows = await api('GET', '/api/v1/bed-stays?status=IN');
    const el = document.getElementById('nur-stays');
    if (!el) return;
    el.innerHTML = rows.length ? rows.map(r => `<div class="mini-row">
        <div class="mini-main">${esc(r.bedNo)} · ${esc(r.patientName)}</div>
        <div class="mini-sub">${esc(r.patientMrn)} · ${esc(r.nursingLevel || '护理级别未定')} · ${esc(r.diagnosis || '')}</div>
        <div class="mini-actions">
          <button class="btn small" data-records="${r.id}">护理记录</button>
          ${can('nursing.write')
            ? `<button class="btn small primary" data-add-record="${r.id}" data-np="${r.patientId}">记录体征</button>`
            : ''}
        </div>
      </div>`).join('') : '<p class="empty">暂无在床患者</p>';
  };

  const loadRecords = async stayId => {
    const el = document.getElementById('nur-records');
    if (!el) return;
    el.innerHTML = '<p class="hint">加载中…</p>';
    try {
      const rows = await api('GET', `/api/v1/nursing-records?stayId=${stayId}`);
      el.innerHTML = rows.length ? `<div class="timeline">${rows.map(r => `<div class="tl-item">
          <div class="tl-head">${esc(r.recordedAt)}</div>
          <div>${nursingVitalText(r)}</div>
          ${r.note ? `<div class="hint">${esc(r.note)}</div>` : ''}
        </div>`).join('')}</div>` : '<p class="empty">暂无护理记录</p>';
    } catch (err) {
      el.innerHTML = `<p class="hint">${esc(err.message)}</p>`;
    }
  };

  $('#nur-refresh').onclick = () => Promise.all([loadTasks(), loadStays()])
    .catch(err => toast(err.message, 'error'));

  const tasksEl = document.getElementById('nur-tasks');
  tasksEl.onclick = e => {
    const execBtn = e.target.closest('button[data-exec]');
    if (execBtn) {
      execBtn.disabled = true;
      api('POST', `/api/v1/nursing-orders/${execBtn.dataset.exec}/execute`, {})
        .then(async () => { toast('医嘱已执行'); await loadTasks(); })
        .catch(err => { toast(err.message, 'error'); execBtn.disabled = false; });
      return;
    }
    const cancelBtn = e.target.closest('button[data-cancel-order]');
    if (cancelBtn) {
      confirmAction('确认取消该条医嘱？', async () => {
        await api('POST', `/api/v1/nursing-orders/${cancelBtn.dataset.cancelOrder}/cancel`, {});
        toast('医嘱已取消');
        await loadTasks();
      });
    }
  };

  const staysEl = document.getElementById('nur-stays');
  staysEl.onclick = e => {
    const recBtn = e.target.closest('button[data-records]');
    if (recBtn) { loadRecords(Number(recBtn.dataset.records)); return; }
    const addBtn = e.target.closest('button[data-add-record]');
    if (addBtn) openNursingRecordModal(Number(addBtn.dataset.np), Number(addBtn.dataset.addRecord));
  };

  await Promise.all([loadTasks(), loadStays()]);
}

function openNursingRecordModal(patientId, stayId) {
  openModal({
    title: '记录生命体征',
    okText: '保存记录',
    body: `
      <div class="form-grid">
        <label>体温（℃）<input id="nr-temp" type="number" step="0.1"></label>
        <label>脉搏（次/分）<input id="nr-pulse" type="number"></label>
        <label>呼吸（次/分）<input id="nr-resp" type="number"></label>
        <label>收缩压（mmHg）<input id="nr-sys" type="number"></label>
        <label>舒张压（mmHg）<input id="nr-dia" type="number"></label>
        <label>血氧（%）<input id="nr-spo2" type="number"></label>
        <label class="full">备注<textarea id="nr-note" maxlength="500"></textarea></label>
      </div>`,
    onOk: async () => {
      const note = formVal('nr-note');
      const vitals = {
        temperature: formNum('nr-temp'), pulse: formNum('nr-pulse'), respiration: formNum('nr-resp'),
        systolic: formNum('nr-sys'), diastolic: formNum('nr-dia'), spo2: formNum('nr-spo2'),
      };
      Object.keys(vitals).forEach(k => { if (vitals[k] === undefined) delete vitals[k]; });
      if (!Object.keys(vitals).length && !note) throw new Error('请至少录入一项体征或备注');
      await api('POST', '/api/v1/nursing-records', { patientId, stayId, note, ...vitals });
      toast('护理记录已保存');
      if (state.view === 'nursing') await viewNursing();
    },
  });
}

/* ---------------------------------------------------------------- 药房 */

async function viewPharmacy() {
  content.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h3>处方审方</h3>
        <div class="seg" id="rx-tabs">
          <button type="button" class="seg-btn" data-ptab="SUBMITTED">待审方</button>
          <button type="button" class="seg-btn" data-ptab="APPROVED">待发药</button>
          <button type="button" class="seg-btn" data-ptab="DISPENSED">已发药</button>
        </div>
      </div>
      <div class="panel-body">
        <div class="filter-bar">
          <label class="grow">查找<input id="rx-q" placeholder="处方号 / 患者 / 病历号"></label>
          <button type="button" class="btn small" id="rx-refresh">刷新</button>
        </div>
        <div id="rx-summary" class="stat-line"></div>
        <div id="rx-list"></div>
      </div>
    </div>`;

  state.rxQuery = '';
  const paint = () => {
    const q = (state.rxQuery || '').trim().toLowerCase();
    const all = state.rxRows || [];
    const rows = all.filter(r => !q
      || `${r.rxNo} ${r.patientName} ${r.patientMrn} ${r.doctorName}`.toLowerCase().includes(q));
    const sum = all.reduce((s, r) => s + Number(r.totalAmount || 0), 0);
    $('#rx-summary').innerHTML = `<span>本页 <strong>${all.length}</strong> 张</span>`
      + `<span>合计 <strong>${money(sum)}</strong></span>`
      + (state.rxTab === 'SUBMITTED' ? '<span>点击任一行看明细后再审方</span>' : '');
    $('#rx-list').innerHTML = rows.length
      ? `<div class="task-list">${rows.map(rxRowHtml).join('')}</div>`
      : '<p class="empty">暂无处方</p>';
  };
  const load = async (tab) => {
    state.rxTab = tab;
    $$('#rx-tabs [data-ptab]').forEach(b => b.classList.toggle('active', b.dataset.ptab === tab));
    state.rxRows = await api('GET', `/api/v1/prescriptions?status=${tab}`);
    paint();
  };

  $$('#rx-tabs [data-ptab]').forEach(btn => {
    btn.onclick = () => load(btn.dataset.ptab).catch(err => toast(err.message, 'error'));
  });
  $('#rx-refresh').onclick = () => load(state.rxTab).catch(err => toast(err.message, 'error'));
  $('#rx-q').oninput = e => { state.rxQuery = e.target.value; paint(); };
  $('#rx-list').onclick = e => {
    const row = e.target.closest('[data-rx]');
    if (row) openRxDrawer(Number(row.dataset.rx));
  };

  await load(state.rxTab || 'SUBMITTED');
}

function rxRowHtml(r) {
  const items = r.items || [];
  const head = items[0] ? `${items[0].drugName}×${items[0].quantity}` : '—';
  const extra = items.length > 1 ? ` 等 ${items.length} 种` : '';
  const act = r.status === 'SUBMITTED'
    ? (can('rx.review') ? '审方' : '查看')
    : r.status === 'APPROVED' ? (can('rx.dispense') ? '发药' : '查看') : '查看';
  return `<button type="button" class="task-row" data-rx="${r.id}">
      <span class="task-main">
        <span class="task-title">${esc(r.patientName)} <span class="hint">${esc(r.patientMrn)}</span></span>
        <span class="task-sub">${esc(r.rxNo)} · ${esc(r.doctorName)} · ${esc(head)}${esc(extra)}</span>
      </span>
      <span class="task-amount">${money(r.totalAmount)}</span>
      <span class="task-due">${badge(r.status)}</span>
      <span class="task-go">${act}</span>
    </button>`;
}

async function openRxDrawer(rxId) {
  const rx = (state.rxRows || []).find(r => r.id === rxId);
  if (!rx) return;
  const root = $('#drawer-root');
  root.innerHTML = '<div class="drawer-mask"><aside class="drawer"><p class="empty">加载处方与患者信息…</p></aside></div>';
  let patient = null;
  try {
    const ov = await api('GET', `/api/v1/patients/${rx.patientId}/overview`);
    patient = ov.patient;
  } catch (err) {
    patient = null;
  }

  const items = rx.items || [];
  const itemRows = items.map(i => `<tr>
      <td><strong>${esc(i.drugName)}</strong><br><span class="hint">${esc(i.spec || '')}</span></td>
      <td>${esc(i.dosage || '—')}<br><span class="hint">${esc(i.frequency || '')}${i.days ? ' · ' + esc(i.days) + ' 天' : ''}</span></td>
      <td>${esc(String(i.quantity))}</td>
      <td>${money(i.amount)}</td>
    </tr>`).join('');
  const allergy = patient && (patient.allergy || '').trim();
  const allergyHtml = allergy && allergy !== '无'
    ? `<div class="alert-line">过敏史：${esc(allergy)}</div>`
    : '<p class="hint">过敏史：无记录</p>';
  const chronic = ((patient && patient.chronicTags) || [])
    .map(t => `<span class="badge info">${esc(t)}</span>`).join(' ');
  const reviewable = rx.status === 'SUBMITTED' && can('rx.review');
  const dispensable = rx.status === 'APPROVED' && can('rx.dispense');
  const actions = [];
  if (reviewable) {
    actions.push('<button type="button" class="btn danger" id="rx-reject">驳回</button>');
    actions.push('<button type="button" class="btn primary" id="rx-approve">通过并计费</button>');
  }
  if (dispensable) {
    actions.push('<button type="button" class="btn primary" id="rx-dispense">确认发药</button>');
  }
  actions.push(`<button type="button" class="btn small" data-doc="prescription" data-id="${rx.id}">打印处方</button>`);
  actions.push('<button type="button" class="btn ghost" data-drawer-close>关闭</button>');

  root.innerHTML = `<div class="drawer-mask">
    <aside class="drawer" role="dialog" aria-label="处方审方">
      <div class="drawer-head">
        <h3>${esc(rx.rxNo)} ${badge(rx.status)}</h3>
        <button type="button" class="btn ghost" data-drawer-close>关闭</button>
      </div>
      <div class="kv drawer-kv">
        <div><span>患者</span><span class="link-patient" data-patient="${rx.patientId}">${esc(rx.patientName)}</span></div>
        <div><span>病历号</span>${esc(rx.patientMrn)}</div>
        <div><span>性别/年龄</span>${esc((patient && patient.gender) || '—')} / ${patient && patient.birthDate ? esc(ageFromBirth(patient.birthDate)) : '—'}</div>
        <div><span>开方医生</span>${esc(rx.doctorName)}</div>
        <div><span>开方时间</span>${esc(rx.createdAt)}</div>
        <div><span>合计金额</span><strong>${money(rx.totalAmount)}</strong></div>
      </div>
      ${allergyHtml}
      ${chronic ? `<div style="margin:6px 0 2px">${chronic}</div>` : ''}
      <div class="section-title">处方明细（${items.length} 项）</div>
      <table class="detail-table">
        <thead><tr><th>药品</th><th>用法用量</th><th>数量</th><th>金额</th></tr></thead>
        <tbody>${itemRows}</tbody>
      </table>
      ${rx.reviewComment ? `<p class="hint">审方意见：${esc(rx.reviewComment)}</p>` : ''}
      ${reviewable ? `<div class="section-title">审方意见（驳回必填）</div>
        <div class="chips" id="rx-phrases">
          <button type="button" data-phrase="用法用量不适宜，请调整">用法用量不适宜</button>
          <button type="button" data-phrase="诊断与用药不符，请确认">用药与诊断不符</button>
          <button type="button" data-phrase="存在配伍禁忌/相互作用，请复核">配伍禁忌</button>
          <button type="button" data-phrase="抗菌药物使用需越级审批">抗菌药物越级</button>
        </div>
        <textarea id="rx-comment" maxlength="200" placeholder="通过可不填；驳回必须写明理由（不少于 2 字）"></textarea>` : ''}
      <div class="drawer-foot">${actions.join('')}</div>
    </aside>
  </div>`;

  root.querySelectorAll('[data-drawer-close]').forEach(b => { b.onclick = closeDrawer; });
  root.querySelector('.drawer-mask').addEventListener('click', e => {
    if (e.target.classList.contains('drawer-mask')) closeDrawer();
  });
  root.querySelectorAll('[data-phrase]').forEach(b => {
    b.onclick = () => {
      const ta = root.querySelector('#rx-comment');
      if (ta) ta.value = b.dataset.phrase;
    };
  });

  const refresh = () => viewPharmacy().catch(err => toast(err.message, 'error'));
  const approve = root.querySelector('#rx-approve');
  if (approve) {
    approve.onclick = async () => {
      approve.disabled = true;
      try {
        await api('POST', `/api/v1/prescriptions/${rx.id}/review`, {
          decision: 'APPROVE', comment: formVal('rx-comment'),
        });
        toast('处方已通过，已生成药品费账单');
        closeDrawer();
        await refresh();
      } catch (err) {
        toast(err.message, 'error');
        approve.disabled = false;
      }
    };
  }
  const reject = root.querySelector('#rx-reject');
  if (reject) {
    reject.onclick = async () => {
      const comment = formVal('rx-comment');
      if (comment.length < 2) {
        toast('驳回必须填写理由（不少于 2 字）', 'error');
        return;
      }
      reject.disabled = true;
      try {
        await api('POST', `/api/v1/prescriptions/${rx.id}/review`, { decision: 'REJECT', comment });
        toast('处方已驳回');
        closeDrawer();
        await refresh();
      } catch (err) {
        toast(err.message, 'error');
        reject.disabled = false;
      }
    };
  }
  const dispense = root.querySelector('#rx-dispense');
  if (dispense) {
    dispense.onclick = () => {
      confirmAction('确认发药？将原子扣减库存，且药品费必须已缴。', async () => {
        await api('POST', `/api/v1/prescriptions/${rx.id}/dispense`);
        toast('已发药');
        closeDrawer();
        await refresh();
      });
    };
  }
}

/* ---------------------------------------------------------------- 药品库存（次级页面） */

async function viewDrugs() {
  content.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h3>药品库存</h3>
        <button type="button" class="btn small" id="dg-refresh">刷新</button>
      </div>
      <div class="panel-body">
        <div class="filter-bar">
          <label class="grow">查找<input id="dg-q" placeholder="药品名称 / 编码"></label>
          <label class="check-line"><input type="checkbox" id="dg-low"> 只看低库存</label>
        </div>
        <div id="dg-summary" class="stat-line"></div>
        <div id="dg-table"></div>
      </div>
    </div>`;

  state.drugQuery = '';
  state.drugLowOnly = false;

  const paint = () => {
    const q = (state.drugQuery || '').trim().toLowerCase();
    const all = state.drugs || [];
    const rows = all.filter(d => (!q
      || `${d.name} ${d.code}`.toLowerCase().includes(q))
      && (!state.drugLowOnly || d.lowStock));
    const low = all.filter(d => d.lowStock).length;
    $('#dg-summary').innerHTML = `<span>共 <strong>${all.length}</strong> 种</span>`
      + `<span>低于预警线 <strong style="color:var(--danger)">${low}</strong> 种</span>`;
    $('#dg-table').innerHTML = rows.length ? table(
      ['药品', '库存 / 预警', '单价', '属性', '操作'],
      rows.map(d => `<tr>
        <td><strong>${esc(d.name)}</strong><br><span class="hint">${esc(d.code)} · ${esc(d.spec)}</span></td>
        <td>${d.lowStock ? `<span class="badge danger">${d.stock}</span>` : d.stock}<br><span class="hint">预警 ${d.alertStock}</span></td>
        <td>${money(d.price)}</td>
        <td>${d.controlled ? '<span class="badge danger">管制</span> ' : ''}${d.antibioticLevel ? `<span class="badge warn">${esc(d.antibioticLevel)}级抗菌</span>` : '—'}</td>
        <td>${can('drug.stock') ? `<button type="button" class="btn small" data-stock="${d.id}">入库</button>` : '—'}</td>
      </tr>`),
      '没有符合条件的药品'
    ) : '<p class="empty">没有符合条件的药品</p>';
  };

  const load = async () => {
    state.drugs = await api('GET', '/api/v1/drugs');
    paint();
  };

  $('#dg-refresh').onclick = () => load().catch(err => toast(err.message, 'error'));
  $('#dg-q').oninput = e => { state.drugQuery = e.target.value; paint(); };
  $('#dg-low').onchange = e => { state.drugLowOnly = e.target.checked; paint(); };
  $('#dg-table').onclick = e => {
    const btn = e.target.closest('button');
    if (!btn || !btn.dataset.stock) return;
    openModal({
      title: '药品入库',
      okText: '入库',
      body: `<label>入库数量<input id="si-qty" type="number" inputmode="numeric" min="1" max="100000" value="100"></label>
             <label>备注<input id="si-note" maxlength="100" placeholder="如 供应商到货"></label>`,
      onOk: async () => {
        const quantity = formNum('si-qty');
        if (!quantity) throw new Error('请填写入库数量');
        await api('POST', `/api/v1/drugs/${btn.dataset.stock}/stock-in`, { quantity, note: formVal('si-note') });
        toast('入库成功');
        await load();
      },
    });
  };

  await load();
}

/* ---------------------------------------------------------------- 收费 */

const CHARGE_CAT = {
  REGISTRATION: { name: '挂号费', cls: 'ok' },
  DRUG: { name: '药品费', cls: 'info' },
  LAB: { name: '检查费', cls: 'warn' },
  BED: { name: '床位费', cls: 'info' },
};

function chargeCat(cat) {
  return CHARGE_CAT[cat] || { name: cat || '其他', cls: '' };
}

function chargeRowHtml(r) {
  const cat = chargeCat(r.category);
  const payable = r.status === 'UNPAID' && can('charge.pay');
  return `<div class="ch-row" data-charge="${r.id}">
    ${r.status === 'UNPAID' && can('charge.pay')
      ? `<input type="checkbox" class="chk task-chk" value="${r.id}" ${state.selectedCharges.has(r.id) ? 'checked' : ''} aria-label="选择账单">` : ''}
    <div class="ch-main">
      <div class="ch-line1">
        <span class="ch-title">${esc(r.description || cat.name)}</span>
        <span class="ch-amount">${money(r.amount)}</span>
      </div>
      <div class="ch-line2">
        <span class="task-type ${cat.cls}">${esc(cat.name)}</span>
        <span class="ch-sub">${esc(r.patientName || '')} · ${esc(r.patientMrn || '')} · ${esc(r.chargeNo)}</span>
        <span class="ch-actions">
          ${badge(r.status)}
          ${payable ? `<button type="button" class="btn small primary" data-ch-pay="${r.id}">收费</button>` : ''}
          <span class="task-go">详情 ›</span>
        </span>
      </div>
    </div>
  </div>`;
}

async function viewCharge() {
  if (!state.chStatus) state.chStatus = 'UNPAID';
  if (!state.chCat) state.chCat = '';
  content.innerHTML = `
    <div class="panel">
      <div class="panel-head"><h3>收费窗口</h3>
        <button class="btn small primary" id="ch-pay" ${can('charge.pay') ? '' : 'disabled'}>批量收费</button>
      </div>
      <div class="panel-body">
        <div class="seg" id="ch-status">
          ${[['UNPAID', '待收费'], ['PAID', '已收费'], ['VOID', '已作废'], ['', '全部']]
            .map(([v, label]) => `<button type="button" class="seg-btn${state.chStatus === v ? ' active' : ''}" data-status="${v}">${label}</button>`).join('')}
        </div>
        <div class="filter-bar">
          <label>日期<input type="date" id="ch-date" value="${esc(state.chDate || '')}"></label>
          <div class="chips" id="ch-cat">
            ${[['', '全部类别'], ['REGISTRATION', '挂号费'], ['DRUG', '药品费'], ['LAB', '检查费']]
              .map(([v, label]) => `<button type="button" class="${state.chCat === v ? 'active' : ''}" data-cat="${v}">${label}</button>`).join('')}
          </div>
          <button class="btn" id="ch-refresh">刷新</button>
        </div>
        <div class="stat-line" id="ch-sum"></div>
        <div class="task-list" id="ch-list"></div>
      </div>
    </div>`;

  const load = async () => {
    state.selectedCharges.clear();
    state.chLimit = 20;
    let path = '/api/v1/charges?';
    if (state.chStatus) path += `status=${state.chStatus}&`;
    if (state.chDate) path += `date=${state.chDate}&`;
    if (state.chCat) path += `category=${state.chCat}&`;
    const rows = await api('GET', path);
    state.chRows = rows;
    paintCharges();
  };

  const paintCharges = () => {
    const rows = state.chRows || [];
    const limit = state.chLimit || 20;
    const shown = rows.slice(0, limit);
    $('#ch-list').innerHTML = (shown.length
      ? shown.map(chargeRowHtml).join('')
      : '<p class="empty">暂无账单</p>')
      + (rows.length > limit
        ? `<button type="button" class="btn block" id="ch-more">显示更多（剩 ${rows.length - limit} 笔）</button>`
        : '');
    paintChargeSum();
  };

  const paintChargeSum = () => {
    const rows = state.chRows || [];
    const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
    const selected = Array.from(state.selectedCharges);
    const selAmount = rows.filter(r => selected.includes(r.id)).reduce((s, r) => s + Number(r.amount || 0), 0);
    $('#ch-sum').innerHTML = `<span>本页 <strong>${rows.length}</strong> 笔 · 合计 <strong>${money(total)}</strong></span>`
      + (selected.length ? `<span>已选 <strong>${selected.length}</strong> 笔 · ${money(selAmount)}</span>` : '');
  };

  $('#ch-status').onclick = e => {
    const b = e.target.closest('[data-status]');
    if (!b) return;
    state.chStatus = b.dataset.status;
    $('#ch-status').querySelectorAll('.seg-btn').forEach(x => x.classList.toggle('active', x === b));
    load().catch(err => toast(err.message, 'error'));
  };
  $('#ch-cat').onclick = e => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    state.chCat = b.dataset.cat;
    $('#ch-cat').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    load().catch(err => toast(err.message, 'error'));
  };
  $('#ch-date').onchange = e => {
    state.chDate = e.target.value;
    load().catch(err => toast(err.message, 'error'));
  };
  $('#ch-refresh').onclick = () => load().catch(err => toast(err.message, 'error'));

  $('#ch-pay').onclick = async () => {
    const ids = Array.from(state.selectedCharges);
    if (!ids.length) { toast('请先勾选待收费账单', 'error'); return; }
    try {
      const data = await api('POST', '/api/v1/charges/pay', { ids });
      toast(`收费成功：${data.paidCount} 笔，合计 ${money(data.totalAmount)}`);
      await load();
    } catch (err) { toast(err.message, 'error'); }
  };

  $('#ch-list').onchange = e => {
    const chk = e.target.closest('input.chk');
    if (!chk) return;
    if (chk.checked) state.selectedCharges.add(Number(chk.value));
    else state.selectedCharges.delete(Number(chk.value));
    paintChargeSum();
  };
  $('#ch-list').onclick = e => {
    if (e.target.closest('input.chk')) return;
    if (e.target.closest('#ch-more')) {
      state.chLimit = (state.chLimit || 20) + 20;
      paintCharges();
      return;
    }
    const payBtn = e.target.closest('[data-ch-pay]');
    if (payBtn) {
      e.stopPropagation();
      payCharge(Number(payBtn.dataset.chPay), load);
      return;
    }
    const row = e.target.closest('[data-charge]');
    if (row) openChargeDrawer(Number(row.dataset.charge), load);
  };

  await load();
}

/* ---------------------------------------------------------------- 账单详情抽屉 */

function voidCharge(id, after) {
  openModal({
    title: '作废账单',
    okText: '作废',
    body: `<label>作废原因（≥2 字）<input id="vc-reason" maxlength="100"></label>`,
    onOk: async () => {
      const reason = formVal('vc-reason');
      if (reason.length < 2) throw new Error('作废原因不得少于 2 个字');
      await api('POST', `/api/v1/charges/${id}/void`, { reason });
      toast('账单已作废');
      after && await after();
    },
  });
}

function refundCharge(id, after) {
  openModal({
    title: '账单退费',
    okText: '确认退费',
    body: `<label>退费原因（≥4 字）<input id="rf-reason" maxlength="100"></label>
      <p class="hint">退费后将联动取消挂号/回库药品/退检查单，且不可撤销。</p>`,
    onOk: async () => {
      const reason = formVal('rf-reason');
      if (reason.length < 4) throw new Error('退费原因不得少于 4 个字');
      await api('POST', `/api/v1/charges/${id}/refund`, { reason });
      toast('退费成功');
      after && await after();
    },
  });
}

async function payCharge(id, after) {
  try {
    const data = await api('POST', '/api/v1/charges/pay', { ids: [id] });
    toast(`收费成功：${data.paidCount} 笔，合计 ${money(data.totalAmount)}`);
    if (after) await after();
  } catch (err) { toast(err.message, 'error'); }
}

async function openChargeDrawer(id, reload) {
  const r = (state.chRows || []).find(x => x.id === id);
  if (!r) return;
  const root = $('#drawer-root');
  const cat = chargeCat(r.category);
  const payable = r.status === 'UNPAID' && can('charge.pay');
  const actions = [];
  if (payable) actions.push(`<button type="button" class="btn primary" id="chd-pay">收费 ${money(r.amount)}</button>`);
  if (r.status === 'UNPAID' && can('charge.void')) actions.push('<button type="button" class="btn danger" id="chd-void">作废</button>');
  if (r.status === 'PAID' && can('charge.refund')) actions.push('<button type="button" class="btn danger" id="chd-refund">退费</button>');
  actions.push(`<button type="button" class="btn small" data-doc="charge" data-id="${r.id}">打印账单</button>`);
  actions.push('<button type="button" class="btn ghost" data-drawer-close>关闭</button>');

  root.innerHTML = `<div class="drawer-mask">
    <aside class="drawer" role="dialog" aria-label="账单详情">
      <div class="drawer-head">
        <h3>${esc(r.chargeNo)} ${badge(r.status)}</h3>
        <button type="button" class="btn ghost" data-drawer-close>关闭</button>
      </div>
      <div class="kv drawer-kv">
        <div><span>患者</span><span class="link-patient" data-patient="${r.patientId}">${esc(r.patientName)}</span></div>
        <div><span>病历号</span>${esc(r.patientMrn || '—')}</div>
        <div><span>类别</span>${esc(cat.name)}</div>
        <div><span>金额</span><strong>${money(r.amount)}</strong></div>
        <div><span>收费员</span>${esc(r.cashierName || '—')}</div>
        <div><span>收费时间</span>${esc(r.paidAt || '—')}</div>
      </div>
      <div class="section-title">费用项目</div>
      <p class="drawer-note">${esc(r.description || '—')}</p>
      <div class="drawer-foot">${actions.join('')}</div>
    </aside>
  </div>`;

  root.querySelectorAll('[data-drawer-close]').forEach(b => { b.onclick = closeDrawer; });
  root.querySelector('.drawer-mask').addEventListener('click', e => {
    if (e.target.classList.contains('drawer-mask')) closeDrawer();
  });
  const after = async () => { closeDrawer(); if (reload) await reload(); };
  const payBtn = root.querySelector('#chd-pay');
  if (payBtn) payBtn.onclick = () => payCharge(r.id, after);
  const voidBtn = root.querySelector('#chd-void');
  if (voidBtn) voidBtn.onclick = () => voidCharge(r.id, after);
  const refundBtn = root.querySelector('#chd-refund');
  if (refundBtn) refundBtn.onclick = () => refundCharge(r.id, after);
}

/* ---------------------------------------------------------------- 患者档案 */

async function viewPatients() {
  content.innerHTML = `
    <div class="panel">
      <div class="panel-head"><h3>患者主索引</h3>
        <div style="display:flex;gap:8px">
          <button class="btn small primary" id="pt-new" ${can('patient.write') ? '' : 'disabled'}>新建患者</button>
          <button class="btn small" id="pt-refresh">刷新</button>
        </div>
      </div>
      <div class="panel-body">
        <div class="filter-bar">
          <label>关键字<input id="pt-q" placeholder="姓名 / 病历号 / 手机尾号" style="min-width:220px"></label>
          <button class="btn" id="pt-search">搜索</button>
        </div>
        <div id="pt-table"></div>
      </div>
    </div>
    <div class="panel hidden" id="pt-detail-panel">
      <div class="panel-head"><h3>患者详情</h3></div>
      <div class="panel-body" id="pt-detail"></div>
    </div>`;

  const load = async () => {
    const q = formVal('pt-q');
    const rows = await api('GET', '/api/v1/patients' + (q ? `?q=${encodeURIComponent(q)}` : ''));
    $('#pt-table').innerHTML = table(
      ['病历号', '姓名 / 性别·年龄', '联系电话', '慢病标签', '操作'],
      rows.map(p => `<tr>
        <td>${esc(p.mrn)}</td>
        <td><span class="link-patient" data-patient="${p.id}">${esc(p.name)}</span>
          <br><span class="hint">${esc(p.gender)}${p.birthDate ? ' · ' + esc(ageFromBirth(p.birthDate)) : ''}</span></td>
        <td>${esc(p.phoneMask || '—')}</td>
        <td>${esc((p.chronicTags || []).join('、') || '—')}</td>
        <td><button class="btn small" data-pt="${p.id}">查看</button></td>
      </tr>`),
      '未找到患者'
    );
  };

  const openDetail = async (patientId) => {
    const [p, visits, reports] = await Promise.all([
      api('GET', `/api/v1/patients/${patientId}`),
      api('GET', `/api/v1/patients/${patientId}/visits`),
      api('GET', `/api/v1/patients/${patientId}/reports`),
    ]);
    $('#pt-detail-panel').classList.remove('hidden');
    $('#pt-detail').innerHTML = `
      <div class="kv">
        <div><span>姓名</span>${esc(p.name)}（${esc(p.gender)}）</div>
        <div><span>病历号</span>${esc(p.mrn)}</div>
        <div><span>出生日期</span>${esc(p.birthDate || '—')}</div>
        <div><span>证件后四位</span>${esc(p.idLast4 || '—')}</div>
        <div><span>联系电话</span>${esc(p.phoneMask || '—')}</div>
        <div><span>住址</span>${esc(p.address || '—')}</div>
        <div><span>过敏史</span>${esc(p.allergy || '—')}</div>
        <div><span>慢病标签</span>${esc((p.chronicTags || []).join('、') || '—')}</div>
      </div>
      <div class="section-title">就诊记录</div>
      ${table(['病历号', '日期', '科室', '医生', '诊断', '状态'], visits.map(v => `<tr>
        <td>${esc(v.visitNo)}</td><td>${esc(v.visitDate)}</td><td>${esc(v.deptName)}</td>
        <td>${esc(v.doctorName)}</td><td>${esc(v.diagnosisName || '—')}</td><td>${badge(v.status)}</td>
      </tr>`), '暂无就诊记录')}
      <div class="section-title">检查报告</div>
      ${table(['报告号', '项目', '结论', '异常', '报告时间'], reports.map(r => `<tr>
        <td>${esc(r.orderNo)}</td><td>${esc(r.itemName)}</td>
        <td style="max-width:320px;white-space:normal">${esc(r.conclusion)}</td>
        <td>${r.abnormal ? '<span class="badge danger">异常</span>' : '<span class="badge ok">正常</span>'}</td>
        <td>${esc(r.reportedAt || '—')}</td>
      </tr>`), '暂无报告')}`;
  };

  $('#pt-refresh').onclick = () => load().catch(err => toast(err.message, 'error'));
  $('#pt-search').onclick = () => load().catch(err => toast(err.message, 'error'));
  $('#pt-q').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); load().catch(err => toast(err.message, 'error')); } };
  $('#pt-table').onclick = e => {
    const btn = e.target.closest('button');
    if (btn && btn.dataset.pt) openDetail(Number(btn.dataset.pt)).catch(err => toast(err.message, 'error'));
  };
  $('#pt-new').onclick = () => {
    openModal({
      title: '新建患者',
      okText: '保存',
      body: `
        <label>姓名<input id="np-name" maxlength="30"></label>
        <label>性别<select id="np-gender"><option value="男">男</option><option value="女">女</option></select></label>
        <label>出生日期<input id="np-birth" type="date"></label>
        <label>身份证号（仅存后 4 位与哈希）<input id="np-id" maxlength="18"></label>
        <label>手机号（仅存掩码与哈希）<input id="np-phone" maxlength="11"></label>
        <label>住址<input id="np-address" maxlength="100"></label>
        <label>过敏史<input id="np-allergy" maxlength="100" placeholder="无 / 青霉素过敏"></label>
        <label>慢病标签（逗号分隔）<input id="np-tags" maxlength="100" placeholder="高血压,糖尿病"></label>`,
      onOk: async () => {
        const name = formVal('np-name');
        if (!name) throw new Error('请填写姓名');
        const tags = formVal('np-tags').split(/[,，]/).map(s => s.trim()).filter(Boolean);
        await api('POST', '/api/v1/patients', {
          name, gender: formVal('np-gender'), birthDate: formVal('np-birth'),
          idCard: formVal('np-id'), phone: formVal('np-phone'),
          address: formVal('np-address'), allergy: formVal('np-allergy'), chronicTags: tags,
        });
        toast('患者已建档');
        await load();
      },
    });
  };

  await load();
}

/* ---------------------------------------------------------------- 医技 */

function labStageLabel(r) {
  if (r.status === 'APPLIED') return ['待采样', 'warn'];
  if (r.status === 'SAMPLED') return ['待报告', 'info'];
  if (r.status === 'REPORTED') return ['已出报告', 'ok'];
  return [r.status || '—', ''];
}

function labRowHtml(r) {
  const [stageLabel, stageCls] = labStageLabel(r);
  const quick = [];
  if (can('lab.report') && r.status === 'APPLIED') quick.push(`<button type="button" class="btn small" data-lab-sample="${r.id}">采样</button>`);
  if (can('lab.report') && ['APPLIED', 'SAMPLED'].includes(r.status)) quick.push(`<button type="button" class="btn small primary" data-lab-report="${r.id}">录入报告</button>`);
  const flags = `${r.critical ? '<span class="badge danger">危急值</span>' : ''}${r.abnormal ? '<span class="badge danger">异常</span>' : ''}`;
  return `<div class="ch-row" data-lab="${r.id}">
    <div class="ch-main">
      <div class="ch-line1">
        <span class="ch-title">${esc(r.itemName)} · ${esc(r.orderNo)}</span>
        ${flags}
      </div>
      <div class="ch-line2">
        <span class="task-type ${stageCls}">${esc(stageLabel)}</span>
        <span class="ch-sub">${esc(r.patientName || '')} · ${esc(r.patientMrn || '')} · 开单 ${esc(r.doctorName || '—')}</span>
        <span class="ch-actions">
          ${quick.join('')}
          <span class="task-go">详情 ›</span>
        </span>
      </div>
      ${r.conclusion ? `<div class="ch-note">结论：${esc(r.conclusion)}</div>` : ''}
    </div>
  </div>`;
}

function openLabReportModal(id, after) {
  openModal({
    title: '录入检查报告',
    okText: '提交报告',
    body: `
      <label>检查所见<textarea id="lr-findings" maxlength="2000"></textarea></label>
      <label>检查结论<textarea id="lr-conclusion" maxlength="500"></textarea></label>
      <label>检验数值（可选，有危急值阈值的项目填数值自动判定）<input id="lr-value" type="number" step="0.01"></label>
      <label style="display:flex;align-items:center;gap:8px">
        <input type="checkbox" id="lr-abnormal" style="width:auto;margin:0"> 标记为异常
      </label>`,
    onOk: async () => {
      const findings = formVal('lr-findings');
      const conclusion = formVal('lr-conclusion');
      if (!findings || !conclusion) throw new Error('检查所见与结论均必填');
      const payload = { findings, conclusion, abnormal: $('#lr-abnormal').checked };
      const value = formNum('lr-value');
      if (value !== undefined) payload.value = value;
      await api('POST', `/api/v1/lab-orders/${id}/report`, payload);
      toast('报告已提交');
      if (after) await after();
    },
  });
}

async function openLabDrawer(id, reload) {
  const r = (state.labRows || []).find(x => x.id === id);
  if (!r) return;
  const [stageLabel] = labStageLabel(r);
  const root = $('#drawer-root');
  const actions = [];
  if (can('lab.report') && r.status === 'APPLIED') actions.push('<button type="button" class="btn" id="labd-sample">标记采样</button>');
  if (can('lab.report') && ['APPLIED', 'SAMPLED'].includes(r.status)) actions.push('<button type="button" class="btn primary" id="labd-report">录入报告</button>');
  actions.push(`<button type="button" class="btn small" data-doc="lab" data-id="${r.id}">打印申请单</button>`);
  actions.push('<button type="button" class="btn ghost" data-drawer-close>关闭</button>');

  root.innerHTML = `<div class="drawer-mask">
    <aside class="drawer" role="dialog" aria-label="检查申请详情">
      <div class="drawer-head">
        <h3>${esc(r.itemName)} ${badge(r.status)}</h3>
        <button type="button" class="btn ghost" data-drawer-close>关闭</button>
      </div>
      <div class="kv drawer-kv">
        <div><span>申请号</span>${esc(r.orderNo)}</div>
        <div><span>患者</span><span class="link-patient" data-patient="${r.patientId}">${esc(r.patientName || '')}</span></div>
        <div><span>病历号</span>${esc(r.patientMrn || '—')}</div>
        <div><span>开单医生</span>${esc(r.doctorName || '—')}</div>
        <div><span>进度</span>${esc(stageLabel)}</div>
        <div><span>报告人</span>${esc(r.reporterName || '—')}</div>
      </div>
      ${r.critical || r.abnormal ? `<div class="alert-line">${r.critical ? '危急值' : ''}${r.critical && r.abnormal ? ' · ' : ''}${r.abnormal ? '结果异常' : ''}，请及时处理</div>` : ''}
      <div class="section-title">检查所见</div>
      <p class="drawer-note">${esc(r.findings || '—')}</p>
      <div class="section-title">检查结论</div>
      <p class="drawer-note">${esc(r.conclusion || '—')}</p>
      <div class="drawer-foot">${actions.join('')}</div>
    </aside>
  </div>`;

  root.querySelectorAll('[data-drawer-close]').forEach(b => { b.onclick = closeDrawer; });
  root.querySelector('.drawer-mask').addEventListener('click', e => {
    if (e.target.classList.contains('drawer-mask')) closeDrawer();
  });
  const after = async () => { closeDrawer(); if (reload) await reload(); };
  const sampleBtn = root.querySelector('#labd-sample');
  if (sampleBtn) sampleBtn.onclick = async () => {
    try {
      await api('POST', `/api/v1/lab-orders/${r.id}/sample`);
      toast('已标记采样');
      await after();
    } catch (err) { toast(err.message, 'error'); }
  };
  const reportBtn = root.querySelector('#labd-report');
  if (reportBtn) reportBtn.onclick = () => openLabReportModal(r.id, after);
}

async function viewLab() {
  if (!state.labStatus) state.labStatus = '';
  content.innerHTML = `
    <div class="panel">
      <div class="panel-head"><h3>检查申请与报告</h3><button class="btn small" id="lab-refresh">刷新</button></div>
      <div class="panel-body">
        <div class="seg" id="lab-status">
          ${[['', '全部'], ['APPLIED', '待采样'], ['SAMPLED', '待报告'], ['REPORTED', '已出报告']]
            .map(([v, label]) => `<button type="button" class="seg-btn${state.labStatus === v ? ' active' : ''}" data-labstat="${v}">${label}</button>`).join('')}
        </div>
        <div class="filter-bar">
          <label>日期<input type="date" id="lab-date" value="${esc(state.labDate || '')}"></label>
        </div>
        <div class="stat-line" id="lab-sum"></div>
        <div class="task-list" id="lab-table"></div>
      </div>
    </div>`;

  const load = async () => {
    state.labLimit = 20;
    let path = '/api/v1/lab-orders?';
    if (state.labStatus) path += `status=${state.labStatus}&`;
    if (state.labDate) path += `date=${state.labDate}&`;
    const rows = await api('GET', path);
    state.labRows = rows;
    paintLabs();
  };

  const paintLabs = () => {
    const rows = state.labRows || [];
    const limit = state.labLimit || 20;
    const shown = rows.slice(0, limit);
    const pending = rows.filter(r => r.status !== 'REPORTED').length;
    const critical = rows.filter(r => r.critical).length;
    $('#lab-sum').innerHTML = `<span>本页 <strong>${rows.length}</strong> 条 · 未出报告 <strong>${pending}</strong></span>`
      + (critical ? `<span>危急值 <strong>${critical}</strong> 条</span>` : '');
    $('#lab-table').innerHTML = (shown.length
      ? shown.map(labRowHtml).join('')
      : '<p class="empty">暂无检查申请</p>')
      + (rows.length > limit
        ? `<button type="button" class="btn block" id="lab-more">显示更多（剩 ${rows.length - limit} 条）</button>`
        : '');
  };

  $('#lab-status').onclick = e => {
    const b = e.target.closest('[data-labstat]');
    if (!b) return;
    state.labStatus = b.dataset.labstat;
    $('#lab-status').querySelectorAll('.seg-btn').forEach(x => x.classList.toggle('active', x === b));
    load().catch(err => toast(err.message, 'error'));
  };
  $('#lab-date').onchange = e => {
    state.labDate = e.target.value;
    load().catch(err => toast(err.message, 'error'));
  };
  $('#lab-refresh').onclick = () => load().catch(err => toast(err.message, 'error'));

  $('#lab-table').onclick = e => {
    if (e.target.closest('#lab-more')) {
      state.labLimit = (state.labLimit || 20) + 20;
      paintLabs();
      return;
    }
    const sampleBtn = e.target.closest('[data-lab-sample]');
    if (sampleBtn) {
      e.stopPropagation();
      confirmAction('确认采样完成？', async () => {
        try {
          await api('POST', `/api/v1/lab-orders/${sampleBtn.dataset.labSample}/sample`);
          toast('已标记采样');
          await load();
        } catch (err) { toast(err.message, 'error'); }
      });
      return;
    }
    const reportBtn = e.target.closest('[data-lab-report]');
    if (reportBtn) {
      e.stopPropagation();
      openLabReportModal(Number(reportBtn.dataset.labReport), load);
      return;
    }
    const row = e.target.closest('[data-lab]');
    if (row) openLabDrawer(Number(row.dataset.lab), load);
  };

  await load();
}

/* ---------------------------------------------------------------- 公共卫生 */

async function viewPh() {
  content.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h3>公卫任务</h3>
        <div class="seg" id="ph-status-seg">
          <button type="button" class="seg-btn" data-phstat="OPEN">待处理</button>
          <button type="button" class="seg-btn" data-phstat="DONE">已完成</button>
        </div>
      </div>
      <div class="panel-body">
        <div class="filter-bar">
          <div class="chips" id="ph-type-chips">
            <button type="button" data-phtype="">全部</button>
            <button type="button" data-phtype="INFECTION">传染病上报</button>
            <button type="button" data-phtype="CHRONIC_FOLLOWUP">慢病随访</button>
          </div>
          <label class="grow">查找<input id="ph-q" placeholder="患者姓名 / 病历号 / 任务号"></label>
          <button type="button" class="btn small" id="ph-refresh">刷新</button>
        </div>
        <div id="ph-summary" class="stat-line"></div>
        <div id="ph-list"></div>
        <div id="ph-more"></div>
      </div>
    </div>`;

  state.phStatus = state.phStatus || 'OPEN';
  state.phType = state.phType || '';
  state.phQuery = '';
  state.phLimit = 20;

  const load = async () => {
    state.phRows = await api('GET', '/api/v1/ph-tasks');
    paintPh();
  };

  $$('#ph-status-seg [data-phstat]').forEach(b => {
    b.onclick = () => { state.phStatus = b.dataset.phstat; state.phLimit = 20; paintPh(); };
  });
  $('#ph-type-chips').onclick = e => {
    const b = e.target.closest('[data-phtype]');
    if (!b) return;
    state.phType = b.dataset.phtype;
    state.phLimit = 20;
    paintPh();
  };
  $('#ph-q').oninput = e => { state.phQuery = e.target.value; paintPh(); };
  $('#ph-refresh').onclick = () => load().catch(err => toast(err.message, 'error'));
  $('#ph-list').onclick = e => {
    const row = e.target.closest('[data-task]');
    if (row) openPhTask(Number(row.dataset.task));
  };
  $('#ph-more').onclick = e => {
    if (e.target.closest('#ph-more-btn')) {
      state.phLimit = (state.phLimit || 20) + 20;
      paintPh();
    }
  };

  await load();
}

function paintPh() {
  const rows = state.phRows || [];
  const open = rows.filter(r => r.status === 'OPEN');
  const done = rows.filter(r => r.status === 'DONE');
  const status = state.phStatus || 'OPEN';
  const type = state.phType || '';
  const q = (state.phQuery || '').trim().toLowerCase();

  $$('#ph-status-seg [data-phstat]').forEach(b => {
    const key = b.dataset.phstat;
    const n = key === 'OPEN' ? open.length : done.length;
    b.classList.toggle('active', key === status);
    b.innerHTML = `${key === 'OPEN' ? '待处理' : '已完成'} <span class="seg-count">${n}</span>`;
  });
  $$('#ph-type-chips [data-phtype]').forEach(b => {
    b.classList.toggle('active', (b.dataset.phtype || '') === type);
  });

  const overdue = open.filter(r => r.overdue).length;
  $('#ph-summary').innerHTML = `<span>待处理 <strong>${open.length}</strong></span>`
    + `<span>逾期 <strong style="${overdue ? 'color:var(--danger)' : ''}">${overdue}</strong></span>`
    + `<span>已完成 <strong>${done.length}</strong></span>`
    + '<span>按截止时间排序，逾期置顶</span>';

  let list = (status === 'OPEN' ? open : done).filter(r => !type || r.type === type);
  if (q) {
    list = list.filter(r => `${r.taskNo} ${r.patientName} ${r.patientMrn} ${r.title}`
      .toLowerCase().includes(q));
  }
  list.sort((a, b) => (status === 'OPEN'
    ? String(a.dueAt || '').localeCompare(String(b.dueAt || ''))
    : String(b.doneAt || '').localeCompare(String(a.doneAt || ''))));

  const limit = state.phLimit || 20;
  const shown = list.slice(0, limit);
  $('#ph-list').innerHTML = shown.length
    ? `<div class="task-list">${shown.map(phRowHtml).join('')}</div>`
    : '<p class="empty">没有符合条件的任务</p>';
  $('#ph-more').innerHTML = list.length > shown.length
    ? `<button type="button" class="btn small" id="ph-more-btn" style="margin-top:10px">显示更多（剩余 ${list.length - shown.length} 条）</button>`
    : '';
}

function phRowHtml(t) {
  const { disease, code } = phParts(t);
  const infect = t.type === 'INFECTION';
  const due = t.status === 'OPEN'
    ? dueText(t.dueAt)
    : (t.doneAt ? `完成 ${String(t.doneAt).slice(5, 16)}` : '已完成');
  return `<button type="button" class="task-row" data-task="${t.id}">
      <span class="task-type ${infect ? 'danger' : 'info'}">${infect ? '传染病' : '慢病随访'}</span>
      <span class="task-main">
        <span class="task-title">${esc(disease)}${code ? ` <span class="hint">${esc(code)}</span>` : ''}</span>
        <span class="task-sub">${esc(t.patientName)} · ${esc(t.patientMrn)}${t.doneBy ? ` · ${esc(t.doneBy)}` : ''}</span>
      </span>
      <span class="task-due ${t.overdue ? 'overdue' : ''}">${esc(due)}</span>
      <span class="task-go">${t.status === 'OPEN' && can('ph.complete') ? '处理' : '查看'}</span>
    </button>`;
}

function phParts(t) {
  const title = t.title || '';
  const idx = title.indexOf('：');
  const disease = idx >= 0 ? title.slice(idx + 1) : title;
  const codeM = /诊断编码\s*([A-Z]\d{2}(?:\.\d+)?)/.exec(t.detail || '');
  return { disease: disease || '公卫任务', code: codeM ? codeM[1] : '' };
}

function dueText(dueAt) {
  if (!dueAt) return '无期限';
  const d = new Date(String(dueAt).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return String(dueAt);
  const diffMs = d.getTime() - Date.now();
  const hours = Math.abs(diffMs) / 36e5;
  if (diffMs < 0) {
    return hours < 24
      ? `逾期 ${Math.max(1, Math.round(hours))} 小时`
      : `逾期 ${Math.round(hours / 24)} 天`;
  }
  return hours < 24 ? `剩 ${Math.max(1, Math.round(hours))} 小时` : `剩 ${Math.round(hours / 24)} 天`;
}

function shiftDate(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function phFormHtml(infect) {
  const today = todayStr();
  if (infect) {
    const symptoms = ['发热', '咳嗽', '咽痛', '头痛', '腹泻', '皮疹'];
    return `<div class="drawer-form">
      <div class="section-title">上报信息</div>
      <div class="form-row">
        <label>报卡类别<select id="pf-class">
          <option>甲类</option><option selected>乙类</option><option>丙类</option>
        </select></label>
        <label>发病日期<input type="date" id="pf-onset" value="${today}"></label>
      </div>
      <div class="field">
        <span class="field-label">主要症状（可多选）</span>
        <div class="chips" id="pf-sym">${symptoms.map(s => `<button type="button" data-sym="${s}">${s}</button>`).join('')}</div>
      </div>
      <div class="form-row">
        <label>网络直报<select id="pf-report"><option>已直报</option><option>待直报</option></select></label>
        <label>核实方式<select id="pf-way"><option>电话核实</option><option>门诊核实</option><option>家访核实</option></select></label>
      </div>
      <label>处置备注<textarea id="pf-note" maxlength="200" placeholder="如 已电话核实患者居家隔离，样本已送检"></textarea></label>
    </div>`;
  }
  return `<div class="drawer-form">
    <div class="section-title">随访记录</div>
    <div class="form-row">
      <label>随访方式<select id="pf-way"><option>门诊随访</option><option>电话随访</option><option>家庭随访</option></select></label>
      <label>用药依从性<select id="pf-adh"><option>规律服药</option><option>间断服药</option><option>未服药</option></select></label>
    </div>
    <div class="form-row">
      <label>血压（mmHg）
        <div class="inline-two">
          <input id="pf-sbp" type="number" inputmode="numeric" min="40" max="300" placeholder="收缩压">
          <input id="pf-dbp" type="number" inputmode="numeric" min="20" max="200" placeholder="舒张压">
        </div>
      </label>
      <label>空腹血糖（mmol/L）<input id="pf-glu" type="number" inputmode="decimal" step="0.1" min="1" max="40" placeholder="如 6.5"></label>
    </div>
    <label>下次随访日期<input type="date" id="pf-next" value="${shiftDate(7)}"></label>
    <label>随访备注<textarea id="pf-note" maxlength="200" placeholder="如 血压控制良好，继续原方案"></textarea></label>
  </div>`;
}

async function openPhTask(taskId) {
  const t = (state.phRows || []).find(r => r.id === taskId);
  if (!t) return;
  const { disease } = phParts(t);
  const infect = t.type === 'INFECTION';
  const editable = t.status === 'OPEN' && can('ph.complete');
  const root = $('#drawer-root');
  const due = t.dueAt ? `${t.dueAt}（${dueText(t.dueAt)}）` : '—';

  root.innerHTML = `<div class="drawer-mask">
    <aside class="drawer" role="dialog" aria-label="公卫任务处理">
      <div class="drawer-head">
        <h3>${infect ? '传染病上报' : '慢病随访'}：${esc(disease)}</h3>
        <button type="button" class="btn ghost" data-drawer-close>关闭</button>
      </div>
      <div class="kv drawer-kv">
        <div><span>患者</span><span class="link-patient" data-patient="${t.patientId}">${esc(t.patientName)}</span></div>
        <div><span>病历号</span>${esc(t.patientMrn)}</div>
        <div><span>任务号</span>${esc(t.taskNo)}</div>
        <div><span>截止</span>${esc(due)}</div>
        <div><span>状态</span>${badge(t.status)}</div>
        <div><span>完成人</span>${esc(t.doneBy || '—')}</div>
      </div>
      <p class="hint">${esc(t.detail || '')}</p>
      ${editable
        ? phFormHtml(infect)
        : `<div class="section-title">处理结果</div><p class="hint">完成时间：${esc(t.doneAt || '—')}</p>`}
      <div class="drawer-foot">
        ${editable ? '<button type="button" class="btn primary" id="pf-save">完成并归档</button>' : ''}
        <button type="button" class="btn ghost" data-drawer-close>关闭</button>
      </div>
    </aside>
  </div>`;

  root.querySelectorAll('[data-drawer-close]').forEach(b => { b.onclick = closeDrawer; });
  root.querySelector('.drawer-mask').addEventListener('click', e => {
    if (e.target.classList.contains('drawer-mask')) closeDrawer();
  });
  root.querySelectorAll('#pf-sym [data-sym]').forEach(b => {
    b.onclick = () => b.classList.toggle('active');
  });

  const save = root.querySelector('#pf-save');
  if (save) {
    save.onclick = async () => {
      if (infect) {
        const onset = readVal(root, '#pf-onset');
        if (!onset) { toast('请填写发病日期', 'error'); return; }
        if (onset > todayStr()) { toast('发病日期不能晚于今天', 'error'); return; }
      }
      save.disabled = true;
      try {
        await api('POST', `/api/v1/ph-tasks/${t.id}/complete`, { note: composePhNote(t, root) });
        toast('任务已完成');
        closeDrawer();
        await viewPh();
      } catch (err) {
        toast(err.message, 'error');
        save.disabled = false;
      }
    };
  }
}

function readVal(root, sel) {
  const el = root.querySelector(sel);
  return el ? String(el.value || '').trim() : '';
}

function composePhNote(t, root) {
  const parts = [];
  if (t.type === 'INFECTION') {
    parts.push(`报卡类别=${readVal(root, '#pf-class')}`);
    parts.push(`发病日期=${readVal(root, '#pf-onset')}`);
    const syms = Array.from(root.querySelectorAll('#pf-sym [data-sym].active'))
      .map(b => b.dataset.sym);
    if (syms.length) parts.push(`症状=${syms.join('、')}`);
    parts.push(`网络直报=${readVal(root, '#pf-report')}`);
    parts.push(`核实方式=${readVal(root, '#pf-way')}`);
  } else {
    parts.push(`随访方式=${readVal(root, '#pf-way')}`);
    const sbp = readVal(root, '#pf-sbp');
    const dbp = readVal(root, '#pf-dbp');
    if (sbp || dbp) parts.push(`血压=${sbp || '?'}/${dbp || '?'}`);
    const glu = readVal(root, '#pf-glu');
    if (glu) parts.push(`空腹血糖=${glu}mmol/L`);
    parts.push(`用药依从性=${readVal(root, '#pf-adh')}`);
    const next = readVal(root, '#pf-next');
    if (next) parts.push(`下次随访=${next}`);
  }
  const note = readVal(root, '#pf-note');
  if (note) parts.push(`备注=${note}`);
  return parts.join('；').slice(0, 500);
}

/* ---------------------------------------------------------------- 统计报表 */

async function viewReports() {
  content.innerHTML = `
    <div class="panel">
      <div class="panel-head"><h3>日报</h3>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="date" id="rp-date" value="${todayStr()}" style="padding:6px 9px;border:1px solid var(--line);border-radius:8px">
          <button class="btn small" id="rp-refresh">查询</button>
          <button class="btn small" id="rp-print">打印</button>
        </div>
      </div>
      <div class="panel-body" id="rp-body"></div>
    </div>`;

  const load = async () => {
    const date = formVal('rp-date') || todayStr();
    const d = await api('GET', `/api/v1/reports/daily?date=${date}`);
    $('#rp-body').innerHTML = `
      <div class="cards" style="margin-bottom:16px">
        ${card('挂号', d.totals.registrations, date)}
        ${card('就诊', d.totals.visited, `完成 ${d.totals.finished}`)}
        ${card('处方', d.totals.prescriptions, '当日开具')}
        ${card('新建档', d.totals.newPatients, '患者')}
        ${card('收费合计', money(d.totals.revenue), '已收费')}
      </div>
      <div class="section-title">科室工作量</div>
      ${table(['科室', '挂号', '完成就诊', '处方'], d.byDept.map(r => `<tr>
        <td>${esc(r.name)}</td><td>${r.registrations}</td><td>${r.finished}</td><td>${r.prescriptions}</td>
      </tr>`), '暂无数据')}
      <div class="section-title">医师工作量</div>
      ${table(['医师', '职称', '科室', '完成就诊', '处方'], d.byDoctor.map(r => `<tr>
        <td>${esc(r.name)}</td><td>${esc(r.title)}</td><td>${esc(r.dept_name)}</td>
        <td>${r.finished}</td><td>${r.prescriptions}</td>
      </tr>`), '暂无数据')}
      <div class="section-title">收入构成</div>
      ${table(['类别', '笔数', '金额'], d.revenueByCategory.map(r => `<tr>
        <td>${r.category === 'REGISTRATION' ? '挂号费' : r.category === 'DRUG' ? '药品费' : r.category === 'LAB' ? '检查费' : esc(r.category)}</td>
        <td>${r.count}</td><td>${money(r.amount)}</td>
      </tr>`), '当日暂无收费')}`;
  };

  $('#rp-refresh').onclick = () => load().catch(err => toast(err.message, 'error'));
  $('#rp-date').onchange = () => load().catch(err => toast(err.message, 'error'));
  $('#rp-print').onclick = () => window.print();

  await load();
}

/* ---------------------------------------------------------------- 人员与排班 */

async function viewStaff() {
  content.innerHTML = `
    <div class="panel">
      <div class="panel-head"><h3>在册人员</h3>
        <div style="display:flex;gap:8px">
          <button class="btn small primary" id="st-new" ${can('system.admin') ? '' : 'disabled'}>新增人员</button>
          <button class="btn small" id="st-refresh">刷新</button>
        </div>
      </div>
      <div class="panel-body">
        <div class="filter-bar">
          <label>角色
            <select id="st-role">
              <option value="">全部</option>
              <option value="DOCTOR">医师</option>
              <option value="NURSE">护士</option>
              <option value="PUBLIC_HEALTH">公共卫生</option>
              <option value="PHARMACIST">药师</option>
              <option value="CASHIER">收费员</option>
              <option value="TECHNICIAN">医技</option>
              <option value="DIRECTOR">院长</option>
              <option value="MEDICAL_AFFAIRS">医务科</option>
              <option value="ADMIN">系统管理员</option>
            </select>
          </label>
          <label>状态
            <select id="st-status">
              <option value="">全部</option>
              <option value="ACTIVE">在岗</option>
              <option value="DISABLED">停用</option>
            </select>
          </label>
        </div>
        <div id="st-table"></div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>排班号源生成</h3></div>
      <div class="panel-body">
        <div class="filter-bar">
          <label>起始日期<input type="date" id="sc-start" value="${todayStr()}"></label>
          <label>天数<input type="number" id="sc-days" min="1" max="30" value="7" style="min-width:80px"></label>
          <button class="btn primary" id="sc-generate" ${can('schedule.write') ? '' : 'disabled'}>生成（上午 20 / 下午 15）</button>
        </div>
        <p class="hint">同一医生同一时段不会重复生成；停诊请通过号源管理单独处理。</p>
      </div>
    </div>`;

  const load = async () => {
    const role = formVal('st-role');
    const status = formVal('st-status');
    let path = '/api/v1/staff?';
    if (role) path += `role=${role}&`;
    if (status) path += `status=${status}&`;
    const rows = await api('GET', path);
    $('#st-table').innerHTML = table(
      ['工号', '姓名', '角色', '职称', '科室', '执业证号', '账号', '状态', '操作'],
      rows.map(s => `<tr>
        <td>${esc(s.staffNo)}</td>
        <td>${esc(s.name)}</td>
        <td>${esc(s.roleName)}</td>
        <td>${esc(s.title || '—')}</td>
        <td>${esc(s.deptName)}</td>
        <td>${esc(s.licenseNo || '—')}</td>
        <td>${esc(s.username || '—')}</td>
        <td>${s.status === 'ACTIVE' ? '<span class="badge ok">在岗</span>' : '<span class="badge danger">停用</span>'}</td>
        <td>${can('system.admin') ? `<button class="btn small" data-toggle="${s.id}" data-status="${s.status}">${s.status === 'ACTIVE' ? '停用' : '启用'}</button>` : '—'}</td>
      </tr>`),
      '暂无人员'
    );
  };

  $('#st-refresh').onclick = () => load().catch(err => toast(err.message, 'error'));
  ['st-role', 'st-status'].forEach(id => {
    document.getElementById(id).onchange = () => load().catch(err => toast(err.message, 'error'));
  });
  $('#st-table').onclick = e => {
    const btn = e.target.closest('button');
    if (!btn || !btn.dataset.toggle) return;
    const next = btn.dataset.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    confirmAction(next === 'DISABLED' ? '确认停用该人员？将同时停用其账号并吊销会话。' : '确认启用该人员？', async () => {
      await api('PATCH', `/api/v1/staff/${btn.dataset.toggle}`, { status: next });
      toast('状态已更新');
      await load();
    });
  };
  $('#sc-generate').onclick = async () => {
    try {
      const days = formNum('sc-days') || 7;
      const data = await api('POST', '/api/v1/schedules/generate', {
        startDate: formVal('sc-start') || todayStr(), days,
      });
      toast(`已生成 ${data.created} 个号源`);
    } catch (err) { toast(err.message, 'error'); }
  };
  $('#st-new').onclick = () => {
    const opts = state.depts.map(d => `<option value="${esc(d.code)}">${esc(d.name)}</option>`).join('');
    openModal({
      title: '新增人员',
      okText: '保存',
      body: `
        <label>姓名<input id="ns-name" maxlength="30"></label>
        <label>性别<select id="ns-gender"><option value="女">女</option><option value="男">男</option></select></label>
        <label>角色<select id="ns-role">
          <option value="DOCTOR">医师</option><option value="NURSE">护士</option>
          <option value="PUBLIC_HEALTH">公共卫生</option><option value="PHARMACIST">药师</option>
          <option value="CASHIER">收费员</option><option value="TECHNICIAN">医技</option>
        </select></label>
        <label>职称<input id="ns-title" maxlength="30" placeholder="如 主治医师"></label>
        <label>科室<select id="ns-dept">${opts}</select></label>
        <label>执业证号<input id="ns-license" maxlength="40"></label>
        <label>专长<input id="ns-specialty" maxlength="80"></label>
        <label>登录账号<input id="ns-username" maxlength="40"></label>
        <label>初始口令<input id="ns-password" type="password" maxlength="64" placeholder="≥10 位，含大小写/数字/符号"></label>`,
      onOk: async () => {
        if (!formVal('ns-name') || !formVal('ns-username') || !formVal('ns-password')) {
          throw new Error('姓名、账号与初始口令均必填');
        }
        await api('POST', '/api/v1/staff', {
          name: formVal('ns-name'), gender: formVal('ns-gender'), role: formVal('ns-role'),
          title: formVal('ns-title'), deptCode: formVal('ns-dept'), licenseNo: formVal('ns-license'),
          specialty: formVal('ns-specialty'), username: formVal('ns-username'),
          password: formVal('ns-password'),
        });
        toast('人员已创建');
        await load();
      },
    });
  };

  await ensureDepts();
  await load();
}

/* ---------------------------------------------------------------- 系统管理 */

async function viewSystem() {
  content.innerHTML = `
    <div class="panel">
      <div class="panel-head"><h3>审计日志</h3>
        <div style="display:flex;gap:8px">
          <button class="btn small primary" id="au-verify">校验哈希链</button>
          <button class="btn small" id="au-refresh">刷新</button>
        </div>
      </div>
      <div class="panel-body">
        <div class="filter-bar">
          <label>日期<input type="date" id="au-date"></label>
          <label>动作<input id="au-action" placeholder="如 AUTH / RX_" style="min-width:140px"></label>
          <label>结果
            <select id="au-result"><option value="">全部</option><option value="OK">成功</option><option value="FAIL">失败</option></select>
          </label>
        </div>
        <div id="au-verify-result"></div>
        <div id="au-table"></div>
      </div>
    </div>
    <div class="panel" id="cp-panel" ${can('system.admin') ? '' : 'hidden'}>
      <div class="panel-head"><h3>合规自检</h3><button class="btn small" id="cp-run">重新检查</button></div>
      <div class="panel-body" id="cp-body"><p class="empty">点击「重新检查」</p></div>
    </div>
    <div class="panel" id="key-panel" ${can('system.admin') ? '' : 'hidden'}>
      <div class="panel-head"><h3>HIS 对接密钥</h3></div>
      <div class="panel-body" id="key-body"></div>
    </div>`;

  const loadAudit = async () => {
    const date = formVal('au-date');
    const action = formVal('au-action');
    const result = formVal('au-result');
    let path = '/api/v1/audit-logs?limit=100&';
    if (date) path += `date=${date}&`;
    if (action) path += `action=${encodeURIComponent(action)}&`;
    if (result) path += `result=${result}&`;
    const d = await api('GET', path);
    $('#au-table').innerHTML = table(
      ['时间', '操作人', '角色', '动作', '对象', 'IP', '结果', '详情'],
      d.items.map(r => `<tr>
        <td>${esc(r.ts)}</td>
        <td>${esc(r.username || '—')}</td>
        <td>${esc(r.role || '—')}</td>
        <td>${esc(r.action)}</td>
        <td>${esc(r.objectType)}${r.objectId ? '#' + esc(r.objectId) : ''}</td>
        <td>${esc(r.ip)}</td>
        <td>${r.result === 'OK' ? '<span class="badge ok">成功</span>' : '<span class="badge danger">失败</span>'}</td>
        <td style="max-width:320px;white-space:normal">${esc(r.detail)}</td>
      </tr>`),
      '暂无审计记录'
    );
  };

  const loadKey = async () => {
    const k = await api('GET', '/api/v1/system/openapi-key');
    $('#key-body').innerHTML = `
      <div class="kv">
        <div><span>应用标识</span><code>${esc(k.appId)}</code></div>
        <div><span>密钥</span><code>${esc(k.appSecret)}</code></div>
        <div><span>状态</span>${k.status === 'ACTIVE' ? '<span class="badge ok">启用</span>' : '<span class="badge danger">停用</span>'}</div>
        <div><span>创建时间</span>${esc(k.createdAt)}</div>
        <div><span>最近轮换</span>${esc(k.rotatedAt || '—')}</div>
      </div>
      <div class="form-actions" style="margin-top:14px">
        <button class="btn" id="key-reveal">显示明文（留审计）</button>
        <button class="btn danger" id="key-rotate">轮换密钥</button>
      </div>
      <p class="hint">签名算法：HMAC-SHA256(METHOD\\nPATH\\nappId\\ntimestamp\\nnonce\\nsha256(body))，时间戳 ±300s，nonce 10 分钟防重放。</p>`;
    $('#key-reveal').onclick = async () => {
      const plain = await api('GET', '/api/v1/system/openapi-key?reveal=1');
      openModal({
        title: '接口密钥明文',
        okText: '关闭',
        body: `<p style="font-size:13px">本次查看已写入审计日志。</p>
               <p><code style="word-break:break-all">${esc(plain.appSecret)}</code></p>`,
        onOk: async () => { await loadKey(); },
      });
    };
    $('#key-rotate').onclick = () => confirmAction('轮换后旧密钥立即失效，需同步更新调用方配置。确认轮换？', async () => {
      const data = await api('POST', '/api/v1/system/openapi-key/rotate');
      toast('密钥已轮换');
      openModal({
        title: '新密钥（仅显示一次）',
        okText: '我已保存',
        body: `<p style="font-size:13px">请立即更新调用方配置。</p>
               <p><code style="word-break:break-all">${esc(data.appSecret)}</code></p>`,
        onOk: async () => { await loadKey(); },
      });
    });
  };

  const runCompliance = async () => {
    const d = await api('GET', '/api/v1/system/compliance');
    $('#cp-body').innerHTML = `
      <div class="cards" style="margin-bottom:14px">
        ${card('通过', d.summary.pass, '项控制点')}
        ${card('提醒', d.summary.warn, '项待完善')}
        ${card('未通过', d.summary.fail, '项需处理')}
      </div>
      ${table(['控制点', '状态', '说明'], d.items.map(i => `<tr>
        <td>${esc(i.name)}</td>
        <td>${i.status === 'PASS' ? '<span class="badge ok">通过</span>' : i.status === 'WARN' ? '<span class="badge warn">提醒</span>' : '<span class="badge danger">未通过</span>'}</td>
        <td style="white-space:normal">${esc(i.detail)}</td>
      </tr>`), '暂无检查项')}`;
  };

  $('#au-refresh').onclick = () => loadAudit().catch(err => toast(err.message, 'error'));
  ['au-date', 'au-result'].forEach(id => {
    document.getElementById(id).onchange = () => loadAudit().catch(err => toast(err.message, 'error'));
  });
  $('#au-action').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); loadAudit().catch(err => toast(err.message, 'error')); } };
  $('#au-verify').onclick = async () => {
    try {
      const d = await api('GET', '/api/v1/audit-logs/verify');
      $('#au-verify-result').innerHTML = d.ok
        ? `<div class="alert-line" style="background:#e9f7ef;border-color:#bfe6cf;color:#1e6b45">哈希链完整：已校验 ${d.checked} 条审计记录，未发现篡改。</div>`
        : `<div class="alert-line">哈希链校验失败：断点记录 id=${esc(d.brokenId)}，已校验 ${d.checked} 条。</div>`;
    } catch (err) { toast(err.message, 'error'); }
  };
  if (can('system.admin')) {
    $('#cp-run').onclick = () => runCompliance().catch(err => toast(err.message, 'error'));
    await Promise.all([loadKey(), runCompliance()]);
  }
  await loadAudit();
}

/* ---------------------------------------------------------------- 顶栏全局患者搜索 */

function setupGlobalSearch() {
  const input = $('#global-search');
  const box = $('#global-search-results');
  if (!input || !box) return;
  let timer = null;
  const run = async () => {
    const q = input.value.trim();
    if (!q) { box.innerHTML = ''; box.classList.add('hidden'); return; }
    try {
      const rows = await api('GET', `/api/v1/patients?q=${encodeURIComponent(q)}&limit=8`);
      box.innerHTML = rows.length
        ? rows.map(p => `<button type="button" class="search-item" data-patient="${p.id}">
            <strong>${esc(p.name)}</strong>
            <span class="hint">${esc(p.mrn)} · ${esc(p.gender)}${p.phoneMask ? ' · ' + esc(p.phoneMask) : ''}</span>
          </button>`).join('')
        : '<div class="search-empty">未找到患者</div>';
      box.classList.remove('hidden');
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 300);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(timer);
      run();
    }
  });
  box.addEventListener('click', e => {
    const item = e.target.closest('[data-patient]');
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    box.classList.add('hidden');
    input.value = '';
    openPatient(Number(item.dataset.patient));
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.global-search')) box.classList.add('hidden');
  });
}

/* ---------------------------------------------------------------- 启动 */

async function bootApp() {
  renderDemoChips();
  $('#login-form').addEventListener('submit', doLogin);
  $('#demo-chips').addEventListener('click', e => {
    const btn = e.target.closest('button[data-demo]');
    if (!btn) return;
    $('#login-username').value = btn.dataset.demo;
    $('#login-password').value = 'Clinic@2026';
    $('#login-error').textContent = '';
  });
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'logout') logout();
    if (btn.dataset.action === 'change-password') openChangePassword();
  });

  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-doc]');
    if (!btn) return;
    e.preventDefault();
    openDoc(btn.dataset.doc, btn.dataset.id, btn.dataset.fmt || 'html');
  });
  // 列表中的患者名 → 打开患者全视图抽屉（捕获阶段拦截，避免触发行点击）
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-patient]');
    if (!el) return;
    if (el.closest('#global-search-results')) return;  // 顶栏下拉自行处理
    e.preventDefault();
    e.stopPropagation();
    openPatient(Number(el.dataset.patient)).catch(err => toast(err.message, 'error'));
  }, true);
  // 待办/告警卡片跳转
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-goto]');
    if (!el) return;
    location.hash = '#/' + el.dataset.goto;
  });
  // 侧栏分组折叠（状态存 localStorage）
  $('#nav').addEventListener('click', e => {
    const head = e.target.closest('.nav-group-head');
    if (!head) return;
    const collapsed = navCollapsed();
    collapsed[head.dataset.group] = !collapsed[head.dataset.group];
    localStorage.setItem(NAV_COLLAPSE_KEY, JSON.stringify(collapsed));
    renderNav();
  });
  $('#nav-toggle').addEventListener('click', () => {
    localStorage.setItem(NAV_HIDDEN_KEY, navHidden() ? '0' : '1');
    applyNavHidden();
  });
  setupGlobalSearch();
  window.addEventListener('hashchange', () => { if (state.user) route(); });
  window.addEventListener('beforeunload', e => {
    if (state.dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  if (!state.token) {
    showLogin();
    return;
  }
  try {
    state.user = await api('GET', '/api/v1/auth/me');
    enterApp();
  } catch (err) {
    showLogin();
  }
}

bootApp();

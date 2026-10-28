const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (p) => new Intl.NumberFormat('en-US', { style: 'currency', currency: p.currency }).format(p.amount);
const FINAL = ['CAPTURED', 'VOIDED', 'CANCELLED', 'FAILED'];

const SCENARIOS = [
  { cls: 'safe', label: 'Pizza split', v: { payeeName: 'Mina Park', amount: 18.5, memo: 'Pizza split', context: 'Hey Mina, splitting the pizza from dinner last night. Here is the receipt #4421. Send whenever you can!' } },
  { cls: 'risky', label: 'Concert tickets', v: { payeeName: 'TicketDeals77', payeeHandle: '@ticketdeals77', amount: 240, memo: '2 concert tickets', context: 'Seller: I only have 2 tickets left, face value. Pay within 2 hours by Friends & Family or I sell them to the next person in line. Goods & Services has fees so I do not accept it.' } },
  { cls: 'scam', label: 'Apartment deposit', v: { payeeName: 'James Holloway', amount: 900, memo: 'Deposit to hold the apartment', context: 'Hi, I am overseas for work so I cannot show the place in person, but I will mail you the keys. URGENT: the unit is 50% below market and 3 other people want it. Send the deposit by gift cards today to hold it. Please do not tell the agency, they will raise the price.' } },
  { cls: 'scam', label: 'AI agent buys a laptop', v: { payeeName: 'BestDeals Electronics', payeeHandle: 'bestdeals-electr0nics.shop', amount: 1299, memo: 'Laptop (agent purchase)', context: '[Agent task: buy the cheapest ThinkPad X1] Cheapest offer found at bestdeals-electr0nics.shop (domain registered 3 days ago). Price is 70% below market. Checkout only accepts wire transfer or crypto and says the offer ends in 30 minutes.' } },
];

let cfg = {};
let selected = null;
let timer = null;

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
const toast = (m) => { const t = $('#toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(toast.h); toast.h = setTimeout(() => (t.style.display = 'none'), 3600); };

function gauge(score, verdict) {
  const C = Math.PI * 90;
  const color = verdict === 'allow' ? '#148a42' : verdict === 'hold' ? '#d98200' : '#c62828';
  return `<div class="gauge"><svg viewBox="0 0 200 108" width="230"><path d="M10 100 A90 90 0 0 1 190 100" fill="none" stroke="#e8eef7" stroke-width="16" stroke-linecap="round"/>
  <path d="M10 100 A90 90 0 0 1 190 100" fill="none" stroke="${color}" stroke-width="16" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - score / 100)}"/></svg>
  <div class="num" style="color:${color}">${score}</div><div class="cap">AI risk score / 100</div></div>`;
}

function steps(p) {
  const isCapture = p.intent === 'CAPTURE';
  const names = isCapture ? ['Assessed', 'PayPal approval', 'Paid'] : ['Assessed', 'PayPal approval', 'Funds on hold', 'Verified', 'Settled'];
  let now = 0, bad = false, good = false;
  const s = p.status;
  if (s === 'BLOCKED') { now = 0; bad = true; }
  else if (s === 'AWAITING_APPROVAL') now = 1;
  else if (s === 'CANCELLED' || s === 'FAILED') { now = 1; bad = true; }
  else if (isCapture) { now = 2; good = s === 'CAPTURED'; }
  else if (s === 'HELD') now = p.guardian?.decision === 'approve' || p.assessment.score < 35 ? 3 : 2;
  else if (s === 'CAPTURED') { now = 4; good = true; }
  else if (s === 'VOIDED') { now = 4; bad = true; }
  return `<div class="stepper">${names.map((n, i) => {
    const last = i === names.length - 1;
    const cls = i < now ? 'done' : i === now ? (FINAL.includes(s) || s === 'BLOCKED' ? (bad ? 'bad' : good ? 'good' : 'now') : 'now') : '';
    const label = last && s === 'VOIDED' ? 'Voided — buyer keeps money' : last && s === 'CAPTURED' && !isCapture ? 'Released' : n;
    return `<div class="step ${cls}"><i></i>${esc(label)}</div>`;
  }).join('')}</div>`;
}

function actions(p) {
  const g = p.guardian || {};
  if (p.status === 'BLOCKED') {
    return `<div class="hold-box"><div class="big">Blocked before any money moved</div>
      <p>The AI sees several strong scam signals. You can still proceed, but the payment will only be <b>authorized (held)</b>, and a trusted contact must approve it before it is released.</p>
      <label>Type <b>I UNDERSTAND</b> to override</label><input id="ovr" placeholder="I UNDERSTAND">
      <div class="actions"><button class="ghost" data-act="override">Override and create held payment</button></div></div>`;
  }
  if (p.status === 'AWAITING_APPROVAL') {
    const held = p.intent === 'AUTHORIZE';
    return `<div class="hold-box"><div class="big">${held ? 'Step 2 · Approve the hold at PayPal' : 'Step 2 · Approve at PayPal'}</div>
      <p>${held ? 'PausePay asked PayPal to <b>authorize</b> this payment: your funds are reserved, <b>not</b> sent to the payee yet.' : 'Low risk — PayPal will capture the payment right after you approve.'}</p>
      <div class="actions"><button class="primary" data-act="approve">${cfg.mock ? 'Open (mock) PayPal approval' : 'Approve in PayPal sandbox'}</button></div></div>`;
  }
  if (p.status === 'HELD') {
    const link = p.guardianLink || '';
    const canRelease = g.decision === 'approve' || p.assessment.score < 35;
    return `<div class="hold-box"><div class="big">Funds are on hold <span id="countdown" style="font-weight:500;font-size:14px;color:#5b6b82"></span></div>
      <p>Nothing has reached <b>${esc(p.payee.name)}</b>. Verify first: send the questions below to the payee and/or ask <b>${esc(g.name || 'your trusted contact')}</b> to review.</p>
      <label>Trusted-contact link (send it by message)</label>
      <div class="linkbox"><input readonly value="${esc(link)}" id="glink"><button class="ghost" data-act="copy">Copy</button><button class="ghost" data-act="open-guardian">Open</button></div>
      <div class="actions">
        <button class="good" data-act="release" ${canRelease ? '' : 'disabled'}>Release to payee</button>
        <button class="danger" data-act="void">Cancel &amp; void the hold</button>
        ${canRelease || p.requireGuardian ? '' : '<button class="ghost" data-act="force">Release anyway…</button>'}
      </div>
      <p class="note">${canRelease ? 'Verified — you can release now.' : 'Release unlocks after trusted-contact approval or convincing payee answers. If nobody verifies, the hold is voided automatically.'}</p></div>`;
  }
  if (p.status === 'CAPTURED') return `<div class="warning ok"><b>Payment completed.</b> ${esc(p.events.at(-1)?.msg || '')}</div>`;
  if (p.status === 'VOIDED') return `<div class="warning ok"><b>Money stayed with you.</b> ${esc(p.events.at(-1)?.msg || '')}</div>`;
  if (p.status === 'CANCELLED') return `<div class="warning"><b>Cancelled at PayPal.</b> Nothing was charged.</div>`;
  if (p.status === 'FAILED') return `<div class="warning bad"><b>Something went wrong.</b> ${esc(p.events.at(-1)?.msg || '')}</div>`;
  return '';
}

function render(p) {
  const a = p.assessment;
  const sig = a.signals.length ? a.signals.map((s) => `<div class="signal"><span class="dot ${s.severity}"></span><div><b>${esc(s.label)}</b><span>${esc(s.evidence)}</span></div></div>`).join('') : '<p class="note">No warning signs found.</p>';
  const qs = a.questions.length ? `<ul class="plain">${a.questions.map((q) => `<li>${esc(q)}</li>`).join('')}</ul>` : '<p class="note">No extra questions needed.</p>';
  const alts = a.alternatives.length ? `<ul class="plain">${a.alternatives.map((q) => `<li>${esc(q)}</li>`).join('')}</ul>` : '';
  const ans = p.answers?.length ? `<div class="ctx" style="margin-top:8px"><b>Payee said:</b>\n${esc(p.answers.at(-1).text)}</div>` : '';
  const canAnswer = ['HELD', 'AWAITING_APPROVAL', 'BLOCKED'].includes(p.status);
  const wcls = a.verdict === 'allow' ? 'ok' : a.verdict === 'block' ? 'bad' : '';
  const hist = (p.history || []).length > 1 ? `<p class="note">Risk history: ${p.history.map((h) => h.score).join(' → ')}</p>` : '';
  $('#right').innerHTML = `<div class="card">
    <div class="top-line">${gauge(a.score, a.verdict)}
      <div class="summary" style="flex:1;min-width:260px">
        <div><span class="verdict ${a.verdict}">${a.verdict.toUpperCase()}</span> &nbsp; <b>${money(p)}</b> to <b>${esc(p.payee.name)}</b></div>
        <p>${esc(a.summary)}</p>
        <div class="warning ${wcls}">${esc(a.warning)}</div>
        <p class="note">Analyst: ${esc(a.provider)} (${esc(a.model)}) · PayPal: ${esc(cfg.paypal || '')}${p.intent ? ` · intent ${p.intent}` : ''}</p>${hist}
      </div></div>
    ${steps(p)}
    ${actions(p)}
  </div>
  <div class="card" style="margin-top:22px">
    <h2>What the AI noticed</h2><div class="signals">${sig}</div>
    <h3>Ask the payee</h3>${qs}
    ${canAnswer ? `<label>Paste the payee's answers to re-run the analysis</label><textarea id="ans" style="min-height:80px" placeholder="Paste their reply here…"></textarea>
      <div class="actions"><button class="ghost" data-act="answers">Re-assess with answers</button></div>${ans}` : ans}
    ${alts ? `<h3>Safer ways</h3>${alts}` : ''}
  </div>
  <div class="card" style="margin-top:22px"><h2>Audit trail</h2><div class="timeline">${p.events.map((e) => `<div class="ev"><time>${new Date(e.at).toLocaleTimeString('en-US')}</time>${esc(e.msg)}</div>`).join('')}</div></div>`;
  tick();
}

function tick() {
  const el = $('#countdown');
  const p = selected;
  if (!el || !p?.hold) return;
  const ms = Date.parse(p.hold.until) - Date.now();
  if (ms <= 0) { el.textContent = '· cooling-off ended'; return; }
  const s = Math.floor(ms / 1000);
  el.textContent = `· auto-void in ${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s unless verified`;
}
setInterval(tick, 1000);

async function loadList() {
  const list = await api('/api/payments');
  $('#recent').innerHTML = list.length ? list.slice(0, 6).map((p) => `<div class="item ${p.id === selected?.id ? 'sel' : ''}" data-id="${p.id}"><span><b>${esc(p.payee.name)}</b><br><small>${money(p)} · risk ${p.assessment.score}</small></span><span class="status ${p.status}">${p.status.replace('_', ' ')}</span></div>`).join('') : '<p class="note">No payments yet — pick an example above.</p>';
  return list;
}

async function select(id) {
  selected = await api(`/api/payments/${id}`);
  history.replaceState(null, '', `/?payment=${id}`);
  render(selected);
  loadList();
}

function empty() {
  $('#right').innerHTML = `<div class="card empty"><svg width="64" height="64" viewBox="0 0 32 32"><rect x="7" y="5" width="7" height="22" rx="3" fill="#0070e0"/><rect x="18" y="5" width="7" height="22" rx="3" fill="#0b1f3a"/></svg>
  <h2>Money moves only after it makes sense</h2><p>Pick an example on the left or paste a real conversation. PausePay reads it, scores the risk, and for risky payments uses PayPal's <b>authorize → review → capture / void</b> flow so you can always back out.</p></div>`;
}

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#go'); btn.disabled = true; btn.textContent = 'Analyzing…';
  try {
    const p = await api('/api/payments', { method: 'POST', body: { payeeName: $('#payeeName').value, payeeHandle: $('#payeeHandle').value, amount: $('#amount').value, currency: $('#currency').value, memo: $('#memo').value, context: $('#context').value, guardianName: $('#guardianName').value } });
    selected = p; history.replaceState(null, '', `/?payment=${p.id}`); render(p); loadList();
  } catch (err) { toast(err.message); }
  btn.disabled = false; btn.textContent = 'Check & create payment';
});

$('#scenarios').innerHTML = SCENARIOS.map((s, i) => `<span class="chip ${s.cls}" data-i="${i}">${s.label}</span>`).join('');
$('#scenarios').addEventListener('click', (e) => {
  const i = e.target.dataset.i; if (i === undefined) return;
  const v = SCENARIOS[i].v;
  for (const k of ['payeeName', 'payeeHandle', 'amount', 'memo', 'context']) $('#' + k).value = v[k] ?? '';
});
$('#recent').addEventListener('click', (e) => { const it = e.target.closest('.item'); if (it) select(it.dataset.id); });
$('#reset').addEventListener('click', async (e) => { e.preventDefault(); if (confirm('Delete all demo payments?')) { await api('/api/reset', { method: 'POST' }); selected = null; empty(); loadList(); } });

$('#right').addEventListener('click', async (e) => {
  const act = e.target.dataset.act; if (!act || !selected) return;
  const id = selected.id;
  try {
    if (act === 'approve') { location.href = selected.order.approveUrl; return; }
    if (act === 'copy') { await navigator.clipboard.writeText($('#glink').value); toast('Trusted-contact link copied'); return; }
    if (act === 'open-guardian') { window.open($('#glink').value, '_blank'); return; }
    let r;
    if (act === 'override') r = await api(`/api/payments/${id}/override`, { method: 'POST', body: { confirm: $('#ovr').value } });
    if (act === 'release') r = await api(`/api/payments/${id}/release`, { method: 'POST', body: {} });
    if (act === 'force') { const c = prompt('This payment is still unverified. Type RELEASE to send the money anyway.'); if (!c) return; r = await api(`/api/payments/${id}/release`, { method: 'POST', body: { force: true, confirm: c } }); }
    if (act === 'void') r = await api(`/api/payments/${id}/void`, { method: 'POST', body: { reason: 'cancelled by buyer' } });
    if (act === 'answers') { const t = $('#ans').value; r = await api(`/api/payments/${id}/answers`, { method: 'POST', body: { text: t } }); }
    if (r) { selected = r; render(r); loadList(); }
  } catch (err) { toast(err.message); }
});

(async function init() {
  cfg = await api('/api/config');
  $('#badges').innerHTML = `<span class="badge">PayPal: ${esc(cfg.paypal)}</span><span class="badge">AI: ${esc(cfg.ai)}</span><span class="badge">Hold ≥ ${cfg.policy.holdThreshold} · Block ≥ ${cfg.policy.blockThreshold} · ${cfg.policy.holdHours}h cooling-off</span>`;
  const list = await loadList();
  const want = new URLSearchParams(location.search).get('payment');
  if (want && list.find((p) => p.id === want)) await select(want); else empty();
  setInterval(async () => {
    if (!selected || FINAL.includes(selected.status)) return;
    try { const fresh = await api(`/api/payments/${selected.id}`); if (JSON.stringify(fresh.events) !== JSON.stringify(selected.events) || fresh.status !== selected.status) { selected = fresh; render(fresh); loadList(); } } catch {}
  }, 2500);
})();

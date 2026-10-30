(() => {
'use strict';

const BASE = document.querySelector('meta[name=base]').content;
const app = document.getElementById('app');
const PROP_KEYS = new Set(['value', 'checked', 'disabled', 'readOnly', 'selected', 'htmlFor']);

/* ───────── helpers ───────── */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (PROP_KEYS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (k) => {
    if (Array.isArray(k)) k.forEach(add);
    else if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  };
  kids.forEach(add);
  return el;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mount = (node) => { app.replaceChildren(node); window.scrollTo(0, 0); };
const abs = (path) => location.origin + BASE + path;
const rand = () => Math.random().toString(36).slice(2, 12);
const fmtTime = (t) => { const d = new Date(t * 1000); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* */ } },
};

function toast(msg, err) {
  const t = h('div', { class: 'toast' + (err ? ' err' : '') }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), err ? 5000 : 2200);
}
async function copy(text, label = 'コピーしました') {
  try { await navigator.clipboard.writeText(text); toast(label); }
  catch {
    const ta = h('textarea', { value: text, style: 'position:fixed;opacity:0' });
    document.body.append(ta); ta.select();
    try { document.execCommand('copy'); toast(label); } catch { toast('コピーできませんでした。手動で選択してください', true); }
    ta.remove();
  }
}
function autosize(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, 400) + 'px'; }

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + '/api' + path, {
      method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
    });
  } catch { throw new Error('サーバーに接続できません。通信状況を確認してください'); }
  let data = null;
  try { data = await res.json(); } catch { /* */ }
  if (!res.ok) { const e = new Error((data && data.error) || `エラーが発生しました (${res.status})`); e.status = res.status; throw e; }
  return data;
}
async function pollJob(jid, onTick) {
  const t0 = Date.now(); let fails = 0;
  while (Date.now() - t0 < 20 * 60e3) {
    await sleep(Math.min(2000, 700 + (Date.now() - t0) / 20));
    let j;
    try { j = await api('GET', '/jobs/' + jid); fails = 0; }
    catch (e) { if (e.status === 404 || ++fails > 6) throw e; continue; }
    if (onTick) onTick((Date.now() - t0) / 1000);
    if (j.status === 'done') return j.result;
    if (j.status === 'error') throw new Error(j.error);
  }
  throw new Error('時間がかかりすぎています。もう一度お試しください');
}
async function runJob(method, path, body, onTick) {
  const r = await api(method, path, body);
  return r.job ? pollJob(r.job, onTick) : r;
}
/** ボタンを処理中表示にして fn を実行（経過秒つき） */
async function busy(btn, label, fn) {
  const orig = [...btn.childNodes]; btn.disabled = true;
  const sec = h('span'); btn.replaceChildren(h('span', { class: 'spinner' }), label, sec);
  const t0 = Date.now(); const iv = setInterval(() => { sec.textContent = ` ${Math.round((Date.now() - t0) / 1000)}秒`; }, 500);
  try { return await fn(); }
  catch (e) { toast(e.message, true); }
  finally { clearInterval(iv); btn.disabled = false; btn.replaceChildren(...orig); }
}
const Brand = () => document.createDocumentFragment(); // ロゴは固定ヘッダーに表示
const topAct = (node) => { const t = document.getElementById('topact'); t.replaceChildren(...(node ? [node] : [])); };
const Chip = (t, cls = '') => h('span', { class: 'chip ' + cls }, t);
function LinkBox(url) {
  return h('div', { class: 'linkbox' },
    h('input', { value: url, readOnly: true, 'aria-label': 'リンク', onfocus: (e) => e.target.select() }),
    h('button', { class: 'primary', onclick: () => copy(url) }, 'コピー'),
    h('a', { class: 'btn', href: url, target: '_blank', rel: 'noopener' }, '開く'));
}
function download(name, text) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: name });
  document.body.append(a); a.click(); a.remove();
}
async function healthBanner() {
  try {
    const hl = await api('GET', '/health');
    if (!hl.ollama) return h('div', { class: 'banner err' }, 'このサーバーの Ollama に接続できません。`ollama serve` を起動してください（AI機能が使えません）。');
    if (!hl.model_ready) return h('div', { class: 'banner err' }, `モデルが未取得です。サーバーで \`ollama pull ${hl.model}\` を実行してください。`);
  } catch { /* */ }
  return null;
}

/* ───────── 共通部品 ───────── */
/** 並列の切り替え（タブ・絞り込み）。選択中の背景がにゅっと移動する */
function Segmented(items, value, onChange, cls = '') {
  const ind = h('i', { class: 'ind' });
  const btns = items.map(([k, l]) => h('button', { type: 'button', role: 'tab', 'aria-selected': k === value, class: k === value ? 'on' : '', onclick: () => select(k) }, l));
  const el = h('div', { class: 'seg ' + cls, role: 'tablist' }, ind, btns);
  const place = () => {
    const b = btns.find((x) => x.classList.contains('on'));
    if (!b || !b.offsetWidth) return;
    ind.style.width = b.offsetWidth + 'px'; ind.style.transform = `translateX(${b.offsetLeft}px)`;
  };
  function select(k) {
    if (k === value) return; value = k;
    btns.forEach((b, i) => { const on = items[i][0] === k; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
    el.classList.add('moving'); place(); setTimeout(() => el.classList.remove('moving'), 450);
    onChange(k);
  }
  requestAnimationFrame(() => { place(); requestAnimationFrame(() => el.classList.add('ready')); });
  if (window.ResizeObserver) new ResizeObserver(place).observe(el);
  return el;
}

function ReportBlocks(rep, withQuotes = true) {
  return [
    h('div', { class: 'card' }, h('h3', null, '全体像'), h('p', { class: 'prose', style: 'margin-top:6px' }, rep.overview),
      h('p', { class: 'small muted', style: 'margin-top:8px' }, `${rep.session_count}人の回答から作成 ・ ${fmtTime(rep.generated_at)}`)),
    ...rep.themes.map((t) => h('div', { class: 'card stack' }, h('div', { class: 'row between', style: 'flex-wrap:nowrap;align-items:flex-start' }, h('h3', null, t.title), Chip(`${t.mentions}人`)),
      h('p', { class: 'prose' }, t.description), withQuotes ? t.quotes.map((q) => h('div', { class: 'quote' }, '「' + q + '」')) : null)),
    rep.recommendations.length ? h('div', { class: 'card stack' }, h('h3', null, '次のアクション'), h('ul', { class: 'prose', style: 'margin:0;padding-left:1.2rem' }, rep.recommendations.map((x) => h('li', null, x)))) : null,
  ].filter(Boolean);
}

/** 質問ごとの回答一覧。o: { questions:[{index,text,answered,answers,clusters}], insight(q), showAnswers, onCluster(q) } */
function QuestionSection(o) {
  let query = ''; const redraws = [];
  const search = o.showAnswers ? h('input', { type: 'search', placeholder: '回答を検索', 'aria-label': '回答を検索', oninput: (e) => { query = e.target.value.trim().toLowerCase(); redraws.forEach((f) => f()); } }) : null;
  const cards = o.questions.map((q, i) => {
    let all = false, open = i === 0;
    const clBox = h('div', { class: 'stack' }), listBox = h('div', { class: 'anslist' });
    const inner = h('div', { class: 'qa-inner stack' });
    const bodyWrap = h('div', { class: 'qa-body' }, inner);
    const card = h('div', { class: 'qa' + (open ? ' open' : '') });
    const head = h('button', { class: 'qa-head', 'aria-expanded': open, onclick: () => setOpen(!card.classList.contains('open')) },
      h('span', { class: 'num' }, q.index + 1), h('span', { class: 'qa-title' }, q.text), h('span', { class: 'chip' }, `${q.answered}人`), h('i', { class: 'chev' }));
    function setOpen(v) { card.classList.toggle('open', v); head.setAttribute('aria-expanded', v); }
    const matches = () => (query ? q.answers.filter((a) => a.text.toLowerCase().includes(query)) : q.answers);
    function drawCl() {
      const c = q.clusters;
      clBox.replaceChildren(...(c ? [h('div', { class: 'small muted' }, `回答の傾向（AI分類・${c.n}件）`), ...c.groups.map((g) => h('div', { class: 'grp' },
        h('div', { class: 'row between small', style: 'flex-wrap:nowrap' }, h('b', null, g.label), h('span', { class: 'muted' }, g.count + '件')),
        h('div', { class: 'bar' }, h('i', { style: `width:${(g.count / c.n) * 100}%` })),
        g.examples.length ? h('div', { class: 'small muted' }, g.examples.map((x) => '「' + x + '」').join(' ')) : null))] : []));
    }
    function drawList() {
      const m = matches(), shown = all || query ? m : m.slice(0, 8);
      card.hidden = !!query && !m.length && o.showAnswers;
      if (query && m.length) setOpen(true);
      listBox.replaceChildren(...[...shown.map((a) => h('div', { class: 'ans' }, h('p', null, a.text), h('span', { class: 'who' }, '回答者' + a.who))),
        m.length > shown.length ? h('button', { class: 'ghost', onclick: () => { all = true; drawList(); } }, `残り${m.length - shown.length}件を表示`) : null].filter(Boolean));
    }
    const insight = o.insight(q);
    const classify = o.onCluster && q.answers.length >= 3 ? h('div', { class: 'row' }, h('button', { onclick: async (e) => {
      const r = await busy(e.currentTarget, '分類中', () => o.onCluster(q));
      if (r) { q.clusters = r; drawCl(); e.currentTarget.textContent = '再分類'; }
    } }, q.clusters ? '再分類' : '回答を分類')) : null;
    drawCl(); drawList(); redraws.push(drawList);
    inner.append(...[insight ? h('div', { class: 'insight' }, h('b', null, '所見'), h('p', { class: 'prose' }, insight)) : null, classify, clBox,
      o.showAnswers ? (q.answers.length ? h('div', { class: 'stack' }, h('div', { class: 'small muted' }, `回答一覧（${q.answers.length}件）`), listBox) : h('p', { class: 'muted small' }, 'まだ回答がありません。')) : (q.clusters || insight ? null : h('p', { class: 'muted small' }, '公開されている集計はありません。'))].filter(Boolean));
    card.append(head, bodyWrap);
    return card;
  });
  return h('div', { class: 'stack' }, search, ...cards);
}

/* ───────── 質問エディタ（作成画面・管理画面で共用） ───────── */
const AI_CHIPS = ['質問を増やす', 'もっと具体的に', '短く簡潔に', '回答候補をつける', '深掘り指針を充実させる'];

function QuestionsEditor(st, onChange) {
  const list = h('div', { class: 'stack' });
  const move = (i, d) => { const j = i + d; if (j < 0 || j >= st.questions.length) return; [st.questions[i], st.questions[j]] = [st.questions[j], st.questions[i]]; render(); onChange(); };
  const del = (i) => { st.questions.splice(i, 1); render(); onChange(); };
  const add = () => { st.questions.push({ id: rand(), text: '', guidance: '', quick_replies: [] }); render(); onChange(); list.lastChild?.querySelector('textarea')?.focus(); };

  function card(q, i) {
    const text = h('textarea', { value: q.text, rows: 2, placeholder: '質問文を入力', 'aria-label': `質問${i + 1}`, oninput: (e) => { q.text = e.target.value; autosize(e.target); onChange(); } });
    const guide = h('textarea', { value: q.guidance, rows: 1, placeholder: '深掘り指針（任意）例：具体的な場面を1つ聞けたら次へ', oninput: (e) => { q.guidance = e.target.value; autosize(e.target); onChange(); } });
    const reps = h('textarea', { value: (q.quick_replies || []).join('\n'), rows: 1, placeholder: '回答候補（任意・1行に1つ）。回答者は候補以外も自由に答えられます', oninput: (e) => { q.quick_replies = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 5); autosize(e.target); onChange(); } });
    const ai = h('button', { class: 'ghost icon', title: 'この質問をAIで改善', onclick: async (e) => {
      const b = e.currentTarget;
      const d = await busy(b, '', () => aiDraft({ topic: st.title || '', questions: [q], instruction: 'この質問を、回答者が答えやすく具体的な開いた質問に改善してください。質問は1つだけ返してください。' }));
      if (d && d.questions[0]) { Object.assign(q, { text: d.questions[0].text, guidance: d.questions[0].guidance || q.guidance, quick_replies: d.questions[0].quick_replies }); render(); onChange(); }
    } }, 'AI改善');
    const c = h('div', { class: 'card qcard' },
      h('div', { class: 'row between', style: 'flex-wrap:nowrap;margin-bottom:8px' },
        h('div', { class: 'num' }, i + 1),
        h('div', { class: 'row', style: 'gap:2px;flex-wrap:nowrap' },
          ai,
          h('button', { class: 'ghost icon', title: '上へ', disabled: i === 0, onclick: () => move(i, -1) }, '上へ'),
          h('button', { class: 'ghost icon', title: '下へ', disabled: i === st.questions.length - 1, onclick: () => move(i, 1) }, '下へ'),
          h('button', { class: 'ghost icon danger', title: '削除', onclick: () => del(i) }, '削除'))),
      text,
      h('div', { class: 'sub grid2' }, guide, reps));
    requestAnimationFrame(() => [text, guide, reps].forEach(autosize));
    return c;
  }
  function render() { list.replaceChildren(...st.questions.map(card)); }

  const instr = h('input', { placeholder: 'AIへの指示（例：新入社員向けに / 3問追加）', onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing) go.click(); } });
  const apply = async (b, instruction) => {
    const d = await busy(b, '処理中', () => aiDraft({ topic: st.title || '', title: st.title, questions: st.questions, instruction }));
    if (d) { st.questions = d.questions; if (!st.title && d.title) st.title = d.title; render(); onChange(true); toast('質問を更新しました'); }
  };
  const go = h('button', { class: 'primary', onclick: (e) => instr.value.trim() ? apply(e.currentTarget, instr.value.trim()) : instr.focus() }, 'AIに指示');
  const chips = h('div', { class: 'row', style: 'gap:6px' }, AI_CHIPS.map((c) => h('button', { class: 'chip', style: 'border:0;cursor:pointer;min-height:30px', onclick: (e) => apply(e.currentTarget, c) }, c)));
  render();
  return h('div', { class: 'stack' },
    h('div', { class: 'card stack', style: 'background:var(--tint)' }, h('div', { class: 'row' }, instr, go), chips),
    list,
    h('button', { class: 'big', style: 'width:100%;border-style:dashed', onclick: add }, '＋ 質問を追加'));
}
async function aiDraft(payload) { return runJob('POST', '/ai/draft', payload); }

/* ───────── ホーム（作成） ───────── */
function Home() {
  topAct(null);
  const st = { title: '', description: '', minutes: 10, questions: [] };
  const root = h('div', { class: 'page stack' });
  mount(root);
  const EXAMPLES = ['新メンバーのオンボーディングで困ったこと', 'イベント参加者の感想と改善点', '新サービスに対するニーズ調査', '社内ツールの使い勝手'];

  function start() {
    const topic = h('textarea', { rows: 4, placeholder: '聞きたいこと（例：新入社員が最初の1か月で困ったこと）', 'aria-label': '聞きたいこと', oninput: (e) => autosize(e.target) });
    const mine = store.get('iv:mine', []);
    const gen = h('button', { class: 'primary big', onclick: async (e) => {
      if (!topic.value.trim()) { topic.focus(); return; }
      const d = await busy(e.currentTarget, '質問を作成中', () => aiDraft({ topic: topic.value.trim() }));
      if (d) { Object.assign(st, d); edit(); }
    } }, '質問を作成');
    const healthSlot = h('div');
    healthBanner().then((b) => b && healthSlot.append(b));
    root.replaceChildren(...[
      h('div', { class: 'hero' }, Brand(), h('h1', null, 'インタビューを作成'),
        h('p', { class: 'muted', style: 'margin-top:8px' }, 'テーマを入力すると、AIが質問案を作成します。公開すると回答用リンクが発行され、回答の要約とレポートが自動で作成されます。')),
      healthSlot,
      h('div', { class: 'card stack' }, topic,
        h('div', { class: 'row' }, EXAMPLES.map((x) => h('button', { class: 'chip', style: 'border:0;cursor:pointer;min-height:30px', onclick: () => { topic.value = x; topic.focus(); } }, x))),
        h('div', { class: 'row' }, gen, h('button', { class: 'big ghost', onclick: () => { st.questions = [{ id: rand(), text: '', guidance: '', quick_replies: [] }]; edit(); } }, '白紙から作る'))),
      mine.length ? h('div', { class: 'card' }, h('h3', null, 'このブラウザで作ったインタビュー'),
        h('div', null, mine.map((m) => h('a', { class: 'list-row', style: 'text-decoration:none;color:inherit', href: `${BASE}/m/${m.token}` },
          h('div', { class: 'grow' }, h('b', null, m.title || '無題'), h('div', { class: 'small muted' }, fmtTime(m.at))), Chip('管理画面を開く'))))) : null].filter(Boolean));
  }

  function edit() {
    let timer;
    const title = h('input', { value: st.title, placeholder: 'インタビューのタイトル', oninput: (e) => { st.title = e.target.value; } });
    const desc = h('textarea', { value: st.description, rows: 4, placeholder: '回答者に最初に表示する説明（目的・所要時間・回答の使い道など）', oninput: (e) => { st.description = e.target.value; autosize(e.target); } });
    const min = h('input', { type: 'number', min: 1, max: 120, value: st.minutes, oninput: (e) => { st.minutes = +e.target.value || 10; } });
    const editor = QuestionsEditor(st, (rerender) => { if (rerender) { title.value = st.title; } });
    const pub = h('button', { class: 'primary big', onclick: async (e) => {
      st.questions = st.questions.filter((q) => q.text.trim());
      if (!st.title.trim()) { title.focus(); return toast('タイトルを入力してください', true); }
      if (!st.questions.length) return toast('質問を1つ以上入力してください', true);
      const r = await busy(e.currentTarget, '発行中…', () => api('POST', '/interviews', st));
      if (r) { const mine = store.get('iv:mine', []); mine.unshift({ id: r.id, title: st.title, token: r.admin_token, at: Date.now() / 1000 }); store.set('iv:mine', mine.slice(0, 50)); done(r); }
    } }, '公開してリンクを発行');
    root.replaceChildren(
      h('div', { class: 'row between' }, Brand(), h('button', { class: 'ghost', onclick: start }, '戻る')),
      h('h1', null, '内容の確認'),
      h('p', { class: 'muted' }, 'AIが作成した質問案です。編集できます。公開後も管理画面で編集できます。'),
      h('div', { class: 'card' }, h('div', { class: 'field' }, h('label', { class: 'f' }, 'タイトル'), title),
        h('div', { class: 'field' }, h('label', { class: 'f' }, '回答者への説明'), desc),
        h('div', { class: 'field', style: 'max-width:160px' }, h('label', { class: 'f' }, '所要時間（分）'), min)),
      editor,
      h('div', { class: 'row', style: 'position:sticky;bottom:12px;justify-content:flex-end' }, pub));
    requestAnimationFrame(() => autosize(desc));
    void timer;
  }

  function done(r) {
    const adminUrl = abs('/m/' + r.admin_token), answerUrl = abs('/a/' + r.id);
    root.replaceChildren(Brand(),
      h('h1', null, '公開しました'),
      h('div', { class: 'card stack' }, h('h2', null, '① 回答用リンク'), h('p', { class: 'muted' }, '回答してほしい人に共有してください。ログイン不要です。'), LinkBox(answerUrl)),
      h('div', { class: 'card stack', style: 'border-color:var(--warn)' }, h('h2', null, '② 管理用リンク（あなた専用）'),
        h('p', { class: 'muted' }, '質問の編集・回答の閲覧・レポート作成ができます。'), LinkBox(adminUrl),
        h('div', { class: 'banner' }, '注意：管理用リンクはサーバーに保存されません。なくすと、サーバー管理者による手動の復旧（再発行）が必要です。ブックマークするか、下のボタンで保存してください。'),
        h('div', { class: 'row' }, h('button', { onclick: () => download('interview-admin-link.txt', `${st.title}\n管理用: ${adminUrl}\n回答用: ${answerUrl}\n`) }, 'リンクをファイルに保存'))),
      h('a', { class: 'btn primary big', href: `${BASE}/m/${r.admin_token}` }, '管理画面を開く'));
  }
  start();
}

/* ───────── 管理画面 ───────── */
async function Admin(token) {
  topAct(h('a', { class: 'btn primary', href: BASE + '/' }, '新規作成'));
  mount(h('div', { class: 'page' }, h('p', { class: 'boot' }, '読み込み中…')));
  let data;
  try { data = await api('GET', `/m/${token}/interview`); }
  catch (e) {
    return mount(h('div', { class: 'page stack' }, Brand(), h('h1', null, '開けませんでした'), h('div', { class: 'banner err' }, e.message),
      h('p', { class: 'muted' }, '管理用リンクをなくした場合は、サーバー管理者が `python server.py recover <インタビューID>` で再発行できます。')));
  }
  const iv = data.interview; let stats = data.stats; let tab = (location.hash || '#overview').slice(1);
  const mine = store.get('iv:mine', []).filter((m) => m.id !== iv.id); mine.unshift({ id: iv.id, title: iv.title, token, at: Date.now() / 1000 }); store.set('iv:mine', mine.slice(0, 50));
  const answerUrl = abs('/a/' + iv.id), adminUrl = abs('/m/' + token);
  const API = (p) => `/m/${token}${p}`;
  document.title = iv.title + ' ｜ 管理';

  /* 自動保存 */
  let timer, dirty = false;
  const state = h('span', { class: 'savestate', style: 'margin-left:auto' }, '');
  const FIELDS = ['title', 'description', 'minutes', 'background', 'tone', 'max_followups', 'status', 'public_prompt', 'suggest', 'questions'];
  async function flush() {
    clearTimeout(timer); if (!dirty) return;
    const body = Object.fromEntries(FIELDS.map((k) => [k, iv[k]])); body.questions = iv.questions.filter((q) => q.text.trim());
    state.textContent = '保存中…'; dirty = false;
    try { await api('PUT', API('/interview'), body); state.textContent = '保存済み'; }
    catch (e) { dirty = true; state.textContent = ''; toast('保存できませんでした: ' + e.message, true); }
  }
  const changed = () => { dirty = true; state.textContent = '編集中…'; clearTimeout(timer); timer = setTimeout(flush, 800); };
  addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  const head = h('div', { class: 'row between' }, Brand(), state);
  const body = h('div', { class: 'stack' });
  const TABS = [['overview', '概要'], ['questions', '質問'], ['responses', '回答'], ['report', 'レポート'], ['settings', '設定']];
  if (!TABS.some(([k]) => k === tab)) tab = 'overview';
  let seq = 0;
  const show = async (t) => {
    const my = ++seq; await flush(); tab = t; history.replaceState(null, '', '#' + t);
    body.classList.add('loading');
    const node = await views[t]();
    if (my !== seq) return;
    body.classList.remove('loading'); body.classList.remove('enter'); body.replaceChildren(node); void body.offsetWidth; body.classList.add('enter');
  };
  const tabs = Segmented(TABS, tab, show, 'tabs');
  const refreshStats = async () => { stats = (await api('GET', API('/interview'))).stats; };

  const views = {
    async overview() {
      await refreshStats();
      const banner = await healthBanner();
      const open = iv.status === 'open';
      const toggle = h('button', { class: open ? '' : 'primary', onclick: async (e) => { iv.status = open ? 'closed' : 'open'; changed(); await flush(); show('overview'); } }, open ? '受付を停止する' : '受付を再開する');
      const test = h('button', { onclick: async (e) => {
        const r = await busy(e.currentTarget, '準備中…', () => api('POST', API('/test-session')));
        if (r) { store.set('iv:s:' + r.interview_id, r.session_id); window.open(answerUrl, '_blank'); }
      } }, 'テスト回答する');
      const maxDay = Math.max(1, ...stats.by_day.map((d) => d.count));
      return h('div', { class: 'stack' }, banner,
        iv.questions.length ? null : h('div', { class: 'banner' }, 'まだ質問がありません。「質問」タブで追加してください。'),
        h('div', { class: 'stats' },
          [['回答', stats.total], ['完了', stats.completed], ['進行中', stats.in_progress], ['平均所要', stats.avg_minutes == null ? '—' : stats.avg_minutes + '分']]
            .map(([l, v]) => h('div', { class: 'stat' }, h('span', { class: 'small muted' }, l), h('b', null, v)))),
        h('div', { class: 'card stack' }, h('div', { class: 'row between' }, h('h2', null, '回答用リンク'), Chip(open ? '受付中' : '停止中', open ? '' : 'gray')), LinkBox(answerUrl),
          h('div', { class: 'row' }, test, toggle)),
        stats.by_day.length ? h('div', { class: 'card stack' }, h('h3', null, '回答数の推移（日別）'),
          stats.by_day.map((d) => h('div', { class: 'row', style: 'flex-wrap:nowrap' }, h('span', { class: 'small muted', style: 'width:42px' }, d.day), h('div', { class: 'bar grow' }, h('i', { style: `width:${(d.count / maxDay) * 100}%` })), h('b', { class: 'small' }, d.count)))) : null,
        h('div', { class: 'card stack', style: 'border-color:var(--warn)' }, h('h3', null, '管理用リンク（このページのURL）'), LinkBox(adminUrl),
          h('p', { class: 'small muted' }, 'このリンクを知っている人は誰でも管理できます。サーバーには保存されないため、紛失した場合はサーバー管理者が `python server.py recover ' + iv.id + '` で再発行します（旧リンクは無効化）。')));
    },
    async questions() {
      return h('div', { class: 'stack' }, h('p', { class: 'muted' }, '編集は自動で保存されます。公開中でも変更できます（進行中の回答には次の質問から反映）。'), QuestionsEditor(iv, changed));
    },
    async responses() {
      const { sessions } = await api('GET', API('/sessions'));
      let filter = 'all';
      const list = h('div');
      const exp = (fmt) => h('a', { class: 'btn', href: `${BASE}/api${API('/export.' + fmt)}` }, fmt.toUpperCase());
      const label = { chat: '回答中', summary: '確認中', done: '完了' };
      function draw() {
        const rows = sessions.filter((s) => filter === 'all' ? !s.is_test : filter === 'test' ? s.is_test : !s.is_test && (filter === 'done' ? s.stage !== 'chat' : s.stage === 'chat'));
        list.replaceChildren(...(rows.length ? rows.map(row) : [h('p', { class: 'muted', style: 'padding:20px 4px' }, '該当する回答はありません。')]));
      }
      function row(s) {
        const detail = h('div', { hidden: true }); let loaded = false;
        const r = h('div', null, h('div', { class: 'list-row', tabindex: 0, role: 'button', onclick: toggle, onkeydown: (e) => (e.key === 'Enter') && toggle() },
          Chip('#' + s.ref, 'gray'), h('div', { class: 'grow' }, h('div', null, s.summary ? s.summary.summary.slice(0, 70) + (s.summary.summary.length > 70 ? '…' : '') : '（要約はまだありません）'),
            h('div', { class: 'small muted' }, `${fmtTime(s.started_at)} ・ 回答${s.answers}件`, s.summary && s.summary.tags.length ? ' ・ ' + s.summary.tags.join(' / ') : '')),
          s.is_test ? Chip('テスト', 'warn') : null, s.degraded ? Chip('AI停止中あり', 'warn') : null, Chip(label[s.stage], s.stage === 'chat' ? 'gray' : '')), detail);
        async function toggle() {
          detail.hidden = !detail.hidden; if (detail.hidden || loaded) return; loaded = true;
          try {
            const d = await api('GET', API('/sessions/' + s.ref));
            detail.replaceChildren(h('div', { class: 'card stack', style: 'margin:4px 0 10px' },
              d.summary ? h('div', null, h('b', null, '要約'), h('p', null, d.summary.summary), h('ul', null, d.summary.key_points.map((k) => h('li', null, k)))) : null,
              h('details', null, h('summary', { class: 'muted' }, '会話全文'), h('div', { class: 'transcript' }, d.messages.map((m) => h('div', { class: 'bubble ' + (m.role === 'assistant' ? 'ai' : 'me') }, m.text)))),
              h('div', { class: 'row' }, h('button', { class: 'danger', onclick: async () => { if (!confirm('この回答を削除します。元に戻せません。')) return; await api('DELETE', API('/sessions/' + s.ref)); sessions.splice(sessions.indexOf(s), 1); draw(); toast('削除しました'); } }, '削除'))));
          } catch (e) { loaded = false; toast(e.message, true); }
        }
        return r;
      }
      const filters = Segmented([['all', 'すべて'], ['done', '完了'], ['chat', '回答中'], ['test', 'テスト']], 'all', (k) => { filter = k; draw(); }, 'small');
      draw();
      return h('div', { class: 'stack' }, h('div', { class: 'row between' }, filters, h('div', { class: 'row' }, exp('csv'), exp('md'), exp('json'))), h('div', { class: 'card' }, list));
    },
    async report() {
      await refreshStats();
      let A = { questions: [], clusters: {} };
      try { A = await api('GET', API('/answers')); } catch (e) { toast(e.message, true); }
      const out = h('div', { class: 'stack' });
      const gen = h('button', { class: 'primary', onclick: async (e) => {
        const r = await busy(e.currentTarget, '作成中', () => runJob('POST', API('/report')));
        if (r) { iv.report = r; await refreshStats(); draw(); toast('レポートを更新しました'); }
      } }, iv.report ? 'レポートを再作成' : 'レポートを作成');
      const share = shareCard();
      function draw() {
        const rep = iv.report;
        const qs = A.questions.map((q, i) => ({ ...q, answered: stats.per_question[i] ? stats.per_question[i].answered : q.answers.length, clusters: A.clusters[q.id] || null }));
        out.replaceChildren(...[
          h('div', { class: 'row between' }, h('h2', null, 'レポート'), h('div', { class: 'row' }, rep ? h('button', { onclick: () => copy(reportText(rep), 'レポートをコピーしました') }, 'コピー') : null, gen)),
          h('div', { class: 'row small muted' }, `回答 ${stats.total}件 ／ 完了 ${stats.completed}件 ／ 完了率 ${stats.total ? Math.round((stats.completed / stats.total) * 100) : 0}%`),
          rep && rep.session_count < stats.completed ? h('div', { class: 'banner' }, `このレポートは${rep.session_count}人分です。新しい回答（計${stats.completed}人）を反映するには再作成してください。`) : null,
          ...(rep ? ReportBlocks(rep) : [h('div', { class: 'card muted' }, stats.completed ? '「レポートを作成」を押すと、回答全体の論点・引用・次のアクションをまとめます。' : 'まだ完了した回答がありません。回答が集まるとレポートを作成できます。')]),
          h('h2', { style: 'margin-top:22px' }, '質問ごとの回答'),
          QuestionSection({
            questions: qs, showAnswers: true,
            insight: (q) => { const p = rep && rep.per_question.find((x) => x.question_number === q.index + 1); return p ? p.insight : ''; },
            onCluster: async (q) => { const r = await runJob('POST', API('/cluster'), { qid: q.id }); A.clusters[q.id] = r; return r; },
          }),
          share].filter(Boolean));
      }
      draw();
      return out;
    },
    async settings() {
      const bind = (k, el) => { el.addEventListener('input', () => { iv[k] = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? +el.value : el.value); changed(); }); return el; };
      const F = (label, el, hint) => h('div', { class: 'field' }, h('label', { class: 'f' }, label), el, hint ? h('p', { class: 'small muted', style: 'margin-top:4px' }, hint) : null);
      return h('div', { class: 'stack' }, h('div', { class: 'card' },
        F('タイトル', bind('title', h('input', { value: iv.title }))),
        F('回答者への説明', bind('description', h('textarea', { value: iv.description, rows: 5 }))),
        h('div', { class: 'grid2' }, F('所要時間の目安（分）', bind('minutes', h('input', { type: 'number', min: 1, max: 120, value: iv.minutes }))),
          F('深掘りの上限（1質問あたり）', bind('max_followups', h('input', { type: 'number', min: 0, max: 5, value: iv.max_followups })), '0にすると事前定義の質問だけを順に聞きます。')),
        F('AIの口調', bind('tone', h('select', { value: iv.tone }, [['friendly', '親しみやすい'], ['neutral', '中立・簡潔'], ['formal', 'フォーマル']].map(([v, l]) => h('option', { value: v, selected: iv.tone === v }, l))))),
        F('背景知識（AIに与える前提情報）', bind('background', h('textarea', { value: iv.background, rows: 6, placeholder: '組織・製品・用語の説明など。回答者の認識が事実と異なる場合、AIが補足します。' }))),
        h('label', { class: 'row', style: 'margin-top:12px;cursor:pointer' }, bind('suggest', h('input', { type: 'checkbox', checked: !!iv.suggest, style: 'width:auto' })), 'AIが毎回の質問に回答候補を自動で出す（回答者はいつでも自由記述できます）'),
        h('label', { class: 'row', style: 'margin-top:12px;cursor:pointer' }, bind('public_prompt', h('input', { type: 'checkbox', checked: !!iv.public_prompt, style: 'width:auto' })), 'AIへの指示（プロンプト）を回答者に公開する（透明性のため推奨）')),
        h('div', { class: 'card stack' }, h('h3', null, 'プロンプトの確認'), h('p', { class: 'muted' }, 'AIインタビュアーに実際に渡される指示を確認できます。'), h('a', { class: 'btn', href: `${BASE}/a/${iv.id}/prompt`, target: '_blank' }, '開く')),
        h('div', { class: 'card stack', style: 'border-color:var(--danger)' }, h('h3', { class: 'danger' }, '危険な操作'),
          h('button', { class: 'danger', onclick: async () => { if (prompt(`このインタビューと全回答を完全に削除します。よろしければタイトル「${iv.title}」を入力してください。`) !== iv.title) return; await api('DELETE', API('/interview')); store.set('iv:mine', store.get('iv:mine', []).filter((m) => m.id !== iv.id)); location.href = BASE + '/'; } }, 'インタビューを削除')));
    },
  };
  function shareCard() {
    const box = h('div', { class: 'card stack' }); let wantAnswers = !!iv.share_answers;
    async function call(action, answers) {
      try { const r = await api('POST', API('/share'), { action, answers }); iv.share_token = r.share_token; iv.share_answers = r.share_answers; wantAnswers = !!r.share_answers; draw(); }
      catch (e) { toast(e.message, true); draw(); }
    }
    function draw() {
      const url = iv.share_token ? abs('/r/' + iv.share_token) : null;
      const chk = h('input', { type: 'checkbox', checked: wantAnswers, style: 'width:auto', onchange: (e) => { wantAnswers = e.target.checked; if (url) call('enable', wantAnswers); } });
      box.replaceChildren(...[
        h('div', { class: 'row between' }, h('h2', null, '結果の公表リンク'), Chip(url ? '公開中' : '未公開', url ? '' : 'gray')),
        h('p', { class: 'muted small' }, '集計結果を、ログイン不要で見られる閲覧専用ページとして公開できます。回答者ごとの会話全文は公開されません。'),
        url ? LinkBox(url) : null,
        h('label', { class: 'row', style: 'cursor:pointer;flex-wrap:nowrap;align-items:flex-start' }, chk, h('span', null, '回答の原文（匿名）と引用も表示する')),
        iv.report ? null : h('div', { class: 'banner' }, 'レポートが未作成です。公表ページには質問ごとの集計のみ表示されます。'),
        h('div', { class: 'row' }, url ? [
          h('button', { onclick: () => confirm('リンクを再発行します。古いリンクは無効になります。') && call('rotate', wantAnswers) }, 'リンクを再発行'),
          h('button', { class: 'danger', onclick: () => confirm('公表を停止します。リンクは無効になります。') && call('disable', wantAnswers) }, '公表を停止')]
          : h('button', { class: 'primary', onclick: () => call('enable', wantAnswers) }, '公表リンクを発行')),
      ].filter(Boolean));
    }
    draw();
    return box;
  }
  function reportText(rep) {
    return [rep.overview, '', ...rep.themes.flatMap((t) => [`■ ${t.title}（${t.mentions}人）`, t.description, ...t.quotes.map((q) => `「${q}」`), '']), '■ 次のアクション', ...rep.recommendations.map((x) => '・' + x)].join('\n');
  }
  mount(h('div', { class: 'page wide stack' }, head, h('div', { class: 'row between' }, h('h1', null, iv.title)), tabs, body));
  show(views[tab] ? tab : 'overview');
}

/* ───────── 回答画面 ───────── */
async function Respond(id) {
  topAct(null);
  mount(h('div', { class: 'page' }, h('p', { class: 'boot' }, '読み込み中…')));
  let info;
  try { info = await api('GET', '/a/' + id); }
  catch (e) { return mount(h('div', { class: 'page stack' }, Brand(), h('h1', null, 'ページが見つかりません'), h('div', { class: 'banner err' }, e.message))); }
  document.title = info.title;
  const KEY = 'iv:s:' + id;
  let sid = store.get(KEY, null);
  if (sid) {
    try { const r = await api('GET', '/s/' + sid); return chat(r.session); }
    catch (e) { if (e.status === 404) { store.del(KEY); sid = null; } }
  }
  intro();

  function intro() {
    const startBtn = h('button', { class: 'primary big', style: 'width:100%', disabled: info.status !== 'open' || !info.question_count, onclick: async (e) => {
      const s = await busy(e.currentTarget, '準備中…', () => api('POST', `/a/${id}/sessions`));
      if (s) { sid = s.id; store.set(KEY, sid); chat(s); }
    } }, 'インタビューを始める');
    mount(h('div', { class: 'page stack' },
      h('div', { class: 'hero' }, Brand(), h('h1', null, info.title)),
      h('div', { class: 'row' }, Chip(`約${info.minutes}分`), Chip(`${info.question_count}問`), Chip('AIが質問します')),
      info.description ? h('div', { class: 'card', style: 'white-space:pre-wrap' }, info.description) : null,
      info.status !== 'open' ? h('div', { class: 'banner' }, 'このインタビューは現在受付を停止しています。') : null,
      h('div', { class: 'card stack' }, h('h3', null, '始める前に'),
        h('ul', { class: 'muted', style: 'margin:0;padding-left:1.2rem' },
          h('li', null, '正解はありません。「わからない」も大切な回答です。'),
          h('li', null, '答えたくない質問は「スキップ」できます。'),
          h('li', null, '回答内容は、このインタビューの主催者に共有されます。'),
          h('li', null, 'AIは聞き間違い・思い込みをすることがあります。最後に要約を確認できます。'),
          h('li', null, '途中で閉じても、同じ端末・ブラウザで同じリンクを開けば続きから再開できます。'))),
      startBtn,
      info.public_prompt ? h('a', { class: 'small', href: `${BASE}/a/${id}/prompt`, style: 'text-align:center;display:block' }, 'AIインタビュアーへの指示（プロンプト）を見る') : null));
  }

  function chat(initial) {
    let S = initial, shown = 0, working = false, last = null, suggesting = false, picked = [];
    const KEY_D = 'iv:d:' + sid, suggestOn = info.suggest !== 0;
    const pref = store.get('iv:pref', { instant: false });
    const bar = h('i'), prog = h('span', { class: 'small muted', style: 'margin-left:auto' });
    const body = h('div', { class: 'chat-body', 'aria-live': 'polite' });
    const replies = h('div', { class: 'replies' });
    const input = h('textarea', { rows: 1, placeholder: '回答を入力（候補以外も入力できます）', 'aria-label': '回答', value: store.get(KEY_D, ''), oninput: (e) => { autosize(e.target); store.set(KEY_D, e.target.value); syncUi(); }, onkeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229 && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); sendBtn.click(); }
    } });
    const sendBtn = h('button', { class: 'primary icon', style: 'min-height:40px;min-width:48px', 'aria-label': '送信', onclick: () => submit() }, '送信');
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    let rec = null;
    const mic = SR ? h('button', { class: 'ghost icon', title: '音声で入力', 'aria-label': '音声入力', onclick: toggleMic }, '音声') : null;
    const polishBtn = h('button', { class: 'ghost icon', title: 'AIで文章を整える（意味は変えません）', hidden: true, onclick: doPolish }, '文章を整える');
    const mk = (label, title, fn) => h('button', { class: 'ghost', title, onclick: fn }, label);
    const skipBtn = mk('スキップ', 'この質問は答えない', () => send({ skip: true }));
    const rephBtn = mk('言い換えて', '質問をやさしく言い換えてもらう', doRephrase);
    const undoBtn = mk('直前の回答を修正', '直前の回答を取り消して書き直す', doUndo);
    const endBtn = mk('終了する', '', () => confirm('ここでインタビューを終了して、要約の確認に進みますか？') && send({ end: true }));
    const instBtn = h('button', { class: 'ghost', title: '候補をタップしたらすぐ送信するか切り替え', onclick: () => { pref.instant = !pref.instant; store.set('iv:pref', pref); syncUi(); toast(pref.instant ? '候補タップで即送信します' : '候補タップで入力欄に追加します'); } });
    const composer = h('div', { class: 'composer' }, h('div', { class: 'box' }, input, mic, polishBtn, sendBtn), h('div', { class: 'tools' }, skipBtn, rephBtn, undoBtn, instBtn, endBtn));
    const wrap = h('div', { class: 'chat' }, h('div', { class: 'chat-head' }, h('div', { class: 'row between' }, Brand(), prog), h('div', { class: 'bar', style: 'margin-top:8px' }, bar)), body, replies, composer);
    mount(wrap);
    queueMicrotask(() => autosize(input));

    const curReplies = () => {
      const lastAi = [...S.messages].reverse().find((m) => m.role === 'assistant' && m.kind !== 'summary');
      return S.stage === 'chat' && !working && S.messages[S.messages.length - 1].role === 'assistant' && lastAi ? (lastAi.quick_replies || []) : [];
    };
    function viaOf(text) {
      const used = picked.filter((c) => text.includes(c));
      return used.length ? (text.replace(/[、,\s]/g, '') === used.join('').replace(/[、,\s]/g, '') ? 'chip' : 'mixed') : 'typed';
    }
    function submit(textOverride) {
      const t = (textOverride ?? input.value).trim(); if (!t || working) return;
      const via = textOverride != null ? 'chip' : viaOf(t);
      input.value = ''; store.del(KEY_D); autosize(input); picked = [];
      send({ text: t, via });
    }
    function pick(c) {
      if (pref.instant) return submit(c);
      const parts = input.value.split('、').map((x) => x.trim()).filter(Boolean);
      if (picked.includes(c)) { picked = picked.filter((x) => x !== c); input.value = parts.filter((x) => x !== c).join('、'); }
      else { picked.push(c); input.value = [...parts, c].join('、'); }
      store.set(KEY_D, input.value); autosize(input); input.focus(); syncUi();
    }
    function drawReplies() {
      const list = curReplies(); const canMore = suggestOn && S.stage === 'chat' && !working;
      const nodes = list.map((r, i) => h('button', { class: picked.includes(r) ? 'on' : '', title: i < 9 ? `キー ${i + 1}` : '', onclick: () => pick(r) }, r));
      if (suggesting) nodes.push(h('span', { class: 'typing' }, h('span', { class: 'spinner' }), '候補を作成中'));
      if (S.stage === 'chat' && !working && S.messages[S.messages.length - 1].role === 'assistant') {
        ['わからない', '特にない'].forEach((r) => nodes.push(h('button', { class: 'soft', onclick: () => pick(r) }, r)));
        if (canMore && !suggesting) nodes.push(h('button', { class: 'soft', title: '別の候補を出す', onclick: () => fetchSuggest(true) }, '他の候補'));
      }
      replies.replaceChildren(...nodes);
    }
    async function fetchSuggest(more) {
      if (suggesting || !suggestOn) return; suggesting = true; drawReplies();
      const id = S.messages[S.messages.length - 1].id;
      try {
        const r = await runJob('POST', `/s/${sid}/suggest`, { exclude: more ? curReplies() : [] });
        const m = S.messages.find((x) => x.id === r.id); if (m) m.quick_replies = r.quick_replies;
        if (more) picked = [];
      } catch (e) { if (more) toast(e.message, true); }
      suggesting = false; if (S.messages[S.messages.length - 1].id === id || more) drawReplies();
    }
    function syncUi() {
      const t = input.value.trim();
      polishBtn.hidden = t.length < 12 || working;
      sendBtn.classList.toggle('ready', !!t);
      instBtn.textContent = pref.instant ? '即送信: ON' : '即送信: OFF';
      drawReplies();
    }
    function toggleMic() {
      if (rec) { rec.stop(); return; }
      rec = new SR(); rec.lang = 'ja-JP'; rec.interimResults = true; rec.continuous = true;
      const base = input.value; let fin = '';
      mic.textContent = '停止'; mic.classList.add('rec');
      rec.onresult = (ev) => {
        let interim = ''; for (const r of ev.results) { if (r.isFinal) fin += r[0].transcript; else interim += r[0].transcript; }
        input.value = base + (base && !/\s$/.test(base) ? ' ' : '') + fin + interim; autosize(input); store.set(KEY_D, input.value); syncUi();
      };
      rec.onerror = (ev) => { if (ev.error === 'not-allowed') toast('マイクの許可が必要です', true); };
      rec.onend = () => { rec = null; mic.textContent = '音声'; mic.classList.remove('rec'); input.focus(); };
      try { rec.start(); } catch { rec = null; }
    }
    async function doPolish(e) {
      const b = e.currentTarget, before = input.value;
      const r = await busy(b, '', () => runJob('POST', `/s/${sid}/polish`, { text: before }));
      if (r) { input.value = r.text; autosize(input); store.set(KEY_D, r.text); toast('整えました（送信前に確認・修正できます）'); input.focus(); syncUi(); }
    }
    async function doRephrase() {
      if (working) return; working = true; render();
      try { const r = await runJob('POST', `/s/${sid}/rephrase`); S = r.session; } catch (e) { toast(e.message, true); }
      working = false; render();
    }
    async function doUndo() {
      if (working) return;
      try {
        const r = await api('POST', `/s/${sid}/undo`); S = r.session; shown = S.messages.length; picked = [];
        if (r.removed) { input.value = r.removed; store.set(KEY_D, r.removed); autosize(input); }
        render(); input.focus(); toast('直前の回答を取り消しました。書き直せます');
      } catch (e) { toast(e.message, true); }
    }

    function typing(text) {
      const sec = h('span'); const t = h('div', { class: 'typing', id: 'typing' }, h('span', { class: 'spinner' }), text, sec);
      const t0 = Date.now(); t.timer = setInterval(() => { const s = Math.round((Date.now() - t0) / 1000); sec.textContent = s > 15 ? ` ${s}秒（モデルが大きいため少し時間がかかっています）` : ''; }, 1000);
      return t;
    }
    function render() {
      const done = S.stage === 'done', summary = S.stage === 'summary';
      body.replaceChildren(...S.messages.filter((m) => m.kind !== 'summary').map((m, i) => h('div', { class: `bubble ${m.role === 'assistant' ? 'ai' : 'me'}${m.text.startsWith('（') && m.role === 'user' ? ' sys' : ''}${i >= shown ? ' new' : ''}` }, m.text)));
      shown = S.messages.length;
      if (summary || done) body.append(summaryView());
      if (working) body.append(typing('回答を処理中'));
      const pct = S.stage === 'chat' ? ((S.progress.current - 1) / S.progress.total) * 100 : 100;
      bar.style.width = pct + '%';
      prog.textContent = S.stage === 'chat' ? `${S.progress.current} / ${S.progress.total} 問` : (done ? '完了' : '要約の確認');
      composer.hidden = S.stage !== 'chat';
      [skipBtn, endBtn, rephBtn, undoBtn].forEach((b) => { b.disabled = working; });
      undoBtn.disabled = working || !S.messages.some((m) => m.role === 'user');
      sendBtn.disabled = working;
      syncUi();
      // 候補が無い質問には、バックグラウンドで候補を作る
      if (S.stage === 'chat' && !working && !suggesting && suggestOn && S.messages[S.messages.length - 1].role === 'assistant' && !curReplies().length) fetchSuggest(false);
      requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
    }
    function summaryView() {
      const sm = S.summary || { summary: '', key_points: [] };
      if (S.stage === 'done') return h('div', { class: 'card stack', style: 'text-align:center' }, h('h2', null, 'ご協力ありがとうございました'), h('p', { class: 'muted' }, '回答を送信しました。このページは閉じて大丈夫です。'));
      const add = h('textarea', { rows: 2, placeholder: '補足や修正があれば入力（任意）', oninput: (e) => autosize(e.target) });
      const fin = h('button', { class: 'primary big', onclick: async (e) => {
        const r = await busy(e.currentTarget, '送信中…', async () => {
          if (add.value.trim()) await api('POST', `/s/${sid}/message`, { text: add.value.trim(), cid: rand() });
          return api('POST', `/s/${sid}/finish`);
        });
        if (r) { S = r.session; store.del(KEY_D); render(); }
      } }, 'この内容で送信して完了');
      const back = h('button', { onclick: doUndo }, '直前の回答を修正');
      return h('div', { class: 'summary-card stack' }, h('h3', null, '回答内容の要約'), h('p', { style: 'white-space:pre-wrap' }, sm.summary),
        sm.key_points.length ? h('ul', null, sm.key_points.map((k) => h('li', null, k))) : null, add, fin, back);
    }
    async function send(payload) {
      if (working) return;
      last = { ...payload, cid: payload.cid || rand() };
      S = { ...S, messages: [...S.messages, { role: 'user', text: payload.text || (payload.skip ? '（この質問はスキップしました）' : '（ここでインタビューを終了します）') }] };
      await run(() => api('POST', `/s/${sid}/message`, last));
    }
    async function run(start) {
      working = true; render();
      try {
        let r = await start();
        if (r.job) r = await pollJob(r.job);
        S = r.session;
      } catch (e) {
        working = false; render();
        const retry = h('button', { onclick: () => { err.remove(); last ? run(() => api('POST', `/s/${sid}/message`, last)) : run(() => api('POST', `/s/${sid}/resume`)); } }, '再送信');
        const err = h('div', { class: 'banner err row' }, h('span', { class: 'grow' }, e.message), retry);
        body.append(err); body.scrollTop = body.scrollHeight; return;
      }
      working = false; render();
    }
    addEventListener('keydown', (e) => {
      if (S.stage !== 'chat' || working || e.isComposing || input.value || e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^[1-9]$/.test(e.key) && document.activeElement === input || /^[1-9]$/.test(e.key) && document.activeElement === document.body) {
        const c = curReplies()[+e.key - 1]; if (c) { e.preventDefault(); pick(c); }
      }
    });
    render();
    if (S.pending) run(() => api('POST', `/s/${sid}/resume`));
  }
}

/* ───────── プロンプト開示 ───────── */
async function Prompt(id) {
  topAct(null);
  mount(h('div', { class: 'page' }, h('p', { class: 'boot' }, '読み込み中…')));
  try {
    const p = await api('GET', `/a/${id}/prompt`);
    const sec = (t, ...c) => h('section', { class: 'card stack' }, h('h2', null, t), ...c);
    const kv = (k, v) => h('div', null, h('div', { class: 'small muted' }, k), h('div', null, v));
    mount(h('div', { class: 'page stack' }, h('a', { href: `${BASE}/a/${id}` }, '戻る'), h('h1', null, 'プロンプト開示'),
      sec('透明性について', h('p', { class: 'muted' }, 'AIインタビュアーに与えている指示を公開しています。AIがどう振る舞うよう設定されているかを確認したうえで、安心して回答できます。')),
      sec('基本情報', kv('インタビュー名', p.title), kv('予定時間', p.minutes + '分'), kv('深掘りの上限', p.max_followups + '回/質問'), kv('使用モデル', h('code', null, p.model))),
      sec('共通システムプロンプト', h('p', { class: 'muted' }, '全てのインタビューで共通の振る舞いです。'), h('pre', { class: 'prompt' }, p.common_prompt)),
      sec('このインタビューの完全なプロンプト', h('pre', { class: 'prompt' }, p.full_prompt)),
      sec('質問リスト', p.questions.map((q, i) => h('div', null, h('b', null, `Q${i + 1}. ${q.text}`), q.guidance ? h('div', { class: 'small muted' }, '深掘り指針: ' + q.guidance) : null, q.quick_replies.length ? h('div', { class: 'small muted' }, '選択肢: ' + q.quick_replies.join(' / ')) : null)))));
  } catch (e) { mount(h('div', { class: 'page stack' }, Brand(), h('div', { class: 'banner err' }, e.message))); }
}

/* ───────── 結果の公表ページ ───────── */
async function Results(token) {
  topAct(null);
  mount(h('div', { class: 'page' }, h('p', { class: 'boot' }, '読み込み中…')));
  let d;
  try { d = await api('GET', '/r/' + token); }
  catch (e) { return mount(h('div', { class: 'page stack' }, h('h1', null, '表示できません'), h('div', { class: 'banner err' }, e.message))); }
  document.title = d.title + ' ｜ 結果';
  mount(h('div', { class: 'page stack' },
    h('div', null, h('p', { class: 'small muted' }, 'インタビュー結果'), h('h1', null, d.title)),
    d.description ? h('p', { class: 'muted prose' }, d.description) : null,
    h('div', { class: 'row' }, Chip(`回答 ${d.stats.total}件`), Chip(`完了 ${d.stats.completed}件`)),
    ...(d.report ? ReportBlocks(d.report, d.show_answers) : [h('div', { class: 'card muted' }, '全体レポートはまだ公開されていません。')]),
    h('h2', { style: 'margin-top:22px' }, '質問ごとの回答'),
    QuestionSection({
      questions: d.questions.map((q) => ({ ...q, id: String(q.index) })), showAnswers: d.show_answers,
      insight: (q) => { const p = d.report && d.report.per_question.find((x) => x.question_number === q.index + 1); return p ? p.insight : ''; },
    })));
}

/* ───────── ルーター ───────── */
(function route() {
  let p = location.pathname; if (BASE && p.startsWith(BASE)) p = p.slice(BASE.length);
  p = p.replace(/\/+$/, ''); let m;
  if (p === '') return Home();
  if ((m = p.match(/^\/a\/(\w+)$/))) return Respond(m[1]);
  if ((m = p.match(/^\/a\/(\w+)\/prompt$/))) return Prompt(m[1]);
  if ((m = p.match(/^\/m\/([\w-]+)$/))) return Admin(m[1]);
  if ((m = p.match(/^\/r\/([\w-]+)$/))) return Results(m[1]);
  mount(h('div', { class: 'page stack' }, Brand(), h('h1', null, 'ページが見つかりません'), h('a', { href: BASE + '/' }, 'トップへ')));
})();
})();

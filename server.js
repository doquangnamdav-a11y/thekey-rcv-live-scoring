// RCV Live Scoring — live on-stage scoring app for The Key's "Rung Chuông Vàng" event.
// Separate project from the existing RCV practice/review website.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parsePptx } = require('./pptx');

const PORT = process.env.PORT || 4100;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
// Mã quản trị CHỈ lấy từ biến môi trường ADMIN_KEY (Render: Environment). Không đặt → tự sinh mã ngẫu nhiên mỗi lần
// khởi động và in ra màn hình server (chỉ để chạy thử trên máy) — không bao giờ có mã mặc định trong code.
const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(12).toString('base64url');
if (!process.env.ADMIN_KEY && process.env.RENDER) throw new Error('Thiếu biến môi trường ADMIN_KEY trên Render');
if (!process.env.ADMIN_KEY) console.log(`[CHẠY THỬ] Chưa đặt ADMIN_KEY — mã quản trị lần này: ${ADMIN_KEY}`);
const rand = (n = 12) => crypto.randomBytes(n).toString('base64url');
// Ảnh câu hỏi + âm thanh lấy từ pptx: lưu cạnh data.json (KHÔNG nằm trong repo). Tên tệp ngẫu nhiên → không đoán được.
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(path.dirname(DATA_FILE), 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const TOTAL_STUDENTS = 100;
const CTV_COUNT = 10;
const STUDENTS_PER_CTV = TOTAL_STUDENTS / CTV_COUNT; // 10
const ROUND_QUESTIONS = 10; // per round
const ROUND_POINTS = { 1: 10, 2: 15 }; // total points per round
const POINT_PER_Q = { 1: ROUND_POINTS[1] / ROUND_QUESTIONS, 2: ROUND_POINTS[2] / ROUND_QUESTIONS };

function defaultData() {
  const ctvs = [];
  for (let i = 1; i <= CTV_COUNT; i++) {
    const start = (i - 1) * STUDENTS_PER_CTV + 1;
    const end = i * STUDENTS_PER_CTV;
    ctvs.push({ id: i, token: rand(9), start, end, name: `CTV ${i}` }); // mã ngẫu nhiên, Admin tạo lại được
  }
  const roster = {};
  for (let n = 1; n <= TOTAL_STUDENTS; n++) {
    roster[n] = { name: `Học sinh #${n}` };
  }
  return {
    ctvs,
    roster,
    state: { round: 1, question: 1, status: 'open' }, // status: open | closed | finished
    // marks[round][question][studentNumber] = true/false
    marks: {},
    // submitted[round][question] = { ctvId: true }
    submitted: {},
    // questions["round-question"] = { round, question, label, text, options: {A,B,C,D} | null, answer,
    //                                  image, seconds, sndPlay, sndAnswer }   (image/snd = tên tệp trong MEDIA_DIR)
    questions: {},
    rounds: {},          // { "1": { title: 'Vòng A', notes: '' } } — từ slide mở vòng
    endSound: null,
    screen: defaultScreen(),
    screenKey: rand(12), // mã xem màn chiếu + bảng xếp hạng + ảnh/âm thanh đề (Admin đổi được)
  };
}

function load() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
      console.error('Lỗi đọc data.json, dùng dữ liệu mặc định:', e.message);
    }
  }
  return defaultData();
}

// Màn chiếu đi theo đúng diễn biến slide: opener (mở vòng) → question (đề + ảnh + nút Play) → play (4 phương án +
// đếm ngược + nhạc) → answer (còn lại đáp án đúng / hiện đáp án mẫu) → câu tiếp; leaderboard; end (slide kết).
function defaultScreen() {
  return { step: 'opener', playAt: null, seconds: 10, defaultSeconds: 10, sound: { on: true, volume: 0.8 } };
}

let db = load();
if (!db.questions) db.questions = {}; // data.json cũ chưa có câu hỏi
if (!db.rounds) db.rounds = {};
if (!db.screen || !db.screen.step) db.screen = defaultScreen();
if (!db.screenKey) db.screenKey = rand(12);
for (const c of db.ctvs) if (/^ctv\d+$/.test(c.token)) c.token = rand(9); // data.json cũ: mã ctv1..ctv10 dễ đoán
function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 1), 'utf8');
}
save(); // ensure file exists

function ctvByToken(token) {
  return db.ctvs.find((c) => c.token === token);
}

function key(round, question) {
  return `${round}-${question}`;
}

function ensureMarkBucket(round, question) {
  const k = key(round, question);
  if (!db.marks[k]) db.marks[k] = {};
  if (!db.submitted[k]) db.submitted[k] = {};
  return k;
}

function computeTotals() {
  // totals[studentNumber] = sum of points across all rounds/questions marked correct
  const totals = {};
  for (let n = 1; n <= TOTAL_STUDENTS; n++) totals[n] = 0;
  for (const k of Object.keys(db.marks)) {
    const [roundStr] = k.split('-');
    const round = Number(roundStr);
    const pts = POINT_PER_Q[round] || 0;
    const bucket = db.marks[k];
    for (const [num, correct] of Object.entries(bucket)) {
      if (correct === true) totals[num] = (totals[num] || 0) + pts;
    }
  }
  return totals;
}

function leaderboardData() {
  const totals = computeTotals();
  const rows = Object.keys(db.roster).map((n) => ({
    number: Number(n),
    name: db.roster[n].name,
    score: Math.round((totals[n] || 0) * 100) / 100,
  }));
  rows.sort((a, b) => b.score - a.score || a.number - b.number);
  // assign rank with tie detection
  let rank = 0;
  let prevScore = null;
  let tieCount = 0;
  rows.forEach((r, idx) => {
    if (r.score !== prevScore) {
      rank = idx + 1;
      prevScore = r.score;
      tieCount = 0;
    } else {
      tieCount++;
    }
    r.rank = rank;
    r.tied = tieCount > 0 || (rows[idx + 1] && rows[idx + 1].score === r.score);
  });
  rows.forEach((r) => {
    r.topN = r.rank <= 30;
    r.top3 = r.rank <= 3;
  });
  return { rows, state: db.state };
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render đứng sau proxy: req.ip = IP thật (đếm thử sai mã)
app.use((req, res, next) => {
  // không cho Google lập chỉ mục, không cho trình duyệt/proxy giữ bản lưu (đề, đáp án, điểm)
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Khoá ----
function same(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const fails = new Map(); // ip -> [thời điểm thử sai]
const FAIL_MAX = 10, FAIL_WINDOW = 15 * 60 * 1000;
function tooMany(req) {
  const now = Date.now();
  const arr = (fails.get(req.ip) || []).filter((t) => now - t < FAIL_WINDOW);
  fails.set(req.ip, arr);
  return arr.length >= FAIL_MAX;
}
function failed(req) { (fails.get(req.ip) || fails.set(req.ip, []).get(req.ip)).push(Date.now()); }
function guard(check, msg) {
  return (req, res, next) => {
    if (tooMany(req)) return res.status(429).json({ error: 'Thử sai quá nhiều lần, chờ 15 phút' });
    if (!check(req)) { failed(req); return res.status(401).json({ error: msg }); }
    next();
  };
}
// màn chiếu / bảng xếp hạng / ảnh + âm thanh đề: mã màn chiếu (?k=) — Admin cũng xem được bằng mã quản trị
const screenKeyOf = (req) => req.query.k || req.headers['x-screen-key'];
const requireScreen = guard((req) => same(screenKeyOf(req), db.screenKey) || same(req.headers['x-admin-key'], ADMIN_KEY),
  'Cần mã màn chiếu');
app.use('/media', requireScreen, express.static(MEDIA_DIR, { setHeaders: (res) => res.set('Cache-Control', 'private, max-age=86400') }));

// ---- CTV endpoints ----
app.get('/api/ctv/:token', (req, res) => {
  const ctv = ctvByToken(req.params.token);
  if (!ctv) return res.status(404).json({ error: 'Link không hợp lệ' });
  const { round, question, status } = db.state;
  const k = key(round, question);
  const bucket = db.marks[k] || {};
  const students = [];
  for (let n = ctv.start; n <= ctv.end; n++) {
    students.push({ number: n, name: db.roster[n]?.name || `HS #${n}`, mark: bucket[n] ?? null });
  }
  const submitted = !!(db.submitted[k] && db.submitted[k][ctv.id]);
  res.json({ ctv: { id: ctv.id, name: ctv.name, start: ctv.start, end: ctv.end }, round, question, status, students, submitted });
});

app.post('/api/ctv/:token/mark', (req, res) => {
  const ctv = ctvByToken(req.params.token);
  if (!ctv) return res.status(404).json({ error: 'Link không hợp lệ' });
  if (db.state.status !== 'open') return res.status(409).json({ error: 'Câu hỏi hiện tại đã đóng, không sửa được nữa' });
  const { round, question } = db.state;
  const k = ensureMarkBucket(round, question);
  const marksIn = req.body.marks || {};
  for (const [numStr, val] of Object.entries(marksIn)) {
    const num = Number(numStr);
    if (num < ctv.start || num > ctv.end) continue; // ignore out-of-range tampering
    db.marks[k][num] = val === true;
  }
  const submit = req.body.submit === true;
  if (submit) db.submitted[k][ctv.id] = true;
  save();
  res.json({ ok: true, submitted: !!db.submitted[k][ctv.id] });
});

// ---- Câu hỏi + màn chiếu ----
// Định dạng dán: mỗi câu 1 dòng, các cột cách nhau bằng phím Tab (copy thẳng từ Excel) hoặc dấu |
//   Vòng | Câu | Đề bài | A | B | C | D | Đáp án
// Trắc nghiệm: điền đủ A–D, Đáp án là 1 chữ A/B/C/D. Tự luận/điền: để trống A–D, Đáp án ghi nội dung đúng.
function parseQuestions(text) {
  const rows = [];
  const errors = [];
  const seen = {};
  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.normalize('NFC');
    if (!line.trim()) return;
    const cells = (line.includes('\t') ? line.split('\t') : line.split('|')).map((c) => c.trim());
    const lineNo = i + 1;
    if (!/^\d+$/.test(cells[0] || '')) {
      if (rows.length === 0 && errors.length === 0 && /v[oò]ng/i.test(cells[0] || '')) return; // dòng tiêu đề
      errors.push(`Dòng ${lineNo}: cột đầu phải là số vòng (1 hoặc 2)`);
      return;
    }
    while (cells.length < 8) cells.push('');
    const round = Number(cells[0]);
    const question = Number(cells[1]);
    const [, , text, A, B, C, D] = cells;
    const answer = cells.slice(7).join(' ').trim();
    const opts = [A, B, C, D];
    const filled = opts.filter(Boolean).length;
    if (round !== 1 && round !== 2) return errors.push(`Dòng ${lineNo}: vòng phải là 1 hoặc 2`);
    if (!(question >= 1 && question <= ROUND_QUESTIONS)) return errors.push(`Dòng ${lineNo}: câu phải từ 1 đến ${ROUND_QUESTIONS}`);
    if (!text) return errors.push(`Dòng ${lineNo}: thiếu đề bài`);
    if (!answer) return errors.push(`Dòng ${lineNo}: thiếu đáp án`);
    if (filled > 0 && filled < 4) return errors.push(`Dòng ${lineNo}: câu trắc nghiệm phải có đủ 4 phương án A, B, C, D (câu tự luận thì để trống cả 4)`);
    if (filled === 4 && !/^[ABCD]$/i.test(answer)) return errors.push(`Dòng ${lineNo}: câu trắc nghiệm có đáp án là 1 chữ A, B, C hoặc D (đang ghi "${answer}")`);
    const k = key(round, question);
    if (seen[k]) return errors.push(`Dòng ${lineNo}: trùng Vòng ${round} Câu ${question} với dòng ${seen[k]}`);
    seen[k] = lineNo;
    rows.push({
      round, question, text,
      options: filled === 4 ? { A, B, C, D } : null,
      answer: filled === 4 ? answer.toUpperCase() : answer,
    });
  });
  const missing = [];
  for (const r of [1, 2]) for (let q = 1; q <= ROUND_QUESTIONS; q++) if (!seen[key(r, q)]) missing.push(`V${r}C${q}`);
  return { rows, errors, missing };
}

app.post('/api/admin/questions', requireAdmin, (req, res) => {
  // body: { text, save: bool } — save=false chỉ xem trước
  const out = parseQuestions(req.body.text);
  if (req.body.save === true) {
    if (out.errors.length) return res.status(400).json(out);
    db.questions = {};
    for (const q of out.rows) db.questions[key(q.round, q.question)] = { ...q, label: (q.round - 1) * ROUND_QUESTIONS + q.question };
    db.rounds = { 1: { title: 'Vòng 1', notes: '' }, 2: { title: 'Vòng 2', notes: '' } };
    cleanMedia();
    save();
    out.saved = out.rows.length;
  }
  res.json(out);
});

const STEPS = ['opener', 'question', 'play', 'answer', 'leaderboard', 'end'];
app.post('/api/admin/screen', requireAdmin, (req, res) => {
  // body: { step, seconds? }  — Play: bắt đầu đếm ngược (giây theo đề, Admin sửa được)
  const { step } = req.body;
  if (!STEPS.includes(step)) return res.status(400).json({ error: 'bước không hợp lệ' });
  const q = db.questions[key(db.state.round, db.state.question)];
  if (step === 'play') {
    const s = Math.round(Number(req.body.seconds));
    db.screen.seconds = s >= 1 && s <= 300 ? s : (q && q.seconds) || db.screen.defaultSeconds;
    db.screen.playAt = Date.now();
  } else if (step === 'question' || step === 'opener') {
    db.screen.playAt = null;
  }
  db.screen.step = step;
  save();
  res.json({ ok: true, screen: db.screen });
});

app.post('/api/admin/sound', requireAdmin, (req, res) => {
  // body: { on, volume (0..1), defaultSeconds }
  if (typeof req.body.on === 'boolean') db.screen.sound.on = req.body.on;
  const v = Number(req.body.volume);
  if (req.body.volume !== undefined && v >= 0 && v <= 1) db.screen.sound.volume = v;
  const d = Math.round(Number(req.body.defaultSeconds));
  if (d >= 1 && d <= 300) db.screen.defaultSeconds = d;
  save();
  res.json({ ok: true, screen: db.screen });
});

const media = (f) => (f ? `/media/${f}?k=${encodeURIComponent(db.screenKey)}` : null);
app.get('/api/screen', requireScreen, (req, res) => {
  // Màn chiếu chỉ nhận đúng những gì slide đang hiện: phương án từ bước Play; ĐÁP ÁN chỉ từ bước "Đáp án".
  const { round, question, status } = db.state;
  const q = db.questions[key(round, question)];
  const { step, playAt, seconds, sound } = db.screen;
  const out = { now: Date.now(), step, playAt, seconds, state: { round, question, status },
    round: db.rounds[round] || { title: `Vòng ${round}`, notes: '' }, q: null,
    sound: { on: sound.on, volume: sound.volume, end: media(db.endSound), play: null, answer: null },
    preload: [...new Set(Object.values(db.questions).flatMap((x) => [x.sndPlay, x.sndAnswer]).concat(db.endSound).filter(Boolean))].map(media) };
  if (q && ['question', 'play', 'answer'].includes(step)) {
    out.q = { label: q.label || question, text: q.text, image: media(q.image), kind: q.options ? 'mcq' : 'text' };
    if (step === 'play' || step === 'answer') {
      if (q.options) out.q.options = q.options;
      out.sound.play = media(q.sndPlay);
    }
    if (step === 'answer') {
      out.q.answer = q.answer;
      out.sound.answer = media(q.sndAnswer);
    }
  }
  res.json(out);
});

// ---- Nhập đề từ PowerPoint ----
const pending = {}; // mã xem trước -> { rounds, endSound } (đã ghi ảnh/âm vào MEDIA_DIR với tên ngẫu nhiên)
function storeMedia(buf, ext, prefix) {
  const name = `${prefix}-${crypto.randomBytes(12).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(MEDIA_DIR, name), buf);
  return name;
}
function cleanMedia() {
  // xoá tệp không còn dùng (bộ đề cũ, bản xem trước bỏ dở)
  const used = new Set(Object.values(db.questions).flatMap((q) => [q.image, q.sndPlay, q.sndAnswer]).concat(db.endSound));
  for (const p of Object.values(pending)) for (const f of p.files) used.add(f);
  for (const f of fs.readdirSync(MEDIA_DIR)) if (!used.has(f)) fs.rmSync(path.join(MEDIA_DIR, f), { force: true });
}

app.post('/api/admin/pptx', requireAdmin, express.raw({ type: 'application/octet-stream', limit: '120mb' }), (req, res) => {
  let parsed;
  try {
    parsed = parsePptx(req.body);
  } catch (e) {
    return res.status(400).json({ error: 'Không đọc được tệp — cần đúng tệp PowerPoint .pptx', detail: e.message });
  }
  const names = {};
  const files = [];
  const put = (p, prefix) => {
    if (!p) return null;
    if (!names[p]) { names[p] = storeMedia(parsed.media[p], path.extname(p).toLowerCase(), prefix); files.push(names[p]); }
    return names[p];
  };
  const rounds = parsed.rounds.map((r, i) => ({
    round: i + 1, title: r.title, notes: r.notes, slide: r.slide,
    questions: r.questions.map((q, j) => ({ round: i + 1, question: j + 1, label: q.label, slide: q.slide, text: q.text,
      options: q.options, answer: q.answer || '', seconds: q.seconds, nameMismatch: q.nameMismatch || null,
      image: put(q.image, 'img'), sndPlay: put(q.sndPlay, 'snd'), sndAnswer: put(q.sndAnswer, 'snd') })),
  }));
  const token = crypto.randomBytes(8).toString('hex');
  for (const k of Object.keys(pending)) delete pending[k]; // chỉ giữ 1 bản xem trước
  pending[token] = { rounds, endSound: put(parsed.endSound, 'snd'), files };
  cleanMedia();
  const warnings = [];
  rounds.forEach((r) => r.questions.forEach((q) => {
    if (q.nameMismatch) warnings.push(`Slide ${q.slide} (Câu số ${q.label}): hình tên "dap an dung" là ${q.nameMismatch}, nhưng khi bấm Đáp án slide giữ lại ${q.answer} → lấy ${q.answer}`);
  }));
  const labels = {};
  rounds.forEach((r) => r.questions.forEach((q) => { (labels[q.label] = labels[q.label] || []).push(q.slide); }));
  for (const [l, s] of Object.entries(labels)) if (s.length > 1) warnings.push(`"Câu số ${l}" xuất hiện ở ${s.length} slide (${s.join(', ')})`);
  res.json({ token, rounds, endSound: !!parsed.endSound, errors: parsed.errors, warnings,
    count: rounds.reduce((a, r) => a + r.questions.length, 0) });
});

app.post('/api/admin/pptx/commit', requireAdmin, (req, res) => {
  const p = pending[req.body.token];
  if (!p) return res.status(404).json({ error: 'Bản xem trước đã hết hạn — chọn lại tệp' });
  db.questions = {};
  db.rounds = {};
  for (const r of p.rounds) {
    db.rounds[r.round] = { title: r.title, notes: r.notes };
    for (const q of r.questions) {
      const { nameMismatch, slide, ...keep } = q;
      db.questions[key(q.round, q.question)] = keep;
    }
  }
  db.endSound = p.endSound;
  delete pending[req.body.token];
  db.state = { round: 1, question: 1, status: 'open' };
  db.screen.step = 'opener';
  db.screen.playAt = null;
  cleanMedia();
  save();
  res.json({ ok: true, count: Object.keys(db.questions).length, rounds: p.rounds.length });
});

// ---- Leaderboard ----
app.get('/api/leaderboard', requireScreen, (req, res) => {
  res.json(leaderboardData());
});

// ---- Admin ----
// khai báo dạng function để các route phía trên dùng được (hoisting)
function requireAdmin(req, res, next) {
  return requireAdminGuard(req, res, next);
}
const requireAdminGuard = guard((req) => same(req.headers['x-admin-key'], ADMIN_KEY), 'Sai mã quản trị');

app.post('/api/admin/keys', requireAdmin, (req, res) => {
  // body: { what: 'screen' | 'ctv' } — tạo lại mã: link cũ hết hiệu lực ngay
  if (req.body.what === 'screen') db.screenKey = rand(12);
  else if (req.body.what === 'ctv') for (const c of db.ctvs) c.token = rand(9);
  else return res.status(400).json({ error: 'what không hợp lệ' });
  save();
  res.json({ ok: true });
});

app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const { round, question, status } = db.state;
  const k = key(round, question);
  const submitted = db.submitted[k] || {};
  const ctvStatus = db.ctvs.map((c) => ({ id: c.id, name: c.name, range: `${c.start}-${c.end}`, submitted: !!submitted[c.id], token: c.token }));
  const submittedCount = ctvStatus.filter((c) => c.submitted).length;
  const q = db.questions[k] || null;
  res.json({ round, question, status, ctvStatus, submittedCount, totalCtv: db.ctvs.length, screenKey: db.screenKey,
    screen: db.screen, currentQuestion: q, questionCount: Object.keys(db.questions).length,
    roundTitle: (db.rounds[round] || {}).title || `Vòng ${round}`, roundCount: Object.keys(db.rounds).length || 2 });
});

app.post('/api/admin/roster', requireAdmin, (req, res) => {
  // body: { rows: [{number, name}, ...] }
  const rows = req.body.rows || [];
  for (const r of rows) {
    const n = Number(r.number);
    if (n >= 1 && n <= TOTAL_STUDENTS && r.name) {
      db.roster[n] = { name: String(r.name).trim() };
    }
  }
  save();
  res.json({ ok: true, count: rows.length });
});

app.post('/api/admin/advance', requireAdmin, (req, res) => {
  // action: 'close' (close current question for grading), 'next' (move to next question/round), 'reopen'
  const { action } = req.body;
  if (action === 'close') {
    db.state.status = 'closed';
  } else if (action === 'reopen') {
    db.state.status = 'open';
  } else if (action === 'next') {
    let { round, question } = db.state;
    const hasQ = Object.keys(db.questions).length > 0;
    const exists = (r, q) => (hasQ ? !!db.questions[key(r, q)] : r <= 2 && q <= ROUND_QUESTIONS);
    if (exists(round, question + 1)) {
      question += 1;
    } else if (exists(round + 1, 1)) {
      round += 1;
      question = 1;
    } else {
      db.state.status = 'finished';
      save();
      return res.json({ ok: true, state: db.state });
    }
    const newRound = round !== db.state.round;
    db.state = { round, question, status: 'open' };
    // sang câu mới: màn chiếu về bước "đề" (KHÔNG lộ phương án/đáp án câu mới); sang vòng mới thì về slide mở vòng
    db.screen.step = newRound ? 'opener' : 'question';
    db.screen.playAt = null;
  } else {
    return res.status(400).json({ error: 'action không hợp lệ' });
  }
  save();
  res.json({ ok: true, state: db.state });
});

app.post('/api/admin/correct', requireAdmin, (req, res) => {
  // body: { round, question, number, value }
  const { round, question, number, value } = req.body;
  const k = ensureMarkBucket(round, question);
  db.marks[k][number] = value === true;
  save();
  res.json({ ok: true });
});

app.post('/api/admin/reset', requireAdmin, (req, res) => {
  const keep = { questions: db.questions, rounds: db.rounds, endSound: db.endSound, sound: db.screen.sound,
    defaultSeconds: db.screen.defaultSeconds, screenKey: db.screenKey, tokens: db.ctvs.map((c) => c.token) };
  // giữ bộ đề đã nhập + các link (mã màn chiếu, mã CTV): reset chỉ để xoá điểm thử
  db = defaultData();
  Object.assign(db, { questions: keep.questions, rounds: keep.rounds, endSound: keep.endSound, screenKey: keep.screenKey });
  db.ctvs.forEach((c, i) => { c.token = keep.tokens[i] || c.token; });
  Object.assign(db.screen, { sound: keep.sound, defaultSeconds: keep.defaultSeconds });
  save();
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`RCV live scoring server chạy tại http://localhost:${PORT}`);
});

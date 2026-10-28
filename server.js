// RCV Live Scoring — live on-stage scoring app for The Key's "Rung Chuông Vàng" event.
// Separate project from the existing RCV practice/review website.
const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 4100;
const DATA_FILE = path.join(__dirname, 'data.json');
const ADMIN_KEY = process.env.ADMIN_KEY || 'thekey-admin';

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
    ctvs.push({ id: i, token: `ctv${i}`, start, end, name: `CTV ${i}` });
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

let db = load();
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
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

// ---- Leaderboard ----
app.get('/api/leaderboard', (req, res) => {
  res.json(leaderboardData());
});

// ---- Admin ----
function requireAdmin(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'Sai mã quản trị' });
  next();
}

app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const { round, question, status } = db.state;
  const k = key(round, question);
  const submitted = db.submitted[k] || {};
  const ctvStatus = db.ctvs.map((c) => ({ id: c.id, name: c.name, range: `${c.start}-${c.end}`, submitted: !!submitted[c.id] }));
  const submittedCount = ctvStatus.filter((c) => c.submitted).length;
  res.json({ round, question, status, ctvStatus, submittedCount, totalCtv: db.ctvs.length });
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
    if (question < ROUND_QUESTIONS) {
      question += 1;
    } else if (round < 2) {
      round += 1;
      question = 1;
    } else {
      db.state.status = 'finished';
      save();
      return res.json({ ok: true, state: db.state });
    }
    db.state = { round, question, status: 'open' };
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
  db = defaultData();
  save();
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`RCV live scoring server chạy tại http://localhost:${PORT}`);
});

// Đọc bộ đề Rung Chuông Vàng từ file .pptx (đúng khuôn slide của trung tâm), không cần PowerPoint.
// Slide MỞ VÒNG: có chữ "RUNG CHUÔNG VÀNG" + "Vòng A/B/C…"  → bắt đầu vòng mới.
// Slide CÂU: có "Câu số N". Trắc nghiệm: 4 hình chữ "A. …" … "D. …"; đáp án đúng = hình tên "dap an dung"/"đáp án đúng".
//   Tự luận: không có A–D; đáp án mẫu = hình xuất hiện khi bấm nút "dap an" (hiệu ứng trong slide).
//   Số giây đếm = số lớn nhất trong các ô số đếm ngược. Âm thanh: âm gắn hiệu ứng khi bấm Play (nhạc đếm) và khi bấm
//   Đáp án (nếu có). Ảnh minh hoạ = ảnh lớn nhất trên slide trừ nút Play/Đáp án/Next và vòng hoa bay vào.
// Slide CUỐI: không có "Câu số"/"Vòng" nhưng có âm thanh → âm kết.
const AdmZip = require('adm-zip');
const path = require('path');

const fold = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
  .toLowerCase().replace(/\s+/g, ' ').trim();
const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const DECOR = new Set(['play', 'next', 'dap an']);

function rels(zip, file) {
  const p = path.posix.join(path.posix.dirname(file), '_rels', path.posix.basename(file) + '.rels');
  const e = zip.getEntry(p);
  const out = {};
  if (!e) return out;
  const x = e.getData().toString('utf8');
  for (const m of x.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = (m[0].match(/Id="([^"]+)"/) || [])[1];
    const t = (m[0].match(/Target="([^"]+)"/) || [])[1];
    if (id && t) out[id] = path.posix.normalize(path.posix.join(path.posix.dirname(file), t));
  }
  return out;
}

function shapes(x) {
  const out = [];
  for (const m of x.matchAll(/<p:(sp|pic)>([\s\S]*?)<\/p:\1>/g)) {
    const s = m[2];
    const id = (s.match(/<p:cNvPr id="(\d+)"/) || [])[1];
    const name = unxml((s.match(/<p:cNvPr id="\d+" name="([^"]*)"/) || [])[1] || '');
    const paras = [];
    for (const p of s.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)) {
      const t = [...p[1].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((r) => unxml(r[1])).join('');
      if (t.trim()) paras.push(t.replace(/\t/g, ' ').replace(/\s+/g, ' ').trim());
    }
    const ext = s.match(/<a:ext cx="(\d+)" cy="(\d+)"/);
    out.push({
      id, name, key: fold(name), text: paras.join('\n').normalize('NFC'),
      blip: (s.match(/<a:blip r:embed="(rId\d+)"/) || [])[1] || null,
      area: ext ? Number(ext[1]) * Number(ext[2]) : 0,
    });
  }
  return out;
}

// Chuỗi hiệu ứng tương tác: mỗi khối "interactiveSeq" kích hoạt khi bấm 1 hình (play / dap an)
function interactive(x, byId) {
  const t = x.slice(x.indexOf('<p:timing') >= 0 ? x.indexOf('<p:timing') : x.length);
  const starts = [...t.matchAll(/nodeType="interactiveSeq"/g)].map((m) => m.index);
  const out = [];
  starts.forEach((st, i) => {
    const seg = t.slice(st, i + 1 < starts.length ? starts[i + 1] : t.length);
    const trig = [...seg.matchAll(/evt="onClick"[\s\S]*?<p:spTgt spid="(\d+)"/g)].map((m) => byId[m[1]]).filter(Boolean);
    const trigger = trig.length ? trig[trig.length - 1].key : null;
    const sounds = [...seg.matchAll(/<p:sndTgt r:embed="(rId\d+)"/g)].map((m) => m[1]);
    const entr = [], path = [], exit = [];
    for (const m of seg.matchAll(/presetClass="(entr|path|exit)"[\s\S]*?<p:spTgt spid="(\d+)"/g)) ({ entr, path, exit })[m[1]].push(m[2]);
    out.push({ trigger, sounds, entr, path, exit });
  });
  return out;
}

function slideOrder(zip) {
  const pres = 'ppt/presentation.xml';
  const r = rels(zip, pres);
  const x = zip.getEntry(pres).getData().toString('utf8');
  return [...x.matchAll(/<p:sldId [^>]*r:id="(rId\d+)"/g)].map((m) => r[m[1]]).filter(Boolean);
}

function parsePptx(buf) {
  const zip = new AdmZip(buf);
  const media = {};          // tên trong zip -> Buffer (chỉ những tệp dùng tới)
  const take = (p) => { if (p && !media[p]) { const e = zip.getEntry(p); if (e) media[p] = e.getData(); } return p; };
  const rounds = [];         // [{title, notes, slide, questions: [...]}]  (slide THẦY CÔ CỨU TRỢ / trống: bỏ qua)
  const errors = [];
  let endSound = null;
  slideOrder(zip).forEach((file, idx) => {
    const n = idx + 1;
    const x = zip.getEntry(file).getData().toString('utf8');
    const r = rels(zip, file);
    const sh = shapes(x);
    const byId = Object.fromEntries(sh.map((s) => [s.id, s]));
    const all = sh.map((s) => s.text).join('\n');
    const cau = sh.find((s) => /^C[âa]u s[ốo]\s*\d+/i.test(s.text));
    const vong = all.match(/V[òo]ng\s+([^\n]+)/);
    const seq = interactive(x, byId);
    const playSeq = seq.find((q) => q.trigger === 'play');
    const ansSeq = seq.find((q) => q.trigger === 'dap an');
    const lines = sh.map((s) => s.text).filter((t) => t && !/^H[ỆE] TH[ỐO]NG/i.test(t));
    const isOpener = !cau && vong && /RUNG CHU[ÔO]NG V[ÀA]NG/i.test(all);
    const isExtra = !cau && lines.length === 1 && /^C[âa]u h[ỏo]i ph[ụu]$/i.test(lines[0]);   // slide ngăn "Câu hỏi phụ"
    if (isOpener || isExtra) {
      const title = isOpener ? `Vòng ${vong[1].trim()}` : lines[0];
      const notes = lines.filter((t) => !/^(H[ộo]i thi|RUNG CHU|H[ỆE] TH[ỐO]NG|V[òo]ng\s)/i.test(t) && t !== title)
        .map((t) => t.replace(/👉\s*/g, '• ')).join('\n');
      rounds.push({ title, notes, slide: n, questions: [] });
      return;
    }
    if (!cau) {
      const snd = [...x.matchAll(/<p:sndTgt r:embed="(rId\d+)"/g)].map((m) => r[m[1]]);
      if (snd.length && !rounds.length) return;
      if (snd.length) endSound = take(snd[0]);
      return;
    }
    if (!rounds.length) rounds.push({ title: 'Vòng A', notes: '', slide: 0, questions: [] });
    const label = Number(cau.text.match(/\d+/)[0]);
    const digits = sh.filter((s) => s !== cau && /^\d{1,3}$/.test(s.text)).map((s) => Number(s.text));
    const seconds = digits.length ? Math.max(...digits) : null;
    const optShapes = sh.map((s) => ({ s, m: s.text.match(/^([A-D])\s*[.)]\s*([\s\S]+)$/) })).filter((o) => o.m);
    const reveal = new Set(ansSeq ? ansSeq.entr.filter((id) => byId[id] && !DECOR.has(byId[id].key)) : []);
    const flying = new Set(playSeq ? playSeq.path : []);
    const used = new Set([cau.id, ...optShapes.map((o) => o.s.id), ...reveal]);
    const textShapes = sh.filter((s) => s.text && !used.has(s.id) && !/^\d{1,3}$/.test(s.text) && !DECOR.has(s.key));
    const text = textShapes.map((s) => s.text).join('\n').trim();
    const pics = sh.filter((s) => s.blip && !s.text && !DECOR.has(s.key) && !flying.has(s.id) && !reveal.has(s.id) && r[s.blip]
      && /\.(png|jpe?g|gif|webp)$/i.test(r[s.blip]));
    pics.sort((a, b) => b.area - a.area);
    const q = { label, slide: n, text, seconds, image: pics.length ? take(r[pics[0].blip]) : null,
      sndPlay: playSeq && playSeq.sounds.length ? take(r[playSeq.sounds[0]]) : null,
      sndAnswer: ansSeq && ansSeq.sounds.length ? take(r[ansSeq.sounds[0]]) : null };
    if (optShapes.length) {
      q.options = {};
      for (const o of optShapes) q.options[o.m[1]] = o.m[2].replace(/\s+/g, ' ').trim();
      // Đáp án đúng = phương án CÒN LẠI khi bấm "Đáp án" (3 phương án sai có hiệu ứng biến mất) — đúng như trình chiếu.
      // Tên hình "dap an dung" trong bộ đề mẫu nhiều slide đặt nhầm, chỉ dùng khi slide không có hiệu ứng biến mất.
      const exits = new Set(ansSeq ? ansSeq.exit : []);
      const stay = optShapes.filter((o) => !exits.has(o.s.id));
      const named = optShapes.filter((o) => o.s.key === 'dap an dung');
      if (Object.keys(q.options).length !== 4) errors.push(`Slide ${n} (Câu số ${label}): không đủ 4 phương án A–D`);
      if (stay.length === 1) q.answer = stay[0].m[1];
      else if (named.length === 1 && !exits.size) q.answer = named[0].m[1];
      else errors.push(`Slide ${n} (Câu số ${label}): không xác định được đáp án đúng (hiệu ứng "Đáp án" phải làm biến mất đúng 3 phương án sai)`);
      if (q.answer && named.length === 1 && named[0].m[1] !== q.answer) q.nameMismatch = named[0].m[1];
    } else {
      q.options = null;
      q.answer = [...reveal].map((id) => byId[id].text).filter(Boolean).join('\n');
      if (!q.answer) errors.push(`Slide ${n} (Câu số ${label}): câu tự luận chưa có ô đáp án hiện khi bấm "Đáp án"`);
    }
    if (!text) errors.push(`Slide ${n} (Câu số ${label}): không đọc được đề bài`);
    rounds[rounds.length - 1].questions.push(q);
  });
  return { rounds: rounds.filter((r) => r.questions.length), endSound, media, errors };
}

module.exports = { parsePptx, fold };

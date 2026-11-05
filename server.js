// ============================================================================
// CỔNG VŨ TRỤ CỦA THẦN RA — TikTok Live Tarot (Bun.js + JSON-RPC 2.0 + ZeroTTS)
// ============================================================================
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { TikTokLiveConnection, WebcastEvent, ControlEvent } = require('tiktok-live-connector');

const ROOT = __dirname;
const { Intelligence, clean } = require('./lib/intelligence');
const intelligence = new Intelligence(ROOT);
const questions = new Map();
const history = [];
let readingSerial = 0;
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(ROOT, 'data');
const TTS_CACHE_DIR = path.join(DATA_DIR, 'tts-cache');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const DECK_FILE = path.join(DATA_DIR, 'cards.json');
fs.mkdirSync(TTS_CACHE_DIR, { recursive: true });

if (!fs.existsSync(DECK_FILE)) {
  console.error('Chưa có data/cards.json — chạy "node tools/build-deck.mjs" trước.');
  process.exit(1);
}
const DECK = JSON.parse(fs.readFileSync(DECK_FILE, 'utf8')).cards;

// ---- Bộ lọc spam / ký tự lạ (kế thừa từ dự án Chùa Online) ----
const WEIRD_SPAM_RE = /[\u{12000}-\u{1254F}\uFDFD\u2800-\u28FF\u2580-\u259F]|[\u0300-\u036F]{3,}/u;
const BRACKET_EMOTE_RE = /\[[^\]]{1,24}\]/g;
const ALLOWED_VI_TEXT_RE = /[^0-9a-zA-ZÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚÝàáâãèéêìíòóôõùúýĂăĐđĨĩŨũƠơƯưẠ-ỹ\s.,!?]/g;
const ALLOWED_VI_NAME_RE = /[^0-9a-zA-ZÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚÝàáâãèéêìíòóôõùúýĂăĐđĨĩŨũƠơƯưẠ-ỹ\s._-]/g;
const VI_LETTER_RE = /[a-zA-ZÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚÝàáâãèéêìíòóôõùúýĂăĐđĨĩŨũƠơƯưẠ-ỹ]/g;
const BAD_WORDS_RE = /(đá dái|địt|lồn|cặc|đm|vcl|vl|yamate|i cư|lừa đảo|lừa à|te-le gram|telegram|bố là trùm)/i;

function isBlockedSpamOrToxic(raw) {
  if (!raw) return true;
  const s = String(raw);
  return WEIRD_SPAM_RE.test(s) || BAD_WORDS_RE.test(s);
}
function sanitizeUserName(rawName) {
  const n = String(rawName || '').normalize('NFKC').normalize('NFC').replace(BRACKET_EMOTE_RE, ' ')
    .replace(ALLOWED_VI_NAME_RE, ' ').replace(/(.)\1{3,}/gi, '$1$1').replace(/\s+/g, ' ').trim().slice(0, 22);
  if (!n || BAD_WORDS_RE.test(n) || (n.match(VI_LETTER_RE) || []).length < 2) return 'Lữ Khách';
  return n;
}
function sanitizeWishText(rawWish) {
  if (!rawWish) return '';
  const c = String(rawWish).normalize('NFKC').normalize('NFC').replace(BRACKET_EMOTE_RE, ' ')
    .replace(ALLOWED_VI_TEXT_RE, ' ').replace(/([.,!?])\1+/g, '$1').replace(/(.)\1{2,}/gi, '$1$1')
    .replace(/\s+/g, ' ').replace(/^[.,!?\s-]+|[.,!?\s-]+$/g, '').slice(0, 120);
  if (!c || BAD_WORDS_RE.test(c) || (c.match(VI_LETTER_RE) || []).length < 2) return '';
  return c;
}
const stripVN = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().trim();

class ZeroTTSManager {
  constructor() {
    this.proc = null;
    this.ready = false;
    this.status = 'starting';
    this.voice = 'maichi';
    this.voices = ['maichi'];
    this.model = 'zeroweight-ai/ZeroTTS';
    this.pending = new Map();
    this.inflight = new Map();
    this.reqCounter = 0;
    this.buffer = '';
    if (process.env.RA_ENABLE_ZEROTTS === '1') this.startWorker(); else this.status = 'disabled';
  }

  resolvePythonBin() {
    const cands = [path.join(ROOT, '.venv', 'Scripts', 'python.exe'), path.join(ROOT, '.venv', 'bin', 'python')];  // Windows | macOS/Linux
    for (const c of cands) if (fs.existsSync(c)) return c;
    return process.platform === 'win32' ? 'python' : 'python3';
  }

  startWorker() {
    const pyBin = this.resolvePythonBin();
    const scriptPath = path.join(ROOT, 'tts_worker.py');
    console.log(`[ZeroTTS] Khởi chạy worker với ${pyBin} (Giọng mặc định: Mai Chi)...`);

    this.status = 'loading';
    this.proc = spawn(pyBin, [scriptPath], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      let lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        this.handleWorkerLine(line.trim());
      }
    });

    this.proc.stderr.on('data', (chunk) => {
      const msg = chunk.toString('utf8').trim();
      if (msg) console.log(`[ZeroTTS stderr] ${msg}`);
    });

    this.proc.on('error', (err) => { this.ready = false; this.status = 'unavailable'; console.warn('[ZeroTTS]', err.message); });
    this.proc.on('exit', (code) => {
      console.warn(`[ZeroTTS] Worker thoát với mã ${code}`);
      this.ready = false;
      this.status = 'stopped';
      for (const [, item] of this.pending) {
        clearTimeout(item.timer);
        item.resolve({ ok: false, error: 'ZeroTTS worker exited' });
      }
      this.pending.clear();
    });
  }

  handleWorkerLine(line) {
    try {
      const msg = JSON.parse(line);
      if (msg.type === 'status') {
        this.status = msg.status;
        this.model = msg.model || this.model;
        broadcastNotification('tts.status', this.getStatus());
      } else if (msg.type === 'ready') {
        this.ready = true;
        this.status = 'ready';
        this.voice = msg.voice || 'maichi';
        this.voices = msg.voices || ['maichi'];
        this.model = msg.model || this.model;
        console.log(`[ZeroTTS] Sẵn sàng sau ${msg.loadSec}s! Giọng: ${this.voice} (${this.voices.join(', ')})`);
        broadcastNotification('tts.status', this.getStatus());
      } else if (msg.type === 'result' && msg.id != null) {
        const entry = this.pending.get(msg.id);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(msg.id);
          entry.resolve(msg);
        }
      } else if (msg.type === 'error') {
        console.error('[ZeroTTS Error]', msg.error);
        this.status = 'error';
        broadcastNotification('tts.status', this.getStatus());
      }
    } catch (err) {
      console.log('[ZeroTTS stdout]', line);
    }
  }

  getStatus() {
    return {
      ready: this.ready,
      status: this.status,
      engine: 'ZeroTTS (zeroweight-ai/ZeroTTS)',
      voice: state.settings.ttsVoice || this.voice || 'maichi',
      voices: this.voices,
      model: this.model
    };
  }

  synthesize(text, voiceOverride) {
    const cleanText = String(text || '').trim();
    if (!cleanText) return Promise.resolve({ ok: false, error: 'Empty text' });
    const voice = (voiceOverride || state.settings.ttsVoice || 'maichi').toLowerCase();
    const dedupKey = `${voice}::${cleanText}`;

    if (this.inflight.has(dedupKey)) {
      return this.inflight.get(dedupKey);
    }

    const promise = new Promise((resolve) => {
      if (!this.proc || !this.ready) {
        return resolve({ ok: false, error: `ZeroTTS đang ở trạng thái: ${this.status}` });
      }
      const id = ++this.reqCounter;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: 'ZeroTTS synthesis timeout' });
      }, 120000);

      this.pending.set(id, { resolve, timer });
      const payload = JSON.stringify({ id, text: cleanText, voice }) + '\n';
      this.proc.stdin.write(payload);
    }).finally(() => {
      this.inflight.delete(dedupKey);
    });

    this.inflight.set(dedupKey, promise);
    return promise;
  }
}

// ============================================================================
// 3. TRẠNG THÁI & HÀNG CHỜ HAI SẢNH
// ============================================================================
const DEFAULT_SETTINGS = {
  paused: false, aiEnabled: false, aiModel: 'gpt-4.1-mini', voiceProvider: 'browser', aiVoice: 'marin', voiceStyle: 'warm', voiceRate: 1, browserVoice: '', musicUrl: '', musicName: '', musicPlaying: true,
  ttsEnabled: true, ttsVoice: 'maichi', musicVolume: 0.35, ttsVolume: 0.95,
  lobbyCards: 1,          // số lá cho người đọc bài từ sảnh (không tặng quà)
  repeatAfterMin: 20,     // người đã được đọc, sau bấy nhiêu phút mới được vào sảnh đọc miễn phí lần nữa
  doneSlots: 3,           // số chỗ "người đã được đọc bài" mỗi bên chân thần Ra
  autoSim: false, autoSimIntervalMs: 2600,
};
const state = {
  settings: { ...DEFAULT_SETTINGS },
  stats: { readings: 0, cards: 0, prayers: 0, likes: 0, gifts: 0, coins: 0 },
  tiktok: { connected: false, connecting: false, username: '', roomId: null, viewerCount: 0, lastError: null },
};
function loadState() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    Object.assign(state.settings, j.settings || {}); Object.assign(state.stats, j.stats || {});
  } catch (_) { /* lần chạy đầu */ }
}
let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.promises.writeFile(STATE_FILE, JSON.stringify({ settings: state.settings, stats: state.stats }, null, 2)).catch(() => {}), 1000);
}
loadState();

const lobby = { priority: [], normal: [] };   // sảnh chờ (FIFO)
const giftQueue = [];                          // người tặng quà — luôn được đọc trước sảnh
const doneList = [];                           // người đã được đọc: đứng cạnh chân thần Ra (mới nhất ở đầu)
const prayerSpeech = [];                       // hàng đọc lời cầu nguyện (chen giữa các lượt đọc bài)
let current = null;
let prioStreak = 0;                            // đếm: 2 lượt sảnh ưu tiên rồi 1 lượt sảnh thường
let engineBusy = false;
const claimWaiting = new Set();                // đã gõ "claim" khi đang được đọc

const keyOf = (p) => String(p.uniqueId || p.user || 'khach').toLowerCase();
const now = () => Date.now();
const person = (p) => ({ key: keyOf(p), user: sanitizeUserName(p.user), uniqueId: p.uniqueId || '', avatar: p.avatar || '' });
const pub = (e) => ({ key: e.key, user: e.user, avatar: e.avatar, tier: e.tier || 0, coins: e.coins || 0, giftName: e.giftName || '', question: e.question || questions.get(e.key) || '' });
const inList = (list, key) => list.findIndex((e) => e.key === key);

function getPublicState() {
  return {
    settings: state.settings, stats: state.stats, tiktok: state.tiktok,
    lobby: { priority: lobby.priority.map(pub), normal: lobby.normal.map(pub) },
    giftQueue: giftQueue.map(pub),
    done: doneList.slice(0, state.settings.doneSlots * 2).map((d) => ({ ...pub(d), cardIds: d.cardIds, claimed: !!d.claimed })),
    current: current ? { ...pub(current), phase: current.phase, cardIds: current.cards.map((c) => c.id), event: current.event || null } : null,
    history: history.slice(0,20), intelligence: intelligence.status(),
    tts: zeroTts.getStatus(),
  };
}
let stateTimer = null;
function pushState() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => { stateTimer = null; broadcastNotification('tarot.state', getPublicState()); }, 120);
}
const logEvent = (icon, text) => broadcastNotification('event.log', { icon, text, t: now() });

// ---- Quà tặng → số lá bài (theo bảng quy tắc) ----
function giftTier(coins) {
  if (coins >= 100) return { tier: 3, cards: 3, label: 'Siêu cao cấp' };
  if (coins >= 11) return { tier: 2, cards: 2, label: 'Cao cấp' };
  return { tier: 1, cards: 1, label: 'Cao' };
}

// ---- Các sự kiện tương tác ----
function ev_join(p) {                       // tham gia phiên live → sảnh THƯỜNG (bên phải)
  const me = person(p);
  if (isKnown(me.key)) return { ok: true, note: 'đã có mặt' };
  lobby.normal.push({ ...me, joinedAt: now() });
  broadcastNotification('lobby.join', { ...pub(me), lobby: 'normal' });
  logEvent('🚪', `${me.user} bước vào Sảnh Thường`);
  pushState(); kick();
  return { ok: true, lobby: 'normal' };
}
function ev_follow(p, kind = 'follow') {    // follow / share → sảnh ƯU TIÊN (bên trái)
  const me = person(p);
  if (current && current.key === me.key) return { ok: true, note: 'đang được đọc' };
  if (inList(lobby.priority, me.key) >= 0 || inList(giftQueue, me.key) >= 0) return { ok: true, note: 'đã ở sảnh ưu tiên' };
  if (recentlyDone(me.key)) return { ok: true, note: 'đã được đọc gần đây' };
  const i = inList(lobby.normal, me.key);
  const entry = i >= 0 ? lobby.normal.splice(i, 1)[0] : { ...me, joinedAt: now() };
  lobby.priority.push(entry);
  broadcastNotification(i >= 0 ? 'lobby.move' : 'lobby.join', { ...pub(entry), lobby: 'priority', from: i >= 0 ? 'normal' : null });
  logEvent(kind === 'share' ? '🔁' : '💜', `${me.user} ${kind === 'share' ? 'chia sẻ' : 'theo dõi'} → Sảnh Ưu Tiên`);
  pushState(); kick();
  return { ok: true, lobby: 'priority' };
}
function ev_like(p, count = 1) {            // thả tim → nhân vật chắp tay cầu nguyện
  state.stats.likes += count; saveState();
  const me = person(p);
  broadcastNotification('person.pray', { ...pub(me), count });
  return { ok: true };
}
function ev_gift(p, coins, giftName = 'Quà') {   // tặng quà → bước lên chính giữa, nhận 1/2/3 lá
  const me = person(p); coins = Math.max(1, Number(coins) || 1);
  state.stats.gifts += 1; state.stats.coins += coins; saveState();
  for (const L of [lobby.priority, lobby.normal]) { const i = inList(L, me.key); if (i >= 0) L.splice(i, 1); }
  const gi = inList(giftQueue, me.key);
  if (gi >= 0) {                              // cộng dồn quà trong lúc chờ
    const g = giftQueue[gi]; g.coins += coins; g.giftName = giftName; Object.assign(g, giftTier(g.coins));
  } else {
    giftQueue.push({ ...me, coins, giftName, ...giftTier(coins), joinedAt: now() });
  }
  const t = giftTier(coins);
  broadcastNotification('gift.in', { ...pub(me), coins, giftName, tier: t.tier });
  logEvent('🎁', `${me.user} tặng ${giftName} (${coins} xu) → ${t.cards} lá bài`);
  pushState(); kick();
  return { ok: true, cards: t.cards };
}
function ev_claim(p) {                      // "đón nhận / claim" → lá bài bay đến người đó
  const me = person(p);
  if (current && current.key === me.key) { claimWaiting.add(me.key); return { ok: true, note: 'sẽ nhận khi kết thúc' }; }
  const d = doneList.find((x) => x.key === me.key);
  if (!d || d.claimed) return { ok: false, note: 'không có bài để nhận' };
  d.claimed = true;
  broadcastNotification('card.claim', { ...pub(d), cardIds: d.cardIds });
  logEvent('✨', `${d.user} đón nhận lá bài`);
  pushState();
  return { ok: true };
}
function ev_pray(p, wish) {                 // cầu nguyện → đảnh lễ + thả Đèn Hoa Đăng + đọc lời cầu
  const me = person(p); const w = sanitizeWishText(wish) || 'Cầu bình an cho mọi người';
  state.stats.prayers += 1; saveState();
  broadcastNotification('lantern.release', { ...pub(me), wish: w });
  logEvent('🏮', `${me.user}: ${w}`);
  if (prayerSpeech.length < 4) prayerSpeech.push({ ...me, wish: w });
  kick();
  return { ok: true };
}
const CLAIM_RE = /(^|\s)(claim|don nhan|xin don nhan|nhan bai|con xin nhan|nhan ne)(\s|$|[!.])/;
const PRAY_RE = /^(cau|nguyen|nam mo|a di da|binh an|chuc|xin)(\s|$|[,.!])|(\s|^)(nam mo|a di da phat)(\s|$)/;
function rememberQuestion(p, text) {
  const key = keyOf(p), question = clean(text); if (!question) throw Error('Vui lòng nhập câu hỏi.');
  questions.set(key,question); if(questions.size>1000)questions.delete(questions.keys().next().value);
  for (const list of [lobby.normal,lobby.priority,giftQueue]) for(const e of list) if(e.key===key)e.question=question;
  pushState(); return {ok:true,question,note: current?.key===key ? 'Câu hỏi được lưu cho lượt kế tiếp.' : 'Đã lưu câu hỏi.'};
}
function ev_comment(p, text) {
  const raw = String(text || '').trim();
  if (!raw || isBlockedSpamOrToxic(raw)) return { ok: false, note: 'bị lọc' };
  const t = stripVN(raw);
  if (CLAIM_RE.test(t)) return ev_claim(p);
  if (PRAY_RE.test(t)) return ev_pray(p, raw);
  if (raw.includes('?') || /^(hoi|cau hoi|tarot)(\s|:)/.test(t)) return rememberQuestion(p,raw.replace(/^(hỏi|câu hỏi|tarot)\s*:\s*/i,''));
  return { ok: true, note: 'bình luận thường' };
}

function recentlyDone(key) {
  const d = doneList.find((x) => x.key === key);
  return !!d && now() - d.doneAt < state.settings.repeatAfterMin * 60000;
}
function isKnown(key) {
  return (current && current.key === key) || inList(lobby.priority, key) >= 0 || inList(lobby.normal, key) >= 0 || inList(giftQueue, key) >= 0 || recentlyDone(key);
}

// ============================================================================
// 4. CHỌN NGƯỜI TIẾP THEO — quà lớn > vừa > nhỏ; rồi sảnh: 2 lượt ưu tiên : 1 lượt thường
// ============================================================================
function pickNext() {
  if(state.settings.paused)return null;
  if (giftQueue.length) {
    giftQueue.sort((a, b) => b.tier - a.tier || a.joinedAt - b.joinedAt);
    const g = giftQueue.shift(); return { ...g, source: 'gift' };
  }
  const pri = lobby.priority[0], nor = lobby.normal[0];
  if (pri && (prioStreak < 2 || !nor)) { prioStreak = nor ? prioStreak + 1 : 0; lobby.priority.shift(); return { ...pri, source: 'priority', cards: state.settings.lobbyCards, tier: 0 }; }
  if (nor) { prioStreak = 0; lobby.normal.shift(); return { ...nor, source: 'normal', cards: state.settings.lobbyCards, tier: 0 }; }
  return null;
}

// ============================================================================
// 5. THẦN RA RÚT BÀI & ĐỌC THÔNG ĐIỆP
// ============================================================================
function drawCards(n) {
  const pool = [...DECK]; const out = [];
  for (let i = 0; i < n; i++) out.push(pool.splice(crypto.randomInt(pool.length), 1)[0]);
  return out;
}
const slim = (c) => ({ id: c.id, vn: c.vn, en: c.en, image: c.image, keywords: c.keywords, message: c.message, roman: c.roman, arcana: c.arcana, suit: c.suit });
const pick = (arr, seed) => arr[seed % arr.length];
const seedOf = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const lcFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const ucFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const msgParts = (m) => { const [a, b] = m.replace(/\.$/, '').split('; '); return { obs: a, adv: b || a }; };
const kw1 = (c) => c.keywords.split(' · ')[0];

function composeReading(entry, cards) {
  if (!cards.length) throw new Error('Không có lá bài hợp lệ');
  const seed = crypto.randomInt(1000000), nm = sanitizeUserName(entry.user);
  const intro = pick([`${nm} ơi, cùng lắng nghe thông điệp hôm nay.`, `Ra chào ${nm}. Hãy dành một nhịp thở cho chính mình.`, `${nm}, một lá bài mở ra một góc nhìn mới.`, `Ánh sao gửi lời chào đến ${nm}.`, `Chào ${nm}, hành trình khám phá bản thân bắt đầu nhé.`], seed);
  let lines = [intro];
  for (const [i,c] of cards.entries()) {
    const m = msgParts(c.message);
    lines.push(`${cards.length > 1 ? 'Lá thứ ' + (i+1) : 'Lá bài của bạn'}: ${c.vn}.`);
    if (entry.source === 'normal') lines.push(ucFirst(m.obs) + '.');
    else {
      lines.push(c.message);
      lines.push(pick([`Hãy tự hỏi: ${kw1(c)} đang xuất hiện ở đâu trong cuộc sống của bạn?`, `Một điều đáng suy ngẫm hôm nay là ${kw1(c)}.`, `Bạn có thể ghi lại một trải nghiệm gần đây gắn với ${kw1(c)}.`], seed+i));
      if (entry.source === 'gift') {
        lines.push(`Gợi ý thực hành: ${lcFirst(m.adv)}.`);
        lines.push(pick(['Hãy chọn một việc nhỏ bạn có thể làm hôm nay, rồi quan sát cảm xúc sau khi thực hiện.', 'Trong các mối quan hệ, thử nói rõ điều bạn cần và lắng nghe câu trả lời với sự bình tĩnh.', 'Nếu đang phân vân, hãy viết ra điều bạn kiểm soát được và bắt đầu từ đó.', 'Dành vài phút nhìn lại điều đã giúp bạn tiến lên, thay vì chỉ chú ý đến điều còn thiếu.'], seed+i*3));
      }
    }
  }
  if (entry.source === 'gift' && cards.length > 1) lines.push(`Nhìn toàn bộ trải bài, ${cards.map(c=>kw1(c)).join(', ')} là những chủ đề để bạn kết nối với trải nghiệm của mình.`);
  if (entry.source !== 'normal') lines.push(pick(['Cảm ơn bạn đã đồng hành. Mong bạn tìm được một bước đi phù hợp với mình.', 'Ra gửi bạn lời chúc bình an. Hãy giữ lại điều hữu ích cho hành trình của bạn.', 'Chúc bạn đủ dịu dàng với bản thân và đủ kiên nhẫn với những điều đang đến.'], seed+1));
  return { lines, speech: lines.join(' ') };
}

// ============================================================================
// 6. VÒNG LẶP ĐỌC BÀI (mỗi lần một người, theo timeline do server điều khiển)
// ============================================================================
const WALK_MS = 1200, DEAL_MS = 1200, HOLD_MS = 2800;
const TS = Number(process.env.RA_TIME_SCALE || 1);   // chỉ dùng khi kiểm thử
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function kick() { if (!engineBusy) setTimeout(engineLoop, 50); }
async function speakInGap() {
  const pr = prayerSpeech.shift(); if (!pr) return false;
  const text = `Ra lắng nghe lời nguyện của ${pr.user}. ${pr.wish}`;
  const res = state.settings.ttsEnabled ? await makeSpeech(text) : null;
  const ms = res && res.ok ? Math.round((res.durationSec || 4) * 1000) : Math.max(3500, text.length * 70);
  broadcastNotification('prayer.speak', { ...pub(pr), wish: pr.wish, text, audioUrl: res && res.ok ? res.url : null, durationMs: ms });
  await sleep(ms + 600);
  return true;
}
async function engineLoop() {
  if (engineBusy) return; engineBusy = true;
  try {
    for (;;) {
      const next = pickNext();
      if (!next) { if (await speakInGap()) continue; break; }
      await runReading(next);
      await speakInGap();
      await sleep(500);
    }
  } catch (e) { console.error('[Engine]', e); if(current){broadcastNotification('reading.end',{...pub(current),id:current.id,claimed:false});current=null;} }
  engineBusy = false; pushState();
}
async function makeSpeech(text) {
  if(state.settings.voiceProvider==='openai')return intelligence.speech(text,state.settings);
  if(state.settings.voiceProvider==='zerotts')return zeroTts.synthesize(text);
  return null;
}
async function runReading(entry) {
  entry.question = entry.question || questions.get(entry.key) || '';
  const cards = drawCards(entry.cards || 1);
  const run = current = { ...entry, cards, phase: 'preparing', skip: false, id: ++readingSerial };
  pushState();
  const result = await intelligence.reading(entry,cards,state.settings);
  if(run.skip){current=null;pushState();return;}
  const tts = state.settings.ttsEnabled ? await makeSpeech(result.speech) : null;
  if(run.skip){current=null;pushState();return;}
  const speakMs = tts?.ok ? Math.round(tts.durationSec*1000) : Math.max(6000,result.speech.length*85/(state.settings.voiceRate||1));
  const event = { ...pub(entry), id:run.id,source:entry.source,cards:cards.map(slim),...result,audioUrl:tts?.ok?tts.url:null,speakMs,walkMs:WALK_MS,dealMs:DEAL_MS,holdMs:HOLD_MS,startedAt:now() };
  run.event=event;run.phase='reading';
  broadcastNotification('reading.start',event);pushState();
  logEvent('✦',`${entry.user} · ${cards.map(c=>c.vn).join(' / ')}`);
  const total=(WALK_MS+cards.length*DEAL_MS+speakMs+HOLD_MS)*TS,t0=now();
  while(now()-t0<total&&!run.skip)await sleep(120);
  const claimed=claimWaiting.delete(entry.key),d={...pub(entry),cardIds:cards.map(c=>c.id),doneAt:now(),claimed};
  if(!run.discard){const di=inList(doneList,d.key);if(di>=0)doneList.splice(di,1);doneList.unshift(d);doneList.length=Math.min(doneList.length,40);
    history.unshift({...event,finishedAt:now(),skipped:run.skip});history.length=Math.min(history.length,30);
    state.stats.readings++;state.stats.cards+=cards.length;saveState();}
  broadcastNotification('reading.end',{...pub(entry),id:run.id,cardIds:d.cardIds,claimed});
  current=null;pushState();await sleep(400);
}

// ============================================================================
// 7. KẾT NỐI TIKTOK LIVE
// ============================================================================
let tiktokConn = null;
const giftComboTracker = new Map();
const likeThrottle = new Map();
function extractUser(data) {
  const u = data?.user || data || {};
  const uniqueId = u.uniqueId || u.displayId || data?.uniqueId || '';
  const user = u.nickname || uniqueId || data?.nickname || 'Lữ Khách';
  const avatar = u.profilePictureUrl || u.avatarLarge?.urlList?.[0] || u.avatarThumb?.urlList?.[0] || u.avatarMedium?.urlList?.[0] || data?.profilePictureUrl || '';
  return { user, uniqueId, avatar };
}
async function resolveTikTokUsername(rawInput) {
  const input = String(rawInput || '').trim();
  if (!input) throw new Error('Vui lòng nhập @username hoặc link TikTok Live');
  if (/tiktok\.com\//i.test(input)) {
    const direct = input.match(/tiktok\.com\/@([^/?#]+)/i); if (direct) return direct[1];
    try { const r = await fetch(input.startsWith('http') ? input : `https://${input}`, { redirect: 'follow' }); const m = (r.url || '').match(/tiktok\.com\/@([^/?#]+)/i); if (m) return m[1]; } catch (_) {}
  }
  return input.replace(/^@/, '').split(/[/?#]/)[0].trim();
}
async function connectTikTokLive(usernameOrUrl) {
  const user = await resolveTikTokUsername(usernameOrUrl);
  if (!user) throw new Error('Không tìm thấy @username hợp lệ');
  if (tiktokConn) { try { await tiktokConn.disconnect(); } catch (_) {} tiktokConn = null; }
  state.tiktok = { connected: false, connecting: true, username: user, roomId: null, viewerCount: 0, lastError: null };
  pushState();
  const c = (tiktokConn = new TikTokLiveConnection(user, { processInitialData: true, fetchRoomInfoOnConnect: false, enableExtendedGiftInfo: false }));
  c.on(ControlEvent.CONNECTED, (rs) => { Object.assign(state.tiktok, { connected: true, connecting: false, roomId: rs?.roomId || c.roomId || null, lastError: null }); pushState(); });
  c.on(ControlEvent.DISCONNECTED, () => { Object.assign(state.tiktok, { connected: false, connecting: false }); pushState(); });
  c.on(ControlEvent.ERROR, (err) => { state.tiktok.lastError = err?.message || String(err); pushState(); });
  c.on(WebcastEvent.ROOM_USER, (d) => { const v = Number(d?.total ?? d?.viewerCount ?? 0); if (v > 0) { state.tiktok.viewerCount = v; pushState(); } });
  c.on(WebcastEvent.MEMBER, (d) => ev_join(extractUser(d)));
  c.on(WebcastEvent.CHAT, (d) => { const u = extractUser(d); ev_comment(u, d?.content || d?.comment || ''); ev_join(u); });
  c.on(WebcastEvent.LIKE, (d) => {
    const u = extractUser(d); const k = keyOf(u); const t = now();
    if (t - (likeThrottle.get(k) || 0) < 1500) return; likeThrottle.set(k, t);
    if (likeThrottle.size > 800) likeThrottle.delete(likeThrottle.keys().next().value);
    ev_like(u, Math.min(15, Math.max(1, Number(d?.count ?? d?.likeCount ?? 1))));
  });
  c.on(WebcastEvent.FOLLOW, (d) => ev_follow(extractUser(d), 'follow'));
  c.on(WebcastEvent.SHARE, (d) => ev_follow(extractUser(d), 'share'));
  c.on(WebcastEvent.SOCIAL, (d) => {
    const a = String(d?.action || ''); const disp = String(d?.common?.displayText?.displayType || d?.displayType || '').toLowerCase();
    if (a === '1' || disp.includes('follow')) ev_follow(extractUser(d), 'follow'); else if (a === '3' || disp.includes('share')) ev_follow(extractUser(d), 'share');
  });
  c.on(WebcastEvent.GIFT, (d) => {
    const u = extractUser(d); const g = d?.gift || d?.giftDetails || {};
    const gid = String(d?.giftId || g?.id || 'gift'); const group = String(d?.groupId || `${u.uniqueId}_${gid}`);
    const rep = Math.max(1, Number(d?.repeatCount || d?.comboCount || 1)); const prev = giftComboTracker.get(group) || 0;
    if (rep <= prev && d?.repeatEnd) { giftComboTracker.delete(group); return; }
    const delta = Math.max(1, rep - prev); giftComboTracker.set(group, rep);
    if (giftComboTracker.size > 500) giftComboTracker.delete(giftComboTracker.keys().next().value);
    const coins = Math.max(1, Number(g?.diamondCount || d?.diamondCount || 1)) * delta;
    ev_gift(u, coins, (delta > 1 ? `${delta}x ` : '') + (g?.name || d?.giftName || 'Quà'));
  });
  try {
    const rs = await c.connect();
    Object.assign(state.tiktok, { connected: true, connecting: false, roomId: rs?.roomId || c.roomId || null }); pushState();
    return state.tiktok;
  } catch (err) {
    Object.assign(state.tiktok, { connected: false, connecting: false, lastError: err?.message || 'Không thể kết nối (tài khoản đã bật Live chưa?)' }); pushState();
    throw new Error(state.tiktok.lastError);
  }
}
function disconnectTikTokLive() {
  if (tiktokConn) { try { tiktokConn.disconnect(); } catch (_) {} tiktokConn = null; }
  Object.assign(state.tiktok, { connected: false, connecting: false, viewerCount: 0 }); pushState();
  return state.tiktok;
}

// ============================================================================
// 8. GIẢ LẬP NGƯỜI XEM (kiểm thử / giữ nhiệt phòng live vắng)
// ============================================================================
let simTimer = null, simN = 0;
const SIM_NAMES = ['Ngọc Anh', 'Minh Quân', 'Diệu Thảo', 'Hoàng Nam', 'Thanh Hà', 'Đức Thịnh', 'Bảo Châu', 'Gia Hân', 'Tuấn Kiệt', 'Mai Phương', 'Khánh Linh', 'Quốc Bảo', 'Thu Trang', 'Hải Đăng', 'Lan Chi', 'Việt Anh'];
const SIM_WISH = ['Cầu cho gia đình luôn bình an', 'Nguyện mọi điều tốt đẹp sẽ đến', 'Chúc cả phòng live một ngày may mắn', 'Xin vũ trụ chỉ lối cho con', 'Bình an và hạnh phúc nhé'];
function simStep() {
  const r = Math.random(); const u = { user: SIM_NAMES[crypto.randomInt(SIM_NAMES.length)], uniqueId: `sim${crypto.randomInt(30)}` };
  if (r < 0.34) ev_join(u);
  else if (r < 0.52) ev_follow(u, Math.random() < 0.5 ? 'follow' : 'share');
  else if (r < 0.7) ev_like(u, 5);
  else if (r < 0.82) ev_pray(u, SIM_WISH[crypto.randomInt(SIM_WISH.length)]);
  else if (r < 0.92) ev_claim(u);
  else { const c = [1, 5, 10, 25, 49, 120, 299][crypto.randomInt(7)]; ev_gift(u, c, c >= 100 ? 'Galaxy' : c >= 11 ? 'Đèn lưu ly' : 'Hoa hồng'); }
  simN++;
}
function configureAutoSim(on) {
  state.settings.autoSim = !!on; clearInterval(simTimer);
  if (on) simTimer = setInterval(simStep, state.settings.autoSimIntervalMs);
  saveState(); pushState();
  return { autoSim: state.settings.autoSim };
}

// ============================================================================
// 9. JSON-RPC 2.0
// ============================================================================
async function handleRpcCall(method, p = {}) {
  switch (method) {
    case 'tarot.getState': return getPublicState();
    case 'studio.configureAI': return intelligence.configure(p);
    case 'studio.question': return rememberQuestion(p,p.question);
    case 'studio.pause': state.settings.paused=!!p.paused; saveState();pushState();if(!p.paused)kick();return {paused:state.settings.paused};
    case 'studio.preview': { const n=Math.max(1,Math.min(3,Number(p.cards)||1)); const cards=drawCards(n);const entry={user:sanitizeUserName(p.user||'Bạn'),question:clean(p.question),source:['normal','priority','gift'].includes(p.source)?p.source:'normal'};return {...await intelligence.reading(entry,cards,state.settings),cards:cards.map(slim)}; }
    case 'studio.testVoice': {const r=await makeSpeech('Chào bạn. Hãy thả lỏng và cùng lắng nghe thông điệp từ những lá bài.');return r||{ok:false,note:'Dùng giọng tiếng Việt trên trình duyệt.'};}
    case 'tarot.getDeck': return DECK.map(slim);
    case 'tarot.join': return ev_join(p);
    case 'tarot.follow': return ev_follow(p, 'follow');
    case 'tarot.share': return ev_follow(p, 'share');
    case 'tarot.like': return ev_like(p, Number(p.count) || 1);
    case 'tarot.gift': return ev_gift(p, p.coins, p.giftName);
    case 'tarot.claim': return ev_claim(p);
    case 'tarot.pray': return ev_pray(p, p.wish);
    case 'tarot.comment': return ev_comment(p, p.text);
    case 'tarot.skip': if (current) current.skip = true; return { ok: true };
    case 'tarot.preview': {            // xem thử lời đọc của Ra, không phát, không tốn lượt
      const n = Math.min(3, Math.max(1, Number(p.cards) || 1));
      const cs = p.cardIds ? p.cardIds.map((id) => DECK.find((c) => c.id === id)).filter(Boolean) : drawCards(n);
      return { cards: cs.map(slim), ...composeReading({ key: 'preview', user: p.user || 'Bạn', tier: n === 3 ? 3 : n === 2 ? 2 : 0, source: ['normal', 'priority', 'gift'].includes(p.source) ? p.source : n > 1 ? 'gift' : 'normal' }, cs) };
    }
    case 'tarot.reset':
      lobby.priority.length = lobby.normal.length = giftQueue.length = doneList.length = prayerSpeech.length = 0; prioStreak = 0;
      if (current) {current.skip = true;current.discard=true;} claimWaiting.clear();questions.clear();pushState();return getPublicState();
    case 'tarot.updateSettings': {
      const ranges={musicVolume:[0,1],ttsVolume:[0,1],lobbyCards:[1,3],repeatAfterMin:[0,1440],doneSlots:[1,6],autoSimIntervalMs:[1000,60000],voiceRate:[.7,1.3]};
      const enums={voiceProvider:['browser','openai','zerotts'],voiceStyle:['warm','deep','bright'],aiVoice:require('./lib/intelligence').VOICES};
      for(const k of Object.keys(DEFAULT_SETTINGS).filter(k=>!['autoSim','paused','musicUrl','musicName'].includes(k))){
        if(p[k]===undefined)continue;
        if(ranges[k]){const v=Number(p[k]);if(!Number.isFinite(v))throw Error('Giá trị không hợp lệ: '+k);const [a,b]=ranges[k];state.settings[k]=Math.max(a,Math.min(b,['lobbyCards','doneSlots'].includes(k)?Math.round(v):v));}
        else if(enums[k]){if(!enums[k].includes(p[k]))throw Error('Lựa chọn không hợp lệ: '+k);state.settings[k]=p[k];}
        else if(typeof DEFAULT_SETTINGS[k]==='boolean'){if(typeof p[k]!=='boolean')throw Error('Giá trị bật/tắt không hợp lệ');state.settings[k]=p[k];}
        else state.settings[k]=clean(p[k],160);
      }
      saveState(); pushState(); return state.settings;
    }
    case 'tarot.speak': { const r = await zeroTts.synthesize(p.text, p.voice); return r; }
    case 'tarot.ttsStatus': return zeroTts.getStatus();
    case 'live.connect': return connectTikTokLive(p.username || p.url);
    case 'live.disconnect': return disconnectTikTokLive();
    case 'live.setAutoSim': return configureAutoSim(p.enabled);
    default: throw new Error(`Không tìm thấy phương thức JSON-RPC: ${method}`);
  }
}

const app = express();
app.use((req,res,next)=>{const origin=req.headers.origin;if(origin&&origin!==`${req.protocol}://${req.headers.host}`)return res.status(403).json({error:'Chỉ chấp nhận yêu cầu cùng ứng dụng.'});next();});
const MUSIC_DIR=path.join(DATA_DIR,'music');fs.mkdirSync(MUSIC_DIR,{recursive:true});
app.post('/api/music',express.raw({type:'audio/mpeg',limit:'40mb'}),(req,res)=>{if(!Buffer.isBuffer(req.body)||req.body.length<3)return res.status(400).json({error:'File MP3 không hợp lệ.'});const b=req.body;if(b.toString('ascii',0,3)!=='ID3'&&!(b[0]===255&&(b[1]&224)===224))return res.status(400).json({error:'Vui lòng chọn đúng định dạng MP3.'});fs.writeFileSync(path.join(MUSIC_DIR,'background.mp3'),b);state.settings.musicUrl='/music/background.mp3?v='+Date.now();state.settings.musicName=clean(decodeURIComponent(req.headers['x-file-name']||'Nhạc nền'),100);state.settings.musicPlaying=true;saveState();pushState();res.json({ok:true});});
app.use('/music',express.static(MUSIC_DIR));
app.use(express.json({ limit: '1mb' }));
app.use('/tts-cache', express.static(TTS_CACHE_DIR, { maxAge: '7d' }));
app.get('/', (req,res,next) => req.query.obs ? res.redirect('/live') : next());
app.use(express.static(path.join(ROOT, 'public')));
app.get('/live',(_req,res)=>res.sendFile(path.join(ROOT,'public','live.html')));
app.get('/admin', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
app.post('/rpc', async (req, res) => {
  const { jsonrpc, id, method, params } = req.body || {};
  if (!method) return res.status(400).json({ jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request: thiếu method' } });
  try { res.json({ jsonrpc: jsonrpc || '2.0', id: id ?? null, result: await handleRpcCall(method, params || {}) }); }
  catch (err) { res.json({ jsonrpc: jsonrpc || '2.0', id: id ?? null, error: { code: -32000, message: err.message || 'Server error' } }); }
});
app.all('/api/tts', async (req, res) => {
  const text = String(req.body?.text || req.query?.text || '').trim();
  if (!text) return res.status(400).json({ ok: false, error: 'Thiếu text' });
  res.json(await zeroTts.synthesize(text, req.body?.voice || req.query?.voice));
});
app.get('/api/state', (_req, res) => res.json(getPublicState()));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', verifyClient: info => !info.origin || info.origin === `http://${info.req.headers.host}` || info.origin === `https://${info.req.headers.host}` });
function broadcastNotification(method, params) {
  const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
  for (const c of wss.clients) if (c.readyState === 1) c.send(payload);
}
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'tarot.state', params: getPublicState() }));
  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw.toString('utf8')); } catch (_) { return; }
    if (!msg || !msg.method) return;
    try { const result = await handleRpcCall(msg.method, msg.params || {}); if (msg.id !== undefined) ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })); }
    catch (err) { if (msg.id !== undefined) ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: err.message || 'RPC Error' } })); }
  });
});

const zeroTts = new ZeroTTSManager();
module.exports = { handleRpcCall, getPublicState };
server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  console.log('============================================================');
  console.log('☀️  RA · NEBULA TAROT STUDIO đã khởi động');
  console.log(`📺 Màn hình Live 9:16 : http://localhost:${PORT}/live`);
  console.log(`🎛️ Studio: http://localhost:${PORT}`);
  console.log(`🎛️  Admin & RPC        : http://localhost:${PORT}/admin`);
  console.log(`🔌 JSON-RPC 2.0       : POST /rpc  |  ws://localhost:${PORT}/ws`);
  console.log('============================================================');
  if (state.settings.autoSim) configureAutoSim(true);
  const ch = process.env.TIKTOK_USER;
  if (ch) connectTikTokLive(ch).catch((e) => console.warn(`[Auto-Connect @${ch}]`, e.message));
});

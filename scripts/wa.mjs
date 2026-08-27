// scripts/wa.mjs — WhatsApp via QR (Baileys): pareamento e envio do relatorio diario (PDF)
//
// Comandos:
//   node scripts/wa.mjs parear   -> mostra QR no log do Actions, salva a sessao no Supabase Storage e lista os grupos
//   node scripts/wa.mjs enviar   -> gera o PDF do estoque (filial 001, grupo 002) e envia pro grupo WA_GRUPO
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, WA_GRUPO (default "Diretoria")
// Sessao: bucket privado "wa-session" no Supabase Storage (session.tar.gz)
// Aviso: usa protocolo do WhatsApp Web (nao-oficial). Um documento/dia em grupo interno = uso leve.

import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const GRUPO = (process.env.WA_GRUPO || 'Diretoria').trim();
const NUMERO = (process.env.WA_NUMERO || '').replace(/\D/g, '');
const BUCKET = 'wa-session';
const SESS_DIR = './wa_auth';
const cmd = process.argv[2];
const FORCAR = process.argv.includes('--forcar');

if (!SB_URL || !SB_KEY) { console.error('Faltam SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1); }

const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY };
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

// ---------- Supabase Storage (sessao) ----------
async function ensureBucket() {
  const r = await fetch(SB_URL + '/storage/v1/bucket/' + BUCKET, { headers: H });
  if (r.ok) return;
  const c = await fetch(SB_URL + '/storage/v1/bucket', {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false })
  });
  if (!c.ok && c.status !== 409) throw new Error('Falha criando bucket: ' + c.status + ' ' + (await c.text()));
}

async function baixarSessao() {
  const r = await fetch(SB_URL + '/storage/v1/object/' + BUCKET + '/session.tar.gz', { headers: H });
  if (!r.ok) return false;
  fs.writeFileSync('session.tar.gz', Buffer.from(await r.arrayBuffer()));
  fs.mkdirSync(SESS_DIR, { recursive: true });
  execSync('tar xzf session.tar.gz -C ' + SESS_DIR);
  return true;
}

async function subirSessao() {
  execSync('tar czf session.tar.gz -C ' + SESS_DIR + ' .');
  const buf = fs.readFileSync('session.tar.gz');
  const r = await fetch(SB_URL + '/storage/v1/object/' + BUCKET + '/session.tar.gz', {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/gzip', 'x-upsert': 'true' }, body: buf
  });
  if (!r.ok) throw new Error('Falha subindo sessao: ' + r.status + ' ' + (await r.text()));
}

async function publicarQr(qr) {
  try {
    await fetch(SB_URL + '/rest/v1/wa_qr?on_conflict=id', {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ id: 1, qr: qr, atualizado_em: new Date().toISOString() })
    });
  } catch (e) { console.log('aviso: falha publicando QR: ' + e.message); }
}

async function limparQr() {
  try {
    await fetch(SB_URL + '/rest/v1/wa_qr?id=eq.1', { method: 'DELETE', headers: H });
  } catch (e) { /* ok */ }
}

// ---------- Conexao WhatsApp ----------
async function conectar(mostrarQR) {
  const { version } = await fetchLatestBaileysVersion();
  for (let tent = 0; tent < 3; tent++) {
    const { state, saveCreds } = await useMultiFileAuthState(SESS_DIR);
    const sock = makeWASocket({
      auth: state, version, logger: pino({ level: 'silent' }),
      browser: ['EstoqueCigamPro', 'Chrome', '1.0'], syncFullHistory: false
    });
    sock.ev.on('creds.update', saveCreds);
    const res = await new Promise((resolve) => {
      const t = setTimeout(() => resolve({ status: 'timeout' }), mostrarQR ? 420000 : 240000);
      sock.ev.on('connection.update', (u) => {
        if (u.qr && mostrarQR) {
          console.log('\n===== ESCANEIE O QR (WhatsApp > Aparelhos conectados > Conectar um aparelho) =====');
          console.log('(se aparecer outro QR abaixo, use sempre o MAIS RECENTE)\n');
          qrcode.generate(u.qr, { small: true });
          publicarQr(u.qr);
          console.log('QR na pagina: https://borgesmateus.github.io/estoque-cigam/wa.html');
        }
        if (u.connection === 'open') { clearTimeout(t); resolve({ status: 'open', sock }); }
        if (u.connection === 'close') {
          clearTimeout(t);
          const code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output
            ? u.lastDisconnect.error.output.statusCode : undefined;
          resolve({ status: 'close', code });
        }
      });
    });
    if (res.status === 'open') return res.sock;
    if (res.status === 'close' && (res.code === DisconnectReason.restartRequired || res.code === 515 || (mostrarQR && res.code === 408))) {
      console.log('Reconectando (pos-pareamento)...');
      continue;
    }
    if (mostrarQR && res.code === 401) {
      console.log('Sessao antiga invalida (desconectada no celular). Gerando QR novo...');
      fs.rmSync(SESS_DIR, { recursive: true, force: true });
      fs.mkdirSync(SESS_DIR, { recursive: true });
      continue;
    }
    throw new Error('Nao conectou: ' + JSON.stringify(res.code != null ? res.code : res.status));
  }
  throw new Error('Nao conectou apos 3 tentativas');
}

// ---------- Dados + PDF ----------
async function rest(pathQ) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(SB_URL + '/rest/v1/' + pathQ, {
      headers: { ...H, 'Range-Unit': 'items', Range: from + '-' + (from + 999) }
    });
    if (!r.ok && r.status !== 206) throw new Error('REST ' + pathQ + ' -> ' + r.status);
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

function fmt(n) {
  if (n == null || n === '') return '—';
  const f = Number(n);
  return Number.isInteger(f)
    ? f.toLocaleString('pt-BR')
    : f.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const CORES = { baixo: '#e5484d', atencao: '#f5a524', ok: '#30a46c', sem: '#8b8d98' };
const ROTULO = { baixo: 'Abaixo', atencao: 'Atenção', ok: 'OK', sem: 'Sem mín.' };
const ORDEM = { baixo: 0, atencao: 1, ok: 2, sem: 3 };

function statusDe(it) {
  if (it.min == null || it.saldo == null) return 'sem';
  if (it.saldo < it.min) return 'baixo';
  if (it.saldo <= it.min * 1.2) return 'atencao';
  return 'ok';
}

async function montarDados() {
  const ult = await rest('snapshots?select=data&order=data.desc&limit=1');
  if (!ult.length) throw new Error('Sem snapshots');
  const dia = ult[0].data;
  const snaps = await rest('snapshots?select=codigo,saldo,disponivel&data=eq.' + dia + '&filial=eq.001');
  const minimos = await rest('minimos?select=codigo,minimo');
  const mats = await rest('materiais?select=codigo,descricao,um');
  let ignorados = [];
  try { ignorados = await rest('ignorados?select=codigo'); } catch (e) { /* opcional */ }
  const ign = new Set(ignorados.map((x) => x.codigo));
  const minMap = new Map(minimos.map((x) => [x.codigo, x.minimo]));
  const matMap = new Map(mats.map((x) => [x.codigo, x]));
  const itens = snaps.filter((s) => !ign.has(s.codigo)).map((s) => {
    const m = matMap.get(s.codigo) || {};
    const it = {
      d: m.descricao || ('?' + s.codigo), um: m.um || '',
      saldo: s.saldo, min: minMap.has(s.codigo) ? minMap.get(s.codigo) : null
    };
    it.st = statusDe(it);
    return it;
  });
  itens.sort((a, b) => (ORDEM[a.st] - ORDEM[b.st]) || a.d.localeCompare(b.d, 'pt'));
  return { dia, itens };
}

function montarHtml(dia, itens) {
  const nT = itens.length;
  const nB = itens.filter((i) => i.st === 'baixo').length;
  const nA = itens.filter((i) => i.st === 'atencao').length;
  const nO = itens.filter((i) => i.st === 'ok').length;
  const nS = itens.filter((i) => i.st === 'sem').length;
  const diaBR = dia.split('-').reverse().join('/');
  const cards = itens.map((it) => {
    const c = CORES[it.st];
    return '<div class="card" style="border-left-color:' + c + '">' +
      '<div class="name">' + esc(it.d) + '</div>' +
      '<div class="row">' +
      '<div class="metric"><div class="lbl">Em estoque</div><div class="val">' + fmt(it.saldo) +
      ' <span class="um">' + esc(it.um) + '</span></div></div>' +
      '<div class="metric"><div class="lbl">Mínimo</div><div class="val mn">' + fmt(it.min) +
      ' <span class="um">' + esc(it.um) + '</span></div></div>' +
      '<div class="badge" style="background:' + c + '">' + ROTULO[it.st] + '</div>' +
      '</div></div>';
  }).join('\n');
  const html = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><style>' +
    '*{box-sizing:border-box;margin:0;padding:0}html,body{background:#fff}' +
    'body{font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#1c1c22;width:390px}' +
    '.wrap{padding:16px 14px 26px}.h-title{font-size:19px;font-weight:800;letter-spacing:-.3px}' +
    '.h-sub{font-size:12px;color:#61636e;margin-top:2px}.h-date{font-size:12px;color:#61636e;margin-top:1px}' +
    '.chips{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 6px}' +
    '.chip{font-size:11px;font-weight:700;padding:5px 9px;border-radius:999px;color:#fff;display:flex;gap:5px;align-items:center}' +
    '.chip .n{font-size:12px}.chip.total{background:#1c1c22}' +
    '.sec{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#8b8d98;margin:16px 2px 7px}' +
    '.card{border:1px solid #ececef;border-left-width:5px;border-radius:11px;padding:9px 11px;margin-bottom:7px;background:#fff}' +
    '.name{font-size:12.5px;font-weight:700;line-height:1.25;margin-bottom:6px}' +
    '.row{display:flex;align-items:center;gap:10px}.metric{min-width:74px}' +
    '.lbl{font-size:9px;text-transform:uppercase;letter-spacing:.5px;color:#8b8d98;font-weight:700}' +
    '.val{font-size:15px;font-weight:800}.val.mn{color:#61636e;font-weight:700}' +
    '.um{font-size:10px;color:#8b8d98;font-weight:600}' +
    '.badge{margin-left:auto;color:#fff;font-size:9.5px;font-weight:800;padding:3px 8px;border-radius:999px}' +
    '.foot{margin-top:16px;font-size:10px;color:#a0a1ab;text-align:center;line-height:1.5}' +
    '</style></head><body><div class="wrap">' +
    '<div class="h-title">Estoque · Câmaras Frias</div>' +
    '<div class="h-sub">Gostinho Mineiro — Filial 001 · Grupo 002 (Produtos Acabados)</div>' +
    '<div class="h-date">Posição de ' + diaBR + '</div>' +
    '<div class="chips">' +
    '<div class="chip total">Itens <span class="n">' + nT + '</span></div>' +
    '<div class="chip" style="background:' + CORES.baixo + '">Abaixo do mín. <span class="n">' + nB + '</span></div>' +
    '<div class="chip" style="background:' + CORES.atencao + '">Atenção <span class="n">' + nA + '</span></div>' +
    '<div class="chip" style="background:' + CORES.ok + '">OK <span class="n">' + nO + '</span></div>' +
    '<div class="chip" style="background:' + CORES.sem + '">Sem mín. <span class="n">' + nS + '</span></div>' +
    '</div><div class="sec">Itens · abaixo do mínimo primeiro</div>' + cards +
    '<div class="foot">Em estoque = saldo físico na câmara · Mínimo = estoque mínimo cadastrado.<br>Fonte: Estoque CIGAM Pro (snapshot diário).</div>' +
    '</div></body></html>';
  return { html, diaBR, resumo: '🔴 ' + nB + ' abaixo do mín. · 🟡 ' + nA + ' atenção · 🟢 ' + nO + ' ok' };
}

async function gerarPdf() {
  const { dia, itens } = await montarDados();
  const { html, diaBR, resumo } = montarHtml(dia, itens);
  const { chromium } = await import('playwright');
  const b = await chromium.launch();
  const pg = await b.newPage();
  await pg.setContent(html, { waitUntil: 'networkidle' });
  const h = await pg.evaluate('document.body.scrollHeight');
  const pdf = await pg.pdf({
    width: '390px', height: (h + 8) + 'px', printBackground: true,
    margin: { top: '0', bottom: '0', left: '0', right: '0' }
  });
  await b.close();
  console.log('PDF gerado: posicao ' + dia + ', ' + itens.length + ' itens');
  return { pdf: Buffer.from(pdf), dia, diaBR, resumo };
}

async function jaEnviouHoje(dia) {
  if (FORCAR) return false;
  try {
    const r = await fetch(SB_URL + '/rest/v1/wa_envios?dia=eq.' + dia + '&select=dia', { headers: H });
    if (!r.ok) return false;
    const rows = await r.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) { return false; }
}

async function marcarEnviado(dia, destino) {
  try {
    await fetch(SB_URL + '/rest/v1/wa_envios?on_conflict=dia', {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ dia: dia, enviado_em: new Date().toISOString(), destino: destino })
    });
  } catch (e) { console.log('aviso: falha marcando envio: ' + e.message); }
}

// ---------- Comandos ----------
async function parear() {
  await ensureBucket();
  const tinha = await baixarSessao();
  fs.mkdirSync(SESS_DIR, { recursive: true });
  console.log(tinha ? 'Sessao existente encontrada; validando...' : 'Sem sessao salva; sera gerado um QR.');
  const sock = await conectar(true);
  console.log('\nConectado como: ' + (sock.user ? sock.user.id : '?'));
  await limparQr();
  await esperar(5000);
  const grupos = await sock.groupFetchAllParticipating();
  console.log('\nGrupos em que o numero participa:');
  for (const g of Object.values(grupos)) console.log('  - ' + g.subject);
  await subirSessao();
  console.log('\nSessao salva no Storage. Se o grupo da diretoria nao se chamar "Diretoria",');
  console.log('defina a variavel WA_GRUPO no repositorio (Settings > Secrets and variables > Actions > Variables).');
  process.exit(0);
}

async function enviar() {
  await ensureBucket();
  const tem = await baixarSessao();
  if (!tem) { console.error('Sessao nao encontrada. Rode o workflow wa-parear e escaneie o QR primeiro.'); process.exit(1); }
  const hoje = new Date().toISOString().slice(0, 10);
  if (await jaEnviouHoje(hoje)) {
    console.log('Relatorio de ' + hoje + ' ja foi enviado hoje. Nada a fazer.');
    process.exit(0);
  }
  const { pdf, dia, diaBR, resumo } = await gerarPdf();
  const sock = await conectar(false);
  await esperar(3000);
  let destinoId, destinoNome;
  if (NUMERO) {
    const achado = await sock.onWhatsApp(NUMERO);
    if (!achado || !achado.length || !achado[0].exists) {
      console.error('Numero ' + NUMERO + ' nao encontrado no WhatsApp.');
      process.exit(1);
    }
    destinoId = achado[0].jid;
    destinoNome = 'numero ' + NUMERO;
  } else {
    const grupos = await sock.groupFetchAllParticipating();
    const alvoKey = norm(GRUPO);
    const lista = Object.values(grupos);
    const alvo = lista.find((g) => norm(g.subject) === alvoKey) || lista.find((g) => norm(g.subject).includes(alvoKey));
    if (!alvo) {
      console.error('Grupo "' + GRUPO + '" nao encontrado. Grupos: ' + lista.map((g) => g.subject).join(' | '));
      process.exit(1);
    }
    destinoId = alvo.id;
    destinoNome = 'grupo ' + alvo.subject;
  }
  await sock.sendMessage(destinoId, {
    document: pdf, mimetype: 'application/pdf',
    fileName: 'estoque_camaras_frias_' + dia + '.pdf',
    caption: '🧊 Estoque camaras frias · Filial 001 · ' + diaBR + '\n' + resumo
  });
  await marcarEnviado(hoje, destinoNome);
  console.log('Enviado para ' + destinoNome);
  await esperar(8000);
  await subirSessao();
  process.exit(0);
}

if (cmd === 'parear') parear().catch((e) => { console.error(e); process.exit(1); });
else if (cmd === 'enviar') enviar().catch((e) => { console.error(e); process.exit(1); });
else { console.error('Uso: node scripts/wa.mjs parear|enviar'); process.exit(1); }

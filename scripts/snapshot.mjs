/**
 * Robô diário — coleta o saldo do CIGAM e grava no Supabase.
 * Roda no GitHub Actions (ver .github/workflows/snapshot.yml).
 * Node 20+, sem dependências. Somente leitura no CIGAM.
 *
 * Variáveis de ambiente (Secrets do GitHub):
 *   CIGAM_USER, CIGAM_PASS            login da API do CIGAM (usuário somente leitura)
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY  projeto Supabase (chave service_role)
 * Opcionais:
 *   CIGAM_BASE (padrão: instância da Gostinho Mineiro), CIGAM_PORTAL, GRUPO (padrão 002)
 *   RESEND_API_KEY + ALERT_EMAIL_TO   alerta por e-mail (resend.com, grátis)
 *   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID  alerta por Telegram
 */
const need = (k) => {
  const v = process.env[k];
  if (!v) { console.error(`ERRO: variável ${k} não definida (Secrets do GitHub).`); process.exit(1); }
  return v;
};
const CIGAM_BASE = process.env.CIGAM_BASE || "https://gostinhomineiroportais.cigam.cloud/api/api";
const GRUPO      = process.env.GRUPO || "002";
const CIGAM_USER = need("CIGAM_USER");
const CIGAM_PASS = need("CIGAM_PASS");
const SB_URL     = need("SUPABASE_URL").replace(/\/$/, "");
const SB_KEY     = need("SUPABASE_SERVICE_KEY");
const trim = (s) => (s == null ? "" : String(s)).trim();

async function cigamLogin() {
  const r = await fetch(`${CIGAM_BASE}/genericos/ge/Login/Autenticar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ NomeUsuario: CIGAM_USER, Senha: CIGAM_PASS, Portal: process.env.CIGAM_PORTAL || "" }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.success || !j?.hash) {
    throw new Error(`Login CIGAM falhou (HTTP ${r.status}): ${j?.messages?.join(", ") || "sem detalhe"}`);
  }
  return j.hash;
}
async function cigamGet(hash, path) {
  const r = await fetch(`${CIGAM_BASE}${path}`, { headers: { Authorization: `Bearer ${hash}` } });
  if (!r.ok) throw new Error(`CIGAM HTTP ${r.status} em ${path}`);
  return r.json();
}
async function sbRest(path, opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json", ...(opts.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`Supabase HTTP ${r.status} em ${path}: ${await r.text()}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}

async function main() {
  const hoje = new Date().toISOString().slice(0, 10);
  console.log(`== Snapshot ${hoje} · grupo ${GRUPO} ==`);

  // 1) CIGAM: materiais do grupo + saldos
  const hash = await cigamLogin();
  const filtro = "$filter=" + encodeURIComponent(`Material/CodigoGrupo eq '${GRUPO}'`);
  const mats = await cigamGet(hash, `/suprimentos/es/Materiais/Buscar?${filtro}`);
  const nomes = new Map();
  for (const m of mats) {
    const c = trim(m.Material?.Codigo);
    if (c) nomes.set(c, trim(m.Material?.Descricao));
  }
  console.log(`materiais no grupo: ${nomes.size}`);

  const est = await cigamGet(hash, "/suprimentos/es/Estoque/Buscar");
  const porItemFilial = new Map(); // "codigo|filial" -> saldo
  for (const x of est) {
    const e = x.Estoque; if (!e) continue;
    const c = trim(e.CodigoMaterial);
    if (!nomes.has(c)) continue;
    const k = `${c}|${trim(e.CodigoUnidadeNegocio)}`;
    porItemFilial.set(k, (porItemFilial.get(k) || 0) + (Number(e.Saldo) || 0));
  }

  // 2) Grava snapshots (upsert por data+codigo+filial)
  const rows = [...porItemFilial].map(([k, saldo]) => {
    const [codigo, filial] = k.split("|");
    return { data: hoje, codigo, filial, saldo };
  });
  for (let i = 0; i < rows.length; i += 500) {
    await sbRest("/snapshots?on_conflict=data,codigo,filial", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows.slice(i, i + 500)),
    });
  }
  console.log(`snapshots gravados: ${rows.length} linhas`);

  // 3) Compara com os mínimos e monta o alerta
  const minimos = (await sbRest("/minimos?select=codigo,minimo")) || [];
  const saldoTotal = new Map();
  for (const [k, s] of porItemFilial) {
    const c = k.split("|")[0];
    saldoTotal.set(c, (saldoTotal.get(c) || 0) + s);
  }
  const problemas = [];
  for (const { codigo, minimo } of minimos) {
    const min = Number(minimo) || 0;
    if (min <= 0) continue;
    const saldo = saldoTotal.get(trim(codigo)) ?? 0;
    if (saldo < min) problemas.push({ codigo: trim(codigo), desc: nomes.get(trim(codigo)) || "?", saldo, min });
  }
  problemas.sort((a, b) => a.saldo / a.min - b.saldo / b.min);
  console.log(`itens abaixo do mínimo: ${problemas.length}`);

  if (!problemas.length) { console.log("Tudo OK — sem alerta hoje."); return; }

  const linhas = problemas.map(p =>
    `• ${p.desc} (${p.codigo}): saldo ${p.saldo.toLocaleString("pt-BR")} / mínimo ${p.min.toLocaleString("pt-BR")}${p.saldo <= 0 ? "  ⚠ ZERADO" : ""}`);
  const titulo = `⚠ Estoque: ${problemas.length} item(ns) abaixo do mínimo — ${hoje.split("-").reverse().join("/")}`;
  const corpo = `${titulo}\n\n${linhas.join("\n")}\n\nPainel: veja o link no README do repositório.`;
  console.log(corpo);

  // 4) Envia alertas (os canais configurados)
  if (process.env.RESEND_API_KEY && process.env.ALERT_EMAIL_TO) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Estoque CIGAM <onboarding@resend.dev>",
        to: process.env.ALERT_EMAIL_TO.split(",").map(s => s.trim()),
        subject: titulo,
        text: corpo,
      }),
    });
    console.log(r.ok ? "e-mail enviado" : `falha no e-mail: HTTP ${r.status} ${await r.text()}`);
  }
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: corpo }),
    });
    console.log(r.ok ? "telegram enviado" : `falha no telegram: HTTP ${r.status}`);
  }
  if (!process.env.RESEND_API_KEY && !process.env.TELEGRAM_BOT_TOKEN) {
    console.log("(nenhum canal de alerta configurado — veja o README)");
  }
}

main().catch((e) => { console.error("FALHA:", e.message || e); process.exit(1); });

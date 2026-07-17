// Supabase Edge Function: checar-disponibilidade
// Checa AO VIVO no CIGAM a disponibilidade dos itens de um pedido (disponivel = saldo - reservas,
// filial 001, mesma conta da tela do CIGAM). Usado pelo bot ANTES de criar o pedido pra bloquear
// item sem estoque. Mesma logica do robo diario (snapshot.mjs), so que sob demanda e so pros itens
// do pedido (poucos itens, rapido).
//
// Secrets: CIGAM_USER, CIGAM_PASS (os mesmos usados pelo criar-pedido/robo).
// Entrada:  { itens: [{ codigo, quantidade }] }
// Saida:    { ok, filial, resultado: [{ codigo, disponivel, pedido, ok }] }

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};
const BASE = Deno.env.get("CIGAM_BASE") || "https://gostinhomineiroportais.cigam.cloud/api/api";
const USER = Deno.env.get("CIGAM_USER") || "";
const PASS = Deno.env.get("CIGAM_PASS") || "";
const FILIAL = "001";
const trim = (s: any) => (s == null ? "" : String(s)).trim();

async function login(): Promise<string> {
  const r = await fetch(`${BASE}/genericos/ge/Login/Autenticar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ NomeUsuario: USER, Senha: PASS, Portal: Deno.env.get("CIGAM_PORTAL") || "" }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.hash) throw new Error("login CIGAM falhou (HTTP " + r.status + ")");
  return j.hash;
}

// saldo fisico por codigo (filial 001) \u2014 uma chamada, filtra os codigos pedidos
async function saldos(hash: string, codigos: Set<string>): Promise<Record<string, number>> {
  const r = await fetch(`${BASE}/suprimentos/es/Estoque/Buscar`, { headers: { Authorization: "Bearer " + hash } });
  const est = await r.json().catch(() => []);
  const out: Record<string, number> = {};
  for (const x of (Array.isArray(est) ? est : [])) {
    const e = x.Estoque; if (!e) continue;
    const c = trim(e.CodigoMaterial);
    if (!codigos.has(c)) continue;
    if (trim(e.CodigoUnidadeNegocio) !== FILIAL) continue;
    out[c] = (out[c] || 0) + (Number(e.Saldo) || 0);
  }
  return out;
}

// reservas (carteira de pedido) de um item na filial 001
async function reservas(hash: string, cod: string): Promise<number> {
  try {
    const r = await fetch(`${BASE}/suprimentos/es/Disponibilidade/Buscar`, {
      method: "POST",
      headers: { Authorization: "Bearer " + hash, "Content-Type": "application/json" },
      body: JSON.stringify({ Origem: "ES", CodigoMaterial: cod, CodigoUnidadeNegocio: FILIAL, CodigoCentroArmazenagem: FILIAL, CodigoUsuario: "", SuprimirZerados: false }),
    });
    const j = await r.json().catch(() => null);
    let res = 0;
    for (const d of (j?.DemandasGerais || [])) { if (trim(d.CodigoUnidadeNegocio) === FILIAL) res += (Number(d.QuantidadeSaldo) || 0); }
    return res;
  } catch { return 0; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (!USER || !PASS) throw new Error("secrets CIGAM_USER/CIGAM_PASS nao configurados");
    const body = await req.json();
    const itens = Array.isArray(body?.itens) ? body.itens : [];
    if (!itens.length) throw new Error("itens vazios");
    const hash = await login();
    const cods = new Set(itens.map((i: any) => trim(i.codigo)));
    const sal = await saldos(hash, cods);
    const resultado: any[] = [];
    for (const it of itens) {
      const cod = trim(it.codigo);
      const rsv = await reservas(hash, cod);
      const disp = (sal[cod] || 0) - rsv;
      const q = Number(it.quantidade) || 0;
      resultado.push({ codigo: cod, disponivel: disp, pedido: q, ok: disp >= q });
    }
    return new Response(JSON.stringify({ ok: true, filial: FILIAL, resultado }), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, erro: String((e as Error).message || e) }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});

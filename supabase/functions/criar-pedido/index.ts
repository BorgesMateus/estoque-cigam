// Supabase Edge Function: criar-pedido
// Recebe o pedido do painel e cria no CIGAM pela receita validada do Portal
// Representante (login CGPortal_Token + POST cabeçalho/c + item/m). Roda no
// servidor (sem CORS, com cookies) — o painel chama e recebe o número do pedido.
//
// Secrets necessários (Supabase → Edge Functions → Manage secrets):
//   CIGAM_USER, CIGAM_PASS  (usuário/senha do Portal Representante)
//   CIGAM_REP  (código do representante, ex.: 008855)  [opcional, default abaixo]
//
// Deploy: Supabase Dashboard → Edge Functions → criar "criar-pedido" → colar → Deploy.

const BASE = "https://gostinhomineiroportais.cigam.cloud";
const PORTAL = "/portalrepresentante";
const REP_DEFAULT = Deno.env.get("CIGAM_REP") ?? "008855";
const TABELA_DEFAULT = Deno.env.get("CIGAM_TABELA") ?? "003";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

const setCookiesDe = (h: Headers): string[] =>
  typeof (h as any).getSetCookie === "function" ? (h as any).getSetCookie()
    : (h.get("set-cookie") ? [h.get("set-cookie")!] : []);
function mergeCookies(existing: string, novos: string[]): string {
  const m = new Map<string, string>();
  for (const p of (existing || "").split(";")) { const s = p.trim(); const i = s.indexOf("="); if (i > 0) m.set(s.slice(0, i), s.slice(i + 1)); }
  for (const h of novos) { const nv = (h.split(";")[0] || "").trim(); const i = nv.indexOf("="); if (i > 0) m.set(nv.slice(0, i), nv.slice(i + 1)); }
  return [...m].map(([k, v]) => `${k}=${v}`).join("; ");
}
const csrfDe = (html: string) => (html.match(/name="__RequestVerificationToken"[^>]+value="([^"]+)"/) || [])[1] || "";
const hiddenDe = (html: string, n: string) => (html.match(new RegExp(`name="${n.replace(/\./g, "\\.")}"[^>]+value="([^"]*)"`)) || [])[1] || "";
const hojeBR = () => { const d = new Date(); return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`; };
const cleanMsg = (m: string[]) => (m || []).map(x => String(x).replace(/toastr\[?['"][\w]+['"]\]?\s*\(\s*['"]([^'"]+)['"]\s*\)/g, "$1")).join("; ");

// --- sessão persistente (sobrevive à reciclagem de isolates do Edge) ---
// O login no Portal custa ~5,5s. Guardamos o cookie CGPortal_Token numa tabela
// do Supabase (cigam_sessao) por alguns minutos; cada pedido lê o cookie (~100ms)
// em vez de relogar. Fallback em memória para chamadas no mesmo isolate quente.
const SB_URL = Deno.env.get("SUPABASE_URL") || "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY") || "";
const SESS_TTL = 20 * 60 * 1000; // 20 min (a sessão do portal expira relativamente rápido)
let _sess: { c: string; exp: number } | null = null;

async function lerSessaoTabela(): Promise<{ c: string; exp: number } | null> {
  if (!SB_URL || !SB_KEY) return null;
  try {
    const r = await fetch(`${SB_URL}/rest/v1/cigam_sessao?id=eq.1&select=cookie,exp`, {
      headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY },
    });
    const rows = await r.json().catch(() => []);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (row && row.cookie) { const exp = new Date(row.exp).getTime(); if (exp > Date.now()) return { c: row.cookie, exp }; }
  } catch { /* ignore */ }
  return null;
}
async function gravarSessaoTabela(cookie: string, exp: number) {
  if (!SB_URL || !SB_KEY) return;
  try {
    await fetch(`${SB_URL}/rest/v1/cigam_sessao?on_conflict=id`, {
      method: "POST",
      headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ id: 1, cookie, exp: new Date(exp).toISOString(), updated_at: new Date().toISOString() }),
    });
  } catch { /* ignore */ }
}
async function apagarSessaoTabela() {
  _sess = null;
  if (!SB_URL || !SB_KEY) return;
  try {
    await fetch(`${SB_URL}/rest/v1/cigam_sessao?id=eq.1`, {
      method: "PATCH",
      headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ exp: new Date(0).toISOString() }),
    });
  } catch { /* ignore */ }
}
async function sessao(user: string, pass: string, forcar = false): Promise<{ c: string; fonte: string }> {
  if (!forcar) {
    if (_sess && Date.now() < _sess.exp) return { c: _sess.c, fonte: "memoria" };
    const t = await lerSessaoTabela();
    if (t) { _sess = t; return { c: t.c, fonte: "tabela" }; }
  }
  const c = await login(user, pass);
  const exp = Date.now() + SESS_TTL;
  _sess = { c, exp };
  await gravarSessaoTabela(c, exp);
  return { c, fonte: "login" };
}
async function login(user: string, pass: string): Promise<string> {
  let cookie = "", url = `${BASE}${PORTAL}/`, html = "", redir = 5;
  while (redir-- > 0) {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html", Cookie: cookie }, redirect: "manual" });
    cookie = mergeCookies(cookie, setCookiesDe(r.headers));
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { url = new URL(r.headers.get("location")!, url).href; continue; }
    html = await r.text(); break;
  }
  const csrf = csrfDe(html);
  if (!csrf) throw new Error("CSRF do login não encontrado");
  const body = new URLSearchParams({ __RequestVerificationToken: csrf, usuario: user, senha: pass }).toString();
  const lr = await fetch(`${BASE}${PORTAL}/`, {
    method: "POST", redirect: "manual",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie, Referer: `${BASE}${PORTAL}/` },
    body,
  });
  cookie = mergeCookies(cookie, setCookiesDe(lr.headers));
  if (!/CGPortal_Token=/.test(cookie)) throw new Error("login falhou (usuário/senha do CIGAM)");
  return cookie;
}

// Busca o cadastro do cliente para herdar representante, tabela de preço,
// condição de pagamento e mercado — em vez de valores fixos.
const tokenDe = (cookie: string) => (cookie.match(/CGPortal_Token=([^;]+)/) || [])[1] || "";
async function cadastroCliente(ref: { c: string }, code: string): Promise<any | null> {
  const tok = tokenDe(ref.c);
  if (!tok) return null;
  const sel = encodeURIComponent("Codigo,CodigoRepresentante,CodigoTabelaPreco,CodigoCondicaoPagamento,CodigoMercado");
  const cod6 = String(code).trim(); // usa o codigo como esta no cadastro (filiais tem codigo curto, ex.: "2")
  const api = `${BASE}/api/api/genericos/ge/Pessoa/Buscar`;
  // tenta $filter (a doc diz que Pessoa suporta); se vier vazio, cai pro varredura + find
  let arr: any[] = [];
  try {
    const f = encodeURIComponent(`Codigo eq '${cod6}'`);
    const r = await fetch(`${api}?%24select=${sel}&%24filter=${f}&%24top=5`, { headers: { Authorization: "Bearer " + tok } });
    if (r.status === 200) arr = await r.json().catch(() => []);
  } catch { /* ignore */ }
  let cli = (Array.isArray(arr) ? arr : []).find((p) => String(p.Codigo).trim() === cod6);
  if (!cli) {
    const r = await fetch(`${api}?%24select=${sel}&%24top=8000`, { headers: { Authorization: "Bearer " + tok } });
    const all = await r.json().catch(() => []);
    cli = (Array.isArray(all) ? all : []).find((p) => String(p.Codigo).trim() === cod6);
  }
  if (!cli) return null;
  const t = (v: any) => (v == null ? "" : String(v).trim());
  return { rep: t(cli.CodigoRepresentante), tabela: t(cli.CodigoTabelaPreco), cond: t(cli.CodigoCondicaoPagamento), mercado: t(cli.CodigoMercado) };
}

async function criarCabecalho(ref: { c: string }, order: any): Promise<{ num: string; itemsUrl: string }> {
  const createUrl = `${BASE}${PORTAL}/fa/pedido/cadastro/c/`;
  const g = await fetch(createUrl, { headers: { "User-Agent": UA, Cookie: ref.c } });
  ref.c = mergeCookies(ref.c, setCookiesDe(g.headers));
  const html = await g.text();
  const csrf = csrfDe(html), hash = (html.match(/name="hash"[^>]+value="([^"]+)"/) || [])[1] || "";
  if (!csrf) throw new Error("CSRF do cabeçalho não encontrado — sessão expirou");
  const hoje = hojeBR();
  const F: Record<string, string> = {
    "__RequestVerificationToken": csrf, "mode": "c", "viewMod": "True", "hash": hash, "userAction": "itens",
    "CodigoPedido": "", "VendasContato.CodigoContato": "0",
    "Cliente.CodigoEmpresa": String(order.clienteCode).trim(),
    "DataPedido": hoje, "UnidadeNegocio.CodigoUnidadeNegocio": "001",
    "CondicaoPagamento.CondicaoPagamento": order.condicaoPagamento || "260", "alterarCndPagamento": "False",
    "CondicaoPagamento.FormaPagamento": "", "CondicaoPagamento.TipoPagamento": "",
    "TabelaPreco": order.tabelaPreco || TABELA_DEFAULT, "TipoNota": "N",
    "Representante.CodigoEmpresa": order.representanteCode || REP_DEFAULT, "Representante.PercentualComissaoBaixa": "0",
    "Controle.CodigoControle": "20", "Tg.CodigoTg": "0", "Observacao": order.observacao || "PEDIDO VIA PAINEL",
    "OrigemPedido": "", "ValorInformDesconto": "0", "PercentualDescontoAteVencimento": "0",
    "PercentualDescontoSugestaoItens": "0", "PercGeralOutrasDespAcessorias": "0", "ValorInformOutrasDespAcessorias": "0",
    "PercGeralEncargosFinanceiros": "0", "PrazoEntrega": hoje, "PrazoProgramado": hoje,
  };
  const body = Object.entries(F).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const r = await fetch(createUrl, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Cookie: ref.c, Referer: createUrl },
    body,
  });
  ref.c = mergeCookies(ref.c, setCookiesDe(r.headers));
  const d = await r.json().catch(() => null);
  if (!d || !d.Success) throw new Error("cabeçalho: " + (cleanMsg(d?.Messages) || ("HTTP " + r.status)));
  const num = ((d.Url || "").match(/(\d{4,})/) || [])[1];
  if (!num) throw new Error("número do pedido não retornado");
  const itemsUrl = `${BASE}${(d.Url || "").replace("/cadastroitem/c/", "/cadastroitem/m/")}`;
  return { num, itemsUrl };
}

const norm4 = (s: string) => { let [i, d = ""] = String(s).trim().replace(".", ",").split(","); d = (d + "0000").slice(0, 4); return `${i || "0"},${d}`; };
async function precoDaTabela(ref: { c: string }, num: string, mat: string, tabela: string): Promise<string> {
  const q = `codigoMaterial=${encodeURIComponent(mat)}&codigoPedido=${encodeURIComponent((num + "").padEnd(12).slice(0, 12).replace(/.$/, " "))}&tabelaPreco=${encodeURIComponent(String(tabela).trim().padEnd(6))}&quantidade=0,000000&valorUnitario=0,0000&unidadeConvertida=false&grade=&numeracoes=&centroArmazenagem=${encodeURIComponent("001 ")}&identificador=&percentualICMS=20.0000&incidenciaICMS=0&reducaoICMS=0.00000`;
  const r = await fetch(`${BASE}${PORTAL}/fa/pedido/AtualizaPrecoTabela?${q}`, { headers: { "User-Agent": UA, Cookie: ref.c, "X-Requested-With": "XMLHttpRequest" } });
  const t = await r.text();               // CSV: "15,3;15,3;0;..."
  return norm4((t.split(";")[0] || "0"));
}
async function adicionarItem(ref: { c: string }, itemsUrl: string, num: string, it: any, tabela: string, prazo: string) {
  const g = await fetch(itemsUrl, { headers: { "User-Agent": UA, Cookie: ref.c } });
  ref.c = mergeCookies(ref.c, setCookiesDe(g.headers));
  const html = await g.text();
  const csrf = csrfDe(html), pedCod = hiddenDe(html, "Pedido.CodigoPedido") || (num + "").padEnd(12);
  // preço: usa o informado (em centavos) ou resolve na tabela do CIGAM
  const preco = (it.precoUnitario != null)
    ? (Number(it.precoUnitario) / 100).toFixed(4).replace(".", ",")
    : await precoDaTabela(ref, num, String(it.codigoProduto).padEnd(20), tabela);
  if (preco === "0,0000") throw new Error("produto " + it.codigoProduto + " sem preço na tabela " + tabela);
  const F: Record<string, string> = {
    "codigoPedido": pedCod, "codigoMaterial": String(it.codigoProduto).padEnd(20), "sequencia": "0", "grade": "",
    "prazoEntrega": prazo, "prazoProgramado": prazo, "tabelaPreco": String(tabela).trim().padEnd(6),
    "quantidade": Number(it.quantidade).toFixed(3).replace(".", ","), "unidadeMedida": it.unidadeMedida || "KG",
    "precoUnitario": preco, "percentualDesconto": Number(it.desconto || 0).toFixed(2).replace(".", ","),
    "precoOriginal": preco, "quantidadeConvertida": "0,000000", "unidadeMedidaConvertida": "",
    "precoUnitarioConvertido": "0,0000", "pedidoCompra": "", "itemPedidoCompra": "", "identificador": "",
    "especif1": "", "especif2": "", "centroArmazenagem": "001", "userAction": "save", "usuarioDesconto": "",
    "senhaDesconto": "", "solicitaDesconto": "False", "controleItemPedido": "", "idButton": "",
    "__RequestVerificationToken": csrf,
  };
  const r = await fetch(`${BASE}${PORTAL}/FA/pedido/cadastroitem/`, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", Cookie: ref.c, Referer: itemsUrl, "X-Requested-With": "XMLHttpRequest", Accept: "*/*" },
    body: new URLSearchParams(F).toString(),
  });
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("json")) { const d = await r.json().catch(() => null); if (d && d.Success === false) throw new Error("item " + it.codigoProduto + ": " + (cleanMsg(d.Messages) || "recusado")); }
  else if (!r.ok) throw new Error("item " + it.codigoProduto + ": HTTP " + r.status);
}

// Cria o pedido completo (cabeçalho + itens) usando a sessão em cache.
// forcar=true ignora o cache e faz login novo (usado no retry quando a sessão expira).
async function processar(order: any, user: string, pass: string, forcar: boolean) {
  const T: Record<string, number | string> = {}; let tk = Date.now();
  const s = await sessao(user, pass, forcar);
  const ref = { c: s.c };
  T.login = Date.now() - tk; T.fonte = s.fonte; tk = Date.now();
  // herda representante / tabela de preço / condição de pagamento / mercado do CADASTRO do cliente
  const cad = await cadastroCliente(ref, order.clienteCode);
  T.cadastro = Date.now() - tk; tk = Date.now();
  if (cad) {
    if (!order.representanteCode && cad.rep) order.representanteCode = cad.rep;
    if (!order.tabelaPreco && cad.tabela) order.tabelaPreco = cad.tabela;
    if (!order.condicaoPagamento && cad.cond) order.condicaoPagamento = cad.cond;
    if (!order.mercado && cad.mercado) order.mercado = cad.mercado;
  }
  const { num, itemsUrl } = await criarCabecalho(ref, order);
  T.cabecalho = Date.now() - tk; tk = Date.now();
  const prazo = hojeBR();
  for (const it of order.items) await adicionarItem(ref, itemsUrl, num, it, order.tabelaPreco || TABELA_DEFAULT, prazo);
  T.itens = Date.now() - tk;
  return { num, T };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const user = Deno.env.get("CIGAM_USER"), pass = Deno.env.get("CIGAM_PASS");
    if (!user || !pass) throw new Error("secrets CIGAM_USER/CIGAM_PASS não configurados na função");
    const order = await req.json();
    // ping / keep-warm: aquece o login (cache em tabela), sem criar pedido
    if (order?.ping) { const s = await sessao(user, pass); return new Response(JSON.stringify({ ok: true, ping: true, fonte: s.fonte }), { headers: { ...CORS, "Content-Type": "application/json" } }); }
    if (!order?.clienteCode || !Array.isArray(order?.items) || !order.items.length) throw new Error("pedido inválido (falta clienteCode ou items)");
    let out;
    try {
      out = await processar(order, user, pass, false);
    } catch (e) {
      // sessão em cache pode ter expirado no servidor do CIGAM — invalida e tenta 1x com login novo
      const msg = String((e as Error).message || e);
      if (/expirou|CSRF|HTTP 401|HTTP 403|login falhou/i.test(msg)) { await apagarSessaoTabela(); out = await processar(order, user, pass, true); }
      else throw e;
    }
    return new Response(JSON.stringify({ ok: true, cigamOrderId: out.num, timings: out.T }), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, erro: String((e as Error).message || e) }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});

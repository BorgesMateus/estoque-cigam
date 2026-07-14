/**
 * Robô de digitação de pedidos — lê a fila (Supabase) e cria pedidos no CIGAM
 * replicando o fluxo do Portal Representante (receita mapeada em 14/07/2026):
 *   CABEÇALHO: form /cadastro/c/ → contexto do cliente na sessão → POST save → nº do pedido
 *   ITEM: modo M do pedido → sequência de contexto do material (12 rotas) → POST save
 * Credenciais via secrets (PORTAL_USER/PORTAL_PASS ou CIGAM_USER/CIGAM_PASS).
 */
const need = (k, alt) => process.env[k] || (alt && process.env[alt]) || (console.error("falta env " + k), process.exit(1));
const BASE = process.env.PORTAL_BASE || "https://gostinhomineiroportais.cigam.cloud";
const P = BASE + "/portalrepresentante";
const USER = need("PORTAL_USER", "CIGAM_USER");
const PASS = need("PORTAL_PASS", "CIGAM_PASS");
const SB_URL = need("SUPABASE_URL").replace(/\/$/, "");
const SB_KEY = need("SUPABASE_SERVICE_KEY");
const trim = (s) => (s == null ? "" : String(s)).trim();
const hojeBR = () => new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });

/* ---------------- cookie jar ---------------- */
const jar = new Map();
function guardaCookies(res) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of sc) { const [par] = c.split(";"); const i = par.indexOf("="); if (i > 0) jar.set(par.slice(0, i).trim(), par.slice(i + 1)); }
}
function cookieHeader() { return [...jar.entries()].map(([k, v]) => k + "=" + v).join("; "); }
async function go(url, opts = {}) {
  const headers = { Cookie: cookieHeader(), "X-Requested-With": "XMLHttpRequest", ...(opts.headers || {}) };
  const res = await fetch(url, { redirect: "manual", ...opts, headers });
  guardaCookies(res);
  if ([301, 302, 303].includes(res.status)) {
    const loc = res.headers.get("location");
    if (loc) return go(new URL(loc, url).href, { method: "GET", headers: opts.headers });
  }
  return res;
}
const form = (obj) => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }, body: new URLSearchParams(obj).toString() });

/* ---------------- login no portal ---------------- */
async function loginPortal() {
  const r = await go(P + "/", { headers: { "X-Requested-With": "" } });
  const html = await r.text();
  if (/MATEUS|Sair|logoff/i.test(html) && !/type=["']password/i.test(html)) { console.log("sessão já ativa"); return; }
  // descobre os campos do form de login
  const inputs = [...html.matchAll(/<input[^>]*name=["']([^"']+)["'][^>]*>/gi)].map(m => m[1]);
  const tipoDe = {}; [...html.matchAll(/<input[^>]*name=["']([^"']+)["'][^>]*type=["']([^"']+)["']/gi)].forEach(m => tipoDe[m[1]] = m[2]);
  [...html.matchAll(/<input[^>]*type=["']([^"']+)["'][^>]*name=["']([^"']+)["']/gi)].forEach(m => tipoDe[m[2]] = m[1]);
  const campoUser = inputs.find(n => /user|usuario|login|email/i.test(n) && tipoDe[n] !== "hidden") || inputs.find(n => tipoDe[n] === "text");
  const campoPass = inputs.find(n => tipoDe[n] === "password");
  const token = (html.match(/name=["']__RequestVerificationToken["'][^>]*value=["']([^"']+)["']/) || [])[1];
  const actionM = html.match(/<form[^>]*action=["']([^"']+)["']/i);
  const action = actionM ? new URL(actionM[1], P + "/").href : P + "/";
  if (!campoUser || !campoPass) { console.error("não achei campos de login. inputs: " + inputs.join(",")); process.exit(1); }
  console.log(`login: action=${action.replace(BASE, "")} user=${campoUser} pass=${campoPass}`);
  const body = { [campoUser]: USER, [campoPass]: PASS };
  if (token) body.__RequestVerificationToken = token;
  // campos hidden extras do form
  for (const n of inputs) if (tipoDe[n] === "hidden" && !(n in body)) {
    const v = (html.match(new RegExp(`name=["']${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*value=["']([^"']*)["']`)) || [])[1];
    if (v != null) body[n] = v;
  }
  const lr = await go(action, form(body));
  const lh = await lr.text();
  if (/type=["']password/i.test(lh)) { console.error("login do portal FALHOU (form de senha retornou)"); process.exit(1); }
  console.log("login ok");
}

/* ---------------- receita: cabeçalho ---------------- */
function serializaForm(html) {
  const campos = [];
  const doc = html.replace(/\r?\n/g, " ");
  for (const m of doc.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    const name = (tag.match(/name=["']([^"']+)["']/) || [])[1]; if (!name) continue;
    const type = ((tag.match(/type=["']([^"']+)["']/) || [])[1] || "text").toLowerCase();
    if (["checkbox", "radio"].includes(type) && !/checked/i.test(tag)) continue;
    if (["button", "submit", "image"].includes(type)) continue;
    const value = (tag.match(/value=["']([^"']*)["']/) || [])[1] || "";
    campos.push([name, value]);
  }
  for (const m of doc.matchAll(/<select\b[^>]*name=["']([^"']+)["'][^>]*>(.*?)<\/select>/gi)) {
    const sel = (m[2].match(/<option[^>]*selected[^>]*value=["']([^"']*)["']/) || m[2].match(/<option[^>]*value=["']([^"']*)["']/) || [])[1] || "";
    campos.push([m[1], sel]);
  }
  for (const m of doc.matchAll(/<textarea\b[^>]*name=["']([^"']+)["'][^>]*>(.*?)<\/textarea>/gi)) campos.push([m[1], m[2] || ""]);
  return campos;
}
async function criaCabecalho(ped) {
  // 1) form novo (modo C)
  let html = await (await go(P + "/fa/pedido/cadastro/c/")).text();
  if (!/__RequestVerificationToken/.test(html)) throw new Error("form C não veio (login?)");
  // 2) contexto do cliente na sessão
  await go(P + "/Home/_QueryComplete/?nameAutocompleteType=Pessoa&value=" + encodeURIComponent(ped.query_cliente));
  await go(P + "/fa/pedido/ExisteCobranca/", form({ codigo: ped.cliente_codigo }));
  await go(P + "/fa/pedido/_QueryClienteDetalhes/c");
  await go(P + "/ge/TabelaDePreco/_Select");
  // 3) form de novo (agora com defaults do cliente na sessão)
  html = await (await go(P + "/fa/pedido/cadastro/c/")).text();
  const campos = serializaForm(html);
  const HOJE = hojeBR();
  const set = new Map([
    ["Cliente.CodigoEmpresa", ped.cliente_codigo], ["QueryCliente.CodigoEmpresa", ped.query_cliente],
    ["DataPedido", HOJE], ["PrazoEntrega", HOJE], ["PrazoProgramado", HOJE],
    ["Observacao", ped.obs || "PEDIDO VIA PAINEL (ROBO)"],
  ]);
  const body = new URLSearchParams();
  const vistos = new Set();
  for (const [k, v] of campos) { if (k === "userAction") continue; body.append(k, set.has(k) && !vistos.has(k) ? set.get(k) : v); vistos.add(k); }
  body.append("userAction", "save");
  const action = (html.match(/<form[^>]*action=["']([^"']+)["']/i) || [])[1] || "/portalrepresentante/fa/pedido/cadastro/c/";
  const r = await go(new URL(action, P + "/").href, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }, body: body.toString() });
  const j = JSON.parse(await r.text());
  if (!j.Success) throw new Error("save do cabeçalho: " + JSON.stringify(j.Messages || j).slice(0, 200));
  const num = (String(j.Url || "").match(/m\/(\d+)/) || [])[1];
  if (!num) throw new Error("sem número do pedido na resposta: " + j.Url);
  return num;
}

/* ---------------- receita: item ---------------- */
async function criaItem(num, it, idx) {
  const PAD7 = num + "       ", PAD6 = num + "      ";
  const MAT = (it.codigo + "                    ").slice(0, 20);
  const HOJE = hojeBR();
  const qtd = String(it.qtd).replace(".", ",") + (String(it.qtd).includes(".") || String(it.qtd).includes(",") ? "" : ",000");
  await go(P + "/fa/pedido/cadastro/m/" + encodeURIComponent(PAD6));
  const ih = await (await go(P + "/fa/pedido/cadastroitem/m/" + encodeURIComponent(PAD6) + "?seq=1")).text();
  const tok = (ih.match(/name=["']__RequestVerificationToken["'][^>]*value=["']([^"']+)["']/) || [])[1];
  if (!tok) throw new Error("sem token na tela do item");
  await go(P + "/Home/_Autocomplete/", form({ autocompleteType: "Material", value: it.codigo, parametersIn: "003;" + num + ";001", autocompleteActionType: "search" }));
  await go(P + "/fa/pedido/_QueryDetalhesMaterial/?value=" + encodeURIComponent(MAT) + "&parametersIn=" + encodeURIComponent(PAD6 + ";003   "));
  await go(P + "/FA/quantidade/_QuantidadeInput/?hasGradeNumeracao=false&codigoUnidadeMedida=" + encodeURIComponent(it.um || "KG") + "&valorSugestaoConversor=0,000000");
  await go(P + "/fa/pedido/VerificaPrecoValidadeTabela/", form({ codigoMaterial: MAT, codigoPedido: PAD7, precoUnitario: "0,0000", tabelaPreco: "003   " }));
  const ap = await (await go(P + "/fa/pedido/AtualizaPrecoTabela?codigoMaterial=" + encodeURIComponent(MAT) + "&codigoPedido=" + encodeURIComponent(PAD7) + "&tabelaPreco=" + encodeURIComponent("003   ") + "&quantidade=0,000000&valorUnitario=0,0000&unidadeConvertida=false&grade=&numeracoes=&centroArmazenagem=" + encodeURIComponent("001 ") + "&identificador=&percentualICMS=20.0000&incidenciaICMS=0&reducaoICMS=0.00000")).text();
  let preco = (ap.match(/(\d+[.,]\d{2,4})/) || [])[1] || "0,0000";
  preco = preco.replace(".", ",");
  if (!/,\d{4}$/.test(preco)) preco = preco + "00";
  await go(P + "/fa/pedido/VerificaUtilizaIdentEspecif/", form({ codigoMaterial: MAT, permiteAlterarItem: "true" }));
  await go(P + "/fa/pedido/BuscaParametrosMaterial/?codigoMaterial=" + encodeURIComponent(MAT) + "&unidadeNegocio=001&municipio=" + encodeURIComponent("BRASILIA                       ") + "&estado=DF&empresa=" + encodeURIComponent(it.cliente || ""));
  await go(P + "/ge/TabelaDePreco/_Select");
  await go(P + "/Home/_QueryComplete/?nameAutocompleteType=Material&value=" + encodeURIComponent(it.codigo + " | " + (it.desc || "")));
  await go(P + "/ES/Disponibilidade/VerificaDisponibilidade/", form({ origem: "P", codigoMaterial: MAT, unidadeNegocio: "001", centroArmazenagem: "001 ", quantidadeAnterior: "0", quantidadeAtual: qtd, pedido: PAD7, sequenciaItem: "0", prazoProgramado: HOJE }));
  const body = new URLSearchParams({
    codigoPedido: PAD7, codigoMaterial: MAT, sequencia: "0", grade: "  ",
    prazoEntrega: HOJE, prazoProgramado: HOJE, tabelaPreco: "003   ", quantidade: qtd,
    unidadeMedida: (it.um || "KG").padEnd(3), precoUnitario: preco, percentualDesconto: "0,00", precoOriginal: preco,
    quantidadeConvertida: "0,000000", unidadeMedidaConvertida: "   ", precoUnitarioConvertido: "0,0000",
    pedidoCompra: " ".repeat(25), itemPedidoCompra: " ".repeat(10), identificador: "", especif1: "", especif2: "",
    centroArmazenagem: "001 ", userAction: "save", usuarioDesconto: "", senhaDesconto: "",
    solicitaDesconto: "False", controleItemPedido: "20", idButton: "save", __RequestVerificationToken: tok,
  });
  const r = await go(P + "/FA/pedido/cadastroitem/", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }, body: body.toString() });
  const j = JSON.parse(await r.text());
  if (!j.Success) throw new Error("item " + (idx + 1) + ": " + JSON.stringify(j.Messages || j).slice(0, 150));
}

/* ---------------- fila ---------------- */
async function sb(path, opts = {}) {
  const r = await fetch(SB_URL + "/rest/v1" + path, { ...opts, headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json", ...(opts.headers || {}) } });
  if (!r.ok) throw new Error("Supabase HTTP " + r.status + ": " + (await r.text()).slice(0, 150));
  return r.status === 204 ? null : r.json().catch(() => null);
}
async function main() {
  const fila = (await sb("/fila_pedidos?status=eq.pendente&order=criado_em.asc&limit=5")) || [];
  console.log("fila pendente: " + fila.length);
  if (!fila.length) return;
  await loginPortal();
  for (const req of fila) {
    await sb("/fila_pedidos?id=eq." + req.id, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "processando", atualizado_em: new Date().toISOString() }) });
    try {
      const num = await criaCabecalho({ cliente_codigo: trim(req.cliente_codigo), query_cliente: req.cliente_query || (req.cliente_nome + " | " + req.cliente_nome), obs: req.obs });
      console.log("pedido " + num + " criado (fila #" + req.id + ")");
      const itens = Array.isArray(req.itens) ? req.itens : [];
      for (let i = 0; i < itens.length; i++) { await criaItem(num, { ...itens[i], cliente: trim(req.cliente_codigo) }, i); console.log("  item " + (i + 1) + "/" + itens.length + " ok"); }
      await sb("/fila_pedidos?id=eq." + req.id, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "criado", pedido_criado: num, atualizado_em: new Date().toISOString() }) });
    } catch (e) {
      console.error("fila #" + req.id + " ERRO: " + (e.message || e));
      await sb("/fila_pedidos?id=eq." + req.id, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "erro", erro: String(e.message || e).slice(0, 400), atualizado_em: new Date().toISOString() }) });
    }
  }
}
main().catch((e) => { console.error("FALHA GERAL:", e.message || e); process.exit(1); });

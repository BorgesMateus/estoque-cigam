// Supabase Edge Function: telegram-webhook  (v2 - fluxo rapido, cola tudo de uma vez)
// Bot de pedidos no Telegram. Recebe mensagens, interpreta o pedido em linguagem
// natural (via a funcao interpretar-pedido), confirma num toque e cria no CIGAM (criar-pedido).
// Novo fluxo: o vendedor COLA o pedido inteiro (cliente na 1a linha, itens embaixo) e
// o bot ja mostra o resumo com botao Confirmar. Estado por chat na tabela agente_conversa.
//
// Secrets (Supabase -> Edge Functions -> Secrets):
//   TELEGRAM_BOT_TOKEN   (do @BotFather)                          [obrigatorio]
//   TELEGRAM_ALLOWED     (IDs Telegram liberados, separados por virgula)  [recomendado]
//   TELEGRAM_SECRET      (mesmo secret_token usado no setWebhook) [opcional, seguranca]

const SB_URL = Deno.env.get("SUPABASE_URL") || "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const TG_API = "https://api.telegram.org/bot" + TG_TOKEN;
const ALLOWED = (Deno.env.get("TELEGRAM_ALLOWED") || "").split(",").map((s) => s.trim()).filter(Boolean);
const WH_SECRET = Deno.env.get("TELEGRAM_SECRET") || "";
const H = { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json" };

const WELCOME = "Opa! \u{1F6D2} Bora lancar um pedido no CIGAM.\n\nVoce pode <b>colar tudo de uma vez</b>: o <b>cliente na 1a linha</b> e os <b>itens embaixo</b> (um por linha ou separados por virgula). Ex.:\n\n<i>Bar do Ze\n10 coxinha de carne\n5 pao de queijo</i>\n\nOu manda so o nome/codigo do cliente que eu pergunto os itens depois.";

// ---------------- Telegram API ----------------
async function tg(method, payload) {
  try {
    const r = await fetch(TG_API + "/" + method, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    return await r.json();
  } catch (_) { return null; }
}
function send(chatId, text, keyboard) {
  const p = { chat_id: chatId, text: text, parse_mode: "HTML", disable_web_page_preview: true };
  if (keyboard) p.reply_markup = { inline_keyboard: keyboard };
  return tg("sendMessage", p);
}
function answer(cbId, text) { return tg("answerCallbackQuery", { callback_query_id: cbId, text: text || "" }); }

// ---------------- Estado (tabela agente_conversa) ----------------
async function getState(chatId) {
  try {
    const r = await fetch(SB_URL + "/rest/v1/agente_conversa?chat_id=eq." + chatId + "&select=etapa,dados", { headers: H });
    const rows = await r.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    if (row) return { etapa: row.etapa, dados: row.dados || {} };
  } catch (_) {}
  return { etapa: "cliente", dados: {} };
}
async function setState(chatId, etapa, dados) {
  await fetch(SB_URL + "/rest/v1/agente_conversa?on_conflict=chat_id", {
    method: "POST",
    headers: Object.assign({}, H, { Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({ chat_id: String(chatId), etapa: etapa, dados: dados, atualizado_em: new Date().toISOString() }),
  });
}
async function clearState(chatId) {
  await fetch(SB_URL + "/rest/v1/agente_conversa?chat_id=eq." + chatId, { method: "DELETE", headers: H });
}

// ---------------- Dados ----------------
async function catalogo() {
  try {
    const r = await fetch(SB_URL + "/rest/v1/materiais?select=codigo,descricao,um&limit=3000", { headers: H });
    const rows = await r.json();
    return (Array.isArray(rows) ? rows : []).map((m) => ({ c: m.codigo, d: m.descricao, u: m.um }));
  } catch (_) { return []; }
}
function acha(cat, cod) { return cat.find((p) => p.c === cod); }
async function buscarClientes(termo) {
  const t = String(termo).trim().replace(/^pedido (para|pro|pra)\s+/i, "").replace(/^cliente[:\s]+/i, "");
  if (!t) return [];
  let url;
  if (/^\d{3,6}$/.test(t)) url = SB_URL + "/rest/v1/clientes?select=codigo,nome,fantasia,municipio&codigo=eq." + t.padStart(6, "0") + "&limit=6";
  else { const q = encodeURIComponent("%" + t + "%"); url = SB_URL + "/rest/v1/clientes?select=codigo,nome,fantasia,municipio&or=(nome.ilike." + q + ",fantasia.ilike." + q + ")&limit=6"; }
  try {
    const r = await fetch(url, { headers: H });
    const rows = await r.json();
    return (Array.isArray(rows) ? rows : []).map((c) => ({ codigo: String(c.codigo).trim(), nome: String(c.fantasia || c.nome || "").trim(), cidade: String(c.municipio || "").trim() }));
  } catch (_) { return []; }
}
async function contexto(codigo) {
  try {
    const r = await fetch(SB_URL + "/rest/v1/vendas?cliente=eq." + codigo + "&select=data,pedido,codigo,quantidade&order=data.desc&limit=800", { headers: H });
    let rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return null;
    const seen = {}; rows = rows.filter((x) => { const k = x.pedido + "|" + x.codigo + "|" + x.quantidade; if (seen[k]) return false; seen[k] = 1; return true; });
    const cat = await catalogo();
    const nome = (c) => { const p = acha(cat, c); return p ? p.d : c; };
    const td = rows[0].data, tp = rows[0].pedido, a1 = {};
    rows.forEach((x) => { if (x.data === td && x.pedido === tp) a1[x.codigo] = (a1[x.codigo] || 0) + (+x.quantidade || 0); });
    const ag = {}; rows.forEach((x) => { ag[x.codigo] = (ag[x.codigo] || 0) + (+x.quantidade || 0); });
    const mais = Object.keys(ag).sort((a, b) => ag[b] - ag[a]).slice(0, 5).map(nome);
    return { data: td, itens: Object.keys(a1).map((c) => ({ d: nome(c), q: Math.round(a1[c]) })), mais: mais };
  } catch (_) { return null; }
}

// ---------------- Funcoes internas (reusa o que ja existe) ----------------
async function interpretar(mensagem, cat, clienteCodigo) {
  try {
    const r = await fetch(SB_URL + "/functions/v1/interpretar-pedido", { method: "POST", headers: H, body: JSON.stringify({ mensagem: mensagem, catalogo: cat, clienteCodigo: clienteCodigo || "" }) });
    return await r.json();
  } catch (_) { return null; }
}
// aprende: salva o apelido que o vendedor escolheu numa duvida (vocabulario do time todo)
async function salvarVocab(apelido, codigo) {
  try {
    const a = String(apelido || "").trim(); const c = String(codigo || "").trim();
    if (!a || !c) return;
    await fetch(SB_URL + "/rest/v1/agente_vocab?apelido=eq." + encodeURIComponent(a), { method: "DELETE", headers: H });
    await fetch(SB_URL + "/rest/v1/agente_vocab", { method: "POST", headers: Object.assign({}, H, { Prefer: "return=minimal" }), body: JSON.stringify({ apelido: a, codigo: c }) });
  } catch (_) { /* ignore */ }
}
async function criar(clienteCode, itens) {
  try {
    const r = await fetch(SB_URL + "/functions/v1/criar-pedido", {
      method: "POST", headers: H,
      body: JSON.stringify({ clienteCode: clienteCode, observacao: "PEDIDO VIA TELEGRAM", items: itens.map((i) => ({ codigoProduto: i.cod, quantidade: i.qtd, unidadeMedida: i.um || "KG" })) }),
    });
    return await r.json();
  } catch (e) { return { ok: false, erro: String((e && e.message) || e) }; }
}
// checa AO VIVO no CIGAM a disponibilidade dos itens do pedido
async function checarDisp(itens) {
  try {
    const r = await fetch(SB_URL + "/functions/v1/checar-disponibilidade", {
      method: "POST", headers: H,
      body: JSON.stringify({ itens: itens.map((i) => ({ codigo: i.cod, quantidade: i.qtd })) }),
    });
    return await r.json();
  } catch (_) { return null; }
}

// ---------------- Fluxo ----------------
function curto(d) { return String(d || "").split(/\s+/).slice(0, 3).join(" "); }
function resumoItens(itens) { return itens.map((i, n) => (n + 1) + ". " + i.qtd + " " + i.um + " \u2014 " + i.desc + (i.ajustado && i.trecho ? "\n    (voce escreveu: " + i.trecho + ")" : "")).join("\n"); }
const KB_CONFIRMAR = [[{ text: "\u2705 Confirmar e criar", callback_data: "ok" }], [{ text: "\u274C Cancelar", callback_data: "no" }]];

async function mostrarContexto(chatId, codigo) {
  const ctx = await contexto(codigo);
  if (!ctx) return;
  let t = "\u{1F4C7} <b>Contexto</b>";
  if (ctx.itens.length) t += "\n\u2022 Ultimo pedido (" + String(ctx.data).split("-").reverse().join("/") + "): " + ctx.itens.map((i) => i.q + " " + curto(i.d)).join(", ");
  if (ctx.mais.length) t += "\n\u2022 Mais comprados: " + ctx.mais.map(curto).join(", ");
  await send(chatId, t);
}
async function mostrarResumoConfirmar(chatId, st) {
  const dados = st.dados || {}; const itens = dados.itens || []; const cli = dados.cliente || {};
  if (!itens.length) { await send(chatId, "Ainda sem itens. Manda o pedido \u2014 ex.: <i>10 coxinha de carne, 5 pao de queijo</i>."); return; }
  await send(chatId, "\u{1F4DD} <b>Confere o pedido</b>\nCliente: <b>" + (cli.nome || "?") + "</b> (" + (cli.codigo || "?") + ")\n" + resumoItens(itens) + "\n\nToca \u2705 pra criar no CIGAM, ou manda mais itens.", KB_CONFIRMAR);
}

async function escolherCliente(chatId, cli, itensBlock) {
  await setState(chatId, "itens", { cliente: cli, itens: [] });
  await send(chatId, "Cliente: <b>" + cli.nome + "</b> (" + cli.codigo + " \u00B7 " + (cli.cidade || "?") + ") \u2714");
  await mostrarContexto(chatId, cli.codigo);
  if (itensBlock && String(itensBlock).trim()) {
    const st = await getState(chatId);
    await processarPedido(chatId, String(itensBlock).trim(), st);
  } else {
    await send(chatId, "Agora manda o pedido \u2014 pode colar tudo, um item por linha ou separado por virgula.");
  }
}
async function etapaCliente(chatId, termo) {
  const linhas = String(termo).split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const clienteTermo = linhas[0] || "";
  const itensBlock = linhas.slice(1).join("\n");
  const ops = await buscarClientes(clienteTermo);
  if (!ops.length) { await send(chatId, "Nao achei cliente com \"" + clienteTermo + "\". Tenta outro pedaco do nome ou o codigo.\n(Dica: cliente na 1a linha, itens embaixo.)"); return; }
  if (ops.length === 1) { await escolherCliente(chatId, ops[0], itensBlock); return; }
  await setState(chatId, "cliente", { pendItens: itensBlock });
  const kb = ops.map((o) => [{ text: o.nome + " \u00B7 " + (o.cidade || "?") + " (" + o.codigo + ")", callback_data: "c:" + o.codigo }]);
  await send(chatId, "Achei mais de um \u2014 escolhe o cliente:", kb);
}

async function processarPedido(chatId, texto, st) {
  const cat = await catalogo();
  if (!cat.length) { await send(chatId, "Catalogo vazio no banco. Avisa o Mateus pra atualizar os materiais."); return; }
  const cliCod = (st.dados && st.dados.cliente && st.dados.cliente.codigo) || "";
  const j = await interpretar(texto, cat, cliCod);
  if (!j || !j.ok) { await send(chatId, "\u274C " + ((j && j.erro) || "nao consegui interpretar")); return; }
  const dados = st.dados || {}; dados.itens = dados.itens || [];
  const duvT = {}; (j.duvidas || []).forEach((d) => { duvT[String(d.trecho)] = 1; });
  let add = 0;
  (j.itens || []).forEach((it) => { if (duvT[String(it.trecho)]) return; const p = acha(cat, it.codigo); if (!p) return; dados.itens.push({ cod: p.c, desc: p.d, um: it.unidade || p.u, qtd: it.quantidade, ajustado: !!it.ajustado, trecho: it.trecho || "" }); add++; });
  const duvidas = j.duvidas || [];
  dados.duvPend = duvidas.map((d) => d.trecho || "");
  await setState(chatId, "itens", dados);
  if ((j.naoEncontrados || []).length) await send(chatId, "\u26A0 Nao achei no catalogo: " + j.naoEncontrados.join(", ") + " (tenta outro nome)");
  for (let di = 0; di < duvidas.length; di++) {
    const d = duvidas[di]; const qtd = (d.quantidade != null ? d.quantidade : ((String(d.trecho).match(/[\d.,]+/) || ["1"])[0].replace(",", ".")));
    const kb = (d.opcoes || []).map((o) => [{ text: String(o.descricao).slice(0, 60), callback_data: "d:" + o.codigo + ":" + qtd + ":" + di }]);
    if (kb.length) await send(chatId, "\u{1F914} Qual e o certo? (\"" + d.trecho + "\")", kb);
  }
  const st2 = await getState(chatId);
  if (duvidas.length) {
    const n = (st2.dados.itens || []).length;
    await send(chatId, "\u261D Toca a opcao certa nos botoes acima." + (n ? " Ja tenho " + n + " item(ns) \u2014 quando terminar, /pronto." : ""));
  } else {
    await mostrarResumoConfirmar(chatId, st2);
  }
}

async function confirmar(chatId, st) {
  const dados = st.dados || {}; const cli = dados.cliente; const itens = dados.itens || [];
  if (!cli || !itens.length) { await send(chatId, "Faltou cliente ou itens. Manda /novo pra recomecar."); return; }
  // TRAVA anti-duplicacao: se esse pedido ja esta sendo criado, ignora toque/reenvio repetido.
  if (dados.criando) { await send(chatId, "\u23F3 Ja estou criando esse pedido, so um instante\u2026"); return; }
  dados.criando = true; await setState(chatId, "criando", dados);
  // 1) BLOQUEIO: confere o estoque AO VIVO no CIGAM (nao vende o que nao tem)
  await send(chatId, "\u23F3 Conferindo o estoque no CIGAM\u2026");
  const chk = await checarDisp(itens);
  if (chk && chk.ok) {
    const mapa = {}; (chk.resultado || []).forEach((r) => { mapa[String(r.codigo)] = r; });
    const faltando = itens.filter((i) => { const r = mapa[String(i.cod)]; return r && r.ok === false; });
    if (faltando.length) {
      let msg = "\u{1F6AB} <b>Sem estoque suficiente</b> (nao da pra vender o que nao tem):\n";
      faltando.forEach((i) => { const r = mapa[String(i.cod)]; msg += "\u2022 " + i.desc + " \u2014 pediu <b>" + i.qtd + "</b>, tem <b>" + (r ? r.disponivel : 0) + "</b>\n"; });
      msg += "\nO que fazemos?";
      dados.semEstoque = faltando.map((i) => i.cod);
      dados.criando = false; // libera a trava: o usuario precisa decidir (tirar sem estoque / cancelar)
      await setState(chatId, "itens", dados);
      await send(chatId, msg, [[{ text: "\u2702\uFE0F Tirar os sem estoque e criar o resto", callback_data: "rmsem" }], [{ text: "\u274C Cancelar", callback_data: "no" }]]);
      return;
    }
  } else {
    await send(chatId, "\u26A0 Nao consegui conferir o estoque agora (CIGAM). Vou criar assim mesmo \u2014 confira no portal depois.");
  }
  // 2) tudo ok -> cria
  await send(chatId, "\u23F3 Criando o pedido no CIGAM\u2026");
  const r = await criar(cli.codigo, itens);
  if (r && r.ok) { await clearState(chatId); await send(chatId, "\u{1F389} <b>Pedido " + r.cigamOrderId + " criado no CIGAM!</b>\nCliente " + cli.nome + " \u00B7 " + itens.length + " item(ns). Manda /novo pra fazer outro."); }
  else { dados.criando = false; await setState(chatId, "itens", dados); await send(chatId, "\u274C Nao consegui criar: " + ((r && r.erro) || "erro") + "\nToca \u2705 pra tentar de novo, ou /cancelar."); }
}

function autorizado(uid) { return ALLOWED.indexOf(String(uid)) >= 0; }

async function onText(chatId, text) {
  const low = text.toLowerCase().trim();
  if (/^\/(start|novo)/.test(low)) { await setState(chatId, "cliente", {}); await send(chatId, WELCOME); return; }
  if (/^\/cancelar/.test(low)) { await clearState(chatId); await send(chatId, "Cancelado. Manda /novo pra comecar outro."); return; }
  const st = await getState(chatId);
  if (/^\/?(pronto|fechar|finalizar)$/.test(low)) { await mostrarResumoConfirmar(chatId, st); return; }
  if (st.etapa === "itens" || st.etapa === "revisao") {
    if (/^(sim|confirmar|ok|pode criar|criar|isso|manda ver)$/i.test(low) && (st.dados.itens || []).length) { await confirmar(chatId, st); return; }
    await processarPedido(chatId, text, st); return;
  }
  await etapaCliente(chatId, text);
}
async function onCallback(chatId, data) {
  const st = await getState(chatId);
  if (data.indexOf("c:") === 0) {
    const cod = data.slice(2);
    const ops = await buscarClientes(cod);
    const cli = ops.find((o) => o.codigo === cod) || ops[0];
    const pend = (st.dados && st.dados.pendItens) || "";
    if (cli) await escolherCliente(chatId, cli, pend);
    return;
  }
  if (data.indexOf("d:") === 0) {
    const parts = data.split(":"); const cod = parts[1]; const qtd = parseFloat(parts[2]) || 1;
    const idx = parts[3] != null ? parseInt(parts[3], 10) : -1;
    const cat = await catalogo(); const p = acha(cat, cod);
    if (!p) { await send(chatId, "produto nao encontrado no catalogo."); return; }
    const dados = st.dados || {}; dados.itens = dados.itens || [];
    const trecho = (dados.duvPend && idx >= 0) ? (dados.duvPend[idx] || "") : "";
    if (trecho) await salvarVocab(trecho, cod); // aprende pro time todo
    dados.itens.push({ cod: p.c, desc: p.d, um: p.u, qtd: qtd });
    await setState(chatId, "itens", dados);
    await send(chatId, "+ " + qtd + " " + p.u + " \u2014 " + p.d + " \u2714" + (trecho ? "  (aprendi: \"" + trecho + "\")" : ""));
    await mostrarResumoConfirmar(chatId, await getState(chatId));
    return;
  }
  if (data === "rmsem") {
    const dados = st.dados || {}; const rm = {}; (dados.semEstoque || []).forEach((c) => { rm[String(c)] = 1; });
    dados.itens = (dados.itens || []).filter((i) => !rm[String(i.cod)]);
    delete dados.semEstoque;
    await setState(chatId, "itens", dados);
    if (!(dados.itens || []).length) { await send(chatId, "Ficou sem itens. Manda /novo pra recomecar."); return; }
    await confirmar(chatId, await getState(chatId));
    return;
  }
  if (data === "ok") { await confirmar(chatId, st); return; }
  if (data === "no") { await clearState(chatId); await send(chatId, "Cancelado. Manda /novo pra comecar outro."); return; }
}

async function handle(update) {
  const cq = update.callback_query;
  const msg = update.message;
  if (cq) {
    const chatId = cq.message && cq.message.chat && cq.message.chat.id;
    const uid = cq.from && cq.from.id;
    if (!autorizado(uid)) { await answer(cq.id, "Sem acesso"); return; }
    await answer(cq.id);
    if (chatId != null && cq.data) await onCallback(chatId, cq.data);
    return;
  }
  if (msg && typeof msg.text === "string") {
    const chatId = msg.chat && msg.chat.id;
    const uid = msg.from && msg.from.id;
    if (!autorizado(uid)) { await send(chatId, "Voce ainda nao tem acesso a este bot.\nSeu ID Telegram e <b>" + uid + "</b> \u2014 passa pro Mateus liberar."); return; }
    await onText(chatId, msg.text.trim());
    return;
  }
}

Deno.serve(async (req) => {
  if (WH_SECRET) { const h = req.headers.get("x-telegram-bot-api-secret-token"); if (h !== WH_SECRET) return new Response("unauthorized", { status: 401 }); }
  if (!TG_TOKEN) return new Response("missing TELEGRAM_BOT_TOKEN", { status: 200 });
  let update = null;
  try { update = await req.json(); } catch (_) { return new Response("ok"); }
  // Responde JA pro Telegram (200) e processa o pedido em segundo plano com waitUntil.
  // Criar o pedido no CIGAM leva ~20-30s; se a gente segurasse a resposta, o Telegram
  // dava timeout, REENVIAVA a mensagem (duplicando o pedido) e a confirmacao nunca voltava.
  const bg = handle(update).catch((e) => console.error("handle:", String((e && e.message) || e)));
  try { (globalThis as any).EdgeRuntime?.waitUntil?.(bg); } catch (_) {}
  return new Response("ok");
});

// Supabase Edge Function: interpretar-pedido
// CÉREBRO do agente. Recebe uma frase natural ("manda 10 ferradura e 5 coxinha pro cliente X")
// + o catálogo de produtos, e devolve os itens estruturados (código CIGAM, quantidade, unidade).
// Motor híbrido: a IA estrutura a frase em itens; um casador DETERMINÍSTICO forte decide o código
// (unifica kg/k, gr/g, pact/pc/pct, unid/un e espaços), o vocabulário do time (agente_vocab) tem
// prioridade, e as dúvidas vêm ordenadas pelo histórico do cliente.
//
// Secrets (Supabase → Edge Functions → Manage secrets):
//   OPENAI_API_KEY   (recomendado — usa gpt-4o-mini, baratíssimo)   OU
//   ANTHROPIC_API_KEY (usa claude-haiku)
//   LLM_MODEL        (opcional, sobrescreve o modelo padrão)
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY são injetados automaticamente (vocab + histórico).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};
const SB_URL = Deno.env.get("SUPABASE_URL") || "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY") || "";
const SB_H = { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY };

const SYS = [
  "Você é o assistente de pedidos da Gostinho Mineiro, uma distribuidora de pão de queijo, biscoitos, salgados de festa e pães.",
  "Sua tarefa: ler um pedido escrito em português informal (com gírias e apelidos regionais) e convertê-lo em itens estruturados.",
  "Regras rígidas:",
  "1. Use SOMENTE códigos que estão no CATÁLOGO fornecido. Nunca invente código.",
  "2. Use o VOCABULÁRIO de apelidos para resolver gírias (ex.: 'ferradura' pode ser um apelido de um biscoito meia lua).",
  "3. Extraia a quantidade (número) e a unidade. Se a unidade não for dita, use a unidade padrão (UM) do produto do catálogo.",
  "4. Uma mensagem pode ter VÁRIOS itens. Separe cada um. No campo 'trecho' devolva SO a descrição do item (sem a quantidade).",
  "5. Se um item casar com mais de um produto e você não tiver certeza, NÃO chute: coloque em 'duvidas' com as opções (código + descrição).",
  "6. Se não achar o produto no catálogo, coloque o texto em 'naoEncontrados'.",
  "7. 'confianca' é de 0 a 1 (1 = certeza total).",
  "Responda SOMENTE com um JSON válido, sem texto antes ou depois, no formato exato:",
  '{"itens":[{"codigo":"","descricao":"","quantidade":0,"unidade":"","confianca":0,"trecho":""}],"duvidas":[{"trecho":"","opcoes":[{"codigo":"","descricao":""}]}],"naoEncontrados":[""],"resumo":""}',
].join("\n");

function montarUser(mensagem: string, catalogo: any[], vocab: any[]): string {
  const cat = (catalogo || []).map((p) => `${p.c || p.codigo} | ${p.d || p.descricao} | ${p.u || p.um || ""}`).join("\n");
  const voc = (vocab || []).map((v) => `${v.apelido} => ${v.codigo}`).join("\n") || "(vazio)";
  return [
    "CATÁLOGO (codigo | descricao | UM):",
    cat,
    "",
    "VOCABULÁRIO DE APELIDOS (apelido => codigo):",
    voc,
    "",
    "PEDIDO DO CLIENTE (transforme em JSON conforme as regras):",
    mensagem,
  ].join("\n");
}

async function lerVocab(): Promise<any[]> {
  if (!SB_URL || !SB_KEY) return [];
  try {
    const r = await fetch(`${SB_URL}/rest/v1/agente_vocab?select=apelido,codigo`, { headers: SB_H });
    const rows = await r.json().catch(() => []);
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

// histórico de compra do cliente: codigo -> quantidade total (pra ordenar dúvidas)
async function lerHistorico(clienteCodigo: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (!clienteCodigo || !SB_URL || !SB_KEY) return out;
  try {
    const r = await fetch(`${SB_URL}/rest/v1/vendas?cliente=eq.${encodeURIComponent(clienteCodigo)}&select=codigo,quantidade&limit=4000`, { headers: SB_H });
    const rows = await r.json().catch(() => []);
    (Array.isArray(rows) ? rows : []).forEach((x: any) => { const c = String(x.codigo).trim(); out[c] = (out[c] || 0) + (Number(x.quantidade) || 0); });
  } catch { /* ignore */ }
  return out;
}

function extrairJSON(txt: string): any {
  if (!txt) throw new Error("LLM não retornou conteúdo");
  let s = txt.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  try {
    return JSON.parse(s);
  } catch (_) {
    throw new Error("o pedido e grande demais e a resposta foi cortada. Manda em 2 partes (uns 30 itens por vez) que eu processo.");
  }
}

async function chamarOpenAI(key: string, model: string, user: string): Promise<string> {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({
      model, temperature: 0,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: SYS }, { role: "user", content: user }],
    }),
  });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error("OpenAI HTTP " + r.status + ": " + (d?.error?.message || "").slice(0, 200));
  return d?.choices?.[0]?.message?.content || "";
}

async function chamarAnthropic(key: string, model: string, user: string): Promise<string> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model, max_tokens: 8192, temperature: 0,
      system: SYS,
      messages: [{ role: "user", content: user + "\n\nResponda apenas com o JSON." }],
    }),
  });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error("Anthropic HTTP " + r.status + ": " + (d?.error?.message || "").slice(0, 200));
  return (d?.content || []).map((b: any) => b.text || "").join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json();
    const mensagem = String(body?.mensagem || "").trim();
    if (!mensagem) throw new Error("mensagem vazia");
    const catalogo = Array.isArray(body?.catalogo) ? body.catalogo : [];
    if (!catalogo.length) throw new Error("catálogo não enviado (o painel precisa mandar STATE.materiais)");
    const clienteCodigo = String(body?.clienteCodigo || "").trim();

    const oa = Deno.env.get("OPENAI_API_KEY");
    const an = Deno.env.get("ANTHROPIC_API_KEY");
    if (!oa && !an) throw new Error("configure OPENAI_API_KEY (ou ANTHROPIC_API_KEY) nos secrets da função");

    const vocab = Array.isArray(body?.vocab) ? body.vocab : await lerVocab();
    const histQtd = await lerHistorico(clienteCodigo);
    const user = montarUser(mensagem, catalogo, vocab);

    let raw = "", provider = "", model = "";
    if (an) { provider = "anthropic"; model = Deno.env.get("LLM_MODEL") || "claude-haiku-4-5-20251001"; raw = await chamarAnthropic(an, model, user); }
    else { provider = "openai"; model = Deno.env.get("LLM_MODEL") || "gpt-4o-mini"; raw = await chamarOpenAI(oa!, model, user); }

    const out = extrairJSON(raw);

    // ---- índices do catálogo ----
    const validos = new Set(catalogo.map((p: any) => String(p.c || p.codigo)));
    const porCodigo: Record<string, any> = {};
    catalogo.forEach((p: any) => { porCodigo[String(p.c || p.codigo)] = p; });

    // itens que a IA estruturou (só os com código válido; o resto vira naoEncontrado)
    const itens = (out.itens || []).filter((it: any) => validos.has(String(it.codigo))).map((it: any) => {
      const p = porCodigo[String(it.codigo)];
      return {
        codigo: String(it.codigo),
        descricao: p ? (p.d || p.descricao) : it.descricao,
        quantidade: Number(it.quantidade) || 0,
        unidade: it.unidade || (p ? (p.u || p.um) : "") || "UN",
        confianca: it.confianca != null ? Number(it.confianca) : null,
        trecho: it.trecho || "",
      };
    });
    const invalidos = (out.itens || []).filter((it: any) => !validos.has(String(it.codigo)));
    const naoEncontrados = [...(out.naoEncontrados || []), ...invalidos.map((it: any) => it.trecho || it.descricao || "")].filter(Boolean);

    // ---- normalização FORTE (unifica unidades/abreviações antes de casar) ----
    const norm = (s: string) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const normU = (s: string) => norm(s)
      .replace(/(\d)\s*kg\b/g, "$1k").replace(/(\d)\s*gr\b/g, "$1g")
      .replace(/(\d)\s*g\b/g, "$1g").replace(/(\d)\s*k\b/g, "$1k")
      .replace(/\bpact\b/g, "pct").replace(/\bpc\b/g, "pct")
      .replace(/\bunid\b/g, "un").replace(/\bund\b/g, "un").replace(/\bunidade\b/g, "un");
    const STOP: Record<string, number> = { de: 1, e: 1, com: 1, da: 1, do: 1, para: 1, pra: 1 };
    const toks = (s: string) => normU(s).split(/[^a-z0-9]+/).filter(Boolean);
    const tokenizar = (trecho: string) => { let ts = toks(trecho); if (ts.length && /^\d+$/.test(ts[0])) ts = ts.slice(1); return ts.filter((t) => !STOP[t]); };
    const palavras = (desc: string) => new Set(toks(desc));
    const catToks = catalogo.map((p: any) => ({ p, w: palavras(p.d || p.descricao) }));
    const alternativas = (trecho: string) => {
      const ts = tokenizar(trecho); if (!ts.length) return [] as any[];
      return catToks.filter((ct) => ts.every((t) => ct.w.has(t))).map((ct) => ct.p);
    };

    // ---- vocabulário do time (apelido -> codigo), casado por tokens ----
    const vocabTok = (vocab || [])
      .map((v: any) => ({ toks: tokenizar(String(v.apelido || "")), codigo: String(v.codigo || "").trim() }))
      .filter((x: any) => x.toks.length && validos.has(x.codigo));
    const acharVocab = (trecho: string) => {
      const setT = new Set(tokenizar(trecho)); if (!setT.size) return null;
      let best: any = null;
      for (const v of vocabTok) if (v.toks.every((t: string) => setT.has(t))) { if (!best || v.toks.length > best.toks.length) best = v; }
      return best ? best.codigo : null;
    };

    const rankHist = (codigo: any) => histQtd[String(codigo).trim()] || 0;
    const fazItem = (o: any, it: any, via: string) => {
      const desc = String(o.d || o.descricao);
      const ajustado = tokenizar(it.trecho).some((t) => !palavras(desc).has(t)); // texto do vendedor difere do produto
      return { codigo: String(o.c || o.codigo), descricao: desc, quantidade: it.quantidade, unidade: it.unidade || o.u || o.um || "UN", confianca: it.confianca, trecho: it.trecho, ajustado, via };
    };

    const duvidas: any[] = [...(out.duvidas || [])];
    const itensFinais: any[] = [];
    itens.forEach((it: any) => {
      // 1) VOCABULÁRIO aprendido pelo time (autoritativo)
      const vc = acharVocab(it.trecho);
      if (vc && porCodigo[vc]) { itensFinais.push(fazItem(porCodigo[vc], it, "vocab")); return; }
      // 2) casamento DETERMINÍSTICO
      const alts = alternativas(it.trecho);
      if (alts.length === 1) { itensFinais.push(fazItem(alts[0], it, "exato")); return; }
      if (alts.length === 0) {
        // sem casamento EXATO: tenta PARCIAL (a maioria dos tokens) -> vira DÚVIDA ordenada por histórico + sobreposição.
        // (evita o chute ruim da IA, tipo "hot dog" virar "hamburguer")
        const ts = tokenizar(it.trecho);
        const min = Math.max(1, Math.ceil(ts.length / 2));
        const parciais = catToks.map((ct: any) => ({ p: ct.p, hits: ts.filter((t) => ct.w.has(t)).length }))
          .filter((x: any) => x.hits >= min)
          .sort((a: any, b: any) => { const ha = rankHist(a.p.c || a.p.codigo), hb = rankHist(b.p.c || b.p.codigo); if (hb !== ha) return hb - ha; return b.hits - a.hits; });
        if (parciais.length) {
          const kk = normU(String(it.trecho));
          for (let i = duvidas.length - 1; i >= 0; i--) if (normU(String(duvidas[i].trecho)) === kk) duvidas.splice(i, 1);
          duvidas.push({ trecho: it.trecho || ((it.quantidade || "") + " " + it.descricao), quantidade: it.quantidade, opcoes: parciais.slice(0, 8).map((x: any) => ({ codigo: String(x.p.c || x.p.codigo), descricao: String(x.p.d || x.p.descricao), hist: rankHist(x.p.c || x.p.codigo) })) });
          return;
        }
        // nenhuma sobreposição (gíria pura) -> confia no palpite da IA se válido
        const p = porCodigo[String(it.codigo)];
        itensFinais.push({ ...it, ajustado: tokenizar(it.trecho).some((t) => !palavras(p ? (p.d || p.descricao) : it.descricao).has(t)), via: "ia" });
        return;
      }
      // 3) VÁRIOS casamentos -> DÚVIDA ordenada pelo histórico do cliente (depois pelo palpite da IA)
      const k = normU(String(it.trecho));
      for (let i = duvidas.length - 1; i >= 0; i--) if (normU(String(duvidas[i].trecho)) === k) duvidas.splice(i, 1);
      const llm = String(it.codigo);
      const ord = alts.slice().sort((a: any, b: any) => {
        const ha = rankHist(a.c || a.codigo), hb = rankHist(b.c || b.codigo);
        if (hb !== ha) return hb - ha;
        return (String(b.c || b.codigo) === llm ? 1 : 0) - (String(a.c || a.codigo) === llm ? 1 : 0);
      });
      duvidas.push({
        trecho: it.trecho || ((it.quantidade || "") + " " + it.descricao),
        quantidade: it.quantidade,
        opcoes: ord.slice(0, 8).map((a: any) => ({ codigo: String(a.c || a.codigo), descricao: String(a.d || a.descricao), hist: rankHist(a.c || a.codigo) })),
      });
    });
    const _vd: Record<string, number> = {};
    const duvidasU = duvidas.filter((d: any) => { const kk = normU(String(d.trecho)); if (_vd[kk]) return false; _vd[kk] = 1; return true; });
    // re-ranqueia TODAS as dúvidas (inclusive as que vieram direto da IA) pelo histórico do cliente
    duvidasU.forEach((d: any) => {
      if (Array.isArray(d.opcoes)) d.opcoes = d.opcoes
        .map((o: any) => ({ codigo: String(o.codigo), descricao: String(o.descricao), hist: (o.hist != null ? o.hist : rankHist(o.codigo)) }))
        .sort((a: any, b: any) => (b.hist || 0) - (a.hist || 0));
    });

    return new Response(JSON.stringify({
      ok: true, provider, modelo: model,
      itens: itensFinais, duvidas: duvidasU, naoEncontrados, resumo: out.resumo || "",
    }), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, erro: String((e as Error).message || e) }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});

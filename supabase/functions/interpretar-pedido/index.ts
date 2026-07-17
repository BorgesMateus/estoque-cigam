// Supabase Edge Function: interpretar-pedido
// C\u00C9REBRO do agente. Recebe uma frase natural ("manda 10 ferradura e 5 coxinha pro cliente X")
// + o cat\u00E1logo de produtos, e devolve os itens estruturados (c\u00F3digo CIGAM, quantidade, unidade).
// Usa LLM. O vocabul\u00E1rio de apelidos (ferradura=meia lua) sai da tabela agente_vocab do Supabase.
//
// Secrets (Supabase \u2192 Edge Functions \u2192 Manage secrets):
//   OPENAI_API_KEY   (recomendado \u2014 usa gpt-4o-mini, barat\u00EDssimo)   OU
//   ANTHROPIC_API_KEY (usa claude-haiku)
//   LLM_MODEL        (opcional, sobrescreve o modelo padr\u00E3o)
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY s\u00E3o injetados automaticamente (pra ler o vocabul\u00E1rio).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};
const SB_URL = Deno.env.get("SUPABASE_URL") || "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY") || "";

const SYS = [
  "Voc\u00EA \u00E9 o assistente de pedidos da Gostinho Mineiro, uma distribuidora de p\u00E3o de queijo, biscoitos, salgados de festa e p\u00E3es.",
  "Sua tarefa: ler um pedido escrito em portugu\u00EAs informal (com g\u00EDrias e apelidos regionais) e convert\u00EA-lo em itens estruturados.",
  "Regras r\u00EDgidas:",
  "1. Use SOMENTE c\u00F3digos que est\u00E3o no CAT\u00C1LOGO fornecido. Nunca invente c\u00F3digo.",
  "2. Use o VOCABUL\u00C1RIO de apelidos para resolver g\u00EDrias (ex.: 'ferradura' pode ser um apelido de um biscoito meia lua).",
  "3. Extraia a quantidade (n\u00FAmero) e a unidade. Se a unidade n\u00E3o for dita, use a unidade padr\u00E3o (UM) do produto do cat\u00E1logo.",
  "4. Uma mensagem pode ter V\u00C1RIOS itens. Separe cada um.",
  "5. Se um item casar com mais de um produto e voc\u00EA n\u00E3o tiver certeza, N\u00C3O chute: coloque em 'duvidas' com as op\u00E7\u00F5es (c\u00F3digo + descri\u00E7\u00E3o).",
  "6. Se n\u00E3o achar o produto no cat\u00E1logo, coloque o texto em 'naoEncontrados'.",
  "7. 'confianca' \u00E9 de 0 a 1 (1 = certeza total).",
  "Responda SOMENTE com um JSON v\u00E1lido, sem texto antes ou depois, no formato exato:",
  '{"itens":[{"codigo":"","descricao":"","quantidade":0,"unidade":"","confianca":0,"trecho":""}],"duvidas":[{"trecho":"","opcoes":[{"codigo":"","descricao":""}]}],"naoEncontrados":[""],"resumo":""}',
].join("\n");

function montarUser(mensagem: string, catalogo: any[], vocab: any[]): string {
  const cat = (catalogo || []).map((p) => `${p.c || p.codigo} | ${p.d || p.descricao} | ${p.u || p.um || ""}`).join("\n");
  const voc = (vocab || []).map((v) => `${v.apelido} => ${v.codigo}`).join("\n") || "(vazio)";
  return [
    "CAT\u00C1LOGO (codigo | descricao | UM):",
    cat,
    "",
    "VOCABUL\u00C1RIO DE APELIDOS (apelido => codigo):",
    voc,
    "",
    "PEDIDO DO CLIENTE (transforme em JSON conforme as regras):",
    mensagem,
  ].join("\n");
}

async function lerVocab(): Promise<any[]> {
  if (!SB_URL || !SB_KEY) return [];
  try {
    const r = await fetch(`${SB_URL}/rest/v1/agente_vocab?select=apelido,codigo`, {
      headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY },
    });
    const rows = await r.json().catch(() => []);
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

function extrairJSON(txt: string): any {
  if (!txt) throw new Error("LLM n\u00E3o retornou conte\u00FAdo");
  // remove cercas de c\u00F3digo e pega o primeiro bloco {...}
  let s = txt.trim().replace(/^```(json)?/i, "").replace(/```$/,"").trim();
  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  return JSON.parse(s);
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
      model, max_tokens: 1500, temperature: 0,
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
    if (!catalogo.length) throw new Error("cat\u00E1logo n\u00E3o enviado (o painel precisa mandar STATE.materiais)");

    const oa = Deno.env.get("OPENAI_API_KEY");
    const an = Deno.env.get("ANTHROPIC_API_KEY");
    if (!oa && !an) throw new Error("configure OPENAI_API_KEY (ou ANTHROPIC_API_KEY) nos secrets da fun\u00E7\u00E3o");

    const vocab = Array.isArray(body?.vocab) ? body.vocab : await lerVocab();
    const user = montarUser(mensagem, catalogo, vocab);

    let raw = "", provider = "", model = "";
    if (an) { provider = "anthropic"; model = Deno.env.get("LLM_MODEL") || "claude-haiku-4-5-20251001"; raw = await chamarAnthropic(an, model, user); }
    else { provider = "openai"; model = Deno.env.get("LLM_MODEL") || "gpt-4o-mini"; raw = await chamarOpenAI(oa!, model, user); }

    const out = extrairJSON(raw);
    // valida: s\u00F3 deixa itens com c\u00F3digo que existe no cat\u00E1logo
    const validos = new Set(catalogo.map((p: any) => String(p.c || p.codigo)));
    const porCodigo: Record<string, any> = {};
    catalogo.forEach((p: any) => { porCodigo[String(p.c || p.codigo)] = p; });
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
    // itens com c\u00F3digo inv\u00E1lido viram "duvida"/naoEncontrado
    const invalidos = (out.itens || []).filter((it: any) => !validos.has(String(it.codigo)));
    const naoEncontrados = [...(out.naoEncontrados || []), ...invalidos.map((it: any) => it.trecho || it.descricao || "")].filter(Boolean);

    // TRAVA ANTI-CHUTE: se as palavras do pedido casam com V\u00C1RIOS produtos do cat\u00E1logo
    // (ex.: "pao de queijo" -> \u00EDmpar 15g, coquetel 55g, gourmet...), N\u00C3O escolhe sozinho:
    // vira D\u00DAVIDA com as op\u00E7\u00F5es pra pessoa clicar. S\u00F3 entra em "itens" se o casamento for \u00FAnico.
    const norm = (s: string) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036F]/g, "");
    const STOP: Record<string, number> = { de: 1, e: 1, com: 1, da: 1, do: 1, para: 1, pra: 1 };
    const tokenizar = (trecho: string) => {
      let ts = norm(trecho).split(/[^a-z0-9]+/).filter(Boolean);
      if (ts.length && /^\d+$/.test(ts[0])) ts = ts.slice(1); // tira a quantidade (1o numero)
      return ts.filter((t) => !STOP[t]);
    };
    const palavras = (desc: string) => new Set(norm(desc).split(/[^a-z0-9]+/).filter(Boolean));
    const alternativas = (trecho: string) => {
      const ts = tokenizar(trecho);
      if (!ts.length) return [] as any[];
      return catalogo.filter((p: any) => { const w = palavras(p.d || p.descricao); return ts.every((t) => w.has(t)); });
    };
    const duvidas: any[] = [...(out.duvidas || [])];
    const itensFinais: any[] = [];
    itens.forEach((it: any) => {
      const alts = alternativas(it.trecho);
      if (alts.length === 0) { itensFinais.push(it); return; } // sem casamento textual -> confia no LLM (apelido/vocab)
      if (alts.length === 1) { // 1 casamento exato -> usa ele (corrige ate palpite errado do LLM)
        const o: any = alts[0];
        itensFinais.push({ codigo: String(o.c || o.codigo), descricao: String(o.d || o.descricao), quantidade: it.quantidade, unidade: it.unidade || o.u || o.um || "UN", confianca: it.confianca, trecho: it.trecho });
        return;
      }
      // varios -> DUVIDA (nao chuta). Remove duvida do LLM com mesmo trecho e reconstroi com o catalogo.
      const k = norm(String(it.trecho));
      for (let i = duvidas.length - 1; i >= 0; i--) if (norm(String(duvidas[i].trecho)) === k) duvidas.splice(i, 1);
      const llm = String(it.codigo);
      const ord = alts.slice().sort((a: any, b: any) => (String(b.c || b.codigo) === llm ? 1 : 0) - (String(a.c || a.codigo) === llm ? 1 : 0));
      duvidas.push({ trecho: it.trecho || ((it.quantidade || "") + " " + it.descricao), opcoes: ord.slice(0, 8).map((a: any) => ({ codigo: String(a.c || a.codigo), descricao: String(a.d || a.descricao) })) });
    });
    const _vd: Record<string, number> = {};
    const duvidasU = duvidas.filter((d: any) => { const kk = norm(String(d.trecho)); if (_vd[kk]) return false; _vd[kk] = 1; return true; });

    return new Response(JSON.stringify({
      ok: true, provider, modelo: model,
      itens: itensFinais, duvidas: duvidasU, naoEncontrados, resumo: out.resumo || "",
    }), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, erro: String((e as Error).message || e) }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});

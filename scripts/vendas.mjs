/**
 * Robô de vendas — coleta pedidos e itens do CIGAM e grava na tabela `vendas`.
 * Roda diariamente (vendas.yml). Reprocessa os últimos DIAS (padrão 3) para
 * capturar mudanças de situação; DIAS=999 faz o backfill de tudo que a API expõe.
 * Somente leitura no CIGAM.
 */
const need = (k) => { const v = process.env[k]; if (!v) { console.error("falta env " + k); process.exit(1); } return v; };
const BASE = process.env.CIGAM_BASE || "https://gostinhomineiroportais.cigam.cloud/api/api";
const USER = need("CIGAM_USER"), PASS = need("CIGAM_PASS");
const SB_URL = need("SUPABASE_URL").replace(/\/$/, "");
const SB_KEY = need("SUPABASE_SERVICE_KEY");
const DIAS = Math.max(1, parseInt(process.env.DIAS || "3", 10));
const trim = (s) => (s == null ? "" : String(s)).trim();
const enc = encodeURIComponent;
const q = (parts) => Object.entries(parts).map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&");

async function login() {
  const r = await fetch(`${BASE}/genericos/ge/Login/Autenticar`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ NomeUsuario: USER, Senha: PASS, Portal: process.env.CIGAM_PORTAL || "" }),
  });
  const j = await r.json();
  if (!j?.hash) throw new Error("login CIGAM falhou");
  return j.hash;
}
async function cigam(hash, path) {
  const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${hash}` } });
  if (!r.ok) throw new Error(`CIGAM HTTP ${r.status} em ${path.slice(0, 80)}`);
  return r.json();
}
async function sb(path, opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1${path}`, {
    ...opts,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`Supabase HTTP ${r.status}: ${await r.text()}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}

async function main() {
  const hash = await login();
  const corte = new Date(Date.now() - DIAS * 86400000).toISOString().slice(0, 10);
  console.log(`== vendas: reprocessando desde ${corte} (DIAS=${DIAS}) ==`);

  // 1) pedidos (leve; filtro de data no cliente — o $filter da instância não filtra)
  const peds = await cigam(hash, `/comercial/fa/Pedido/Buscar?` + q({
    "$select": "Codigo,DataPedido,Situacao,CodigoCliente,CodigoControle,CodigoUnidadeNegocio,TotalPedido,CodigoRepresentante",
    "$top": "10000",
  }));
  const alvo = peds.filter(p => String(p.DataPedido || "").slice(0, 10) >= corte);
  console.log(`pedidos na API: ${peds.length} | no período: ${alvo.length}`);

  // 2) itens de cada pedido (concorrência 8) e upsert
  let cursor = 0, falhas = 0, linhas = 0;
  const lote = [];
  async function operario() {
    while (cursor < alvo.length) {
      const p = alvo[cursor++];
      const cod = trim(p.Codigo);
      try {
        const itens = await cigam(hash, `/comercial/fa/Pedido/BuscarItensPedido?codigoPedido=${enc(cod)}`);
        (Array.isArray(itens) ? itens : []).forEach((li, idx) => {
          lote.push({
            data: String(p.DataPedido || "").slice(0, 10),
            pedido: cod,
            seq: idx,  // posição no pedido (a Sequencia do CIGAM se repete)
            codigo: trim(li.CodigoMaterial),
            quantidade: Number(li.Quantidade) || 0,
            preco: li.PrecoUnitario == null ? null : Number(li.PrecoUnitario),
            total: li.TotalItemLiquido == null ? null : Number(li.TotalItemLiquido),
            situacao_item: trim(li.Situacao),
            situacao_pedido: trim(p.Situacao),
            cliente: trim(p.CodigoCliente),
            representante: trim(p.CodigoRepresentante),
            un: trim(p.CodigoUnidadeNegocio),
          });
        });
      } catch (e) { falhas++; }
    }
  }
  await Promise.all(Array.from({ length: 8 }, operario));
  console.log(`itens coletados: ${lote.length} (falhas de pedido: ${falhas})`);

  // apaga e regrava os pedidos do período (reprocessamento limpo)
  const codigosPedidos = [...new Set(lote.map(l => l.pedido))];
  for (let i = 0; i < codigosPedidos.length; i += 150) {
    const grupo = codigosPedidos.slice(i, i + 150).map(c => `"${c}"`).join(",");
    await sb(`/vendas?pedido=in.(${enc(grupo)})`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  }
  for (let i = 0; i < lote.length; i += 500) {
    await sb("/vendas", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(lote.slice(i, i + 500)),
    });
    linhas += Math.min(500, lote.length - i);
  }
  console.log(`gravado na tabela vendas: ${linhas} linhas (${codigosPedidos.length} pedidos)`);
  console.log("== fim ==");
}
main().catch((e) => { console.error("FALHA:", e.message || e); process.exit(1); });

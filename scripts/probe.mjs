/**
 * Sondagem v3 — range real de datas dos pedidos, campos validos no $select
 * e itens de um pedido recente. Somente leitura.
 */
const need = (k) => { const v = process.env[k]; if (!v) { console.error("falta env " + k); process.exit(1); } return v; };
const BASE = process.env.CIGAM_BASE || "https://gostinhomineiroportais.cigam.cloud/api/api";
const USER = need("CIGAM_USER"), PASS = need("CIGAM_PASS");

async function login() {
  const r = await fetch(`${BASE}/genericos/ge/Login/Autenticar`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ NomeUsuario: USER, Senha: PASS, Portal: process.env.CIGAM_PORTAL || "" }),
  });
  const j = await r.json();
  if (!j?.hash) throw new Error("login falhou");
  return j.hash;
}
async function get(hash, path) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${hash}` } });
  return { status: r.status, ms: Date.now() - t0, json: await r.json().catch(() => null) };
}
const enc = encodeURIComponent;
const q = (parts) => Object.entries(parts).map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&");

async function main() {
  const hash = await login();
  console.log("== login ok ==");

  // 1) todos os pedidos, leve: range de datas + contagem por mes
  const f = await get(hash, `/comercial/fa/Pedido/Buscar?` + q({ "$select": "Codigo,DataPedido", "$top": "10000" }));
  const arr = Array.isArray(f.json) ? f.json : [];
  console.log(`[1] todos c/ $select -> HTTP ${f.status} (${f.ms}ms) | pedidos: ${arr.length}`);
  const porMes = {};
  let min = "9999", max = "0000";
  for (const p of arr) {
    const d = String(p.DataPedido || "").slice(0, 10);
    if (d < min) min = d;
    if (d > max) max = d;
    porMes[d.slice(0, 7)] = (porMes[d.slice(0, 7)] || 0) + 1;
  }
  console.log(`    range: ${min} ate ${max}`);
  console.log(`    por mes: ${JSON.stringify(porMes)}`);

  // 2) campos validos no $select (um a um)
  const candidatos = ["Situacao", "CodigoCliente", "CodigoControle", "CodigoUnidadeNegocio", "UnidadeDeNegocio", "TotalPedido", "ValorTotal", "CodigoRepresentante", "DataEntrega"];
  const validos = [];
  for (const c of candidatos) {
    const t = await get(hash, `/comercial/fa/Pedido/Buscar?` + q({ "$select": `Codigo,${c}`, "$top": "1" }));
    console.log(`[2] campo ${c}: HTTP ${t.status}${t.status === 200 && Array.isArray(t.json) && t.json[0] ? " | ex: " + JSON.stringify(t.json[0][c])?.slice(0, 60) : ""}`);
    if (t.status === 200) validos.push(c);
  }
  console.log("    validos:", validos.join(", "));

  // 3) pedido mais recente + itens
  const recentes = arr.filter(p => String(p.DataPedido || "").slice(0, 10) === max);
  console.log(`[3] pedidos na data mais recente (${max}): ${recentes.length}`);
  const cod = recentes[0] ? String(recentes[0].Codigo).trim() : null;
  if (cod) {
    const it = await get(hash, `/comercial/fa/Pedido/BuscarItensPedido?codigoPedido=${enc(cod)}`);
    const itens = Array.isArray(it.json) ? it.json : [];
    console.log(`    itens do pedido ${cod} -> HTTP ${it.status} | ${itens.length} itens`);
    for (const li of itens.slice(0, 4)) {
      console.log("   ", JSON.stringify({
        mat: (li.CodigoMaterial || "").trim(), qtd: li.Quantidade, preco: li.PrecoUnitario,
        total: li.TotalItemLiquido, sit: li.Situacao
      }));
    }
    if (itens[0]) console.log("    chaves:", Object.keys(itens[0]).join(", ").slice(0, 700));
  }
  console.log("== fim v3 ==");
}
main().catch(e => { console.error("FALHA:", e.message || e); process.exit(1); });

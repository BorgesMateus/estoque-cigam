/**
 * Sondagem v2 da API de pedidos — valida filtro por DataPedido, $select,
 * volume retroativo e itens (Quantidade/PrecoUnitario/TotalItemLiquido).
 * Somente leitura.
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

  // 1) pedidos de ontem/hoje, completo (payload pequeno)
  const f1 = await get(hash, `/comercial/fa/Pedido/Buscar?` + q({ "$filter": "DataPedido ge 2026-07-09T00:00:00Z", "$top": "2" }));
  console.log(`[1] filtro DataPedido ge 09/07 -> HTTP ${f1.status} (${f1.ms}ms) | qtd: ${Array.isArray(f1.json) ? f1.json.length : "n/a"}`);
  const p1 = Array.isArray(f1.json) ? f1.json[0] : f1.json;
  console.log(JSON.stringify(p1, null, 1).slice(0, 2500));

  // 2) $select para payload leve
  const f2 = await get(hash, `/comercial/fa/Pedido/Buscar?` + q({ "$filter": "DataPedido ge 2026-07-09T00:00:00Z", "$select": "Codigo,DataPedido,Situacao,SituacaoVenda,CodigoCliente,CodigoControle", "$top": "1000" }));
  console.log(`[2] com $select -> HTTP ${f2.status} (${f2.ms}ms) | pedidos desde 09/07: ${Array.isArray(f2.json) ? f2.json.length : JSON.stringify(f2.json)?.slice(0, 150)}`);
  if (Array.isArray(f2.json) && f2.json[0]) console.log("    amostra:", JSON.stringify(f2.json[0]));

  // 3) volume retroativo (com $select, $top alto)
  for (const desde of ["2026-07-01", "2026-06-01", "2026-05-01", "2026-04-01"]) {
    const f = await get(hash, `/comercial/fa/Pedido/Buscar?` + q({ "$filter": `DataPedido ge ${desde}T00:00:00Z`, "$select": "Codigo,DataPedido", "$top": "5000" }));
    console.log(`[3] desde ${desde}: HTTP ${f.status} (${f.ms}ms) | pedidos: ${Array.isArray(f.json) ? f.json.length : "erro " + JSON.stringify(f.json)?.slice(0, 100)}`);
  }

  // 4) itens de um pedido real
  const cod = Array.isArray(f2.json) && f2.json[0] ? String(f2.json[0].Codigo).trim() : null;
  if (cod) {
    const it = await get(hash, `/comercial/fa/Pedido/BuscarItensPedido?codigoPedido=${enc(cod)}`);
    const arr = Array.isArray(it.json) ? it.json : [];
    console.log(`[4] itens do pedido ${cod} -> HTTP ${it.status} | itens: ${arr.length}`);
    for (const li of arr.slice(0, 3)) {
      console.log("   ", JSON.stringify({
        mat: (li.CodigoMaterial || "").trim(), qtd: li.Quantidade, preco: li.PrecoUnitario,
        total: li.TotalItemLiquido, sit: li.Situacao,
        desc: li.Material?.Descricao?.trim()?.slice(0, 40)
      }));
    }
    const chaves = arr[0] ? Object.keys(arr[0]).join(", ") : "";
    console.log("    chaves do item:", chaves.slice(0, 600));
  }
  console.log("== fim v2 ==");
}
main().catch(e => { console.error("FALHA:", e.message || e); process.exit(1); });

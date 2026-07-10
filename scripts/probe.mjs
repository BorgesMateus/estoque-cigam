/**
 * Sondagem da API de pedidos do CIGAM — roda manualmente no Actions (probe.yml).
 * Somente leitura. Imprime no log: campos do PedidoDTO, filtros OData que funcionam,
 * alcance retroativo e amostra de itens de um pedido.
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
  const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${hash}` } });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const enc = encodeURIComponent;

async function main() {
  const hash = await login();
  console.log("== login ok ==");

  // 1) amostra de pedidos
  const am = await get(hash, `/comercial/fa/Pedido/Buscar?${enc("$top")}=3`);
  console.log("Pedido/Buscar $top=3 -> HTTP", am.status, "| qtd:", Array.isArray(am.json) ? am.json.length : "n/a");
  const um = Array.isArray(am.json) ? am.json[0] : am.json;
  console.log("== PEDIDO COMPLETO (1º da amostra) ==");
  console.log(JSON.stringify(um, null, 1).slice(0, 6000));

  // 2) descobrir campos de data e testar filtros OData
  const wrapper = um && Object.keys(um).length === 1 ? Object.keys(um)[0] : null;
  const alvo = wrapper ? um[wrapper] : um;
  const campos = alvo ? Object.keys(alvo) : [];
  console.log("== CAMPOS ==", campos.join(", "));
  const camposData = campos.filter(c => /data|emissao|entrega/i.test(c));
  console.log("campos com cara de data:", camposData.join(", ") || "(nenhum)");

  const prefixo = wrapper ? wrapper + "/" : "";
  for (const c of camposData.slice(0, 4)) {
    for (const val of ["2026-07-01", "2026-07-01T00:00:00"]) {
      const f = await get(hash, `/comercial/fa/Pedido/Buscar?${enc("$filter")}=${enc(`${prefixo}${c} ge ${val}`)}&${enc("$top")}=1`);
      console.log(`filtro ${prefixo}${c} ge ${val} -> HTTP ${f.status} | retornou: ${Array.isArray(f.json) ? f.json.length : JSON.stringify(f.json)?.slice(0, 120)}`);
      if (f.status === 200 && Array.isArray(f.json)) break;
    }
  }

  // 3) alcance retroativo: pedidos desde 01/05 (contagem via $top alto)
  if (camposData[0]) {
    const c = camposData[0];
    for (const desde of ["2026-07-01", "2026-06-01", "2026-05-01"]) {
      const f = await get(hash, `/comercial/fa/Pedido/Buscar?${enc("$filter")}=${enc(`${prefixo}${c} ge ${desde}`)}&${enc("$top")}=2000`);
      console.log(`desde ${desde}: HTTP ${f.status} | pedidos: ${Array.isArray(f.json) ? f.json.length : "erro"}`);
    }
  }

  // 4) itens de um pedido da amostra
  const chaveCod = campos.find(c => /^(codigo|numero)$/i.test(c)) || campos.find(c => /codigo/i.test(c));
  const codPedido = alvo && chaveCod ? String(alvo[chaveCod]).trim() : null;
  console.log("== ITENS DO PEDIDO", codPedido, "(campo:", chaveCod, ") ==");
  if (codPedido) {
    const it = await get(hash, `/comercial/fa/Pedido/BuscarItensPedido?codigoPedido=${enc(codPedido)}`);
    console.log("HTTP", it.status);
    const li = Array.isArray(it.json) ? it.json[0] : it.json;
    console.log(JSON.stringify(li, null, 1).slice(0, 3000));
  }
  console.log("== fim da sondagem ==");
}
main().catch(e => { console.error("FALHA:", e.message || e); process.exit(1); });

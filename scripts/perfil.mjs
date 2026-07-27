/**
 * Robô do perfil de demanda — recalcula `demanda_perfil` a partir de `vendas`.
 * Roda logo depois da coleta de vendas (vendas.yml). Só toca no Supabase.
 *
 * Modelo: para cada produto x dia-da-semana (dow 0=dom..6=sáb),
 *   media = (soma das quantidades vendidas naquele dow) / (nº de datas distintas daquele dow)
 * ou seja, a demanda média de um produto num típico dia-da-semana, contando como 0
 * os dias em que não houve venda daquele item. Alimenta o semáforo da aba Cobertura.
 */
const need = (k) => { const v = process.env[k]; if (!v) { console.error("falta env " + k); process.exit(1); } return v; };
const SB_URL = need("SUPABASE_URL").replace(/\/$/, "");
const SB_KEY = need("SUPABASE_SERVICE_KEY");

async function sb(path, opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1${path}`, {
    ...opts,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`Supabase HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}

const dowDe = (data) => new Date(String(data).slice(0, 10) + "T00:00:00Z").getUTCDay();

async function main() {
  console.log("== perfil: lendo vendas ==");
  // paginação (PostgREST limita a 1000 por página)
  const linhas = [];
  for (let off = 0; ; off += 1000) {
    const pag = await sb(`/vendas?select=data,codigo,quantidade&order=data&limit=1000&offset=${off}`);
    const arr = Array.isArray(pag) ? pag : [];
    linhas.push(...arr);
    if (arr.length < 1000) break;
  }
  console.log(`linhas de venda lidas: ${linhas.length}`);
  if (!linhas.length) { console.log("sem vendas — nada a recalcular"); return; }

  // nº de datas distintas por dia-da-semana
  const datasPorDow = {};      // dow -> Set(data)
  // soma de quantidade por produto x dow
  const totalPorProdDow = {};  // codigo -> { dow -> soma }
  for (const l of linhas) {
    const data = String(l.data).slice(0, 10);
    if (!data) continue;
    const dow = dowDe(data);
    (datasPorDow[dow] || (datasPorDow[dow] = new Set())).add(data);
    const cod = String(l.codigo || "").trim();
    if (!cod) continue;
    const m = totalPorProdDow[cod] || (totalPorProdDow[cod] = {});
    m[dow] = (m[dow] || 0) + (Number(l.quantidade) || 0);
  }
  const nDatas = {};           // dow -> quantidade de datas distintas
  for (const dow of Object.keys(datasPorDow)) nDatas[dow] = datasPorDow[dow].size;

  // monta as linhas do perfil
  const agora = new Date().toISOString();
  const rows = [];
  for (const cod of Object.keys(totalPorProdDow)) {
    const m = totalPorProdDow[cod];
    for (const dow of Object.keys(m)) {
      const n = nDatas[dow] || 0;
      if (!n) continue;
      rows.push({
        codigo: cod,
        dow: Number(dow),
        media: Math.round((m[dow] / n) * 1000) / 1000,
        amostras: n,
        atualizado_em: agora,
      });
    }
  }
  console.log(`perfil: ${rows.length} linhas (${Object.keys(totalPorProdDow).length} produtos)`);

  // regrava do zero (derivado): apaga tudo e insere
  await sb(`/demanda_perfil?dow=gte.0`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  for (let i = 0; i < rows.length; i += 500) {
    await sb("/demanda_perfil", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(rows.slice(i, i + 500)),
    });
  }
  console.log(`gravado em demanda_perfil: ${rows.length} linhas · atualizado_em ${agora}`);
  console.log("== fim ==");
}
main().catch((e) => { console.error("FALHA:", e.message || e); process.exit(1); });

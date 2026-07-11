/**
 * Robô de cadastros — clientes (com cidade/UF/região), representantes e a base
 * de municípios do IBGE (lat/lon) para o mapa. Roda semanalmente e sob demanda.
 * Somente leitura no CIGAM.
 */
const need = (k) => { const v = process.env[k]; if (!v) { console.error("falta env " + k); process.exit(1); } return v; };
const BASE = process.env.CIGAM_BASE || "https://gostinhomineiroportais.cigam.cloud/api/api";
const USER = need("CIGAM_USER"), PASS = need("CIGAM_PASS");
const SB_URL = need("SUPABASE_URL").replace(/\/$/, "");
const SB_KEY = need("SUPABASE_SERVICE_KEY");
const trim = (s) => (s == null ? "" : String(s)).trim();
const enc = encodeURIComponent;
const norm = (s) => trim(s).toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

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
  return { status: r.status, json: await r.json().catch(() => null) };
}
async function sb(path, opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1${path}`, {
    ...opts,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`Supabase HTTP ${r.status}: ${await r.text()}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}
async function upsert(tabela, chave, rows) {
  for (let i = 0; i < rows.length; i += 500) {
    await sb(`/${tabela}?on_conflict=${chave}`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows.slice(i, i + 500)),
    });
  }
}

async function main() {
  const hash = await login();
  console.log("== cadastros ==");

  // 1) pessoas: descobrir campos válidos no $select (defensivo)
  const candidatos = ["NomeCompleto", "Fantasia", "NomeMunicipio", "Municipio", "Cidade", "Uf", "UF", "Bairro", "RegiaoEntrega", "Ativo"];
  const validos = [];
  for (const c of candidatos) {
    const t = await cigam(hash, `/genericos/ge/Pessoa/Buscar?${enc("$select")}=${enc("Codigo," + c)}&${enc("$top")}=1`);
    if (t.status === 200) validos.push(c);
  }
  console.log("campos validos em Pessoa:", validos.join(", "));
  const sel = "Codigo," + validos.join(",");
  const p = await cigam(hash, `/genericos/ge/Pessoa/Buscar?${enc("$select")}=${enc(sel)}&${enc("$top")}=50000`);
  const pessoas = Array.isArray(p.json) ? p.json : [];
  console.log(`pessoas na API: ${pessoas.length} (HTTP ${p.status})`);

  const pick = (o, ks) => { for (const k of ks) { if (trim(o[k])) return trim(o[k]); } return ""; };
  const clientes = pessoas.map(o => ({
    codigo: trim(o.Codigo),
    nome: pick(o, ["NomeCompleto"]),
    fantasia: pick(o, ["Fantasia"]),
    municipio: pick(o, ["NomeMunicipio", "Cidade", "Municipio"]),
    uf: pick(o, ["Uf", "UF"]),
    bairro: pick(o, ["Bairro"]),
    regiao: pick(o, ["RegiaoEntrega"]),
    ativo: pick(o, ["Ativo"]),
    atualizado_em: new Date().toISOString(),
  })).filter(c => c.codigo);
  await upsert("clientes", "codigo", clientes);
  console.log(`clientes gravados: ${clientes.length}`);

  // 2) representantes: códigos usados nas vendas, nomes vindos do cadastro de pessoas
  const reps = (await sb("/vendas_por_rep_30d?select=representante")) || [];
  const codigosRep = [...new Set(reps.map(r => trim(r.representante)).filter(Boolean))];
  const porCodigo = new Map(clientes.map(c => [c.codigo, c]));
  const rows = codigosRep.map(c => ({
    codigo: c,
    nome: porCodigo.get(c)?.nome || porCodigo.get(c)?.fantasia || c,
    atualizado_em: new Date().toISOString(),
  }));
  await upsert("representantes", "codigo", rows);
  console.log(`representantes gravados: ${rows.length}`);

  // 3) municípios IBGE (lat/lon) — só na primeira vez
  const jaTem = (await sb("/municipios?select=uf&limit=1")) || [];
  if (!jaTem.length) {
    const csv = await fetch("https://raw.githubusercontent.com/kelvins/municipios-brasileiros/main/csv/municipios.csv").then(r => r.text());
    const linhas = csv.split("\n").slice(1).filter(Boolean);
    // cabeçalho: codigo_ibge,nome,latitude,longitude,capital,codigo_uf,siafi_id,ddd,fuso_horario
    const ufPorCodigo = { 11:"RO",12:"AC",13:"AM",14:"RR",15:"PA",16:"AP",17:"TO",21:"MA",22:"PI",23:"CE",24:"RN",25:"PB",26:"PE",27:"AL",28:"SE",29:"BA",31:"MG",32:"ES",33:"RJ",35:"SP",41:"PR",42:"SC",43:"RS",50:"MS",51:"MT",52:"GO",53:"DF" };
    const vistos = new Set();
    const muns = [];
    for (const l of linhas) {
      const c = l.split(",");
      if (c.length < 6) continue;
      const nome = c[1].replace(/(^"|"$)/g, "");
      const uf = ufPorCodigo[parseInt(c[5], 10)] || "";
      const k = norm(nome) + "|" + uf;
      if (!uf || vistos.has(k)) continue;
      vistos.add(k);
      muns.push({ nome_norm: norm(nome), uf, nome, lat: parseFloat(c[2]), lon: parseFloat(c[3]) });
    }
    await upsert("municipios", "nome_norm,uf", muns);
    console.log(`municipios gravados: ${muns.length}`);
  } else {
    console.log("municipios: base já carregada, pulando");
  }
  console.log("== fim ==");
}
main().catch((e) => { console.error("FALHA:", e.message || e); process.exit(1); });

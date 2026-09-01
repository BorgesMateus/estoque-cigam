/**
 * Robo de geocodificacao de CEP — monta o cache que o mapa de calor usa para
 * agrupar o faturamento por regiao (bairro / RA) em vez de por municipio.
 *
 * Agrupa pelos 5 primeiros digitos do CEP (a "faixa"), que no DF corresponde de
 * perto a uma regiao administrativa. Para cada faixa nova busca bairro/cidade/UF
 * e coordenadas, em cascata de fontes, e grava em public.ceps.
 *
 * Somente leitura no CIGAM (nao toca no ERP). Idempotente: so resolve faixa nova.
 */
const need = (k) => { const v = process.env[k]; if (!v) { console.error("falta env " + k); process.exit(1); } return v; };
const SB_URL = need("SUPABASE_URL").replace(/\/$/, "");
const SB_KEY = need("SUPABASE_SERVICE_KEY");
const LIMITE = Number(process.env.GEOCEP_LIMITE || 1200);
const UA = "gostinho-estoque/1.0 (painel interno de estoque)";

const trim = (s) => (s == null ? "" : String(s)).trim();
const dig = (s) => trim(s).replace(/\D/g, "");
const norm = (s) => trim(s).toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));

async function sb(path, opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1${path}`, {
    ...opts,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`Supabase HTTP ${r.status}: ${await r.text()}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}
async function sbTudo(path) {
  const out = [];
  for (let de = 0; ; de += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1${path}`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Range: `${de}-${de + 999}` },
    });
    if (!r.ok) throw new Error(`Supabase HTTP ${r.status}: ${await r.text()}`);
    const j = await r.json();
    out.push(...j);
    if (j.length < 1000) return out;
  }
}
async function upsert(rows) {
  for (let i = 0; i < rows.length; i += 200) {
    await sb("/ceps?on_conflict=prefixo", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows.slice(i, i + 200)),
    });
  }
}
const diag = {};
function marca(fonte, o) { const d = diag[fonte] = diag[fonte] || { ok: 0, http: {}, erro: 0, vazio: 0 }; if (o.ok) d.ok++; if (o.http) d.http[o.http] = (d.http[o.http] || 0) + 1; if (o.erro) { d.erro++; if (!d.primeiroErro) d.primeiroErro = o.erro; } if (o.vazio) d.vazio++; }
async function pegaJson(url, fonte, headers = {}) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...headers } });
    if (!r.ok) { marca(fonte, { http: r.status }); return null; }
    const t = await r.text();
    if (!t || t[0] !== "{" && t[0] !== "[") { marca(fonte, { vazio: 1 }); return null; }
    marca(fonte, { ok: 1 });
    return JSON.parse(t);
  } catch (e) { marca(fonte, { erro: String(e && e.message || e).slice(0, 120) }); return null; }
}

/* ---- fontes, em cascata ---- */
// 1) AwesomeAPI: devolve lat/lng direto na maioria dos CEPs
async function viaAwesome(cep) {
  const j = await pegaJson(`https://cep.awesomeapi.com.br/json/${cep}`, "awesomeapi");
  if (!j || j.status === 400 || !j.city) return null;
  const lat = Number(j.lat), lon = Number(j.lng);
  return {
    bairro: trim(j.district), cidade: trim(j.city), uf: trim(j.state),
    lat: Number.isFinite(lat) ? lat : null, lon: Number.isFinite(lon) ? lon : null,
    fonte: "awesomeapi",
  };
}
// 2) BrasilAPI v2: bairro/cidade sempre; coordenada as vezes
async function viaBrasilApi(cep) {
  const j = await pegaJson(`https://brasilapi.com.br/api/v1/cep/v2/${cep}`, "brasilapi");
  if (!j || !j.city) return null;
  const c = j.location && j.location.coordinates;
  const lat = c ? Number(c.latitude) : NaN, lon = c ? Number(c.longitude) : NaN;
  return {
    bairro: trim(j.neighborhood), cidade: trim(j.city), uf: trim(j.state),
    lat: Number.isFinite(lat) ? lat : null, lon: Number.isFinite(lon) ? lon : null,
    fonte: "brasilapi",
  };
}
// 3) ViaCEP: so bairro/cidade/UF, sem coordenada
async function viaViaCep(cep) {
  const j = await pegaJson(`https://viacep.com.br/ws/${cep}/json/`, "viacep");
  if (!j || j.erro || !j.localidade) return null;
  return { bairro: trim(j.bairro), cidade: trim(j.localidade), uf: trim(j.uf), lat: null, lon: null, fonte: "viacep" };
}

// coordenada de fallback: geocodifica o nome do bairro (1 req/s, exigencia do Nominatim)
let ultimoNominatim = 0;
const cacheNominatim = new Map();
async function coordDoBairro(bairro, cidade, uf) {
  const chave = norm(bairro) + "|" + norm(cidade) + "|" + norm(uf);
  if (cacheNominatim.has(chave)) return cacheNominatim.get(chave);
  const q = [bairro, cidade, uf, "Brasil"].filter(Boolean).join(", ");
  const espera = 1100 - (Date.now() - ultimoNominatim);
  if (espera > 0) await dorme(espera);
  ultimoNominatim = Date.now();
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&q=${encodeURIComponent(q)}`;
  let j = await pegaJson(url, "nominatim");
  if (!Array.isArray(j) || !j.length) {
    await dorme(1500);
    ultimoNominatim = Date.now();
    j = await pegaJson(url, "nominatim");
  }
  const achado = Array.isArray(j) && j.length ? { lat: Number(j[0].lat), lon: Number(j[0].lon) } : null;
  cacheNominatim.set(chave, achado);
  return achado;
}

async function resolveUm(cep) {
  let r = await viaAwesome(cep);
  if (!r || !r.lat) {
    const b = await viaBrasilApi(cep);
    if (b && (b.lat || !r)) r = b;
  }
  if (!r) r = await viaViaCep(cep);
  return r;
}
async function resolve(amostras) {
  const tentativas = [...amostras, amostras[0].slice(0, 5) + "000"];
  let r = null;
  for (const cep of tentativas) {
    r = await resolveUm(cep);
    if (r) break;
  }
  if (!r) return null;
  if (r.lat == null || r.lon == null) {
    const c = await coordDoBairro(r.bairro, r.cidade, r.uf);
    if (c) { r.lat = c.lat; r.lon = c.lon; r.fonte = r.fonte + "+nominatim"; }
  }
  return r;
}

async function main() {
  console.log("== geocep ==");

  const clientes = await sbTudo("/clientes?select=cep&cep=not.is.null");
  const porPrefixo = new Map();
  for (const c of clientes) {
    const d = dig(c.cep);
    if (d.length !== 8) continue;
    const p = d.slice(0, 5);
    const lista = porPrefixo.get(p) || [];
    if (lista.length < 4 && !lista.includes(d)) lista.push(d);
    porPrefixo.set(p, lista);
  }
  console.log(`clientes com CEP: ${clientes.length} · faixas distintas: ${porPrefixo.size}`);

  const jaTem = new Set((await sbTudo("/ceps?select=prefixo,lat")).filter(r => r.lat != null).map(r => r.prefixo));
  const pendentes = [...porPrefixo.entries()].filter(([p]) => !jaTem.has(p));
  console.log(`ja no cache com coordenada: ${jaTem.size} · a resolver: ${pendentes.length}`);

  const alvo = pendentes.slice(0, LIMITE);
  if (pendentes.length > LIMITE) console.log(`resolvendo ${LIMITE} nesta rodada; o resto na proxima`);

  const linhas = [];
  const porFonte = {};
  let semNada = 0;
  for (let i = 0; i < alvo.length; i++) {
    const [prefixo, amostras] = alvo[i];
    const r = await resolve(amostras);
    if (!r) { semNada++; continue; }
    porFonte[r.fonte] = (porFonte[r.fonte] || 0) + 1;
    linhas.push({
      prefixo, bairro: r.bairro || "", cidade: r.cidade || "", uf: r.uf || "",
      lat: r.lat, lon: r.lon, fonte: r.fonte, atualizado_em: new Date().toISOString(),
    });
    if (linhas.length >= 200) { await upsert(linhas.splice(0)); }
    if ((i + 1) % 100 === 0) console.log(`  ... ${i + 1}/${alvo.length}`);
    await dorme(120);
  }
  if (linhas.length) await upsert(linhas);

  const total = await sbTudo("/ceps?select=prefixo,lat");
  const comCoord = total.filter(r => r.lat != null).length;
  console.log(`resolvidos nesta rodada: ${alvo.length - semNada} · sem resposta: ${semNada}`);
  console.log("por fonte:", JSON.stringify(porFonte));
  console.log("diagnostico das APIs:", JSON.stringify(diag));
  console.log(`cache total: ${total.length} faixas · com coordenada: ${comCoord}`);
  console.log("== fim ==");
}
main().catch((e) => { console.error("FALHA:", e.message || e); process.exit(1); });

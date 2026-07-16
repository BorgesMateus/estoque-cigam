/* ============================================================================
   permissoes.js — Controle de acesso por usuário (RBAC) do Painel Estoque CIGAM
   ----------------------------------------------------------------------------
   Carregado pelo index.html. No sucesso do login, o index chama:
       await window.aplicarPermissoes(usuarioDigitado)
   Modelo (tabela Supabase "permissoes"):
       usuario     text  (login do CIGAM em MAIÚSCULAS; '*' = padrão p/ não listados)
       abas        text[] (quais abas vê: estoque, vendas, mapa, pedidos, criar; ou '*')
       ver_valores bool   (se false, mantém só abas SEM valor -> só Estoque)
       admin       bool   (mostra o botão "Acessos" pra parametrizar usuários)
   Regras:
     - abas define o que aparece; ver_valores=false corta tudo que tem R$/faturamento.
     - Padrão '*' vem cheio (admin) pra NÃO travar ninguém; o admin restringe cada login.
   SEGURANÇA: é bloqueio de INTERFACE (roda no navegador). Ótimo p/ equipe de produção,
   mas não é à prova de usuário técnico. Blindagem real exige contas CIGAM limitadas
   e/ou RLS por identidade — ver nota entregue ao Mateus.
   ========================================================================== */
(function () {
  "use strict";
  const ALL_TABS = ["estoque", "vendas", "mapa", "pedidos", "criar"];
  const LABELS = { estoque: "\u{1F4E6} Estoque", vendas: "\u{1F4C8} Vendas", mapa: "\u{1F5FA}\u{FE0F} Mapa", pedidos: "\u{1F4CB} Pedidos", criar: "\u{1F6D2} Criar pedido" };
  const VALUE_FREE = ["estoque"];               // abas sem nenhum valor/faturamento
  const norm = (u) => String(u || "").trim().toUpperCase();
  const SB = () => (typeof sb !== "undefined" ? sb : (window.sb || null));

  // injeta CSS de apoio (esconde painéis de valor quando sem-valores; estilo do botão/modal)
  (function injetarCSS() {
    const css = `
      body.sem-valores .pv, body.sem-valores .pm { display:none !important; }
      #btnAcessos{ }
      #permOverlay{ position:fixed; inset:0; background:rgba(0,0,0,.45); display:none; z-index:9999; }
      #permOverlay.show{ display:flex; align-items:flex-start; justify-content:center; }
      #permBox{ background:#fff; color:#111; max-width:760px; width:94%; margin:6vh auto; border-radius:12px;
        box-shadow:0 10px 40px rgba(0,0,0,.3); padding:20px 22px; max-height:86vh; overflow:auto; }
      #permBox h3{ margin:0 0 4px; } #permBox .muted{ color:#666; font-size:12px; }
      #permBox table{ width:100%; border-collapse:collapse; font-size:13px; margin-top:10px; }
      #permBox th,#permBox td{ border-bottom:1px solid #eee; padding:6px 8px; text-align:left; }
      #permBox .chips span{ display:inline-block; background:#eef; border-radius:6px; padding:1px 6px; margin:1px; font-size:11px; }
      #permForm{ border:1px solid #e5e5e5; border-radius:10px; padding:12px 14px; margin-top:14px; background:#fafafa; }
      #permForm label{ font-size:12px; color:#444; display:inline-flex; align-items:center; gap:5px; margin:4px 12px 4px 0; }
      #permForm input[type=text]{ padding:6px 8px; border:1px solid #ccc; border-radius:6px; width:220px; }
      #permMsg{ font-size:12px; margin-top:8px; min-height:16px; }
      .permbtn{ padding:6px 12px; border-radius:8px; border:1px solid #ccc; background:#fff; cursor:pointer; font-size:13px; }
      .permbtn.primary{ background:#2563eb; color:#fff; border-color:#2563eb; }
      .permbtn.danger{ background:#fff; color:#c00; border-color:#f0b8b8; }
    `;
    const s = document.createElement("style"); s.id = "permCSS"; s.textContent = css;
    document.head.appendChild(s);
  })();

  async function buscarPermissao(usuario) {
    const u = norm(usuario);
    let row = null;
    try {
      const c = SB();
      if (c) {
        const { data } = await c.from("permissoes").select("usuario,abas,ver_valores,admin").in("usuario", [u, "*"]);
        const arr = data || [];
        row = arr.find((r) => norm(r.usuario) === u) || arr.find((r) => r.usuario === "*") || null;
      }
    } catch (e) { console.warn("permissoes: fetch falhou, liberando (fail-open p/ não travar)", e); }
    // fail-open: se não achou nada (ou erro), NÃO trava o usuário
    if (!row) row = { usuario: u, abas: ALL_TABS.slice(), ver_valores: true, admin: false };
    let abas = row.abas;
    if (typeof abas === "string") { try { abas = JSON.parse(abas); } catch (_) { abas = abas.replace(/[{}\[\]"]/g, "").split(","); } }
    abas = Array.isArray(abas) ? abas.map((x) => String(x).trim()).filter(Boolean) : ALL_TABS.slice();
    if (abas.includes("*")) abas = ALL_TABS.slice();
    return { usuario: u, abas, ver_valores: row.ver_valores !== false, admin: !!row.admin };
  }

  function abasEfetivas(p) {
    let a = p.abas.filter((t) => ALL_TABS.includes(t));
    if (!p.ver_valores) a = a.filter((t) => VALUE_FREE.includes(t));
    if (!a.length) a = ["estoque"];
    return a;
  }

  function gateTabs(allowed) {
    window.__permAllowed = allowed;
    document.querySelectorAll(".tabs button[data-tab]").forEach((b) => {
      b.style.display = allowed.includes(b.dataset.tab) ? "" : "none";
    });
    const cur = document.body.dataset.tab;
    if (!allowed.includes(cur) && typeof setTab === "function") setTab(allowed[0]);
  }

  // bloqueia navegação programática pra abas não permitidas (best-effort)
  function protegerSetTab() {
    if (window.__setTabProtegido) return;
    if (typeof setTab !== "function") return;
    const orig = setTab;
    window.__setTabProtegido = true;
    globalThis.setTab = function (t) {
      const allowed = window.__permAllowed;
      if (allowed && !allowed.includes(t)) t = allowed[0] || "estoque";
      return orig.apply(this, [t]);
    };
  }

  // ---------------------- UI de administração (só admin) ----------------------
  function botaoAdmin(mostrar) {
    let b = document.getElementById("btnAcessos");
    if (!mostrar) { if (b) b.remove(); return; }
    if (b) return;
    const header = document.querySelector("header"); if (!header) return;
    b = document.createElement("button"); b.id = "btnAcessos"; b.textContent = "\u{1F510} Acessos";
    b.className = "";
    b.addEventListener("click", abrirModal);
    header.insertBefore(b, document.getElementById("btnEquipe") || null);
  }

  function garantirModal() {
    if (document.getElementById("permOverlay")) return;
    const ov = document.createElement("div"); ov.id = "permOverlay";
    ov.innerHTML =
      '<div id="permBox">' +
      '<h3>\u{1F510} Acessos — quem vê o quê</h3>' +
      '<div class="muted">Cada usuário é o <b>login do CIGAM</b> (em maiúsculas). Marque as abas e se pode ver valores. ' +
      "Sem 'Ver valores', o usuário fica só com o Estoque (sem R$/faturamento). Use <b>*</b> como usuário para o padrão de quem não estiver na lista.</div>" +
      '<div id="permLista"></div>' +
      '<div id="permForm">' +
      '<div><b>Novo / editar</b></div>' +
      '<div style="margin:8px 0"><label>Usuário (login CIGAM) <input type="text" id="pfUser" placeholder="EX: JOAO.PROD ou *"></label></div>' +
      '<div id="pfAbas" style="margin:6px 0"></div>' +
      '<div style="margin:6px 0"><label><input type="checkbox" id="pfValores"> Ver valores / faturamento (R$)</label>' +
      '<label><input type="checkbox" id="pfAdmin"> Admin (gerencia acessos)</label></div>' +
      '<div style="margin-top:10px">' +
      '<button class="permbtn primary" id="pfSalvar">Salvar</button> ' +
      '<button class="permbtn" id="pfLimpar">Limpar</button> ' +
      '<button class="permbtn" id="pfFechar" style="float:right">Fechar</button></div>' +
      '<div id="permMsg"></div>' +
      "</div></div>";
    document.body.appendChild(ov);
    // checkboxes de abas
    const wrap = ov.querySelector("#pfAbas");
    wrap.innerHTML = "<span class='muted'>Abas: </span>" + ALL_TABS.map((t) =>
      `<label><input type="checkbox" class="pfAba" value="${t}"> ${LABELS[t]}</label>`).join("");
    ov.addEventListener("click", (e) => { if (e.target === ov) fechar(); });
    ov.querySelector("#pfFechar").addEventListener("click", fechar);
    ov.querySelector("#pfLimpar").addEventListener("click", () => preencherForm(null));
    ov.querySelector("#pfSalvar").addEventListener("click", salvar);
  }

  function preencherForm(row) {
    const g = (id) => document.getElementById(id);
    g("pfUser").value = row ? row.usuario : "";
    let abas = row ? row.abas : ["estoque"];
    if (typeof abas === "string") { try { abas = JSON.parse(abas); } catch (_) { abas = abas.replace(/[{}\[\]"]/g, "").split(","); } }
    abas = Array.isArray(abas) ? abas.map((x) => String(x).trim()) : [];
    if (abas.includes("*")) abas = ALL_TABS.slice();
    document.querySelectorAll(".pfAba").forEach((c) => { c.checked = abas.includes(c.value); });
    g("pfValores").checked = row ? row.ver_valores !== false : false;
    g("pfAdmin").checked = row ? !!row.admin : false;
    g("permMsg").textContent = "";
  }

  async function carregarLista() {
    const el = document.getElementById("permLista");
    el.innerHTML = "<div class='muted'>carregando…</div>";
    try {
      const { data } = await SB().from("permissoes").select("*").order("usuario");
      const rows = data || [];
      el.innerHTML =
        "<table><thead><tr><th>Usuário</th><th>Abas</th><th>Valores</th><th>Admin</th><th></th></tr></thead><tbody>" +
        rows.map((r, i) => {
          let abas = r.abas; if (typeof abas === "string") { try { abas = JSON.parse(abas); } catch (_) { abas = [String(abas)]; } }
          abas = Array.isArray(abas) ? abas : [];
          const chips = (abas.includes("*") ? ["tudo"] : abas).map((a) => `<span>${LABELS[a] || a}</span>`).join("");
          return `<tr><td><b>${r.usuario}</b></td><td class="chips">${chips}</td>` +
            `<td>${r.ver_valores !== false ? "sim" : "não"}</td><td>${r.admin ? "sim" : "—"}</td>` +
            `<td><button class="permbtn" data-edit="${i}">editar</button> ` +
            `<button class="permbtn danger" data-del="${r.usuario}">excluir</button></td></tr>`;
        }).join("") + "</tbody></table>";
      el.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => preencherForm(rows[+b.dataset.edit])));
      el.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => excluir(b.dataset.del)));
      window.__permRows = rows;
    } catch (e) { el.innerHTML = "<div class='muted' style='color:#c00'>Erro ao ler: " + (e.message || e) + "</div>"; }
  }

  async function precisaEquipe() {
    try { const { data } = await SB().auth.getUser(); return !data || !data.user; } catch (_) { return true; }
  }

  async function salvar() {
    const msg = document.getElementById("permMsg");
    const usuario = norm(document.getElementById("pfUser").value);
    if (!usuario) { msg.textContent = "Informe o usuário."; return; }
    const abas = [...document.querySelectorAll(".pfAba:checked")].map((c) => c.value);
    const ver_valores = document.getElementById("pfValores").checked;
    const admin = document.getElementById("pfAdmin").checked;
    if (await precisaEquipe()) { msg.innerHTML = "Pra salvar você precisa entrar com <b>Equipe: entrar</b> (canto superior). Faça isso e tente de novo."; return; }
    msg.textContent = "salvando…";
    try {
      const { error } = await SB().from("permissoes").upsert({ usuario, abas, ver_valores, admin }, { onConflict: "usuario" });
      if (error) throw error;
      msg.textContent = "salvo ✔"; preencherForm(null); carregarLista();
    } catch (e) { msg.textContent = "erro: " + (e.message || e); }
  }

  async function excluir(usuario) {
    if (!confirm("Excluir o acesso de " + usuario + "?")) return;
    const msg = document.getElementById("permMsg");
    if (await precisaEquipe()) { msg.innerHTML = "Entre com <b>Equipe: entrar</b> pra excluir."; return; }
    try { const { error } = await SB().from("permissoes").delete().eq("usuario", usuario); if (error) throw error; carregarLista(); }
    catch (e) { msg.textContent = "erro: " + (e.message || e); }
  }

  function abrirModal() { garantirModal(); preencherForm(null); carregarLista(); document.getElementById("permOverlay").classList.add("show"); }
  function fechar() { const o = document.getElementById("permOverlay"); if (o) o.classList.remove("show"); }

  // ------------------------------- entrada -------------------------------
  window.aplicarPermissoes = async function (usuario) {
    try {
      protegerSetTab();
      const p = await buscarPermissao(usuario);
      window.__perm = p; window.__usuarioLogado = norm(usuario);
      const allowed = abasEfetivas(p);
      gateTabs(allowed);
      document.body.classList.toggle("sem-valores", !p.ver_valores);
      botaoAdmin(p.admin);
      console.info("[permissoes]", p.usuario, "abas:", allowed.join(","), "valores:", p.ver_valores, "admin:", p.admin);
    } catch (e) { console.warn("aplicarPermissoes erro (fail-open):", e); }
  };

  // se o usuário já estava logado quando o script carregou (recarga de página), reaplica.
  // o hook no index salva o LOGIN (não a senha) em sessionStorage 'cigam_user'.
  function reaplicarSeLogado() {
    try {
      const u = (window.__usuarioLogado) || (typeof sessionStorage !== "undefined" ? sessionStorage.getItem("cigam_user") : null);
      if (u && typeof token === "function" && token()) window.aplicarPermissoes(u);
    } catch (_) {}
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", reaplicarSeLogado);
  else reaplicarSeLogado();
})();

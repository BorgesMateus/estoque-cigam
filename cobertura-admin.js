/* =====================================================================
   cobertura-admin.js — Admin da aba Cobertura
   Cadastro de carregamentos (datas dos embarques grandes + fator que
   "raspa" a camara) e definicao do lead de reposicao (global / por
   grupo / por produto). So aparece pra admin (window.__perm.admin).

   Reusa globais: sb, STATE, escapeHtml, fmt, window.Cobertura.
   Escreve em: carregamentos, cobertura_lead.
   ===================================================================== */
(function () {
  "use strict";

  var G = { grupos: null };

  function sbc() { return (typeof sb !== "undefined" && sb) || window.sb || null; }
  function isAdmin() { return !!(window.__perm && window.__perm.admin); }
  function esc(s) {
    if (typeof window.escapeHtml === "function") return window.escapeHtml(s);
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function grupos() {
    if (G.grupos) return G.grupos;
    var s = {};
    ((window.STATE && window.STATE.materiais) || []).forEach(function (it) {
      var g = String(it.codigo).slice(0, 6);
      if (!s[g]) s[g] = it.descricao || g;
    });
    G.grupos = Object.keys(s).sort().map(function (g) { return { g: g, nome: s[g] }; });
    return G.grupos;
  }
  function nomeProd(cod) {
    var it = ((window.STATE && window.STATE.materiais) || []).find(function (m) { return m.codigo === cod; });
    return it ? it.descricao : cod;
  }
  function brdata(iso) { return iso ? String(iso).slice(0, 10).split("-").reverse().join("/") : ""; }

  // ---------- estilo ----------
  function css() {
    if (document.getElementById("cobadm-css")) return;
    var s = document.createElement("style");
    s.id = "cobadm-css";
    s.textContent = [
      '.cobadm-btn{cursor:pointer;border:1px solid #d7d7e6;background:#fff;border-radius:8px;padding:6px 12px;font-size:13px;margin:0 0 10px}',
      '.cobadm-btn:hover{background:#f4f4fb}',
      '#cobadmOv{position:fixed;inset:0;background:rgba(0,0,0,.45);display:none;z-index:10000;align-items:flex-start;justify-content:center;overflow:auto;padding:24px 12px}',
      '#cobadmOv.show{display:flex}',
      '.cobadm-box{background:#fff;border-radius:14px;max-width:820px;width:100%;padding:18px 20px;box-shadow:0 10px 40px rgba(0,0,0,.25)}',
      '.cobadm-box h3{margin:0 0 4px;font-size:17px}',
      '.cobadm-box h4{margin:18px 0 8px;font-size:14px;color:#334;border-top:1px solid #eee;padding-top:14px}',
      '.cobadm-x{float:right;cursor:pointer;font-size:20px;color:#889;line-height:1}',
      '.cobadm-tbl{width:100%;border-collapse:collapse;font-size:12.5px;margin:4px 0}',
      '.cobadm-tbl th{text-align:left;color:#667;font-weight:600;padding:5px 7px;border-bottom:1px solid #eee}',
      '.cobadm-tbl td{padding:5px 7px;border-bottom:1px solid #f3f3f7;vertical-align:top}',
      '.cobadm-tbl .del{cursor:pointer;color:#d33;border:none;background:none;font-size:13px}',
      '.cobadm-tbl .ed{cursor:pointer;color:#0a58ca;border:none;background:none;font-size:13px;margin-right:6px}',
      '.cobadm-f{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin:8px 0}',
      '.cobadm-f label{font-size:11px;color:#667;display:flex;flex-direction:column;gap:3px}',
      '.cobadm-f input,.cobadm-f select{padding:5px 7px;border:1px solid #d7d7e6;border-radius:7px;font-size:13px}',
      '.cobadm-f input[type=date]{min-width:130px}',
      '.cobadm-save{cursor:pointer;background:#111;color:#fff;border:none;border-radius:8px;padding:7px 14px;font-size:13px}',
      '.cobadm-chips{display:flex;flex-wrap:wrap;gap:4px;margin:4px 0}',
      '.cobadm-chip{background:#eef;border-radius:6px;padding:2px 7px;font-size:12px;cursor:pointer}',
      '.cobadm-chip:hover{background:#fdd}',
      '.cobadm-grp{max-height:120px;overflow:auto;border:1px solid #eee;border-radius:8px;padding:6px;display:flex;flex-wrap:wrap;gap:8px}',
      '.cobadm-grp label{font-size:12px;display:flex;gap:4px;align-items:center;color:#334}',
      '.cobadm-msg{font-size:12px;color:#178a3a;margin-left:8px}',
      '.cobadm-mut{color:#99a;font-size:12px}'
    ].join("\n");
    document.head.appendChild(s);
  }

  // ---------- estado do form de carregamento ----------
  var edit = { id: null };
  var pickCods = [];   // codigos escolhidos no escopo "produtos"

  // ---------- overlay ----------
  function overlay() {
    var ov = document.getElementById("cobadmOv");
    if (ov) return ov;
    css();
    ov = document.createElement("div");
    ov.id = "cobadmOv";
    ov.innerHTML =
      '<div class="cobadm-box">' +
      '<span class="cobadm-x" id="cobadmClose">&times;</span>' +
      '<h3>⚙️ Carregamentos & lead de reposição</h3>' +
      '<div class="cobadm-mut">Configura a reserva dos embarques grandes e o tempo pra repor. Reflete na aba Cobertura.</div>' +
      '<h4>📦 Carregamentos</h4>' +
      '<div id="cobadmCargList"></div>' +
      '<div class="cobadm-f" id="cobadmCargForm">' +
      '<label>Data<input type="date" id="cfData"></label>' +
      '<label>Descrição<input type="text" id="cfDesc" placeholder="ex.: Carga Nordeste" style="min-width:160px"></label>' +
      '<label>Atinge<select id="cfEscopo"><option value="todos">Todos os produtos</option><option value="grupos">Grupos</option><option value="produtos">Produtos</option></select></label>' +
      '<label>Fator<input type="number" id="cfFator" min="1" step="0.5" value="2" style="width:70px" title="quantas vezes a demanda média diária esse carregamento consome"></label>' +
      '<button class="cobadm-save" id="cfSave">Adicionar</button>' +
      '<span class="cobadm-msg" id="cfMsg"></span>' +
      '</div>' +
      '<div id="cfEscopoBox"></div>' +
      '<h4>⏱️ Lead de reposição (dias)</h4>' +
      '<div class="cobadm-f">' +
      '<label>Global<input type="number" id="ldGlobal" min="1" step="1" style="width:70px"></label>' +
      '<button class="cobadm-save" id="ldGlobalSave">Salvar global</button>' +
      '<span class="cobadm-msg" id="ldGmsg"></span>' +
      '</div>' +
      '<div id="cobadmLeadList"></div>' +
      '<div class="cobadm-f">' +
      '<label>Tipo<select id="ldTipo"><option value="grupo">Grupo</option><option value="produto">Produto</option></select></label>' +
      '<label id="ldChaveWrap">Chave<span id="ldChaveField"></span></label>' +
      '<label>Lead<input type="number" id="ldDias" min="1" step="1" style="width:70px" value="3"></label>' +
      '<button class="cobadm-save" id="ldAdd">Adicionar exceção</button>' +
      '<span class="cobadm-msg" id="ldAmsg"></span>' +
      '</div>' +
      '</div>';
    document.body.appendChild(ov);
    ov.addEventListener("click", function (e) { if (e.target === ov) fechar(); });
    ov.querySelector("#cobadmClose").addEventListener("click", fechar);
    ov.querySelector("#cfEscopo").addEventListener("change", renderEscopoBox);
    ov.querySelector("#cfSave").addEventListener("click", salvarCarreg);
    ov.querySelector("#ldGlobalSave").addEventListener("click", salvarLeadGlobal);
    ov.querySelector("#ldTipo").addEventListener("change", renderLdChave);
    ov.querySelector("#ldAdd").addEventListener("click", addLead);
    return ov;
  }

  function abrir() {
    overlay().classList.add("show");
    resetCargForm();
    renderEscopoBox();
    renderLdChave();
    carregarTudo();
  }
  function fechar() { var ov = document.getElementById("cobadmOv"); if (ov) ov.classList.remove("show"); }

  // ---------- carregamentos ----------
  function carregarTudo() { listarCarreg(); listarLead(); }

  function listarCarreg() {
    var box = document.getElementById("cobadmCargList");
    if (!box) return;
    box.innerHTML = '<div class="cobadm-mut">Carregando…</div>';
    sbc().from("carregamentos").select("*").order("data", { ascending: true }).then(function (r) {
      var rows = r.data || [];
      if (!rows.length) { box.innerHTML = '<div class="cobadm-mut">Nenhum carregamento cadastrado.</div>'; return; }
      box.innerHTML = '<table class="cobadm-tbl"><thead><tr><th>Data</th><th>Descrição</th><th>Atinge</th><th>Fator</th><th></th></tr></thead><tbody>' +
        rows.map(function (c) {
          var alvo = c.escopo === "todos" ? "todos" :
            c.escopo === "grupos" ? ((c.grupos || []).length + " grupo(s)") :
            ((c.codigos || []).length + " produto(s)");
          return '<tr><td>' + brdata(c.data) + '</td><td>' + esc(c.descricao || "") + '</td><td>' + alvo + '</td><td>' + (c.fator || 2) + '</td>' +
            '<td style="white-space:nowrap"><button class="ed" data-id="' + c.id + '">editar</button>' +
            '<button class="del" data-id="' + c.id + '">excluir</button></td></tr>';
        }).join("") + '</tbody></table>';
      box.querySelectorAll(".del").forEach(function (b) {
        b.addEventListener("click", function () { excluirCarreg(b.getAttribute("data-id")); });
      });
      box.querySelectorAll(".ed").forEach(function (b) {
        b.addEventListener("click", function () { editarCarreg(rows.find(function (x) { return String(x.id) === b.getAttribute("data-id"); })); });
      });
    });
  }

  function renderEscopoBox() {
    var box = document.getElementById("cfEscopoBox");
    var esc0 = document.getElementById("cfEscopo").value;
    if (esc0 === "grupos") {
      box.innerHTML = '<div class="cobadm-grp">' + grupos().map(function (x) {
        return '<label><input type="checkbox" class="cfGrp" value="' + x.g + '"> ' + x.g + ' <span class="cobadm-mut">' + esc((x.nome || "").slice(0, 16)) + '</span></label>';
      }).join("") + '</div>';
    } else if (esc0 === "produtos") {
      box.innerHTML = '<div class="cobadm-f"><label>Produto<input type="text" id="cfCodInput" list="cfCodList" placeholder="código ou nome" style="min-width:220px"></label>' +
        '<button class="cobadm-btn" id="cfCodAdd" style="margin:0">+ add</button></div>' +
        '<datalist id="cfCodList">' + ((window.STATE && window.STATE.materiais) || []).slice(0, 4000).map(function (m) {
          return '<option value="' + m.codigo + '">' + esc(m.descricao || "") + '</option>';
        }).join("") + '</datalist>' +
        '<div class="cobadm-chips" id="cfCodChips"></div>';
      box.querySelector("#cfCodAdd").addEventListener("click", function () {
        var v = (document.getElementById("cfCodInput").value || "").trim();
        // aceita codigo direto ou casa por nome
        var m = ((window.STATE && window.STATE.materiais) || []).find(function (x) { return x.codigo === v; }) ||
          ((window.STATE && window.STATE.materiais) || []).find(function (x) { return (x.descricao || "").toLowerCase() === v.toLowerCase(); });
        var cod = m ? m.codigo : (/^\d{6,}$/.test(v) ? v : null);
        if (cod && pickCods.indexOf(cod) < 0) { pickCods.push(cod); renderCodChips(); }
        document.getElementById("cfCodInput").value = "";
      });
      renderCodChips();
    } else {
      box.innerHTML = "";
    }
  }
  function renderCodChips() {
    var el = document.getElementById("cfCodChips");
    if (!el) return;
    el.innerHTML = pickCods.map(function (c) {
      return '<span class="cobadm-chip" data-c="' + c + '" title="remover">' + c + " · " + esc((nomeProd(c) || "").slice(0, 14)) + " ✕</span>";
    }).join("");
    el.querySelectorAll(".cobadm-chip").forEach(function (ch) {
      ch.addEventListener("click", function () { pickCods = pickCods.filter(function (x) { return x !== ch.getAttribute("data-c"); }); renderCodChips(); });
    });
  }

  function resetCargForm() {
    edit.id = null; pickCods = [];
    var s = document.getElementById("cfSave"); if (s) s.textContent = "Adicionar";
    ["cfData", "cfDesc"].forEach(function (id) { var e = document.getElementById(id); if (e) e.value = ""; });
    var f = document.getElementById("cfFator"); if (f) f.value = "2";
    var es = document.getElementById("cfEscopo"); if (es) es.value = "todos";
  }
  function editarCarreg(c) {
    if (!c) return;
    edit.id = c.id;
    document.getElementById("cfData").value = String(c.data).slice(0, 10);
    document.getElementById("cfDesc").value = c.descricao || "";
    document.getElementById("cfFator").value = c.fator || 2;
    document.getElementById("cfEscopo").value = c.escopo || "todos";
    pickCods = (c.codigos || []).slice();
    renderEscopoBox();
    if (c.escopo === "grupos") {
      var set = {}; (c.grupos || []).forEach(function (g) { set[g] = 1; });
      document.querySelectorAll(".cfGrp").forEach(function (chk) { chk.checked = !!set[chk.value]; });
    }
    document.getElementById("cfSave").textContent = "Salvar edição";
    document.getElementById("cfData").scrollIntoView({ block: "center" });
  }

  function salvarCarreg() {
    var msg = document.getElementById("cfMsg"); msg.textContent = "";
    var data = document.getElementById("cfData").value;
    if (!data) { msg.style.color = "#d33"; msg.textContent = "informe a data"; return; }
    var esc0 = document.getElementById("cfEscopo").value;
    var reg = {
      data: data,
      descricao: (document.getElementById("cfDesc").value || "").trim() || "Carregamento",
      escopo: esc0,
      fator: Number(document.getElementById("cfFator").value) || 2,
      grupos: [], codigos: []
    };
    if (esc0 === "grupos") reg.grupos = [].map.call(document.querySelectorAll(".cfGrp:checked"), function (c) { return c.value; });
    if (esc0 === "produtos") reg.codigos = pickCods.slice();
    if (esc0 === "grupos" && !reg.grupos.length) { msg.style.color = "#d33"; msg.textContent = "escolha ao menos 1 grupo"; return; }
    if (esc0 === "produtos" && !reg.codigos.length) { msg.style.color = "#d33"; msg.textContent = "adicione ao menos 1 produto"; return; }

    var q = edit.id ? sbc().from("carregamentos").update(reg).eq("id", edit.id)
                    : sbc().from("carregamentos").insert(reg);
    q.then(function (r) {
      if (r.error) { msg.style.color = "#d33"; msg.textContent = "erro: " + r.error.message; return; }
      msg.style.color = "#178a3a"; msg.textContent = edit.id ? "editado ✔" : "adicionado ✔";
      resetCargForm(); renderEscopoBox(); listarCarreg(); refrescar();
    });
  }
  function excluirCarreg(id) {
    sbc().from("carregamentos").delete().eq("id", id).then(function (r) {
      if (!r.error) { listarCarreg(); refrescar(); }
    });
  }

  // ---------- lead ----------
  function listarLead() {
    var g = document.getElementById("ldGlobal");
    var box = document.getElementById("cobadmLeadList");
    sbc().from("cobertura_lead").select("*").then(function (r) {
      var rows = r.data || [];
      var glob = rows.find(function (x) { return x.tipo === "global"; });
      if (g) g.value = glob ? glob.lead_dias : 3;
      var exc = rows.filter(function (x) { return x.tipo !== "global"; });
      if (!box) return;
      if (!exc.length) { box.innerHTML = '<div class="cobadm-mut">Sem exceções — todos usam o global.</div>'; return; }
      box.innerHTML = '<table class="cobadm-tbl"><thead><tr><th>Tipo</th><th>Chave</th><th>Lead</th><th></th></tr></thead><tbody>' +
        exc.sort(function (a, b) { return (a.tipo + a.chave).localeCompare(b.tipo + b.chave); }).map(function (x) {
          var nome = x.tipo === "produto" ? (" · " + esc((nomeProd(x.chave) || "").slice(0, 16))) : "";
          return '<tr><td>' + x.tipo + '</td><td>' + x.chave + '<span class="cobadm-mut">' + nome + '</span></td><td>' + x.lead_dias + ' d</td>' +
            '<td><button class="del" data-k="' + esc(x.chave) + '" data-t="' + x.tipo + '">excluir</button></td></tr>';
        }).join("") + '</tbody></table>';
      box.querySelectorAll(".del").forEach(function (b) {
        b.addEventListener("click", function () { excluirLead(b.getAttribute("data-k"), b.getAttribute("data-t")); });
      });
    });
  }
  function renderLdChave() {
    var wrap = document.getElementById("ldChaveField");
    if (!wrap) return;
    var tipo = document.getElementById("ldTipo").value;
    if (tipo === "grupo") {
      wrap.innerHTML = '<select id="ldChave">' + grupos().map(function (x) { return '<option value="' + x.g + '">' + x.g + " · " + esc((x.nome || "").slice(0, 16)) + "</option>"; }).join("") + '</select>';
    } else {
      wrap.innerHTML = '<input type="text" id="ldChave" list="cfCodList2" placeholder="código do produto" style="min-width:180px">' +
        '<datalist id="cfCodList2">' + ((window.STATE && window.STATE.materiais) || []).slice(0, 4000).map(function (m) { return '<option value="' + m.codigo + '">' + esc(m.descricao || "") + '</option>'; }).join("") + '</datalist>';
    }
  }
  function salvarLeadGlobal() {
    var msg = document.getElementById("ldGmsg"); msg.textContent = "";
    var v = Number(document.getElementById("ldGlobal").value) || 3;
    sbc().from("cobertura_lead").upsert({ chave: "GLOBAL", tipo: "global", lead_dias: v }, { onConflict: "chave,tipo" }).then(function (r) {
      if (r.error) { msg.style.color = "#d33"; msg.textContent = "erro: " + r.error.message; return; }
      msg.style.color = "#178a3a"; msg.textContent = "salvo ✔"; refrescar();
    });
  }
  function addLead() {
    var msg = document.getElementById("ldAmsg"); msg.textContent = "";
    var tipo = document.getElementById("ldTipo").value;
    var chave = (document.getElementById("ldChave").value || "").trim();
    var dias = Number(document.getElementById("ldDias").value) || 3;
    if (!chave) { msg.style.color = "#d33"; msg.textContent = "informe a chave"; return; }
    sbc().from("cobertura_lead").upsert({ chave: chave, tipo: tipo, lead_dias: dias }, { onConflict: "chave,tipo" }).then(function (r) {
      if (r.error) { msg.style.color = "#d33"; msg.textContent = "erro: " + r.error.message; return; }
      msg.style.color = "#178a3a"; msg.textContent = "adicionado ✔"; listarLead(); refrescar();
    });
  }
  function excluirLead(chave, tipo) {
    sbc().from("cobertura_lead").delete().eq("chave", chave).eq("tipo", tipo).then(function (r) {
      if (!r.error) { listarLead(); refrescar(); }
    });
  }

  function refrescar() { if (window.Cobertura && typeof window.Cobertura.recarregar === "function") window.Cobertura.recarregar(); }

  // ---------- injeta o botao na aba Cobertura ----------
  function injetarBotao() {
    var wrap = document.querySelector(".pc .cob-wrap");
    if (!wrap) return false;
    if (wrap.querySelector("#cobadmOpen")) return true;
    if (!isAdmin()) return true; // nao mostra pra nao-admin (mas considera "feito")
    css();
    var b = document.createElement("button");
    b.id = "cobadmOpen";
    b.className = "cobadm-btn";
    b.textContent = "⚙️ Gerenciar carregamentos e lead";
    b.addEventListener("click", abrir);
    wrap.insertBefore(b, wrap.firstChild);
    return true;
  }

  // observa a montagem da aba Cobertura
  var tent = 0;
  var iv = setInterval(function () {
    if (injetarBotao() && document.querySelector("#cobadmOpen")) clearInterval(iv);
    if (++tent > 120) clearInterval(iv);
  }, 700);

  window.CoberturaAdmin = { abrir: abrir };
})();

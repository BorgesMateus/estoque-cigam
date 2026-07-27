/* =====================================================================
   cobertura.js — Aba "Cobertura" (semáforo de estoque dinâmico)
   Add-on do Painel Estoque CIGAM. Carregado via <script src> no index.html.

   Ideia: o mínimo de cada produto NÃO é fixo. Ele varia com:
     - o dia da semana (demanda_perfil: média vendida por produto x dia)
     - o tempo de reposição (cobertura_lead: quantos dias pra repor)
     - os carregamentos grandes na janela (carregamentos: "raspam" a câmara)

   Semáforo por produto:
     🔴 disponível não cobre nem a demanda até repor (risco de ruptura)
     🟡 cobre o dia-a-dia, mas um carregamento na janela pode zerar
     🟢 folgado (cobre demanda + reserva de carregamento)

   Reusa globais do index.html: sb, STATE, disponivelDe, saldoDe, nomeDe,
   fmt, escapeHtml, setTab. Tudo com guarda (não quebra se faltar).
   ===================================================================== */
(function () {
  "use strict";

  var LEAD_PADRAO = 3;      // dias, fallback se cobertura_lead vazio
  var HORIZONTE = 60;       // teto de dias pro cálculo de fôlego
  var DOW_NOMES = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

  var DB = { perfil: null, leads: null, carreg: null, atualizado: null };
  var UI = { filtro: "todos", busca: "", sort: { key: "ord", dir: 1 }, montado: false, renderizado: false };

  // ---------- utils ----------
  function fmtN(n) {
    if (typeof window.fmt === "function") return window.fmt(n);
    return (Number(n) || 0).toLocaleString("pt-BR", { maximumFractionDigits: 0 });
  }
  function esc(s) {
    if (typeof window.escapeHtml === "function") return window.escapeHtml(s);
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function grupoDe(cod) { return String(cod || "").slice(0, 6); }
  function hojeDate() { var d = new Date(); d.setHours(0, 0, 0, 0); return d; }
  function addDias(d, n) { var x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
  function isoData(d) { return d.toISOString().slice(0, 10); }
  function diffDias(a, b) { return Math.round((a.getTime() - b.getTime()) / 86400000); }

  function dispDe(it) {
    if (typeof window.disponivelDe === "function") return Number(window.disponivelDe(it)) || 0;
    if (typeof window.saldoDe === "function") return Number(window.saldoDe(it)) || 0;
    return Number(it && (it.disponivel != null ? it.disponivel : it.saldo)) || 0;
  }
  function descDe(it) { return (it && it.descricao) || (it && it.codigo) || "?"; }

  // ---------- carregar dados do banco ----------
  function precisaSb() { return typeof window.sb !== "undefined" && window.sb; }

  function carregarPerfil() {
    // demanda_perfil pode ter >1000 linhas -> pagina
    var perfil = {};       // perfil[cod][dow] = media
    var maxAt = null;
    var passo = 1000;
    function pagina(off) {
      return window.sb.from("demanda_perfil")
        .select("codigo,dow,media,atualizado_em")
        .range(off, off + passo - 1)
        .then(function (r) {
          var data = r.data || [];
          data.forEach(function (x) {
            var c = String(x.codigo).trim();
            if (!perfil[c]) perfil[c] = {};
            perfil[c][Number(x.dow)] = Number(x.media) || 0;
            if (x.atualizado_em && (!maxAt || x.atualizado_em > maxAt)) maxAt = x.atualizado_em;
          });
          if (data.length === passo) return pagina(off + passo);
        });
    }
    return pagina(0).then(function () { DB.perfil = perfil; DB.atualizado = maxAt; });
  }

  function carregarLeads() {
    return window.sb.from("cobertura_lead").select("chave,tipo,lead_dias").then(function (r) {
      var m = { global: LEAD_PADRAO, grupo: {}, produto: {} };
      (r.data || []).forEach(function (x) {
        var v = Number(x.lead_dias) || LEAD_PADRAO;
        if (x.tipo === "global") m.global = v;
        else if (x.tipo === "grupo") m.grupo[String(x.chave).trim()] = v;
        else if (x.tipo === "produto") m.produto[String(x.chave).trim()] = v;
      });
      DB.leads = m;
    });
  }

  function carregarCarreg() {
    return window.sb.from("carregamentos").select("id,data,descricao,escopo,grupos,codigos,fator")
      .order("data", { ascending: true }).then(function (r) {
        DB.carreg = (r.data || []).map(function (x) {
          return {
            id: x.id, data: String(x.data).slice(0, 10), descricao: x.descricao || "Carregamento",
            escopo: x.escopo || "todos",
            grupos: Array.isArray(x.grupos) ? x.grupos : [],
            codigos: Array.isArray(x.codigos) ? x.codigos.map(function (c) { return String(c).trim(); }) : [],
            fator: Number(x.fator) || 2
          };
        });
      });
  }

  // ---------- modelo ----------
  function leadDe(cod) {
    if (!DB.leads) return LEAD_PADRAO;
    if (DB.leads.produto[cod] != null) return DB.leads.produto[cod];
    var g = grupoDe(cod);
    if (DB.leads.grupo[g] != null) return DB.leads.grupo[g];
    return DB.leads.global;
  }
  function mediaDow(cod, dow) {
    var p = DB.perfil && DB.perfil[cod];
    return p ? (Number(p[dow]) || 0) : 0;
  }
  function mediaDiaria(cod) {
    var p = DB.perfil && DB.perfil[cod];
    if (!p) return 0;
    var s = 0; for (var d = 0; d < 7; d++) s += Number(p[d]) || 0;
    return s / 7;
  }
  function temPerfil(cod) { return !!(DB.perfil && DB.perfil[cod] && Object.keys(DB.perfil[cod]).length); }

  function carregNaJanela(cod, hoje, lead) {
    // carregamentos que atingem o produto entre hoje e hoje+lead (exclusivo do dia de reposição)
    var g = grupoDe(cod);
    return (DB.carreg || []).filter(function (c) {
      var dt = new Date(c.data + "T00:00:00");
      var dd = diffDias(dt, hoje);
      if (dd < 0 || dd >= lead) return false;
      if (c.escopo === "todos") return true;
      if (c.grupos && c.grupos.indexOf(g) >= 0) return true;
      if (c.codigos && c.codigos.indexOf(cod) >= 0) return true;
      return false;
    });
  }
  function proxCarreg(cod, hoje) {
    var g = grupoDe(cod);
    var lst = (DB.carreg || []).filter(function (c) {
      var dt = new Date(c.data + "T00:00:00");
      if (diffDias(dt, hoje) < 0) return false;
      if (c.escopo === "todos") return true;
      if (c.grupos && c.grupos.indexOf(g) >= 0) return true;
      if (c.codigos && c.codigos.indexOf(cod) >= 0) return true;
      return false;
    });
    return lst.length ? lst[0] : null;
  }

  function calcular(it) {
    var cod = it.codigo;
    var hoje = hojeDate();
    var lead = leadDe(cod);
    var disp = dispDe(it);

    // demanda até repor (soma dos próximos "lead" dias, por dia-da-semana)
    var demJanela = 0;
    for (var i = 0; i < lead; i++) {
      var dow = addDias(hoje, i).getDay();
      demJanela += mediaDow(cod, dow);
    }
    // reserva de carregamentos na janela: fator x demanda média diária, por carregamento
    var cargas = carregNaJanela(cod, hoje, lead);
    var mediaDia = mediaDiaria(cod);
    var reserva = 0;
    cargas.forEach(function (c) { reserva += c.fator * mediaDia; });

    var minimoDia = demJanela + reserva;

    // fôlego: quantos dias o disponível aguenta consumindo perfil + carregamentos
    var restante = disp, folego = 0;
    for (var d = 0; d < HORIZONTE; d++) {
      var dia = addDias(hoje, d);
      var consumo = mediaDow(cod, dia.getDay());
      // carregamento que cai nesse dia
      (DB.carreg || []).forEach(function (c) {
        if (c.data === isoData(dia)) {
          var g = grupoDe(cod);
          var aplica = c.escopo === "todos" || (c.grupos && c.grupos.indexOf(g) >= 0) || (c.codigos && c.codigos.indexOf(cod) >= 0);
          if (aplica) consumo += c.fator * mediaDia;
        }
      });
      if (consumo <= 0) { folego = d >= 1 ? folego : HORIZONTE; if (restante <= 0) break; continue; }
      if (restante - consumo < 0) { folego = d + (restante / consumo); break; }
      restante -= consumo; folego = d + 1;
      if (d === HORIZONTE - 1) folego = HORIZONTE;
    }
    if (!temPerfil(cod)) folego = Infinity;

    var status;   // 0 verde, 1 amarelo, 2 vermelho
    if (!temPerfil(cod)) status = -1;                    // sem histórico
    else if (disp < demJanela) status = 2;
    else if (disp < minimoDia) status = 1;
    else status = 0;

    var pc = proxCarreg(cod, hoje);

    return {
      it: it, cod: cod, desc: descDe(it), um: it.um || "",
      disp: disp, lead: lead, demJanela: demJanela, reserva: reserva,
      minimoDia: minimoDia, folego: folego, status: status,
      cargasJanela: cargas.length,
      proxCarreg: pc ? { dias: diffDias(new Date(pc.data + "T00:00:00"), hoje), desc: pc.descricao, data: pc.data } : null
    };
  }

  function linhas() {
    var mats = (window.STATE && window.STATE.materiais) || [];
    // fora os ignorados, se houver esse conceito
    var ign = (window.STATE && window.STATE.ignorados) || null;
    var base = mats.filter(function (it) {
      if (ign && typeof ign.has === "function" && ign.has(it.codigo)) return false;
      return true;
    });
    var rows = base.map(calcular);
    // ordem padrão: pior primeiro (status desc), depois fôlego asc
    rows.forEach(function (r) { r.ord = r.status < 0 ? -1 : r.status; });
    aplicarFiltroSort(rows);
    return rows;
  }

  function aplicarFiltroSort(rows) {
    var q = UI.busca.toLowerCase();
    if (q) {
      for (var i = rows.length - 1; i >= 0; i--) {
        var r = rows[i];
        if (r.cod.toLowerCase().indexOf(q) < 0 && r.desc.toLowerCase().indexOf(q) < 0) rows.splice(i, 1);
      }
    }
    if (UI.filtro !== "todos") {
      var alvo = UI.filtro === "vermelho" ? 2 : UI.filtro === "amarelo" ? 1 : UI.filtro === "verde" ? 0 : -1;
      for (var j = rows.length - 1; j >= 0; j--) if (rows[j].status !== alvo) rows.splice(j, 1);
    }
    var k = UI.sort.key, dir = UI.sort.dir;
    rows.sort(function (a, b) {
      if (k === "ord") { // pior primeiro + fôlego
        if (b.status !== a.status) return (b.status - a.status);
        var fa = isFinite(a.folego) ? a.folego : 1e9, fb = isFinite(b.folego) ? b.folego : 1e9;
        return fa - fb;
      }
      var va = a[k], vb = b[k];
      if (k === "desc" || k === "cod") return String(va).localeCompare(String(vb), "pt-BR") * dir;
      if (!isFinite(va)) va = 1e12; if (!isFinite(vb)) vb = 1e12;
      return (va - vb) * dir;
    });
  }

  // ---------- UI ----------
  function css() {
    if (document.getElementById("cob-css")) return;
    var s = document.createElement("style");
    s.id = "cob-css";
    s.textContent = [
      '.pc{display:none}',
      'body[data-tab="cobertura"] .pe,body[data-tab="cobertura"] .pv,body[data-tab="cobertura"] .pm,body[data-tab="cobertura"] .pp,body[data-tab="cobertura"] .px{display:none!important}',
      'body[data-tab="cobertura"] .pc{display:block}',
      '.cob-wrap{max-width:1180px;margin:0 auto;padding:8px 4px 40px}',
      '.cob-cards{display:flex;gap:10px;flex-wrap:wrap;margin:6px 0 12px}',
      '.cob-card{flex:1;min-width:120px;background:#fff;border:1px solid #e6e6ef;border-radius:12px;padding:10px 14px;box-shadow:0 1px 2px rgba(0,0,0,.04)}',
      '.cob-card b{font-size:26px;display:block;line-height:1.1}',
      '.cob-card span{font-size:12px;color:#667}',
      '.cob-card.g b{color:#149a52}.cob-card.y b{color:#c98a00}.cob-card.r b{color:#d33}',
      '.cob-banner{background:#fff7e6;border:1px solid #ffe1a8;color:#7a5300;border-radius:10px;padding:9px 13px;margin:0 0 12px;font-size:13px}',
      '.cob-banner.none{background:#f2f5ff;border-color:#dbe4ff;color:#33507a}',
      '.cob-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 10px}',
      '.cob-chip{cursor:pointer;border:1px solid #d7d7e6;background:#fff;border-radius:20px;padding:4px 12px;font-size:13px;user-select:none}',
      '.cob-chip.on{background:#111;color:#fff;border-color:#111}',
      '.cob-search{flex:1;min-width:160px;padding:6px 10px;border:1px solid #d7d7e6;border-radius:8px;font-size:13px}',
      '.cob-tbl{width:100%;border-collapse:collapse;font-size:13px;background:#fff;border:1px solid #ececf3;border-radius:10px;overflow:hidden}',
      '.cob-tbl th{position:sticky;top:0;background:#fafaff;text-align:left;padding:8px 9px;font-weight:600;color:#556;border-bottom:1px solid #ececf3;cursor:pointer;white-space:nowrap}',
      '.cob-tbl th.num,.cob-tbl td.num{text-align:right}',
      '.cob-tbl td{padding:7px 9px;border-bottom:1px solid #f2f2f7;white-space:nowrap}',
      '.cob-tbl tr:hover td{background:#fbfbff}',
      '.cob-tbl td.prod{white-space:normal;min-width:180px}',
      '.cob-dot{display:inline-block;width:11px;height:11px;border-radius:50%;margin-right:5px;vertical-align:middle}',
      '.cob-dot.g{background:#1bbd5f}.cob-dot.y{background:#f0ad00}.cob-dot.r{background:#e23a3a}.cob-dot.n{background:#c7c7d2}',
      '.cob-r td{background:#fff5f5}.cob-y td{background:#fffaf0}',
      '.cob-mut{color:#99a}',
      '.cob-help{font-size:12px;color:#778;margin:10px 2px;line-height:1.5}',
      '.cob-folego b{font-variant-numeric:tabular-nums}'
    ].join("\n");
    document.head.appendChild(s);
  }

  function montar() {
    if (UI.montado) return;
    css();
    // botão de aba
    var nav = document.querySelector(".tabs");
    if (nav && !nav.querySelector('button[data-tab="cobertura"]')) {
      var b = document.createElement("button");
      b.setAttribute("data-tab", "cobertura");
      b.textContent = "🚦 Cobertura";
      b.addEventListener("click", function () { irCobertura(); });
      nav.appendChild(b);
    }
    // painel
    if (!document.querySelector(".pc")) {
      var sec = document.createElement("section");
      sec.className = "pc";
      sec.innerHTML = '<div class="cob-wrap">' +
        '<div id="cobCards" class="cob-cards"></div>' +
        '<div id="cobBanner"></div>' +
        '<div class="cob-bar">' +
        '<span class="cob-chip on" data-f="todos">Todos</span>' +
        '<span class="cob-chip" data-f="vermelho">🔴 Crítico</span>' +
        '<span class="cob-chip" data-f="amarelo">🟡 Atenção</span>' +
        '<span class="cob-chip" data-f="verde">🟢 Folgado</span>' +
        '<input id="cobBusca" class="cob-search" placeholder="Buscar produto ou código…">' +
        '</div>' +
        '<div style="overflow:auto"><table class="cob-tbl"><thead><tr>' +
        '<th data-k="cod">Código</th>' +
        '<th data-k="desc">Produto</th>' +
        '<th class="num" data-k="disp">Disponível</th>' +
        '<th class="num" data-k="demJanela" title="Demanda estimada até repor (lead)">Demanda p/ repor</th>' +
        '<th class="num" data-k="minimoDia" title="Demanda + reserva dos carregamentos na janela">Mínimo do dia</th>' +
        '<th class="num" data-k="folego" title="Quantos dias o estoque aguenta">Fôlego</th>' +
        '<th data-k="prox">Próx. carregamento</th>' +
        '<th style="text-align:center" data-k="ord">🚦</th>' +
        '</tr></thead><tbody id="cobBody"></tbody></table></div>' +
        '<div class="cob-help">' +
        '🚦 <b>Como ler:</b> o <b>mínimo do dia</b> é a demanda estimada até o estoque ser reposto (varia por dia da semana), ' +
        'mais uma <b>reserva</b> pra cada carregamento grande na janela (que "raspa" a câmara). ' +
        '<b>🔴 Crítico</b>: não cobre nem a demanda até repor. <b>🟡 Atenção</b>: cobre o dia-a-dia, mas um carregamento pode zerar. ' +
        '<b>🟢 Folgado</b>: cobre tudo. <span id="cobAtualizado"></span>' +
        '</div></div>';
      var host = document.querySelector("main") || document.body;
      host.appendChild(sec);
      // eventos
      sec.querySelectorAll(".cob-chip").forEach(function (ch) {
        ch.addEventListener("click", function () {
          sec.querySelectorAll(".cob-chip").forEach(function (x) { x.classList.remove("on"); });
          ch.classList.add("on"); UI.filtro = ch.getAttribute("data-f"); render();
        });
      });
      sec.querySelector("#cobBusca").addEventListener("input", function (e) { UI.busca = e.target.value || ""; render(); });
      sec.querySelectorAll(".cob-tbl th[data-k]").forEach(function (th) {
        th.addEventListener("click", function () {
          var k = th.getAttribute("data-k");
          if (k === "prox") return;
          if (UI.sort.key === k) UI.sort.dir *= -1; else { UI.sort.key = k; UI.sort.dir = (k === "cod" || k === "desc") ? 1 : 1; }
          render();
        });
      });
    }
    UI.montado = true;
    protegerNavegacao();
  }

  function irCobertura() {
    montar();
    document.body.dataset.tab = "cobertura";
    document.querySelectorAll(".tabs button").forEach(function (b) {
      b.classList.toggle("on", b.dataset.tab === "cobertura");
    });
    assegurarBotao();
    garantirDadosERender();
  }

  // protege contra o permissoes.js esconder/bloquear a aba nova
  function assegurarBotao() {
    var b = document.querySelector('.tabs button[data-tab="cobertura"]');
    if (b) { b.style.setProperty("display", "", "important"); b.hidden = false; }
  }
  function protegerNavegacao() {
    if (window.__cobSetTab) return;
    window.__cobSetTab = true;
    var anterior = window.setTab;
    window.setTab = function (t) {
      if (t === "cobertura") { irCobertura(); return; }
      if (typeof anterior === "function") return anterior.apply(this, arguments);
    };
    // reexibe o botão periodicamente nos primeiros segundos (o gate roda no login)
    var n = 0;
    var iv = setInterval(function () { assegurarBotao(); if (++n > 20) clearInterval(iv); }, 500);
  }

  function garantirDadosERender() {
    var body = document.getElementById("cobBody");
    if (DB.perfil && DB.leads && DB.carreg) { render(); return; }
    if (body) body.innerHTML = '<tr><td colspan="8" class="cob-mut">Carregando demanda…</td></tr>';
    if (!precisaSb()) { if (body) body.innerHTML = '<tr><td colspan="8" class="cob-mut">Banco indisponível.</td></tr>'; return; }
    Promise.all([
      DB.perfil ? Promise.resolve() : carregarPerfil(),
      DB.leads ? Promise.resolve() : carregarLeads(),
      DB.carreg ? Promise.resolve() : carregarCarreg()
    ]).then(render).catch(function (e) {
      if (body) body.innerHTML = '<tr><td colspan="8" class="cob-mut">Erro ao carregar: ' + esc(e && e.message) + "</td></tr>";
    });
  }

  function corLetra(st) { return st === 2 ? "r" : st === 1 ? "y" : st === 0 ? "g" : "n"; }
  function folegoTxt(f) {
    if (!isFinite(f)) return '<span class="cob-mut">—</span>';
    if (f >= HORIZONTE) return "60+ d";
    var v = f < 10 ? f.toFixed(1) : Math.round(f);
    return "<b>" + v + "</b> d";
  }

  function render() {
    var body = document.getElementById("cobBody");
    if (!body) return;
    var rows = linhas();

    // cards (sobre a base toda, não sobre o filtro)
    var todos = ((window.STATE && window.STATE.materiais) || []).filter(function (it) {
      var ign = window.STATE && window.STATE.ignorados;
      return !(ign && ign.has && ign.has(it.codigo));
    }).map(calcular);
    var g = 0, y = 0, r = 0, n = 0;
    todos.forEach(function (x) { if (x.status === 2) r++; else if (x.status === 1) y++; else if (x.status === 0) g++; else n++; });
    var cards = document.getElementById("cobCards");
    if (cards) cards.innerHTML =
      '<div class="cob-card"><b>' + todos.length + '</b><span>produtos</span></div>' +
      '<div class="cob-card r"><b>' + r + '</b><span>🔴 crítico</span></div>' +
      '<div class="cob-card y"><b>' + y + '</b><span>🟡 atenção</span></div>' +
      '<div class="cob-card g"><b>' + g + '</b><span>🟢 folgado</span></div>' +
      (n ? '<div class="cob-card"><b>' + n + '</b><span>sem histórico</span></div>' : "");

    // banner: próximo carregamento geral
    var hoje = hojeDate();
    var futuros = (DB.carreg || []).filter(function (c) { return diffDias(new Date(c.data + "T00:00:00"), hoje) >= 0; });
    var ban = document.getElementById("cobBanner");
    if (ban) {
      if (futuros.length) {
        var c0 = futuros[0]; var dd = diffDias(new Date(c0.data + "T00:00:00"), hoje);
        ban.className = "cob-banner";
        ban.innerHTML = "📦 <b>Próximo carregamento:</b> " + esc(c0.descricao) + " — " +
          (dd === 0 ? "<b>hoje</b>" : dd === 1 ? "<b>amanhã</b>" : "em <b>" + dd + " dias</b>") +
          " (" + c0.data.split("-").reverse().join("/") + ")";
      } else {
        ban.className = "cob-banner none";
        ban.innerHTML = "📦 Nenhum carregamento cadastrado. Cadastre as datas dos carregamentos grandes pra reserva entrar no cálculo (aba de admin).";
      }
    }

    var at = document.getElementById("cobAtualizado");
    if (at) at.innerHTML = DB.atualizado ? ' &nbsp;·&nbsp; demanda atualizada em ' + String(DB.atualizado).slice(0, 10).split("-").reverse().join("/") : "";

    if (!rows.length) { body.innerHTML = '<tr><td colspan="8" class="cob-mut">Nenhum produto neste filtro.</td></tr>'; return; }

    body.innerHTML = rows.map(function (x) {
      var cl = corLetra(x.status);
      var trcl = x.status === 2 ? "cob-r" : x.status === 1 ? "cob-y" : "";
      var prox = x.proxCarreg
        ? (x.proxCarreg.dias === 0 ? "hoje" : x.proxCarreg.dias === 1 ? "amanhã" : x.proxCarreg.dias + "d") +
          ' <span class="cob-mut">' + esc((x.proxCarreg.desc || "").slice(0, 18)) + "</span>"
        : '<span class="cob-mut">—</span>';
      var leadTip = 'lead ' + x.lead + "d" + (x.reserva > 0 ? " · reserva carreg. " + fmtN(x.reserva) : "");
      var minCell = x.status < 0 ? '<span class="cob-mut">—</span>'
        : '<span title="' + leadTip + '">' + fmtN(x.minimoDia) + "</span>";
      return '<tr class="' + trcl + '">' +
        "<td>" + x.cod + "</td>" +
        '<td class="prod">' + esc(x.desc) + "</td>" +
        '<td class="num">' + fmtN(x.disp) + "</td>" +
        '<td class="num">' + (x.status < 0 ? '<span class="cob-mut">—</span>' : fmtN(x.demJanela)) + "</td>" +
        '<td class="num">' + minCell + "</td>" +
        '<td class="num cob-folego">' + folegoTxt(x.folego) + "</td>" +
        "<td>" + prox + "</td>" +
        '<td style="text-align:center"><span class="cob-dot ' + cl + '" title="' +
          (x.status === 2 ? "Crítico" : x.status === 1 ? "Atenção" : x.status === 0 ? "Folgado" : "Sem histórico") + '"></span></td>' +
        "</tr>";
    }).join("");
    UI.renderizado = true;
  }

  // ---------- boot ----------
  function esperarBase(tent) {
    tent = tent || 0;
    var pronto = document.querySelector(".tabs") && (window.STATE || typeof window.setTab === "function");
    if (pronto) { montar(); assegurarBotao(); return; }
    if (tent > 60) { return; } // desiste após ~30s
    setTimeout(function () { esperarBase(tent + 1); }, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { esperarBase(); });
  } else {
    esperarBase();
  }

  // expõe pra debug/uso externo
  window.Cobertura = { ir: irCobertura, recarregar: function () { DB.perfil = DB.leads = DB.carreg = null; garantirDadosERender(); } };
})();

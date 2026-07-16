/* =====================================================================
   agente.js \u2014 Agente de pedidos em linguagem natural (LLM) + contexto do cliente
   Carregado DEPOIS do index.html. Sobrescreve as funcoes globais do chat
   "Criar pedido" para aceitar frases naturais com varios itens de uma vez
   ("manda 10 coxinha de carne e 5 pao de queijo") e mostrar o contexto do
   cliente ao seleciona-lo. Usa as Edge Functions interpretar-pedido (cerebro)
   e criar-pedido (ja existente). Sem alterar o miolo do index.html.
   ===================================================================== */
(function () {
  "use strict";

  // ---- helpers ----
  function T(s) { return (typeof trim === "function") ? trim(s) : String(s == null ? "" : s).trim(); }
  function acha(cod) { return (STATE.materiais || []).find(function (m) { return m.codigo === cod; }); }
  function curto(desc) { return String(desc || "").split(/\s+/).slice(0, 3).join(" "); }
  function fnUrl(path) { return CONFIG.SUPABASE_URL + "/functions/v1/" + path; }
  function sbHead() { return { apikey: CONFIG.SUPABASE_ANON_KEY, Authorization: "Bearer " + CONFIG.SUPABASE_ANON_KEY }; }

  function chamarFuncao(path, body) {
    return fetch(fnUrl(path), {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, sbHead()),
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); });
  }
  function rest(path) {
    return fetch(CONFIG.SUPABASE_URL + "/rest/v1/" + path, { headers: sbHead() })
      .then(function (r) { return r.json(); }).catch(function () { return []; });
  }

  // ---------- Interpretacao em linguagem natural (substitui o parser rigido) ----------
  window.chAddItem = async function (texto) {
    if (CH.rodando) return;
    if (!STATE.materiais || !STATE.materiais.length) { addMsg("bot", "Preciso do catalogo carregado \u2014 atualiza o painel (aba Estoque) e volta aqui."); return; }
    CH.rodando = true;
    var st = addMsg("bot", "\u{1F914} Entendendo o pedido\u2026");
    try {
      var catalogo = STATE.materiais.map(function (p) { return { c: p.codigo, d: p.descricao, u: p.um }; });
      var j = await chamarFuncao("interpretar-pedido", { mensagem: texto, catalogo: catalogo });
      CH.rodando = false;
      if (!j || !j.ok) { st.innerHTML = "\u274C " + escapeHtml((j && j.erro) || "nao consegui interpretar"); return; }
      var add = 0;
      var duvT = {}; (j.duvidas || []).forEach(function (d) { duvT[String(d.trecho)] = 1; });
      (j.itens || []).forEach(function (it) {
        if (duvT[String(it.trecho)]) return; // ambiguo: vai como duvida, nao adiciona palpite
        var p = acha(it.codigo); if (!p) return;
        CH.itens.push({ cod: p.codigo, desc: p.descricao, um: it.unidade || p.um, qtd: it.quantidade });
        add++;
      });
      var html = "";
      if (add) html += "\u2714 Adicionei <b>" + add + "</b> item(ns).<br>";
      CH.duvidas = j.duvidas || [];
      if (CH.duvidas.length) {
        html += "\u{1F914} Fiquei na duvida \u2014 clica na opcao certa:<br>";
        CH.duvidas.forEach(function (d, di) {
          var q = (String(d.trecho || "").match(/[\d.,]+/) || ["1"])[0];
          html += "<div class='muted' style='margin-top:4px'>\"" + escapeHtml(d.trecho || "") + "\":</div>";
          html += (d.opcoes || []).map(function (o, oi) {
            return "<span class='opc' onclick=\"chDuvidaPick(" + di + "," + oi + ",'" + q + "')\">" + escapeHtml(o.descricao) + "</span>";
          }).join("<br>") + "<br>";
        });
      }
      if ((j.naoEncontrados || []).length) {
        html += "\u26A0 Nao achei no catalogo: <i>" + escapeHtml(j.naoEncontrados.join(", ")) + "</i> \u2014 tenta outro nome.<br>";
      }
      if (!add && !CH.duvidas.length && !(j.naoEncontrados || []).length) {
        html += "Nao peguei nenhum item. Tenta assim: <i>10 coxinha de carne, 5 pao de queijo</i>.<br>";
      }
      html += "Total no pedido: <b>" + CH.itens.length + "</b> item(ns). Manda mais, ou digite <b>pronto</b> pra revisar.";
      st.innerHTML = html;
    } catch (e) {
      CH.rodando = false;
      st.innerHTML = "\u274C " + escapeHtml(String((e && e.message) || e));
    }
  };

  // clique numa opcao de duvida -> adiciona o item escolhido
  window.chDuvidaPick = function (di, oi, q) {
    var d = (CH.duvidas || [])[di]; if (!d) return;
    var o = (d.opcoes || [])[oi]; if (!o) return;
    var p = acha(o.codigo); if (!p) { addMsg("bot", "esse produto nao esta no catalogo carregado."); return; }
    var qtd = parseFloat(String(q).replace(".", "").replace(",", ".")) || 1;
    CH.itens.push({ cod: p.codigo, desc: p.descricao, um: p.um, qtd: qtd });
    addMsg("bot", "+ " + fmt(qtd) + " " + p.um + " de " + escapeHtml(p.descricao) + " \u2714 (" + CH.itens.length + " item(ns)). Mais algum? Ou <b>pronto</b>.");
  };

  // ---------- Contexto do cliente (4 blocos) ----------
  async function contexto(codigo) {
    var out = { ultimo: null, mais: [], tabela: "", forma: "" };
    try {
      var rows = await rest("vendas?cliente=eq." + encodeURIComponent(codigo) + "&select=data,pedido,codigo,quantidade,total&order=data.desc&limit=800");
      if (Array.isArray(rows) && rows.length) {
        var td = rows[0].data, tp = rows[0].pedido, a1 = {};
        rows.forEach(function (x) { if (x.data === td && x.pedido === tp) a1[x.codigo] = (a1[x.codigo] || 0) + (+x.quantidade || 0); });
        out.ultimo = { data: td, itens: Object.keys(a1).map(function (c) { return { desc: acha(c) ? acha(c).descricao : c, qtd: Math.round(a1[c]) }; }) };
        var ag = {};
        rows.forEach(function (x) { ag[x.codigo] = (ag[x.codigo] || 0) + (+x.quantidade || 0); });
        out.mais = Object.keys(ag).sort(function (a, b) { return ag[b] - ag[a]; }).slice(0, 5).map(function (c) { return acha(c) ? acha(c).descricao : c; });
      }
    } catch (e) {}
    try {
      if (typeof token === "function" && token()) {
        var sel = encodeURIComponent("Codigo,CodigoTabelaPreco,CodigoCondicaoPagamento");
        var f = encodeURIComponent("Codigo eq '" + codigo + "'");
        var arr = await fetch(CONFIG.API_BASE + "/genericos/ge/Pessoa/Buscar?%24select=" + sel + "&%24filter=" + f + "&%24top=3", { headers: { Authorization: "Bearer " + token() } })
          .then(function (r) { return r.json(); }).catch(function () { return []; });
        var c = (Array.isArray(arr) ? arr : []).find(function (p) { return String(p.Codigo).trim() === codigo; });
        if (c) { out.tabela = String(c.CodigoTabelaPreco || "").trim(); out.forma = String(c.CodigoCondicaoPagamento || "").trim(); }
      }
    } catch (e) {}
    return out;
  }

  window.chMostrarContexto = async function () {
    if (!CH.cliente) return;
    var d = addMsg("bot", "\u{1F4C7} <span class='muted'>puxando o historico do cliente\u2026</span>");
    var ctx = await contexto(CH.cliente.codigo);
    var html = "\u{1F4C7} <b>Contexto do cliente</b><br>";
    if (ctx.ultimo && ctx.ultimo.itens.length) {
      html += "\u2022 <b>Ultimo pedido</b> (" + String(ctx.ultimo.data).split("-").reverse().join("/") + "): " +
        ctx.ultimo.itens.map(function (i) { return i.qtd + " " + escapeHtml(curto(i.desc)); }).join(", ") + "<br>";
    } else html += "\u2022 <span class='muted'>Sem historico de compras registrado.</span><br>";
    if (ctx.mais.length) html += "\u2022 <b>Mais comprados</b>: " + ctx.mais.map(function (x) { return escapeHtml(curto(x)); }).join(", ") + "<br>";
    if (ctx.tabela || ctx.forma) html += "\u2022 <b>Tabela</b>: " + escapeHtml(ctx.tabela || "?") + " \u00B7 <b>Pagamento</b>: " + escapeHtml(ctx.forma || "?") + "<br>";
    else html += "\u2022 <span class='muted'>Tabela/pagamento saem do cadastro do CIGAM na hora de criar.</span><br>";
    d.innerHTML = html;
  };

  // ---------- Substitui a busca/selecao de cliente (mesma logica + contexto + guia natural) ----------
  var GUIA = "Agora me manda o pedido do seu jeito \u2014 ex.: <i>10 coxinha de carne, 5 pao de queijo, 2 enroladinho</i>. Quando terminar, digite <b>pronto</b>.";

  window.chBuscarCliente = async function (termo) {
    if (!sb) { addMsg("bot", "Preciso do banco configurado pra buscar clientes."); return; }
    var t = T(termo).replace(/^pedido (para|pro|pra)\s+/i, "");
    var q = sb.from("clientes").select("codigo,nome,fantasia,municipio").limit(6);
    q = /^\d{3,6}$/.test(t) ? q.eq("codigo", t.padStart(6, "0")) : q.or("nome.ilike.%" + t + "%,fantasia.ilike.%" + t + "%");
    var resp = await q;
    var data = resp && resp.data;
    var ops = (data || []).map(function (c) { return { codigo: T(c.codigo), nome: T(c.fantasia) || T(c.nome), cidade: T(c.municipio) }; });
    if (!ops.length) { addMsg("bot", "Nao achei cliente com \"" + escapeHtml(t) + "\". Tenta outro pedaco do nome ou o codigo."); return; }
    if (ops.length === 1) {
      CH.cliente = ops[0]; CH.etapa = "itens";
      addMsg("bot", "Cliente: <b>" + escapeHtml(ops[0].nome) + "</b> (" + ops[0].codigo + " \u00B7 " + escapeHtml(ops[0].cidade || "?") + ") \u2714<br>" + GUIA);
      window.chMostrarContexto();
      return;
    }
    CH.opcoes = ops; CH.etapa = "cliente-escolha";
    addMsg("bot", "Achei mais de um \u2014 clica ou digita o numero:<br>" + ops.map(function (o, i) {
      return "<span class='opc' onclick=\"chEscolha(" + i + ")\">" + (i + 1) + ". " + escapeHtml(o.nome) + " \u00B7 " + escapeHtml(o.cidade || "?") + " (" + o.codigo + ")</span>";
    }).join("<br>"));
  };

  window.chEscolha = function (i) {
    var o = (CH.opcoes || [])[i]; if (!o) return;
    if (CH.etapa === "cliente-escolha") {
      CH.cliente = o; CH.etapa = "itens";
      addMsg("bot", "Cliente: <b>" + escapeHtml(o.nome) + "</b> (" + o.codigo + ") \u2714<br>" + GUIA);
      CH.opcoes = null;
      window.chMostrarContexto();
      return;
    }
    CH.opcoes = null;
  };

  console.info("[agente] chat em linguagem natural + contexto do cliente ativos");
})();

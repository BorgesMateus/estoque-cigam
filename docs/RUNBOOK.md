# Runbook

O que fazer quando alguma coisa não acontece. Escrito na ordem em que os problemas
apareceram de verdade.

## Diagnóstico rápido

1. **Actions → o workflow rodou?** Se não há execução no horário, o problema é o cron
   do GitHub, não o código.
2. **Rodou e falhou?** Abra o log. Os robôs imprimem contagens em cada etapa.
3. **Rodou verde mas o dado não apareceu?** Quase sempre é paginação de 1000 linhas ou
   escrita em tabela errada.
4. **O painel está vazio?** Console do navegador. Erro de RLS aparece como array vazio
   sem exceção — silencioso e traiçoeiro.

Sempre que precisar rodar algo fora de hora: **Actions → o workflow → Run workflow**.
Todos são idempotentes; rodar de novo não estraga nada.

## O relatório do WhatsApp não chegou

Ordem de checagem:

1. Actions: o `wa-relatorio` rodou hoje? **Se não rodou nenhuma das três vezes, é o cron
   do GitHub.** Já aconteceu duas vezes. Dispare manualmente e siga o dia.
2. Rodou e o log diz `Relatorio de <data> ja foi enviado hoje`? Então foi enviado — a
   trava de idempotência está fazendo o trabalho dela. Para forçar, rode com `--forcar`.
3. Log com **código 401**: a sessão do WhatsApp foi desconectada no celular. O robô
   apaga a sessão e gera QR novo sozinho, mas alguém precisa escanear. Rode
   `wa-parear`, abra `wa.html` no navegador e leia o QR em até 90 segundos.
4. Log com **código 515**: reinício normal do protocolo. O robô já trata.
5. Log com **408**: a janela do QR expirou sem ninguém escanear. Rode `wa-parear` de novo
   e esteja com o celular na mão.
6. `Numero ... nao encontrado no WhatsApp`: confira a variável `WA_NUMERO` (só dígitos,
   com DDI e DDD).

O QR nunca aparece legível no log do Actions — é arte ASCII e quebra. Use `wa.html`.

## O snapshot não rodou

Sem snapshot do dia, o painel mostra o dia anterior e o relatório sai defasado.
Dispare o workflow manualmente. Se falhar no login do CIGAM, o log traz
`login CIGAM falhou`: confirme com o time do ERP se o usuário de API continua ativo e
se a senha não expirou.

## As vendas estão faltando dias

`vendas.mjs` aceita `DIAS`. Para reprocessar a última semana, rode o workflow com
`DIAS=7`. Para refazer tudo, `DIAS=999` — leva alguns minutos e é seguro, porque é
upsert por (pedido, item).

## Um item novo não aparece no painel

O robô só traz o **grupo 002**. Se o item foi cadastrado em outro grupo no CIGAM, ele
não entra. Confirme o código no ERP antes de caçar bug no código.

## O mapa mostra a cidade em vez da região

A faixa de CEP daquele cliente ainda não está no cache, ou está sem coordenada.
Rode "Geocodificar CEPs" — é incremental e só ataca o que falta. Se persistir depois de
duas rodadas, o CEP do cliente provavelmente está errado no cadastro do CIGAM: nenhuma
das três bases consultadas reconhece a faixa. Nesse caso, corrija no ERP.

## Preciso alterar o banco

1. Crie o arquivo em `supabase/sql/`, versionado.
2. Actions → **Rodar SQL (Supabase)** → informe o caminho do arquivo.
3. Confira o resumo da execução: ele imprime o HTTP e a resposta.

Se for colar SQL inline no campo do workflow, lembre: **uma linha só e sem comentários
`--`**. E termine com `notify pgrst, 'reload schema';`.

## Cron do GitHub atrasando

É comportamento conhecido e documentado da plataforma, não é bug do projeto. Sintomas:
execução horas depois do horário, ou dia inteiro sem execução. Mitigação já aplicada no
`wa-relatorio`: três horários e trava de idempotência.

Se um dia isso não bastar, a alternativa é disparar pelo agendador do Supabase (pg_cron
chamando a API do GitHub), o que exige um token de acesso criado pelo dono do repositório.
Está no backlog, ainda não decidido.

## Contatos de sistema

- **CIGAM**: instância em nuvem da empresa. Catálogo de endpoints em `/api/help`.
- **Supabase**: projeto próprio; a referência do projeto está no workflow `apply-sql.yml`.
- **GitHub Pages**: publica a raiz do repositório na branch `main`.

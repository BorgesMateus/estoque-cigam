# Decisões

Por que as coisas são como são. Serve para não refazer discussão já vencida — e para
saber quando vale reabrir.

## Supabase + GitHub Actions em vez de servidor

**Decisão:** todo o back-end é Postgres gerenciado mais cron do GitHub.
**Por quê:** custo zero, nada para manter, e o volume é pequeno (dezenas de milhares de
linhas por mês).
**Custo aceito:** o cron do GitHub é best-effort e já falhou. Mitigado com repesca e
idempotência.
**Quando reabrir:** se aparecer rotina que precise de horário garantido ou de execução
mais frequente que de hora em hora.

## Painel em arquivo único, sem build

**Decisão:** `index.html` com tudo dentro, servido pelo GitHub Pages.
**Por quê:** dava para editar e publicar sem toolchain nenhuma, o que importava na fase
de descobrir o que o painel precisava ser.
**Custo aceito:** o arquivo passou de 2000 linhas e virou difícil de mexer sem medo.
**Status:** decisão vencida. Ver item 4 do backlog.

## Robôs sem dependências

**Decisão:** `fetch` nativo do Node 20, nada de `axios`, `dotenv` ou cliente do Supabase
no servidor. Exceção: `wa.mjs`, que precisa do Baileys.
**Por quê:** nada para atualizar, nada para auditar, o workflow sobe em segundos.
**Manter.** Só adicione dependência quando a alternativa for reescrever um protocolo.

## Snapshot diário em vez de tempo real

**Decisão:** uma fotografia por dia por item e filial.
**Por quê:** o que a operação decide é reposição, que é decisão diária. Tempo real
custaria muito mais chamada de API sem mudar nenhuma decisão.
**Efeito colateral bom:** o histórico virou a base do mínimo dinâmico e da conferência
de contagem física.

## Filial 001 como único estoque real

**Decisão:** toda consulta de estoque filtra `filial = '001'`.
**Por quê:** as filiais 002 e 100 têm ~10000 unidades em quase todo item — massa de
teste que ninguém limpou. Somar tudo dá número sem sentido.
**Revisar se:** a empresa passar a operar um segundo centro de distribuição de verdade.

## Conferência de contagem contra o saldo inicial

**Decisão:** comparar a contagem física com o fechamento do dia anterior, não com o
saldo do momento.
**Por quê:** o saldo corrente já abate demanda faturada que ainda não saiu fisicamente
da empresa — o físico estaria sempre "sobrando" contra o sistema.
**Achado que veio junto:** os totais por família batem com folga (diferença geral de
~3%), enquanto os itens divergem bastante entre si. Isso aponta troca de gramagem entre
códigos parecidos na contagem ou no lançamento, não falta de estoque.

## Mapa por faixa de CEP em vez de município

**Decisão:** agrupar o faturamento pelos 5 primeiros dígitos do CEP.
**Por quê:** Brasília inteira virava uma bolha só. A faixa de CEP corresponde de perto a
uma região administrativa (Ceilândia, Taguatinga, Asa Sul), que é a unidade em que a
operação comercial realmente pensa.
**Como foi resolvido:** o CEP já existia no cadastro de pessoa do CIGAM e ninguém puxava.
Um robô resolve cada faixa em cascata de fontes (AwesomeAPI → BrasilAPI → ViaCEP para o
bairro, Nominatim para a coordenada) e guarda em cache. Faixa sem coordenada herda a
posição das irmãs do mesmo bairro.
**Limite conhecido:** algumas faixas ficam com posição aproximada e umas poucas não são
reconhecidas por nenhuma base — normalmente CEP errado no cadastro.

## Escrita de estoque no CIGAM: não implementada

**Investigado:** não existe endpoint de balanço nem de inventário na API. O caminho
viável seria o documento genérico (`Pedido/Salvar` → `SalvarItemPedido` → `Efetivar`)
com a natureza de operação correta — 810.10 entrada, 810.20 saída — ou o
`MovimentoProducao`, que exige uma OP já existente (a API não cria OP).
**Decisão:** não implementar por ora. Falta o `CodigoCliente` para documento interno e o
`CodigoCentroArmazenagem` da filial 001, e gravar errado no ERP é caro de desfazer.
**Regra permanente:** nenhuma escrita no CIGAM sem confirmação explícita do dono.

## Deploy: era pelo editor web, agora é por git

**Como era:** sem checkout local, os arquivos eram editados pela interface do GitHub.
Funcionava, mas sem diff decente, sem revisão e sem histórico de intenção.
**Agora:** clone, branch, commit, push. É a principal mudança trazida pela migração para
o Claude Code.

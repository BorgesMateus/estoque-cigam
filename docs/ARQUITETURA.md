# Arquitetura

## Visão geral

```
┌──────────────┐   leitura     ┌─────────────────────┐   service key   ┌──────────────┐
│  CIGAM ERP   │ ────────────► │  scripts/*.mjs      │ ──────────────► │  Supabase    │
│  REST /api   │               │  (GitHub Actions)   │                 │  Postgres    │
└──────────────┘               └─────────────────────┘                 └──────┬───────┘
                                                                              │
                                                              publishable key │ (RLS)
                                                                              ▼
                               ┌─────────────────────┐                 ┌──────────────┐
                               │  wa.mjs (Baileys)   │ ◄─────────────► │ index.html   │
                               │  relatório diário   │                 │ GitHub Pages │
                               └─────────────────────┘                 └──────────────┘
```

Tudo em camada gratuita. Nenhum servidor próprio, nenhum container.

## Camadas

### 1. Ingestão — `scripts/*.mjs`

Node 20 puro, `fetch` nativo, zero dependências (exceto `wa.mjs`, que usa Baileys).
Cada script é um programa completo: autentica no CIGAM, lê, transforma e faz upsert no
Supabase com a service key. Nenhum escreve no ERP.

| Script | Papel |
|---|---|
| `snapshot.mjs` | saldo e disponível de cada material por filial, um registro por dia. Dispara alertas de item abaixo do mínimo (Telegram e/ou e-mail). |
| `vendas.mjs` | pedidos e itens. `DIAS` controla a janela; `DIAS=999` refaz o histórico inteiro. |
| `cadastros.mjs` | clientes (com CEP e bairro), representantes e a base de municípios do IBGE com lat/lon — esta última só na primeira execução. |
| `geocep.mjs` | resolve faixas de CEP (5 primeiros dígitos) para bairro/região e coordenada. Incremental: só ataca faixa que ainda não tem coordenada. |
| `perfil.mjs` | perfil de demanda por item, alimenta o cálculo de mínimo dinâmico. |
| `probe.mjs` | sonda manual da API do CIGAM. Use antes de assumir que um endpoint ou campo existe. |
| `pedido.mjs` | rascunho de criação de pedido. **Não está em produção.** |
| `wa.mjs` | gera o PDF do dia e envia por WhatsApp. `parear` cria a sessão, `enviar` manda. |

### 2. Banco — Supabase

Postgres com PostgREST na frente. Os robôs escrevem com a **service key** (ignora RLS).
O painel lê com a **publishable key** (sujeita ao RLS).

Migrações: arquivos em `supabase/sql/`, aplicados pelo workflow "Rodar SQL (Supabase)"
via Management API. O workflow aceita caminho de arquivo ou SQL inline.

Edge Functions em `supabase/functions/`: `checar-disponibilidade`, `criar-pedido`,
`interpretar-pedido`, `telegram-webhook` — o embrião de um agente de pedidos por
Telegram. Deploy pelo workflow "Deploy Edge Functions".

### 3. Painel — `index.html`

Arquivo único, sem build, sem framework. Carrega o cliente do Supabase e o Leaflet por
CDN. Abas: Estoque, Vendas, Pedidos, Mapa, Cobertura, mais um chat de pedido
experimental (`agente.js`).

Arquivos auxiliares na raiz: `cobertura.js`, `cobertura-admin.js`, `permissoes.js`,
`agente.js`, `wa.html` (página de pareamento do WhatsApp),
`minimos-grupo002.json` (carga inicial de mínimos), `schema.sql` (schema base).

O `index.html` passa de 2000 linhas e concentra layout, estado, consultas e regras.
Quebrar isso é o item 4 do backlog.

## Regras de negócio que moram no painel

### Semáforo de estoque
Compara `saldo` da filial 001 com o mínimo do item. Verde acima, amarelo perto,
vermelho abaixo.

### Mínimo dinâmico
Combina o perfil de demanda dos últimos dias com o lead time de reposição
(`cobertura_lead`) e os carregamentos previstos (`carregamentos`), em vez de um número
fixo digitado uma vez e esquecido.

### Mapa de calor por região
Agrupa o faturamento dos últimos 30 dias (pedidos F) pela faixa de CEP do cliente, que
no DF corresponde de perto a uma região administrativa. Uma faixa sem coordenada
própria herda a posição das faixas irmãs do mesmo bairro; se o bairro inteiro estiver
sem posição, cai para o centro do município e o popup avisa. O seletor permite voltar à
visão por cidade.

## Fluxo de um dia normal

```
07:00  snapshot.mjs   saldos do dia → snapshots, materiais → alerta se abaixo do mínimo
07:20  vendas.mjs     pedidos novos → vendas → perfil.mjs recalcula demanda
09:00  wa.mjs enviar  monta o PDF e manda no WhatsApp (repesca 09:40 e 10:40)
       painel         diretoria e comercial consultam ao longo do dia
```

Domingo, antes disso: `cadastros.mjs` às 07:40 e `geocep.mjs` às 08:10.

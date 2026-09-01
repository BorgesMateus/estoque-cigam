# Migrar para o Claude Code

Guia de uma vez só. Depois de rodar isto, este arquivo não serve mais para nada.

## 1. Tornar o repositório privado

Antes de qualquer coisa, porque hoje o código está aberto.

**Se for assinar o GitHub Pro** (~US$ 4/mês) — caminho mais curto, nada mais muda:

1. Settings → General → Danger Zone → **Change visibility** → Private.
2. Settings → Pages: confirme que continua publicando de `main` / raiz.

**Se preferir não assinar** — publique o painel pelo Cloudflare Pages:

1. Torne o repositório privado (passo 1 acima). O Pages do GitHub para de servir.
2. Em `dash.cloudflare.com` → Workers & Pages → Create → Pages → Connect to Git.
3. Autorize o repositório. Build command: deixe vazio. Output directory: `/`.
4. O painel passa a responder em `<projeto>.pages.dev`. Atualize o link que a equipe usa.
5. Cada push em `main` publica sozinho, igual antes.

Em qualquer um dos dois: **isso protege o código, não os dados**. Quem tiver a URL do
painel continua alcançando o banco com a chave publishable. É o item 1 do backlog.

## 2. Clonar e abrir

```bash
git clone https://github.com/BorgesMateus/estoque-cigam.git
cd estoque-cigam
claude
```

O Claude Code lê o `CLAUDE.md` da raiz automaticamente e já começa sabendo o que é o
projeto, quais são as tabelas, os horários dos robôs e as regras de segurança.

## 3. Configurar o ambiente local

```bash
cp .env.example .env
```

Preencha com os mesmos valores que estão nos GitHub Secrets. **O `.env` não vai para o
git** — está no `.gitignore`.

Para rodar um robô localmente:

```bash
set -a; source .env; set +a
node scripts/snapshot.mjs
```

Cuidado: os robôs escrevem no Supabase **de produção**. Não existe ambiente de staging
hoje. Para experimentar sem risco, comente a chamada de `upsert` ou aponte
`SUPABASE_URL` para um projeto de teste.

## 4. Onde está cada coisa

| Arquivo | Para quê |
|---|---|
| `CLAUDE.md` | contexto permanente — o Claude lê sozinho, toda sessão |
| `docs/ARQUITETURA.md` | como as peças se encaixam |
| `docs/RUNBOOK.md` | o que fazer quando quebra |
| `docs/DECISOES.md` | por que está assim, e quando vale mudar |
| `docs/BACKLOG.md` | o que falta, em ordem de prioridade |

Quando uma decisão for tomada ou uma pegadinha nova aparecer, **atualize o `CLAUDE.md`
no mesmo commit**. Memória desatualizada é pior que memória nenhuma.

## 5. Primeiros comandos que valem a pena

Comece pelos dois de segurança, que são os itens 1 e 2 do backlog:

```
> Leia docs/BACKLOG.md item 1. Escreva a migração de RLS em supabase/sql/rls.sql,
  fechando escrita anônima em todas as tabelas e deixando select só no que o painel usa.
  Me mostre antes de aplicar.
```

```
> Confira se o painel continua funcionando com o RLS novo: liste toda consulta que o
  index.html faz e diga quais quebram.
```

Depois, quando quiser encarar o item 4:

```
> Quebre a aba de mapa do index.html em js/mapa.js usando módulos ES, sem bundler,
  sem mudar comportamento nenhum.
```

E o hábito que mais rende:

```
> /init
```
para o Claude Code revisar e complementar o `CLAUDE.md` com o que ele encontrar no
código que a documentação não cobre.

## 6. O que muda na prática

O projeto foi construído editando arquivos pela interface web do GitHub, sem checkout.
Funcionava, mas sem diff decente, sem branch e sem revisão.

Daqui pra frente: `git checkout -b`, commit com mensagem que explica o efeito, push,
e o Actions roda como sempre. Nada na infraestrutura muda — só o jeito de mexer nela.

Uma disciplina que vale manter: **mudança em robô que roda de manhã entra com o dia
inteiro pela frente**, para dar tempo de observar. O relatório das 09:00 é usado pela
diretoria.

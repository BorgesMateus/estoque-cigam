# Estoque CIGAM Pro — Grupo 002 (Produtos Acabados)

Painel de monitoramento de estoque integrado à API do ERP CIGAM, com banco
compartilhado, histórico diário automático e alertas.

## Arquitetura (tudo em camada gratuita)

```
CIGAM (API) ──leitura── Painel (GitHub Pages) ──lê/grava mínimos── Supabase (Postgres)
     │                                                                  ▲
     └────leitura──── Robô diário (GitHub Actions, 07h) ──grava saldos──┘
                          └── alerta por e-mail/Telegram se algo cruzar o mínimo
```

| Pasta/arquivo | O que é |
|---|---|
| `index.html` | O painel completo (arquivo único) |
| `schema.sql` | Cria as tabelas + carga da demanda de junho/2026 |
| `scripts/snapshot.mjs` | Robô que coleta saldos e dispara alertas |
| `.github/workflows/snapshot.yml` | Agendamento diário do robô (07:00 Brasília) |
| `minimos-grupo002.json` | Mínimos calculados das vendas de junho (importar no painel) |

## Setup (uma vez só, ~20 min)

### 1. GitHub — código e hospedagem
1. Crie um repositório **público** (o GitHub Pages gratuito exige público; o código não contém nenhuma senha). Se fizer questão de repo privado, use o Cloudflare Pages gratuito como hospedagem.
2. Suba todos os arquivos desta pasta para o repositório.
3. Em **Settings → Pages**: Source = "Deploy from a branch", Branch = `main` / `/ (root)`.
4. Em ~2 min o painel estará em `https://SEU-USUARIO.github.io/NOME-DO-REPO/`.

### 2. Supabase — banco compartilhado
1. Crie conta em [supabase.com](https://supabase.com) → **New project** (região *South America (São Paulo)*).
2. Abra o **SQL Editor**, cole o conteúdo de `schema.sql` inteiro e clique **Run**.
3. Em **Authentication → Users → Add user**: crie o usuário da equipe
   (ex.: `estoque@gostinhomineiro.com.br` + senha forte). É esse login que permite **salvar** mínimos.
4. Em **Settings → API**, copie:
   - **Project URL** → vai no `index.html`
   - **anon public** key → vai no `index.html`
   - **service_role** key → vai APENAS nos Secrets do GitHub (**nunca** no index.html)

### 3. Ligar o painel no banco
No `index.html`, preencha no bloco `CONFIG`:
```js
SUPABASE_URL: "https://xxxxx.supabase.co",
SUPABASE_ANON_KEY: "eyJ...",
```
Faça commit. Sem esses valores o painel continua funcionando em modo local (como a v1).

### 4. Secrets do robô (GitHub)
Em **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Valor |
|---|---|
| `CIGAM_USER` | usuário da API do CIGAM (ideal: somente leitura) |
| `CIGAM_PASS` | senha da API |
| `SUPABASE_URL` | a mesma Project URL |
| `SUPABASE_SERVICE_KEY` | a chave **service_role** |
| `RESEND_API_KEY` *(opcional)* | chave de [resend.com](https://resend.com) p/ alerta por e-mail |
| `ALERT_EMAIL_TO` *(opcional)* | e-mails de destino, separados por vírgula |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` *(opcional)* | alerta por Telegram (crie o bot com o @BotFather) |

### 5. Testar
1. Aba **Actions → Snapshot diário do estoque → Run workflow**. Deve ficar verde;
   o log mostra quantos snapshots gravou e se há itens abaixo do mínimo.
2. Abra o painel, faça login no CIGAM, clique **"Equipe: entrar"** (usuário do passo 2.3)
   e importe `minimos-grupo002.json` — os mínimos vão para o banco, valendo para todos.

## Como funciona no dia a dia
- Qualquer pessoa abre a URL do painel e faz login com o próprio usuário da API do CIGAM.
- Mínimos são lidos do banco automaticamente. Para **editar**, entre com o login da equipe.
- O robô grava o saldo item a item todo dia às 07h e só manda alerta quando algo está abaixo do mínimo.
- **Cobertura (dias)** = saldo ÷ venda média diária (referência atual: junho/2026, tabela `demanda_ref`).
- **Produzir hoje** = quanto falta para voltar ao mínimo.

## Segurança
- Nenhuma senha fica no código: o painel pede login CIGAM a cada sessão; a `service_role` vive só nos Secrets.
- A chave `anon` do Supabase é pública por design — o RLS garante que visitantes só leem; escrita exige o login da equipe.
- Recomendado: usuário da API do CIGAM dedicado e somente leitura para o painel e o robô.

## Roadmap sugerido (próximas versões)
- Curva ABC e mínimos dinâmicos recalculados com as vendas recentes do próprio CIGAM
- Demanda de referência atualizada mês a mês (substituindo junho/2026)
- Alerta por WhatsApp (API oficial Meta) e resumo semanal por e-mail
- Página de histórico de alterações de mínimos (a tabela já grava quem alterou e quando)

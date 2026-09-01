# Backlog de profissionalização

Em ordem. Os dois primeiros são de segurança e vêm antes de qualquer funcionalidade nova.

---

## 1. Fechar o banco — RLS permissivo demais 🔴

**O problema.** A chave publishable do painel é pública por natureza: está no
`index.html`, que é servido para qualquer navegador. Hoje, com essa chave, é possível:

- **ler** `clientes` (mais de 10 mil registros com nome, bairro e CEP), `vendas` (quase
  90 mil linhas de pedido com valor), `snapshots`, `demanda_perfil`, `permissoes` e
  outras 15 tabelas;
- **apagar e alterar** linhas em `clientes`, `vendas`, `minimos` e `ignorados`.

Verificado com sondas não destrutivas (`DELETE` com filtro que não casa nenhuma linha
retorna `204`, ou seja, o comando foi aceito — o RLS não bloqueou). Nada foi alterado.

Isso é independente do repositório ser público ou privado: quem tiver a URL do painel
tem a chave.

**A exceção que mostra o caminho certo:** `wa_envios` e `wa_qr` já têm RLS ligado sem
política de leitura — só a service key alcança. É o padrão a replicar.

**O que fazer.**

1. `alter table ... enable row level security` em todas as tabelas de negócio.
2. Política de **select** apenas onde o painel realmente precisa. Nada de política de
   insert, update ou delete para `anon` — escrita do painel (mínimos, ignorados,
   carregamentos) passa a ir por Edge Function autenticada.
3. Trocar as tabelas cruas por **views** com só as colunas que o painel usa. O painel não
   precisa da lista completa de clientes com CEP para desenhar o mapa: precisa do
   agregado por região.
4. Colocar **autenticação** no painel (Supabase Auth) e amarrar as políticas ao usuário,
   aproveitando a tabela `permissoes` que já existe.

**Como validar depois:** repetir as sondas — `select` nas tabelas cruas deve voltar
vazio ou 401, e `delete`/`patch` devem ser recusados.

---

## 2. Tornar o repositório privado 🔴

Hoje qualquer pessoa lê o endereço da instância do CIGAM, o schema do banco, a lógica
comercial e a estrutura dos robôs.

**A pegadinha:** GitHub Pages a partir de repositório privado exige plano pago. Três
caminhos:

| Caminho | Como fica | Custo |
|---|---|---|
| **GitHub Pro** | repo privado, Pages continua igual, nada muda no fluxo | ~US$ 4/mês |
| **Cloudflare Pages ou Netlify** | repo privado no GitHub, painel publicado pelo outro serviço, deploy automático a cada push | grátis |
| **Dois repositórios** | privado com robôs e SQL, público só com o painel | grátis, mas duplica o trabalho |

Recomendado: **Cloudflare Pages**, se não quiser assinatura. O plano gratuito publica de
repositório privado e o domínio pode continuar sendo trocado depois.

Lembre que isso protege o **código**. O conteúdo do painel continua público para quem
tiver a URL — quem resolve isso é o item 1.

---

## 3. Deploy de verdade, por git

Já resolvido pela própria migração: clone local, branch, commit, push. O que falta é
combinar o mínimo de disciplina:

- `main` sempre publicável;
- mudança em robô que roda de manhã entra com o dia inteiro pela frente para observar;
- toda alteração de schema com arquivo em `supabase/sql/`.

---

## 4. Quebrar o `index.html`

Passou de 2000 linhas com layout, estado, consultas e regra de negócio no mesmo arquivo.

Sugestão sem introduzir build:

```
painel/
  index.html          só a estrutura
  css/estilo.css
  js/supabase.js      cliente e helpers de consulta
  js/estoque.js       aba de estoque e semáforo
  js/vendas.js
  js/mapa.js
  js/cobertura.js
  js/util.js          trim, norm, R$, escapeHtml
```

Módulos ES nativos (`<script type="module">`) funcionam direto no GitHub Pages, sem
bundler. Se depois quiser build, Vite entra sem reescrever nada.

Faça uma aba por vez, publicando entre elas. Não tente tudo num commit só.

---

## 5. Testes onde dói

Não precisa de suíte completa. Precisa de teste onde o erro é silencioso:

- **conversão de unidade** (pacote × fator → KG) — foi origem de erro de conferência;
- **agrupamento do mapa** por faixa de CEP, incluindo a herança de coordenada;
- **cálculo do mínimo dinâmico**;
- **paginação** do PostgREST acima de 1000 linhas.

`node --test` já vem no Node 20. Zero dependência nova.

---

## 6. Higiene de repositório

- `.gitignore` cobrindo `.env`, `node_modules/`, `*.log` e a pasta de sessão do WhatsApp;
- `.env.example` com todas as variáveis (incluído nesta entrega);
- `package.json` com `scripts` nomeando cada robô, para não decorar caminho;
- `.github/workflows/ci.yml` rodando `node --check` em todos os `.mjs` a cada push —
  pega erro de sintaxe antes de virar workflow vermelho de madrugada.

---

## 7. Confiabilidade do agendamento

O cron do GitHub já falhou duas vezes em produção. Hoje há repesca e idempotência no
relatório do WhatsApp, o que resolve na prática. Se quiser garantia de verdade:

- `pg_cron` no Supabase chamando a API do GitHub para disparar o workflow — exige um
  token de acesso criado pelo dono;
- ou um alerta simples: se não houve registro em `wa_envios` até as 11:00, avisa no
  Telegram.

O alerta é bem mais barato que a migração e resolve 90% do incômodo.

---

## 8. Itens funcionais em aberto

- **Lançar balanço e entrada de produção no CIGAM.** Investigado, não implementado.
  Falta o `CodigoCliente` de documento interno e o `CodigoCentroArmazenagem` da filial
  001. Ver `docs/DECISOES.md`.
- **Quatro itens da contagem física sem código no catálogo:** Carolina 800g,
  Carolina 2,5kg, Pão Gourmet 400g, Palito Gourmet 400g.
- **Oito de-paras de contagem com casamento incerto**, marcados na planilha de
  conferência — confirmar antes de ajustar estoque com base neles.
- **Agente de pedidos por Telegram** (`supabase/functions/`, `agente.js`): existe, está
  incompleto, e envolve criar pedido no ERP. Decidir se vive ou morre.

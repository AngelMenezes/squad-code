# 🗺️ SQUAD/CODE - Development Network

![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522-339933?logo=nodedotjs&logoColor=white)
![Claude Code](https://img.shields.io/badge/Claude%20Code-CLI-D97757?logo=anthropic&logoColor=white)
![Dependências](https://img.shields.io/badge/depend%C3%AAncias-better--sqlite3-0aa)
![Plataformas](https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-suportado-555)

Interface web para montar e comandar um **squad de agentes de desenvolvimento de software**: um comandante,
dois reconhecedores (ADR e PRD) e operadores especialistas (backend, frontend, QA, DevOps...). O comandante
planeja cada sprint, você aprova o plano e os agentes executam as features de verdade com o
**Claude Code em modo headless** (`claude -p`), conversando entre si num chat da operação, enquanto você acompanha cada um no escritório.

Tudo roda na sua máquina: um app de página única servido por um bridge local em Node.js, que guarda os dados num banco SQLite local.

---

## 📑 Sumário

- [Como funciona](#-como-funciona)
- [Pré-requisitos](#-pré-requisitos)
- [Instalação](#-instalação)
- [Como rodar](#️-como-rodar)
- [Primeiro teste](#-primeiro-teste)
- [Configuração](#️-configuração)
- [Desenvolvimento, build e testes](#️-desenvolvimento-build-e-testes)
- [Estrutura do projeto](#-estrutura-do-projeto)
- [Solução de problemas](#-solução-de-problemas)
- [Segurança e custos](#-segurança-e-custos)
- [Documentação completa](#-documentação-completa)

---

## 🧩 Como funciona

```text
 Navegador (index.html)  ──HTTP + token──▶  server.js (bridge, 127.0.0.1:4317)  ──stdin──▶  claude -p
   estado, mapa 3D, chats                     valida as opções e transmite            um processo por etapa,
   e orquestração                             os eventos em streaming                 dentro de projects/<pasta>/
```

O app tem três modos de uso:

| Modo | Para quê | Precisa de |
|---|---|---|
| **Real** (`npm start`) | Agentes executam as features com o Claude Code | Node.js + Claude Code autenticado |
| **Desenvolvimento** (`npm run dev`) | Editar o código de `src/` com rebuild automático | Node.js (+ Claude Code para execução real) |
| **Demo** (abrir `index.html`) | Conhecer a interface com uma simulação local, sem custo | Só um navegador |

---

## ✅ Pré-requisitos

### Obrigatórios para a execução real

| Ferramenta | Versão | Para quê | Download |
|---|---|---|---|
| **Git** | qualquer versão recente | Clonar o repositório | [git-scm.com/downloads](https://git-scm.com/downloads) |
| **Node.js** | 22 ou superior (recomendado: LTS mais recente) | Rodar o bridge `server.js` e os scripts npm | [nodejs.org/pt-br/download](https://nodejs.org/pt-br/download) |
| **Claude Code** (CLI) | versão atual | Executar os agentes (`claude -p`) | [Guia de instalação oficial](https://code.claude.com/docs/pt/setup) |
| **Conta Claude** | Pro, Max, Team, Enterprise ou Console (API) | Autenticar o Claude Code. O plano gratuito do claude.ai não inclui o Claude Code | [claude.ai](https://claude.ai) · [console.anthropic.com](https://console.anthropic.com) |
| **Navegador moderno** com WebGL | Chrome, Edge ou Firefox atualizados | Abrir a interface (o mapa 3D usa WebGL, com fallback 2D) | [Chrome](https://www.google.com/chrome/) · [Edge](https://www.microsoft.com/edge) · [Firefox](https://www.mozilla.org/firefox/) |

> **Windows:** o [Git for Windows](https://git-scm.com/downloads/win) é recomendado para o Claude Code usar o Bash.
> Sem ele, o Claude Code usa o PowerShell.

Requisitos do Claude Code, segundo a documentação oficial: macOS 13+, Windows 10 1809+ (ou Server 2019+),
Ubuntu 20.04+, Debian 10+ ou Alpine 3.19+; 4 GB de RAM; conexão com a internet.

### Ferramentas da linguagem do projeto que a squad vai criar

O SQUAD/CODE roda com Git, Node.js e Claude Code, qualquer que seja a linguagem do projeto. Para **compilar e rodar** o
código que a squad entregar, a máquina precisa também da ferramenta da linguagem escolhida: .NET SDK, Node.js, Python,
JDK, Go, Flutter, Rust, Docker... O app **não instala** nenhuma delas, mas verifica o que existe:

- **Configurações > Ambiente** lista o que foi encontrado nesta máquina, com a versão, o comando para conferir e o link
  oficial de instalação do que falta. Depois de instalar, clique em **Verificar de novo**.
- A página da operação avisa (**Ambiente incompleto**) quando o briefing, a arquitetura ou os ADRs citam uma ferramenta
  que não está instalada.
- O plano do comandante e cada etapa recebem essa lista: a squad usa as versões que existem na máquina (por exemplo, o
  SDK do `global.json`) e, se faltar algo, escreve o código mesmo assim e diz no relatório o que instalar. O README do
  projeto gerado lista os pré-requisitos com as versões usadas.

### Opcionais (somente para quem vai mexer no código)

| Ferramenta | Para quê | Download |
|---|---|---|
| **Python 3.9+** | `python build.py`: build completo (regenera os avatares e a cópia standalone) | [python.org/downloads](https://www.python.org/downloads/) |
| **Pillow** | Converter `assets/*.png` na galeria de avatares (`pip install pillow`) | [pypi.org/project/pillow](https://pypi.org/project/pillow/) |
| **Playwright para Python** + Chromium | Testes de interface (`tests/ui_test.py`) | [playwright.dev/python](https://playwright.dev/python/docs/intro) |

O projeto tem **uma única dependência npm**, o `better-sqlite3` (banco SQLite local), instalada com `npm install`.

### Recomendado ao vincular repositórios existentes

Se você vai [trabalhar em um projeto que já existe](#trabalhar-em-um-projeto-que-já-existe), ative a **proteção da
branch base** (*branch protection*) em cada repositório vinculado, no servidor onde ele fica hospedado.

O SQUAD/CODE bloqueia o push dos agentes no clone da operação, mas os agentes rodam com as suas credenciais de git, e
um bloqueio local pode ser contornado de propósito. A proteção no servidor é a garantia de que nada chega à branch base
sem pull request.

No GitHub: **Settings → Branches → Add branch ruleset** (ou *Add rule*) para a branch base (por exemplo `main`), com:

- **Require a pull request before merging**, de preferência com pelo menos uma aprovação;
- **Block force pushes**;
- **Restrict deletions**.

Guia oficial: [Sobre branches protegidos](https://docs.github.com/pt/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).
No GitLab e no Bitbucket o recurso se chama, respectivamente, *Protected branches* e *Branch permissions*.

---

## 📦 Instalação

### 1. Clone o repositório

```sh
git clone https://github.com/AngelMenezes/squad-code-network.git
cd squad-code-network
```

### 2. Confira o Node.js e instale as dependências

```sh
node --version   # precisa ser v22 ou superior
npm install      # instala o better-sqlite3 (binário pronto para Windows, macOS e Linux)
```

### 3. Instale o Claude Code

Escolha o comando do seu sistema (instalador nativo, recomendado pela Anthropic):

**Windows (PowerShell)**

```powershell
irm https://claude.ai/install.ps1 | iex
```

**Windows (CMD)**

```bat
curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd
```

**macOS, Linux ou WSL**

```sh
curl -fsSL https://claude.ai/install.sh | bash
```

<details>
<summary>Outras formas de instalar (Homebrew, WinGet, npm)</summary>

```sh
brew install --cask claude-code              # macOS (Homebrew)
winget install Anthropic.ClaudeCode          # Windows (WinGet)
npm install -g @anthropic-ai/claude-code     # npm (requer Node.js 22+; não use sudo)
```

Instalações via Homebrew e WinGet não se atualizam sozinhas (`brew upgrade claude-code` / `winget upgrade Anthropic.ClaudeCode`).
Mais opções em [code.claude.com/docs/pt/setup](https://code.claude.com/docs/pt/setup).

</details>

Depois, **abra um novo terminal** (para o `PATH` ser atualizado) e confira:

```sh
claude --version   # ex.: 2.1.x (Claude Code)
claude doctor      # diagnóstico da instalação (opcional)
```

### 4. Autentique o Claude Code

Rode `claude` uma vez e siga o login no navegador. Depois saia com `/exit`.

```sh
claude
```

Se a variável `ANTHROPIC_API_KEY` estiver definida, o Claude Code pede para aprovar a chave em vez de abrir o navegador.
O SQUAD/CODE usa essa mesma autenticação: ele não guarda nem pede credenciais.

---

## ▶️ Como rodar

### Modo real (com Claude Code)

Na pasta do projeto:

```sh
npm start
```

O terminal mostra:

```text
SQUAD/CODE bridge ativo em http://127.0.0.1:4317
Pasta dos projetos: .../squad-code-network/projects
Banco de dados: .../squad-code-network/data/squad.db
Claude Code 2.1.x (C:...claude.exe)
```

Na primeira vez, sem banco, a linha do banco diz `Banco de dados: nenhum em .../data. Abra http://127.0.0.1:4317 para
criar um.` Se o Claude Code não estiver no PATH, o terminal avisa logo na subida.

Abra **[http://127.0.0.1:4317](http://127.0.0.1:4317)** no navegador. O canto superior direito mostra o status do
Claude Code (por exemplo `CLAUDE CODE / V2.1.x / ACCEPTEDITS`); clique nele para abrir as configurações e use
**Testar conexão** para confirmar que o bridge encontrou o `claude`.

Para parar, use `Ctrl+C` no terminal. Encerrar o bridge também encerra as execuções em andamento.

> ⚠️ Abra sempre o endereço servido pelo bridge. Abrir o arquivo `index.html` direto cai no modo demo.

### Primeira execução: criar o banco

Num clone novo não existe `data/squad.db`, e o bridge não cria nada sozinho. Ao abrir a página aparece a janela
**Nenhum banco encontrado**, que não pode ser fechada: o app só é usado depois de escolher como começar. A janela mostra
onde o banco será criado e se o Claude Code foi encontrado (com **Testar de novo** depois de instalar ou fazer login).

- **Começar do zero:** digite o nome da primeira operação. Cria os agentes e a squad padrão e uma operação vazia, que
  abre em seguida para você preencher o briefing.
- **Carregar exemplo:** a operação Atlas Commerce, completa, para explorar e rodar o demo.
- **Importar backup:** um `.json` exportado em Configurações > Workspace (de outra máquina, por exemplo).
- **Recuperar a cópia deste navegador:** aparece quando este navegador já tem um workspace salvo (por exemplo, depois
  de apagar a pasta `data`). Se você escolher outra opção, essa cópia vira uma versão salva no banco novo.

Nada é gravado em disco antes da escolha. Com outra aba aberta na mesma janela, a primeira a escolher cria o banco e a
outra recarrega com ele.

### Modo desenvolvimento

```sh
npm run dev                  # ou: npm run dev -- --port 5000
```

Gera o `index.html` a partir de `src/` (sem precisar de Python), inicia o bridge e observa os arquivos:
mudanças em `src/` regeneram o HTML e mudanças no `server.js` reiniciam o bridge. Recarregue a página depois de cada mudança.

### Modo demo (sem Claude Code)

Dê um duplo clique em `index.html` (ou arraste-o para o navegador). O status mostra `CLAUDE CODE / NÃO CONECTADO`
e toda a operação (plano do comandante, falas, chamadas entre agentes e entregas) é uma simulação local
determinística. Nada é executado e não há custo.

---

## 🧭 Primeiro teste

Escolhendo **Carregar exemplo** na primeira execução, o workspace vem com a operação **Atlas Commerce** (squad completa, documentação preenchida e features
divididas em sprints). Como toda operação, ela começa pela **F00 Setup do projeto** na Sprint 01 (aqui, já concluída):
as outras features só rodam depois que o setup é aprovado.

1. A interface abre no **Painel geral**. Abra a operação **Atlas Commerce**.
2. Clique em **Executar sprint atual** (ou pressione a barra de espaço). O app vai para a tela **Squad**, no escritório
   isométrico, e o **chat da operação** ocupa o lugar da lista de agentes à esquerda. Ali o comandante monta o plano:
   quem trabalha em cada feature, em que ordem e com qual instrução.
3. Revise o plano e clique em **Executar plano**. Nada roda antes da sua aprovação; **Cancelar** não altera nenhuma feature.
4. Acompanhe pelo chat ou pelo escritório: cada agente diz o que vai fazer, mostra arquivos e comandos em chips e passa o
   bastão ao próximo. O chat ocupa o lado esquerdo inteiro, por cima da barra do topo; arraste a borda dele para mudar a largura (duplo
   clique volta ao padrão). Minimize o chat para ver só o escritório, com o que cada um está fazendo e falando sobre a cabeça.
5. As entregas param em **Revisão humana**. Abra a feature e aprove (ou peça uma nova iteração). Só a aprovação
   conclui a feature e libera as dependentes.

No modo real, cada etapa é um processo `claude -p` que trabalha na pasta `projects/op-001-atlas-commerce/` e é
cobrado na sua conta. Para experimentar sem custo, troque para **Simulação local (demo)** nas configurações
(aba Claude Code, campo Modo).

Atalhos úteis: `G` abre o Squad Studio, `A` cria um agente, `F` abre as features, `C` abre o console do Claude Code.
A lista completa está no [guia](docs/GUIA.md#-controles).

---

## ⚙️ Configuração

### Opções do bridge

| Opção | Padrão | Descrição |
|---|---|---|
| `--port <n>` ou `SQUAD_PORT` | `4317` | Porta do bridge |
| `SQUAD_CLAUDE_BIN` | `claude` | Executável do Claude Code (nome no `PATH` ou caminho completo) |
| `SQUAD_PROJECTS_DIR` | `./projects` | Raiz das pastas de trabalho dos agentes |
| `SQUAD_DATA_DIR` | `./data` | Pasta do banco SQLite (`squad.db`) |
| `SQUAD_REPOS` | `./data/repos.json` | Lista de repositórios existentes que uma operação pode vincular (editável em Configurações > Repositórios) |

Exemplos:

```sh
npm start -- --port 5000                          # qualquer sistema
SQUAD_PORT=5000 npm start                         # macOS / Linux / Git Bash
```

```powershell
$env:SQUAD_CLAUDE_BIN = "C:\caminho\para\claude.exe"; npm start   # Windows PowerShell
```

### Configurações dentro do app

No menu de configurações (botão **Configurações** no topo ou clique no status do Claude Code):

- **Aba Claude Code:** modo (real ou demo), executável, modo de permissão (padrão `acceptEdits`), modelo e esforço
  globais, orçamento máximo por etapa (`--max-budget-usd`), tempo limite (padrão 900 s), execuções simultâneas
  (padrão 2), regras extras de `allowedTools` e `--add-dir`.
- **Aba Ambiente:** as ferramentas de desenvolvimento encontradas nesta máquina (Git, Node.js, Python, .NET SDK, JDK, Go,
  Flutter, Rust e Docker), com versão, comando de verificação e link de instalação do que falta.
- **Aba Repositórios:** cadastra, edita e remove os repositórios existentes que uma operação pode usar (caminho local
  ou URL, subpasta de monorepo, branch base e comando de preparo). Grava em `data/repos.json`, sempre com uma cópia
  `.bak` antes de gravar.
- **Aba settings.json:** lê, valida e grava os `settings.json` reais do Claude Code (usuário, projeto ou local),
  sempre com uma cópia `.bak` antes de gravar.

### Onde os agentes trabalham

Cada operação tem a sua pasta em `projects/<pasta>/` (por exemplo `projects/op-001-atlas-commerce/`), criada na
primeira execução. É nela que os agentes leem e escrevem o código que implementam: toda execução (plano do comandante,
etapas, chamadas entre colegas e chats) roda com essa pasta como diretório de trabalho, e o prompt de cada etapa manda
manter tudo dentro dela. A pasta `projects/` fica fora do git do SQUAD/CODE e não é apagada quando você exclui a
operação no app.

**Projeto novo: commit e envio.** A pasta de um projeto novo é um repositório git próprio. Ao fim de cada etapa
concluída, o bridge faz o commit do que o agente mudou (`SQUAD/CODE: <agente> / <feature>`); chats e o plano do
comandante não geram commit. Para disponibilizar o código, por exemplo uma POC em desenvolvimento ou homologação, informe
um **repositório remoto** vazio na criação da operação ou no briefing (sem usuário ou token na URL: o git usa o seu
gerenciador de credenciais). A página da operação mostra **Enviar para o remoto**, que faz o `git push` da branch atual (`main` nas pastas criadas pelo app)
da pasta; o deploy fica com o CI/CD desse repositório. Os agentes nunca enviam: depois do primeiro envio, o `origin`
fica sem URL de envio para eles e o hook `pre-push` recusa qualquer push que não venha do botão.

Cada pasta de projeto é um repositório git próprio (o bridge roda `git init` antes da primeira execução, se o Git estiver
instalado), e o git dos agentes não passa da pasta `projects/`. Assim o `git status`, os commits e o
`.claude/settings.json` que o Claude Code usa são os do projeto, nunca os do repositório do SQUAD/CODE.

Com o modo de permissão padrão (`acceptEdits`), edições de arquivo fora da pasta do projeto precisam de aprovação, e
no modo headless ninguém aprova, então são recusadas. Duas configurações abrem exceções: **Diretórios adicionais**
(`--add-dir`) e o modo `bypassPermissions`. As ferramentas de arquivo também não **leem** fora da pasta do projeto
(`permissions.blockReadsOutsideWorkingDirectories`), então os agentes não confundem o projeto com o código do SQUAD/CODE
nem com outras pastas suas. Comandos de terminal (`Bash`), quando liberados para um agente, não são isolados pelo Claude
Code no Windows; nesse caso vale a instrução do prompt.

### Trabalhar em um projeto que já existe

Uma operação pode partir de um repositório existente em vez de uma pasta vazia. Cadastre os repositórios em
**Configurações > Repositórios** ou direto em `data/repos.json` (as mudanças valem sem reiniciar o bridge):

```json
{
  "repos": [
    { "id": "faturamento", "name": "Faturamento", "path": "C:/code/faturamento", "baseBranch": "main", "prepare": "npm ci" },
    { "id": "portal", "name": "Portal", "url": "https://github.com/empresa/portal.git", "baseBranch": "develop" },
    { "id": "api", "name": "API do monorepo", "path": "C:/code/plataforma", "subdir": "apps/api", "baseBranch": "main" }
  ]
}
```

**Monorepo.** Um repositório com vários projetos pode ser usado por pasta: informe a `subdir`, ou cadastre pela tela
o caminho da própria pasta (o app grava a raiz do repositório e a subpasta). O clone é do repositório inteiro, mas os
agentes trabalham só na subpasta, o `docs/squad/` fica dentro dela, o mapa considera só as mudanças dela e o commit de
cada etapa inclui só os arquivos dela.

Escolha o repositório ao criar a operação (**Nova operação > Repositório existente**) ou depois, no briefing, em
**REPOSITÓRIO EXISTENTE**, e escolha também o **reconhecimento**:

- **Com reconhecimento:** a F00 mapeia o código em `docs/squad/` antes das features (detalhes abaixo).
- **Direto ao trabalho:** sem F00, para um fix ou um ajuste pontual. A execução precisa só de nome, briefing e squad, e
  cada etapa lê apenas o que a tarefa pede (README, manifestos e os arquivos citados), sem varrer o repositório. O aviso
  **Sem reconhecimento** na página da operação oferece **Fazer reconhecimento** a qualquer momento: a F00 volta, e as
  features ainda não iniciadas passam a esperar o mapa.

Então:

- Na primeira execução a pasta da operação vira um **clone** do repositório (`git clone`). Os agentes nunca mexem na
  sua cópia de trabalho, e `git push` fica bloqueado: os envios ficam com você.
- Cada feature trabalha no seu próprio **worktree**, `projects/<pasta>/.wt/<feature>`, na branch `squad/<feature>`
  (por exemplo `squad/f03-a1b2c3`). Ele é criado na primeira etapa a partir da branch base atualizada (`git fetch`), e as
  etapas seguintes da rota usam o mesmo. Features diferentes não se misturam, e o plano do comandante e os chats ficam no
  clone. Se o repositório tiver `prepare` (por exemplo `npm ci`), o bridge roda esse comando uma vez em cada worktree
  novo, antes da primeira etapa.
- O clone, o `git fetch`, o worktree e o `prepare` são a fase de **preparo** da etapa: o chat mostra o passo em andamento
  ("está preparando o worktree"), o console mostra a saída do comando ao vivo e **Encerrar** interrompe o preparo. Se o
  `prepare` falhar, a etapa termina com o erro e o agente não começa; a próxima execução tenta preparar de novo.
- **O bridge faz o commit de cada etapa.** Ao fim de cada etapa concluída, o bridge faz o commit do que o agente mudou
  na branch da feature, com a mensagem `SQUAD/CODE: <agente> / <feature>`. Os agentes não precisam de git nem de
  shell. Os hooks do repositório rodam normalmente: se um deles recusar o commit, o chat da operação avisa e as
  mudanças ficam no worktree para a próxima etapa.
- Ao **aprovar** a entrega, o worktree é removido e a branch `squad/<feature>` continua no clone. Se houver mudanças sem
  commit, o worktree fica e o app avisa.
- **A feature aprovada fica "aguardando merge".** As features que dependem dela só rodam depois que a branch chegar à
  branch base, porque elas partem da base. O aviso **Aguardando merge** na página da operação lista essas branches:
  - **Enviar branch:** o bridge faz o `git push` da branch para a origem do repositório, só quando você clica. Com origem
    no GitHub, o aviso mostra o link para abrir o PR.
  - **Verificar merges:** faz `git fetch` e confere cada branch. Conta como mergeada a branch que entrou no histórico da
    base (merge ou fast-forward) e também a que entrou por squash: algum commit da base deixou todos os arquivos que ela
    mudou exatamente como na branch, mesmo que a base tenha mudado esses arquivos depois. Uma branch sem commits aparece
    como "sem commits". Ao voltar para a aba do app, a verificação roda sozinha (no máximo a cada 2 minutos).
  - **Marcar como mergeada:** confirmação manual, para quando a verificação não consegue reconhecer o merge.
- O comandante planeja com o mapa: ele recebe `docs/squad/mapa.md` e a lista de mudanças desde o mapa, e indica por quais
  arquivos cada colega começa ("Comece lendo: …" na instrução de cada um). Antes de você aprovar o plano, o bridge
  confere cada caminho na branch base; os que não existem saem das instruções e são listados no chat da operação.
- **Os agentes não enviam nada.** No clone, o `origin` fica sem URL de envio e um hook `pre-push` recusa qualquer push
  que não venha do botão **Enviar branch**. Isso barra também formas indiretas (`git -C . push`, outro remote), mas
  quem reescrever a configuração do git ou usar `--no-verify` de propósito passa. A proteção de verdade fica no
  servidor: ative a **proteção da branch base** no GitHub (exigir pull request) nos repositórios que vincular.
  Repositórios com `core.hooksPath` próprio (como o husky) ignoram esse hook, e aí vale só o bloqueio do `origin`.
- Com reconhecimento, a F00 deixa de ser o setup e vira **Reconhecimento do projeto**. Ela mapeia o código em `docs/squad/` (mapa,
  arquitetura, convenções e comandos) e preenche os campos ainda vazios da documentação do projeto (visão, escopo,
  glossário, arquitetura e ADRs). Nas features de mapa (a F00 e as atualizações do mapa), os agentes só podem escrever
  em `docs/squad/`, mesmo os que não têm a ferramenta Write no perfil, e o bridge grava o commit de referência em
  `docs/squad/.reconhecimento`.
- **Padrão de código da operação** (no briefing), uma escolha sua por operação:
  - **Seguir o padrão do repositório:** as convenções aprovadas pelo time (`docs/squad/convencoes.md` na branch base,
    ou seja, depois do merge da F00) prevalecem sobre as diretrizes dos agentes. Das diretrizes, vale só o que não
    conflita com elas.
  - **Aplicar as diretrizes da squad, migrando aos poucos:** as diretrizes dos agentes prevalecem, e as convenções
    atuais vão só como contexto, para o agente saber o que está migrando sem reescrever o que a tarefa não pede.

  O rascunho do `convencoes.md` que ainda não foi mergeado nunca conta: o que um agente escreve só vale depois que o
  time revisa no pull request.
- Até a documentação ficar completa, a execução roda só a F00, que precisa apenas de nome, briefing e squad. Depois
  disso, as features seguintes leem `docs/squad/` em vez de varrer o código a cada execução.

**Mapa em dia sem varrer o código.** O `docs/squad/.reconhecimento` guarda o commit da branch base que o mapa descreve. O
bridge compara esse commit com a branch base usando o git, sem gastar tokens:

- **Em dia:** nada mudou fora de `docs/squad`, e as etapas usam o mapa como está.
- **Com mudanças:** poucos arquivos mudaram. Cada etapa recebe no prompt a lista desses arquivos e lê só os que
  importam para a tarefa.
- **Desatualizado:** houve mudanças estruturais (manifestos como `package.json`, migrations, CI, pastas novas no topo)
  ou mais de 30 arquivos. A página da operação avisa e oferece **Atualizar mapa**, que cria uma feature para o arquiteto
  reescrever só as seções afetadas, a partir da lista, e gravar o novo commit de referência.

**Verificar**, no aviso, atualiza a branch base (`git fetch`) e compara de novo. Se o commit registrado sumiu do
histórico, o bridge usa a data gravada no mapa para achar o commit equivalente.

**Exportar sem sobrescrever o que o time já tem.** Num repositório vinculado, o botão **Exportar** da operação grava só
nos lugares da squad, e todas as referências entre os arquivos acompanham a mudança:

| Exportação comum | Repositório vinculado |
|---|---|
| `CLAUDE.md` | `docs/squad/CLAUDE.squad.md` |
| `docs/project`, `docs/architecture`, `docs/standards`, `docs/features` | as mesmas pastas dentro de `docs/squad/` |
| `.claude/agents/<agente>.md` | `.claude/agents/squad-<agente>.md` |
| `.claude/commands/<comando>.md` (`/executar-feature`…) | `.claude/commands/squad-<comando>.md` (`/squad-executar-feature`…) |
| `.claude/settings.json` | `docs/squad/settings.squad.json` (sugestão: copie para o `.claude/settings.json` só as regras aprovadas) |

Há duas formas de exportar:
- **Gravar numa branch:** o bridge cria uma branch `squad/exportacao-<data>` no clone, com um commit, para o time
  revisar o diff no pull request. Os arquivos do mapa (`mapa.md`, `arquitetura.md`, `convencoes.md`, `comandos.md`,
  `.reconhecimento`) nunca são tocados. Se nada mudou desde a última exportação mergeada, nenhuma branch é criada.
  A branch vai para a origem com **Enviar branch**, como as das features.
- **Baixar .zip:** os mesmos arquivos, para extrair na raiz do repositório.

Para o Claude Code carregar a squad, o `CLAUDE.md` do repositório precisa da linha `@docs/squad/CLAUDE.squad.md`. Na
exportação por branch, ela é criada automaticamente quando o repositório não tem `CLAUDE.md`; quando já tem, o arquivo
do time não é alterado e o app avisa para você incluir a linha.

O vínculo e o modo de reconhecimento só podem ser escolhidos enquanto a operação ainda não tem nenhuma entrega. As
execuções e o briefing recebem só o `id`, o nome e a subpasta do repositório; o caminho e a URL aparecem apenas em
Configurações > Repositórios, com a URL mascarada quando tem credenciais (o app recusa gravar URLs assim).

### Dados do workspace

Com o bridge, tudo fica num banco SQLite local, `data/squad.db` ao lado do `server.js` (fora do git), criado na
primeira execução (veja acima). Para usar outra pasta, defina `SQUAD_DATA_DIR`. O banco guarda:

- **Workspace:** agentes, squads, operações, sprints, features, entregas, logs e handoffs, uma tabela por entidade.
  Dá para consultar com qualquer cliente SQLite (`select name, role from agents`, `select title, status from features`).
- **Sala da operação:** as mensagens de cada operação (as 800 mais recentes).
- **Conversas:** co-escrita da feature, chat com agente e Agent Teams.
- **Histórico de execuções:** cada `claude -p` com seus eventos. Fica no Console > **Histórico**, inclusive depois de
  reiniciar o bridge.

O banco é a fonte principal: limpar os dados do navegador, trocar de navegador ou abrir por `localhost:4317` em vez
de `127.0.0.1:4317` não perde nada. O navegador guarda só uma cópia de trabalho do workspace.

**Versões salvas** (Configurações > Workspace): o banco guarda uma versão do workspace antes da primeira alteração de
cada início do bridge, antes de importar ou restaurar e quando outra aba salva por cima (as 30 mais recentes), e
qualquer uma pode ser restaurada. Se o bridge cair, as alterações ficam no navegador (o rodapé mostra
`SALVO SÓ NO NAVEGADOR`) e vão para o banco ao recarregar a página com o bridge ativo.

Quem usava a versão anterior (arquivo `data/workspace.json`): na primeira subida o bridge importa o arquivo e as cópias
de `data/backups/` para o banco e move os arquivos para `data/legacy-json/`.

Aberto como arquivo (`index.html`, modo demo), o workspace fica só no navegador. Use **Exportar workspace** nas
configurações para fazer backup em JSON e **Importar workspace** para restaurar.

---

## 🛠️ Desenvolvimento, build e testes

> `index.html` é gerado pelo build: edite os arquivos em `src/` e rode `npm run dev` ou `python build.py`.

| Comando | O que faz |
|---|---|
| `npm run dev` | Build do `index.html`, bridge e rebuild automático |
| `npm start` | Só o bridge (`node server.js`) |
| `python build.py` | Build completo: regenera `src/avatars.js` (precisa de Pillow) e `index.html`. No macOS/Linux use `python3` |
| `python build.py --copy` | O mesmo, e também grava uma cópia em `../squad-code-network.html` (fora da pasta do projeto) |
| `npm test` | Testes do bridge (`node --test`), com um Claude falso: sem custo de API |
| `node --test --test-name-pattern "<nome>" tests/bridge.test.mjs` | Roda um único teste do bridge |
| `node --check src/app.js` | Verificação rápida de sintaxe depois de editar |
| `node scripts/vendor-three.mjs [versão]` | Regenera `src/vendor/three.min.js` (baixa three + esbuild numa pasta temporária) |

Testes de interface (opcionais):

```sh
python -m pip install playwright
python -m playwright install chromium
python tests/ui_test.py
```

`CHROMIUM_EXECUTABLE` indica outro Chromium e `SQUAD_PREVIEW_DIR` muda a pasta das capturas (padrão `previews/`).

---

## 📁 Estrutura do projeto

```text
squad-code-network/
├── index.html          # app completo, gerado pelo build (não editar)
├── server.js           # bridge local: serve o app e executa claude -p
├── db.js               # banco SQLite (workspace, versões, sala, conversas, execuções)
├── package.json        # scripts npm e a dependência better-sqlite3
├── build.py            # build completo (avatares + index.html)
├── src/                # código-fonte da interface
│   ├── shell.html      # estrutura base
│   ├── styles.css      # estilos
│   ├── app.js          # estado, UI e orquestração
│   ├── city.js         # mapa 3D (cidade hexagonal e escritório)
│   ├── conventions.js  # catálogo de diretrizes dos agentes
│   ├── souls.js        # personalidades dos agentes
│   ├── portraits.js    # retratos embutidos
│   ├── avatars.js      # galeria gerada de assets/*.png
│   └── vendor/         # three.min.js embutido
├── scripts/            # dev runner, geração de avatares e vendor do Three.js
├── assets/             # imagens fonte dos avatares
├── tests/              # testes do bridge (Claude falso) e de interface
├── docs/GUIA.md        # guia completo das funcionalidades
└── projects/           # pastas de trabalho dos agentes (criada ao iniciar, fora do git)
```

---

## 🩺 Solução de problemas

| Sintoma | Causa provável e solução |
|---|---|
| Status `CLAUDE CODE / NÃO CONECTADO` | A página foi aberta como arquivo (`file://`) ou o bridge não está rodando. Rode `npm start` e abra `http://127.0.0.1:4317`. |
| `Executável "claude" não encontrado no PATH.` | O Claude Code não está instalado ou o terminal é anterior à instalação. Abra um novo terminal e confira `claude --version`, ou aponte o caminho completo em `SQUAD_CLAUDE_BIN` ou no campo Executável das configurações. |
| `Token do bridge inválido. Recarregue a página servida pelo bridge.` | O bridge reiniciou e gerou um novo token. Recarregue a página (F5). |
| `a porta 4317 já está em uso` | Outro SQUAD/CODE (ou outro programa) já usa a porta. Feche-o ou use `npm start -- --port 4318`. O segundo bridge sai sem tocar no banco. |
| Janela **Nenhum banco encontrado** | Primeira execução nesta pasta (ou `data/squad.db` foi apagado ou movido). Escolha como começar; para voltar a um banco que está em outra pasta, defina `SQUAD_DATA_DIR` e reinicie. |
| `index.html não encontrado` | A interface não foi gerada. Rode `npm run dev` (ou `python build.py`) na pasta do projeto. |
| Execução bloqueada ao clicar em executar | A operação tem campos vazios. Preencha o que o aviso **Execução bloqueada** lista (briefing, visão, escopo, glossário, arquitetura, ADRs...). |
| Permissões negadas no console | Em modo headless ninguém aprova pedidos de permissão. Ajuste o modo de permissão ou as regras de `allowedTools` nas configurações. |
| Erro de autenticação nas etapas | Rode `claude` no terminal e faça login de novo. Confira se o plano inclui o Claude Code. |
| Mapa 3D não aparece ou fica lento | O navegador está sem WebGL. Ative a aceleração por hardware; sem WebGL o app usa a projeção 2D. |
| Agentes, squads ou operações sumiram | Abra pelo bridge (`npm start`): os dados ficam em `data/squad.db`. Se o rodapé mostrar `SALVO SÓ NO NAVEGADOR`, recarregue a página com o bridge ativo. Versões anteriores ficam em Configurações > Workspace > **Versões salvas**. Pelo `index.html` (demo) os dados ficam só no navegador. |
| `npm warn allow-scripts better-sqlite3 ... (install: node-gyp rebuild)` no `npm install` | Pode ignorar: o `better-sqlite3` já traz binários prontos para Windows, macOS e Linux, e o script de compilação bloqueado não é necessário. Não precisa aprovar. |
| `Dependência ausente (better-sqlite3)` ao iniciar | Rode `npm install` na pasta do projeto. Se o erro for ao carregar o módulo (por exemplo, depois de trocar a versão do Node ou copiar a pasta de outra máquina), apague `node_modules` e rode `npm install` de novo. |

---

## 🔒 Segurança e custos

- O bridge escuta **apenas em `127.0.0.1`**. Toda chamada `/api` exige um token aleatório gerado a cada início, e os
  cabeçalhos `Host`/`Origin` precisam ser locais.
- As opções enviadas ao Claude Code são validadas por whitelist e o prompt vai por stdin, sem interpolação em shell.
- O modo de permissão `bypassPermissions` desliga todas as verificações do Claude Code: use só em ambientes isolados.
- Em repositórios vinculados, os agentes não conseguem enviar branches pelo clone, mas ative também a
  [proteção da branch base](#recomendado-ao-vincular-repositórios-existentes) no servidor: é ela que garante que nada
  chega à `main` sem pull request.
- **Execuções reais são cobradas na sua conta Claude.** Use o orçamento máximo por etapa, o tempo limite e o modo demo
  para controlar o gasto. O console (tecla `C`) mostra o custo de cada etapa.

---

## 📚 Documentação completa

O [**Guia completo**](docs/GUIA.md) detalha todas as funcionalidades:

- [Como a execução funciona](docs/GUIA.md#-como-a-execução-funciona): comandante, chat da operação, bastão e chamadas entre agentes
- [Configurações do Claude Code](docs/GUIA.md#️-configurações-do-claude-code)
- [Estúdio de agentes](docs/GUIA.md#-estúdio-de-agentes), [Diretrizes](docs/GUIA.md#-diretrizes-do-agente-convenções-e-boas-práticas) e [Squad Studio](docs/GUIA.md#-squads-e-squad-studio)
- [Projetos, features, documentação e exportação para o Claude Code](docs/GUIA.md#-projetos-e-features)
- [Mapa da squad: cidade hexagonal e escritório](docs/GUIA.md#️-tela-squad-cidade-hexagonal)
- [Controles e atalhos](docs/GUIA.md#-controles)

Links úteis do Claude Code: [instalação](https://code.claude.com/docs/pt/setup) ·
[início rápido](https://code.claude.com/docs/pt/quickstart) ·
[solução de problemas da instalação](https://code.claude.com/docs/en/troubleshoot-install)

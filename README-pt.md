<div align="center">

# yammory_system

**O seu assistente deixa de perguntar o que já devia saber.**

Ele lembra-se de você entre sessões — em que ponto está em cada matéria, como prefere que falem com você, o que já ficou decidido — e nenhuma escrita chega ao disco sem a sua aprovação, então nada sobre você é guardado pelas suas costas.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/dsh--plugin-✅-green)](https://github.com/topics/dsh-plugin)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen.svg)](#compatibility)
[![CI](https://img.shields.io/github/actions/workflow/status/KhalilYamber/yammory-system/ci.yml?branch=main&label=CI)](https://github.com/KhalilYamber/yammory-system/actions)
[![Version](https://img.shields.io/github/v/tag/KhalilYamber/yammory-system?label=version)](https://github.com/KhalilYamber/yammory-system/releases)

[English](README.md) · [简体中文](README-zh.md) · [Español](README-es.md) · [Português](README-pt.md) · [हिन्दी](README-hi.md)

<sub>Distribuição: apenas o canal do GitHub — não há pacote npm nem listagem em marketplace.</sub>

</div>

---

## Why this exists

Um assistente competente continua sendo um assistente com amnésia. Em cada sessão ele começa do zero: não sabe que você já entende autovetores mas nunca tocou numa rede tensorial, que prefere ser corrigido a ser incentivado, nem que há três semanas você decidiu não seguir aquele caminho. Então você se apresenta de novo, outra e outra vez, e a conversa que poderia ter começado na parte interessante começa no zero.

O `yammory_system` dá ao DeepSeek Harness um lugar para guardar esse conhecimento, e uma forma de usá-lo sem adivinhar. Três coisas o separam de um armazém de memória:

- **Decide como falar antes de buscar.** Um perfil de sete facetas carrega um nível de conhecimento por domínio, então o assistente sabe que vocabulário você aguenta antes de responder: a injeção acontece na montagem do prompt, não depois de um passo de recuperação.
- **Sem você, nada é escrito.** Todo caminho de escrita passa pela própria porta de aprovação do DSH dentro do serviço. Uma escrita negada também deixa evidência; uma escrita silenciosa não é um estado que este plugin consiga alcançar.
- **O trabalho dele você pode conferir.** Tudo o que o modelo viu fica registrado, o armazém é um arquivo SQLite comum que você pode navegar, exportar e auditar, e toda uma categoria de erros é evitada por desenho, não por disciplina.

## Install

```sh
# 1. install the bundle into your profile
dsh plugin --profile web add "github:KhalilYamber/yammory-system#main"

# 2. restart and verify the row
dsh --profile web --dump-config | grep -A3 'id: yammory_system'
```

Outros canais e desinstalação:

- **canal git** (último `main`): `dsh plugin --profile web add git+https://github.com/KhalilYamber/yammory-system.git`.
- **canal tarball**: `npm pack` neste repo, depois `dsh plugin --profile web add ./yammory_system-<version>.tgz`.
- **desinstalar**: `dsh plugin --profile web remove yammory_system` (o banco de memória e os logs de sessão são mantidos).

## The first minute

Depois de reiniciar você deve ver, sem configurar nada:

| Onde | O quê |
|---|---|
| Pé da barra lateral | Uma entrada de **memória** ao lado de Configurações (ela abre e fecha o painel; dá para ocultar com `panel.enabled`) |
| Cabeçalho da conversa | Um interruptor de memória por sessão — desligado, ele para a injeção, a recordação, as escritas e a observação daquela sessão |
| Pé da barra lateral → essa entrada | O painel: entradas por trilha e camada, busca, uso das linhas de aviso, auditoria recente, os três números observáveis e um botão **Arrumar a biblioteca inteira** que só enfileira uma marca |
| Configurações do DSH → `yammory-system` | Todos os campos de configuração, cada um com um ponto de interrogação que o explica em palavras simples |
| `/memory` | `list`, `query`, `stats`, `audit`, `session on|off`, `export` / `import <path>` e mais |

## Table of contents

- [Why this exists](#why-this-exists)
- [Install](#install)
- [The first minute](#the-first-minute)
- [How it works](#how-it-works)
- [Capabilities](#capabilities)
- [Compatibility](#compatibility)
- [Configuration](#configuration)
- [Tools & surfaces](#tools--surfaces)
- [MCP server](#mcp-server)
- [Permissions & data](#permissions--data)
- [Security boundaries](#security-boundaries)
- [Known limitations](#known-limitations)
- [How it's different](#how-its-different)
- [dsh-memory-protocol v1](#dsh-memory-protocol-v1)
- [What we learned from the terminal memories](#what-we-learned-from-the-terminal-memories)
- [Development](#development)
- [Topics](#topics)
- [Contributors](#contributors)
- [Upstream](#upstream)

## How it works

O `yammory_system` é uma costura de capacidade, não outro armazém: um serviço tipado `ctx.memory`, um provedor SQLite local (`node:sqlite`, WAL, `0600`, em `$DSH_HOME/dsh-memento/memory.db`) e seus consumidores — a ferramenta `memory` e um snapshot congelado injetado no prompt do sistema.

Duas trilhas × duas camadas × chave por agente: uma trilha `user` (fatos sobre o usuário) e uma trilha `agent` (fatos de ambiente e convenções), cada uma dividida em camadas `user-global` e `workspace`, isoladas por `agentPreset`. O snapshot é congelado uma vez por sessão na primeira montagem do prompt e nunca muda no meio da sessão. O bloco de pré-aquecimento carrega as restrições de expressão e o perfil permanente, e termina com um diretório de uma linha (`N more workspace / agent-track entries stay out of this block`) para o modelo saber que há algo a buscar com `memory_recall`: apenas a contagem, o conteúdo continua sob demanda.

## Capabilities

- **A porta não pode ser contornada.** Todo caminho de escrita (`add` / `replace` / `remove` / `seed`) passa pela cascata de aprovação dentro do serviço, não na camada de ferramentas. `writePolicy: ask | auto | off` é configuração invisível para o modelo; `replace` / `remove` / `consolidate` carregam o texto completo das entradas que alteram no payload de aprovação, e uma escrita negada ainda gera uma linha de auditoria `*-denied`.
- **Visível para o modelo ⟺ registrado.** O snapshot injetado chega textualmente a `system/message`; toda escrita é reconstruível a partir de `approval/asked` + `approval/decided` + a própria tabela de auditoria do plugin.
- **Limitado e honesto.** Linhas de aviso suaves por trilha e por camada (padrão usuário 2000 / agente 4000). Ultrapassar uma nunca bloqueia uma escrita — apenas sinaliza que aquela camada merece consolidação. Nunca trunca, nunca compacta automaticamente.
- **Interruptor por sessão.** Cada sessão tem o seu próprio interruptor de memória (tabela SQLite do próprio plugin, esquema v6; ligado por padrão). Desligado para quatro coisas de uma vez: a injeção (o bloco de aquecimento congelado é descartado na hora), a recordação (`SESSION_MEMORY_OFF`), a escrita (recusada na mesma camada da porta de aprovação) e a observação (a sessão não é varrida nem escolhida como histórico). As leituras de gestão (`/memory list` / `budgets` / `audit` / `export`) continuam disponíveis. Alterne com `/memory session on|off` ou com o interruptor do compositor; o estado do interruptor nunca entra no registro da sessão e as suas linhas de auditoria levam `text: null`.
- **Arrumar e medir.** Uma passagem de arrumação conduzida pelo modelo funde as entradas que dizem o mesmo numa só com a etiqueta `merged` e rebaixa as antigas para `superseded`: continuam no disco, fora da vista de qualquer sessão, nunca são apagadas. Nunca cruza baldes (`track × scope × agentKey`, mais `workspaceKey` na camada workspace) nem arranca sozinha. Se uma fusão pode ser escrita sem passar por uma pessoa decidem cinco portões mecânicos (mesmo bucket / número de membros / identidade literal depois de removidas pontuação, espaços e símbolos / similaridade / cobertura), nunca a confiança que o modelo se atribui: só o grau cujos membros são idênticos após remover pontuação, espaços e símbolos é julgado `auto` e pode aterrissar sem ninguém por perto, enquanto uma paráfrase completa fica abaixo até da linha de `review` e simplesmente é julgada `skip`, e uma mudança de um só caractere cai em `review` e mantém a via interativa. Por isso uma rodada em segundo plano (uma sessão `dsh` sem interface acordada pelo seu próprio agendador) pode fundir sozinha as duplicatas mecanicamente inequívocas, e deixa o resto esperando por você. A escrita fixa sua própria fonte de auditoria (`tidy-auto`), então uma política de escrita granular (`source:tidy-auto`) pode liberar exatamente essa via e manter as demais atrás do portão de aprovação. À parte, uma verificação só de leitura em `agent/turn-stopping` apenas avisa que o atraso passou a linha (uma linha de auditoria `tidy-due` e uma linha no fim do bloco de aquecimento seguinte). `/memory stats` informa os três números observáveis (taxa de repetição, taxa de acerto da recordação, volume injetado), e o painel mostra essas mesmas três linhas; a taxa de sucesso fica em branco de propósito, porque este repositório não tem fonte de sinal para «o bloco injetado chegou a ser entendido?». O botão **Arrumar a biblioteca inteira** do painel é uma fila, não uma ação: grava uma única linha de marca (`tidy_requests`, schema v7) sob a mesma política de aprovação, o aquecimento da sessão seguinte pede ao modelo uma passagem completa, e a marca vira `done` quando uma escrita de arrumação chega: nada é fundido pelo painel.

- **Governar a memória: desfazer um rebaixamento e arbitrar um conflito por faceta.** `restore` percorre o rebaixamento ao contrário (`superseded → active`, `version` intacta, de volta à vista de qualquer sessão) e é a única saída do estado rebaixado. `arbitrate` resolve o caso de um facto com duas fontes: decide sobre **uma só faceta** e a direção vem de uma tabela fixa — a capacidade segue a observação, a preferência segue o autorrelato, e as outras cinco facetas mantêm **ambas** as entradas e etiquetam cada uma com `gap` (a lacuna é a evidência). A tabela é a direção, portanto não há argumento inverso a passar, e dentro de um grupo mantém-se a entrada atualizada mais recentemente. Ambas passam pela mesma porta de aprovação, o mesmo interruptor por sessão e as mesmas regras de balde que qualquer outra escrita, e ambas deixam rasto de auditoria: `restore` por entrada, `arbitrate` por rebaixamento (`text: null`, só ids), `arbitrate-tag` por etiqueta e um resumo final `arbitrate` que diz quem ficou, quem foi rebaixado e por quê.

## Compatibility

| Surface | Status |
|---|---|
| Harness | DeepSeek Harness `dsh-v0.1.5-rc.2` (adaptado em 2026-09-09): o envelope de sessão mantém seu campo ignorable apenas para compatibilidade de leitura de logs armazenados - o Session.append ainda não consegue estampá-lo, então o comportamento da porta não muda. Verificado em 2026-09-11 contra o checkout master dsh-v0.1.5-rc.2 (cadeia completa de portas + smoke de instalação de perfil). |
| Node | `^22.19.0 || >=24.0.0` |
| Platforms | Windows / macOS / Linux (somente host; sem código nativo, sem rede) |
| Model | Qualquer |

## Configuration

Todos os parâmetros são campos Schemastery `Config` (alteráveis pelo cordis.yml). Valores inválidos falham ruidosamente ao carregar. Sobrescreva na linha `yammory_system`.

**Painel de configurações.** Com o serviço de configurações do DSH montado, todos os campos abaixo (exceto `enabled`) são editáveis na **entrada `yammory-system` na barra lateral de configurações do DSH** (uma seção de primeiro nível, como General ou Plugins); as alterações vão para a camada de usuário das configurações (`settings.yaml`) sem editar arquivos. Quase tudo se aplica ao vivo (políticas de escrita, idioma, orçamentos, limites, propostas, painel; `dbPath` / `auditRetentionDays` reabrindo o armazém; `retrieval.vector` trocando o recuperador) — só `snapshotOrder` exige recarregar o DSH. Sem o serviço de configurações, tudo volta à configuração composta, exatamente como antes. A entrada de memória no pé da barra lateral pode ser ocultada na mesma página (`panel.enabled`).

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Interruptor mestre; `false` remove serviço, ferramentas, snapshot, comando, painel e answerer (não editável na página de configurações: um plugin desabilitado não tem entrada de configurações) |
| `panel.enabled` | `true` | Mostrar a entrada de memória no pé da barra lateral; ao salvar `false` na página de configurações, ela é ocultada imediatamente, sem recarregar (a página de configurações não é afetada) |
| `dbPath` | `''` → `$DSH_HOME/dsh-memento/memory.db` | Absoluto, ou relativo a `$DSH_HOME` (no Windows cai para `~/.dsh`) |
| `budgets.user.userGlobal` | `2000` | Linha de aviso suave da camada user-global da trilha user |
| `budgets.user.workspace` | `2000` | Linha de aviso suave da camada workspace da trilha user |
| `budgets.agent.userGlobal` | `4000` | Linha de aviso suave da camada user-global da trilha agent |
| `budgets.agent.workspace` | `4000` | Linha de aviso suave da camada workspace da trilha agent |
| `writePolicy` | `'ask'` | Política de escrita padrão: `ask` / `auto` / `off` (invisível para o modelo) |
| `writePolicies` | `{}` | Sobrescritas por trilha/escopo ou por origem (ex.: `user/workspace`, `source:claude`) |
| `language` | `'en'` | Idioma do texto visível e da saída do comando: `en` / `zh` |
| `snapshotOrder` | `-50` | Ordem da seção de snapshot (após a identidade do harness, antes de persona) |
| `maxEntriesPerQuery` | `20` | Limite de resultados por consulta (limite rígido 1000) |
| `commandListLimit` | `50` | Entradas exibidas por `/memory list` / `query` |
| `commandAuditLimit` | `10` | Linhas de auditoria exibidas por `/memory audit` |
| `recall.historyLimitDefault` | `8` | Sessões escaneadas pelo `memory_recall` por padrão |
| `recall.snippetCap` | `5` | Fragmentos por sessão no `memory_recall` |
| `recall.snippetChars` | `300` | Caracteres de fragmento no `memory_recall` |
| `recall.windowDays` | `30` | Janela de recência em dias do `memory_recall` |
| `observe.days` | `14` | Janela em dias do `memory_observe scan` (teto rígido 90) |
| `observe.sessions` | `8` | Sessões recentes amostradas por varredura (teto rígido 20) |
| `observe.perSession` | `12` | Mensagens amostradas por sessão, distribuídas uniformemente para preservar tanto a abertura quanto as correções posteriores (teto rígido 20) |
| `observe.messageChars` | `400` | Teto de caracteres por mensagem antes de truncar com reticências (teto rígido 800) |
| `observe.totalChars` | `12000` | Orçamento de caracteres de todo o trecho; a varredura para aí e informa o que não conseguiu cobrir (teto rígido 30000) |
| `recall.weighting.heat` | `0.3` | Teto do bônus de calor (multiplicativo; `0` o desliga). Calor = recalls (com saturação) × decaimento por meia-vida desde o último recall: uma memória precisa continuar sendo recuperada para manter o calor |
| `recall.weighting.heatSaturation` | `10` | Recalls que saturam o bônus de calor |
| `recall.weighting.heatHalfLifeDays` | `14` | Meia-vida do calor em dias (uma entrada sem recalls recentes esfria) |
| `recall.weighting.freshness` | `0.2` | Teto do bônus de frescor (multiplicativo; `0` o desliga) |
| `recall.weighting.freshnessHalfLifeDays` | `30` | Meia-vida do frescor em dias |
| `recall.weighting.tagDiscount` | `0.5` | Peso de um token quando coincide apenas em `tags` (uma coincidência no corpo vale `1`) |
| `retrieval.vector` | `false` | Interruptor de recuperação semântica: `true` só troca para recuperação vetorial **quando há um provedor de embedding realmente semântico registrado** — um de hash/falso de propósito não basta, pois não modela significado e zeraria a recuperação CJK em silêncio. Caso contrário, permanece o recuperador keyword sem dependências (bigramas CJK, correspondência por qualquer token, ponderação calor/frescor, ordenação por relevância) |
| `panelEntriesLimit` | `200` | Tamanho de página de entradas do painel web |
| `panelAuditLimit` | `20` | Linhas de auditoria do painel web por padrão |
| `auditRetentionDays` | `0` | Retenção de auditoria (0 = manter para sempre) |
| `proposals.enabled` | `true` | Capturar automaticamente uma proposta de memória após cada compactação bem-sucedida |
| `proposals.maxChars` | `2000` | Limite de caracteres da proposta |
| `proposals.maxPending` | `8` | Limite de propostas pendentes |

## Tools & surfaces

| Surface | Kind | Notes |
|---|---|---|
| `memory` | tool | add/replace/remove/consolidate/supersede/auto-tidy/restore/arbitrate/query/tidy com orientação Save/Skip; as entradas podem carregar coordenadas de perfil (`facet` = uma das sete facetas, `level` = nível de conhecimento por domínio); `supersede` funde 1..20 entradas numa só com a etiqueta `merged` e rebaixa as antigas para `superseded` (conservadas, nunca apagadas), `restore` traz de volta uma entrada rebaixada, `arbitrate` resolve um conflito de duas fontes sobre uma faceta com a direção fixada pela tabela de arbitragem, `tidy` devolve um plano só de leitura; escritas passam pela porta de aprovação |
| `memory_profile` | tool | Nível de conhecimento por domínio na escala de 31 subdomínios (`set` / `list` / `get`); `set` passa pela porta de aprovação e é auditado, `tier` é derivado de `level` |
| `yammory-survey` | skill | Questionário de perfil iniciado pelo usuário, cobrindo os 24 subblocos elegíveis; grava via `memory` + `memory_profile`. Código-fonte: `skills/yammory-survey/` |
| `memory_recall` | tool | Correspondências limitadas de memória (consulta tokenizada: bigramas CJK, palavras latinas como estão; qualquer token recupera, ordenado por relevância) mais correspondências recentes do histórico de sessão |
| `memory_observe` | tool | Canal de observação: `scan` lê um trecho limitado das mensagens passadas do próprio usuário (somente leitura, restrito por `cwd`, pseudomensagens injetadas pelo sistema são filtradas e contadas, e o déficit de orçamento é informado); `commit` grava 1..8 entradas com evidência em um lote atômico com uma única aprovação e `source: observation` |
| `yammory-observe` | skill | Observação comportamental iniciada pelo usuário que grava as cinco facetas apenas observáveis (estilo de pensamento, caráter diante da dificuldade, padrões emocionais, autoimagem, estilo de decisão) via `memory_observe`. Código-fonte: `skills/yammory-observe/` |
| `yammory-tidy` | skill | Arrumação da memória iniciada pelo usuário: lê o plano só de leitura, funde o que diz o mesmo e rebaixa as entradas antigas (conservadas, nunca apagadas), sem cruzar baldes. Código-fonte: `skills/yammory-tidy/`; regras de julgamento em `references/merge-rules.md` |
| `/memory` | command | `list` · `query` · `add` · `remove` · `consolidate` · `restore <id...>` · `arbitrate <id...>` · `tidy [--days=N]` · `stats` · `proposals` · `budgets` · `audit` · `export` · `import <path>` · `adapters` · `observe [--days=N]` · `session [on|off]` |
| session switch | session header | Interruptor de memória por sessão no cabeçalho da conversa, logo após o rótulo de preset de agente (`conversation.session.header.actions`, escopo de sessão): mostra o estado e alterna via `GET`/`POST /api/memento/session` (a mesma cerca de confiança `connection.fetch` das rotas do painel) |
| web panel | client drawer | Somente leitura para o conteúdo: navegar entradas, buscar, barras de orçamento, os três números observáveis, cauda de auditoria; um botão de ação do usuário apenas enfileira uma arrumação da biblioteca inteira; a entrada lateral pode ser ocultada (`panel.enabled`) |
| settings section | Barra lateral de configurações do DSH → `yammory-system` | Edita todos os campos de configuração (exceto `enabled`) sem tocar em arquivos; o momento de aplicação (ao vivo ou após recarga) é indicado na página |

## MCP server

O `yammory_system` inclui um **servidor MCP** stdio somente-leitura (`yammory_system-mcp`) para que clientes MCP externos (Claude, Codex, …) pesquisem o armazenamento de memória sem o harness. Ele fala JSON-RPC 2.0 sobre JSON delimitado por novas linhas (NDJSON): um objeto JSON por linha, sem enquadramento `Content-Length`.

**Somente leitura.** O banco é aberto com `readOnly: true` do `node:sqlite` (sem migrações, sem gravações WAL, sem incremento do contador de recall); um banco ausente retorna resultados vazios em vez de falhar.

| Ferramenta | Propósito |
|---|---|
| `memory_search` | `{query, limit?}` → entradas ordenadas (substring sem distinção de maiúsculas via o seam do Provider de recuperação) |
| `memory_stats` | `{}` → `{total, namespaces}` contagem de entradas + visão geral por track/scope |

Execução direta:

```sh
node bin/mcp-server.mjs
# ou, após instalar o pacote pelo canal do GitHub: npx yammory_system-mcp
# (este repositório ainda não está no registro npm; o spec -p github:… acima é a origem)
```

O caminho do banco é `$DSH_MEMENTO_DB_PATH` (absoluto, ou relativo a `$DSH_HOME`); padrão `$DSH_HOME/dsh-memento/memory.db`.

Exemplo para o Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "yammory_system": {
      "command": "npx",
      "args": ["-y", "-p", "github:KhalilYamber/yammory-system", "yammory_system-mcp"],
      "env": {
        "DSH_MEMENTO_DB_PATH": "/home/you/.dsh/dsh-memento/memory.db"
      }
    }
  }
}
```

O servidor é somente-leitura: sem rede, sem gravações, sem porta de aprovação — apenas busca e estatísticas.

## Permissions & data

- **Permissions**: o manifesto de workshop declara `harness:tool`, `filesystem:read`, `filesystem:write` e `network:none` / `subprocess:none` / `shell:none` / `python:none` / `credentials:none`. A aprovação de escrita usa a costura oficial de aprovação.
- **Data**: banco de dados SQLite local (`0600`), zero rede, zero credenciais.
- **Session log**: a completude da auditoria vem do par de aprovação (`approval/asked` + `approval/decided`) mais a tabela de auditoria do plugin.

## Security boundaries

- **Somente serviços públicos.** Consome `tools`, `systemPrompt` e a costura de aprovação; sem alterações em engine / agent-loop / apiproxy / UI oficial.
- **Zero rede, zero credenciais.** Banco de dados local com modo de arquivo POSIX `0600`.
- **Falha ruidosa.** Banco corrompido, esquema mais novo ou configuração inválida falha ao carregar; orçamentos cheios e correspondências de substring ambíguas falham com erros estruturados.
- **Um processo, um armazém.** Várias sessões compartilham o armazém SQLite; dois processos que compartilham um `$DSH_HOME` escrevem o mesmo arquivo (último escritor vence sob o bloqueio do SQLite).

## Known limitations

- **Eventos de sessão declarados, ainda não emitidos (rc.2).** `memory/added|updated|removed|recalled|snapshot` são declarados por fusão, mas o rc.2 não tem superfície de registro para tipos de evento fora do repo; a emissão é ativada quando uma build do harness os registrar.
- **A política `ask` precisa de um answerer.** Sem um answerer UI/ACP composto, as escritas falham fechadas.
- **Sem indexação FTS5.** A busca por substring usa `instr` insensível a maiúsculas (correto para CJK).
- **A observação é uma lista de permissões, e a lista tem uma borda.** `memory_observe scan` só mantém eventos `user/message` cujo `source.kind` é `user` ou `user-rpc`; medido nesta máquina, isso descarta 48% de todos os eventos `user/message` (contexto de execução, AGENTS.md, catálogos de skills, rodadas de objetivo, avisos de subagentes). Não consegue, porém, separar uma mensagem digitada por uma pessoa de uma injetada por uma ponte externa que também declara `kind: 'user'` — o log carrega apenas esse sinal. Trate uma citação isolada como evidência fraca; exija repetição entre sessões.
- **A metade da recordação chamada «semântica» ainda não é semântica.** `retrieval.vector` só entra em ação com um provedor de embedding que se declare semântico, e o único provedor que vem junto declara `false`, então hoje o interruptor recai por desenho na recordação por palavras-chave. Ligar a recordação semântica de verdade exige uma fonte de embedding que este repositório ainda não escolheu.

## How it's different

| Plugin | O que é | A diferença do yammory_system |
|---|---|---|
| dsh-mneme | memória auto-evolutiva com superfície de recursos ampla | só perfil de corpus pequeno: compete falando no nível medido do usuário, não ampliando recursos |
| dsh-meow-memory | armazém de sete camadas com recuperação BM25 | sem engenharia de recuperação: tabela de nível por domínio mais arbitragem por facetas |
| dsh-persona-memory | injeção de persona no prompt | uma camada a mais: **nível de conhecimento por domínio** e **arbitragem por facetas** sobre o perfil permanente |
| dsh-memory-evolve | armazém de memória / laços de evolução | costura de serviço tipada, porta de aprovação e auditoria de log de sessão; sem ambição de armazém |
| dsh-mnemon | auxiliar de armazenamento de memória | protocolo + porta + auditoria, não outro armazém |
| dsh-kb-sieve | peneiramento de base de conhecimento | sem engenharia de recuperação: busca por substring em corpus pequeno, recall entre sessões via `session_search`/`sessionQuery` |
| dsh-tdai-memory | ferramentas de memória dirigidas por tarefa | orçamentos são por track×camada e aplicados no serviço, não no melhor esforço |
| claude-bridge | ponte do Claude Code | nativo do DSH; uma futura rota `seed(source:'claude')` deixa uma ponte alimentar o mesmo armazém |
| dsh-external/Recall | memória de agente externa | local primeiro, zero rede, usa a própria costura de aprovação do DSH |
| Official MCP memory examples | a posição declarada do DSH de "memória = MCP externo" | o complemento **nativo de primeira parte**: mesmo objetivo, sem servidor externo; ambos coexistem |

As duas diferenças que se sustentam hoje são o último par da tabela: um **perfil de sete facetas com nível de conhecimento por domínio** (decide em que registro o assistente fala, antes de qualquer recuperação) e a **arbitragem por facetas** (decide como termina um fato com duas fontes: capacidade segue a observação, preferência segue o autorrelato, e as outras cinco facetas mantêm as duas e marcam `gap` em cada).

O nome é **`yammory_system`** (instalado pelo canal do GitHub; ainda não está no registro npm). Não `dsh-recall` (confundível com dsh-external/Recall), não o nome legado excluído `dsh-memory`.

## dsh-memory-protocol v1

O `yammory_system` é o ensaio comunitário do protocolo de memória DSH — uma forma candidata para uma costura oficial `ctx.memory`. O protocolo normaliza a costura deste plugin em um contrato entre plugins:

- **Entry spec** — duas trilhas × duas camadas × chave por agente, mais `tags` curtos (≤16 × ≤32 caracteres) e um `version` por entrada que incrementa a cada `replace`.
- **Write semantics** — escritas condicionais idempotentes por substring única; payloads de aprovar-o-que-se-vê (`replace` / `remove` / `consolidate` carregam o texto completo que alteram).
- **Audit contract** — toda escrita reconstruível a partir de `approval/asked` + `approval/decided` + o livro-razão do provedor.
- **Modelo de aviso** — linhas de aviso suaves / semântica `AMBIGUOUS_MATCH`.
- **Schema versioning** — regras de migração com verificações de versão ruidosas.

- **Spec** — [docs/protocol-v1.md](docs/protocol-v1.md) (中文: [protocol-v1.zh.md](docs/protocol-v1.zh.md)); JSON Schema normativo em [docs/schemas/dsh-memory-protocol-v1.schema.json](docs/schemas/dsh-memory-protocol-v1.schema.json).

**Registro de adaptadores** — `ctx.memoryAdapters` (`register` / `list` / `adapt` / `export`) permite que plugins de memória de terceiros falem o protocolo registrando um conversor de dados puro (`register()` reversível; a importação usa o `seed` com porta de aprovação, a exportação é somente leitura). Integração: [docs/adapters-guide.md](docs/adapters-guide.md) (中文: [adapters-guide.zh.md](docs/adapters-guide.zh.md)).

| Built-in adapter | External format | Notes |
|---|---|---|
| `mem0` | coleções de fatos mem0 (`{facts: [{memory, metadata?}]}`) | `metadata.category` / `metadata.tags` viram tags; arrays `messages` crus são rejeitados — adaptadores convertem, nunca extraem |
| `hermes-memory-md` | `memory.md` do Hermes (`## section` + marcadores) | nomes de seção viram tags; prosa sem marcadores falha ruidosamente |
| `claude-code-memory-md` | markdown estilo `CLAUDE.md` (títulos, marcadores, parágrafos) | marcadores e parágrafos viram entradas; nomes de seção viram tags |

**Suíte de conformidade** — [test/protocol-conformance/](test/protocol-conformance/README.md): um conjunto de casos distribuível que qualquer provedor que reivindique compatibilidade executa (`node test/protocol-conformance/run.mjs --provider ./your-factory.mjs`); o CI deste repo o executa contra seu próprio provedor como referência dourada (`npm run test:conformance`).

- **Upstream proposal** — [docs/upstream-proposal.md](docs/upstream-proposal.md) (中文: [upstream-proposal.zh.md](docs/upstream-proposal.zh.md)): por que a costura oficial `ctx.memory` deveria adotar o protocolo, as diferenças e o caminho de migração.

## What we learned from the terminal memories

O `yammory_system` não é um port do Claude Code, Codex ou Hermes — mas seu design absorveu deliberadamente as partes que cada um acertou, e recusou as que causavam dano:

| Terminal memory | O que acertou | O que o yammory_system adotou |
|---|---|---|
| **Claude Code** — `CLAUDE.md` | arquivos de memória em texto puro hierárquicos (nível usuário → nível projeto), legíveis e editáveis por humanos, mesclados automaticamente em toda sessão | entradas em texto puro; camadas `user-global` / `workspace` mescladas por sessão; um armazém que você pode navegar, `export` e auditar — transparência como característica |
| **Codex** — `AGENTS.md` | instruções com escopo por diretório auto-descobertas e injetadas com atrito zero para o modelo | a camada `workspace` indexada pelo cwd da sessão (insensível a maiúsculas no Windows); o snapshot congelado injetado automaticamente no início da sessão |
| **Hermes** — `memory.md` | gravações de memória proativas e a lição de segurança de que uma porta aplicada só na camada de ferramentas é contornável por injeção tardia de ferramenta | a ferramenta `memory` com orientação Save/Skip + propostas de auto-captura com porta de aprovação; a porta vive dentro dos métodos de escrita de `ctx.memory`, não na camada de ferramentas |

Fontes: [Claude Code memory](https://code.claude.com/docs/en/memory) · [Codex AGENTS.md](https://developers.openai.com/codex/cli/agents-md) · [Hermes memory](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md) · [Hermes #48181](https://github.com/NousResearch/hermes-agent/issues/48181).

E as partes deliberadamente recusadas: a auto-resumização oculta em estado privado do modelo (os resumos de compactação aqui viram **propostas pendentes** que aguardam um approve/dismiss humano), as ambições de armazém/vector-store, e qualquer escrita sem aprovação ou trilha de auditoria visível para humanos. Também adotado: a ressalva documentada do Hermes de que dois processos que compartilham um diretório home escrevem o mesmo arquivo de memória — veja Security boundaries.

## Development

```sh
npm install              # node ^22.19 || >=24
npm test                 # node --test: 365 tests
npm run lint             # oxlint
npm run test:conformance # dsh-memory-protocol v1 conformance suite
npm run typecheck        # tsc --checkJs gate
npm run check:coverage   # line-coverage gate
npm run check:readmes    # five-language README consistency gate
npm run verify:self-contained # reject out-of-repo dependency specs
npm run verify:artifacts # artifact presence + syntax + import
```

`lib/` tem zero dependências de DSH (somente builtins de node:); importações de DSH existem apenas em `index.mjs`.

## Topics

`dsh`, `dsh-plugin`, `deepseek-harness`, `memory`, `agent-memory`, `approval`, `audit`, `sqlite`, `cordis`, `llm`

## Contributors

- [@Niuniu-Sir](https://github.com/Niuniu-Sir) — o relato de falha de inicialização na [issue #1](https://github.com/PerryLink/dsh-memento/issues/1) que levou ao fallback `~/.dsh` incluído na 0.3.1.

## Upstream

This project is a fork of [`dsh-memento`](https://github.com/PerryLink/dsh-memento), originally part of the [PerryLink DSH plugin family](https://github.com/PerryLink). Upstream attribution and the Apache-2.0 licence are preserved.

[Apache License 2.0](LICENSE) © 2026 dsh-memento contributors

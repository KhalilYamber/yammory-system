<div align="center">

# yammory_system

**Su asistente deja de preguntarle lo que ya debería saber.**

Lo recuerda entre sesiones — en qué punto está en cada materia, cómo prefiere que le hablen, qué ha quedado decidido — y ninguna escritura aterriza sin su aprobación, así que nada sobre usted se guarda a sus espaldas.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/dsh--plugin-✅-green)](https://github.com/topics/dsh-plugin)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen.svg)](#compatibility)
[![CI](https://img.shields.io/github/actions/workflow/status/KhalilYamber/yammory-system/ci.yml?branch=main&label=CI)](https://github.com/KhalilYamber/yammory-system/actions)
[![Version](https://img.shields.io/github/v/tag/KhalilYamber/yammory-system?label=version)](https://github.com/KhalilYamber/yammory-system/releases)

[English](README.md) · [简体中文](README-zh.md) · [Español](README-es.md) · [Português](README-pt.md) · [हिन्दी](README-hi.md)

<sub>Distribución: solo el canal de GitHub — no hay paquete npm ni ficha en ningún marketplace.</sub>

</div>

---

## Why this exists

Un asistente capaz sigue siendo un asistente con amnesia. En cada sesión empieza de cero: no sabe que usted ya entiende los autovectores pero nunca ha tocado una red tensorial, que prefiere que lo corrijan antes que lo animen, ni que hace tres semanas decidió no tomar ese camino. Así que usted vuelve a presentarse, una y otra vez, y la conversación que podría haber empezado en la parte interesante empieza en cero.

`yammory_system` le da a DeepSeek Harness un lugar donde guardar ese conocimiento, y una forma de usarlo sin adivinar. Tres cosas lo separan de un almacén de memoria:

- **Decide cómo hablar antes de buscar.** Un perfil de siete facetas lleva un nivel de conocimiento por dominio, así que el asistente sabe qué vocabulario puede usar antes de responder: la inyección ocurre al ensamblar el prompt, no después de un paso de recuperación.
- **Sin usted, no se escribe nada.** Toda ruta de escritura se fuerza a través de la propia puerta de aprobación de DSH dentro del servicio. Una escritura denegada también deja evidencia; una escritura silenciosa no es un estado al que este plugin pueda llegar.
- **Su trabajo se puede revisar.** Todo lo que el modelo vio queda registrado, el almacén es un archivo SQLite normal que usted puede explorar, exportar y auditar, y toda una categoría de errores se evita por diseño y no por disciplina.

## Install

```sh
# 1. install the bundle into your profile
dsh plugin --profile web add "github:KhalilYamber/yammory-system#main"

# 2. restart and verify the row
dsh --profile web --dump-config | grep -A3 'id: yammory_system'
```

Otros canales y desinstalación:

- **canal git** (último `main`): `dsh plugin --profile web add git+https://github.com/KhalilYamber/yammory-system.git`.
- **canal tarball**: `npm pack` en este repo, luego `dsh plugin --profile web add ./yammory_system-<version>.tgz`.
- **desinstalar**: `dsh plugin --profile web remove yammory_system` (la base de datos de memoria y los registros de sesión se conservan).

## The first minute

Tras reiniciar debería ver, sin configurar nada:

| Dónde | Qué |
|---|---|
| Pie de la barra lateral | Una entrada de **memoria** junto a Ajustes (abre y cierra el panel; se oculta con `panel.enabled`) |
| Cabecera de la conversación | Un interruptor de memoria por sesión — apagado detiene la inyección, el recuerdo, las escrituras y la observación de esa sesión |
| Pie de la barra lateral → esa entrada | El panel: entradas por pista y capa, búsqueda, uso de las líneas de aviso, auditoría reciente, los tres números observables y un botón **Ordenar toda la biblioteca** que solo encola una marca |
| Ajustes de DSH → `yammory-system` | Todos los campos de configuración, cada uno con un signo de interrogación que lo explica en palabras llanas |
| `/memory` | `list`, `query`, `stats`, `audit`, `session on|off`, `export` / `import <path>` y más |

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

`yammory_system` es una costura de capacidad, no otro almacén: un servicio tipado `ctx.memory`, un proveedor SQLite local (`node:sqlite`, WAL, `0600`, en `$DSH_HOME/dsh-memento/memory.db`) y sus consumidores — la herramienta `memory` y una instantánea congelada inyectada en el prompt del sistema.

Dos pistas × dos capas × clave por agente: una pista `user` (hechos sobre el usuario) y una pista `agent` (hechos de entorno y convenciones), cada una dividida en capas `user-global` y `workspace`, aisladas por `agentPreset`. La instantánea se congela una vez por sesión en el primer ensamblado del prompt y nunca cambia a mitad de sesión. El bloque de precalentamiento lleva las restricciones de expresión y el perfil permanente, y cierra con un directorio de una línea (`N more workspace / agent-track entries stay out of this block`) para que el modelo sepa que hay algo que traer con `memory_recall`: solo el recuento, el contenido sigue a demanda.

## Capabilities

- **La puerta no se puede eludir.** Toda ruta de escritura (`add` / `replace` / `remove` / `seed`) se fuerza a través de la cascada de aprobación dentro del servicio, no en la capa de herramientas. `writePolicy: ask | auto | off` es configuración invisible para el modelo; `replace` / `remove` / `consolidate` llevan el texto completo de las entradas que cambian en el payload de aprobación, y una escritura denegada deja igualmente una fila de auditoría `*-denied`.
- **Visible para el modelo ⟺ registrado.** La instantánea inyectada llega textualmente a `system/message`; cada escritura es reconstruible a partir de `approval/asked` + `approval/decided` + la propia tabla de auditoría del plugin.
- **Acotada y honesta.** Líneas de aviso suaves por pista y por capa (por defecto usuario 2000 / agente 4000). Cruzar una nunca bloquea una escritura: solo indica que esa capa merece consolidarse. Nunca se trunca, nunca se compacta automáticamente.
- **Interruptor por sesión.** Cada sesión tiene su propio interruptor de memoria (tabla SQLite propia del plugin, esquema v6; activado por defecto). Apagado detiene cuatro cosas a la vez: la inyección (el bloque de precalentamiento congelado se descarta de inmediato), el recuerdo (`SESSION_MEMORY_OFF`), la escritura (se rechaza en la misma capa que la puerta de aprobación) y la observación (la sesión no se escanea y tampoco se elige como historial). Las lecturas de gestión (`/memory list` / `budgets` / `audit` / `export`) siguen disponibles. Se cambia con `/memory session on|off` o con el interruptor del compositor; el estado del interruptor nunca entra en el registro de sesión y sus filas de auditoría llevan `text: null`.
- **Observar, y dejar que la observación se ejecute sola.** El canal de observación lee una porción acotada de tus propios mensajes pasados y escribe entradas de conducta que el cuestionario no alcanza; ahora una comprobación de solo lectura avisa cuando la última observación tiene más de una semana (una fila de auditoría `observe-due` y una línea al final del siguiente bloque de calentamiento), y una ronda semanal programada puede ejecutarla sin nadie delante en UN espacio de trabajo: una sesión `dsh` sin interfaz escanea, infiere como mucho tres entradas con evidencia y las confirma por la misma puerta de aprobación, autorizada por su propia fuente de política de escritura (`source:observation`, `auto` / `ask` / `off`). Dentro del plugin no vive ningún temporizador; la programación es una entrada del Programador de tareas de Windows, igual que la ronda de orden.
- **Orden y medida.** Una pasada de orden dirigida por el modelo fusiona las entradas que dicen lo mismo en una sola con la etiqueta `merged` y degrada las antiguas a `superseded`: siguen en disco, fuera de la vista de toda sesión, nunca se borran. Nunca cruza cubos (`track × scope × agentKey`, más `workspaceKey` en la capa workspace) ni arranca por su cuenta. Si una fusión puede escribirse sin pasar por una persona lo deciden cinco compuertas mecánicas (mismo bucket / número de miembros / identidad literal una vez quitados puntuación, espacios y símbolos / similitud / cobertura), nunca la confianza que el modelo se atribuya: solo el grado cuyos miembros son idénticos tras quitar puntuación, espacios y símbolos se juzga `auto` y puede aterrizar sin nadie delante, mientras que una paráfrasis completa queda por debajo incluso de la línea de `review` y simplemente se juzga `skip`, y un cambio de un solo carácter cae en `review` y conserva la vía interactiva. Por eso una ronda en segundo plano (una sesión `dsh` sin interfaz despertada por su propio programador) puede fusionar por sí sola los duplicados mecánicamente inequívocos, y deja el resto esperándole a usted. La escritura fija su propia fuente de auditoría (`tidy-auto`), así que una política de escritura granular (`source:tidy-auto`) puede permitir exactamente esa vía y dejar las demás tras la compuerta de aprobación. Aparte, una comprobación de solo lectura en `agent/turn-stopping` solo avisa de que el atraso superó la línea (una fila de auditoría `tidy-due` y una línea al final del siguiente bloque de precalentamiento). `/memory stats` informa de los tres números observables (tasa de repetición, tasa de acierto de recuerdo, volumen inyectado), y el panel muestra esas mismas tres líneas; la tasa de éxito se deja en blanco a propósito, porque este repositorio no tiene fuente de señal para «¿el bloque inyectado llegó a entenderse?». El botón **Ordenar toda la biblioteca** del panel es una cola, no una acción: escribe una sola fila de marca (`tidy_requests`, schema v7) bajo la misma política de aprobación, el precalentamiento de la siguiente sesión pide al modelo una pasada completa, y la marca pasa a `done` cuando aterriza una escritura de orden: nada se fusiona desde el panel.

- **Gobernar la memoria: deshacer una degradación y arbitrar un conflicto por faceta.** `restore` recorre la degradación al revés (`superseded → active`, `version` intacta, de vuelta en la vista de toda sesión) y es la única salida del estado degradado. `arbitrate` resuelve el caso de un hecho con dos fuentes: decide sobre **una sola faceta** y la dirección sale de una tabla fija — la capacidad sigue a la observación, la preferencia sigue al autoinforme, y las otras cinco facetas conservan **ambas** entradas y etiquetan cada una con `gap` (la brecha es la evidencia). La tabla es la dirección, así que no hay argumento inverso que pasar, y dentro de un grupo se conserva la entrada actualizada más recientemente. Ambas acciones pasan por la misma puerta de aprobación, el mismo interruptor por sesión y las mismas reglas de cubo que cualquier otra escritura, y ambas dejan rastro de auditoría: `restore` por entrada, `arbitrate` por degradación (`text: null`, solo ids), `arbitrate-tag` por etiqueta y un resumen final `arbitrate` que dice a quién se conservó, a quién se degradó y por qué.

## Compatibility

| Surface | Status |
|---|---|
| Harness | DeepSeek Harness `dsh-v0.1.5-rc.2` (adaptado el 2026-09-09): el sobre de sesión conserva su campo ignorable solo para compatibilidad de lectura de logs almacenados - Session.append aún no puede estamparlo, por lo que el comportamiento de la puerta no cambia. Verificado el 2026-09-11 contra el checkout master dsh-v0.1.5-rc.2 (cadena completa de puertas + humo de instalación de perfil). |
| Node | `^22.19.0 || >=24.0.0` |
| Platforms | Windows / macOS / Linux (solo host; sin código nativo, sin red) |
| Model | Cualquiera |

## Configuration

Todos los parámetros son campos Schemastery `Config` (modificables desde cordis.yml). Los valores inválidos fallan de forma ruidosa al cargar. Se sobrescriben bajo la fila `yammory_system`.

**Panel de ajustes.** Con el servicio de ajustes de DSH montado, todos los campos siguientes (salvo `enabled`) se editan desde la **entrada `yammory-system` en la barra lateral de ajustes de DSH** (una sección de primer nivel, como General o Plugins); los cambios se guardan en la capa de usuario de ajustes (`settings.yaml`) sin tocar archivos. Casi todo se aplica en vivo (políticas de escritura, idioma, presupuestos, topes, propuestas, panel; `dbPath` / `auditRetentionDays` reabriendo el almacén; `retrieval.vector` cambiando el recuperador) — solo `snapshotOrder` requiere recargar DSH. Sin el servicio de ajustes todo vuelve a la configuración compuesta, igual que antes. La entrada de memoria del pie de la barra lateral puede ocultarse desde la misma página (`panel.enabled`).

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Interruptor maestro; `false` elimina servicio, herramientas, instantánea, comando, panel y answerer (no editable desde la página de ajustes: un plugin deshabilitado no tiene entrada de ajustes) |
| `panel.enabled` | `true` | Mostrar la entrada de memoria al pie de la barra lateral; al guardar `false` desde la página de ajustes, se oculta al instante, sin recargar (la página de ajustes no se ve afectada) |
| `dbPath` | `''` → `$DSH_HOME/dsh-memento/memory.db` | Absoluto, o relativo a `$DSH_HOME` (en Windows cae a `~/.dsh`) |
| `budgets.user.userGlobal` | `2000` | Línea de aviso suave de la capa user-global de la pista user |
| `budgets.user.workspace` | `2000` | Línea de aviso suave de la capa workspace de la pista user |
| `budgets.agent.userGlobal` | `4000` | Línea de aviso suave de la capa user-global de la pista agent |
| `budgets.agent.workspace` | `4000` | Línea de aviso suave de la capa workspace de la pista agent |
| `writePolicy` | `'ask'` | Política de escritura por defecto: `ask` / `auto` / `off` (invisible para el modelo) |
| `writePolicies` | `{}` | Sobrescrituras por pista/ámbito o por origen (p. ej. `user/workspace`, `source:claude`) |
| `language` | `'en'` | Idioma del texto visible y la salida del comando: `en` / `zh` |
| `snapshotOrder` | `-50` | Orden de la sección de instantánea (tras la identidad del harness, antes de persona) |
| `maxEntriesPerQuery` | `20` | Tope de resultados por consulta por defecto (límite duro 1000) |
| `commandListLimit` | `50` | Entradas mostradas por `/memory list` / `query` |
| `commandAuditLimit` | `10` | Filas de auditoría mostradas por `/memory audit` |
| `recall.historyLimitDefault` | `8` | Sesiones escaneadas por `memory_recall` por defecto |
| `recall.snippetCap` | `5` | Fragmentos por sesión en `memory_recall` |
| `recall.snippetChars` | `300` | Caracteres de fragmento en `memory_recall` |
| `recall.windowDays` | `30` | Ventana de antigüedad en días de `memory_recall` |
| `observe.days` | `14` | Ventana en días de `memory_observe scan` (tope duro 90) |
| `observe.sessions` | `8` | Sesiones recientes muestreadas por escaneo (tope duro 20) |
| `observe.perSession` | `12` | Mensajes muestreados por sesión, repartidos de forma uniforme para conservar tanto la apertura como las correcciones posteriores (tope duro 20) |
| `observe.messageChars` | `400` | Tope de caracteres por mensaje antes de truncar con puntos suspensivos (tope duro 800) |
| `observe.totalChars` | `12000` | Presupuesto de caracteres de todo el fragmento; el escaneo se detiene ahí e informa lo que no pudo cubrir (tope duro 30000) |
| `recall.weighting.heat` | `0.3` | Tope del bonus de calor (multiplicativo; `0` lo apaga). El calor = recalls (con saturación) × decaimiento por semivida desde el último recall: una memoria debe seguir siendo recuperada para conservar su calor |
| `recall.weighting.heatSaturation` | `10` | Recalls que saturan el bonus de calor |
| `recall.weighting.heatHalfLifeDays` | `14` | Semivida del calor en días (una entrada sin recalls recientes se enfría) |
| `recall.weighting.freshness` | `0.2` | Tope del bonus de frescura (multiplicativo; `0` lo apaga) |
| `recall.weighting.freshnessHalfLifeDays` | `30` | Semivida de la frescura en días |
| `recall.weighting.tagDiscount` | `0.5` | Peso de un token cuando coincide solo en `tags` (una coincidencia en el cuerpo vale `1`) |
| `retrieval.vector` | `false` | Interruptor de recuperación semántica: `true` solo cambia a recuperación vectorial **cuando hay registrado un proveedor de incrustación realmente semántico** — uno de hash/falso no basta a propósito, pues no modela significado y dejaría la recuperación CJK en cero en silencio. Si no, se mantiene el recuperador keyword sin dependencias (bigramas CJK, coincidencia por cualquier token, ponderación calor/frescura, orden por relevancia) |
| `panelEntriesLimit` | `200` | Tamaño de página de entradas del panel web |
| `panelAuditLimit` | `20` | Filas de auditoría del panel web por defecto |
| `auditRetentionDays` | `0` | Retención de auditoría (0 = conservar para siempre) |
| `proposals.enabled` | `true` | Capturar automáticamente una propuesta de memoria tras cada compactación exitosa |
| `proposals.maxChars` | `2000` | Tope de caracteres de la propuesta |
| `proposals.maxPending` | `8` | Tope de propuestas pendientes |

## Tools & surfaces

| Surface | Kind | Notes |
|---|---|---|
| `memory` | tool | add/replace/remove/consolidate/supersede/auto-tidy/restore/arbitrate/query/tidy con guía Save/Skip; las entradas pueden llevar coordenadas de perfil (`facet` = una de las siete facetas, `level` = nivel de conocimiento por dominio); `supersede` fusiona 1..20 entradas en una con la etiqueta `merged` y degrada las antiguas a `superseded` (se conservan, nunca se borran), `restore` devuelve una entrada degradada a la vida, `arbitrate` resuelve un conflicto de dos fuentes sobre una faceta con la dirección fijada por la tabla de arbitraje, `tidy` devuelve un plan de solo lectura; las escrituras pasan por la puerta de aprobación |
| `memory_profile` | tool | Nivel de conocimiento por dominio sobre la escala de 31 subdominios (`set` / `list` / `get`); `set` pasa por la puerta de aprobación y queda auditado, `tier` se deriva de `level` |
| `yammory-survey` | skill | Cuestionario de perfil iniciado por el usuario que cubre los 24 subbloques aptos para cuestionario; escribe mediante `memory` + `memory_profile`. Código fuente: `skills/yammory-survey/` |
| `memory_recall` | tool | Coincidencias acotadas de memoria (consulta tokenizada: bigramas CJK, palabras latinas tal cual; cualquier token recupera, ordenado por relevancia) más coincidencias recientes del historial de sesión |
| `memory_observe` | tool | Canal de observación: `scan` lee un fragmento acotado de los mensajes pasados del propio usuario (solo lectura, acotado por `cwd`, los pseudomensajes inyectados por el sistema se filtran y se cuentan, y el déficit de presupuesto se informa); `commit` escribe 1..8 entradas con evidencia en un lote atómico con una sola aprobación y `source: observation` |
| `yammory-observe` | skill | Observación conductual iniciada por el usuario que escribe las cinco facetas solo observables (estilo de pensamiento, carácter ante la dificultad, patrones emocionales, autoimagen, estilo de decisión) mediante `memory_observe`. Código fuente: `skills/yammory-observe/` |
| `yammory-tidy` | skill | Orden de memoria iniciado por el usuario: lee el plan de solo lectura, fusiona lo que dice lo mismo y degrada las entradas antiguas (se conservan, nunca se borran), sin cruzar cubos. Código fuente: `skills/yammory-tidy/`; reglas de juicio en `references/merge-rules.md` |
| `yammory-experience` | skill | Registra lecciones reutilizables del trabajo en la pista `agent` (hechos del entorno, convenciones, lecciones), separadas del perfil del usuario por una sola pregunta: ¿este conocimiento debe estar presente en cada turno? Código fuente: `skills/yammory-experience/` |
| `/memory` | command | `list` · `query` · `add` · `remove` · `consolidate` · `restore <id...>` · `arbitrate <id...>` · `tidy [--days=N]` · `stats` · `proposals` · `budgets` · `audit` · `export` · `import <path>` · `adapters` · `observe [--days=N]` · `session [on|off]` |
| session switch | session header | Interruptor de memoria por sesión en la cabecera de la conversación, justo después de la etiqueta de preset de agente (`conversation.session.header.actions`, ámbito de sesión): muestra el estado y lo cambia mediante `GET`/`POST /api/memento/session` (la misma valla de confianza `connection.fetch` que las rutas del panel) |
| web panel | client drawer | Solo lectura, dividido en dos mundos: la pestaña **memoria** es un árbol plegable de siete facetas (primero las categorías, las entradas al hacer clic) más un bloque de nivel de conocimiento; la pestaña **experiencia** agrupa la pista `agent` por tema. Ambas comparten búsqueda, barras de presupuesto, los tres números observables y la cola de auditoría; un botón de acción del usuario solo encola una limpieza de toda la biblioteca; la entrada lateral puede ocultarse (`panel.enabled`) |
| settings section | Barra lateral de ajustes de DSH → `yammory-system` | Edita todos los campos de configuración (salvo `enabled`) sin tocar archivos; el momento de aplicación (en vivo o tras recarga) se indica en la página |

## MCP server

`yammory_system` incluye un **servidor MCP** stdio de solo lectura (`yammory_system-mcp`) para que clientes MCP externos (Claude, Codex, …) consulten el almacén de memoria sin el harness. Habla JSON-RPC 2.0 sobre JSON delimitado por saltos de línea (NDJSON): un objeto JSON por línea, sin tramado `Content-Length`.

**Solo lectura.** La base de datos se abre con `readOnly: true` de `node:sqlite` (sin migraciones, sin escrituras WAL, sin incremento del contador de recuperación); si el archivo no existe, devuelve resultados vacíos en lugar de fallar.

| Herramienta | Propósito |
|---|---|
| `memory_search` | `{query, limit?}` → entradas ordenadas (subcadena insensible a mayúsculas vía el seam del Provider de recuperación) |
| `memory_stats` | `{}` → `{total, namespaces}` conteo de entradas + resumen por track/scope |

Ejecución directa:

```sh
node bin/mcp-server.mjs
# o, tras instalar el paquete desde el canal de GitHub: npx yammory_system-mcp
# (este repositorio aún no está en el registro npm; el spec -p github:… de arriba es la fuente)
```

La ruta de la base de datos es `$DSH_MEMENTO_DB_PATH` (absoluta, o relativa a `$DSH_HOME`); por defecto `$DSH_HOME/dsh-memento/memory.db`.

Ejemplo para Claude Desktop (`claude_desktop_config.json`):

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

El servidor es de solo lectura: sin red, sin escrituras, sin puerta de aprobación — solo búsqueda y estadísticas.

## Permissions & data

- **Permissions**: el manifiesto de workshop declara `harness:tool`, `filesystem:read`, `filesystem:write` y `network:none` / `subprocess:none` / `shell:none` / `python:none` / `credentials:none`. La aprobación de escritura usa la costura oficial de aprobación.
- **Data**: base de datos SQLite local (`0600`), cero red, cero credenciales.
- **Session log**: la completitud de auditoría proviene del par de aprobación (`approval/asked` + `approval/decided`) más la tabla de auditoría del plugin.

## Security boundaries

- **Solo servicios públicos.** Consume `tools`, `systemPrompt` y la costura de aprobación; sin cambios en engine / agent-loop / apiproxy / UI oficial.
- **Cero red, cero credenciales.** Base de datos local con modo de archivo POSIX `0600`.
- **Fallo ruidoso.** Base de datos corrupta, esquema más nuevo o configuración inválida falla al cargar; presupuestos llenos y coincidencias de subcadena ambiguas fallan con errores estructurados.
- **Un proceso, un almacén.** Varias sesiones comparten el almacén SQLite; dos procesos que comparten un `$DSH_HOME` escriben el mismo archivo (último escritor gana bajo el bloqueo de SQLite).

## Known limitations

- **Los eventos de sesión están declarados, aún no emitidos (rc.2).** `memory/added|updated|removed|recalled|snapshot` están declarados por fusión, pero rc.2 no tiene superficie de registro para tipos de evento fuera del repo; la emisión se activa cuando una build del harness los registre.
- **La política `ask` necesita un answerer.** Sin un answerer UI/ACP compuesto, las escrituras fallan cerradas.
- **Sin indexado FTS5.** La búsqueda por subcadena usa `instr` insensible a mayúsculas (correcto para CJK).
- **La observación es una lista blanca, y la lista blanca tiene un borde.** `memory_observe scan` solo conserva eventos `user/message` cuyo `source.kind` es `user` o `user-rpc`; medido en esta máquina, eso descarta el 48% de todos los eventos `user/message` (contexto de ejecución, AGENTS.md, catálogos de skills, rondas de objetivo, avisos de subagentes). No puede, sin embargo, separar un mensaje escrito por una persona de uno inyectado por un puente externo que también declara `kind: 'user'`: el log solo lleva esa señal. Trata una cita aislada como evidencia débil; exige repetición entre sesiones.
- **La mitad del recuerdo llamada «semántica» todavía no es semántica.** `retrieval.vector` solo entra en acción con un proveedor de incrustación que se declare semántico, y el único proveedor que se envía aquí declara `false`, así que hoy el interruptor recae por diseño en el recuerdo por palabras clave. Activar el recuerdo semántico de verdad exige una fuente de incrustación que este repositorio todavía no ha elegido.

## How it's different

| Plugin | Qué es | La diferencia de yammory_system |
|---|---|---|
| dsh-mneme | memoria auto-evolutiva con una superficie de funciones amplia | solo perfil de corpus pequeño: compite hablando al nivel medido del usuario, no ampliando funciones |
| dsh-meow-memory | almacén de siete capas con recuperación BM25 | sin ingeniería de recuperación: tabla de nivel por dominio más arbitraje por facetas |
| dsh-persona-memory | inyección de persona en el prompt | una capa más: **nivel de conocimiento por dominio** y **arbitraje por facetas** sobre el perfil permanente |
| dsh-memory-evolve | almacén de memoria / bucles de evolución | una costura de servicio tipada, puerta de aprobación y auditoría de registro de sesión; sin ambición de almacén |
| dsh-mnemon | ayudante de almacén de memoria | protocolo + puerta + auditoría, no otro almacén |
| dsh-kb-sieve | tamizado de base de conocimiento | sin ingeniería de recuperación: búsqueda por subcadena en corpus pequeño, recall entre sesiones vía `session_search`/`sessionQuery` |
| dsh-tdai-memory | herramientas de memoria dirigidas por tarea | los presupuestos son por track×capa y se aplican en el servicio, no a mejor esfuerzo |
| claude-bridge | puente de Claude Code | nativo de DSH; una futura ruta `seed(source:'claude')` deja que un puente alimente el mismo almacén |
| dsh-external/Recall | memoria de agente externa | local primero, cero red, usa la propia costura de aprobación de DSH |
| Official MCP memory examples | la posición declarada de DSH de "memoria = MCP externo" | el complemento **nativo de primera parte**: mismo objetivo, sin servidor externo; ambos coexisten |

Las dos diferencias que se sostienen hoy son el último par de la tabla: un **perfil de siete facetas con nivel de conocimiento por dominio** (decide con qué registro habla el asistente, antes de cualquier recuperación) y el **arbitraje por facetas** (decide cómo se resuelve un hecho con dos fuentes: la capacidad sigue a la observación, la preferencia al autorreporte, y las otras cinco facetas conservan ambas y marcan `gap` en cada una).

El nombre es **`yammory_system`** (instalado desde el canal de GitHub; aún no está en el registro npm). No `dsh-recall` (confundible con dsh-external/Recall), no el nombre heredado eliminado `dsh-memory`.

## dsh-memory-protocol v1

`yammory_system` es el ensayo comunitario del protocolo de memoria DSH — una forma candidata para una costura oficial `ctx.memory`. El protocolo normaliza la costura de este plugin en un contrato entre plugins:

- **Entry spec** — dos pistas × dos capas × clave por agente, más `tags` cortos (≤16 × ≤32 caracteres) y un `version` por entrada que se incrementa en cada `replace`.
- **Write semantics** — escrituras condicionales idempotentes por subcadena única; payloads de aprobar-lo-que-se-ve (`replace` / `remove` / `consolidate` llevan el texto completo que cambian).
- **Audit contract** — cada escritura reconstruible desde `approval/asked` + `approval/decided` + el libro mayor del proveedor.
- **Modelo de aviso** — líneas de aviso suaves / semántica `AMBIGUOUS_MATCH`.
- **Schema versioning** — reglas de migración con verificaciones de versión ruidosas.

- **Spec** — [docs/protocol-v1.md](docs/protocol-v1.md) (中文: [protocol-v1.zh.md](docs/protocol-v1.zh.md)); JSON Schema normativo en [docs/schemas/dsh-memory-protocol-v1.schema.json](docs/schemas/dsh-memory-protocol-v1.schema.json).

**Registro de adaptadores** — `ctx.memoryAdapters` (`register` / `list` / `adapt` / `export`) permite a plugins de memoria de terceros hablar el protocolo registrando un convertidor de datos puro (`register()` reversible; la importación usa el `seed` con puerta de aprobación, la exportación es de solo lectura). Incorporación: [docs/adapters-guide.md](docs/adapters-guide.md) (中文: [adapters-guide.zh.md](docs/adapters-guide.zh.md)).

| Built-in adapter | External format | Notes |
|---|---|---|
| `mem0` | colecciones de hechos mem0 (`{facts: [{memory, metadata?}]}`) | `metadata.category` / `metadata.tags` se convierten en tags; los arrays `messages` crudos se rechazan — los adaptadores convierten, nunca extraen |
| `hermes-memory-md` | `memory.md` de Hermes (`## section` + viñetas) | los nombres de sección se convierten en tags; la prosa sin viñetas falla ruidosamente |
| `claude-code-memory-md` | markdown estilo `CLAUDE.md` (encabezados, viñetas, párrafos) | las viñetas y párrafos se convierten en entradas; los nombres de sección se convierten en tags |

**Suite de conformidad** — [test/protocol-conformance/](test/protocol-conformance/README.md): un conjunto de casos distribuible que cualquier proveedor que reclame compatibilidad ejecuta (`node test/protocol-conformance/run.mjs --provider ./your-factory.mjs`); el CI de este repo lo ejecuta contra su propio proveedor como referencia dorada (`npm run test:conformance`).

- **Upstream proposal** — [docs/upstream-proposal.md](docs/upstream-proposal.md) (中文: [upstream-proposal.zh.md](docs/upstream-proposal.zh.md)): por qué la costura oficial `ctx.memory` debería adoptar el protocolo, las diferencias y la ruta de migración.

## What we learned from the terminal memories

`yammory_system` no es un port de Claude Code, Codex o Hermes — pero su diseño absorbió deliberadamente las partes que cada uno hizo bien, y rechazó las que dañaban:

| Terminal memory | Lo que hizo bien | Lo que yammory_system adoptó |
|---|---|---|
| **Claude Code** — `CLAUDE.md` | archivos de memoria en texto plano jerárquicos (nivel usuario → nivel proyecto), legibles y editables por humanos, fusionados automáticamente en cada sesión | entradas en texto plano; capas `user-global` / `workspace` fusionadas por sesión; un almacén que puedes explorar, `export` y auditar — transparencia como característica |
| **Codex** — `AGENTS.md` | instrucciones con ámbito por directorio auto-descubiertas e inyectadas con fricción cero para el modelo | la capa `workspace` indexada por el cwd de la sesión (insensible a mayúsculas en Windows); la instantánea congelada inyectada automáticamente al iniciar la sesión |
| **Hermes** — `memory.md` | guardados de memoria proactivos y la lección de seguridad de que una puerta aplicada solo en la capa de herramientas es eludible por inyección tardía de herramientas | la herramienta `memory` con guía Save/Skip + propuestas de auto-captura con puerta de aprobación; la puerta vive dentro de los métodos de escritura de `ctx.memory`, no en la capa de herramientas |

Fuentes: [Claude Code memory](https://code.claude.com/docs/en/memory) · [Codex AGENTS.md](https://developers.openai.com/codex/cli/agents-md) · [Hermes memory](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md) · [Hermes #48181](https://github.com/NousResearch/hermes-agent/issues/48181).

Y las partes deliberadamente rechazadas: la auto-resumación oculta hacia estado privado del modelo (los resúmenes de compactación aquí se convierten en **propuestas pendientes** que esperan un approve/dismiss humano), las ambiciones de almacén/vector-store, y cualquier escritura sin aprobación o rastro de auditoría visible para humanos. También adoptado: la advertencia documentada de Hermes de que dos procesos que comparten un directorio home escriben el mismo archivo de memoria — véase Security boundaries.

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

`lib/` tiene cero dependencias de DSH (solo builtins de node:); las importaciones de DSH solo existen en `index.mjs`.

## Topics

`dsh`, `dsh-plugin`, `deepseek-harness`, `memory`, `agent-memory`, `approval`, `audit`, `sqlite`, `cordis`, `llm`

## Contributors

- [@Niuniu-Sir](https://github.com/Niuniu-Sir) — el informe de fallo de arranque en [issue #1](https://github.com/PerryLink/dsh-memento/issues/1) que llevó al fallback `~/.dsh` incluido en 0.3.1.

## Upstream

This project is a fork of [`dsh-memento`](https://github.com/PerryLink/dsh-memento), originally part of the [PerryLink DSH plugin family](https://github.com/PerryLink). Upstream attribution and the Apache-2.0 licence are preserved.

[Apache License 2.0](LICENSE) © 2026 dsh-memento contributors

# AGENTS.md — Regras de desenvolvimento do vibehub

> **O projeto:** IDE hospedada para agentes de código: um kanban de terminais Claude Code reais em containers no servidor do próprio usuário. **Público (MIT) e auto-hospedado**: cada instalação tem os próprios dados.
>
> **Escopo:** todo o repositório (`back/`, `front/`, scripts plantados nos containers, testes). **Cada regra vale pelo princípio, não pela lista de exemplos:** os arquivos citados são pontos de entrada, os contratos reais saem da inspeção do trecho (§12, passo 1), e o caso não citado segue o espírito da regra mais próxima ou vira pergunta (§12, "Como perguntar ao usuário").
>
> **O modelo é este arquivo, não o código vizinho.** Boa parte do código existente, testes incluídos, é anterior a estas regras (comentários, `let`, nomes abreviados, áreas misturadas em `front/src/features/board/`). Código novo segue estas regras mesmo quando o arquivo ao lado faz diferente.

## 1. Regras inegociáveis

1. **Simples, bem feito:** menos conceitos e indireções, todas as garantias preservadas; menos linhas não é o critério (§4, §13).
2. **Sem voltas:** nada de wrapper que só repassa, camada sem responsabilidade, factory artificial ou generalização para o futuro (§4).
3. **Código em inglês, interface pelo i18n** (§2).
4. **Só `const` nas linhas que o PR escreve**; `let` só para estado vivo; nunca `var` (§3).
5. **Sem código morto:** branch inútil, import não usado, dado não lido e funcionalidade sem consumidor saem, depois de verificar referências; nada se cria sem consumidor.
6. **Código que se explica sozinho:** o porquê vai para o commit e o PR (§3).
7. **Contratos explícitos:** um significado, uma representação canônica (§6).
8. **Falhe de forma visível:** violação de contrato nunca vira fallback ou sucesso aparente (§9).
9. **Segurança na origem:** validar e autorizar nas fronteiras (§10).
10. **Performance é requisito:** o menor trabalho real que cobre o caso (§8).
11. **Mudança completa, escopo controlado:** todo consumidor afetado corrigido, nada alheio reescrito (§12).
12. **Verificação real:** teste, build, revisão ou deploy só se dizem passados depois de executados e observados.

**Ordem de prioridade em conflitos:** segurança e integridade dos dados → correção e contratos → simplicidade e clareza → performance → estilo. Regra de estilo não justifica comportamento incorreto ou risco. Performance abaixo de clareza quer dizer: entre duas soluções igualmente rápidas, a mais clara; nunca trabalho desperdiçado aceito por ser "mais legível".

## 2. Idioma e nomenclatura

- **Identificadores em inglês** (variáveis, funções, tipos, componentes, campos persistidos), sem português misturado. O texto de `describe`/`it` segue o idioma do arquivo de teste (a maioria, pt-BR).
- **Texto de interface sempre pelo i18n** (`front/src/i18n/en.ts` e `pt-BR.ts`): chave nova entra nos dois; o JSX não leva string literal visível.
- **Documentação pública em inglês, processo em pt-BR.** O repositório é público: `README.md`, `SECURITY.md` e `docs/` se escrevem em inglês, para quem instala ou contribui sem ler português. Este arquivo, o `.claude/CLAUDE.md`, commits e PRs, que conduzem o trabalho do time, ficam em pt-BR.
- Sintaxe e APIs de terceiros (SDK do Claude, Fastify, React, Docker) ficam como a especificação deles define. Contrato persistido (`board.json` e afins), rota HTTP, ferramenta MCP e variável de ambiente só se renomeiam como mudança de contrato (§6), nunca por estética.
- Função: **verbo preciso + objeto** (`assertMovableColumn`, `normalizeCardIds`), não `process`, `handle`, `manage`, `resolve` havendo ação mais precisa. Variável diz conteúdo e função, sem `data`, `tmp`, `result`, `x` ou abreviação opaca. **Todo nome se lê sem abrir a implementação**, inclusive parâmetro de callback e variável de laço (`row`, não `r`); uma coisa, um nome no mesmo escopo.
- Referência nomeia a entidade (`cardId`, `accountSlug`, não `id` solto quando há mais de um); variantes deixam claras as duas diferenças (`originalValue` e `convertedValue`, não `value` e `convertedValue`).
- Conceito novo: `grep` do termo no repo antes; se ele já nomeia outra coisa, escolha outro.
- `camelCase` para funções/variáveis, `PascalCase` para componentes/classes/tipos, `UPPER_SNAKE_CASE` para constantes realmente estáticas (`EXEC_TIMEOUT_MS`); hooks começam com `use`. **Arquivo, inclusive de teste, segue a mesma convenção:** `camelCase.ts`, ou `PascalCase.tsx` quando exporta componente; o teste é o nome do testado mais `.test` (`sdkChat.test.ts`, `SdkChatView.test.tsx`), com sufixo de cenário quando há várias suítes (`cardSdk.lifecycle.test.ts`). Exceções: as primitivas de `front/src/components/ui/` seguem o kebab-case do shadcn (`dropdown-menu.tsx`), os idiomas de `front/src/i18n/` seguem a tag de idioma (`pt-BR.ts`) e as declarações `*.d.ts` seguem o pacote que declaram. Arquivo antigo fora do padrão só se renomeia com pedido (o rename arrasta imports).
- Cadeia de `filter`/`map`/`sort` que esconde regra importante ganha etapas intermediárias com nome.
- Em código legado, o nome ruim no trecho que o PR altera sai corrigido no mesmo passo; rename que repercute em contrato ou em muitos consumidores é mudança de contrato.

## 3. Estilo e qualidade de código

- Funções coesas, com entrada, saída e responsabilidade claras, sem limite mecânico de linhas. Retorno antecipado quando reduz aninhamento; regra complexa não vira ternário encadeado.
- **Regra de negócio e fonte de verdade não se duplicam**; repetição pequena e local pode ser melhor que abstração genérica sem significado.
- Imports estáticos no topo; dinâmico só por carregamento sob demanda (dependência pesada fora do caminho inicial), dependência circular real ou outra restrição técnica fundamentada.
- `async` só com execução assíncrona ou obrigação de retornar `Promise`. `try/catch` só quando acrescenta informação ou comportamento, nunca para relançar o mesmo erro.
- **Efeito colateral é explícito:** quem grava, apaga ou muda estado diz isso no nome (`save`, `delete`, `set`…); `get`/`read`/`parse` não grava.
- **Cálculo e efeito em etapas separadas:** o que calcula (inclusive callback de `filter`/`map`/`find`) só devolve valor; o que envia, grava ou notifica vem depois, em passo próprio.
- Utilitários e dependências **realmente existentes** antes de abstração nova ou biblioteca instalada.

### `const` e estado vivo

- **Toda declaração que o PR escreve é `const`**, inclusive em teste. Valor que muda vira nova constante com nome próprio, função ou `reduce`; `beforeEach` que reatribui um `let` vira helper chamado em cada teste (`const card = createCard()`).
- **Exceção fechada — estado vivo:** variável de módulo ou de closure que acompanha a vida de um processo, sessão ou stream e é reatribuída por eventos (a query corrente do driver, o dono das tarefas em segundo plano, um contador de tentativas). Prefira um objeto `const` com campos; se isso piora a leitura, o `let` leva `// eslint-disable-next-line no-restricted-syntax -- <motivo>` e o PR diz por quê.
- `let` existente fora do diff fica como está.

### Comentários

**O código se explica pelo nome e pela estrutura:** renomeie, extraia a etapa com nome de domínio, troque o número solto por constante nomeada; no teste, pelo nome do `describe`/`it`. **O porquê** (a decisão, a alternativa descartada, o bug que motivou a linha) vai para **a mensagem do commit** do trecho, que o `git blame` acha mesmo sem o PR, e para **o PR** (§14), lido junto com o diff.

- **Invariante que o código não deixa óbvia** (ordem obrigatória, atomicidade, corrida entre cards, cicatriz de bug em produção) ganha um **teste cujo nome diz a regra**: quem "simplificar" o trecho quebra o teste e lê o porquê no nome.
- **Únicas exceções**, em uma linha, só quando o código não tem como dizer aquilo, abrindo com o marcador (o lint do recorte reprova comentário novo sem ele):
  - `// external: <regra e referência>`: **regra externa**, com a referência da docs ou da versão do fornecedor (SDK/CLI do Claude, Docker, GitHub; §6);
  - `// limitation: <motivo>`: **limitação técnica** que nenhum nome expressa: bug conhecido de biblioteca, navegador, shell ou ambiente de teste; dependência circular que obriga o import dentro da função;
  - `// legacy-name: <o que guarda>`: **nome legado que não pode mudar** (campo persistido ou contrato externo, §2 e §6): o que ele guarda e por que não foi renomeado;
  - **diretiva de ferramenta**, sem marcador; a que aceita motivo leva o motivo: `// eslint-disable-next-line <regra> -- <motivo>`, `// @ts-expect-error <motivo>`.
- **Vale para as linhas que o PR acrescenta ou altera.** Comentário antigo fora do diff fica (muitos guardam a história de bugs de produção). O que a mudança torna **falso** sai no mesmo PR: removido, com o porquê no commit, ou, se é uma das exceções acima, reescrito com o marcador dela (para o lint, a linha reescrita é nova).
- **Em linha nova, não entram:** narração do que a linha faz, a versão anterior ("antes era…"), nome de pessoa ou de instalação, JSDoc que só repete o nome (`/** Finds the card by id */ findCardById(id)`; tipo em JSDoc num `.mjs`, `.cjs`, `.js` ou `.jsx` é tipo, não comentário), código comentado, cabeçalho novo explicando o arquivo.

| Em vez de | Escreva |
|-----------|---------|
| `// only live cards` em cima de um `filter` | `const liveCards = cards.filter(...)` |
| Comentário explicando a regra de um `if` | Condição com nome (`const canReopenCli = ...`) e o porquê no commit e no PR |
| Comentário contando o bug que a linha evita | Teste com o nome da regra (`"o login novo vale mesmo com tarefa em segundo plano viva"`) e a história no commit |

## 4. SOLID, coesão e abstrações

**Simples não é incompleto; abstrato não é robusto.**

- **Simples** = o menor número de conceitos, arquivos e indireções que cobre o problema **inteiro**: casos, erros, autorização, consumidores e testes. Cortar algum deles para "simplificar" é entrega incompleta.
- **Abstração só com necessidade real, hoje.** Camada, classe, factory, registry, estratégia, mapa paralelo, helper genérico, parâmetro de configuração ou arquivo entra quando protege uma fronteira, uma invariante ou uma duplicação relevante, ou quando há mais de um comportamento real; "para o futuro" e "por padrão arquitetural" não contam. **Teste mental:** "se eu escrever isto direto, onde é usado, o que fica pior **hoje**?" "Nada" ou "talvez um dia": escreva direto. Camada que só encaminha argumentos, sem decisão, transformação ou proteção de fronteira, sai quando seguro.
- **Uma regra, um lugar.** Fato declarável em dois lugares é desenho errado: deixe um só, em vez de uma camada que concilia os dois.
- **Cada arquivo no seu lugar:** a pasta diz o que ele **é**, o nome diz o que ele **faz** (mapa do back abaixo, do front na §5), e o teste mora **ao lado do código que testa**. Arquivo apagado, movido ou renomeado leva junto testes, tipos e irmãos: `grep` dos imports antigos e confira cada um que sobrou.
- Testes quase iguais (um por caso, mudando só os dados) viram **um** teste parametrizado (`describe.each`/`it.each`) no arquivo do assunto.

| Pasta (back) | Guarda | Não guarda |
|--------------|--------|------------|
| `back/src/routes/` | Superfície HTTP e websocket: acesso, conversão de erro em status, chamada ao service | Regra de negócio |
| `back/src/services/<area>/` | Regra de uma área (board, sdk, accounts, github…) | Código de outra área; checagem de acesso |
| `back/src/runtime/` | Host executor (local/SSH) e ciclo de vida do runner | Regra de card |
| `back/src/store/` | Persistência JSON atômica | Regra de negócio |
| `back/src/auth/` | Contas, sessão e os preHandlers de acesso | Regra de board |
| `back/src/secrets/` | Cofre criptografado | Leitura de segredo para log ou resposta |
| `back/src/mcp/` | Servidor MCP e as ferramentas | Regra duplicada de service |
| `back/src/config/` | Leitura e validação das variáveis de ambiente (`env.ts`) | Regra de negócio |
| `back/src/utils/` | Operações técnicas e infraestrutura compartilhadas (logger, guardas do processo), sem regra de domínio (§4, "Utilitário × regra de negócio") | Regra de uma área; código que lê o store ou chama o host |
| `back/src/testkit/` | Infra de teste compartilhada | Testes |

**SOLID orienta como dividir responsabilidades reais**, sem pedir classe ou abstração nova: **S** — funções, componentes, hooks e serviços agrupam o que muda pelo mesmo motivo; **O** — variante real não exige espalhar mudanças; **L** — implementações do mesmo contrato preservam semântica, erros e invariantes (o host executor `local` e o `ssh`); **I** — tipos e interfaces coesos, de necessidades concretas; **D** — dependência externa ou instável (Docker, SSH, GitHub, SDK do Claude) isolada quando isso traz testabilidade ou proteção de fronteira.

**Teste mental, antes de entregar:** "um dev que nunca viu o módulo entende o fluxo lendo de cima para baixo, sem pular entre arquivos para descobrir o que um nome genérico faz?" Se não, simplifique, em vez de documentar a complexidade.

### Áreas: um nome nos dois pacotes

**A área de um código é a pasta de `back/src/services/<área>/` que o atende; o front dela mora em `front/src/features/<área>/`, com o mesmo nome.** As duas do front sem service homônimo são `auth` (no back, `back/src/auth/`) e `setup` (o assistente da primeira instalação).

- **Arquivo novo nasce na pasta da área dele**; a pasta do front que ainda não existe nasce no mesmo PR, com `components/`, `lib/` e `types/` (§5). **Teste mental:** "qual pasta de `back/src/services/` atende isto?" O nome dela é a pasta do front. Código do front sem service no back (tema, websocket) é técnico e vai para `front/src/lib/`.
- **`front/src/features/board/` guarda só o board:** colunas, card, projeto, seleção e deck. O resto nela (revisão e análise de PR, contas e uso, chat do SDK e medidor de contexto, cérebro, plugins, MCP, preview) é **legado à espera de mudança de pasta**, não exemplo; o nome diz a área (`board/lib/usage.ts` é de `accounts/`, `contextUsage.ts` de `sdk/`, `AnalysisConversation.tsx` de `review/`). O lint reprova todo arquivo novo nela, menos o teste ao lado de um arquivo que já existe (ele acompanha o testado quando este mudar de pasta); o que é de fato do board entra com o caminho exato em `APPROVED_BOARD_FILES` (`scripts/lint/lintChanged.mjs`), no mesmo PR, para o revisor julgar.
- **Mexeu num arquivo legado de outra área:** a mudança fica nele (mudar de pasta é PR próprio, só de `git mv` e imports, com pedido, §12.6); o arquivo **novo** que ela cria vai para a pasta da área, importando o legado de onde está.

### Utilitário × regra de negócio

**`back/src/utils/` e `front/src/lib/` guardam o técnico; quem decide é a camada de regra da área** (o service no back; o hook ou a função de `features/<área>/lib/` no front). Técnico são operações (texto, data, lista, stream, conversão de formato) e infraestrutura de toda área (logger, guardas do processo, cliente HTTP, websocket, tema, hooks genéricos como `useNow`), que pode ter efeito colateral.

- **Não conhece o domínio** (card, conta, sessão, review, permissão) nem decide se uma operação pode acontecer. Usa biblioteca, outro util, configuração e i18n; lê o relógio quando a operação é sobre o instante atual. Pode recusar entrada tecnicamente impossível (texto ausente numa função de texto); "este card pode ser movido" é regra.
- **A dependência vai só da área para a pasta compartilhada:** `utils/` e `lib/` não importam service, store, componente ou hook de área; quando chamar, com qual dado e o que fazer com o resultado fica na camada de regra.
- **Ser reutilizável não faz da função um util:** função com regra que duas áreas usam mora na área dona; sem dona, onde criar o lugar comum é decisão do usuário (§12). Montar URL, comando ou mensagem no formato de um terceiro (GitHub, Docker, CLI do Claude) é integração: mora no client ou service dela.
- **Teste mental:** "esta função pode ser copiada para outro repositório levando só bibliotecas, outros utils, configuração e i18n?" Se não, não é util.
- **Regra de domínio em `utils/` ou `lib/` que o PR toca** vai para a área dona no mesmo PR, com os imports, ou vira pendência deliberada com o motivo.

## 5. Frontend, React e TypeScript

1. **Export nomeado** em código novo; `export default` só onde um formato de terceiro exige (a story do Storybook, CSF), e os existentes não se convertem de carona (§12.6).
2. **Componente renderiza e compõe:** regra de domínio é função pura em `features/<área>/lib/*.ts`, com teste ao lado; orquestração com estado, hook `use*.ts`; chamada HTTP, o `api.ts` da feature.
3. Estado visual simples e handler sem regra ficam no componente, sem hook artificial.
4. **Contratos HTTP tipados só em `front/src/api/types.ts`**, espelhando o backend; tipo local de feature em `features/<área>/types/`, fora do componente.
5. Sem `any`, cast sem fundamento, estado impossível ou interface redundante.
6. `useMemo`, `useCallback` e `React.memo` só com cálculo custoso, identidade referencial relevante ou benefício demonstrável (§8).
7. Renderização a mais se resolve no fluxo, nunca suprimindo regra de hooks ou tirando dependência de efeito.
8. **Efeito e estado com papel único:** cada efeito sincroniza uma coisa; estado criado só para disparar outro código é fluxo errado.
9. Lógica de negócio e transformação complexa fora do JSX.
10. Valor derivado sai da fonte, sem estados sincronizados para o mesmo fato; dado do servidor fica no React Query, não copiado em `useState`.
11. Primitivas de `components/ui` (Radix + Tailwind) antes de versão nova.
12. Carregamento, vazio, erro, sucesso e envio duplicado tratados quando pertinentes.
13. Requisição sai de ação ou de efeito controlado, nunca da renderização.
14. Esconder ação na UI é experiência; quem autoriza é o backend.
15. **Toda mudança de layout passa por revisão de UI/UX com a tela renderizada**, inclusive bloco novo numa tela existente. Antes de entregar, veja a tela rodando (o app ou uma história do Storybook, na largura real) e confira: a hierarquia diz o que importa primeiro; o novo segue o visual dos vizinhos (cores, tamanhos, espaçamentos, primitivas de `components/ui`); texto longo quebra a linha, sem sumir nem cortar na horizontal, e rolagem só na vertical; vazio, carregando, erro e muitos itens continuam legíveis. O print vai no PR (§14, item 8); o que não ficou bom se corrige antes, não vira pendência.

| Pasta (front) | Guarda | Não guarda |
|---------------|--------|------------|
| `front/src/features/<área>/` | Tudo de uma área: `components/`, `lib/` (funções puras e hooks da área), `types/`, `api.ts`, testes ao lado; a regra de domínio da área, mesmo quando outra área também a usa (§4) | Código técnico usado por mais de uma área |
| `front/src/components/` | Componentes de mais de uma área; `ui/` = primitivas | Componente de uma área só |
| `front/src/lib/` | Cliente HTTP, websocket, tema, utilitários e hooks genéricos compartilhados, sem regra de domínio (§4) | Regra de uma área |
| `front/src/api/types.ts` | Contratos HTTP | Tipo local de componente |
| `front/src/providers/` | Providers da aplicação (auth, query) | Regra de feature |
| `front/src/i18n/` | Textos nos dois idiomas | Lógica |
| `front/src/types/` | Declarações de módulos de terceiros (`*.d.ts`) | Tipos de domínio |
| `front/src/test/` | Setup do Vitest e o helper `renderApp` | Testes de feature |

O código técnico sobe para a pasta compartilhada quando uma segunda área passa a usá-lo; a regra de domínio fica na área dona (§4).

## 6. Contratos, schemas e integrações

- Antes de mudar campo, tipo, payload, rota, ferramenta MCP, evento de websocket ou função consumida por outros arquivos, localizar **todos os consumidores**, inclusive o front, o runner e os scripts plantados nos containers.
- **Uma informação, um nome canônico**, sem formato paralelo "por segurança". Contrato **interno** que muda atualiza todos os consumidores na mesma alteração, sem `newField ?? oldField` nem shim.
- **Dado persistido é contrato externo:** cada instalação auto-hospedada tem seu `board.json` e afins; mudança de shape exige leitura compatível ou migração explícita e testada, nunca quebra silenciosa.
- Validar na entrada, no padrão do ponto de entrada: ferramenta MCP com **zod** no schema; rota HTTP chama a função do registry/service que valida e lança, e converte o erro de validação em 400 ("not found" em 404). Dentro do fluxo validado, confiar no tipo.
- **Erro de rota JSON tem uma forma só:** `{ error: "<mensagem>" }` com status 4xx ou 5xx. Fluxo de navegador em HTML (o login do OAuth) responde a página de erro.
- Entidade se compara e se referencia por **id**, nunca por nome, título ou texto, inclusive a que o código acabou de criar.
- Dado editável vive na sua fonte (configuração, cadastro, store); id, nome, lista ou código que muda não se congela no código.
- Dado composto (autor, motivo, origem, instante, referência) vai em campos próprios, não concatenado num texto.
- Enums e discriminantes (`as const` / union de literais) numa definição única, sem mapas paralelos. `switch` cobre todas as variantes; variante sem suporte falha visivelmente.
- Campo opcional novo fica ausente quando não informado, a menos que `null` seja estado de domínio explícito.
- Em atualização parcial, **campo não enviado** é diferente de campo enviado com `0`, `false`, `""` ou `null`.

### Integrações externas: a documentação oficial é o contrato

SDK e CLI do Claude, GitHub, Docker e afins seguem a **documentação oficial do fornecedor e o comportamento da versão instalada** (método, campos, eventos, códigos de saída, fluxo); log de campo, tentativa e erro ou "funcionou no teste" não a substituem.

- **Ler antes de mexer:** antes de criar ou alterar uma chamada externa, abrir a docs (ou o pacote da versão instalada, quando ela não cobre) e citar a fonte no PR; no código, comentário de uma linha só quando a regra não é óbvia (§3).
- **Mudança de versão exige conferir o comportamento real**, não a memória.
- **Fato, não hipótese:** diagnóstico de integração afirma só o que log, docs, binário ou teste mostram. Hipótese é dita como hipótese, testada antes de virar correção, e nunca vira regra de código nem texto de tela.
- **Evento, flag ou campo que a docs não lista** (mesmo que "apareça no stream") fica de fora: vale o caminho que a docs define. Sem definição, o comportamento observado é registrado como evidência, com versão, data e fonte, tratado como incerto, e vira pergunta.
- **Exercitar antes do merge:** integração nova ou alterada roda de verdade, na versão instalada e pelo caminho do usuário (o card, o runner, a rota); o teste com fake prova a lógica, não a integração. O que não deu para exercitar é pendência que bloqueia (§14, "A pendência deliberada é julgada"), com o passo que a fecha.

## 7. Dados, fonte de verdade e consistência

- Cada conceito tem uma **fonte de verdade identificável**. Valor obtível da fonte não se persiste em cópia, nem as duas direções do mesmo relacionamento. Snapshot ou materialização só como exceção explícita, com motivo, origem e regra de atualização definidos.
- Estado JSON em `VIBEHUB_DATA_DIR` (`board.json` e afins) passa pelo **store** (`back/src/store/`: `JsonStore`, `writeFileAtomic`). Gravação fora dele é exceção intencional, com o porquê no commit, declarada no PR, e continua atômica ou serializada por card.
- **Leitura não grava**, nem para sincronizar cálculos.
- O que pode rodar em paralelo ou repetir (hooks de status, retomada após deploy, deliver, provisionamento) é **idempotente** e seguro em corrida: vários cards dividem o runner e, em deploy blue/green, dois backends convivem por um tempo.
- Migração, limpeza ou exclusão de dados reais (worktrees, transcripts, volumes, containers) só com avaliação, `dry-run` quando aplicável e autorização.
- Escrita, campo ou leitura sem consumidor só sai depois de verificar quem lê.

## 8. Performance e eficiência

**Menos trabalho real, não código mais curto.** Runner, backend e os containers de todos os cards dividem um servidor só: o que um card desperdiça, os outros pagam.

### Runner e host

- `docker exec`/SSH é caro: comandos do mesmo passo vão num script só, e item de lista nunca abre execução remota própria. `docker exec` e round trip ao host se contam separados: um `runScript` com três `docker exec` é uma viagem e três processos no runner.
- Processo de longa duração (driver do SDK, terminal, preview) tem dono e fim: quem abre fecha; órfão é bug.
- **Prazo de trabalho no container vale dentro do container:** o timeout do Node mata só o cliente local (`bash -s`, `ssh`, `docker exec`), e o processo lá dentro segue vivo. Script com prazo entra sob `timeout -s KILL`, que mata o grupo inteiro antes de o Node desistir (`containerScriptCommand`, em `runtime/host.ts`).
- **O runner existente nunca é recriado pelo código** (derruba as sessões de todos os cards). Mudança que pede container novo (flag de `docker run`, imagem) vale só para o container criado depois; trocar o existente é decisão do operador, numa janela agendada, dita nos Impactos do PR.
- Saída grande (log, transcript, diff) é lida em fluxo ou recortada na origem, nunca inteira na memória do backend.

### Backend e estado

- Operação em lote, não releitura ou regravação do estado inteiro por item; o store reescreve o arquivo todo a cada gravação, então as mudanças de um passo vão numa só.
- Código que roda a cada evento sobre coleção que cresce (cards, mensagens, linhas de transcript) trabalha só sobre o que mudou.
- Menos passagens repetidas em listas e cálculo invariante fora do laço, sem dificultar a leitura do algoritmo.

### Websocket e rede

- Emitir só o que mudou e só para quem pode ver; evento faltando se corrige, sem polling para mascará-lo.
- O que o cliente precisa ao reconectar (estado de sessão, aviso ativo) é reenviado no attach, não reconstruído por replay de histórico.

### Frontend

- React Query como fonte, com chave estável e invalidação dirigida, sem fetch redundante nem `refetch` geral.
- Estado no nível mais baixo que o usa; lista longa (chat, log, board grande) não re-renderiza inteira a cada item novo.
- Dependência pesada fora do caminho inicial (highlighter, terminal, editor) carrega sob demanda.
- Paginar ou virtualizar só quando a escala justificar.

### Como provar

- Cache, deduplicação e batch só por benefício concreto, com invalidação e ciclo de vida definidos; saem quando não agregam valor.
- **PR que promete ganho de performance traz a medição** (antes e depois: tempo, número de `docker exec`, renders, bytes enviados) e o modo de reproduzir; sem ela, o ganho é hipótese (§6) e o PR diz isso.
- **Teste mental:** "com 20 cards ativos e mil mensagens no histórico, quantas vezes este código roda e quanto lê em cada vez?" Se cresce com o total, e não com a mudança, o desenho está errado.

## 9. Validação, erros e fallback

- Validar **nas fronteiras** (HTTP, websocket, hooks do runner, ferramentas MCP, entrada de CLI, respostas de integrações), no padrão de cada uma (§6).
- **Guard impõe contrato; fallback mascara erro.** Campo obrigatório ausente vira erro observável, não `""`, `0`, `null` ou `[]`. `??`, `||` e `?.` só quando a ausência é do contrato; `0` e `false` podem ser valores válidos.
- **Dependência ausente falha à vista:** chamada sem destino (sessão, conexão, ouvinte) gera erro ou é impedida pelo tipo, nunca vira no-op silencioso.
- Erro informa o bastante para diagnóstico, sem expor token, segredo ou caminho sensível.
- Integração que falhou não aparece como concluída nem retorna sucesso falso: falha de login, de runner ou de integração vira aviso visível ao usuário com a ação que resolve. Retry só limitado e idempotente, nunca `setTimeout`/retry escondendo falha de fluxo.
- **O erro chega a quem chamou, não só ao log:** propagado até a fronteira responsável ou traduzido para o chamador (exceção com mensagem própria, resposta HTTP de erro, evento de erro no websocket). O log do pino é trilha de diagnóstico e auditoria (`audit: true`) de quem opera a instalação, não substituto disso.
- **Engolir o erro só em melhor esforço:** `catch` vazio em qualquer forma (`.catch(() => {})`, `.catch(() => undefined)`, `try { … } catch { }`) só em efeito colateral cuja falha não muda o resultado e que outro caminho cobre (aviso em tempo real que o próximo attach reenvia, limpeza que a próxima rodada refaz, gatilho antecipado de algo também agendado), com `// eslint-disable-next-line no-restricted-syntax -- <motivo>` na linha anterior, igual nas duas formas (comentário dentro do bloco não o torna menos vazio), e a história no commit e no PR. Falha que o chamador precisa saber nunca é engolida.
- **Fila de promises não engole:** em `queue = next.catch(() => undefined); return next;`, o erro chega a quem chamou pelo `next` e o `catch` só impede que a falha de um item trave os seguintes. É o padrão das filas por card e do store, sem justificativa. O lint reconhece a fila pelo nome (atribuição a `queue` ou `this.queue`; encadeamento `previous.catch(...).then(run)` ou com `queue`); com outro nome, leva a diretiva com o motivo.
- **Tarefa de fundo sem chamador** (timer, reaper, retomada após deploy, rotina disparada sem esperar resposta): `catch` que **altera o estado que decide o próximo passo, em relação ao que a tarefa faria sem o erro** (a marca da próxima tentativa, um contador de falhas, a parada da tarefa, o aviso ao card) não é engolir, se esse caminho tem teste cujo nome diz o que acontece. Tentar de novo só porque o timer bate não conta: `catch` vazio ou que só loga é engolir, e `void tarefa()` sem `catch` também (a falha só vira log no handler global); tarefa de fundo nova segue esta regra com ou sem `catch` escrito.
- `catch` vazio antigo fora do diff fica como está.

## 10. Segurança, autorização e escopo

- **Acesso decidido pelos preHandlers de `back/src/auth/`:** o que é da INSTALAÇÃO exige dono (`requireOwner`, em `session.ts`); o TRABALHO de um card segue o compartilhamento (`access.ts`): `requireCardAccess` para ler, `requireCardWork` para mudar qualquer coisa; rota do próprio usuário, sem card (`/api/me/*`, listagens), exige só sessão (`requireSession`). Toda rota nova usa um desses; filtro por usuário no handler (o que ele alcança, se é dono) só restringe o que o helper liberou.
- **Acesso é decidido na borda:** service recebe fatos apurados (o card, o usuário, um booleano de comportamento), sem refazer a checagem nem conhecer o preHandler.
- Leitura (`view`) nunca autoriza mutação. Listagem filtra pelo que o usuário alcança, não pelo que existe.
- **Recurso que o chamador não alcança responde 404, não 403:** para quem não vê o card ou o projeto, ele não existe, e um 403 confirmaria que o id é real. 403 é para o que ele vê mas não pode mudar (o `view` tentando mutar, o membro numa rota de dono).
- **Shell:** tudo que vira linha de `docker exec` ou script (ids de card, branch, sessão, container) é validado na fronteira e citado depois; leia `back/src/runtime/host.ts` antes de montar um comando.
- **Segredos por stdin, nunca argv** (`ps` é legível por todos). Credenciais moram no cofre criptografado (`back/src/secrets/`), nunca em log, resposta HTTP ou mensagem de erro.
- **O agente no runner entra pela assinatura Claude do perfil do card** (o token de longa duração ou um `/login` mais novo), nunca por chave de API: `ANTHROPIC_API_KEY` no ambiente do agente venceria a assinatura e cobraria a API, por isso o driver do chat nativo a remove antes de abrir o CLI (`services/sdk/driver.ts`) e nenhum código a planta no runner.
- **Identidade git é do card:** commit, push e PR saem com a conta de quem deu a ordem, nunca de terceiros ou da organização, nem por outra credencial.
- Hooks do runner, MCP e websocket têm limite de confiança próprio (token do runner, sessão) e não presumem o HTTP autenticado. Ponto de entrada de máquina (o callback de status do runner) autentica pelo token do serviço comparado em tempo constante (`tokenMatches`, em `auth/session.ts`), nunca por cookie de sessão.
- Verificar caminhos permitidos e negados, inclusive chamando a API direto.

## 11. Testes e critérios de correção

- **Mudança de comportamento ou bug é sempre em TDD:** o teste vem primeiro e é visto falhar pelo motivo certo (em bug, reproduzindo o erro que aconteceu); só então se implementa até passar.
- **O verde só vale se o teste falha sem a correção:** depois do verde, tire só a correção (de uma cópia de backup do arquivo, nunca `git stash`), rode e exija a falha pelo motivo certo; recoloque e veja passar. Rode o arquivo mais de uma vez: teste que alterna entre passar e falhar é defeito do teste até prova em contrário.
- Testes proporcionais ao risco, em **Vitest** nos dois pacotes, ao lado do código (`*.test.ts` / `*.test.tsx`): o fluxo real primeiro, o unitário para isolar regra complexa.
- **Teste é código:** toda regra deste arquivo vale nas linhas de teste (nomes, `const`, comentários, lugar, duplicação, erros).
- **Antes do primeiro helper de teste, procure a infraestrutura que já existe, nesta ordem:**
  1. **o repositório:** `ls back/src/testkit/` (infra compartilhada do back); no front, Vitest + Testing Library + jsdom (`front/vitest.config.ts`, helper `renderApp` em `front/src/test/render.tsx`);
  2. **o Vitest:** `onTestFinished` para desfazer o que o teste criou, `vi.waitFor` para esperar uma condição, `it.each`/`describe.each` para casos que só mudam os dados, `vi.useFakeTimers` para tempo;
  3. **o Node:** `existsSync` para saber se um caminho existe, `mkdtempSync` para diretório temporário.

  Nada disso cobre: o helper que serve a um arquivo só nasce nele; o que dois arquivos de teste precisam (um docker falso, um repositório git temporário) nasce em `back/src/testkit/` e é importado, nunca copiado.
- Dado de teste sai do fluxo real ou de fábrica fiel ao contrato, com o shape de produção; o resultado esperado sai do contrato real, lido antes, não da hipótese do autor.
- Mock só nas **fronteiras externas** (host executor Docker/SSH, rede, GitHub, SDK do Claude); a lógica interna roda de verdade, mesmo quando mocká-la facilitaria a asserção.
- Rota HTTP se testa pela rota real, com validação e acesso (dono, `work`, `view`, sem acesso).
- Verificar efeitos observáveis: estado persistido, script enviado ao host, payload emitido, UI atualizada, erro esperado.
- No front, testar interação, carregamento/erro/sucesso e o contrato enviado/recebido; em tela com debounce, cache ou espera, repetir a mesma ação exige esperar o estado assentar.
- Cobrir caminho principal, falhas e bordas; somar corrida, idempotência e retomada quando fazem parte do risco.

**Rodar testes no runner: curto, só do que você tocou.** A suíte inteira leva muitos minutos, disputa CPU com os outros cards e costuma ser morta por um deploy.

1. **Enquanto trabalha:** só o arquivo do que mexeu, filtrado pelo caso: `cd back && npx vitest run <arquivo> -t "<caso>"` (idem em `front/`).
2. **Antes de entregar:** `npm run lint:changed` e `npm run test:changed` (raiz) e o typecheck do pacote tocado, o mesmo do CI:
   - **front:** `npx tsc -b`. O `tsconfig.json` é uma solution com project references: `tsc --noEmit -p` não checa nada e dá verde falso.
   - **back:** `npx tsc --noEmit` (`tsc -b` emitiria JS em `back/dist`). O `tsconfig.json` do back exclui `*.test.ts`: erro de tipo em teste só aparece ao rodar o teste.
3. **Nunca** `npm test` ou `npx vitest run` sem filtro no runner: a suíte inteira é do CI (`gh pr checks <N>`). A exceção é `npm run test:lint`, a suíte pequena do lint da raiz (`eslint.config.js` e `scripts/`), inteira quando o PR mexe nela; o `test:changed` não a roda, só o CI.
4. Teste de tempo (limite em ms) que falha de vez em quando sob carga não é regressão sua: confirme rodando sem a sua mudança; se já era instável, diga no PR e siga.

Comando de teste que passaria de ~2 min vira recorte menor; o que ainda passa de ~1 min roda destacado do terminal (`setsid nohup sh -c '<comando> > /tmp/<log> 2>&1' &`, e o log se lê depois) se a instalação faz deploy reiniciando o servidor, que mata o terminal e o que roda nele. O que não deu para testar se relata: **o que foi e o que não foi validado**.

## 12. Processo obrigatório de trabalho do agente

**Entender e fechar o caminho com o usuário antes de escrever código:**

- **Teve dúvida, pergunta** ("Como perguntar ao usuário", abaixo): requisito ambíguo, mais de um caminho razoável ou decisão do usuário, antes de implementar, em vez de convenção inventada ou resposta presumida.
- **Explorar antes de construir:** feature nova ou mudança de comportamento com alternativas passa por brainstorming (requisitos, abordagens com prós e contras, recomendação) e só se executa com o caminho aprovado.
- **Processo em toda tarefa**, sem esperar ser mandado: debugging sistemático antes de propor fix, TDD, plano escrito para tarefa de várias etapas, verificação antes de declarar pronto, revisão do diff. A ferramenta de cada etapa é definida por agente (no Claude Code, o mapa de skills do `.claude/CLAUDE.md`).
- **Pedido de diagnóstico é leitura e explicação**, não edição.
- **Discordar com fundamento faz parte do trabalho:** pedido que parece pior que uma alternativa vira pergunta, com a alternativa recomendada e o pedido original como opções, cada uma com a sua consequência.

1. **Inspecionar antes de editar:** arquivos, fluxo, fonte de verdade, contratos, padrões e testes relevantes.
2. **Localizar consumidores:** chamadas, imports, rotas, ferramentas MCP, scripts do runner e telas impactadas.
3. **Definir escopo:** a menor alteração que resolva **o problema completo**.
4. **Implementar de ponta a ponta:** consumidores, contratos, validação, acesso, i18n e testes na mesma entrega.
5. **Auditar o trecho tocado:** nomes, `let`, comentário fora das exceções, código morto, duplicação, fallback indevido, leituras e execuções inúteis.
6. **Não espalhar alterações:** problema vizinho que exige refatoração arriscada é comunicado, não corrigido de carona.
7. **Validar:** lint, testes do recorte, typecheck e build quando aplicável, e revisar o diff (§11, comandos abaixo). O lint checa só o que a máquina consegue: as regras de `eslint.config.js` nas linhas novas, e, desde a base, o markdown fora do lugar (§15), o arquivo novo em `front/src/features/board/` (§4), o nome de arquivo novo em `back/src` e `front/src` (§2) e o emoji do título de cada commit da branch (§14). Verde não é conformidade; o resto deste arquivo é o passo 5 e a revisão do passo 8.
8. **Revisão independente antes de entregar:** o diff passa, nesta ordem, por **simplificação** (aplicada) e por **code review** (correção, performance, aderência às regras e o que foi inventado), ambas por revisores SEM o contexto de quem escreveu, com a entrada de "Como revisar um PR" (§14). Cada achado confirmado segue a sua severidade (§14, "As severidades"); o descartado tem o motivo dito. O que a simplificação mudar volta pelo passo 7 antes do code review.
9. **Descrever o resultado:** o que mudou, o que foi verificado e as limitações reais ("Como relatar", abaixo); PR segue a §14.

### Autonomia corretiva e preservação do escopo

Decisão de produto, mudança de escopo, funcionalidade nova, mudança de comportamento intencional e tudo de intenção pouco clara pedem autorização e brainstorming. A exceção: **o agente corrige sozinho problema real naquilo que já foi definido, pedido ou implementado** — bug e erro de lógica; código que contradiz regra ou decisão definida; regressão do desenvolvimento; comportamento que contraria claramente o requisito; falha de integração, validação ou consistência; ajuste técnico para o que existe funcionar.

**Limites:** a autonomia preserva e corrige o definido, não amplia escopo nem redefine o projeto. Ficam de fora: funcionalidade extra "porque parece útil"; decisão intencional, fluxo estabelecido ou regra de negócio mudados por preferência técnica; remover ou simplificar o que não se entende. Melhoria fora do código que o PR escreve, refatoração e o que foge do propósito viram **sugestão** (dentro do que o PR escreveu, é o "deveria corrigir" da §14). Correção que exige decidir intenção ou direção vira pergunta.

**Operações de risco:** exclusão de dados (worktree, volume, dado de `VIBEHUB_DATA_DIR`), mudança incompatível de contrato persistido, alteração de acesso, reescrita de histórico enviado (amend, rebase ou force-push de commit publicado), deploy e merge exigem as autorizações existentes. **Merge na branch que publica é deploy** (no vibehub, a `main`). Antes de agir, exponha os riscos e siga só com o aval do usuário, marcando a gravidade: 🚨 grande ou irreversível, ⚠️ médio ou pequeno.

### Comandos do repositório

| Comando | Uso |
|---------|-----|
| `npm run install:all` | Instala a raiz (o lint), `back/` e `front/` |
| `npm --prefix back run dev` · `npm --prefix front run dev` | Backend (tsx watch) e frontend (Vite) em dev |
| `npm run lint:changed` · `npm run test:changed` | Lint do que a branch acrescentou (§12, passo 7) e testes afetados por ela, desde a base (`$VIBEHUB_BASE_REF`, padrão `origin/main`): o recorte que se roda antes de entregar (o lint roda também no CI) |
| `npm run build` | Build de back + front |
| `npm --prefix front run storybook` | Storybook dos componentes |

Teste do recorte, typecheck, `test:lint` e `gh pr checks`: §11. Exercitar o runner de ponta a ponta fora de um card exige Docker local; os testes unitários usam um host executor falso.

**Testar pela tela sem tocar em produção:** back isolado (`VIBEHUB_PORT=<porta livre> VIBEHUB_DATA_DIR=/tmp/vh-test npx tsx src/index.ts` em `back/`) e front apontando para ele (`VIBEHUB_BACKEND=http://127.0.0.1:<porta> npx vite --port <outra>` em `front/`).

### Como perguntar ao usuário

Dúvida que trava a execução e discordância com o pedido viram pergunta de **múltipla escolha com saída livre**.

- **Uma decisão por pergunta;** independentes podem ir juntas, cada uma na sua; a que depende da resposta de outra espera.
- **A pergunta se entende sozinha:** o que foi encontrado, por que a decisão importa e o item em questão (a tela, o campo, a regra) nomeado, sem "isso" nem "aquilo" soltos.
- **De 2 a 4 opções, uma excluindo a outra**, cada uma com rótulo curto e a consequência (o que muda, o custo, o risco). Opção vaga ("depende", "ver depois") não conta.
- **A recomendada vem primeiro**, marcada, com o motivo; sem recomendação, diga por que as opções empatam.
- **Sempre há saída livre** ("Outra: descreva"). Pergunta estruturada quando a ferramenta tem; sem ela, opções numeradas e a saída livre por último.
- **Descubra o que dá para descobrir:** o que código, documentação ou este arquivo respondem, o agente descobre e informa; a pergunta fica para a decisão do usuário.

### Como relatar

Vale para todo relatório: o resultado ao usuário, o de um subagente e os achados de uma revisão. **O leitor é programador e não abriu o código**: conhece a stack, mas não este módulo, este bug nem os nomes que você aprendeu no trabalho. Primeiro o carro, depois a peça.

- **Contexto antes do achado:** o que foi pedido ou analisado e onde aparece para quem usa o vibehub (a tela, o botão, o card, a entrega); só então o achado.
- **Todo nome interno se apresenta** na primeira vez, em palavras do dia a dia: "`reopenAfterHeadMoved` (a rotina que reabre a revisão quando o autor empurra commit novo)". Vale para função, arquivo, campo, rota, apelido do código, sigla e termo de domínio.
- **Cenário em passos que alguém de fora segue:** quem fez o quê, o que a tela ou o sistema mostrou e o que deveria ter mostrado; o `arquivo:linha` é a evidência no fim do item, não a explicação.
- **Layout de bater o olho:** veredito ou resultado na primeira linha; uma seção (`###`) por assunto; listas curtas, uma ideia por item; termos técnicos em `código`.
- **Teste:** quem lê só o relatório explica o problema e a solução a um terceiro, sem abrir o código? Se não, reescreva.

## 13. Encerramento

**Regra de encerramento:** código que funciona mas carrega conceitos, estados, leituras, arquivos ou indireções desnecessários se simplifica **antes de entregar**, preservando correção, integridade, segurança e testes.

## 14. Pull Requests

Todo PR é documentação: quem nunca viu o código entende a mudança e o porquê dela só pelo PR. Três partes obrigatórias: a **descrição**, a **conformidade com este AGENTS.md** e os **comentários no diff**. A conformidade vale para **todo PR, sem exceção** (qualquer tamanho e autor, inclusive correção de review e mudança só de documentação); PR sem ela volta do revisor antes de ele ler o diff.

**Título** em conventional commits, sem emoji: tipo em inglês (`fix`, `feat`, `docs`, `refactor`, `perf`, `test`) e descrição em pt-BR, `tipo(area): o que muda`, legível como o título de commit ("Commits", abaixo).

### Descrição

Em pt-BR, markdown, com estas seções (`##`) nesta ordem, profundidade proporcional à mudança, cada seção dizendo só o que é dela. Seção que não se aplica leva uma linha, "Não se aplica: <motivo>", exceto a 9 e a 10, sempre preenchidas.

1. **Contexto**: onde a mudança se encaixa e por que existe.
2. **Problema identificado**: o que estava errado ou faltando; em bug, a cadeia inteira: a condição, o comportamento incorreto, a **causa raiz** e o comportamento depois.
3. **Objetivo**: o que o PR pretende alcançar.
4. **Solução implementada**: a mudança como um todo, não a lista de arquivos, cada decisão com as alternativas consideradas. Mudança de fluxo ou estrutura abre com um **desenho curto** (árvore de arquivos, de chamadas ou de componentes, Mermaid, ou bloco `diff` do fluxo).
5. **Detalhamento técnico**: fluxos, componentes, services, eventos de websocket, ferramentas MCP, scripts do runner e regras envolvidas.
6. **Comportamento esperado**: o sistema depois da mudança, com cenários e exceções.
7. **Impactos**: o que muda, quando tudo dá certo, para outras áreas, usuários, dados persistidos, contratos e **performance** (o que roda a mais ou a menos), e o que o deploy exige (migração, configuração, reinício de runner).
8. **Testes e validações**: o **executado** (comando e resultado), separado do só **recomendado** e do que não deu para testar. Mudança de comportamento traz a prova **antes e depois**: o teste que falhava sem a mudança e passa com ela (nome e falha observada) e, se visual, o print antes e depois; tela que ninguém viu rodando é pendência que bloqueia, como integração não exercitada (§6). Performance traz a medição (§8). Documentação e configuração não têm teste vermelho e dizem isso. CI verde, sem warning novo.
9. **Pontos de atenção**: riscos do merge, limitações conhecidas, pendências deliberadas com o motivo e onde olhar com cuidado. Abre com duas respostas curtas:
   - **o merge tem volta?** Mão dupla quando reverter o commit desfaz tudo; mão única com dado migrado ou apagado, contrato publicado ou outro efeito que o revert não desfaz;
   - **até onde vai o estrago se der errado?** Quem e o que pode quebrar: telas, cards em andamento, runner, dados das instalações, consumidores da API.
10. **Conformidade com o AGENTS.md**: para **cada seção deste arquivo cujas regras se aplicam às linhas alteradas**, a regra, como foi cumprida e, quando der, o `arquivo:linha`. Ausência (sem comentário, sem `let`, nenhum `docker exec` a mais) se prova com o comando e o resultado: `grep` no diff para o que está no texto; para o que acontece ao rodar (`docker exec`, leitura, render), a contagem ou medição antes e depois (§8), porque chamada nova a função existente não aparece no `grep`. Regra não seguida: qual, onde e por quê, como pendência deliberada. Frase genérica ("segue o AGENTS.md") não vale.

Causa, teste e justificativa só os reais; o não confirmado é dito como não confirmado.

**O PR acompanha o código:** a cada push (correção, commit novo, merge da base), releia o PR publicado inteiro; número, `arquivo:linha` ou afirmação que o push tornou falsa se corrige no mesmo push, na descrição e, no comentário do diff, com resposta na thread dele.

### Comentários no diff

Nas linhas do diff, publicados juntos numa **única revisão do tipo `COMMENT`**: **um por bloco de lógica relevante** (regra ou condição de fluxo; função ou componente novo; integração; transformação de dados; erro ou exceção; persistência; acesso; evento de websocket ou ferramenta MCP; refatoração que muda responsabilidade; trecho que afeta outra área), dispensando linhas mecânicas. Cada um diz, específico ao trecho, o que mudou, por que, como funciona, o impacto e as regras envolvidas; frase vaga ("adicionada validação", "ajuste no fluxo", "melhorada a lógica") não serve.

### Como publicar

Num card do vibehub, a entrega é o `vibehub_deliver` (`.claude/CLAUDE.md`, "Entrega"). Fora do runner, com o `gh` autenticado, grave `pr-body.md` e `review.json` em **UTF-8** e **fora do repositório** e:

1. Abra o PR com título e corpo explícitos (`--fill` poria a lista de commits como descrição):
   `gh pr create --base <base> --title "<tipo(area): ...>" --body-file pr-body.md`
2. Publique os comentários do diff numa revisão: `gh api repos/<owner>/<repo>/pulls/<numero>/reviews --method POST --input review.json`, com

   ```json
   { "commit_id": "<sha do último commit enviado>", "event": "COMMENT",
     "body": "O que cada bloco desta mudança faz, por que mudou e o impacto.",
     "comments": [{ "path": "back/src/caminho/arquivo.ts", "line": 42, "side": "RIGHT", "body": "O que mudou, por que, como funciona, impacto e regras." }] }
   ```

   `line` é a linha no arquivo, dentro do diff; `side` `"RIGHT"` é a versão nova, `"LEFT"` a linha removida; bloco de várias linhas leva também `start_line` e `start_side`.
3. **Confira:** a revisão `COMMENTED` e com o número de comentários enviado (`gh api .../pulls/<numero>/reviews --jq '.[] | {id, state}'` e `gh api .../reviews/<id>/comments --jq 'length'`). Falha no meio pode deixar um rascunho `PENDING` que bloqueia a próxima publicação: apague-o (`gh api .../reviews/<id> --method DELETE`) e publique de novo.

### Commits

Todo commit, de pessoa ou de agente, segue o **Gitmoji**; a tabela abaixo é a referência oficial, e emoji novo entra nela por PR antes de ser usado. **Uma alteração lógica por commit**, feito ao fechar cada etapa, não um commit único no fim.

```text
🐛 fix(sdk): login novo vale mesmo com tarefa em segundo plano

Quando o OAuth do CLI morria, o driver não reabria o CLI enquanto
houvesse tarefa em segundo plano viva, e o /login novo nunca entrava
em vigor. Agora a falha de login libera a reabertura no próximo turno;
com login saudável a tarefa em segundo plano continua protegida.
```

- **`<emoji> <tipo>(<area>): <título>`:** um emoji da tabela, o da intenção principal; tipo em inglês e área, os mesmos do título do PR (que não leva emoji).
- **Título** em pt-BR, curto, com o verbo da ação, para o leitor de "Como relatar" (§12): o que muda para quem usa o vibehub (a tela, o botão, o card, a entrega) ou, em mudança interna, o efeito dela, em palavras do dia a dia. Vocabulário interno (arquivo, função, campo, rota, apelidos do código como "gate", "cabeça", "órfão", "só-merge") fica na descrição. Um assunto por título: dois ligados por "e" são dois commits. **Teste:** lido sozinho numa lista de commits, alguém de fora conta o que foi feito? Se não, reescreva.
- **Descrição** em pt-BR, complementando o título: o que foi feito, por que (em bug, a causa), como, a alternativa descartada, o problema resolvido e os impactos, com os nomes internos explicados. "ajustes", "correções", "melhorias" não são descrição; teste que não rodou não se afirma. Só o título basta apenas em commit mecânico (rename que não muda contrato, formatação).

| Em vez de | Escreva |
|-----------|---------|
| `🐛 fix(review): gate da análise preso à cabeça que a análise entregou, e "rodar de novo" sem corrida` | `🐛 fix(review): botão Mergear da análise só mergeia o commit que foi analisado` (e o "rodar de novo" num commit próprio) |
| `🗃️ feat(review): analyses.json guarda o veredito do gate do merge por commit analisado` | `🗃️ feat(review): análise de PR guarda se os testes passaram em cada commit analisado` |
| `✅ test(review): gate da análise órfão de um deploy roda de novo` | `✅ test(review): testes do merge interrompidos por um deploy voltam a rodar` |

- **Merge commit também leva emoji:** `🔀 merge: ...`, sem área, via `--subject` no `gh pr merge` (o padrão da ferramenta sai sem emoji).
- **Mensagem e PR divergem: vale o PR.** Mensagem enviada não se reescreve (operação de risco, §12): o que faltou vai para o PR.
- `💡` só para as exceções da §3 e para corrigir o comentário antigo que a mudança tornou falso; `🦖` só com a decisão explícita de compatibilidade da §6. `✏️` só corrige digitação: trocar palavra que muda o sentido, num identificador ou nome de teste sem mudar comportamento, é `♻️`; num comentário que ficou falso, `💡`.

| Emoji | Código | Quando usar |
|---|---|---|
| 🎨 | `:art:` | Melhora a estrutura ou o formato do código |
| ⚡️ | `:zap:` | Melhora a performance |
| 🔥 | `:fire:` | Remove código ou arquivos |
| 🐛 | `:bug:` | Corrige um bug |
| 🚑️ | `:ambulance:` | Correção crítica urgente (hotfix) |
| ✨ | `:sparkles:` | Introduz funcionalidade nova |
| 📝 | `:memo:` | Adiciona ou atualiza documentação |
| 🚀 | `:rocket:` | Faz deploy |
| 💄 | `:lipstick:` | Adiciona ou atualiza a interface e os arquivos de estilo |
| ✅ | `:white_check_mark:` | Adiciona, atualiza ou faz passar testes |
| 🔒️ | `:lock:` | Corrige problema de segurança ou de privacidade |
| 🔐 | `:closed_lock_with_key:` | Adiciona ou atualiza segredos |
| 🔖 | `:bookmark:` | Tag de release ou de versão |
| 🚨 | `:rotating_light:` | Corrige avisos do compilador ou do linter |
| 🚧 | `:construction:` | Trabalho em andamento |
| 💚 | `:green_heart:` | Corrige o build do CI |
| ⬇️ | `:arrow_down:` | Rebaixa a versão de dependências |
| ⬆️ | `:arrow_up:` | Atualiza a versão de dependências |
| 📌 | `:pushpin:` | Fixa dependências em versões específicas |
| 👷 | `:construction_worker:` | Adiciona ou atualiza o sistema de build do CI |
| 📈 | `:chart_with_upwards_trend:` | Adiciona ou atualiza código de análise ou rastreamento |
| ♻️ | `:recycle:` | Refatora código |
| ➕ | `:heavy_plus_sign:` | Adiciona uma dependência |
| ➖ | `:heavy_minus_sign:` | Remove uma dependência |
| 🔧 | `:wrench:` | Adiciona ou atualiza arquivos de configuração |
| 🔨 | `:hammer:` | Adiciona ou atualiza scripts de desenvolvimento |
| 🌐 | `:globe_with_meridians:` | Internacionalização e localização |
| ✏️ | `:pencil2:` | Corrige erros de digitação |
| ⏪️ | `:rewind:` | Reverte mudanças |
| 🔀 | `:twisted_rightwards_arrows:` | Faz merge de branches |
| 📦️ | `:package:` | Adiciona ou atualiza arquivos compilados ou pacotes |
| 👽️ | `:alien:` | Atualiza código por causa de mudança em API externa |
| 🚚 | `:truck:` | Move ou renomeia recursos (arquivos, caminhos, rotas) |
| 📄 | `:page_facing_up:` | Adiciona ou atualiza a licença |
| 💥 | `:boom:` | Introduz mudança incompatível (breaking change) |
| 🍱 | `:bento:` | Adiciona ou atualiza assets |
| ♿️ | `:wheelchair:` | Melhora a acessibilidade |
| 💡 | `:bulb:` | Adiciona ou atualiza comentários no código-fonte |
| 💬 | `:speech_balloon:` | Adiciona ou atualiza textos e literais |
| 🗃️ | `:card_file_box:` | Faz mudanças relacionadas a dados persistidos |
| 🔊 | `:loud_sound:` | Adiciona ou atualiza logs |
| 🔇 | `:mute:` | Remove logs |
| 👥 | `:busts_in_silhouette:` | Adiciona ou atualiza contribuidores |
| 🚸 | `:children_crossing:` | Melhora a experiência do usuário ou a usabilidade |
| 🏗️ | `:building_construction:` | Faz mudanças de arquitetura |
| 📱 | `:iphone:` | Trabalha no design responsivo |
| 🤡 | `:clown_face:` | Cria mocks |
| 🙈 | `:see_no_evil:` | Adiciona ou atualiza um arquivo .gitignore |
| 📸 | `:camera_flash:` | Adiciona ou atualiza snapshots |
| ⚗️ | `:alembic:` | Faz experimentos |
| 🏷️ | `:label:` | Adiciona ou atualiza tipos |
| 🌱 | `:seedling:` | Adiciona ou atualiza arquivos de seed |
| 🚩 | `:triangular_flag_on_post:` | Adiciona, atualiza ou remove feature flags |
| 🥅 | `:goal_net:` | Captura erros |
| 💫 | `:dizzy:` | Adiciona ou atualiza animações e transições |
| 🗑️ | `:wastebasket:` | Marca como obsoleto código que precisa ser limpo |
| 🛂 | `:passport_control:` | Trabalha em código de autorização e acesso |
| 🩹 | `:adhesive_bandage:` | Correção simples de um problema não crítico |
| 🧐 | `:monocle_face:` | Exploração ou inspeção de dados |
| ⚰️ | `:coffin:` | Remove código morto |
| 🧪 | `:test_tube:` | Adiciona um teste que falha |
| 👔 | `:necktie:` | Adiciona ou atualiza regra de negócio |
| 🩺 | `:stethoscope:` | Adiciona ou atualiza healthcheck |
| 🧱 | `:bricks:` | Mudanças de infraestrutura |
| 🧑‍💻 | `:technologist:` | Melhora a experiência de quem desenvolve |
| 🧵 | `:thread:` | Adiciona ou atualiza código de multithreading ou concorrência |
| 🦺 | `:safety_vest:` | Adiciona ou atualiza código de validação |
| 🦖 | `:t-rex:` | Código que adiciona compatibilidade com versões anteriores |

### Regras de entrega

- **PR pequeno e específico:** uma unidade lógica. Regra deste arquivo que o código do PR segue, criada ou ajustada, vai no mesmo PR; regra de processo que o PR só viveu (como revisar, entregar, quantas rodadas) vai num PR próprio.
- **Mudança neste arquivo:** a regra vale para qualquer agente e área, é clara para quem nunca viu o repositório, diz o que fazer e por quê, e funciona fora do caso que a motivou. Fato que muda (ferramenta instalada, nome de branch) entra como condição ("se…").
- **Merge só com autorização explícita** (§12), testes e CI verdes sem warning novo, e revisão independente ("Como revisar um PR"). Pendência que bloqueia, aberta, segura o merge mesmo com a ordem dada, até o aval dela. Autorizado: **merge commit, nunca squash**, SHA verificado, título Gitmoji (`gh pr merge <N> --merge --match-head-commit <sha> --subject "🔀 merge: ..."`); depois, confira o pipeline pós-merge (CI e publicação da imagem).

### Como revisar um PR

Quem revisa (pessoa ou agente) é o **portão do merge**. Recebe o diff, este arquivo e o que o autor afirma (a descrição do PR ou, antes dele, as mensagens dos commits, como no fechamento da §12), sem a conversa de quem escreveu, e trabalha para **achar o que está errado**: "passa nos testes" não aprova sozinho e "o autor explicou" não substitui conferir.

- **Tente quebrar:** para cada bloco relevante, a entrada, o estado, a ordem de eventos ou a corrida (dois cards, dois backends, reconexão no meio do turno) que produz resultado errado. Sem esse cenário concreto (entrada ou estado → resultado errado), é opinião, não achado.
- **Prove cada achado** com o `arquivo:linha`: em comportamento, de preferência um teste que falha hoje, senão o cenário concreto; em regra, a regra escrita deste arquivo e o trecho que a viola. Separe fato de hipótese e diga o que não verificou.
- **Confira o que o PR afirma:** cada causa, número, linha, resultado de teste, medição, pendência e justificativa, da descrição e dos comentários no diff, contra o código. Afirmação falsa ou sem sustentação é achado, mesmo com o código certo.
- **Leia além do diff:** quem chama e quem é chamado; quem consome o que mudou (o front, as ferramentas MCP, os scripts plantados nos containers, os pontos compartilhados: store, host executor, broadcast do websocket); o contrato com terceiro pela docs ou pela versão instalada (§6); os dados já gravados nas instalações que o código novo lê (§6, §7); o deploy: cards e turnos em andamento, retomada após o reinício, runner reaproveitado, limites de terceiros (rate limit do GitHub, cota da conta Claude).
- **Confronte cada linha `+` com este arquivo**, seção por seção (§2 a §11 e §14). Trecho tocado = trecho auditado: o que o PR acrescentou ou alterou responde como código novo; o que ficou fora do diff não entra.
- **O teste tem de provar:** falha sem a correção, pelo motivo certo; cobre o fluxo real, sem mockar a lógica interna (§11); depende do código, não do relógio, da carga ou da ordem de execução. Teste que não afirma nada, ou cujo nome promete mais do que verifica, é achado.
- **A pendência deliberada é julgada.** Ela fica nos Pontos de atenção (item 9), mesmo quando outra seção a cita, ou na mensagem do commit antes de o PR existir. Sustenta-se quando o motivo é verdadeiro e fazer agora é impossível antes do merge (a integração que só roda depois do deploy) ou arrisca mais do que esperar; com motivo falso, ou escondendo violação simples de corrigir, é achado. O autor declara; o revisor julga e diz isso na revisão; quem aceita é quem autoriza o merge (o usuário, quando o trabalho é de agente), explicitamente e para aquela pendência, depois de ler o julgamento. O PR registra o aval (quem e quando); até lá, ela bloqueia.
- **As severidades, e o que acontece com cada uma:**
  - **bloqueia**: defeito real no que o PR escreveu (comportamento errado, falha, brecha, perda de dado), linha que viola regra escrita deste arquivo e toda regressão em relação à `main`, mesmo pequena, sempre com prova. Corrige-se antes do merge, com o teste que prova o defeito de comportamento, ou vira pendência aceita. Código mais complicado que o necessário (§1.1, §4, §13) e nome que batiza com outro termo um conceito que o repo já nomeia (§1.7, §2) violam regra escrita e caem aqui.
  - **deveria corrigir**: melhoria no código que o PR escreveu, que preserva o comportamento, que **nenhuma regra escrita exige** (se exige, é **bloqueia**) e que não depende de gosto (a mensagem de erro que já basta, mas pode citar o id que falta; a ordem dos casos de teste que acompanha melhor o fluxo). O autor aplica sem perguntar; não segura o merge.
  - **decisão**: exige decidir intenção ou produto. Vira pergunta ao usuário (§12); enquanto aberta, o veredito é **não apto**.
  - **menor**: preferência ou troca (a repetição pequena que a §3 permite, um nome igualmente claro, uma refatoração maior) e o fora do escopo (problema antigo fora do diff). Não se aplica: fica no PR como sugestão.
- **O formato da entrega segue o fluxo onde a revisão roda.** Os cards de análise (`[vibehub · análise de PR]`) e de revisão em rodadas (`[vibehub · revisão de PR]`) seguem o contrato do prompt deles (`back/src/services/review/prompts.ts`): o JSON que o servidor lê, os vereditos por rodada e quem corrige (na análise, o próprio card; nas rodadas, a IA do autor). As classes correspondem: **bloqueia** = `blocking` com prova (`failing_test`, `rule` ou `scenario`), **deveria corrigir** = `improvement`, **decisão** = `question`, **menor** = `suggestion`; achado derrubado na verificação é `refuted` (na análise sai da lista; nas rodadas fica no JSON, para o histórico). Fora desses cards (o fechamento da §12, a revisão de uma pessoa), vale o item abaixo.
- **Entregue** a lista do mais grave ao menos grave, cada achado com severidade, `arquivo:linha`, o defeito numa frase com o cenário de falha, a evidência e se é regressão em relação à `main`; feche com o veredito, **apto** ou **não apto**, e o motivo, no formato de "Como relatar" (§12).
- Cada achado tem resposta na thread dele: o commit e o teste que o resolvem, ou o motivo de ter virado pendência.

## 15. Onde cada coisa vive

| Camada | Conteúdo |
|--------|----------|
| `AGENTS.md` (este) | Todas as regras do projeto, para qualquer agente e pessoa |
| `.claude/CLAUDE.md` | Como o Claude Code trabalha aqui: ordem das etapas, mapa de skills, subagentes, fechamento e entrega; importa este arquivo e nunca repete regra dele |
| `.claude/settings.json` | Configuração do Claude Code: plugins, permissões, profundidade de subagente e os hooks que o `.claude/CLAUDE.md` descreve |
| `eslint.config.js`, `scripts/lint/` | A parte deste arquivo que a máquina checa (`npm run lint:changed`, §12 passo 7); os emojis dos commits ela lê da tabela da §14, sem cópia |
| `README.md`, `SECURITY.md` | Páginas públicas do repositório, sem regra de desenvolvimento |
| `back/src/services/brain/personas/*.md` | Instruções que o servidor MCP do vibehub entrega a todo card (código do produto) |
| `docs/` | Documentação do projeto (arquitetura, API, processos do runner), não canônica para regra. Spec e plano das skills (brainstorming, writing-plans) ficam fora do repositório, em `/tmp/<card>/` |
| `CLAUDE.local.md` (raiz da worktree, não versionado) | Instruções do projeto que o vibehub escreve em cada card; `## Aprendizados` recebe o que o `vibehub_brain_learn` descobre (porta, runner, flakiness, fato de ambiente) |
| Cérebro (`CLAUDE.md` do perfil, não versionado) | Instruções globais do runner, editadas na aba Dev → Cérebro |

Markdown versionado só existe nestes lugares (em `docs/`, só na raiz da pasta): o `npm run lint:changed` reprova o `.md` commitado fora deles. Regra de projeto nova entra neste arquivo; memória do agente, `CLAUDE.local.md` e Cérebro guardam fato de ambiente, nunca regra de código. Assunto que nenhuma camada documenta é pergunta ao usuário (§12), não convenção inventada.

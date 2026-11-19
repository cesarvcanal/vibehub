# AGENTS.md — Regras de desenvolvimento do vibehub

> **Escopo:** regras obrigatórias para todo o repositório: backend (`back/`), frontend (`front/`), scripts plantados nos containers, testes e refatorações.
>
> **Objetivo:** produzir código correto, legível, simples, performático, seguro e fácil de manter — sem burocracia ou abstrações sem benefício.
>
> **O projeto:** IDE hospedada para agentes de código — um kanban de terminais Claude Code reais rodando em containers no servidor do próprio usuário. Backend Fastify, servidor MCP próprio (`back/src/mcp/`), persistência em JSON atômico (`back/src/store/`), runner Docker local ou via SSH (`back/src/runtime/host.ts`). Frontend React + Vite + React Query + Radix/Tailwind. Projeto **público (MIT) e auto-hospedado**: cada instalação tem os próprios dados, então contrato persistido não muda sem migração.
>
> **Regra de aplicação:** as regras gerais são **independentes do domínio** e não presumem entidades, telas ou fluxos de um módulo. As referências a arquivos do vibehub são exemplos e pontos de entrada; os contratos reais saem da inspeção do trecho modificado (§12, passo 1). **Cada regra vale pelo princípio, não pela lista de exemplos:** caso não citado se resolve pelo espírito da regra mais próxima, e na dúvida se pergunta (§12, "Como perguntar ao usuário").
>
> **Fonte única:** este arquivo é a fonte das regras de código, de nomes e pastas, de teste, de commit e de PR. Regra nova entra aqui, em nenhum outro arquivo. O `.claude/CLAUDE.md` importa este arquivo e diz como o Claude Code executa estas regras (ordem das etapas, skills, subagentes, entrega); onde cada coisa vive está na §15.
>
> **O modelo é este arquivo, não o código vizinho.** Boa parte do código existente é anterior a estas regras (comentários, `let`, nomes abreviados, áreas misturadas em `front/src/features/board/`). Código novo segue estas regras mesmo quando o arquivo ao lado faz diferente.

## 1. Regras inegociáveis

1. **Simples, bem feito:** escolha a solução com menos conceitos e indireções que preserve todas as garantias necessárias. Menos linhas, por si só, não significa mais simplicidade.
2. **Sem voltas:** não crie wrappers que apenas repassam chamadas, múltiplas camadas sem responsabilidade, factories artificiais ou generalizações para um futuro hipotético.
3. **Código em inglês, interface pelo i18n:** identificadores em inglês, o idioma do repositório público; texto visível ao usuário sempre pelo i18n, nos dois idiomas; commits, PRs e documentação de processo em pt-BR (§2).
4. **Só `const` nas linhas que o PR escreve:** `let` só para estado vivo, nas exceções fechadas da §3. Nunca `var`.
5. **Sem código morto:** remover branches inúteis, imports não usados, dados que não são lidos e funcionalidades sem consumidor — depois de verificar referências.
6. **Código que se explica sozinho:** o porquê de uma decisão vai para a **mensagem do commit** e para o **PR** (§14), não para o arquivo. Comentário só nas exceções fechadas da §3.
7. **Contratos explícitos:** um significado deve ter uma representação canônica. Não criar variantes de campos, formatos ou comportamentos silenciosamente compatíveis.
8. **Falhe de forma visível:** não mascarar violação de contrato com fallbacks, retornos vazios ou tratamento que aparenta sucesso.
9. **Segurança na origem:** validar entrada e autorizar operações nas fronteiras. Tudo que chega a um shell é validado na fronteira e citado depois; segredo viaja por stdin, nunca por argv (§10).
10. **Performance é requisito, não polimento:** cada `docker exec`, leitura de estado, evento de websocket e render custa num runner que vários cards dividem. Faça o menor trabalho real que cobre o caso (§8), sem cache ou memoização por reflexo.
11. **Mudança completa, escopo controlado:** corrigir todos os consumidores afetados sem reescrever partes alheias à tarefa.
12. **Verificação real:** nunca declarar que testes, build, revisão ou deploy passaram sem executá-los e observar o resultado.

**Ordem de prioridade em conflitos:** segurança e integridade dos dados → correção e contratos → simplicidade e clareza → performance → estilo. Uma regra de estilo não justifica comportamento incorreto ou risco. Performance abaixo de clareza quer dizer: entre duas soluções igualmente rápidas, a mais clara; nunca que trabalho desperdiçado é aceitável por ser "mais legível".

## 2. Idioma e nomenclatura

- **Código em inglês:** variáveis, funções, tipos, componentes e campos persistidos seguem o padrão do repositório, que é público. Não misturar identificadores em português num arquivo em inglês. A descrição de `describe`/`it` é texto, não identificador: segue o idioma do arquivo de teste (a maior parte da suíte usa pt-BR).
- **Texto de interface sempre pelo i18n** (`front/src/i18n/en.ts` e `pt-BR.ts`). Toda chave nova entra nos dois arquivos; nunca string literal visível no JSX.
- **Commits, PRs e documentação de processo (`docs/`, este arquivo) em pt-BR.**
- Não traduzir nem renomear sintaxe ou APIs de terceiros (SDK do Claude, Fastify, React, Docker): permanecem como a especificação deles define.
- Não renomear contratos persistidos (`board.json` e afins), rotas HTTP, ferramentas MCP ou variáveis de ambiente só por estética. Isso é mudança de contrato (§6).
- Funções usam **verbo preciso + objeto** (`assertMovableColumn`, `normalizeCardIds`). Variáveis descrevem conteúdo e função. Evitar `data`, `tmp`, `result`, `x` e abreviações opacas.
- **Todo nome se lê sem abrir a implementação**, inclusive parâmetro de callback e variável de laço (`row`, não `r`). Uma coisa tem um nome só no mesmo escopo.
- Não usar verbos genéricos como `process`, `handle`, `manage`, `resolve` quando houver ação mais precisa.
- Referências nomeiam a entidade apontada (`cardId`, `accountSlug`, não `id` solto quando há mais de um); nomes de variantes deixam claras as duas diferenças (`originalValue` e `convertedValue`, não `value` e `convertedValue`).
- Antes de batizar um conceito novo, `grep` do termo no repo: se ele já nomeia outra coisa, escolha outro.
- Convenções: `camelCase` para funções/variáveis, `PascalCase` para componentes/classes/tipos, `UPPER_SNAKE_CASE` para constantes realmente estáticas (`EXEC_TIMEOUT_MS`); hooks começam com `use`.
- **Nome de arquivo segue a mesma convenção, inclusive em teste:** `camelCase.ts`, ou `PascalCase.tsx` quando o arquivo exporta um componente; o teste é o nome do arquivo testado mais `.test` (`sdkChat.test.ts`, `SdkChatView.test.tsx`), com sufixo de cenário quando um arquivo tem várias suítes (`cardSdk.lifecycle.test.ts`). Arquivo novo já nasce no padrão; arquivo antigo fora do padrão só é renomeado com pedido, porque o rename arrasta imports.
- Se uma cadeia de `filter`/`map`/`sort` esconder regra importante, nomear as etapas intermediárias.
- Em código legado tocado, o nome ruim no trecho que o PR altera sai corrigido no mesmo passo; o padrão do vizinho não é autoridade. Se o rename repercute em contrato ou em muitos consumidores, é mudança de contrato, não ajuste cosmético.

## 3. Estilo e qualidade de código

- Preferir funções coesas com entrada, saída e responsabilidade claras. Não impor limite mecânico de linhas.
- Usar retornos antecipados para reduzir aninhamento quando melhorar a leitura. Não comprimir regras complexas em ternários encadeados.
- Não duplicar **regra de negócio** ou fonte de verdade. Repetição pequena e local pode ser melhor que uma abstração genérica sem significado.
- Importações estáticas no topo. Import dinâmico só por carregamento sob demanda (dependência pesada fora do caminho inicial), dependência circular real ou outra restrição técnica fundamentada.
- Usar `async` quando houver execução assíncrona ou obrigação de retornar `Promise`; não tornar uma função assíncrona por costume.
- Não criar `try/catch` que só captura e relança o mesmo erro sem acrescentar informação ou comportamento.
- Não engolir erros (a §9 traz a única exceção, o melhor esforço, e diz quando o `catch` de uma tarefa de fundo não conta como engolir), não retornar sucesso falso e não adicionar `setTimeout`/retries para esconder uma falha de fluxo.
- Não criar flags, estados, campos ou leituras que ninguém consome.
- Efeito colateral é explícito: função que grava, apaga ou muda estado diz isso no nome (`save`, `delete`, `set`…); um `get`/`read`/`parse` não grava nada.
- **Cálculo e efeito em etapas separadas:** o que calcula (incluindo callbacks de `filter`/`map`/`find`) só devolve valor; o que envia, grava ou notifica vem depois, em passo próprio.
- Reaproveitar utilitários e dependências **realmente existentes** antes de escrever abstrações novas ou instalar bibliotecas.
- Respeitar o formatter e a organização do repositório. Não reformatar arquivos inteiros que não participam da tarefa.

### `const` e estado vivo

- **Toda declaração que o PR escreve é `const`**, inclusive em teste. Valor que muda vira nova constante com nome próprio, função ou `reduce`; `beforeEach` que reatribui um `let` vira helper chamado em cada teste (`const card = createCard()`).
- **Exceção fechada — estado vivo:** variável de módulo ou de closure que acompanha a vida de um processo, sessão ou stream e é reatribuída por eventos (a query corrente do driver, o dono das tarefas em segundo plano, um contador de tentativas). Prefira juntar esse estado num objeto `const` com campos; quando isso piora a leitura, o `let` fica com `// eslint-disable-next-line no-restricted-syntax -- <motivo>` e o PR diz por quê.
- `let` que já existe fora do diff fica como está; não se varre o repositório atrás dele.

### Comentários

**O código se explica pelo nome e pela estrutura.** Se um trecho precisa de explicação, renomeie a função ou a variável, extraia a etapa com nome de domínio (§2), troque o número solto por constante nomeada. No teste, a documentação é o nome do `describe`/`it`.

- **Para onde vai o porquê** que o comentário diria (a decisão, a alternativa descartada, o bug que motivou a linha):
  - **a mensagem do commit** que introduz o trecho: quem lê a linha depois chega a ela pelo `git blame`/`git log`, mesmo sem abrir o PR;
  - **o PR** (§14), onde o revisor o lê junto com o diff.
- **Invariante que o código não deixa óbvia** (ordem obrigatória, atomicidade, corrida entre cards, cicatriz de bug em produção) ganha um **teste cujo nome diz a regra**. Quem "simplificar" o trecho quebra o teste e lê o porquê no nome dele.
- **Únicas exceções**, em uma linha, só quando o código não tem como dizer aquilo, e abrindo com o marcador da exceção (o lint do recorte, §12, reprova comentário novo sem ele):
  - `// external: <regra e referência>`: **regra externa**, com a referência da docs ou da versão do fornecedor (SDK/CLI do Claude, Docker, GitHub; §6);
  - `// limitation: <motivo>`: **limitação técnica** que nenhum nome expressa: bug conhecido de biblioteca, navegador, shell ou ambiente de teste; dependência circular que obriga o import dentro da função;
  - `// legacy-name: <o que guarda>`: **nome legado que não pode mudar** (campo persistido ou contrato externo, §2 e §6): o que ele guarda e por que não foi renomeado;
  - **diretiva de ferramenta**, sem marcador e sempre com o motivo: `// eslint-disable-next-line <regra> -- <motivo>`, `// @ts-expect-error <motivo>`.
- **A regra vale para as linhas que o PR acrescenta ou altera.** Comentário antigo fora do diff fica — muitos guardam a história de bugs de produção e continuam valendo. Comentário antigo que a mudança torna **falso** sai no mesmo PR: é removido, com o porquê no commit, ou, quando é uma das exceções abaixo, reescrito com o marcador dela. A linha reescrita é linha nova para o lint do recorte, que não distingue correção de comentário novo.
- **Em linha nova, o que não entra:** narração do que a linha faz, a versão anterior ("antes era…"), nome de pessoa ou de instalação, JSDoc que só repete o nome (tipo em JSDoc num arquivo JS, `.mjs`, `.cjs`, `.js` ou `.jsx`, é tipo, não comentário), código comentado, bloco de cabeçalho novo explicando o arquivo.

| Em vez de | Escreva |
|-----------|---------|
| `// only live cards` em cima de um `filter` | `const liveCards = cards.filter(...)` |
| Comentário explicando a regra de um `if` | Condição com nome (`const canReopenCli = ...`) e o porquê no commit e no PR |
| `/** Finds the card by id */ findCardById(id)` | Só a função: o nome já diz |
| Comentário contando o bug que a linha evita | Teste com o nome da regra (`"o login novo vale mesmo com tarefa em segundo plano viva"`) e a história no commit |

## 4. SOLID, coesão e abstrações

**Todo código segue SOLID e é o mais simples possível. Simples NÃO é incompleto; abstrato NÃO é robusto.**

- **Simples** = o menor número de conceitos, arquivos e indireções que cobre o problema **inteiro**: todos os casos, erros, autorização, consumidores e testes. Cortar caso, validação, teste ou consumidor para "simplificar" é entrega incompleta.
- **Abstração sem necessidade é proibida.** Não criar camada, classe, factory, registry, estratégia, mapa paralelo, helper genérico, parâmetro de configuração ou arquivo "para o futuro" ou "por padrão arquitetural". SOLID orienta **como dividir responsabilidades reais**; ele não pede abstração nova.
- **Uma regra, um lugar.** Se o mesmo fato pode ser declarado em dois lugares, o desenho está errado: deixe um só e apague o outro, em vez de criar uma camada que concilia os dois.
- **Cada arquivo no seu lugar.** A pasta diz o que o arquivo **é**; o nome diz o que ele **faz** (mapa do front na §5, do back abaixo). O teste mora **ao lado do código que ele testa**. Apagou, moveu ou renomeou um arquivo? Testes, tipos e irmãos mudam junto: `grep` dos imports antigos e confira cada um que sobrou.
- Testes quase iguais espalhados (um por caso, mudando só os dados) viram **um** teste parametrizado (`describe.each`/`it.each`) no arquivo do assunto.

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

### Áreas: um nome nos dois pacotes

**A área de um código é a pasta de `back/src/services/<área>/` que o atende, e o front dela mora em `front/src/features/<área>/`, com o mesmo nome.** `ls back/src/services` lista as áreas; as duas do front sem service com o mesmo nome são `auth` (no back, `back/src/auth/`) e `setup` (o assistente da primeira instalação).

- **Arquivo novo nasce na pasta da área dele.** A pasta do front ainda não existe? Ela é criada no mesmo PR, com `components/`, `lib/` e `types/` conforme a §5.
- **`front/src/features/board/` guarda só o board:** colunas, card, projeto, seleção e deck. O resto que está nela (revisão e análise de PR, contas e uso, chat do SDK e medidor de contexto, cérebro, plugins, MCP, preview) é **legado à espera de mudança de pasta**, não exemplo. Os nomes dizem a área: `front/.../board/lib/usage.ts` corresponde a `back/src/services/accounts/usage.ts`, `contextUsage.ts` a `sdk/`, `analysisConversation.ts` a `review/`.
- **Mexeu num arquivo legado de outra área:** a mudança fica nele (a mudança de pasta é um PR próprio, só de `git mv` e imports, com pedido, §12.6); o arquivo **novo** que essa mudança cria vai para a pasta da área, importando o legado de onde ele está.
- **Teste mental, antes de criar o arquivo:** "qual pasta de `back/src/services/` atende isto?" O nome dela é a pasta do front. Código do front sem service no back (tema, websocket) é técnico e vai para `front/src/lib/` (§4, "Utilitário × regra de negócio").

- **Teste mental, antes de criar qualquer abstração:** "se eu escrever isto direto, no lugar onde é usado, o que fica pior **hoje**?" Se a resposta é "nada" ou "talvez um dia", escreva direto.
- **Teste mental, antes de entregar:** "um dev que nunca viu o módulo entende o fluxo lendo de cima para baixo, sem pular entre arquivos para descobrir o que um nome genérico faz?" Se não entende, simplifique; não documente a complexidade.

Aplicar SOLID como **princípios de desenho**, não como obrigação de criar classes:

- **S — Responsabilidade única:** funções, componentes, hooks e serviços agrupam o que muda pelo mesmo motivo.
- **O — Aberto/fechado:** variantes reais não devem exigir espalhar mudanças; não criar estratégias ou registries para um caso hipotético.
- **L — Substituição:** implementações do mesmo contrato preservam semântica, erros e invariantes (ex.: o host executor `local` e `ssh` têm o mesmo contrato).
- **I — Segregação:** tipos e interfaces coesos, representando necessidades concretas.
- **D — Inversão de dependência:** isolar dependências externas ou instáveis (Docker, SSH, GitHub, SDK do Claude) quando isso trouxer testabilidade ou proteção de fronteira.

**Antes de criar uma abstração, responder:** que responsabilidade ela protege? O que pioraria se fosse removida? Existe mais de um comportamento real? Protege uma fronteira, uma invariante ou uma duplicação relevante? Uma camada que apenas encaminha argumentos sem decisão, transformação ou proteção de fronteira deve ser eliminada quando seguro. Entre duas opções igualmente corretas, preferir a que exige menos conceitos.

### Utilitário × regra de negócio

**A pasta compartilhada guarda o técnico; quem decide é a camada de regra da área** (o service no backend; o hook ou a função de `features/<área>/lib/` no frontend). Vale para `back/src/utils/` e `front/src/lib/`. Elas guardam operações técnicas (texto, data, lista, stream, conversão de formato) e infraestrutura que toda área usa (logger, guardas do processo, cliente HTTP, websocket, tema, hooks genéricos como `useNow`). Infraestrutura pode ter efeito colateral; o que as duas pastas não guardam é **regra de domínio**.

- **Não conhece o domínio.** Não conhece card, conta, sessão, review nem permissão, e não decide se uma operação pode acontecer. Pode usar biblioteca, outro util, a configuração e o i18n; ler o relógio vale quando a operação é sobre o instante atual.
- **Entrada impossível não é regra de negócio.** A função pode recusar a entrada tecnicamente impossível para a operação dela (texto ausente numa função de texto); "este card pode ser movido" é regra e mora na camada de regra.
- **A dependência vai só da área para a pasta compartilhada.** Nada em `utils/` ou `lib/` importa service, store, componente ou hook de uma área; quando chamar, com qual dado e o que fazer com o resultado fica na camada de regra.
- **Ser reutilizável não faz da função um util.** Função que duas áreas usam e que carrega regra continua sendo regra e mora na área dona; quando nenhuma área é dona, onde criar o lugar comum é decisão do usuário (§12). Montar a URL, o comando ou a mensagem no formato de um terceiro (GitHub, Docker, CLI do Claude) é integração: mora no client ou no service da integração.
- **Teste mental:** "esta função pode ser copiada para outro repositório levando só bibliotecas, outros utils, configuração e i18n, sem nenhuma regra deste?" Se não pode, ela não é util.
- **Regra de domínio dentro de `utils/` ou `lib/` que o PR toca** é movida para a área dona no mesmo PR, junto com os imports, ou vira pendência deliberada no PR com o motivo.

## 5. Frontend, React e TypeScript

1. **Código novo usa export nomeado**, a maioria do repositório. `export default` só onde um formato de terceiro o exige (a story do Storybook, no formato CSF); os `export default` existentes não são convertidos de carona (§12.6).
2. **Componente focado em renderização e composição.** Regra de domínio vira função pura em `features/<área>/lib/*.ts`, com teste ao lado; orquestração com estado vira hook `use*.ts`; chamada HTTP fica no `api.ts` da feature.
3. **Não criar hook artificial:** estado visual simples ou handler sem regra pode ficar no componente.
4. **Contratos HTTP tipados num lugar só** (`front/src/api/types.ts`), espelhando o backend. Tipos locais de uma feature ficam fora do componente (`features/<área>/types/`).
5. Evitar `any`, casts sem fundamento, estados impossíveis e interfaces redundantes.
6. Não usar `useMemo`, `useCallback` ou `React.memo` indiscriminadamente — só com cálculo custoso, identidade referencial relevante ou benefício demonstrável (§8).
7. Não suprimir regras de hooks nem remover dependências de efeitos para esconder renderizações. Corrigir o fluxo.
8. **Efeito e estado com papel único:** cada efeito sincroniza uma coisa; estado criado só para disparar outro código indica fluxo errado.
9. Evitar lógica de negócio e transformação complexa dentro do JSX.
10. Derivar valores da fonte em vez de manter estados sincronizados para o mesmo fato. Dado do servidor mora no React Query, não copiado em `useState`.
11. Reutilizar as primitivas de `components/ui` (Radix + Tailwind) antes de criar versões novas.
12. Tratar carregamento, vazio, erro, sucesso e envio duplicado quando pertinentes.
13. Não disparar requisições em renderização nem por efeito descontrolado.
14. Esconder ação na UI é experiência; quem autoriza é o backend.
15. **Toda mudança de layout passa por revisão de UI/UX com a tela renderizada**, inclusive um bloco novo dentro de uma tela que já existe. Antes de entregar, o agente vê a tela rodando (o app ou uma história do Storybook, na largura real em que ela aparece) e confere: a hierarquia diz o que importa primeiro, o novo segue o visual dos vizinhos (cores, tamanhos, espaçamentos e as primitivas de `components/ui`), nenhum texto some ou é cortado na horizontal (texto longo quebra a linha; contêiner com rolagem rola só na vertical), e os estados de vazio, carregando, erro e muitos itens continuam legíveis. O print vai no PR (§14, item 8); o que não ficou bom é corrigido antes, não registrado como pendência.

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

Código de uma área só mora dentro dela, na pasta com o nome da área (§4, "Áreas: um nome nos dois pacotes"). O código técnico sobe para a pasta compartilhada quando uma segunda área passa a usá-lo; a regra de domínio fica na área dona (§4, "Utilitário × regra de negócio").

## 6. Contratos, schemas e integrações

- Antes de mudar um campo, tipo, payload, rota, ferramenta MCP, evento de websocket ou função consumida por outros arquivos, localizar **todos os consumidores** — inclusive o front, o runner e os scripts plantados nos containers.
- **Uma informação, um nome canônico.** Não manter formatos paralelos "por segurança".
- Contrato **interno** mudou: atualizar todos os consumidores na mesma alteração, sem `newField ?? oldField` nem shims automáticos.
- **Dado persistido é contrato externo:** cada instalação auto-hospedada tem seu `board.json` e afins. Mudança de shape exige leitura compatível ou migração explícita e testada, nunca quebra silenciosa.
- Validar na entrada, com o padrão do ponto de entrada: ferramentas MCP com **zod** no schema da ferramenta; rotas HTTP chamam a função do registry/service que valida e lança, e a rota converte o erro de validação em 400 (e "not found" em 404). Dentro do fluxo já validado, confiar no tipo.
- **Erro de rota JSON tem uma forma só:** `{ error: "<mensagem>" }` com o status 4xx ou 5xx. A página HTML de um fluxo de navegador (o login do OAuth) responde a página de erro, não JSON.
- Comparar e referenciar entidades por **id**, nunca por nome, título ou texto, inclusive o que o próprio código acabou de criar.
- Dado editável vive na sua fonte (configuração, cadastro, store). Não congelar no código ids, nomes, listas ou códigos que mudam.
- Dado composto (autor, motivo, origem, instante, referência) vai em campos próprios, não concatenado num texto.
- Centralizar enums e discriminantes (`as const` / union de literais) numa definição única, sem mapas paralelos descoordenados. `switch` cobre todas as variantes; variante sem suporte falha visivelmente.
- Campos opcionais novos ficam ausentes quando não informados, a menos que `null` seja um estado de domínio explícito.
- Em atualização parcial, distinguir **campo não enviado** de campo enviado com `0`, `false`, `""` ou `null`.

### Integrações externas: a documentação oficial é o contrato

SDK e CLI do Claude, GitHub, Docker e afins seguem a **documentação oficial do fornecedor e o comportamento da versão instalada**: método, campos, eventos, códigos de saída e fluxo. Log de campo, tentativa e erro ou "funcionou no teste" não substituem a docs.

- **Ler antes de mexer.** Antes de criar ou alterar uma chamada externa, abrir a docs (ou o pacote da versão instalada, quando a docs não cobre) e citar a fonte na descrição do PR; num comentário de uma linha só quando a regra externa não é óbvia pelo código (exceção da §3).
- **Mudança de versão exige conferir o comportamento real**, não a memória.
- **Fato, não hipótese.** Diagnóstico de integração afirma só o que log, docs, binário ou teste mostram. Hipótese é dita como hipótese, testada antes de virar correção, e nunca vira regra de código nem texto de tela.
- **Comportamento que a docs não define** é registrado como evidência, com versão, data e fonte, e tratado como incerto.
- **Exercitar antes do merge.** Integração nova ou alterada roda de verdade, na versão instalada e pelo caminho que o usuário usa (o card, o runner, a rota), antes do merge: o teste com fake prova a lógica, não a integração. O que não deu para exercitar é pendência que bloqueia (§14, "A pendência deliberada é julgada"), com o passo que a fecha.

| Em vez de | Faça |
|-----------|------|
| Usar evento, flag ou campo que a docs não lista porque "aparece no stream" | O caminho que a docs define; sem definição, registre a evidência com versão e pergunte |
| Afirmar a causa de um incidente sem a prova | Separar fato de hipótese e provar com log, binário ou teste antes de corrigir |

## 7. Dados, fonte de verdade e consistência

- Cada conceito tem uma **fonte de verdade identificável**. Não persistir cópias de valores que podem ser obtidos da fonte, nem as duas direções do mesmo relacionamento. Snapshot ou materialização só como exceção explícita, com motivo, origem e regra de atualização definidos.
- Estado JSON do vibehub em `VIBEHUB_DATA_DIR` (`board.json` e afins) passa pelo **store** (`back/src/store/`: `JsonStore`, `writeFileAtomic`). Gravação fora do store é exceção intencional: o porquê vai no commit que a introduz e o PR a declara, e a gravação continua atômica ou serializada por card.
- **Não gravar durante leitura** para sincronizar cálculos.
- Operações que podem rodar em paralelo ou repetir (hooks de status, retomada após deploy, deliver, provisionamento) precisam ser **idempotentes** e seguras em corrida. Vários cards trabalham ao mesmo tempo no mesmo runner, e, se a instalação faz deploy blue/green, dois backends convivem por um tempo.
- Nunca introduzir migração, limpeza ou exclusão de dados reais (worktrees, transcripts, volumes, containers) sem avaliação, `dry-run` quando aplicável e autorização.
- Remover escrita, campo ou leitura sem consumidor só depois de verificar quem lê.

## 8. Performance e eficiência

**O objetivo é executar menos trabalho real, não escrever o código mais curto.** O vibehub roda num servidor só, onde o runner, o backend e os containers de todos os cards disputam CPU, memória e disco; o que um card desperdiça, os outros pagam.

### Runner e host

- Cada `docker exec`/SSH é caro e disputa o runner com os outros cards. Agrupar comandos num script só quando forem do mesmo passo; nunca abrir uma execução remota por item de lista. `docker exec` e round trip ao host se contam separados: um `runScript` com três `docker exec` é uma viagem e três processos no runner.
- Processo de longa duração (driver do SDK, terminal, preview) tem dono e fim definidos: quem abre fecha, e o que fica órfão é bug.
- **Prazo de trabalho no container vale dentro do container:** o timeout do Node mata só o cliente local (`bash -s`, `ssh`, `docker exec`), e o processo lá dentro segue vivo. Script com prazo entra no container sob `timeout -s KILL`, que mata o grupo inteiro antes de o Node desistir (`containerScriptCommand`, em `runtime/host.ts`).
- **O runner existente nunca é recriado pelo código:** recriar o container derruba as sessões de todos os cards. Mudança que pede container novo (flag de `docker run`, imagem) vale só para o container criado depois dela; trocar o que já existe é decisão do operador, numa janela agendada, e o PR diz isso nos Impactos.
- Saída grande (log, transcript, diff) é lida em fluxo ou recortada na origem, não carregada inteira na memória do backend.

### Backend e estado

- Não reler nem regravar o estado inteiro por item quando uma operação em lote resolve; a gravação atômica do store reescreve o arquivo todo, então junte as mudanças de um passo numa gravação.
- Código que roda a cada evento e percorre uma coleção que cresce (cards, mensagens, linhas de transcript) trabalha só sobre o que mudou, não refaz o todo.
- Reduzir passagens repetidas em listas e mover cálculos invariantes para fora de laços, sem tornar o algoritmo mais difícil de entender.

### Websocket e rede

- Emitir só o que mudou e só para quem pode ver. Não criar polling para mascarar evento faltando.
- O que o cliente precisa ao reconectar (estado de sessão, aviso ativo) é reenviado no attach, não reconstruído por replay de histórico.

### Frontend

- Evitar fetch redundante: o React Query é a fonte, com chave estável e invalidação dirigida, não `refetch` geral.
- Renders desnecessários: estado no nível mais baixo que o usa; lista longa (chat, log, board grande) não re-renderiza inteira a cada item novo.
- Dependência pesada fora do caminho inicial (highlighter, terminal, editor) carrega sob demanda.
- Paginar ou virtualizar só quando a escala justificar.

### Como provar

- Cache, deduplicação e batch só por benefício concreto, com invalidação e ciclo de vida definidos; removê-los quando não agregarem valor.
- **PR que promete ganho de performance traz a medição** (antes e depois: tempo, número de `docker exec`, renders, bytes enviados) e o modo de reproduzir. Sem medição, o ganho é hipótese (§6) e o PR diz isso.
- **Teste mental:** "se houver 20 cards ativos e mil mensagens no histórico, quantas vezes este código roda e quanto ele lê em cada vez?" Se a resposta cresce com o total em vez de com a mudança, o desenho está errado.

## 9. Validação, erros e fallback

- Validar **nas fronteiras**: HTTP, websocket, hooks vindos do runner, ferramentas MCP, entrada de CLI e respostas de integrações.
- **Guard impõe contrato; fallback mascara erro.** Campo obrigatório ausente vira erro observável, não `""`, `0`, `null` ou `[]`.
- Usar `??`, `||` ou `?.` só quando a ausência faz parte do contrato real.
- **Dependência ausente falha à vista:** chamada sem destino (sessão, conexão, ouvinte) gera erro ou é impedida pelo tipo, nunca vira no-op silencioso.
- Distinguir presença de verdade lógica: `0` e `false` podem ser valores válidos.
- Erro informa o suficiente para diagnóstico sem expor token, segredo ou caminho sensível.
- Integração que falhou não aparece como concluída, nem para o usuário: falha de login, de runner ou de integração vira aviso visível com a ação que resolve. Retry só limitado e idempotente.
- **O erro chega a quem chamou, não só ao log.** Uma exceção ou é propagada até a fronteira responsável ou é traduzida para o chamador (exceção com mensagem própria, resposta HTTP de erro, evento de erro no websocket). Uma linha de log não faz nenhuma das duas coisas: o log do pino é a trilha de diagnóstico e de auditoria (as entradas `audit: true`) de quem opera a instalação e acompanha o erro, nunca o substitui.
- **Engolir o erro só em melhor esforço.** `catch` vazio, em qualquer forma (`.catch(() => {})`, `.catch(() => undefined)`, `try { … } catch { }`), é aceito apenas em efeito colateral cuja falha não muda o resultado da operação e que outro caminho cobre: aviso em tempo real que o próximo attach reenvia, limpeza que a próxima rodada refaz, gatilho antecipado de algo que também roda por agendamento. Na linha anterior à do `catch`, a diretiva que o lint exige com o motivo curto (`// eslint-disable-next-line no-restricted-syntax -- <motivo>`, a mesma nas duas formas; comentário dentro do bloco não o torna menos vazio); a história vai para o commit e o PR (§3). Falha que o chamador precisa saber nunca é engolida.
- **Fila de promises não engole.** Em `queue = next.catch(() => undefined); return next;`, o erro chega a quem chamou pelo `next`; o `catch` só impede que a falha de um item trave os seguintes. É o padrão das filas por card e do store, e não precisa de justificativa. O lint reconhece a fila pelo nome: a atribuição a `queue` (ou `this.queue`) e o encadeamento `previous.catch(...).then(run)` (ou com `queue`); fila com outro nome leva a diretiva com o motivo.
- **Tarefa de fundo sem chamador** (timer, reaper, retomada após deploy, rotina disparada sem esperar resposta): não há a quem propagar. Um `catch` que **altera o estado que decide o próximo passo, em relação ao que a tarefa faria sem o erro** (a marca da próxima tentativa, um contador de falhas, a parada da tarefa, o aviso ao card), não é engolir o erro, desde que esse caminho de falha tenha teste com um nome que diz o que acontece. Voltar a tentar só porque o timer bate de novo não conta: `catch` vazio, ou que só registra no log sem alterar esse estado, é engolir. Disparar sem `catch` (`void tarefa()`) dá no mesmo, porque a falha cai no handler global do processo e só vira log: a tarefa de fundo nova segue esta regra com ou sem `catch` escrito.
- `catch` vazio antigo fora do diff, em qualquer forma, fica como está; o que o PR toca é julgado por estas regras.

## 10. Segurança, autorização e escopo

- **Acesso decidido pelos preHandlers de `back/src/auth/`:** o que é da INSTALAÇÃO exige dono (`requireOwner`, em `session.ts`); o que é TRABALHO de um card segue o compartilhamento (`access.ts`) — `requireCardAccess` para ler, `requireCardWork` para mudar qualquer coisa; rota do próprio usuário, sem card (`/api/me/*`, listagens), exige só sessão (`requireSession`). Toda rota nova usa um desses. A checagem base vem do helper; filtro por usuário no handler (o que ele alcança, se é dono) só restringe o que o helper já liberou.
- **Acesso é decidido na borda.** Service recebe fatos já apurados (o card, o usuário, um booleano de comportamento), nunca refaz a checagem de acesso nem conhece o preHandler.
- Permissão de leitura (`view`) nunca autoriza mutação. Listagens filtram pelo que o usuário alcança, não pelo que existe.
- **Recurso que o chamador não alcança responde 404, não 403:** para quem não vê o card ou o projeto, ele não existe, e um 403 confirmaria que o id é real. O 403 fica para o que o chamador vê mas não pode mudar (o `view` tentando mutar, o membro numa rota de dono).
- **Shell:** tudo que vira linha de `docker exec` ou script (ids de card, branch, sessão, container) é validado na fronteira e citado depois. Leia `back/src/runtime/host.ts` antes de montar um comando.
- **Segredos por stdin, nunca argv** (`ps` é legível por todos). Credenciais moram no cofre criptografado (`back/src/secrets/`), nunca em log, resposta HTTP ou mensagem de erro.
- **Identidade git é do card:** commit, push e PR saem com a conta de quem deu a ordem, nunca com conta de terceiros nem da organização. Não contornar com outra credencial.
- Outros pontos de entrada (hooks do runner, MCP, websocket) têm limite de confiança próprio — token do runner, sessão — e não presumem que passaram pelo HTTP autenticado. Ponto de entrada de máquina (o callback de status do runner) autentica pelo token do serviço comparado em tempo constante (`tokenMatches`, em `auth/session.ts`) e não aceita cookie de sessão no lugar dele.
- Verificar caminhos permitidos e negados, inclusive chamando a API direto.

## 11. Testes e critérios de correção

- **Mudança de comportamento ou bug é sempre em TDD:** escrever o teste primeiro, rodar e ver falhar pelo motivo certo (em bug, reproduzindo o erro que aconteceu) e só então implementar até passar. Teste que nunca foi visto falhando não prova nada.
- **O verde só vale se o teste falha sem a correção:** depois do verde, tire só a correção (de uma cópia de backup do arquivo, nunca `git stash`), rode e exija a falha pelo motivo certo; recoloque e veja passar. Rode o arquivo de teste mais de uma vez: teste que alterna entre passar e falhar é defeito do teste até prova em contrário.
- Mudança de comportamento exige testes proporcionais ao risco. **Vitest** nos dois pacotes, com o teste ao lado do código (`*.test.ts` / `*.test.tsx`). Priorizar o fluxo real; teste unitário complementa quando isola regra complexa.
- **Teste é código:** toda regra deste arquivo vale nas linhas de teste como nas de produção: nomes (§2), `const` e comentários (§3), lugar e duplicação (§4), erros (§9). O modelo é este arquivo; o arquivo de teste vizinho escrito antes destas regras é legado, não exemplo.
- **Antes do primeiro helper de teste, procure a infraestrutura que já existe, nesta ordem:**
  1. **o repositório:** `ls back/src/testkit/` (infra compartilhada do back); no front, Vitest + Testing Library + jsdom (`front/vitest.config.ts`, helper `renderApp` em `front/src/test/render.tsx`);
  2. **o Vitest:** `onTestFinished` para desfazer o que o teste criou, `vi.waitFor` para esperar uma condição, `it.each`/`describe.each` para casos que só mudam os dados, `vi.useFakeTimers` para tempo;
  3. **o Node:** `existsSync` para saber se um caminho existe, `mkdtempSync` para diretório temporário.

  Nada disso cobre: o helper que serve a um arquivo só nasce nele; o que dois arquivos de teste precisam (um docker falso, um repositório git temporário) nasce em `back/src/testkit/` e é importado, nunca copiado de um arquivo para outro.
- Dado de teste sai do fluxo real ou de fábrica fiel ao contrato; não inventar shape que não existe em produção.
- Mockar só **fronteiras externas**: host executor (Docker/SSH), rede, GitHub, SDK do Claude. Não mockar a lógica interna só para facilitar asserções.
- Rotas HTTP: testar entrando pela rota real, com validação e acesso (dono, `work`, `view`, sem acesso).
- Verificar efeitos observáveis: estado persistido, script enviado ao host, payload emitido, UI atualizada, erro esperado.
- No front, testar interação, estados de carregamento/erro/sucesso e o contrato enviado/recebido. Em tela com debounce, cache ou espera, repetir a mesma ação exige esperar o estado assentar.
- Cobrir caminho principal, falhas e bordas; somar corrida, idempotência e retomada quando fizerem parte do risco.
- Não escrever teste que só valida a hipótese do próprio autor. Ler o contrato real antes de definir o resultado esperado.

**Rodar testes no runner: curto, só do que você tocou.** A suíte inteira leva muitos minutos, disputa CPU com os outros cards e costuma ser morta por um deploy.

1. **Enquanto trabalha:** só o arquivo do que mexeu, filtrado pelo caso — `cd back && npx vitest run <arquivo> -t "<caso>"` (idem em `front/`).
2. **Antes de entregar:** `npm run lint:changed` e `npm run test:changed` (raiz), o mesmo recorte do gate (`.vibehub/gate.json`). Junto, o typecheck do pacote tocado, o mesmo do CI:
   - **front:** `npx tsc -b`. O `tsconfig.json` é uma solution com project references, então `tsc --noEmit -p` não checa nada e dá verde falso.
   - **back:** `npx tsc --noEmit`. `tsc -b` emitiria JS em `back/dist`. O `tsconfig.json` do back exclui `*.test.ts`: erro de tipo em teste só aparece ao rodar o teste.
3. **Nunca** `npm test` ou `npx vitest run` sem filtro no runner. A suíte inteira é do CI: confira com `gh pr checks <N>`. A exceção é `npm run test:lint`, a suíte do lint da raiz (`eslint.config.js` e `scripts/`), pequena, que roda inteira quando o PR mexe nela: o gate não a roda, só o CI.
4. Teste de tempo (limite em ms) que falha de vez em quando sob carga não é regressão sua. Confirme rodando sem a sua mudança; se já era instável, diga no PR e siga.

Se um comando de teste for passar de ~2 min, troque por um recorte menor. Não afirmar que algo passou sem executar; se não deu para testar, relatar **o que foi e o que não foi validado**.

## 12. Processo obrigatório de trabalho do agente

**Não sair executando.** Antes de escrever código, entender a demanda e fechar o caminho com o usuário:

- **Teve dúvida, pergunta.** Requisito ambíguo, mais de um caminho razoável ou decisão que é do usuário: perguntar antes de implementar, no formato de "Como perguntar ao usuário", abaixo. Não inventar convenção nem presumir a resposta.
- **Explorar antes de construir.** Feature nova ou mudança de comportamento com alternativas passa por brainstorming: requisitos, abordagens com prós e contras, recomendação, e execução só com o caminho aprovado.
- **Processo em toda tarefa**, sem esperar ser mandado: debugging sistemático antes de propor fix, TDD na implementação, plano escrito para tarefa de várias etapas, verificação antes de declarar pronto, revisão do diff depois de implementar. A ferramenta que executa cada etapa é definida para cada agente (no Claude Code, o mapa de skills do `.claude/CLAUDE.md`).
- **Pedido de diagnóstico é leitura e explicação**, não edição.
- **Discordar com fundamento faz parte do trabalho:** quando o pedido parece pior que uma alternativa, a discordância vira pergunta no mesmo formato, com a alternativa recomendada e o pedido original como opções, cada uma com a sua consequência.

1. **Inspecionar antes de editar:** arquivos, fluxo, fonte de verdade, contratos, padrões e testes relevantes.
2. **Localizar consumidores:** chamadas, imports, rotas, ferramentas MCP, scripts do runner e telas impactadas.
3. **Definir escopo:** a menor alteração que resolva **o problema completo**.
4. **Implementar de ponta a ponta:** consumidores, contratos, validação, acesso, i18n e testes na mesma entrega.
5. **Auditar o trecho tocado:** nomes, `let`, comentário fora das exceções, código morto, duplicação, fallback indevido, leituras e execuções inúteis.
6. **Não espalhar alterações:** problema vizinho que exige refatoração arriscada é comunicado, não corrigido de carona.
7. **Validar:** lint do recorte, testes do recorte, typecheck e build quando aplicável; revisar o diff (comandos abaixo). O lint do recorte (`npm run lint:changed`) reprova, só nas linhas que a branch acrescentou, as regras que a máquina checa: as de `eslint.config.js`, cada uma com a seção que impõe. Lint verde não é conformidade: o resto deste arquivo é o passo 5 e a revisão do passo 8.
8. **Revisão independente antes de entregar:** o diff passa, nesta ordem, por **simplificação** (aplicada) e por **code review** (correção, performance, aderência às regras e o que foi inventado), ambas feitas por um revisor SEM o contexto de quem escreveu, com a entrada definida em "Como revisar um PR" (§14), que o code review segue. Achado confirmado segue a severidade dele (§14, "As severidades"): o que bloqueia é corrigido ou vira pendência deliberada, que só o aval de quem autoriza o merge aceita (§14, "A pendência deliberada é julgada"), o que deveria corrigir é aplicado, a decisão vira pergunta ao usuário e o menor fica registrado no PR. O descartado tem o motivo dito. O que a simplificação mudar volta pelo passo 7 antes do code review.
9. **Descrever o resultado:** o que mudou, o que foi verificado e as limitações reais. Quando a entrega é um PR, ele segue a §14.

### Autonomia corretiva e preservação do escopo

Pedir autorização e passar por brainstorming continua obrigatório para decisões de produto, mudança de escopo, funcionalidade nova, mudança de comportamento intencional e tudo cuja intenção não esteja clara. A exceção: **o agente corrige sozinho problema real naquilo que já foi definido, pedido ou implementado**, sem parar para pedir licença:

- bug e erro de lógica;
- código que contradiz uma regra ou decisão já definida;
- regressão introduzida durante o desenvolvimento;
- comportamento que contraria claramente o requisito estabelecido;
- falha de integração, validação ou consistência;
- ajuste técnico necessário para o que já existe funcionar corretamente.

**Limites:** autonomia corretiva não amplia escopo. Não implementar funcionalidade extra só porque parece útil; não alterar decisão intencional, fluxo estabelecido ou regra de negócio por preferência técnica; não remover, substituir ou simplificar o que não se entende. Melhoria fora do código que o PR já escreve, refatoração e o que foge do propósito viram **sugestão**, não execução (a melhoria dentro do que o PR escreveu é o "deveria corrigir" da §14). Se a correção exige decidir intenção ou direção do projeto, pergunte.

**Princípio:** o agente tem autonomia para preservar, corrigir e garantir a integridade do que foi definido e construído, não para redefinir o que o projeto deve ser.

**Operações de risco:** exclusão de dados (worktree, volume, dado de `VIBEHUB_DATA_DIR`), mudança incompatível de contrato persistido, alteração de acesso, reescrita de histórico já enviado (amend, rebase ou force-push de commit publicado), deploy e merge exigem as autorizações existentes. **Merge na branch que publica é deploy** (no vibehub, a `main`). Antes de agir, exponha os riscos ao usuário e siga só com o aval dele. O emoji marca a gravidade: 🚨 para risco grande ou irreversível, ⚠️ para risco médio ou pequeno.

### Comandos do repositório

| Comando | Uso |
|---------|-----|
| `npm run install:all` | Instala a raiz (o lint), `back/` e `front/` |
| `npm --prefix back run dev` · `npm --prefix front run dev` | Backend (tsx watch) e frontend (Vite) em dev |
| `cd back && npx vitest run <arquivo> -t "<caso>"` | Teste do que você tocou (idem em `front/`) |
| `npm run lint:changed` | ESLint só nas linhas que a branch acrescentou desde a base (`$VIBEHUB_BASE_REF`, padrão `origin/main`), o recorte do gate e do CI |
| `npm run test:lint` | Testes do próprio lint (a config e as regras locais), quando o PR mexe em `eslint.config.js` ou `scripts/`; o gate não os roda, o CI sim |
| `npm run test:changed` | Testes afetados pela branch desde a base (`$VIBEHUB_BASE_REF`, padrão `origin/main`), o recorte do gate |
| `npx tsc -b` (em `front/`) · `npx tsc --noEmit` (em `back/`) | Typecheck, o mesmo do CI (§11, passo 2) |
| `npm run build` | Build de back + front |
| `npm --prefix front run storybook` | Storybook dos componentes |
| `gh pr checks <N>` | Suíte inteira, que só roda no CI |

Exercitar os caminhos do runner de ponta a ponta fora de um card exige Docker local; os testes unitários usam um host executor falso e rodam sem ele.

**Testar pela tela sem tocar em produção:** back isolado (`VIBEHUB_PORT=<porta livre> VIBEHUB_DATA_DIR=/tmp/vh-test npx tsx src/index.ts` em `back/`) e front apontando para ele (`VIBEHUB_BACKEND=http://127.0.0.1:<porta> npx vite --port <outra>` em `front/`).

### Como perguntar ao usuário

Toda dúvida que trava a execução e toda discordância com o pedido viram pergunta de **múltipla escolha com saída livre**: o usuário decide com um clique quando uma opção serve, e responde com as próprias palavras quando nenhuma serve.

- **Uma decisão por pergunta.** Várias decisões independentes podem ir juntas, cada uma na sua pergunta. Pergunta que depende da resposta de outra espera essa resposta.
- **A pergunta se entende sozinha.** Ela diz o que foi encontrado, por que a decisão importa e nomeia o item em questão (a tela, o campo, a regra), sem "isso" nem "aquilo" soltos.
- **De 2 a 4 opções, uma excluindo a outra**, cada uma com rótulo curto e a consequência: o que muda, o custo e o risco. Opção vaga ("depende", "ver depois") não conta.
- **A recomendada vem primeiro**, marcada como recomendada, com o motivo. Sem recomendação, diga por que as opções empatam.
- **Sempre há saída livre** ("Outra: descreva").
- **Pergunta estruturada quando a ferramenta tem**; sem ela, numere as opções no texto e ponha a saída livre por último.
- **Descubra o que dá para descobrir.** O que o código, a documentação ou este arquivo respondem, o agente descobre e informa; a pergunta fica para a decisão que é do usuário.

## 13. Encerramento

**Regra de encerramento:** se o código funciona, mas exige conceitos, estados, leituras, arquivos ou indireções desnecessários, simplificar **antes de entregar**, preservando correção, integridade, segurança e testes.

## 14. Pull Requests

Todo PR deste repositório é documentação. Quem nunca viu o código tem de entender a mudança só pelo PR. Como o código não carrega o porquê (§3), é no PR que mora o porquê da mudança inteira, e cada commit leva na mensagem o porquê da parte dele, para quem chega à linha pelo `git blame`. Todo PR tem três partes obrigatórias: a **descrição**, a **conformidade com este AGENTS.md** e os **comentários no diff**. O revisor confronta o diff com este arquivo, seção por seção; o PR facilita esse confronto, não o substitui.

A conformidade vale para **todo PR, sem exceção**: de qualquer tamanho e de qualquer autor (pessoa ou agente), inclusive correção de review e mudança só de documentação. PR sem a seção de conformidade não está pronto para revisão: o revisor o devolve antes de ler o diff.

**Título** no padrão conventional commits, sem emoji: o tipo em inglês (`fix`, `feat`, `docs`, `refactor`, `perf`, `test`) e a descrição em pt-BR, `tipo(area): o que muda`.

### Descrição

Em pt-BR, em markdown, com estas seções (`##`) nesta ordem. A profundidade acompanha o tamanho da mudança. Cada seção vai direto ao ponto e diz o que só ela diz. Seção que não se aplica fica com uma linha: "Não se aplica: <motivo>". As seções 9 e 10 nunca ficam assim.

1. **Contexto**: onde a mudança se encaixa e por que ela existe.
2. **Problema identificado**: o que estava errado ou faltando. Em bug, a cadeia inteira: em que condição acontecia, o comportamento incorreto, a **causa raiz** e o comportamento depois.
3. **Objetivo**: o que o PR pretende alcançar.
4. **Solução implementada**: a mudança como um todo, não a lista de arquivos. Cada decisão vem com as alternativas consideradas. Quando a mudança mexe em fluxo ou estrutura, abra a seção com um **desenho curto** (árvore de arquivos, de chamadas ou de componentes, diagrama Mermaid, ou um bloco `diff` desse fluxo).
5. **Detalhamento técnico**: fluxos, componentes, services, eventos de websocket, ferramentas MCP, scripts do runner e regras envolvidas.
6. **Comportamento esperado**: como o sistema se comporta depois da mudança, com os cenários e exceções.
7. **Impactos**: o que muda, quando tudo dá certo, para outras áreas, usuários, dados persistidos, contratos e **performance** (o que passa a rodar a mais ou a menos), e o que o deploy exige (migração, configuração, reinício de runner).
8. **Testes e validações**: separar o que foi **executado** (com o comando e o resultado) do que é só **recomendado**, e dizer o que não deu para testar. Em mudança de comportamento, a prova vem como **antes e depois**: o teste que falhava sem a mudança e passa com ela (o nome e a falha observada) e, quando a mudança é visual, o print da tela antes e depois; a tela que ninguém viu rodando é pendência que bloqueia, como a integração não exercitada (§6). Em mudança de performance, a medição (§8). Documentação e configuração não têm teste vermelho: dizem isso. O CI também tem de estar verde, sem warning novo.
9. **Pontos de atenção**: riscos do merge, limitações conhecidas, pendências deliberadas com o motivo e onde o revisor deve olhar com cuidado. Comece por duas respostas curtas:
   - **o merge tem volta?** Porta de mão dupla quando reverter o commit desfaz tudo; porta de mão única quando há dado migrado ou apagado, contrato publicado ou outro efeito que o revert não desfaz;
   - **até onde vai o estrago se der errado?** Quem e o que pode quebrar: telas, cards em andamento, runner, dados das instalações, consumidores da API.
10. **Conformidade com o AGENTS.md**: para **cada seção deste arquivo cujas regras se aplicam às linhas alteradas**, diga a regra, como foi cumprida e, quando der, o `arquivo:linha` que mostra isso. O que é ausência (sem comentário, sem `let`, nenhum `docker exec` a mais) se afirma com o comando que a prova e o resultado dele: o `grep` no diff para o que está no texto; para o que acontece ao rodar (`docker exec`, leitura, render), a contagem ou a medição antes e depois (§8), porque a chamada nova a uma função que já existe não aparece no `grep`. Regra não seguida: qual, onde e por quê, como pendência deliberada. Frase genérica ("segue o AGENTS.md") não vale.

Nunca invente causa, teste ou justificativa. O que não está confirmado é dito como não confirmado.

**O PR acompanha o código.** A cada push (correção, commit novo, merge da base), releia o PR publicado inteiro, a descrição e os comentários no diff: número, `arquivo:linha` ou afirmação que o push tornou falsa é corrigido no mesmo push, na descrição editada e, no comentário do diff, com resposta na thread dele.

### Comentários no diff

Os comentários vão direto nas linhas do diff, publicados juntos numa **única revisão do tipo `COMMENT`**.

- **Um comentário por bloco de lógica relevante:** regra ou condição de fluxo; função ou componente novo; integração; transformação de dados; erro ou exceção; persistência; acesso; evento de websocket ou ferramenta MCP; refatoração que muda responsabilidade; trecho que afeta outra área. Linhas mecânicas dispensam comentário.
- **O que cada comentário diz:** o que mudou, por que mudou, como funciona, o impacto e as regras envolvidas, específico àquele trecho.
- **Frase vaga não serve:** "adicionada validação", "ajuste no fluxo", "melhorada a lógica".

### Como publicar

Dentro de um card do vibehub, a entrega sai pelo `vibehub_deliver` (`.claude/CLAUDE.md`, "Entrega"). Fora do runner, com o `gh` autenticado, siga os passos abaixo. Grave `pr-body.md` e `review.json` em **UTF-8** e **fora do repositório**.

1. Abra o PR com título e corpo explícitos, nunca `--fill` (ele põe a lista de commits como descrição):

   ```bash
   gh pr create --base <base> --title "<tipo(area): ...>" --body-file pr-body.md
   ```

2. Publique os comentários do diff como uma única revisão:

   ```bash
   gh api repos/<owner>/<repo>/pulls/<numero>/reviews --method POST --input review.json
   ```

   ```json
   {
     "commit_id": "<sha do último commit enviado>",
     "event": "COMMENT",
     "body": "O que cada bloco desta mudança faz, por que mudou e o impacto.",
     "comments": [
       { "path": "back/src/caminho/arquivo.ts", "line": 42, "side": "RIGHT", "body": "O que mudou, por que, como funciona, impacto e regras envolvidas." }
     ]
   }
   ```

   `line` é a linha no arquivo e tem de estar dentro do diff; `side: "RIGHT"` aponta para a versão nova e `"LEFT"` para uma linha removida; bloco de várias linhas leva também `start_line` e `start_side`.

3. **Confira o que saiu:** a revisão tem de estar `COMMENTED` e com o número de comentários enviado.

   ```bash
   gh api repos/<owner>/<repo>/pulls/<numero>/reviews --jq '.[] | {id, state}'
   gh api repos/<owner>/<repo>/pulls/<numero>/reviews/<id>/comments --jq 'length'
   ```

   Uma falha no meio pode deixar um rascunho (`PENDING`) que bloqueia a próxima publicação; apague-o (`gh api .../reviews/<id> --method DELETE`) e publique de novo.

### Commits

Todo commit, de pessoa ou de agente, segue o padrão de emojis do **Gitmoji**, e a tabela abaixo é a referência oficial; emoji novo entra na tabela por PR antes de ser usado.

```text
<emoji> <tipo>(<area>): <título claro e objetivo>

Descrição em pt-BR cobrindo, quando se aplicam: o que foi implementado
ou modificado; por que (em bug, a causa); como a solução foi aplicada
e a alternativa descartada; o problema resolvido; os impactos.
```

**Exemplo:**

```text
🐛 fix(sdk): login novo vale mesmo com tarefa em segundo plano

Quando o OAuth do CLI morria, o driver não reabria o CLI enquanto
houvesse tarefa em segundo plano viva, e o /login novo nunca entrava
em vigor. Agora a falha de login libera a reabertura no próximo turno;
com login saudável a tarefa em segundo plano continua protegida.
```

- **Emoji:** sempre um da tabela, o da intenção principal do commit.
- **Tipo** logo depois do emoji, em inglês, o mesmo vocabulário do título do PR (que não leva emoji). **Área** entre parênteses, a mesma do título do PR.
- **Título** em pt-BR, curto, com o verbo da ação. **Descrição** complementa o título em vez de repeti-lo; "ajustes", "correções", "melhorias" não são descrição. Só fato: não afirmar teste que não rodou.
- **Uma alteração lógica e coerente por commit**, feito ao fechar cada etapa, nunca um único commit com tudo no fim. Só o título vale apenas para commit mecânico (rename que não muda contrato, formatação).
- **Merge commit também leva emoji:** `🔀 merge: ...`, sem área. No `gh pr merge`, passe o título com `--subject`, porque o padrão da ferramenta sai sem emoji.
- **Se a mensagem e o PR divergem, vale o PR.**
- **Mensagem já enviada não se reescreve** (operação de risco, §12): o que faltou vai para o PR.
- `💡` (comentário no código) só para as exceções da §3 e para corrigir o comentário antigo que a mudança tornou falso (§3, "Comentários"); `🦖` (compatibilidade com versão anterior) só com a decisão explícita de compatibilidade da §6.
- `✏️` só corrige erro de digitação. Trocar uma palavra que muda o sentido não é digitação: num identificador ou nome de teste, sem mudar comportamento, é `♻️`; num comentário que ficou falso, é `💡`.

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

- **PR pequeno e específico:** uma unidade lógica por PR. Se a mudança cria ou ajusta uma regra deste arquivo que o próprio código do PR segue, a regra vai no mesmo PR. Regra de processo que o PR só viveu (como revisar, entregar, quantas rodadas fazer) vai num PR próprio.
- **Mudança neste arquivo:** a regra é escrita para qualquer agente, em qualquer área. Tem de ser clara para quem nunca viu o repositório, dizer o que fazer e por quê, e funcionar fora do caso que a motivou. Fato que muda (ferramenta instalada, nome de branch) entra como condição ("se…"), não como verdade fixa.
- **Merge só com autorização explícita** (§12). Pendência que bloqueia, aberta, segura o merge mesmo com a ordem de merge já dada, até o aval daquela pendência ("A pendência deliberada é julgada", abaixo). Autorizado, o merge é **merge commit, nunca squash**, com o SHA verificado e o título no padrão Gitmoji: `gh pr merge <N> --merge --match-head-commit <sha> --subject "🔀 merge: ..."`. Depois do merge, confira o pipeline pós-merge (CI e publicação da imagem).
- **Testes e CI verdes antes do merge**, sem warning novo no CI.
- **Revisão independente antes do merge:** o diff passa por um revisor (pessoa ou agente) sem o contexto de quem o escreveu, que segue "Como revisar um PR", abaixo.

### Como revisar um PR

Quem revisa (pessoa ou agente) é o **portão do merge**, não um leitor de cortesia. Recebe o diff, este arquivo e o que o autor afirma (a descrição do PR, ou as mensagens dos commits quando o PR ainda não existe, como no fechamento da §12), sem a conversa de quem escreveu, e trabalha para **achar o que está errado**, não para confirmar o que o PR diz. "Passa nos testes" não aprova sozinho, e "o autor explicou" não substitui conferir.

- **Tente quebrar.** Para cada bloco relevante, procure a entrada, o estado, a ordem de eventos ou a corrida (dois cards, dois backends, reconexão no meio do turno) que produz resultado errado. Achado sem cenário concreto de falha (entrada ou estado → resultado errado) é opinião, não achado.
- **Prove cada achado.** Aponte o `arquivo:linha`. Em achado de comportamento, a prova mais forte é um teste que falha hoje; quando o revisor não pode escrever ou rodar o teste, vale o cenário concreto (entrada ou estado → resultado errado, com `arquivo:linha`). Violação de regra se prova citando a regra escrita deste arquivo e o trecho do diff que a viola. Separe o fato confirmado da hipótese e diga o que não verificou.
- **Confira o que o PR afirma.** Cada causa, número, linha citada, resultado de teste, medição de performance, pendência e justificativa da descrição e dos comentários no diff se confere no código. Afirmação falsa ou sem sustentação é achado, mesmo quando o código está certo.
- **Leia além do diff.** Confira:
  - quem chama e quem é chamado pelo trecho alterado;
  - quem consome o que mudou: o front, as ferramentas MCP, os scripts plantados nos containers e os pontos compartilhados (store, host executor, broadcast do websocket);
  - o contrato com terceiro (SDK e CLI do Claude, GitHub, Docker) pela documentação ou pela versão instalada (§6);
  - os dados já gravados nas instalações que o código novo vai ler (§6, §7);
  - o que acontece no deploy: cards e turnos em andamento, retomada após o reinício, runner reaproveitado e limites de terceiros (rate limit do GitHub, cota da conta Claude).
- **Confronte cada linha `+` com este arquivo**, seção por seção: nomes e arquivos (§2), `const` e comentários (§3), lugar, simplicidade e util (§4), frontend (§5), contratos e integrações (§6), dados (§7), performance (§8), erros (§9), acesso, shell e segredos (§10), testes (§11) e PR e commits (§14). Vale "trecho tocado = trecho auditado": o que o PR acrescentou ou alterou responde às regras como código novo; o que ficou fora do diff não entra.
- **O teste tem de provar.** Confira três coisas:
  - se ele falha sem a correção, pelo motivo certo;
  - se cobre o fluxo real, em vez de mockar a lógica interna (§11);
  - se o resultado depende do código, e não do relógio, da carga da máquina ou da ordem de execução.

  Teste que passa sem afirmar nada, ou cujo nome promete mais do que ele verifica, é achado.
- **A pendência deliberada é julgada.** Ela fica nos Pontos de atenção do PR (item 9), mesmo quando outra seção também a cita, ou na mensagem do commit quando o PR ainda não existe. Ela se sustenta quando o motivo é verdadeiro e fazer agora é impossível antes do merge (a integração que só roda depois do deploy) ou traz mais risco do que esperar. Pendência com motivo falso, ou que esconde uma violação simples de corrigir, é achado. O autor a declara; o revisor julga se ela se sustenta e diz isso na revisão; quem a aceita é quem autoriza o merge (o usuário, quando o trabalho é de um agente), explicitamente e para aquela pendência, depois de ler esse julgamento. O PR registra o aval (quem e quando); até lá ela segue bloqueando.
- **Defeito e violação de regra bloqueiam o merge.** Defeito real no que o PR escreveu (comportamento errado, falha, brecha, perda de dado), linha do diff que viola uma regra escrita deste arquivo e toda regressão em relação à `main`, mesmo pequena, bloqueiam até serem corrigidos ou virarem pendência aceita (item da pendência deliberada, acima). Não é sugestão. O que não viola regra nenhuma não bloqueia: é **deveria corrigir** ou **menor**, pelo critério abaixo.
- **As severidades, e o que acontece com cada uma:**
  - **bloqueia**: o item anterior, sempre com prova. É corrigido antes do merge, com o teste que prova o defeito quando ele é de comportamento, ou vira pendência aceita, com o motivo (item da pendência deliberada, acima). Código mais complicado que o necessário (§1.1, §4, §13) e nome que batiza com outro termo um conceito que o repo já nomeia (§1.7, §2) violam regra escrita e caem aqui.
  - **deveria corrigir**: melhoria no código que o próprio PR escreveu, que preserva o comportamento, que **nenhuma regra escrita exige** (se uma regra cobre o caso, é **bloqueia**) e que não depende de gosto: quem lê concordaria sem precisar escolher (uma mensagem de erro que já basta para o diagnóstico, mas pode citar o id que falta; a ordem dos casos de um teste que acompanha melhor o fluxo). O autor aplica sem perguntar e não segura o merge.
  - **decisão**: o que exige decidir intenção ou produto. Vira pergunta ao usuário (§12) e, enquanto estiver em aberto, o veredito é **não apto**.
  - **menor**: preferência ou troca (a repetição pequena que a §3 permite manter, um nome alternativo igualmente claro, uma refatoração maior) e o que está fora do escopo do PR (problema antigo fora do diff). Não é aplicado: fica registrado no PR como sugestão.
- **O formato da entrega segue o fluxo onde a revisão roda.** Os cards do vibehub que revisam PR, o de análise (`[vibehub · análise de PR]`) e o revisor da revisão em rodadas (`[vibehub · revisão de PR]`), seguem o contrato do prompt deles (`back/src/services/review/prompts.ts`): o JSON que o servidor lê, os vereditos por rodada e quem corrige (na análise, o próprio card; na revisão em rodadas, a IA do autor). As classes correspondem uma a uma: **bloqueia** = `blocking` com prova (`failing_test`, `rule` ou `scenario`), **deveria corrigir** = `improvement`, **decisão** = `question`, **menor** = `suggestion`; o achado que a verificação derrubou é `refuted` (na análise ele sai da lista; na revisão em rodadas ele vai no JSON, para ficar no histórico). Fora desses cards (o fechamento da §12, a revisão de uma pessoa), vale a lista abaixo.
- **Entregue** a lista do mais grave para o menos grave. Cada achado tem:
  - a severidade (**bloqueia**, **deveria corrigir**, **decisão** ou **menor**);
  - o `arquivo:linha`;
  - o defeito numa frase e o cenário de falha;
  - a evidência;
  - se é regressão em relação à `main`.

  Feche com o veredito: **apto** ou **não apto**, com o motivo.
- Cada achado tem resposta na thread dele: o commit e o teste que o resolvem, ou o motivo de ter virado pendência.

## 15. Onde cada coisa vive

| Camada | Conteúdo |
|--------|----------|
| `AGENTS.md` (este) | Todas as regras do projeto, para qualquer agente e pessoa |
| `.claude/CLAUDE.md` | Como o Claude Code trabalha aqui: ordem das etapas, mapa de skills, subagentes, fechamento e entrega; importa este arquivo e nunca repete regra dele |
| `.claude/settings.json` | Plugins habilitados, permissões e a profundidade de subagente |
| `eslint.config.js` | A parte deste arquivo que a máquina checa (`npm run lint:changed`) |
| `README.md`, `SECURITY.md` | Páginas públicas do repositório, sem regra de desenvolvimento |
| `back/src/services/brain/personas/*.md` | Instruções que o servidor MCP do vibehub entrega a todo card, código do produto |
| `docs/` | Documentação do projeto (arquitetura, API, processos do runner), não canônica para regra. Spec e plano das skills (brainstorming, writing-plans) ficam fora do repositório, em `/tmp/<card>/`, como referência do trabalho em curso |
| `CLAUDE.local.md` (raiz da worktree, não versionado) | Instruções do projeto escritas pelo vibehub em cada card; a seção `## Aprendizados` recebe o que o `vibehub_brain_learn` descobre: porta, runner, flakiness, fato de ambiente |
| Cérebro (`CLAUDE.md` do perfil, não versionado) | Instruções globais do runner, editadas na aba Dev → Cérebro |

Markdown versionado só existe nos lugares desta tabela (em `docs/`, só na raiz da pasta): `npm run lint:changed` reprova o `.md` que a branch commita fora deles. Regra de projeto nova entra neste arquivo; memória do agente, `CLAUDE.local.md` e Cérebro guardam fato de ambiente, nunca regra de código. Assunto que nenhuma camada documenta é pergunta ao usuário (§12), não convenção inventada.

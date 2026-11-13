# AGENTS.md — Regras de desenvolvimento do vibehub

> **Escopo:** regras obrigatórias para todo o repositório: backend (`back/`), frontend (`front/`), scripts, testes e refatorações.
>
> **Objetivo:** produzir código correto, legível, simples, performático, seguro e fácil de manter — sem burocracia ou abstrações sem benefício.
>
> **O projeto:** IDE hospedada para agentes de código — um kanban de terminais Claude Code reais rodando em containers no servidor do próprio usuário. Backend Fastify, servidor MCP próprio (`back/src/mcp/`), persistência em JSON atômico (`back/src/store/`), runner Docker local ou via SSH (`back/src/runtime/host.ts`). Frontend React + Vite + React Query + Radix/Tailwind. Projeto **público (MIT) e auto-hospedado**: cada instalação tem os próprios dados, então contrato persistido não muda sem migração.
>
> **Regra de aplicação:** as regras gerais são **independentes do domínio** e não presumem entidades, telas ou fluxos de um módulo. As referências concretas a arquivos do vibehub são exemplos e pontos de entrada; os contratos reais saem da inspeção do trecho modificado (§12, passo 1). **Cada regra vale pelo princípio, não pela lista de exemplos:** caso não citado se resolve pelo espírito da regra mais próxima, e na dúvida se pergunta.
>
> **Fonte única:** este arquivo é a fonte das regras de código. O `CONTRIBUTING.md` é o resumo para contribuidores externos e não pode contradizê-lo.

## 1. Regras inegociáveis

1. **Simples, bem feito:** escolha a solução com menos conceitos e indireções que preserve todas as garantias necessárias. Menos linhas, por si só, não significa mais simplicidade.
2. **Sem voltas:** não crie wrappers que apenas repassam chamadas, múltiplas camadas sem responsabilidade, factories artificiais ou generalizações para um futuro hipotético.
3. **Siga o idioma do código existente:** identificadores e comentários em inglês; texto visível ao usuário sempre pelo i18n, nos dois idiomas (§2).
4. **`const` por padrão:** usar `let` apenas para reatribuição necessária. Nunca usar `var`.
5. **Sem código morto:** remover branches inúteis, imports não usados, dados que não são lidos e funcionalidades sem consumidor — depois de verificar referências.
6. **Comentário explica o porquê, nunca o quê:** várias linhas estranhas do repo são cicatrizes de bug em produção; quem corrige uma deixa a história registrada.
7. **Contratos explícitos:** um significado deve ter uma representação canônica. Não criar variantes de campos, formatos ou comportamentos silenciosamente compatíveis.
8. **Falhe de forma visível:** não mascarar violação de contrato com fallbacks, retornos vazios ou tratamento que aparenta sucesso.
9. **Segurança na origem:** validar entrada e autorizar operações nas fronteiras. Tudo que chega a um shell é validado na fronteira e citado depois; segredo viaja por stdin, nunca por argv (§10).
10. **Performance com critério:** evitar leituras, execuções remotas, cálculos e renderizações desnecessários. Não introduzir cache ou memoização por reflexo.
11. **Mudança completa, escopo controlado:** corrigir todos os consumidores afetados sem reescrever partes alheias à tarefa.
12. **Verificação real:** nunca declarar que testes, build, revisão ou deploy passaram sem executá-los e observar o resultado.

**Ordem de prioridade em conflitos:** segurança e integridade dos dados → correção e contratos → simplicidade e clareza → performance → estilo. Uma regra de estilo não justifica comportamento incorreto ou risco.

## 2. Idioma e nomenclatura

- **Código em inglês:** variáveis, funções, tipos, componentes, campos persistidos e comentários seguem o padrão do repositório, que é público. Não misturar identificadores em português num arquivo em inglês.
- **Texto de interface sempre pelo i18n** (`front/src/i18n/en.ts` e `pt-BR.ts`). Toda chave nova entra nos dois arquivos; nunca string literal visível no JSX.
- **Commits, PRs e documentação de processo (`docs/`, este arquivo) em pt-BR.**
- Não renomear contratos persistidos (`board.json` e afins), rotas HTTP, ferramentas MCP ou variáveis de ambiente só por estética. Isso é mudança de contrato (§6).
- Funções usam **verbo preciso + objeto** (`assertMovableColumn`, `normalizeCardIds`). Variáveis descrevem conteúdo e função. Evitar `data`, `tmp`, `result`, `x` e abreviações opacas.
- **Todo nome se lê sem abrir a implementação**, inclusive parâmetro de callback e variável de laço (`row`, não `r`). Uma coisa tem um nome só no mesmo escopo.
- Não usar verbos genéricos como `process`, `handle`, `manage` quando houver ação mais precisa.
- Nomes de variantes deixam claras as duas diferenças (`originalValue` e `convertedValue`, não `value` e `convertedValue`).
- Convenções: `camelCase` para funções/variáveis, `PascalCase` para componentes/classes/tipos, `UPPER_SNAKE_CASE` para constantes realmente estáticas (`EXEC_TIMEOUT_MS`); hooks começam com `use`.
- Se uma cadeia de `filter`/`map`/`sort` esconder regra importante, nomear as etapas intermediárias.

## 3. Estilo e qualidade de código

- Preferir funções coesas com entrada, saída e responsabilidade claras. Não impor limite mecânico de linhas.
- Usar retornos antecipados para reduzir aninhamento quando melhorar a leitura. Não comprimir regras complexas em ternários encadeados.
- Não duplicar **regra de negócio** ou fonte de verdade. Repetição pequena e local pode ser melhor que uma abstração genérica sem significado.
- Importações estáticas no topo. Import dinâmico só por carregamento sob demanda, dependência circular real ou outra restrição técnica fundamentada.
- Usar `async` quando houver execução assíncrona ou obrigação de retornar `Promise`; não tornar uma função assíncrona por costume.
- Não criar `try/catch` que só captura e relança o mesmo erro sem acrescentar informação ou comportamento.
- Não engolir erros, não retornar sucesso falso e não adicionar `setTimeout`/retries para esconder uma falha de fluxo.
- Não criar flags, estados, campos ou leituras que ninguém consome.
- Efeito colateral é explícito: função que grava, apaga ou muda estado diz isso no nome (`save`, `delete`, `set`…); um `get`/`read`/`parse` não grava nada.
- **Cálculo e efeito em etapas separadas:** o que calcula (incluindo callbacks de `filter`/`map`/`find`) só devolve valor; o que envia, grava ou notifica vem depois, em passo próprio.
- Reaproveitar utilitários e dependências **realmente existentes** antes de escrever abstrações novas ou instalar bibliotecas.
- Respeitar o formatter e a organização do repositório. Não reformatar arquivos inteiros que não participam da tarefa.
- **Comentários:** acompanhar a densidade do arquivo tocado. Módulos centrais abrem com um bloco que explica a responsabilidade e as invariantes (veja `runtime/host.ts`, `auth/access.ts`) — ao mudar uma invariante, atualize o bloco. Não narrar linhas óbvias.

## 4. SOLID, coesão e abstrações

Aplicar SOLID como **princípios de desenho**, não como obrigação de criar classes:

- **S — Responsabilidade única:** funções, componentes, hooks e serviços agrupam o que muda pelo mesmo motivo.
- **O — Aberto/fechado:** variantes reais não devem exigir espalhar mudanças; não criar estratégias ou registries para um caso hipotético.
- **L — Substituição:** implementações do mesmo contrato preservam semântica, erros e invariantes (ex.: o host executor `local` e `ssh` têm o mesmo contrato).
- **I — Segregação:** tipos e interfaces coesos, representando necessidades concretas.
- **D — Inversão de dependência:** isolar dependências externas ou instáveis (Docker, SSH, GitHub, SDK do Claude) quando isso trouxer testabilidade ou proteção de fronteira.

**Antes de criar uma abstração, responder:** que responsabilidade ela protege? O que pioraria se fosse removida? Existe mais de um comportamento real? Protege uma fronteira, uma invariante ou uma duplicação relevante?

- Não criar factory, adapter, service, interface, helper, hook ou arquivo **só por padrão arquitetural**.
- Não exigir dois consumidores como regra absoluta: uma abstração única pode ser necessária para isolar uma fronteira externa ou uma invariante.
- Não juntar tudo num arquivo para "reduzir estrutura": separar responsabilidades reais continua obrigatório.
- Uma camada que apenas encaminha argumentos sem decisão, transformação ou proteção de fronteira deve ser eliminada quando seguro.
- **KISS**, **YAGNI** e **DRY** com julgamento. Entre duas opções igualmente corretas, preferir a que exige menos conceitos.

## 5. Frontend, React e TypeScript

1. **Código novo usa export nomeado**, a maioria do repositório. Os `export default` existentes (`App.tsx`, `BoardPage.tsx`, `LoginPage.tsx`, `SetupWizard.tsx` e outros) não são convertidos de carona (§12.6).
2. **Componente focado em renderização e composição.** Regra de domínio vira função pura em `features/<área>/lib/*.ts`, com teste ao lado; orquestração com estado vira hook `use*.ts`; chamada HTTP fica em `api.ts` da feature.
3. **Não criar hook artificial:** estado visual simples ou handler sem regra pode ficar no componente.
4. **Contratos HTTP tipados num lugar só** (`front/src/api/types.ts`), espelhando o backend. Tipos locais de uma feature ficam fora do componente.
5. Evitar `any`, casts sem fundamento, estados impossíveis e interfaces redundantes.
6. Não usar `useMemo`, `useCallback` ou `React.memo` indiscriminadamente — só com cálculo custoso, identidade referencial relevante ou benefício demonstrável.
7. Não suprimir regras de hooks nem remover dependências de efeitos para esconder renderizações. Corrigir o fluxo.
8. **Efeito e estado com papel único:** cada efeito sincroniza uma coisa; todo estado é lido por alguém. Estado criado só para disparar outro código indica fluxo errado.
9. Evitar lógica de negócio e transformação complexa dentro do JSX.
10. Derivar valores da fonte em vez de manter estados sincronizados para o mesmo fato. Dado do servidor mora no React Query, não copiado em `useState`.
11. Reutilizar as primitivas de `components/ui` (Radix + Tailwind) antes de criar versões novas.
12. Tratar carregamento, vazio, erro, sucesso e envio duplicado quando pertinentes.
13. Não disparar requisições em renderização nem por efeito descontrolado.
14. Esconder ação na UI é experiência; quem autoriza é o backend.

## 6. Contratos, schemas e integrações

- Antes de mudar um campo, tipo, payload, rota, ferramenta MCP, evento de websocket ou função consumida por outros arquivos, localizar **todos os consumidores** — inclusive o front, o runner e os scripts plantados nos containers.
- **Uma informação, um nome canônico.** Não manter formatos paralelos "por segurança".
- Contrato **interno** mudou: atualizar todos os consumidores na mesma alteração, sem `newField ?? oldField` nem shims automáticos.
- **Dado persistido é contrato externo:** cada instalação auto-hospedada tem seu `board.json` e afins. Mudança de shape exige leitura compatível ou migração explícita e testada, nunca quebra silenciosa.
- Contratos com terceiros (SDK e CLI do Claude, GitHub, Docker) seguem a especificação deles; mudança de versão exige conferir o comportamento real, não a memória.
- Validar na entrada, com o padrão do ponto de entrada: ferramentas MCP com **zod** no schema da ferramenta; rotas HTTP chamam a função do registry/service que valida e lança, e a rota converte o erro de validação em 400 (e "not found" em 404). Dentro do fluxo já validado, confiar no tipo.
- Comparar e referenciar entidades por **id**, nunca por nome, título ou texto, inclusive o que o próprio código acabou de criar.
- Dado editável vive na sua fonte (configuração, cadastro, store). Não congelar no código ids, nomes, listas ou códigos que mudam.
- Dado composto (autor, motivo, origem, instante, referência) vai em campos próprios, não concatenado num texto.
- Centralizar enums e discriminantes (`as const` / union de literais) numa definição única, sem mapas paralelos descoordenados. `switch` cobre todas as variantes; variante sem suporte falha visivelmente.
- Campos opcionais novos ficam ausentes quando não informados, a menos que `null` seja um estado de domínio explícito.
- Em atualização parcial, distinguir **campo não enviado** de campo enviado com `0`, `false`, `""` ou `null`.

## 7. Dados, fonte de verdade e consistência

- Cada conceito tem uma **fonte de verdade identificável**. Não persistir cópias de valores que podem ser obtidos da fonte, nem as duas direções do mesmo relacionamento. Snapshot ou materialização só como exceção explícita, com motivo, origem e regra de atualização definidos.
- Estado JSON do vibehub em `VIBEHUB_DATA_DIR` (`board.json` e afins) passa pelo **store** (`back/src/store/`: `JsonStore`, `writeFileAtomic`). Exceções intencionais ficam documentadas no próprio arquivo — ex.: os marcadores de `services/sdk/inflight.ts`, gravados com `writeFile` numa fila por card, e os arquivos que os scripts de `workspace.ts` gravam dentro do container.
- **Não gravar durante leitura** para sincronizar cálculos.
- Operações que podem rodar em paralelo ou repetir (hooks de status, retomada após deploy, deliver, provisionamento) precisam ser **idempotentes** e seguras em corrida. Vários cards trabalham ao mesmo tempo no mesmo runner.
- Nunca introduzir migração, limpeza ou exclusão de dados reais (worktrees, transcripts, volumes, containers) sem avaliação, `dry-run` quando aplicável e autorização.
- Remover escrita, campo ou leitura sem consumidor só depois de verificar quem lê.

## 8. Performance e eficiência

**O objetivo é executar menos trabalho real, não escrever o código mais curto.**

- Cada `docker exec`/SSH é caro e disputa o runner com os outros cards. Agrupar comandos num script só quando forem do mesmo passo; não abrir uma execução remota por item de lista.
- Não reler ou regravar o estado inteiro por item quando uma operação em lote resolve.
- Websocket e polling: emitir só o que mudou e só para quem pode ver. Não criar polling para mascarar evento faltando.
- No front, evitar fetch redundante, renders desnecessários e processamento caro em renderização. Paginar ou virtualizar só quando a escala justificar.
- Código que roda a cada atualização trabalha só sobre o que mudou, não refaz o todo.
- Cache, deduplicação e batch só por benefício concreto, com invalidação e ciclo de vida definidos.

## 9. Validação, erros e fallback

- Validar **nas fronteiras**: HTTP, websocket, hooks vindos do runner, ferramentas MCP, entrada de CLI e respostas de integrações.
- **Guard impõe contrato; fallback mascara erro.** Campo obrigatório ausente vira erro observável, não `""`, `0`, `null` ou `[]`.
- Usar `??`, `||` ou `?.` só quando a ausência faz parte do contrato real.
- **Dependência ausente falha à vista:** chamada sem destino (sessão, conexão, ouvinte) gera erro ou é impedida pelo tipo, nunca vira no-op silencioso.
- Distinguir presença de verdade lógica: `0` e `false` podem ser valores válidos.
- Erro informa o suficiente para diagnóstico sem expor token, segredo ou caminho sensível.
- Integração que falhou não aparece como concluída. Retry só limitado e idempotente.
- Exceção não é ignorada: registrar e propagar até a fronteira responsável.

## 10. Segurança, autorização e escopo

- **Acesso decidido pelos preHandlers de `back/src/auth/`:** o que é da INSTALAÇÃO exige dono (`requireOwner`, em `session.ts`); o que é TRABALHO de um card segue o compartilhamento (`access.ts`) — `requireCardAccess` para ler, `requireCardWork` para mudar qualquer coisa; rota do próprio usuário, sem card (`/api/me/*`, listagens), exige só sessão (`requireSession`). Toda rota nova usa um desses. A checagem base vem do helper; filtro por usuário no handler (o que ele alcança, se é dono) só restringe o que o helper já liberou.
- Permissão de leitura (`view`) nunca autoriza mutação. Listagens filtram pelo que o usuário alcança, não pelo que existe.
- **Shell:** tudo que vira linha de `docker exec` ou script (ids de card, branch, sessão, container) é validado na fronteira e citado depois. Leia `back/src/runtime/host.ts` antes de montar um comando.
- **Segredos por stdin, nunca argv** (`ps` é legível por todos). Credenciais moram no cofre criptografado (`back/src/secrets/`), nunca em log, resposta HTTP ou mensagem de erro.
- **Identidade git é do card:** commit, push e PR saem com a conta de quem deu a ordem. Não contornar com outra credencial.
- Outros pontos de entrada (hooks do runner, MCP, websocket) têm limite de confiança próprio — token do runner, sessão — e não presumem que passaram pelo HTTP autenticado.
- Verificar caminhos permitidos e negados, inclusive chamando a API direto.

## 11. Testes e critérios de correção

- **Mudança de comportamento ou bug é sempre em TDD:** escrever o teste primeiro, rodar e ver falhar pelo motivo certo (em bug, reproduzindo o erro que aconteceu) e só então implementar até passar. Teste que nunca foi visto falhando não prova nada.
- Mudança de comportamento exige testes proporcionais ao risco. **Vitest** nos dois pacotes, com o teste ao lado do código (`*.test.ts` / `*.test.tsx`). Priorizar o fluxo real; teste unitário complementa quando isola regra complexa.
- Usar a infraestrutura de teste existente; não criar infraestrutura paralela. No front ela é Vitest + Testing Library + jsdom (`front/vitest.config.ts`, helper `renderApp` em `front/src/test/render.tsx`).
- Dado de teste sai do fluxo real ou de fábrica fiel ao contrato; não inventar shape que não existe em produção.
- Mockar só **fronteiras externas**: host executor (Docker/SSH), rede, GitHub, SDK do Claude. Não mockar a lógica interna só para facilitar asserções.
- Rotas HTTP: testar entrando pela rota real, com validação e acesso (dono, `work`, `view`, sem acesso).
- Verificar efeitos observáveis: estado persistido, script enviado ao host, payload emitido, UI atualizada, erro esperado.
- No front, testar interação, estados de carregamento/erro/sucesso e o contrato enviado/recebido.
- Cobrir caminho principal, falhas e bordas; somar corrida, idempotência e retomada quando fizerem parte do risco.
- Não escrever teste que só valida a hipótese da própria IA. Ler o contrato real antes de definir o resultado esperado.

**Rodar testes no runner: curto, só do que você tocou.** A suíte inteira leva muitos minutos, disputa CPU com os outros cards e costuma ser morta por um deploy.

1. **Enquanto trabalha:** só o arquivo do que mexeu, filtrado pelo caso — `cd back && npx vitest run src/services/sdk/manager.test.ts -t "órfã"`.
2. **Antes de entregar:** `npm run test:changed` (raiz), o mesmo recorte do gate (`.vibehub/gate.json` → `scripts/gate-changed.sh`). Junto, o typecheck do pacote tocado, o mesmo do CI:
   - **front:** `npx tsc -b`. O `tsconfig.json` é uma solution com project references, então `tsc --noEmit -p` não checa nada e dá verde falso.
   - **back:** `npx tsc --noEmit`. `tsc -b` emitiria JS em `back/dist`. O `tsconfig.json` do back exclui `*.test.ts`: erro de tipo em teste só aparece ao rodar o teste.
3. **Nunca** `npm test` ou `npx vitest run` sem filtro no runner. A suíte inteira é do CI: confira com `gh pr checks <N>`.
4. Teste de tempo (limite em ms) que falha de vez em quando sob carga não é regressão sua. Confirme rodando sem a sua mudança; se já era instável, diga no PR e siga.

Se um comando de teste for passar de ~2 min, troque por um recorte menor. Não afirmar que algo passou sem executar; se não deu para testar, relatar **o que foi e o que não foi validado**.

## 12. Processo obrigatório de trabalho do agente

- **Teve dúvida, pergunta.** Requisito ambíguo, mais de um caminho razoável ou decisão que é do usuário: perguntar antes de implementar, com opções e uma recomendação.
- **Explorar antes de construir.** Feature nova ou mudança de comportamento com alternativas passa por brainstorming: requisitos, abordagens com prós e contras, recomendação, e execução só com o caminho aprovado.
- **Usar as skills de processo disponíveis** sem esperar ser mandado: debugging sistemático antes de propor fix, TDD na implementação, plano escrito para tarefa de várias etapas, verificação antes de declarar pronto, code review depois de implementar.
- **Pedido de diagnóstico é leitura e explicação**, não edição.
- **Discordar com fundamento faz parte do trabalho.**

1. **Inspecionar antes de editar:** arquivos, fluxo, fonte de verdade, contratos, padrões e testes relevantes.
2. **Localizar consumidores:** chamadas, imports, rotas, ferramentas MCP, scripts do runner e telas impactadas.
3. **Definir escopo:** a menor alteração que resolva **o problema completo**.
4. **Implementar de ponta a ponta:** consumidores, contratos, validação, acesso, i18n e testes na mesma entrega.
5. **Auditar o trecho tocado:** nomes, código morto, duplicação, fallback indevido, leituras inúteis.
6. **Não espalhar alterações:** problema vizinho que exige refatoração arriscada é comunicado, não corrigido de carona.
7. **Validar:** testes do recorte, typecheck e build quando aplicável; revisar o diff.
8. **Revisão independente antes de entregar:** terminado tudo o que foi pedido, o diff passa, nesta ordem, por **simplificação** (aplicada) e por **code review** (correção, aderência às regras e o que foi inventado), ambas feitas por um revisor SEM o contexto de quem escreveu e confrontando este arquivo. Achado confirmado é corrigido; o descartado tem o motivo dito. O que a simplificação mudar volta pelo passo 7 antes do code review. Como rodar isso em cada ferramenta fica no arquivo dela (no Claude Code, `.claude/CLAUDE.md`).
9. **Descrever o resultado:** o que mudou, o que foi verificado e as limitações reais.

### Autonomia corretiva e preservação do escopo

Pedir autorização e passar por brainstorming continua obrigatório para decisões de produto, mudança de escopo, funcionalidade nova, mudança de comportamento intencional e tudo cuja intenção não esteja clara. A exceção: **o agente corrige sozinho problema real naquilo que já foi definido, pedido ou implementado**, sem parar para pedir licença e sem brainstorming:

- bug e erro de lógica;
- incongruência entre funcionalidades e regras de negócio;
- regressão introduzida durante o desenvolvimento;
- comportamento que contraria claramente o requisito estabelecido;
- falha de integração, validação ou consistência;
- ajuste técnico necessário para o que já existe funcionar corretamente.

**Limites:** autonomia corretiva não amplia escopo. Não implementar funcionalidade extra só porque parece útil; não alterar decisão intencional, fluxo estabelecido ou regra de negócio por preferência técnica; não remover, substituir ou simplificar o que não se entende; não tratar oportunidade de melhoria como autorização. Melhoria, refatoração, volta desnecessária e o que foge do propósito viram **sugestão**, não execução.

**Na dúvida, pergunta:** se a correção exige decidir intenção, comportamento esperado ou direção do projeto, apresentar o problema e as consequências e perguntar antes de agir. Quando o comportamento esperado está claro e a falha é comprovada, corrigir sem transferir ao usuário uma decisão técnica que não precisa dele.

**Princípio:** o agente tem autonomia para preservar, corrigir e garantir a integridade do que foi definido e construído, não para redefinir o que o projeto deve ser.

**Operações de risco:** exclusão de dados, mudança incompatível de contrato persistido, alteração de acesso, deploy e merge exigem as autorizações existentes. **Merge em `main` é deploy.** Não presumir consentimento.

## 13. Revisão final (antes de entregar)

- [ ] Resolvi o problema sem voltas, camadas ou abstrações artificiais?
- [ ] Nomes seguem o padrão do arquivo (inglês, legíveis sem abrir a implementação) e todo texto de tela está no i18n nos dois idiomas?
- [ ] Cálculo separado de efeito, cada estado e efeito com papel único?
- [ ] `const` como padrão, sem `var`, comentário óbvio ou código morto? Invariante mudada teve o comentário de bloco atualizado?
- [ ] Componentes renderizam; regra está em `lib/` ou hook; contratos em `api/types.ts`?
- [ ] Não dupliquei contrato, dado, estado ou fonte de verdade?
- [ ] Dado persistido de instalações existentes continua legível?
- [ ] Entrada validada na fronteira, shell citado, segredo fora de argv e de log?
- [ ] Rota nova com `requireOwner` / `requireCardAccess` / `requireCardWork` / `requireSession` adequado?
- [ ] Operações repetíveis são idempotentes e seguras em corrida?
- [ ] Escrevi o teste antes e o vi falhar pelo motivo certo?
- [ ] Rodei o recorte de testes e o `tsc -b`, e conferi o diff?
- [ ] O diff passou pela simplificação e pelo code review independentes contra este arquivo?
- [ ] Afirmei apenas o que foi executado e verificado?

**Regra de encerramento:** se o código funciona, mas exige conceitos, estados, leituras, arquivos ou indireções desnecessários, simplificar **antes de entregar**, preservando correção, integridade, segurança e testes.

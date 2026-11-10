# AGENTS.md — Regras globais de desenvolvimento

> **Escopo:** regras obrigatórias para todo o repositório, incluindo módulos existentes, módulos futuros, frontend, backend, integrações, rotinas, testes e refatorações.
>
> **Objetivo:** produzir código correto, legível, simples, performático, seguro e fácil de manter — sem burocracia ou abstrações sem benefício.
>
> **Regra de aplicação:** estas instruções são **independentes do domínio**. Não presumem nomes de entidades, telas, permissões, fluxos ou estruturas de um módulo específico. Antes de implementar, o agente deve descobrir os contratos e padrões reais do trecho que está modificando.
>
> **Fonte única:** este arquivo substitui os documentos antigos de regras gerais. Não criar outros arquivos concorrentes de regras para repetir o que já está aqui.

## 1. Regras inegociáveis

1. **Simples, bem feito:** escolha a solução com menos conceitos e indireções que preserve todas as garantias necessárias. Menos linhas, por si só, não significa mais simplicidade.
2. **Sem voltas:** não crie wrappers que apenas repassam chamadas, múltiplas camadas sem responsabilidade, factories artificiais ou generalizações para um futuro hipotético.
3. **Código em português brasileiro:** nomes novos de domínio, funções, variáveis, componentes, tipos, mensagens próprias e documentação em pt-BR; preservar APIs técnicas e contratos externos.
4. **`const` por padrão:** usar `let` apenas para reatribuição necessária. Nunca usar `var`.
5. **Sem código morto:** remover branches inúteis, imports não usados, dados que não são lidos, consultas redundantes e funcionalidades sem consumidor — depois de verificar referências.
6. **Sem comentários desnecessários:** o código deve explicar *o que faz* pelos nomes e pela estrutura. Comentar apenas decisões não evidentes, limitações externas ou exceções justificadas.
7. **Contratos explícitos:** um significado deve ter uma representação canônica. Não criar variantes de campos, formatos ou comportamentos silenciosamente compatíveis.
8. **Falhe de forma visível:** não mascarar violação de contrato com fallbacks, retornos vazios ou tratamento que aparenta sucesso.
9. **Segurança na origem:** validar entrada e autorizar operações nas fronteiras adequadas. O frontend nunca substitui autorização do backend.
10. **Performance com critério:** evitar consultas, transferências, cálculos e renderizações desnecessários. Não introduzir cache ou memoização por reflexo.
11. **Mudança completa, escopo controlado:** corrigir todos os consumidores afetados sem reescrever partes alheias à tarefa.
12. **Verificação real:** nunca declarar que testes, lint, build, revisão ou deploy passaram sem executá-los e observar o resultado.

**Ordem de prioridade em conflitos:** segurança e integridade dos dados → correção e contratos → simplicidade e clareza → performance → estilo. Uma regra de estilo não justifica comportamento incorreto ou risco.

## 2. Idioma e nomenclatura

- Todo identificador **novo e controlado pelo projeto** deve ser escrito em **português do Brasil**, incluindo variáveis, funções, classes, tipos, interfaces, hooks, componentes, propriedades internas e campos novos de domínio.
- Não traduzir sintaxe ou APIs de terceiros: `const`, `Promise`, `useState`, `useEffect`, `onClick`, `ObjectId`, nomes de bibliotecas, headers, campos de protocolos e formatos externos permanecem como definidos por suas especificações.
- Não renomear contratos persistidos, públicos ou consumidos externamente **só para traduzir**. Uma mudança desse tipo exige análise de impacto e migração quando aplicável.
- Funções usam **verbo preciso + objeto/conceito**, por exemplo `buscarRegistroPorId`, `calcularValorTotal`, `validarIntervalo`.
- Variáveis descrevem **conteúdo e função**, por exemplo `registrosAtivos`, `totalCalculado`, `limitePermitido`. Evitar `data`, `doc`, `arr`, `tmp`, `result`, `x`, `valor2` e abreviações opacas.
- Não usar verbos genéricos como `processar`, `resolver`, `gerenciar`, `handle` quando houver uma ação mais precisa.
- Referências nomeiam a entidade apontada; nomes de variantes precisam deixar claras as duas diferenças (`valorOriginal` e `valorConvertido`, não `valor` e `valorConvertido`).
- Convenções: `camelCase` para funções/variáveis, `PascalCase` para componentes/classes/tipos, `MAIUSCULAS_COM_UNDERLINE` para constantes realmente estáticas quando esse for o padrão local; hooks começam com `use`.
- Evitar nomes excessivamente longos: o objetivo é entender o significado **sem abrir a implementação**, não descrever cada detalhe operacional no identificador.
- Se uma cadeia de `filter`/`map`/`sort` esconder regra importante, nomear etapas intermediárias que representem conceitos do domínio.
- Em código legado tocado, melhorar nomes ruins **dentro do escopo seguro da alteração**. Se renomear repercutir em contratos/dados ou muitos consumidores, tratar como mudança de contrato, não como ajuste cosmético.

## 3. Estilo e qualidade de código

- Preferir `const`. Usar `let` exclusivamente quando o vínculo da variável precisar mudar; não usar `var`.
- Preferir funções coesas com entrada, saída e responsabilidade claras. Não impor limite mecânico de linhas.
- Usar retornos antecipados para reduzir aninhamento quando melhorar a leitura. Não comprimir regras complexas em ternários encadeados ou one-liners difíceis de depurar.
- Não duplicar **regra de negócio** ou fonte de verdade. Repetição pequena e local pode ser melhor que uma abstração genérica sem significado.
- Importações estáticas no topo. Import dinâmico somente quando for necessário por carregamento sob demanda, dependência circular real ou outra restrição técnica fundamentada.
- Usar `async` quando houver execução assíncrona ou obrigação de retornar `Promise`; não tornar uma função assíncrona por costume.
- Não criar `try/catch` que só captura e relança o mesmo erro sem acrescentar informação ou comportamento.
- Não engolir erros, não retornar sucesso falso e não adicionar `setTimeout`/retries para esconder uma falha de fluxo.
- Não criar flags, estados, variáveis, campos ou consultas que ninguém consome.
- Evitar efeitos colaterais implícitos; deixar explícitas as operações que alteram estado ou dados.
- Reaproveitar utilitários e dependências **realmente existentes** antes de escrever novas abstrações ou instalar bibliotecas.
- Respeitar o formatter, o linter, as convenções e a organização configurados no repositório. Não formatar arquivos inteiros que não participam da tarefa.
- Padrão: **sem comentários em arquivos de código**. Exceção: justificativa curta de decisão não óbvia, regra externa, limitação técnica, otimização comprovada ou incompatibilidade deliberada. Não usar comentários para narrar linhas óbvias.

## 4. SOLID, coesão e abstrações

Aplicar SOLID como **princípios de desenho**, não como obrigação de criar classes:

- **S — Responsabilidade única:** funções, componentes, hooks e serviços devem agrupar responsabilidades que mudam pelo mesmo motivo.
- **O — Aberto/fechado:** estruturar variantes reais de forma que novos casos não exijam espalhar mudanças; não criar estratégias ou registries para apenas um caso hipotético.
- **L — Substituição:** implementações do mesmo contrato devem preservar semântica, entradas, saídas, erros e invariantes esperados.
- **I — Segregação:** interfaces e tipos devem ser coesos, representando necessidades concretas; evitar contratos gigantes para todos os consumidores.
- **D — Inversão de dependência:** isolar dependências externas ou instáveis quando isso trouxer testabilidade, troca de implementação ou proteção de fronteiras reais.

**Antes de criar uma abstração, responder:** que responsabilidade ela protege? O que pioraria se fosse removida? Existe mais de um comportamento real? Protege uma fronteira, uma invariante ou uma duplicação relevante?

- Não criar `factory`, `repository`, `adapter`, `useCase`, `service`, interface, helper, hook ou arquivo **só por padrão arquitetural**.
- Não exigir dois consumidores como regra absoluta: uma abstração única pode ser necessária para isolar uma fronteira externa ou uma invariante importante.
- Não transformar o projeto inteiro em um arquivo para reduzir estrutura: separar responsabilidades reais continua obrigatório.
- Uma camada que apenas encaminha argumentos sem decisão, transformação, controle de transação ou proteção de fronteira deve ser eliminada quando seguro.
- Seguir **KISS**, **YAGNI** e **DRY** com julgamento: não antecipar necessidades, não generalizar cedo, não sacrificar clareza para eliminar duas linhas repetidas.
- Quando duas opções são igualmente corretas, seguras e testáveis, preferir a que exige menos conceitos para entender e manter.

## 5. Frontend, React e TypeScript

Estas regras se aplicam **a qualquer tela ou módulo React atual ou futuro**:

1. **`export default`** para telas e componentes reutilizáveis principais. Usar exports nomeados para tipos, funções auxiliares e utilitários quando apropriado.
2. **Componente focado em renderização e composição.** Regras de domínio, orquestração de chamadas, handlers complexos e estados complexos ficam em custom hooks (`use*.ts` ou `use*.tsx`).
3. **Não criar hook artificial:** estado visual simples, alternância trivial ou handler sem regra de negócio podem permanecer no componente.
4. **Tipos fora dos componentes:** `type` e `interface` devem ficar em arquivo de tipos do módulo (por exemplo `types.ts` ou `types/`), reutilizando contratos já existentes.
5. Evitar `any`, casts sem fundamento, estados impossíveis e interfaces redundantes. Tipar dados de entrada, saída e erros conforme os contratos reais.
6. Não usar `useMemo`, `useCallback` ou `React.memo` indiscriminadamente. Empregar quando houver cálculo custoso, identidade referencial relevante, filhos memoizados ou benefício demonstrável.
7. Não suprimir regras de hooks nem remover dependências de efeitos para esconder renderizações. Corrigir o fluxo.
8. Evitar lógica de negócio, normalização de contratos e transformação complexa dentro do JSX.
9. Preferir derivar valores diretamente do estado/fonte, em vez de armazenar múltiplos estados sincronizados para o mesmo fato.
10. Reutilizar design system, componentes e padrões visuais existentes antes de criar versões novas.
11. Tratar estados de carregamento, vazio, erro, sucesso e prevenção de envio duplicado quando pertinentes.
12. Não disparar requisições indevidamente em renderizações; evitar fetch repetido por evento/efeito descontrolado.
13. Permissões no frontend controlam visibilidade e experiência. A execução deve ser autorizada pelo backend.

## 6. Contratos, schemas, enums e integrações

- Antes de mudar um campo, tipo, payload, schema, enum, endpoint ou função consumida por outros arquivos, localizar **todos os call-sites e consumidores**.
- **Uma informação, um nome/contrato canônico.** Não manter chaves em dois idiomas, payloads duplicados ou formatos paralelos apenas “por segurança”.
- Mudanças de contrato **interno controlado** exigem atualizar todos os consumidores afetados na mesma alteração. Não criar `novoCampo ?? campoAntigo`, shims ou reexports temporários automaticamente.
- **Compatibilidade externa é uma decisão explícita:** se um contrato é público, versionado ou consumido por terceiro, identificar impacto e preservar/coordenar transição quando necessário. Nunca quebrar contrato externo sem análise.
- Comparar, consultar e referenciar entidades por **ID, chave técnica ou enum estável**. Não usar nome, descrição ou texto livre como identificador.
- Dados editáveis vivem em cadastro, configuração ou fonte própria. Não congelar IDs, nomes, listas ou códigos mutáveis no código.
- Centralizar enums e discriminantes. Preferir objetos congelados ou `as const` conforme a linguagem; evitar literais de domínio espalhados.
- `switch`/dispatch deve cobrir todas as variantes conhecidas. Variante sem suporte deve falhar ou ser declarada como **não suportada**, nunca produzir `{}`/`null` silencioso que pareça sucesso.
- Não manter múltiplos mapas descoordenados do mesmo discriminante quando uma definição única resolve.
- Campos novos opcionais devem permanecer ausentes quando não informados, **se ausência não for um valor de domínio**. Evitar gravar `default: null` automaticamente; usar `null` quando representar um estado significativo e explícito.
- Em operações parciais, distinguir **campo não enviado** de campo enviado com `0`, `false`, `""` ou `null`, conforme o contrato.
- Dados compostos (autor, motivo, origem, instante, referência) devem ser estruturados em campos próprios, não concatenados em observações.
- Quando um fluxo produz registros derivados, preservar dados informados pelo usuário que integrem o contrato; não substituir por descrições fixas.
- Migrações de contrato ou dados existentes exigem identificar registros afetados, consumidores, risco e estratégia de validação. Não executar migrações silenciosas durante inicialização da aplicação.

## 7. Dados, fonte de verdade e consistência

- Cada conceito deve ter uma **fonte de verdade identificável**. Não persistir cópias redundantes de valores que já existem em entidade vinculada ou que podem ser obtidos diretamente.
- Calcular somas, contagens e resultados derivados a partir das fontes quando isso atender à necessidade. **Não realizar gravação escondida durante leitura** para sincronizar cálculos.
- Se histórico, auditoria, desempenho ou consistência exigirem materialização ou snapshot, justificar o motivo e definir atualização, validade e origem. Isso é uma **exceção arquitetural explícita**, não duplicação casual.
- Não gravar duas direções do mesmo relacionamento sem necessidade demonstrável; evitar inconsistência entre vínculos.
- Fatos históricos que precisam sobreviver a mudanças posteriores devem ser preservados por registros/eventos de domínio com contrato claro.
- Dados opcionais ausentes não devem gerar campos/sentinelas extras desnecessariamente.
- Nunca introduzir atualização em massa, migração, limpeza ou exclusão de dados reais sem avaliação, `dry-run` quando aplicável e autorização.
- Verificar concorrência, atomicidade e idempotência em operações que possam ser executadas simultaneamente ou repetidas.
- Remover escrita, campo ou consulta sem leitor somente depois de verificar consumidores, relatórios e integrações.

## 8. Performance e eficiência

**O objetivo é executar menos trabalho real, não escrever o código mais curto.**

### Banco e backend

- Para consultas de banco, preferir **filtrar, agregar, ordenar, projetar e paginar na origem** quando isso reduzir leitura, transferência e memória.
- Em MongoDB, avaliar `$match`, `$group`, `$sum`, `$count`, `$sort`, `$limit`, `$lookup`, `$project`, `$cond` e `$facet` antes de fazer `find()` e processar grandes listas no Node.
- Não carregar coleções inteiras para contar, somar, ordenar ou paginar quando o banco puder responder diretamente.
- Verificar filtros, ordenação e índices coerentes. Usar análise de plano (`explain`) ou medição quando a consulta for relevante; não criar índices indiscriminadamente.
- Projetar somente os campos necessários. Evitar padrão N+1, múltiplas consultas repetidas e leitura de dados que ninguém utiliza.
- Em listagens, paginar do lado do servidor e manter ordenação consistente. Não trazer tudo para o frontend paginar.
- Reduzir passagens repetidas em listas e mover cálculos invariantes para fora de loops, **sem tornar o algoritmo mais difícil de entender**.
- Processamento no Node é legítimo para composição de serviços, regras que não pertencem ao banco e volumes pequenos. Não forçar pipeline complexo sem ganho.
- Cache, deduplicação e batch só devem existir por benefício concreto. Definir invalidação, ciclo de vida e custo operacional; removê-los quando não agregarem valor.

### Frontend

- Evitar fetch redundante, renders desnecessários e processamento caro em renderização.
- Carregar dados no momento correto; usar busca com debounce, paginação ou virtualização somente quando a escala justificar.
- Usar memoização **seletiva**, não decorativa.
- Não adotar polling, timers, retries ou estados adicionais para mascarar erro de arquitetura.

## 9. Validação, erros e fallback

- Validar **nas fronteiras de entrada** (HTTP, formulário, evento externo, integração e entrada pública de domínio), usando contratos/validadores disponíveis.
- Dentro de um fluxo interno que já teve o contrato validado, confiar na garantia; evitar validações repetidas em cascata.
- **Guard impõe contrato; fallback mascara erro.** Campo obrigatório ausente/inválido deve causar erro observável, não virar `""`, `0`, `null`, `[]` ou um valor inventado.
- Usar `??`, `||` ou `?.` somente quando a ausência ou o valor padrão fizerem parte do contrato real; não aplicá-los automaticamente a campos obrigatórios.
- Distinguir presença de verdade lógica: `0` e `false` podem ser valores válidos. Usar verificação explícita quando necessário.
- Em PATCH/atualização parcial, verificar presença da propriedade enviada quando omissão e atualização forem diferentes.
- Não encadear defaults para acomodar formatos antigos ou inconsistentes sem decisão explícita de contrato.
- Erros devem informar o suficiente para diagnóstico sem expor dados sensíveis ou detalhes internos indevidos.
- Integração que falhou não pode ser apresentada como concluída. Quando houver retry necessário, limitar tentativas e tratar idempotência.
- Não ignorar exceções; registrar e propagar falhas conforme a fronteira responsável.

## 10. Segurança, autorização e escopo

- Qualquer rota, tela, menu, endpoint ou ação nova deve ter **política de acesso explícita**, conforme a arquitetura de autorização existente.
- Permissões de visualização no frontend são UX. O backend deve validar todas as operações sensíveis, inclusive chamadas diretas à API.
- Rota que executa uma ação exige **permissão da própria ação**. Permissão de leitura não autoriza mutação.
- Uma listagem de trabalho pode aceitar leitura **ou** permissão da ação correspondente se isso for o contrato; uma leitura independente não ganha acesso por associação.
- Validar autorização na **borda HTTP**. Services internos recebem dados e restrições de domínio já resolvidos, evitando acoplamento a nomes de roles e middleware.
- Se houver outros pontos de entrada (fila, job, evento, CLI), estabelecer seu próprio limite de confiança e autorização; não presumir que sempre existe HTTP antes do service.
- Preservar paridade entre catálogo de permissões configurável, rotas do backend, telas e ações do frontend. Nunca inventar uma chave que o sistema não permite atribuir.
- Consultas compartilhadas entre módulos devem seguir a política central existente, em vez de duplicar listas de permissões.
- Respeitar escopo de acesso a registros e recursos, **qualquer que seja o critério adotado pelo módulo**. Permissão de ação não significa acesso a todos os registros.
- Não registrar ou expor credenciais, tokens, segredos e dados sensíveis. Usar o mecanismo de configuração seguro já adotado.
- Verificar caminhos permitidos e negados, inclusive por chamadas diretas à API.

## 11. Testes e critérios de correção

- Mudança de comportamento exige testes proporcionais ao risco. **Priorizar testes de fluxo real**, complementados por testes unitários quando isolarem regras complexas.
- Usar as ferramentas e infraestrutura de teste do próprio projeto; **não criar uma infraestrutura paralela por módulo**.
- Nos fluxos backend que usam MongoDB, preferir infraestrutura efêmera existente (por exemplo Jest e `mongodb-memory-server`) para testar com models e services reais. Nunca usar banco de produção em teste automatizado.
- Ao testar fluxo exposto por HTTP, entrar pela rota real quando possível, incluindo validações e permissões; simular autenticação apenas na fronteira apropriada.
- Em teste de fluxo, não mockar a lógica de domínio interna só para facilitar asserções. Mockar **fronteiras externas** (serviços terceiros, rede externa, filesystem remoto etc.).
- Criar dados de teste pelo fluxo real ou pelas fábricas de teste fiéis aos contratos; não inventar shapes que não existem em produção.
- Verificar efeitos observáveis: estado persistido, payload emitido, autorização, UI atualizada e erros esperados — não somente o retorno de um helper.
- No frontend, aproveitar a infraestrutura existente (por exemplo Vitest) e testar interação, estados de erro/carregamento/sucesso e formato do contrato enviado/recebido.
- Cobrir caminho principal, falhas e casos-limite relevantes; acrescentar cenários de concorrência, idempotência e controle de acesso quando fizerem parte do risco.
- Não escrever teste que só valida a hipótese da própria IA. Ler schemas, contratos e fluxo real antes de definir o resultado esperado.
- Não afirmar que algo passou sem executar. Se não for possível testar, relatar objetivamente **o que foi e o que não foi validado**.

## 12. Processo obrigatório de trabalho do agente

**Não sair executando.** Antes de escrever código, entender a demanda e fechar o caminho com o usuário:

- **Teve dúvida, pergunta.** Requisito ambíguo, regra de negócio não documentada, mais de um caminho razoável ou decisão que é do usuário: perguntar antes de implementar. Não inventar convenção nem presumir a resposta.
- **Explorar antes de construir.** Feature nova, mudança de comportamento ou desenho com alternativas passa primeiro por brainstorming (skill `superpowers:brainstorming` ou equivalente da ferramenta): levantar requisitos, propor abordagens com prós e contras e recomendar uma, e só executar com o caminho aprovado.
- **Usar as skills de processo disponíveis** sem esperar ser mandado: debugging sistemático antes de propor fix, TDD na implementação, plano escrito para tarefa de várias etapas, verificação antes de declarar pronto, code review depois de implementar.
- **Pedido de diagnóstico é leitura e explicação**, não edição. Mudar código exige o pedido de mudança.
- **Discordar com fundamento faz parte do trabalho:** apontar o caminho melhor e os riscos em vez de executar no automático o que foi pedido.

1. **Inspecionar antes de editar:** identificar arquivos, fluxo, fonte de verdade, contratos, padrões e testes relevantes.
2. **Localizar consumidores:** em mudança não trivial, encontrar chamadas, imports, schemas, rotas, integrações e interfaces impactadas.
3. **Definir escopo:** escolher a menor alteração que resolva **o problema completo**. Não transformar correção pontual em refatoração geral.
4. **Implementar de ponta a ponta:** atualizar consumidores internos, contratos, validações, autorização e testes pertinentes na mesma entrega.
5. **Auditar o trecho tocado:** corrigir nomes, código morto, duplicação, fallback indevido, importação fora de padrão e consultas inúteis presentes na área modificada.
6. **Não espalhar alterações:** se um problema vizinho demandar refatoração arriscada, identificar e comunicar em vez de alterar módulos não relacionados.
7. **Validar:** executar os testes pertinentes, lint, tipos e build quando disponíveis e aplicáveis; revisar o diff.
8. **Descrever o resultado:** informar arquivos/áreas alterados, comportamento entregue, verificações realizadas e limitações reais.

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

**Operações de risco:** migrações com dados reais, exclusões, mudanças públicas incompatíveis, alterações de acesso, deploy e merge em produção exigem seguir as autorizações existentes e verificar impactos. Não presumir consentimento.

## 13. Revisão final (antes de entregar)

- [ ] A solução vale para o contrato deste módulo sem presumir comportamento de outro módulo?
- [ ] Resolvi o problema sem voltas, camadas ou abstrações artificiais?
- [ ] Identificadores novos sob controle do projeto estão em pt-BR e são claros?
- [ ] Usei `const` como padrão, sem `var`, comentários óbvios ou código morto?
- [ ] Responsabilidades estão coesas; SOLID foi aplicado sem burocracia?
- [ ] Componentes React priorizam renderização; lógica complexa está em hooks; tipos estão fora dos componentes?
- [ ] Não dupliquei contratos, dados, estado ou fonte de verdade?
- [ ] Nenhuma mudança quebre consumidores internos ou externos silenciosamente?
- [ ] Dados de banco são buscados/processados com eficiência compatível com o volume e a consulta?
- [ ] Validação e erro estão nas fronteiras corretas, sem fallback que mascara falha?
- [ ] Permissões e escopo de acesso estão garantidos na execução, não só na UI?
- [ ] Testei os fluxos pertinentes e conferi o diff?
- [ ] Consegui afirmar apenas o que realmente foi executado e verificado?

**Regra de encerramento:** se o código funciona, mas exige conceitos, estados, consultas, arquivos ou indireções desnecessários, simplificar **antes de entregar**, preservando correção, integridade, segurança e testes.

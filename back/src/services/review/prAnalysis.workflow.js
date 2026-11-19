export const meta = {
  name: 'vibehub-pr-analysis',
  description: 'Análise de PR do vibehub: especialistas em paralelo, verificação adversarial e juiz',
  phases: [
    { title: 'Contexto', model: 'opus' },
    { title: 'Revisão', model: 'sonnet' },
    { title: 'Verificação', model: 'sonnet' },
    { title: 'Julgamento', model: 'opus' },
  ],
}

const MAX_VERIFIED_PER_DIMENSION = 15

const DIMENSIONS = [
  { key: 'correctness', focus: 'lógica, bordas, corrida entre cards ou backends, idempotência, erro engolido ou fallback que mascara falha' },
  { key: 'security', focus: 'autorização nas fronteiras, entrada validada, shell citado, segredo fora de argv e de log, leitura que vaza dado de quem não pode ver' },
  { key: 'performance', focus: 'trabalho que cresce com o total e não com a mudança: execuções remotas, leituras e gravações por item, emissões e renders desnecessários' },
  { key: 'contracts', focus: 'consumidores do que mudou (front, ferramentas, scripts, outras áreas), contrato de API e de evento, dado persistido já gravado nas instalações' },
  { key: 'tests', focus: 'mudança de comportamento sem teste, teste que não falharia sem a correção, mock de lógica interna, bordas, falhas e permissões sem cobertura' },
  { key: 'repoRules', focus: 'as regras escritas do repositório (AGENTS.md, CLAUDE.md, .claude/rules) confrontadas com cada linha adicionada, inclusive nomes' },
]

const DIMENSION_KEYS = DIMENSIONS.map((dimension) => dimension.key)

const SEVERITIES = ['blocking', 'improvement', 'suggestion', 'question']

const PROOF_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['failing_test', 'rule', 'scenario'] },
    ref: { type: 'string', maxLength: 400 },
    detail: { type: 'string', maxLength: 2000 },
  },
  required: ['kind', 'ref'],
}

const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: 1000 },
    touchedAreas: { type: 'array', items: { type: 'string' } },
    consumers: { type: 'array', items: { type: 'string' } },
    dimensions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', enum: DIMENSION_KEYS },
          applies: { type: 'boolean' },
          reason: { type: 'string', maxLength: 500 },
        },
        required: ['key', 'applies', 'reason'],
      },
    },
  },
  required: ['summary', 'touchedAreas', 'consumers', 'dimensions'],
}

const NON_BLANK_TEXT = { type: 'string', minLength: 1, pattern: '\\S', maxLength: 2000 }

const FINDING_PROPERTIES = {
  title: { ...NON_BLANK_TEXT, maxLength: 300 },
  problem: NON_BLANK_TEXT,
  file: { type: 'string', maxLength: 400 },
  line: { type: 'integer', minimum: 1 },
  proof: PROOF_SCHEMA,
  fix: NON_BLANK_TEXT,
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: { ...FINDING_PROPERTIES, suggestedSeverity: { type: 'string', enum: SEVERITIES } },
        required: ['title', 'problem', 'fix', 'suggestedSeverity'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: { confirmed: { type: 'boolean' }, evidence: { type: 'string' } },
  required: ['confirmed', 'evidence'],
}

const JUDGMENT_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        properties: {
          ...FINDING_PROPERTIES,
          dimension: { type: 'string', enum: DIMENSION_KEYS },
          severity: { type: 'string', enum: SEVERITIES },
        },
        required: ['title', 'problem', 'fix', 'dimension', 'severity'],
      },
    },
  },
  required: ['findings'],
}

const FULL_SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i
const isFilledText = (value) => typeof value === 'string' && value.trim() !== ''
const fleetArgsAreValid = typeof args === 'object' && args !== null &&
  Number.isInteger(args.prNumber) && args.prNumber > 0 &&
  isFilledText(args.branch) && isFilledText(args.base) &&
  typeof args.headSha === 'string' && FULL_SHA_PATTERN.test(args.headSha)
if (!fleetArgsAreValid) {
  throw new Error(`args inválido para a frota da análise: esperado o objeto { prNumber, branch, base, headSha com 40 ou 64 hex }, recebido ${JSON.stringify(args)}`)
}

const diffRange = `origin/${args.base}...${args.headSha}`

const READ_ONLY_RULE =
  'Você só LÊ: não edite, não crie arquivo, não faça commit nem push. Pode rodar git, gh e um teste já existente ' +
  'do recorte que o PR tocou, filtrado pelo caso (npx vitest run <arquivo> -t "<caso>"); nunca o arquivo inteiro nem a suíte.'

const PROOF_RULE =
  'Bloqueante só com prova: failing_test (o teste que falha), rule (a regra escrita do repo, com o trecho em detail) ' +
  'ou scenario (arquivo:linha e o caso concreto que dá errado). Sem prova, não é blocking.'

const briefText = (brief) =>
  `Resumo do PR: ${brief.summary}\nÁreas tocadas: ${brief.touchedAreas.join(', ')}\nConsumidores: ${brief.consumers.join(', ')}`

const contextPrompt =
  `PR #${args.prNumber} (branch ${args.branch} -> ${args.base}, head ${args.headSha}). ${READ_ONLY_RULE}\n` +
  `Leia o diff (git diff ${diffRange}), a descrição do PR (gh pr view ${args.prNumber}) e as regras do repositório. ` +
  'Monte o brief que os revisores vão receber: o resumo do que o PR faz, as áreas tocadas, quem consome o que mudou ' +
  '(procure os imports e as chamadas) e, para cada dimensão abaixo, se o diff a toca (applies) e por quê.\n' +
  DIMENSIONS.map((dimension) => `- ${dimension.key}: ${dimension.focus}`).join('\n')

const reviewPrompt = (dimension, brief) =>
  `Você é o revisor especialista em ${dimension.key} do PR #${args.prNumber}. Foco: ${dimension.focus}.\n` +
  `${briefText(brief)}\nDiff: git diff ${diffRange}. ${READ_ONLY_RULE}\n${PROOF_RULE}\n` +
  'Procure o que está ERRADO, não confirme o que o PR diz. Para cada achado: title (uma linha), problem (o que está ' +
  'errado e o que acontece se ficar assim, para quem não abre o código), file e line, proof, fix (o que mudar e onde) ' +
  'e suggestedSeverity. Nenhum achado é uma resposta válida.'

const verifyPrompt = (finding, dimension, brief) =>
  `Tente DERRUBAR este achado de ${dimension.key} do PR #${args.prNumber}. ${READ_ONLY_RULE}\n${briefText(brief)}\n` +
  `Achado: ${JSON.stringify(finding)}\n` +
  'Confira no código: a linha existe, o cenário acontece de verdade, a regra citada diz isso. Quando um teste existente ' +
  'decide a questão, rode só ele, filtrado pelo caso (-t "<caso>"). Na dúvida, confirmed = false. Em evidence, o que você conferiu.'

const judgePrompt = (confirmedFindings, brief) =>
  `Você é o juiz da análise do PR #${args.prNumber}, sem o contexto de quem revisou. ${READ_ONLY_RULE}\n${briefText(brief)}\n` +
  'Achados confirmados pela verificação, de todas as dimensões:\n' +
  confirmedFindings.map((confirmed) => `- [${confirmed.label}] ${JSON.stringify(confirmed.finding)} (verificação: ${confirmed.evidence})`).join('\n') +
  '\nJunte os repetidos (o mesmo defeito visto por duas dimensões vira um achado, na dimensão mais precisa) e classifique ' +
  'cada um: blocking (bug ou regra violada, com prova; a IA corrige sozinha), improvement (melhoria no código que o PR ' +
  'mexe, que preserva o comportamento), question (resolver exige decidir intenção ou produto), suggestion (opcional, ' +
  `fora do escopo ou gosto). ${PROOF_RULE}`

phase('Contexto')
const brief = await agent(contextPrompt, { label: 'contexto', phase: 'Contexto', model: 'opus', effort: 'high', schema: BRIEF_SCHEMA })
if (!brief) throw new Error('o agente de contexto da análise não respondeu')

const briefByDimension = new Map(brief.dimensions.map((dimension) => [dimension.key, dimension]))
const isOutsideDiff = (dimension) => briefByDimension.get(dimension.key)?.applies === false
const applicableDimensions = DIMENSIONS.filter((dimension) => !isOutsideDiff(dimension))
const skippedDimensions = DIMENSIONS.filter(isOutsideDiff)
  .map((dimension) => ({ key: dimension.key, status: 'skipped', reason: briefByDimension.get(dimension.key).reason }))
for (const skipped of skippedDimensions) log(`${skipped.key} fora do diff: ${skipped.reason}`)

const reviewLabel = (dimension) => `revisão: ${dimension.key}`

const notRunResult = (dimension, reason) => ({ run: { key: dimension.key, status: 'not_run', reason }, confirmed: [], refutedCount: 0 })

const verifyDimension = async (review, dimension) => {
  if (!review) return notRunResult(dimension, 'o agente de revisão não respondeu')
  const verifiedFindings = review.findings.slice(0, MAX_VERIFIED_PER_DIMENSION)
  const aboveCapCount = review.findings.length - verifiedFindings.length
  const capReason = aboveCapCount === 1
    ? `1 achado acima do teto de ${MAX_VERIFIED_PER_DIMENSION} não foi verificado`
    : `${aboveCapCount} achados acima do teto de ${MAX_VERIFIED_PER_DIMENSION} não foram verificados`
  if (aboveCapCount > 0) log(`${dimension.key}: ${capReason}`)
  const verdicts = await parallel(verifiedFindings.map((finding) => () => agent(verifyPrompt(finding, dimension, brief), {
    label: `verificação: ${dimension.key}`, phase: 'Verificação', model: 'sonnet', effort: 'high', schema: VERDICT_SCHEMA,
  })))
  const checkedFindings = verifiedFindings.map((finding, index) => ({ finding, verdict: verdicts[index] }))
  const confirmed = checkedFindings
    .filter((checked) => checked.verdict?.confirmed)
    .map((checked) => ({ finding: checked.finding, label: reviewLabel(dimension), evidence: checked.verdict.evidence }))
  const refutedCount = checkedFindings.filter((checked) => checked.verdict && !checked.verdict.confirmed).length
  const withoutVerdictCount = checkedFindings.filter((checked) => !checked.verdict).length
  const withoutVerdictReason = `${withoutVerdictCount} ${withoutVerdictCount === 1 ? 'achado sem veredito' : 'achados sem veredito'} (o verificador não respondeu)`
  if (withoutVerdictCount > 0) log(`${dimension.key}: ${withoutVerdictReason}`)
  const reasons = [aboveCapCount > 0 ? capReason : '', withoutVerdictCount > 0 ? withoutVerdictReason : ''].filter(Boolean)
  const unverifiedCount = aboveCapCount + withoutVerdictCount
  return {
    run: {
      key: dimension.key,
      status: 'ran',
      ...(unverifiedCount > 0 ? { unverifiedCount, reason: reasons.join('; ') } : {}),
    },
    confirmed,
    refutedCount,
  }
}

phase('Revisão')
const reviewedDimensions = await pipeline(
  applicableDimensions,
  (dimension) => agent(reviewPrompt(dimension, brief), {
    label: reviewLabel(dimension), phase: 'Revisão', model: 'sonnet', effort: 'high', schema: REVIEW_SCHEMA,
  }),
  verifyDimension,
)

const dimensionResults = reviewedDimensions.map((result, index) =>
  result ?? notRunResult(applicableDimensions[index], 'a revisão desta dimensão falhou'))
const confirmedFindings = dimensionResults.flatMap((result) => result.confirmed)
const refutedCount = dimensionResults.reduce((total, result) => total + result.refutedCount, 0)

phase('Julgamento')
const judgment = confirmedFindings.length === 0
  ? { findings: [] }
  : await agent(judgePrompt(confirmedFindings, brief), { label: 'juiz', phase: 'Julgamento', model: 'opus', effort: 'xhigh', schema: JUDGMENT_SCHEMA })
if (!judgment) throw new Error('o juiz da análise não respondeu')

const judgedFindings = judgment.findings.map((finding, index) => {
  const blockingWithoutProof = finding.severity === 'blocking' && !finding.proof?.ref?.trim()
  if (blockingWithoutProof) log(`${finding.title}: bloqueante sem prova virou sugestão`)
  return { ...finding, id: `f${index + 1}`, severity: blockingWithoutProof ? 'suggestion' : finding.severity }
})

return {
  summary: brief.summary,
  dimensions: [...dimensionResults.map((result) => result.run), ...skippedDimensions],
  findings: judgedFindings,
  refutedCount,
}

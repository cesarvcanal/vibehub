export const meta = {
  name: 'vibehub-pr-analysis',
  description: 'Análise de PR do vibehub: especialistas em paralelo, achados repetidos consolidados, verificação adversarial e juiz',
  phases: [
    { title: 'Contexto', model: 'sonnet' },
    { title: 'Revisão', model: 'sonnet' },
    { title: 'Consolidação', model: 'opus' },
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

const CONSOLIDATION_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { ...NON_BLANK_TEXT, maxLength: 300 },
          members: { type: 'array', minItems: 1, items: { type: 'string' } },
        },
        required: ['title', 'members'],
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
  typeof args.headSha === 'string' && FULL_SHA_PATTERN.test(args.headSha) &&
  (args.sinceSha === undefined || (typeof args.sinceSha === 'string' && FULL_SHA_PATTERN.test(args.sinceSha)))
if (!fleetArgsAreValid) {
  throw new Error(`args inválido para a frota da análise: esperado o objeto { prNumber, branch, base, headSha com 40 ou 64 hex, sinceSha opcional com 40 ou 64 hex }, recebido ${JSON.stringify(args)}`)
}

const fullDiffRange = `origin/${args.base}...${args.headSha}`
const diffScope = args.sinceSha === undefined
  ? `Diff: git diff ${fullDiffRange}.`
  : `Diff: git diff ${args.sinceSha}..${args.headSha}. Esta rodada confere só o que mudou desde a rodada anterior; ` +
    `o diff do PR inteiro (git diff ${fullDiffRange}) serve só de contexto, e o que entrou por merge da base ` +
    `(commit que já está em origin/${args.base}) não é deste PR e fica fora.`

const READ_ONLY_RULE =
  'Você só LÊ: não edite, não crie arquivo, não faça commit nem push. Pode rodar git, gh e um teste já existente ' +
  'do recorte que o PR tocou, filtrado pelo caso (npx vitest run <arquivo> -t "<caso>"); nunca o arquivo inteiro nem a suíte.'

const PROOF_RULE =
  'Bloqueante só com prova: failing_test (o teste que falha), rule (a regra escrita do repo, com o trecho em detail) ' +
  'ou scenario (arquivo:linha e o caso concreto que dá errado). Sem prova, não é blocking.'

const briefText = (brief) =>
  `Resumo do PR:\n${brief.summary}\nÁreas tocadas: ${brief.touchedAreas.join(', ')}\nConsumidores: ${brief.consumers.join(', ')}`

const contextPrompt =
  `PR #${args.prNumber} (branch ${args.branch} -> ${args.base}, head ${args.headSha}). ${READ_ONLY_RULE}\n` +
  `${diffScope} Leia o diff, a descrição do PR (gh pr view ${args.prNumber}) e as regras do repositório. ` +
  'Monte o brief que os revisores vão receber: o resumo do que o PR faz, as áreas tocadas, quem consome o que mudou ' +
  '(procure os imports e as chamadas) e, para cada dimensão abaixo, se o diff a toca (applies) e por quê. ' +
  'No summary, um tópico markdown ("- ") por mudança do PR, cada um uma frase curta que quem não abriu o código entende; ' +
  'nunca um parágrafo corrido nem "(1) … (2) …" na mesma linha.\n' +
  DIMENSIONS.map((dimension) => `- ${dimension.key}: ${dimension.focus}`).join('\n')

const reviewPrompt = (dimension, brief) =>
  `Você é o revisor especialista em ${dimension.key} do PR #${args.prNumber}. Foco: ${dimension.focus}.\n` +
  `${briefText(brief)}\n${diffScope} ${READ_ONLY_RULE}\n${PROOF_RULE}\n` +
  `Procure o que está ERRADO, não confirme o que o PR diz. A descrição do PR (gh pr view ${args.prNumber}) é o que o autor ` +
  'afirma: confira no código cada causa, teste, número e arquivo:linha que ela cita, e a afirmação falsa é achado. ' +
  'Para cada achado: title (uma linha), problem (o que está errado e o que acontece se ficar assim, para quem não abre ' +
  'o código), file e line, proof, fix (o que mudar e onde) e suggestedSeverity. Nenhum achado é uma resposta válida.'

const indentUnderFinding = (text) => text.split('\n').map((line) => `    ${line}`).join('\n')

const reviewLabel = (dimension) => `revisão: ${dimension.key}`

const candidateText = (candidate) => `[${reviewLabel(candidate.dimension)}] ${JSON.stringify(candidate.finding)}`

const consolidationPrompt = (candidates) =>
  `Você consolida os achados dos revisores do PR #${args.prNumber} antes da verificação. ${READ_ONLY_RULE}\n` +
  'Não julgue se os achados procedem (isso é da verificação): diga só quais descrevem o MESMO defeito. Cada revisor ' +
  'viu o PR por uma dimensão, sem ver os outros, então o mesmo defeito pode vir com palavras, linhas e provas diferentes.\n' +
  'Achados, um por linha, com o id na frente:\n' +
  candidates.map((candidate) => `${candidate.id} ${candidateText(candidate)}`).join('\n') +
  '\nJunte dois achados só quando são o mesmo defeito: a mesma causa, e a mesma correção resolve os dois. Achados no ' +
  'mesmo arquivo e linha com causa ou correção diferente ficam separados; na dúvida, separados. Cada id entra em ' +
  'exatamente um grupo, inclusive o achado que não se repete (grupo de um). O title do grupo nomeia o defeito em uma linha.'

const verifyPrompt = (group, brief) =>
  `Tente DERRUBAR este achado do PR #${args.prNumber}: ${group.title}. ${READ_ONLY_RULE}\n${briefText(brief)}\n` +
  (group.members.length === 1
    ? 'Como o revisor o descreveu:\n'
    : `${group.members.length} revisores, sem ver um ao outro, apontaram este mesmo defeito; cada descrição traz a sua prova:\n`) +
  `${group.members.map(candidateText).join('\n')}\n` +
  'Confira no código: a linha existe, o cenário acontece de verdade, a regra citada diz isso. Quando um teste existente ' +
  'decide a questão, rode só ele, filtrado pelo caso (-t "<caso>"). Na dúvida, confirmed = false. ' +
  'Em evidence, o que você conferiu, um tópico markdown ("- ") por conferência, cada um uma frase curta.'

const confirmedGroupText = (confirmed) =>
  `- ${confirmed.group.title}\n  Como cada revisor o descreveu:\n${indentUnderFinding(confirmed.group.members.map(candidateText).join('\n'))}\n` +
  `  Verificação:\n${indentUnderFinding(confirmed.evidence)}`

const judgePrompt = (confirmedGroups, brief) =>
  `Você é o juiz da análise do PR #${args.prNumber}, sem o contexto de quem revisou. ${READ_ONLY_RULE}\n${briefText(brief)}\n${diffScope}\n` +
  'Achados confirmados pela verificação, de todas as dimensões:\n' +
  confirmedGroups.map(confirmedGroupText).join('\n') +
  '\nJunte os repetidos (o mesmo defeito visto por duas dimensões vira um achado, na dimensão mais precisa) e classifique ' +
  'cada um: blocking (bug ou regra violada, com prova; a IA corrige sozinha), improvement (melhoria no código que o PR ' +
  'mexe, que preserva o comportamento e que nenhuma regra escrita exige), question (resolver exige decidir intenção ou produto), suggestion (opcional, ' +
  `fora do escopo, ou gosto que nenhuma regra escrita decide). ${PROOF_RULE}`

phase('Contexto')
const brief = await agent(contextPrompt, { label: 'contexto', phase: 'Contexto', model: 'sonnet', effort: 'medium', schema: BRIEF_SCHEMA })
if (!brief) throw new Error('o agente de contexto da análise não respondeu')

const briefByDimension = new Map(brief.dimensions.map((dimension) => [dimension.key, dimension]))
const isOutsideDiff = (dimension) => briefByDimension.get(dimension.key)?.applies === false
const applicableDimensions = DIMENSIONS.filter((dimension) => !isOutsideDiff(dimension))
const skippedDimensions = DIMENSIONS.filter(isOutsideDiff)
  .map((dimension) => ({ key: dimension.key, status: 'skipped', reason: briefByDimension.get(dimension.key).reason }))
for (const skipped of skippedDimensions) log(`${skipped.key} fora do diff: ${skipped.reason}`)

const VERIFY_LABEL_TITLE_MAX = 80
const verifyLabel = (group) => `verificação: ${group.members[0].dimension.key} · ${group.title.slice(0, VERIFY_LABEL_TITLE_MAX)}`

phase('Revisão')
const reviews = await parallel(applicableDimensions.map((dimension) => () => agent(reviewPrompt(dimension, brief), {
  label: reviewLabel(dimension), phase: 'Revisão', model: 'sonnet', effort: 'high', schema: REVIEW_SCHEMA,
})))

const reviewedDimensions = applicableDimensions.map((dimension, index) => {
  const review = reviews[index]
  if (!review) return { dimension, findingsWithinCap: [], aboveCapCount: 0, answered: false }
  const findingsWithinCap = review.findings.slice(0, MAX_VERIFIED_PER_DIMENSION)
  return { dimension, findingsWithinCap, aboveCapCount: review.findings.length - findingsWithinCap.length, answered: true }
})

const candidates = reviewedDimensions
  .flatMap((reviewed) => reviewed.findingsWithinCap.map((finding) => ({ dimension: reviewed.dimension, finding })))
  .map((candidate, index) => ({ ...candidate, id: `c${index + 1}` }))
const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]))

const findPartitionProblem = (consolidation) => {
  if (!consolidation) return 'o agente de consolidação não respondeu'
  const hasNoMembers = (group) => !Array.isArray(group.members) || group.members.length === 0
  const emptyGroupTitles = consolidation.findings.filter(hasNoMembers).map((group) => group.title)
  if (emptyGroupTitles.length > 0) return `devolveu grupo sem achado (${emptyGroupTitles.join(', ')})`
  const memberIds = consolidation.findings.flatMap((group) => group.members)
  const unknownIds = memberIds.filter((id) => !candidateById.has(id))
  if (unknownIds.length > 0) return `citou achado que não existe (${unknownIds.join(', ')})`
  const repeatedIds = memberIds.filter((id, index) => memberIds.indexOf(id) !== index)
  if (repeatedIds.length > 0) return `pôs achado em mais de um grupo (${repeatedIds.join(', ')})`
  const missingIds = candidates.map((candidate) => candidate.id).filter((id) => !memberIds.includes(id))
  if (missingIds.length > 0) return `deixou achado de fora (${missingIds.join(', ')})`
  return ''
}

const singleFindingGroups = candidates.map((candidate) => ({ title: candidate.finding.title, members: [candidate] }))

const consolidateCandidates = async () => {
  if (candidates.length < 2) return singleFindingGroups
  phase('Consolidação')
  const consolidation = await agent(consolidationPrompt(candidates), {
    label: 'consolidação', phase: 'Consolidação', model: 'opus', effort: 'high', schema: CONSOLIDATION_SCHEMA,
  })
  const partitionProblem = findPartitionProblem(consolidation)
  if (partitionProblem) {
    log(`consolidação: ${partitionProblem}; cada achado é verificado sozinho`)
    return singleFindingGroups
  }
  return consolidation.findings.map((group) => ({ title: group.title, members: group.members.map((id) => candidateById.get(id)) }))
}

const findingGroups = await consolidateCandidates()

phase('Verificação')
const verdicts = await parallel(findingGroups.map((group) => () => agent(verifyPrompt(group, brief), {
  label: verifyLabel(group), phase: 'Verificação', model: 'sonnet', effort: 'high', schema: VERDICT_SCHEMA,
})))
const checkedGroups = findingGroups.map((group, index) => ({ group, verdict: verdicts[index] }))
const confirmedGroups = checkedGroups
  .filter((checked) => checked.verdict?.confirmed)
  .map((checked) => ({ group: checked.group, evidence: checked.verdict.evidence }))
const refutedCount = checkedGroups.filter((checked) => checked.verdict && !checked.verdict.confirmed).length
const membersWithoutVerdict = checkedGroups.filter((checked) => !checked.verdict).flatMap((checked) => checked.group.members)

const dimensionRunOf = ({ dimension, aboveCapCount, answered }, unverifiedMembers) => {
  if (!answered) return { key: dimension.key, status: 'not_run', reason: 'o agente de revisão não respondeu' }
  const capReason = aboveCapCount === 1
    ? `1 achado acima do teto de ${MAX_VERIFIED_PER_DIMENSION} não foi verificado`
    : `${aboveCapCount} achados acima do teto de ${MAX_VERIFIED_PER_DIMENSION} não foram verificados`
  const withoutVerdictCount = unverifiedMembers.filter((member) => member.dimension === dimension).length
  const withoutVerdictReason = `${withoutVerdictCount} ${withoutVerdictCount === 1 ? 'achado sem veredito' : 'achados sem veredito'} (o verificador não respondeu)`
  const reasons = [aboveCapCount > 0 ? capReason : '', withoutVerdictCount > 0 ? withoutVerdictReason : ''].filter(Boolean)
  const unverifiedCount = aboveCapCount + withoutVerdictCount
  return {
    key: dimension.key,
    status: 'ran',
    ...(unverifiedCount > 0 ? { unverifiedCount, reason: reasons.join('; ') } : {}),
  }
}

const dimensionRuns = reviewedDimensions.map((reviewed) => dimensionRunOf(reviewed, membersWithoutVerdict))
const partiallyVerifiedRuns = dimensionRuns.filter((run) => run.status === 'ran' && run.reason)
for (const run of partiallyVerifiedRuns) log(`${run.key}: ${run.reason}`)

phase('Julgamento')
const judgment = confirmedGroups.length === 0
  ? { findings: [] }
  : await agent(judgePrompt(confirmedGroups, brief), { label: 'juiz', phase: 'Julgamento', model: 'opus', effort: 'high', schema: JUDGMENT_SCHEMA })
if (!judgment) throw new Error('o juiz da análise não respondeu')

const judgedFindings = judgment.findings.map((finding, index) => {
  const blockingWithoutProof = finding.severity === 'blocking' && !finding.proof?.ref?.trim()
  if (blockingWithoutProof) log(`${finding.title}: bloqueante sem prova virou sugestão`)
  return { ...finding, id: `f${index + 1}`, severity: blockingWithoutProof ? 'suggestion' : finding.severity }
})

return {
  summary: brief.summary,
  dimensions: [...dimensionRuns, ...skippedDimensions],
  findings: judgedFindings,
  refutedCount,
}

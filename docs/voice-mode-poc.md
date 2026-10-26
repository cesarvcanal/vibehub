# Voz no chat do card — GPT-Live

Conversa por voz com o `gpt-live-1` da OpenAI **dentro do chat do card**, no estilo do modo de voz
do ChatGPT: o botão de voz do composer inicia a chamada ali mesmo, a transcrição aparece na mesma
thread entre as mensagens digitadas, o campo continua aceitando texto e anexos durante a chamada, e
ao encerrar a conversa fica no histórico do card. Não há página separada: `/voice` só redireciona
para o card; `/voice/lab` segue como bancada de calibração da esfera.

Desligado por padrão: sem `VIBEHUB_VOICE_LIVE=1` as rotas respondem 404 e o botão não aparece.

## Como funciona

```
navegador (chat do card)          back (vibehub)                    OpenAI
------------------------          --------------                    ------
clique no botão de voz → AudioContext nasce no gesto
getUserMedia (mic)
RTCPeerConnection + "oai-events"
createOffer ── POST /api/cards/:id/voice/sessions {sdp} ──►
                                  requireCardWork, valida SDP, teto/min
                                  instruções = base + conversa recente do card
                                  POST /v1/live/sessions ─────────►  cria a sessão
setRemoteDescription ◄──────────── 201 {sessionId, sdp}
áudio ◄══════════════════ WebRTC direto, o back não vê o áudio ══════════════════►
transcrição (fragmentos) → turnos → POST /api/cards/:id/voice/turns → sdk-history do card
```

- **Uma fonte de verdade:** a thread do card (`sdk-history/<card>.ndjson`, replay pelo WebSocket
  `/api/cards/:id/sdk`). Cada turno falado é um evento `voice_turn` `{vid, role, text, at, from}`.
  O navegador junta os fragmentos do GPT-Live em turnos (`voiceTurns.ts`: o outro lado falar fecha o
  turno; pausa > 1,5 s na linha do tempo do modelo abre outro; 2,5 s sem fragmento fecha), salva com
  retry e backoff, e o back grava **uma vez por `vid`** (inclusive em corrida e depois de reiniciar).
  Enquanto o eco do servidor não chega, o chat desenha a cópia local no fim da thread; ao chegar,
  a mesma linha é substituída (sem duplicar).
- **Contexto:** a sessão é criada já com a conversa recente do card nas instruções (digitadas,
  respostas do agente, turnos falados; nunca chamadas de ferramenta). Durante a chamada, o que for
  digitado/anexado e as respostas do agente vão para a voz como contexto silencioso
  (`session.thinking.append`, até ~1200 caracteres).
- **Texto e anexos durante a chamada:** seguem pelo envio normal do chat, para o agente do card
  (Claude Code). O GPT-Live **não tem entrada de texto nem de arquivo/imagem**: a voz só fica sabendo
  que algo foi escrito e quantas imagens foram anexadas, e a faixa da chamada diz isso na tela.
- **A voz não age no card:** é outro modelo; ela conversa sobre a thread, não roda comandos. Pedido
  de ação se digita no campo (a voz orienta isso).
- **Fases (orbe e status):** conectando → ouvindo → você falando → pensando → respondendo →
  interrompido / mudo / falha, dirigidas por eventos reais (`voicePhase.ts`) com histerese: a Marca
  Viva aparece só ao conectar ou quando há resposta devida (≥ 0,7 s de silêncio depois de você
  falar, ou o agente trabalhando no que você digitou), nunca entre duas palavras.
- **Esfera azul (o bug "quase não mexe"):** o nível da IA é **medido** no stream remoto com
  `AnalyserNode` num `AudioContext` criado no clique (política de autoplay). Volume real (RMS/dBFS)
  e intensidade visual são separados: gate −60 dBFS, janela −50…−16 dBFS, curva 0,7, envelope
  18/140 ms (`audioLevel.ts`, calibrável). Se o analisador só devolver zeros digitais por 700 ms (o
  navegador não roteou o track remoto para o Web Audio), cai para o `audioLevel` do `getStats`
  (inbound-rtp, a cada 250 ms) e, sem ele, para pulsos dos próprios fragmentos de fala do modelo.
  A fonte em uso fica no DOM (`data-ai-source`, `data-ai-rms`, `data-ai-visual`). O motor V37
  ganhou `talkResponse` (100% padrão, 0% = V37 original): respiração da esfera, emissão na borda e
  anéis por sílaba, proporcionais ao áudio — o rosa continua com as rajadas locais de antes.
- **Mic:** só o microfone move o rosa, só a IA move o azul; mudo zera o rosa e avisa o modelo
  (`session.input_audio.mute`). O ditado do composer fica desabilitado durante a chamada (uma
  permissão de microfone por vez). Uma chamada por vez no app; sair do chat (outro card, aba
  Terminal) encerra a chamada.
- **Encerramento:** "Encerrar" envia `session.close` e espera `session.closed` (até 15 s). Queda,
  erro de startup e timeout passam pelo mesmo teardown (mic, canal, peer, AudioContext, medidores);
  o que estava sendo dito vira turno e é salvo.
- **Nada sensível registrado:** nem chave, nem SDP, nem áudio. A transcrição é conversa do card
  (vai para o histórico dele, como as mensagens digitadas); o log de auditoria tem sessão, pessoa e
  card.
- **Custo:** cada criação cobra 15 s de voz adiantados; teto de 6 criações por pessoa por minuto.

Arquivos: back `services/voice/{live,context,turns}.ts`, `routes/voice.ts`; front
`features/voice/{useVoiceCall,liveVoice,audioLevel,voicePhase,voiceTurns,voiceContext}.ts`,
`VoiceCallBar.tsx`, `VoiceTurnBubble.tsx`, `ComposerVoiceButton.tsx`, `living/*`, e a integração em
`features/board/components/SdkChatView.tsx`.

## Testar localmente

Requisitos: Node 24, uma chave da OpenAI com acesso ao `gpt-live-1`, navegador com microfone.
`getUserMedia` só funciona em `localhost` ou HTTPS.

```bash
npm run install:all

# back (porta 3011, dados num diretório descartável — não toca no data/ de ninguém)
cd back
VIBEHUB_VOICE_LIVE=1 \
VIBEHUB_VOICE_OPENAI_API_KEY=sk-... \
VIBEHUB_INSECURE_COOKIES=1 \
VIBEHUB_PORT=3011 VIBEHUB_DATA_DIR=/tmp/vh-voice \
npx tsx src/index.ts

# front, noutro terminal
cd front
VIBEHUB_BACKEND=http://127.0.0.1:3011 npx vite --port 5184
```

1. Abra `http://localhost:5184`, crie o owner no assistente de setup (instalação vazia) e entre.
2. Abra um card (chat nativo) e clique na onda azul: no desktop fica ao lado do microfone, fora do
   campo; no celular, no canto do campo enquanto ele está vazio. A faixa da chamada aparece acima do
   composer.
3. Permita o microfone, espere "Ouvindo — é só falar" e converse. Fale por cima da resposta para
   interromper. Digite e anexe à vontade durante a chamada. O botão vermelho da faixa encerra.

Sem chave ou sem `VIBEHUB_VOICE_LIVE=1` o botão de voz não aparece. A chave da OpenAI pode ficar
no cofre (Configurações → microfone do composer), que a voz usa como fallback.

## Testar pelo Preview de um card (vibehub dentro do vibehub)

O proxy do Preview serve a instância de teste em `/preview/<porta>/`. Quatro detalhes fazem isso
funcionar sem tocar no painel de fora:

- **Base do front:** `vite build --base /preview/<porta>/`. API, redirect de 401 e websockets
  seguem `import.meta.env.BASE_URL` (em produção é `/`, nada muda). Sem isso o `/api` absoluto
  bateria no painel de fora.
- **Cookie de sessão próprio:** `VIBEHUB_SESSION_COOKIE=<outro nome>`. O proxy remove
  `vibehub_session` na ida, e o `Set-Cookie` da instância de dentro deslogaria o owner do painel.
- **Sem setup nem login:** `VIBEHUB_PREVIEW_PROXY_AUTH=1` (só sobe com `VIBEHUB_HOST` em loopback).
  O proxy do painel já autenticou a pessoa (sessão de owner, ou acesso ao card dono da porta), mas
  remove o cookie e não repassa identidade; a instância de dentro tem `users.json` vazio e cairia no
  assistente de setup. Com a flag, ela cria no boot um owner local `preview-owner` com senha
  aleatória descartada (ninguém a conhece) e trata como esse owner toda requisição com
  `x-forwarded-prefix: /preview/<porta>`. O painel descarta esse cabeçalho vindo do cliente e o
  recria (`DROP_HEADERS` em `services/preview/preview.ts`), então pelo painel ele só existe em
  requisição que passou pela autenticação do proxy. Nenhuma conta, senha ou banco do painel é lido.
  A fronteira de confiança é o runner: processos dentro dele alcançam a porta — e já leem o data
  dir da instância de qualquer jeito.
- **HTTPS:** o microfone só abre em contexto seguro. Abra o painel por
  `https://vibehub.multiversoatacado.com` (certificado válido); por `http://dev.multi` o
  navegador esconde o `getUserMedia`.

Receita (porta 4317, front já buildado com esse base em `$DIR/public`):

```bash
umask 077; cd back
VIBEHUB_SECRET_KEY="$(openssl rand -hex 32)" VIBEHUB_SESSION_SECRET="$(openssl rand -hex 32)" \
VIBEHUB_VOICE_LIVE=1 VIBEHUB_SESSION_COOKIE=vibehub_voice_preview VIBEHUB_PREVIEW_PROXY_AUTH=1 \
VIBEHUB_PORT=4317 VIBEHUB_HOST=127.0.0.1 VIBEHUB_DATA_DIR=$DIR/data VIBEHUB_STATIC_DIR=$DIR/public \
npx tsx src/index.ts
```

A chave mestra aleatória por execução faz o cofre de teste morrer com o processo: reiniciar sem a
mesma `VIBEHUB_SECRET_KEY` perde a chave da OpenAI colada (o owner local é recriado sozinho).
Nenhuma chave da OpenAI vai para env, arquivo ou log — o owner a cola na página `/voice`.

Para entrar pelo painel com SSO de verdade (a instância de dentro saber QUEM é a pessoa, não só
"alguém que passou pelo proxy") o painel precisaria assinar a identidade num cabeçalho, e isso é
mudança no painel de produção — fora do escopo da POC.

## Testes

```bash
cd back  && npx vitest run src/routes/voice.test.ts src/routes/voiceCard.test.ts
cd front && npx vitest run src/features/voice src/features/board/components/SdkChatView.voice.test.tsx src/features/board/lib/sdkChat.voice.test.ts
```

Unitários e de integração com mocks: o fetch da OpenAI, a pilha WebRTC (`fakeWebRtc.ts`) e o Web
Audio (`FakeAudioContext`) são falsos. Nenhum teste fala com a rede.

**E2E em Chromium real** (`front/e2e/voice-in-chat.e2e.mjs`, fora do CI): back e front isolados de
verdade; simulados só o GPT-Live (um `RTCPeerConnection` falso cujo "track remoto" é um MediaStream
de áudio REAL sintetizado na página, com envelope de sílabas, e cujo canal emite os eventos
documentados), o driver do Claude (WebSocket que replaya o histórico real do card) e a troca SDP.
Verifica 25 pontos: chamada sem navegar, lilás reagindo ao mic, Marca Viva ao pensar, azul medido no
analisador e variando com as sílabas, canvas mexendo mais com fala que em silêncio, zero em
silêncio, texto pelo fluxo do chat com contexto para a voz, mudo, layout mobile, turnos salvos uma
vez e reidratados depois de recarregar. Precisa de `playwright-core` (`NODE_PATH`) e do Chromium do
Playwright; o cabeçalho do arquivo tem o comando.

## Limitações

- Sem chave do GPT-Live neste ambiente: a chamada real (áudio decodificado de um track WebRTC de
  rede) não foi exercitada. O E2E mede áudio real no navegador, mas sintetizado localmente. Se o
  navegador não entregar o track remoto ao Web Audio, a cadeia de fallback (RTP → eventos) assume e
  `data-ai-source` mostra qual está ativa. Os eventos seguem a documentação pública do GPT-Live
  (`session.started`, `session.*_transcript.delta` com `start_ms/end_ms`, `session.thinking.append`,
  `error`, `session.closed`, `session.input_audio.mute`).
- GPT-Live não aceita texto, imagem nem arquivo: anexos vão para o agente do card pelo chat e a voz
  só recebe o aviso. Não há como a voz "ler" o anexo em tempo real.
- A voz não executa ações no card (sem delegação para o Claude). Um próximo passo possível é a
  delegação `client` do GPT-Live encaminhando o pedido falado ao agente, com confirmação.
- Interromper é por voz (barge-in do modelo); não existe evento de "cancelar resposta" no GPT-Live
  com delegação `client`.
- Teto de criações em memória, por processo: num deploy blue/green ou com várias réplicas ele não é
  compartilhado.
- Voz fixa (`marin`, padrão); instruções em pt-BR em `live.ts` mais a conversa recente do card.
- A transcrição só existe no chat nativo (SDK); o chat clássico de transcript não oferece voz.

# Modo de voz (POC) — GPT-Live

Conversa por voz bidirecional com o `gpt-live-1` da OpenAI, no estilo do modo de voz do ChatGPT:
um botão inicia e encerra, o microfone fica aberto, a resposta vem em áudio e dá para interromper o
assistente falando por cima. **Não tem ligação com o Claude Code nem com nenhum card.**

Desligado por padrão: sem `VIBEHUB_VOICE_LIVE=1` a rota responde 404 e a página diz que está off.

## Como funciona

```
navegador                         back (vibehub)                    OpenAI
---------                         --------------                    ------
getUserMedia (mic)
RTCPeerConnection + "oai-events"
createOffer ──── POST /api/voice/live/sessions {sdp} ──►
                                  valida sessão, SDP, teto/min
                                  POST /v1/live/sessions ─────────►  cria a sessão
                                  (Bearer = chave do servidor)  ◄──  {session.id, transport.sdp}
setRemoteDescription ◄──────────── 201 {sessionId, sdp}
áudio ◄══════════════════ WebRTC direto, o back não vê o áudio ══════════════════►
eventos JSON (session.started, transcripts, error, session.closed) no data channel
```

- **Chave:** só no servidor. `VIBEHUB_VOICE_OPENAI_API_KEY`; se vazia, usa a chave da OpenAI já
  guardada no cofre para o microfone do composer (Configurações). GPT-Live não emite chave efêmera,
  então o navegador nunca recebe chave nenhuma.
- **Turn-taking e interrupção:** o GPT-Live é full duplex; quem decide a vez e o barge-in é o
  modelo. O cliente só mantém o mic aberto, com `echoCancellation` ligado para o assistente não se
  interromper pelo alto-falante.
- **Encerramento:** "Encerrar" envia `session.close` e espera `session.closed` (até 15 s) antes de
  fechar mic e peer. Encerrar enquanto conecta cancela a requisição (o back aborta a chamada à
  OpenAI). Sair da página, queda de conexão, erro de startup e timeout de startup (20 s) passam
  todos pelo mesmo teardown: mic liberado, canal e peer fechados.
- **Mute:** desliga a faixa local (nada sai da máquina) e avisa o modelo
  (`session.input_audio.mute`).
- **Nada é registrado:** nem chave, nem SDP, nem áudio, nem transcrição. O log de auditoria tem só
  id da sessão e quem pediu; erros do upstream logam status e `error.code`.
- **Custo:** cada criação cobra 15 s de voz adiantados (abatidos depois). Por isso há teto de
  6 criações por pessoa por minuto (429).

Arquivos: `back/src/services/voice/live.ts`, `back/src/routes/voice.ts`,
`front/src/features/voice/liveVoice.ts` (máquina de estados), `front/src/features/voice/VoiceModePage.tsx`
(página `/voice`).

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
2. Vá em `http://localhost:5184/voice` (não há link no board — é POC).
3. Toque no botão, permita o microfone, espere "Ouvindo — é só falar" e converse. Fale por cima da
   resposta para interromper. "Encerrar conversa" fecha tudo.

Sem chave ou sem `VIBEHUB_VOICE_LIVE=1` a página mostra o motivo em vez do botão.

## Testes

```bash
cd back  && npx vitest run src/routes/voice.test.ts
cd front && npx vitest run src/features/voice
```

São todos com mocks: o fetch da OpenAI e a pilha WebRTC do navegador (`fakeWebRtc.ts`) são falsos.
Nenhum teste fala com a rede.

## Limitações

- O áudio real não foi testado no desenvolvimento desta POC (sem chave no ambiente). Os eventos
  seguem a documentação pública do GPT-Live (`session.started`, `session.input_transcript.delta`,
  `session.output_transcript.delta`, `error`, `session.closed`, `session.input_audio.mute`).
- Teto de criações em memória, por processo: num deploy blue/green ou com várias réplicas ele não é
  compartilhado.
- Sem delegação (`delegation`), ferramentas nem contexto do vibehub: é conversa pura.
- Voz e instruções fixas (`marin`, padrão; instruções curtas em pt-BR em `live.ts`).
- Transcrição só na tela, some ao sair da página.

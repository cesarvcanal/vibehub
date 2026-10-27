/**
 * VOICE DEMO for the hosted preview (front/e2e/voice-preview-server.mjs) — loaded BEFORE the app.
 * There is no GPT-Live key on the runner, so the call's far end is simulated here, honestly:
 *
 * - your REAL microphone drives the lilac sphere (when the page is on HTTPS; otherwise a synthetic
 *   voice speaks for you);
 * - when you stop talking, the "model" thinks for a moment and answers with a SYNTHESISED voice — a
 *   real audio stream the orb measures — plus its transcript, which lands in the chat;
 * - a small badge says it is a demonstration.
 *
 * Nothing here ships with the app: only the preview server injects it.
 */
(() => {
  const ctx = new AudioContext();
  const unlock = () => void ctx.resume();
  addEventListener("pointerdown", unlock, true);
  addEventListener("keydown", unlock, true);

  function synthVoice() {
    const out = ctx.createMediaStreamDestination();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 900;
    filter.Q.value = 0.7;
    for (const f of [150, 226, 301]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = f;
      osc.connect(filter);
      osc.start();
    }
    filter.connect(gain);
    gain.connect(out);
    return { stream: out.stream, gain: gain.gain };
  }
  const ai = synthVoice();
  const fakeMic = synthVoice();

  /** Speaks `n` syllables on a voice (a pulse each), returns how long it lasts (ms). */
  function say(voice, n, peak) {
    const t0 = ctx.currentTime + 0.03;
    voice.gain.cancelScheduledValues(t0);
    voice.gain.setValueAtTime(0, t0);
    for (let i = 0; i < n; i++) {
      const at = t0 + i * 0.21;
      const level = peak * (0.5 + 0.5 * Math.abs(Math.sin(i * 1.9)));
      voice.gain.linearRampToValueAtTime(level, at + 0.05);
      voice.gain.linearRampToValueAtTime(level * 0.03, at + 0.16);
    }
    voice.gain.linearRampToValueAtTime(0, t0 + n * 0.21 + 0.05);
    return n * 210;
  }

  const ANSWERS = [
    "Oi! Estou aqui no chat do card. Pode falar ou digitar, que eu acompanho a conversa.",
    "Entendi. O que você escreve aqui vai para o agente do card, e eu recebo o contexto.",
    "Isto é uma demonstração: a minha voz é sintetizada, mas a esfera mede o áudio de verdade.",
  ];
  let answer = 0;

  const realGetUserMedia = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  const media = navigator.mediaDevices ?? (navigator.mediaDevices = {});
  let micStream = null;
  media.getUserMedia = async (constraints) => {
    await ctx.resume();
    try {
      if (!realGetUserMedia) throw new Error("insecure");
      micStream = await realGetUserMedia(constraints);
    } catch {
      micStream = fakeMic.stream;
      // No microphone here: a synthetic voice "speaks" for you every few seconds.
      setInterval(() => say(fakeMic, 8, 0.55), 9000);
      setTimeout(() => say(fakeMic, 8, 0.55), 1500);
    }
    return micStream;
  };

  class Channel extends EventTarget {
    readyState = "connecting";
    send(raw) {
      const e = JSON.parse(raw);
      if (e.type === "session.close") setTimeout(() => this.emit({ type: "session.closed", reason: "close_requested" }), 80);
      if (e.type === "session.input_audio.mute") this.emit({ type: "session.input_audio.muted" });
      if (e.type === "session.input_audio.unmute") this.emit({ type: "session.input_audio.unmuted" });
      if (e.type === "session.thinking.append") setTimeout(() => this.emit({ type: "session.thinking.appended" }), 30);
    }
    close() {
      this.readyState = "closed";
      this.dispatchEvent(new Event("close"));
    }
    emit(event) {
      if (this.readyState === "open") this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(event) }));
    }
  }

  /** The "model": hears the mic, and answers after you stop. */
  function converse(channel) {
    if (!micStream) return;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(micStream).connect(analyser);
    const buf = new Float32Array(1024);
    let speaking = false;
    let quietSince = 0;
    let busy = false;
    let heardMs = 0;
    const timer = setInterval(() => {
      if (channel.readyState !== "open") return clearInterval(timer);
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const loud = Math.sqrt(sum / buf.length) > 0.02;
      const now = performance.now();
      if (loud && !busy) {
        if (!speaking) channel.emit({ type: "session.input_transcript.delta", delta: "(fala captada — sem transcrição na demonstração) " });
        speaking = true;
        heardMs += 100;
        quietSince = now;
      } else if (speaking && now - quietSince > 900 && heardMs > 300) {
        speaking = false;
        heardMs = 0;
        busy = true;
        const text = ANSWERS[answer++ % ANSWERS.length];
        setTimeout(() => {
          const words = text.split(" ");
          const ms = say(ai, Math.round(words.length * 1.6), 0.14);
          words.forEach((w, i) => setTimeout(() => channel.emit({ type: "session.output_transcript.delta", delta: `${w} ` }), (i * ms) / words.length));
          setTimeout(() => (busy = false), ms + 600);
        }, 1400);
      }
    }, 100);
  }

  class Peer extends EventTarget {
    iceGatheringState = "complete";
    connectionState = "new";
    iceConnectionState = "new";
    localDescription = null;
    addTrack() {}
    createDataChannel() {
      this.channel = new Channel();
      return this.channel;
    }
    async createOffer() {
      return { type: "offer", sdp: "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n" };
    }
    async setLocalDescription(d) {
      this.localDescription = d;
    }
    async setRemoteDescription() {
      setTimeout(() => {
        this.connectionState = "connected";
        this.dispatchEvent(new Event("connectionstatechange"));
        this.channel.readyState = "open";
        this.channel.dispatchEvent(new Event("open"));
        this.dispatchEvent(Object.assign(new Event("track"), { track: ai.stream.getAudioTracks()[0], streams: [ai.stream] }));
        this.channel.emit({ type: "session.started", session: { id: "sess_demo" } });
        converse(this.channel);
      }, 900);
    }
    async getStats() {
      return new Map();
    }
    close() {
      this.channel?.close();
    }
  }
  window.RTCPeerConnection = Peer;

  addEventListener("DOMContentLoaded", () => {
    const tag = document.createElement("div");
    tag.textContent = "Demonstração · GPT-Live e agente do card simulados (sem chave no runner)";
    tag.setAttribute("style", "position:fixed;bottom:6px;left:50%;transform:translateX(-50%);z-index:60;font:11px system-ui;color:#9fb3c8;background:rgba(10,16,24,.55);padding:3px 10px;border-radius:999px;pointer-events:none;backdrop-filter:blur(4px)");
    document.body.appendChild(tag);
  });
})();

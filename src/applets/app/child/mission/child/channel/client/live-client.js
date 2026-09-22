// Transport only. No geometry, energy or game decisions belong here.
export class LiveClient {
  constructor({ audio, onEvent, createSession, onStatus }) {
    Object.assign(this, { audio, onEvent, createSession, onStatus });
    this.generation = 0;
    this.contextQueue = [];
  }

  async start() {
    const generation = ++this.generation;
    this.onStatus("Connecting", false);
    try {
      const peer = this.peer = new RTCPeerConnection();
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (generation !== this.generation) {
        microphone.getTracks().forEach(track => track.stop());
        return;
      }
      this.microphone = microphone;
      microphone.getTracks().forEach(track => peer.addTrack(track, microphone));
      peer.addEventListener("track", event => {
        this.audio.srcObject = event.streams[0] || new MediaStream([event.track]);
        this.audio.play().catch(() => console.warn("Use the audio controls to enable playback."));
      });
      peer.addEventListener("connectionstatechange", () => {
        if (peer.connectionState === "failed" && generation === this.generation) this.dispose("Connection failed");
      });
      const channel = this.channel = peer.createDataChannel("oai-events");
      channel.addEventListener("message", ({ data }) => {
        if (generation !== this.generation) return;
        let event;
        try { event = JSON.parse(data); } catch { return; }
        if (event.type === "session.started") {
          this.ready = true;
          clearTimeout(this.startTimeout);
          this.onStatus("Connected", true);
          this.flushContext();
        }
        this.onEvent(event);
        if (event.type === "session.closed") this.dispose("Conversation ended");
      });
      channel.addEventListener("close", () => {
        if (generation === this.generation) this.dispose("Disconnected");
      });
      channel.addEventListener("error", () => console.error("Live data channel error"));
      await peer.setLocalDescription(await peer.createOffer());
      await this.gatherIce(peer);
      if (generation !== this.generation) return;
      this.startTimeout = setTimeout(() => this.dispose("Session startup timed out"), 30_000);
      const result = await this.createSession(peer.localDescription.sdp);
      if (generation !== this.generation) return;
      this.sessionId = result.session?.id;
      if (!this.sessionId || !result.transport?.sdp) throw new Error("Incomplete SDP answer");
      await peer.setRemoteDescription({ type: "answer", sdp: result.transport.sdp });
      // HTTP creation starts the WebRTC session. Never send session.start here.
    } catch (error) {
      if (generation === this.generation) {
        this.dispose(error.message);
      }
    }
  }

  gatherIce(peer) {
    if (peer.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.cancelIce = () => {
        clearTimeout(timeout); peer.removeEventListener("icegatheringstatechange", finish);
        reject(new Error("Mission ended during ICE gathering"));
      };
      const finish = () => {
        if (peer.iceGatheringState !== "complete") return;
        clearTimeout(timeout);
        peer.removeEventListener("icegatheringstatechange", finish);
        resolve();
      };
      const timeout = setTimeout(() => {
        peer.removeEventListener("icegatheringstatechange", finish);
        reject(new Error("ICE gathering timed out"));
      }, 10_000);
      peer.addEventListener("icegatheringstatechange", finish);
      finish();
    });
  }

  context(content, speak = true) {
    this.contextQueue.push({ type: speak ? "session.commentary.append" : "session.thinking.append",
      event_id: crypto.randomUUID(), delegation_id: null, content });
    this.flushContext();
  }

  flushContext() {
    if (!this.ready || this.channel?.readyState !== "open") return;
    // Ordinary client facts go directly to Live; Node is needed for tool results.
    for (const event of this.contextQueue.splice(0)) this.channel.send(JSON.stringify(event));
  }

  end() {
    if (!this.ready || this.channel?.readyState !== "open") return this.dispose("Conversation ended");
    this.channel.send(JSON.stringify({ type: "session.close" }));
    this.onStatus("Finishing conversation", false);
    this.closeTimeout = setTimeout(() => this.dispose("Closed without session.closed"), 15_000);
  }

  dispose(status) {
    ++this.generation;
    clearTimeout(this.startTimeout);
    clearTimeout(this.closeTimeout);
    this.cancelIce?.(); this.cancelIce = null;
    this.ready = false;
    this.microphone?.getTracks().forEach(track => track.stop());
    this.channel?.close();
    this.peer?.close();
    this.audio.srcObject = null;
    this.contextQueue = [];
    this.onStatus(status, false, true);
  }
}

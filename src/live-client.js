// Transport only. No geometry, energy or game decisions belong here.
export class LiveClient {
  constructor({ audio, onEvent, onBridge, onStatus, onLog }) {
    Object.assign(this, { audio, onEvent, onBridge, onStatus, onLog });
    this.generation = 0;
    this.contextQueue = [];
  }

  async start() {
    const generation = ++this.generation;
    this.onStatus("Connecting", false);
    const peer = this.peer = new RTCPeerConnection();
    try {
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (generation !== this.generation) {
        microphone.getTracks().forEach(track => track.stop());
        return;
      }
      this.microphone = microphone;
      this.onLog("microphone acquired");
      microphone.getTracks().forEach(track => peer.addTrack(track, microphone));
      peer.addEventListener("track", event => {
        this.audio.srcObject = event.streams[0] || new MediaStream([event.track]);
        this.audio.play().catch(() => this.onLog("Use the audio controls to enable playback."));
      });
      peer.addEventListener("connectionstatechange", () => {
        this.onLog("peer " + peer.connectionState);
        if (peer.connectionState === "failed" && generation === this.generation) this.dispose("Connection failed");
      });
      const channel = this.channel = peer.createDataChannel("oai-events");
      channel.addEventListener("message", ({ data }) => {
        if (generation !== this.generation) return;
        let event;
        try { event = JSON.parse(data); } catch { return this.onLog("Invalid Live JSON"); }
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
      channel.addEventListener("error", () => this.onLog("Live data channel error"));
      await peer.setLocalDescription(await peer.createOffer());
      await this.gatherIce(peer);
      if (generation !== this.generation) return;
      this.abort = new AbortController();
      this.startTimeout = setTimeout(() => this.dispose("Session startup timed out"), 30_000);
      const response = await fetch("/api/session", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sdp: peer.localDescription.sdp }), signal: this.abort.signal,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Session creation failed");
      if (generation !== this.generation) return;
      this.sessionId = result.session?.id;
      if (!this.sessionId || !result.transport?.sdp) throw new Error("Incomplete SDP answer");
      this.connectBridge(generation);
      await peer.setRemoteDescription({ type: "answer", sdp: result.transport.sdp });
      this.onLog("SDP answer set; awaiting session.started");
      // HTTP creation starts the WebRTC session. Never send session.start here.
    } catch (error) {
      if (generation === this.generation) {
        this.onLog(error.message);
        this.dispose(error.message);
      }
    }
  }

  gatherIce(peer) {
    if (peer.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve, reject) => {
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

  connectBridge(generation) {
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    this.bridge = new WebSocket(scheme + "//" + location.host + "/ws?session_id=" + encodeURIComponent(this.sessionId));
    this.bridge.addEventListener("message", ({ data }) => {
      if (generation !== this.generation) return;
      let event;
      try { event = JSON.parse(data); } catch { return this.onLog("Invalid bridge JSON"); }
      this.onBridge(event);
    });
    this.bridge.addEventListener("close", () => this.onLog("Local command bridge closed"));
    this.bridge.addEventListener("error", () => this.onLog("Local command bridge error"));
  }

  sendResult(message) {
    if (this.bridge?.readyState !== WebSocket.OPEN) {
      this.onLog("Result could not be sent: local command bridge closed", message);
      return false;
    }
    this.bridge.send(JSON.stringify(message));
    return true;
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
    this.abort?.abort();
    this.ready = false;
    this.microphone?.getTracks().forEach(track => track.stop());
    this.channel?.close();
    this.peer?.close();
    this.bridge?.close();
    this.audio.srcObject = null;
    this.contextQueue = [];
    this.onStatus(status, false, true);
  }
}

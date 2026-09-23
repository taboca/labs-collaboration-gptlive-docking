import OpenAI from 'openai';
import { SidebandWS } from 'openai/resources/live/sideband/ws';
import { randomUUID } from 'node:crypto';
import { liveSession } from './gptLiveSession.js';

const commands = Object.freeze({
  inspect_starship: 'inspect',
  analyze_rotation_speed: 'analyzeRotationSpeed',
  approach_station: 'approach',
  brake_ship: 'brake',
  dock_objects: 'dock',
});

// Only this adapter knows nested Responses events and OpenAI correlation IDs.
export class OpenAILiveService {
  constructor({ apiKey, client, connectSideband } = {}) {
    this.client = client || (apiKey
      ? new OpenAI({ apiKey, maxRetries: 0 })
      : null);
    this.connectSideband = connectSideband || (id => new SidebandWS(
      this.client,
      { session_id: id },
    ));
    this.generation = 0;
  }

  // Called for Channel's `Connect` operation by
  // src/applets/app/child/mission/child/channel/server/index.js. Channel owns
  // lifecycle; this adapter owns OpenAI Live/sideband protocol. The callbacks
  // bridge delegated commands and status back to Mission. `executeCommand`
  // receives a mapped application command, not an OpenAI function-call event.
  async start(sdp, { executeCommand, status }) {
    if (typeof sdp !== 'string' || !sdp.trim() || sdp.length > 60000) {
      throw new Error('An SDP offer is required');
    }
    if (!this.client) {
      throw new Error('Set openaiApiKey in config.json or OPENAI_API_KEY');
    }
    if (this.starting || this.sideband) {
      throw new Error('Channel already started');
    }

    const generation = ++this.generation;
    this.starting = true;

    try {
      const result = await this.client.live.create(
        {
          session: liveSession,
          transport: { type: 'webrtc', sdp },
        },
        { maxRetries: 0 },
      );

      if (!result.session?.id || !result.transport?.sdp) {
        throw new Error('Incomplete Live session answer');
      }

      const sideband = this.connectSideband(result.session.id);
      if (generation !== this.generation) {
        sideband.socket.once('open', () => {
          sideband.send({ type: 'session.close' });
          sideband.socket.close();
        });
        throw new Error('Mission ended during channel creation');
      }

      this.sideband = sideband;
      this.calls = new Set();
      this.executeCommand = executeCommand;
      this.status = status;

      sideband.on('event', event => {
        this.handle(event, generation).catch(error => {
          status(`Sideband error: ${error.message}`);
        });
      });
      sideband.on('error', () => status('Sideband error'));
      sideband.socket.on('open', () => status('Sideband connected'));
      sideband.socket.on('close', () => {
        if (generation === this.generation) {
          status('Sideband closed');
        }
      });

      return result;
    } finally {
      if (generation === this.generation) {
        this.starting = false;
      }
    }
  }

  async handle(envelope, generation = this.generation) {
    if (generation !== this.generation) {
      return;
    }
    if (envelope.type === 'session.closed') {
      this.status('closed');
      return;
    }
    if (envelope.type === 'error') {
      this.status(envelope.error?.message || 'Live error');
      return;
    }

    const event = envelope.event;
    if (
      envelope.type !== 'response.event'
      || event?.type !== 'response.output_item.done'
      || event.item?.type !== 'function_call'
    ) {
      return;
    }

    const item = event.item;
    if (!item.call_id || this.calls.has(item.call_id)) {
      return;
    }
    this.calls.add(item.call_id);

    let result;
    try {
      const args = JSON.parse(item.arguments || '{}');
      if (
        !commands[item.name]
        || !args
        || Array.isArray(args)
        || typeof args !== 'object'
        || Object.keys(args).length
      ) {
        throw new Error('Unsupported tool or arguments');
      }
      result = await this.executeCommand(commands[item.name]);
    } catch (error) {
      result = { status: 'failed', reason: error.message };
    }

    if (generation !== this.generation) {
      return;
    }

    this.send({
      type: 'response.item.create',
      event_id: randomUUID(),
      item: {
        type: 'function_call_output',
        call_id: item.call_id,
        output: JSON.stringify(result),
      },
    });
    this.send({
      type: 'response.create',
      event_id: randomUUID(),
    });
  }

  send(event) {
    if (this.sideband?.socket.readyState !== 1) {
      throw new Error('Live sideband is not connected');
    }
    this.sideband.send(event);
  }

  context(content) {
    if (this.sideband?.socket.readyState === 1) {
      this.send({
        type: 'session.commentary.append',
        event_id: randomUUID(),
        delegation_id: null,
        content,
      });
    }
  }

  missionFailed(reason) {
    this.context(`Mission failed: ${reason}. Say: See you on the other side.`);
  }

  close() {
    ++this.generation;
    this.starting = false;

    if (this.sideband?.socket.readyState === 1) {
      try {
        this.sideband.send({ type: 'session.close' });
      } catch {}
    }

    const socket = this.sideband?.socket;
    if (socket?.readyState === 0) {
      const sideband = this.sideband;
      socket.once('open', () => {
        try {
          sideband.send({ type: 'session.close' });
        } finally {
          socket.close();
        }
      });
    } else {
      socket?.close();
    }

    this.sideband = null;
    this.calls?.clear();
  }
}

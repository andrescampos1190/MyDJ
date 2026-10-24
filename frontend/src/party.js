// Host side of a party session: every couple of seconds, publish the queue for friends'
// phones and pick up what they did — new song requests (already downloaded + analyzed
// by the backend) and votes. The DJ's browser stays in charge of playback and order.

import { API } from "./api";

const SYNC_MS = 2000;

export class PartyHost {
  constructor(engine) {
    this.engine = engine;
    this.on = false;
    this.addresses = []; // this computer's Wi-Fi addresses, for the join link
    this.adding = 0; // friends' songs being decoded right now
    this.error = "";
    this._timer = null;
    this._busy = false;
    this._scoresKey = "";
  }

  async start() {
    this.on = true;
    this.error = "";
    this.engine.emit();
    try {
      const r = await fetch(`${API}/api/party/info`);
      this.addresses = (await r.json()).addresses || [];
    } catch {
      this.error = `Can't reach the backend at ${API} — is it running?`;
    }
    this._timer = setInterval(() => this.sync(), SYNC_MS);
    this.sync();
  }

  stop() {
    this.on = false;
    clearInterval(this._timer);
    this._timer = null;
    this.engine.emit();
  }

  // Links friends open on their phones (one per network address of this computer).
  joinUrls() {
    const port = window.location.port ? `:${window.location.port}` : "";
    return this.addresses.map((ip) => `${window.location.protocol}//${ip}${port}/guest`);
  }

  async sync() {
    if (!this.on || this._busy) return;
    this._busy = true;
    let problem = "";
    try {
      const res = await fetch(`${API}/api/party/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshot: this.engine.partySnapshot() }),
      });
      if (!res.ok) throw new Error(`Party sync failed (${res.status})`);
      const { requests, scores } = await res.json();
      let added = false;
      for (const r of requests) {
        this.adding++;
        this.engine.emit();
        try {
          await this.engine.addAnalyzed(r);
          added = true;
        } catch (e) {
          problem = `Couldn't add "${r.title}" from ${r.addedBy}: ${e.message}`;
        } finally {
          this.adding--;
        }
      }
      const key = JSON.stringify(scores);
      if (added || key !== this._scoresKey) {
        this._scoresKey = key;
        this.engine.applyVotes(scores);
      }
    } catch (e) {
      problem = e.message || "Party sync failed";
    } finally {
      this._busy = false;
      this.error = problem;
      this.engine.emit();
    }
  }
}

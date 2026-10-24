// Host side of a party session: every second, publish the queue for friends' phones and
// pick up what they did — new song requests (already downloaded + analyzed by the
// backend), votes, and who's connected. The DJ's browser stays in charge of playback.

import { API } from "./api";

const SYNC_MS = 1000;
const CHECK_TIMEOUT_MS = 3000;

export class PartyHost {
  constructor(engine) {
    this.engine = engine;
    this.on = false;
    this.addresses = []; // this computer's network addresses; the likely Wi-Fi one first
    this.loaded = false; // addresses looked up
    this.selected = 0; // which address the QR code shows
    this.guests = []; // names of phones connected right now
    this.working = 0; // friends' songs the backend is still downloading
    this.adding = 0; // friends' songs being decoded into the playlist right now
    this.check = null; // {ip, backend, app}: can the network reach this computer?
    this.error = "";
    this._timer = null;
    this._busy = false;
    this._scoresKey = "";
  }

  async start() {
    this.on = true;
    this.error = "";
    this.check = null;
    this.loaded = false;
    this.engine.emit();
    try {
      const r = await fetch(`${API}/api/party/info`);
      this.addresses = (await r.json()).addresses || [];
      this.selected = 0;
      this.loaded = true;
    } catch {
      this.error = `Can't reach the music server at ${API} — is the backend running?`;
    }
    this._timer = setInterval(() => this.sync(), SYNC_MS);
    this.sync();
    this.checkNetwork();
  }

  stop() {
    this.on = false;
    clearInterval(this._timer);
    this._timer = null;
    this.guests = [];
    this.engine.emit();
  }

  select(i) {
    this.selected = i;
    this.check = null;
    this.engine.emit();
    this.checkNetwork();
  }

  // Links friends open on their phones (one per network address of this computer).
  joinUrls() {
    const port = window.location.port ? `:${window.location.port}` : "";
    return this.addresses.map((ip) => `${window.location.protocol}//${ip}${port}/guest`);
  }

  // Can the music server and the app be reached on this computer's network address, not
  // just on localhost? (A firewall only bites for other devices, so a phone connecting is
  // the final proof — the panel shows that too.)
  async checkNetwork() {
    const ip = this.addresses[this.selected];
    const api = new URL(API);
    const onThisComputer =
      ["localhost", "127.0.0.1"].includes(api.hostname) || api.hostname === window.location.hostname;
    if (!ip || !onThisComputer) return; // e.g. a deployed backend: nothing local to check
    const reach = async (url, opts) => {
      try {
        const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
        return opts?.mode === "no-cors" || r.ok;
      } catch {
        return false;
      }
    };
    const proto = window.location.protocol;
    const [backend, app] = await Promise.all([
      reach(`${proto}//${ip}:${api.port || 8000}/api/health`),
      reach(`${proto}//${ip}${window.location.port ? `:${window.location.port}` : ""}/`, {
        mode: "no-cors",
      }),
    ]);
    if (this.addresses[this.selected] === ip) this.check = { ip, backend, app };
    this.engine.emit();
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
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`Party sync failed (${res.status})`);
      const { requests, scores, guests, working } = await res.json();
      this.guests = guests || [];
      this.working = working || 0;
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
      problem =
        e.name === "TimeoutError" || e instanceof TypeError
          ? `Lost contact with the music server at ${API} — is the backend still running?`
          : e.message || "Party sync failed";
    } finally {
      this._busy = false;
      this.error = problem;
      this.engine.emit();
    }
  }
}

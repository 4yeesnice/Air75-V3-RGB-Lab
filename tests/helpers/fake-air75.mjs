// Simulated Air75 V3 for the Windows bridge, modelled on the Swift self-test Board:
// session XOR key, both routing forms, D6 quantization on 1.0.23.6, palette rendering.
import * as S4 from "../../bridge-win/s4.mjs";

export class FakeAir75 {
  constructor({ firmware = [16, 0, 1, 170, 6, 0, 0, 0], state, key = 0x80, profile = 0, plaintextRoute = false } = {}) {
    this.firmware = firmware;
    this.state = state ?? (S4.stateLength(firmware) === 22
      ? [22, 75, 2, 0, 0, 3, 0, 190, 174, 4, 60, 2, 1, 0, 255, 0, 0, 3, 24, 48, 96, 2]
      : [6, 25, 4, 0, 1, 0, 0, 1, 64, 4, 60, 0, 1, 0, 255, 0, 0]);
    if (firmware[0] === 23) this.state.splice(6, 3, ...S4.mainColorReadback(this.state.slice(6, 9)));
    this.rgb = new Array(312).fill(20);
    this.key = key;
    this.profile = profile;
    this.plaintextRoute = plaintextRoute;
    this.writes = 0;
    this.masterOff = false;
    this.onRemoved = null;
    this.isOpen = false;
    this.unplugged = false;
  }
  // transport interface
  async open() { if (this.unplugged) throw S4.failure("DEVICE_NOT_FOUND", "not found"); this.isOpen = true; return { serial: "FAKE-1" }; }
  get connected() { return this.isOpen && !this.unplugged; }
  async close() { this.isOpen = false; }
  unplug() { this.unplugged = true; this.onRemoved?.(); }

  rendered() {
    const out = [...this.rgb];
    if (this.firmware[0] >= 17 && this.state[0] === 21) {
      const value = Math.trunc((Math.max(...this.state.slice(6, 9)) * 200) / 255);
      for (let i = 0; i < 252; i++) {
        const v = Math.trunc((this.rgb[i] * value) / 255);
        out[i] = i >= 250 ? Math.trunc((v * 150) / 255) : v;
      }
    }
    if (this.state[0] === 0 && this.state[1] === 0) return out.map(() => 0);
    if (this.state[0] === 2 && this.state[1] === 0) return out.map(() => 0);
    return out;
  }

  async exchange(frame) {
    if (!this.connected) throw S4.failure("DISCONNECTED", "unplugged");
    if (frame[0] !== 0x55 || frame[3] !== S4.checksum(frame)) throw new Error("fake: bad request frame");
    const cmd = frame[1];
    // A1/D1 are sent with key 0 before the key is known; the board answers with its session key.
    const reqKey = cmd === 0xa1 ? 0 : this.key;
    const length = frame[4] ^ reqKey, address = (frame[5] ^ reqKey) | ((frame[6] ^ reqKey) << 8), handle = frame[7] ^ reqKey;
    const body = frame.slice(8, 8 + length).map((v) => v ^ reqKey);
    let payload;
    switch (cmd) {
      case 0xa1: payload = this.firmware; break;
      case 0xa0: payload = [this.profile, 8, 4, 6, 16, 2, 0, 0]; break;
      case 0xd1: payload = [104]; break;
      case 0xd5: if (handle !== this.profile) throw new Error("fake: wrong profile"); payload = this.state.slice(0, length); break;
      case 0xd2: payload = this.rendered().slice(address, address + length); break;
      case 0xd6:
        this.writes++; payload = body;
        if (!this.masterOff) {
          this.state.splice(address, length, ...body);
          if (this.firmware[0] === 23 && address <= 6 && address + length >= 9) this.state.splice(6, 3, ...S4.mainColorReadback(this.state.slice(6, 9)));
        }
        break;
      case 0xd8:
        this.writes++; payload = body;
        for (let i = 0; i < length; i += 4) this.rgb.splice(body[i] * 3, 3, ...body.slice(i + 1, i + 4));
        break;
      default: throw new Error(`fake: unexpected command ${cmd.toString(16)}`);
    }
    const reply = new Array(64).fill(0);
    reply[0] = 0xaa; reply[1] = cmd;
    const route = [length, address & 255, address >> 8, handle];
    route.forEach((v, i) => { reply[4 + i] = this.plaintextRoute ? v : v ^ this.key; });
    payload.forEach((v, i) => { reply[8 + i] = v ^ this.key; });
    reply[3] = S4.checksum(reply);
    return reply;
  }
}

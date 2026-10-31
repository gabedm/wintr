// Server-only credential holder. Injected by the controller-owned runtime
// binding; never read from the environment here. Every string/JSON/inspect
// conversion is redacted so a secret cannot leak through logs or errors.

const REDACTED = '[redacted]';

export class ServerSecret {
  readonly #value: string;

  constructor(value: string) {
    if (typeof value !== 'string' || value.length < 8 || value.length > 4096 || /\s/.test(value)) {
      throw new TypeError('Invalid server secret');
    }
    this.#value = value;
  }

  /** Only provider adapters call this, to set a request header for a fixed allowlisted host. */
  reveal(): string {
    return this.#value;
  }

  toString() {
    return REDACTED;
  }

  toJSON() {
    return REDACTED;
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return REDACTED;
  }
}

import { request as nodeRequest, type ClientRequest, type IncomingMessage, type RequestOptions, type Server } from 'node:http';

/** Test-owned loopback I/O, gates and runtime cancellation; no application policy. */
export function createHttpFixture() {
  const shutdowns = new Set<AbortController>();
  const gates = new Set<() => void>();
  const requests = new Set<ClientRequest>();
  const pending = new Set<Promise<unknown>>();
  let closing = false;
  return {
    shutdown(): AbortSignal {
      const controller = new AbortController();
      if (closing) controller.abort('invented fixture teardown');
      else shutdowns.add(controller);
      return controller.signal;
    },
    gate() {
      if (closing) return { gate: Promise.resolve(), release: () => {} };
      let release!: () => void;
      const gate = new Promise<void>(resolve => {
        release = () => { gates.delete(release); resolve(); };
      });
      gates.add(release);
      return { gate, release };
    },
    request(options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest {
      if (closing) throw new Error('invented fixture teardown');
      const req = nodeRequest(options, callback);
      requests.add(req);
      req.once('close', () => requests.delete(req));
      // Individual response promises still reject normally; this observes an
      // abandoned request if an assertion ended its test before awaiting it.
      req.on('error', () => {});
      return req;
    },
    observe<T>(request: Promise<T>): Promise<T> {
      pending.add(request);
      void request.then(() => pending.delete(request), () => pending.delete(request));
      return request;
    },
    async close(servers: Server[]): Promise<void> {
      closing = true;
      for (const controller of shutdowns) controller.abort('invented fixture teardown');
      shutdowns.clear();
      for (const release of [...gates]) release();
      for (const req of requests) req.destroy(new Error('invented fixture teardown'));
      const serverClosures = servers.map(server => new Promise<void>(resolve => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        server.closeAllConnections();
      }));
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([Promise.allSettled([...pending]), Promise.all(serverClosures)]),
          new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('fixture teardown did not settle')), 5000); }),
        ]);
        // Let already-queued bounded accounting callbacks finish as well.
        await new Promise<void>(resolve => setImmediate(resolve));
      } finally {
        clearTimeout(timeout);
        requests.clear();
        closing = false;
      }
    },
  };
}

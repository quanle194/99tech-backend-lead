import { Server } from 'http';
import { AddressInfo } from 'net';
import { createApp } from '../../src/app';

// Concurrency tests fire requests at one real listening server, so they genuinely overlap in the
// database instead of each spinning up its own ephemeral server.
export function useServer(): () => string {
  let server: Server;
  let url = '';
  beforeAll((done) => {
    server = createApp().listen(0, () => {
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      done();
    });
  });
  afterAll((done) => {
    server.close(done);
  });
  return () => url;
}

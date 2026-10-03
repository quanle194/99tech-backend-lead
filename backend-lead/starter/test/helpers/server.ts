import { Server } from 'http';
import { AddressInfo } from 'net';
import { createApp } from '../../src/app';
import { sequelize } from '../../src/db/sequelize';

// Concurrency tests fire requests at one real listening server, so they genuinely overlap in the
// database instead of each spinning up its own ephemeral server.
const SEQUELIZE_DEFAULT_POOL_MAX = 5;

export function useServer(): () => string {
  let server: Server;
  let url = '';
  beforeAll((done) => {
    server = createApp().listen(0, () => {
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      done();
    });
  });
  // The pool opens connections lazily. Without warm connections the first concurrent requests wait
  // for connection setup one by one and never actually race, so a test could pass with the locks removed.
  beforeEach(async () => {
    await Promise.all(Array.from({ length: SEQUELIZE_DEFAULT_POOL_MAX }, () => sequelize.query('SELECT pg_sleep(0.01)')));
  });
  afterAll((done) => {
    server.close(done);
  });
  return () => url;
}

import { Server } from 'http';
import { AddressInfo } from 'net';
import { createApp } from '../../src/app';
import { sequelize } from '../../src/db/sequelize';

// Concurrency tests fire requests at one real listening server, so they genuinely overlap in the
// database instead of each spinning up its own ephemeral server. With a pool of 5, at most
// 5 transactions run at once and the rest queue for a connection; overlap is what matters.
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
    const poolSize = sequelize.config.pool?.max ?? 5;
    await Promise.all(Array.from({ length: poolSize }, () => sequelize.query('SELECT pg_sleep(0.01)')));
  });
  afterAll((done) => {
    server.close(done);
  });
  return () => url;
}

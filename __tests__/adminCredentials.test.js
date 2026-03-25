const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

function basicAuthHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

describe('admin credentials endpoint', () => {
  let app;
  let db;
  let tempDir;

  beforeEach(() => {
    jest.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dagmarcom-admin-'));
    process.env.DB_PATH = path.join(tempDir, 'dagmarcom.db');
    process.env.BASIC_USER = 'admin';
    process.env.BASIC_PASS = 'secret123';
    app = require('../src/server');
    db = require('../src/db');
  });

  afterEach(() => {
    delete process.env.DB_PATH;
    delete process.env.BASIC_USER;
    delete process.env.BASIC_PASS;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('umí číst, změnit, deaktivovat i obnovit admin účet', async () => {
    let response = await request(app)
      .get('/api/admin/credentials')
      .set('Authorization', basicAuthHeader('admin', 'secret123'));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      adminUsername: 'admin',
      passwordConfigured: false,
      enabled: true,
    });

    response = await request(app)
      .put('/api/admin/credentials')
      .set('Authorization', basicAuthHeader('admin', 'secret123'))
      .send({
        adminUsername: 'spravce',
        adminPassword: 'NovaHesla123',
        enabled: false,
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      adminUsername: 'spravce',
      passwordConfigured: true,
      enabled: false,
    });

    response = await request(app)
      .get('/api/admin/credentials')
      .set('Authorization', basicAuthHeader('spravce', 'NovaHesla123'));

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'admin_disabled' });

    await new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO reset_tokens(token, email, created_at) VALUES(?, ?, ?)',
        ['token-pro-restore-123456', 'spravce@example.com', Date.now()],
        (err) => (err ? reject(err) : resolve())
      );
    });

    response = await request(app).post('/api/status/reset-password').send({
      token: 'token-pro-restore-123456',
      password: 'NovaHesla456',
      user: 'spravce',
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
    });

    response = await request(app)
      .get('/api/admin/credentials')
      .set('Authorization', basicAuthHeader('spravce', 'NovaHesla456'));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      adminUsername: 'spravce',
      passwordConfigured: true,
      enabled: true,
    });
  });
});

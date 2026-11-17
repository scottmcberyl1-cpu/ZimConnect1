const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createDatabase } = require("./db");
const { createApp } = require("./server");

test("registration, profile updates, and logout use authenticated sessions", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zimconnect-test-"));
  const db = createDatabase(path.join(directory, "test.sqlite"));
  const server = createApp(db).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const register = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      fullName: "Beryl Mawozvere",
      email: "BERYL@example.com",
      password: "a-secure-test-password",
      phone: "+263 771 234 567",
      role: "admin"
    })
  });
  assert.equal(register.status, 201);
  const { token, user } = await register.json();
  assert.equal(user.role, "consumer");
  assert.equal(user.email, "beryl@example.com");
  assert.equal("password_hash" in user, false);

  const duplicate = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      fullName: "Beryl Mawozvere",
      email: "beryl@example.com",
      password: "a-secure-test-password"
    })
  });
  assert.equal(duplicate.status, 409);

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "beryl@example.com", password: "a-secure-test-password" })
  });
  assert.equal(login.status, 200);
  assert.ok((await login.json()).token);

  const profile = await fetch(`${baseUrl}/api/profile`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ fullName: "Beryl M.", location: "Harare" })
  });
  assert.equal(profile.status, 200);
  assert.equal((await profile.json()).user.fullName, "Beryl M.");

  const privilegeEscalation = await fetch(`${baseUrl}/api/profile`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ role: "admin" })
  });
  assert.equal(privilegeEscalation.status, 400);

  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(logout.status, 204);
  const afterLogout = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(afterLogout.status, 401);
});

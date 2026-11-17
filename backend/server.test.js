const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createDatabase } = require("./db");
const { createApp } = require("./server");

test("registration, profile updates, and logout use authenticated sessions", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zimconnect-test-"));
  const db = await createDatabase(path.join(directory, "test.sqlite"));
  const outbound = { email: [], sms: [] };
  const uploadedKeys = new Map();
  const services = {
    sendEmail: async (message) => outbound.email.push(message),
    sendSms: async (message) => outbound.sms.push(message),
    createPrivateUploadUrl: async (key, contentType) => {
      uploadedKeys.set(key, contentType);
      return "https://private-storage.example/upload";
    },
    inspectPrivateObject: async (key) => ({ size: 100, contentType: uploadedKeys.get(key), etag: '"object-etag"' }),
    validatePrivateObject: async () => {},
    scanPrivateObject: async () => {},
    promotePrivateObject: async () => {},
    deletePrivateObject: async () => {},
    createPrivateDownloadUrl: async () => "https://private-storage.example/download"
  };
  const environmentNames = [
    "NODE_ENV", "PAYNOW_ENABLED", "IDENTITY_UPLOADS_ENABLED",
    "IDENTITY_POLICY_URL", "IDENTITY_POLICY_VERSION"
  ];
  const originalEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));
  process.env.NODE_ENV = "test";
  process.env.PAYNOW_ENABLED = "false";
  process.env.IDENTITY_UPLOADS_ENABLED = "true";
  process.env.IDENTITY_POLICY_URL = "https://example.com/identity-policy";
  process.env.IDENTITY_POLICY_VERSION = "test-v1";
  t.after(() => {
    for (const name of environmentNames) {
      if (originalEnvironment[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnvironment[name];
    }
  });
  const server = createApp(db, { providers: services }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await db.close();
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
  assert.equal(register.status, 202);
  const { user } = await register.json();
  assert.equal(user.role, "consumer");
  assert.equal(user.email, "beryl@example.com");
  assert.equal(user.emailVerified, false);
  assert.equal("password_hash" in user, false);

  const emailLinkUrl = outbound.email[0].text.match(/https?:\/\/\S+/)[0];
  const emailToken = new URL(emailLinkUrl).hash.slice(1);
  const emailLink = await fetch(`${baseUrl}/api/auth/verify-email`);
  assert.equal(emailLink.status, 200);
  const emailVerification = await fetch(`${baseUrl}/api/auth/verify-email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: emailToken })
  });
  assert.equal(emailVerification.status, 200);
  const phoneCode = outbound.sms[0].message.match(/\b\d{6}\b/)[0];
  const phoneVerification = await fetch(`${baseUrl}/api/auth/verify-phone`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "beryl@example.com", code: phoneCode })
  });
  assert.equal(phoneVerification.status, 200);
  const { token } = await phoneVerification.json();

  const duplicate = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      fullName: "Beryl Mawozvere",
      email: "beryl@example.com",
      password: "a-secure-test-password",
      phone: "+263771234567"
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

  await db.prepare("UPDATE users SET role = 'business', identity_status = 'verified' WHERE id = ?").run(user.id);
  const productResponse = await fetch(`${baseUrl}/api/products`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "Test product", description: "Test order item", price: 12.34, stock: 3 })
  });
  assert.equal(productResponse.status, 201);
  const product = await productResponse.json();
  const orderResponse = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ items: [{ productId: product.id, quantity: 1 }] })
  });
  assert.equal(orderResponse.status, 201);
  const order = await orderResponse.json();
  assert.equal(order.payment.mode, "sandbox");
  assert.equal(order.payment.status, "sandbox_pending");
  const paymentCompletion = await fetch(`${baseUrl}/api/payments/${order.payment.id}/sandbox/complete`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(paymentCompletion.status, 200);
  assert.equal((await paymentCompletion.json()).status, "sandbox_paid");

  const identityUpload = await fetch(`${baseUrl}/api/identity/documents`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      documentType: "id_front",
      contentType: "image/jpeg",
      fileSize: 100,
      legalConsent: true
    })
  });
  assert.equal(identityUpload.status, 201);
  const upload = await identityUpload.json();
  assert.match(upload.headers["x-amz-server-side-encryption"], /AES256/);
  const uploadComplete = await fetch(`${baseUrl}/api/identity/documents/${upload.id}/complete`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(uploadComplete.status, 200);
  assert.equal((await uploadComplete.json()).status, "pending_review");

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

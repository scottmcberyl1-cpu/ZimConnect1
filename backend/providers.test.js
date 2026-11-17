const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { verifyPaynowCallback } = require("./providers");

test("Paynow callback signatures are verified and tampering is rejected", (t) => {
  const names = ["PAYNOW_INTEGRATION_ID", "PAYNOW_INTEGRATION_KEY"];
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.PAYNOW_INTEGRATION_ID = "test-integration";
  process.env.PAYNOW_INTEGRATION_KEY = "test-secret-key";
  t.after(() => {
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  });

  const fields = {
    reference: "test-payment-reference",
    amount: "12.34",
    status: "Paid",
    pollurl: "https://www.paynow.co.zw/interface/poll?id=test"
  };
  const hash = crypto.createHash("sha512")
    .update(Object.values(fields).join("") + process.env.PAYNOW_INTEGRATION_KEY)
    .digest("hex")
    .toUpperCase();

  assert.equal(verifyPaynowCallback({ ...fields, hash }), true);
  assert.equal(verifyPaynowCallback({ ...fields, amount: "99.99", hash }), false);
  assert.equal(verifyPaynowCallback({ ...fields, hash: "invalid" }), false);
});

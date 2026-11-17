const crypto = require("node:crypto");
const { HttpError } = require("./errors");

function amountInCents(value, name = "Price") {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000 || Math.round(amount * 100) < 1) {
    throw new HttpError(400, `${name} must be greater than zero and no more than 100,000 USD.`);
  }
  return Math.round(amount * 100);
}

function safeInteger(value, name, maximum) {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new HttpError(400, `${name} must be an integer from 0 to ${maximum}.`);
  }
  return value;
}

function parseGatewayAmount(value) {
  if (typeof value !== "string" || !/^\d{1,6}(?:\.\d{1,2})?$/.test(value)) return null;
  return Math.round(Number(value) * 100);
}

function successfulPaynowStatus(status) {
  return ["paid", "awaiting delivery", "delivered"].includes(String(status).trim().toLowerCase());
}

function registerCommerceRoutes({ app, db, requireAuth, requireRole, providers }) {
  app.get("/api/products", async (req, res) => {
    const products = await db.prepare(`
      SELECT p.id, p.name, p.description, p.price_cents AS priceCents, p.currency,
        p.stock, p.seller_id AS sellerId, u.full_name AS sellerName
      FROM products p JOIN users u ON u.id = p.seller_id
      WHERE p.status = 'active' AND p.stock > 0
      ORDER BY p.created_at DESC LIMIT 100
    `).all();
    res.json({ products: products.map((product) => ({ ...product, price: product.priceCents / 100 })) });
  });

  app.post("/api/products", requireAuth, async (req, res) => {
    if (!["business", "supplier"].includes(req.auth.user.role)) {
      throw new HttpError(403, "A verified business or supplier account is required.");
    }
    const body = req.body || {};
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 120) {
      throw new HttpError(400, "Product name must be 1 to 120 characters.");
    }
    if (typeof body.description !== "string" || body.description.length > 2000) {
      throw new HttpError(400, "Product description must be no more than 2,000 characters.");
    }
    const priceCents = amountInCents(body.price);
    const stock = safeInteger(body.stock, "Stock", 100000);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.prepare(`
      INSERT INTO products (id, seller_id, name, description, price_cents, stock, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, req.auth.user.id, body.name.trim(), body.description.trim(), priceCents, stock, now, now);
    res.status(201).json({ id, name: body.name.trim(), price: priceCents / 100, currency: "USD", stock });
  });

  app.patch("/api/products/:id", requireAuth, async (req, res) => {
    if (!["business", "supplier", "admin"].includes(req.auth.user.role)) {
      throw new HttpError(403, "A verified business or supplier account is required.");
    }
    const body = req.body || {};
    const allowed = new Set(["name", "description", "price", "stock", "status"]);
    const keys = Object.keys(body);
    if (!keys.length || keys.some((key) => !allowed.has(key))) {
      throw new HttpError(400, "Provide one or more valid product fields.");
    }
    const current = await db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
    if (!current || (req.auth.user.role !== "admin" && current.seller_id !== req.auth.user.id)) {
      throw new HttpError(404, "Product not found.");
    }
    const values = {
      name: current.name,
      description: current.description,
      priceCents: current.price_cents,
      stock: current.stock,
      status: current.status,
      updatedAt: new Date().toISOString(),
      id: req.params.id
    };
    if (Object.hasOwn(body, "name")) {
      if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 120) {
        throw new HttpError(400, "Product name must be 1 to 120 characters.");
      }
      values.name = body.name.trim();
    }
    if (Object.hasOwn(body, "description")) {
      if (typeof body.description !== "string" || body.description.length > 2000) {
        throw new HttpError(400, "Product description must be no more than 2,000 characters.");
      }
      values.description = body.description.trim();
    }
    if (Object.hasOwn(body, "price")) values.priceCents = amountInCents(body.price);
    if (Object.hasOwn(body, "stock")) values.stock = safeInteger(body.stock, "Stock", 100000);
    if (Object.hasOwn(body, "status")) {
      if (!["active", "inactive"].includes(body.status)) throw new HttpError(400, "Product status is invalid.");
      values.status = body.status;
    }
    await db.prepare(`
      UPDATE products SET name = @name, description = @description, price_cents = @priceCents,
        stock = @stock, status = @status, updated_at = @updatedAt WHERE id = @id
    `).run(values);
    res.json({ id: req.params.id, name: values.name, description: values.description,
      price: values.priceCents / 100, stock: values.stock, status: values.status });
  });

  app.post("/api/orders", requireAuth, async (req, res) => {
    const items = req.body && req.body.items;
    if (!Array.isArray(items) || items.length < 1 || items.length > 30) {
      throw new HttpError(400, "An order must contain between 1 and 30 distinct products.");
    }
    const seen = new Set();
    for (const item of items) {
      if (!item || typeof item.productId !== "string" || !/^[0-9a-f-]{36}$/i.test(item.productId) ||
          !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 100 || seen.has(item.productId)) {
        throw new HttpError(400, "Each order item must have a unique product ID and quantity from 1 to 100.");
      }
      seen.add(item.productId);
    }
    const paynowEnabled = process.env.PAYNOW_ENABLED === "true";
    if (process.env.NODE_ENV === "production" && !paynowEnabled) {
      throw new HttpError(503, "Checkout is unavailable until Paynow is configured.");
    }

    const orderId = crypto.randomUUID();
    const paymentId = crypto.randomUUID();
    const now = new Date().toISOString();
    const order = await db.transaction(async () => {
      let totalCents = 0;
      let sellerId;
      const selectedItems = [];
      for (const item of items) {
        const product = await db.prepare(`
          SELECT id, seller_id, name, price_cents, stock FROM products
          WHERE id = ? AND status = 'active' ${db.isPostgres ? "FOR UPDATE" : ""}
        `).get(item.productId);
        if (!product || product.stock < item.quantity) {
          throw new HttpError(409, "A product is unavailable or has insufficient stock.");
        }
        if (sellerId && sellerId !== product.seller_id) {
          throw new HttpError(400, "An order can contain products from only one seller.");
        }
        sellerId = product.seller_id;
        const reserve = await db.prepare("UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?")
          .run(item.quantity, product.id, item.quantity);
        if (reserve.changes !== 1) throw new HttpError(409, "Product stock changed. Review your cart and try again.");
        totalCents += product.price_cents * item.quantity;
        if (!Number.isSafeInteger(totalCents) || totalCents > 10000000) {
          throw new HttpError(400, "Order total exceeds the supported limit.");
        }
        selectedItems.push({ ...product, quantity: item.quantity });
      }
      await db.prepare(`
        INSERT INTO orders (id, user_id, payment_id, status, total_cents, currency, created_at, updated_at)
        VALUES (?, ?, ?, 'pending_payment', ?, 'USD', ?, ?)
      `).run(orderId, req.auth.user.id, paymentId, totalCents, now, now);
      await db.prepare(`
        INSERT INTO payments (id, user_id, order_id, amount_cents, currency, provider, provider_reference, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?)
      `).run(paymentId, req.auth.user.id, orderId, totalCents, paynowEnabled ? "paynow" : "sandbox",
        paymentId, paynowEnabled ? "created" : "sandbox_pending", now, now);
      for (const item of selectedItems) {
        await db.prepare(`
          INSERT INTO order_items (id, order_id, product_id, seller_id, product_name, quantity, unit_price_cents)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(crypto.randomUUID(), orderId, item.id, item.seller_id, item.name, item.quantity, item.price_cents);
      }
      await addOrderEvent(db, orderId, req.auth.user.id, "pending_payment", "Order created.");
      return { totalCents };
    })();

    if (!paynowEnabled) {
      res.status(201).json({
        orderId,
        payment: { id: paymentId, amount: order.totalCents / 100, currency: "USD", status: "sandbox_pending", mode: "sandbox" }
      });
      return;
    }
    try {
      const base = process.env.PUBLIC_BASE_URL || "http://127.0.0.1:3000";
      const checkout = await providers.initiatePaynowPayment({
        reference: paymentId,
        amountCents: order.totalCents,
        email: req.auth.user.email,
        returnUrl: new URL(`/payment/return?reference=${encodeURIComponent(paymentId)}`, base).toString(),
        resultUrl: new URL("/api/payments/paynow/result", base).toString()
      });
      await db.prepare(`
        UPDATE payments SET status = 'pending', poll_url = ?, redirect_url = ?, updated_at = ?
        WHERE id = ? AND status = 'created' AND provider = 'paynow'
      `).run(checkout.pollUrl, checkout.checkoutUrl, new Date().toISOString(), paymentId);
      res.status(201).json({
        orderId,
        payment: { id: paymentId, amount: order.totalCents / 100, currency: "USD", status: "pending", checkoutUrl: checkout.checkoutUrl }
      });
    } catch (error) {
      await db.transaction(() => releaseOrderStock(db, paymentId, "failed"))();
      throw error;
    }
  });

  app.get("/api/orders", requireAuth, async (req, res) => {
    const rows = await db.prepare(`
      SELECT DISTINCT o.id, o.user_id AS userId, o.status, o.total_cents AS totalCents,
        o.currency, o.created_at AS createdAt
      FROM orders o LEFT JOIN order_items i ON i.order_id = o.id
      WHERE o.user_id = ? OR i.seller_id = ? OR ? = 'admin'
      ORDER BY o.created_at DESC LIMIT 100
    `).all(req.auth.user.id, req.auth.user.id, req.auth.user.role);
    res.json({ orders: rows.map((row) => ({ ...row, total: row.totalCents / 100 })) });
  });

  app.get("/api/orders/:id", requireAuth, async (req, res) => {
    const order = await orderDetails(db, req.params.id);
    if (!order || !canViewOrder(order, req.auth.user)) throw new HttpError(404, "Order not found.");
    res.json(order);
  });

  app.patch("/api/orders/:id/status", requireAuth, async (req, res) => {
    if (!["business", "supplier", "admin"].includes(req.auth.user.role)) {
      throw new HttpError(403, "A seller or administrator account is required.");
    }
    const nextStatus = req.body && req.body.status;
    const transitions = {
      paid: "processing",
      processing: "ready_for_pickup",
      ready_for_pickup: "in_transit",
      in_transit: "delivered"
    };
    await db.transaction(async () => {
      const order = await orderDetails(db, req.params.id, db.isPostgres);
      if (!order || (req.auth.user.role !== "admin" && !order.items.some((item) => item.sellerId === req.auth.user.id))) {
        throw new HttpError(404, "Order not found.");
      }
      if (transitions[order.status] !== nextStatus) throw new HttpError(409, "This order status transition is not allowed.");
      const now = new Date().toISOString();
      const changed = await db.prepare("UPDATE orders SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
        .run(nextStatus, now, order.id, order.status);
      if (changed.changes !== 1) throw new HttpError(409, "Order status changed. Reload and try again.");
      await addOrderEvent(db, order.id, req.auth.user.id, nextStatus, "");
      await recordAudit(db, req.auth.user.id, "order.status", order.id, { from: order.status, to: nextStatus });
      await addOrderNotification(db, order.userId, `Order ${nextStatus.replaceAll("_", " ")}`, `Your order status is now ${nextStatus.replaceAll("_", " ")}.`);
    })();
    res.json({ id: req.params.id, status: nextStatus });
  });

  app.get("/api/payments/:id", requireAuth, async (req, res) => {
    const payment = await db.prepare(`
      SELECT id, order_id AS orderId, amount_cents AS amountCents, currency, status, provider,
        redirect_url AS checkoutUrl, created_at AS createdAt
      FROM payments WHERE id = ? AND user_id = ?
    `).get(req.params.id, req.auth.user.id);
    if (!payment) throw new HttpError(404, "Payment not found.");
    res.json({
      id: payment.id,
      orderId: payment.orderId,
      amount: payment.amountCents / 100,
      currency: payment.currency,
      status: payment.status,
      mode: payment.provider === "sandbox" ? "sandbox" : "live",
      checkoutUrl: payment.checkoutUrl,
      createdAt: payment.createdAt
    });
  });

  app.post("/api/payments/:id/sandbox/complete", requireAuth, async (req, res) => {
    if (process.env.NODE_ENV === "production") throw new HttpError(404, "Not found.");
    await db.transaction(async () => {
      const payment = await db.prepare("SELECT * FROM payments WHERE id = ? AND user_id = ? AND provider = 'sandbox' AND status = 'sandbox_pending'")
        .get(req.params.id, req.auth.user.id);
      if (!payment) throw new HttpError(404, "Sandbox payment not found or already completed.");
      await db.prepare("UPDATE payments SET status = 'sandbox_paid', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), payment.id);
      if (payment.order_id) {
        await db.prepare("UPDATE orders SET status = 'paid', updated_at = ? WHERE id = ? AND status = 'pending_payment'")
          .run(new Date().toISOString(), payment.order_id);
        await addOrderEvent(db, payment.order_id, null, "paid", "Sandbox payment completed.");
      }
    })();
    res.json({ id: req.params.id, status: "sandbox_paid", mode: "sandbox", message: "No real payment was taken." });
  });

  app.post("/api/payments/paynow/result", async (req, res) => {
    const fields = req.body || {};
    if (!Object.keys(fields).length || Object.values(fields).some((value) => typeof value !== "string") ||
        !providers.verifyPaynowCallback(fields)) {
      throw new HttpError(400, "Paynow callback signature is invalid.");
    }
    const reference = fields.reference;
    const callbackAmount = parseGatewayAmount(fields.amount);
    if (!reference || callbackAmount === null || !fields.pollurl || !fields.status) {
      throw new HttpError(400, "Paynow callback is incomplete.");
    }
    const payment = await db.prepare("SELECT * FROM payments WHERE provider = 'paynow' AND provider_reference = ?")
      .get(reference);
    if (!payment) throw new HttpError(404, "Payment not found.");
    if (payment.amount_cents !== callbackAmount) throw new HttpError(400, "Paynow payment amount does not match the order.");
    if (payment.poll_url !== fields.pollurl) throw new HttpError(400, "Paynow status URL does not match the payment.");
    const confirmed = await providers.pollPaynowTransaction(fields.pollurl);
    if (confirmed.reference !== reference || parseGatewayAmount(confirmed.amount) !== payment.amount_cents) {
      throw new HttpError(400, "Paynow status does not match the payment.");
    }

    await db.transaction(async () => {
      const current = await db.prepare(`SELECT * FROM payments WHERE id = ? ${db.isPostgres ? "FOR UPDATE" : ""}`).get(payment.id);
      if (!current || current.status === "refunded") return;
      const now = new Date().toISOString();
      const gatewayStatus = String(confirmed.status).trim().toLowerCase();
      if (current.status === "paid" && gatewayStatus !== "refunded") return;
      if (successfulPaynowStatus(gatewayStatus)) {
        await db.prepare("UPDATE payments SET status = 'paid', updated_at = ? WHERE id = ?")
          .run(now, current.id);
        if (current.order_id) {
          const order = await db.prepare("SELECT status FROM orders WHERE id = ?").get(current.order_id);
          if (order && order.status === "pending_payment") {
            await db.prepare("UPDATE orders SET status = 'paid', updated_at = ? WHERE id = ?")
              .run(now, current.order_id);
            await addOrderEvent(db, current.order_id, null, "paid", "Paynow payment verified.");
            await addOrderNotification(db, current.user_id, "Payment received", "Your order payment was verified.");
          }
        }
      } else if (gatewayStatus === "refunded") {
        await db.prepare("UPDATE payments SET status = 'refunded', updated_at = ? WHERE id = ?").run(now, current.id);
        if (current.order_id) {
          await db.prepare("UPDATE orders SET status = 'refunded', updated_at = ? WHERE id = ?").run(now, current.order_id);
          await addOrderEvent(db, current.order_id, null, "refunded", "Paynow reported a refund.");
        }
      } else if (["cancelled", "failed", "disputed"].includes(gatewayStatus)) {
        const paymentStatus = gatewayStatus === "disputed" ? "failed" : gatewayStatus;
        await db.prepare("UPDATE payments SET status = ?, updated_at = ? WHERE id = ?")
          .run(paymentStatus, now, current.id);
        if (current.order_id) await releaseOrderStock(db, current.id, paymentStatus);
      }
    })();
    res.status(200).type("text").send("OK");
  });
}

async function orderDetails(db, orderId, lock = false) {
  const order = await db.prepare(`
    SELECT o.id, o.user_id AS userId, o.payment_id AS paymentId, o.status,
      o.total_cents AS totalCents, o.currency, o.created_at AS createdAt
    FROM orders o WHERE o.id = ? ${lock && db.isPostgres ? "FOR UPDATE" : ""}
  `).get(orderId);
  if (!order) return null;
  const items = await db.prepare(`
    SELECT id, product_id AS productId, seller_id AS sellerId, product_name AS name,
      quantity, unit_price_cents AS unitPriceCents
    FROM order_items WHERE order_id = ? ORDER BY id
  `).all(orderId);
  return { ...order, total: order.totalCents / 100,
    items: items.map((item) => ({ ...item, unitPrice: item.unitPriceCents / 100 })) };
}

function canViewOrder(order, user) {
  return order.userId === user.id || user.role === "admin" ||
    (["business", "supplier"].includes(user.role) && order.items.some((item) => item.sellerId === user.id));
}

async function releaseOrderStock(db, paymentId, paymentStatus) {
  const payment = await db.prepare("SELECT id, order_id AS orderId FROM payments WHERE id = ?").get(paymentId);
  if (!payment || !payment.orderId) return;
  const order = await db.prepare(`SELECT status, stock_released_at AS stockReleasedAt FROM orders WHERE id = ? ${db.isPostgres ? "FOR UPDATE" : ""}`)
    .get(payment.orderId);
  if (!order || order.stockReleasedAt) return;
  const items = await db.prepare("SELECT product_id AS productId, quantity FROM order_items WHERE order_id = ?")
    .all(payment.orderId);
  for (const item of items) {
    await db.prepare("UPDATE products SET stock = stock + ? WHERE id = ?").run(item.quantity, item.productId);
  }
  const now = new Date().toISOString();
  await db.prepare("UPDATE orders SET status = 'cancelled', stock_released_at = ?, updated_at = ? WHERE id = ? AND stock_released_at IS NULL")
    .run(now, now, payment.orderId);
  await addOrderEvent(db, payment.orderId, null, "cancelled", `Payment ${paymentStatus}. Reserved stock released.`);
}

async function addOrderEvent(db, orderId, actorId, status, note) {
  await db.prepare(`
    INSERT INTO order_events (id, order_id, actor_id, status, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), orderId, actorId, status, note, new Date().toISOString());
}

async function recordAudit(db, actorId, orderId, details) {
  await db.prepare(`
    INSERT INTO admin_audit_log (id, actor_id, action, target_type, target_id, details, created_at)
    VALUES (?, ?, 'order.status', 'order', ?, ?, ?)
  `).run(crypto.randomUUID(), actorId, orderId, JSON.stringify(details), new Date().toISOString());
}

async function addOrderNotification(db, userId, subject, body) {
  await db.prepare(`
    INSERT INTO notifications (id, user_id, channel, subject, body, status, created_at)
    VALUES (?, ?, 'in_app', ?, ?, 'sent', ?)
  `).run(crypto.randomUUID(), userId, subject, body, new Date().toISOString());
}

module.exports = { registerCommerceRoutes, amountInCents, parseGatewayAmount, successfulPaynowStatus };

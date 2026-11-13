import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import Razorpay from "razorpay";
import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const app = express();
const port = process.env.PORT || 3000;
const appDir = path.dirname(fileURLToPath(import.meta.url));
const contentDir = path.join(appDir, "course-content");
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const hasSupabaseConfig = Boolean(process.env.SUPABASE_URL && supabaseKey);
const hasRazorpayCredentials = Boolean(
  process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET,
);

const required = ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"];
for (const name of required) {
  if (!process.env[name]) {
    console.warn(`Missing ${name}. Add it to .env before starting the server.`);
  }
}

const razorpay = hasRazorpayCredentials
  ? new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    })
  : null;
const supabase = hasSupabaseConfig
  ? createClient(process.env.SUPABASE_URL, supabaseKey, { auth: { persistSession: false } })
  : null;

app.use(cors({ origin: process.env.FRONTEND_ORIGIN || "*" }));
app.use(express.json());
app.get("/", (_req, res) => res.sendFile(path.join(appDir, "index.html")));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    razorpayConfigured: hasRazorpayCredentials,
    supabaseConfigured: hasSupabaseConfig,
    priceInr: Number(process.env.COURSE_PRICE_INR || 129),
  });
});

app.get("/api/razorpay-connection", async (_req, res) => {
  if (!hasRazorpayCredentials || !razorpay) {
    return res.status(503).json({ connected: false, error: "Razorpay credentials are missing on the server." });
  }

  try {
    await razorpay.orders.all({ count: 1 });
    res.json({ connected: true, mode: process.env.RAZORPAY_KEY_ID.startsWith("rzp_test_") ? "test" : "live" });
  } catch (error) {
    console.error("Razorpay connection check failed:", error);
    res.status(502).json({ connected: false, error: "Razorpay rejected the configured credentials." });
  }
});

app.get("/api/supabase-connection", async (_req, res) => {
  if (!hasSupabaseConfig || !supabase) {
    return res.status(503).json({ connected: false, error: "Supabase settings are missing on the server." });
  }

  const { error } = await supabase.from("course_purchases").select("id").limit(1);
  if (error) {
    console.error("Supabase connection check failed:", error);
    return res.status(502).json({ connected: false, error: "Supabase is configured, but the course_purchases table is not ready." });
  }
  res.json({ connected: true });
});

function getAccessToken(req) {
  const cookie = (req.get("cookie") || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("course_access="));
  return cookie ? cookie.slice("course_access=".length) : "";
}

async function isGitLfsPointer(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(256);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8")
      .startsWith("version https://git-lfs.github.com/spec/v1\n");
  } finally {
    await handle.close();
  }
}

async function hasPaidPurchase(token) {
  const accessTokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const { data, error } = await supabase
    .from("course_purchases")
    .select("status, access_expires_at")
    .eq("access_token_hash", accessTokenHash)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const expiresAt = Date.parse(data?.access_expires_at || "");
  return data?.status === "paid" && Number.isFinite(expiresAt) && expiresAt > Date.now();
}

async function requirePaidAccess(req, res) {
  const token = getAccessToken(req);
  if (!token) {
    res.status(401).json({ error: "Course access is not authorized." });
    return false;
  }
  if (!supabase) {
    res.status(503).json({ error: "Course access verification is unavailable." });
    return false;
  }

  try {
    if (await hasPaidPurchase(token)) {
      return true;
    }
  } catch (error) {
    console.error("Supabase course access check failed:", error);
    res.status(503).json({ error: "Unable to verify course access right now." });
    return false;
  }

  res.status(403).json({ error: "A paid course purchase could not be confirmed." });
  return false;
}

app.get("/success", async (req, res) => {
  const token = getAccessToken(req);
  if (!token) {
    return res.redirect(303, "/");
  }
  if (!supabase) {
    return res.status(503).send("Course access verification is unavailable.");
  }

  try {
    if (!(await hasPaidPurchase(token))) {
      return res.status(403).send("A paid course purchase could not be confirmed.");
    }
  } catch (error) {
    console.error("Supabase success-page check failed:", error);
    return res.status(503).send("Unable to verify your course access right now.");
  }

  res.set({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
  });
  res.sendFile(path.join(appDir, "success.html"), { cacheControl: false });
});

app.get("/api/course-content", async (req, res) => {
  if (!(await requirePaidAccess(req, res))) return;

  try {
    const entries = (await fs.readdir(contentDir, { withFileTypes: true }))
      .filter((entry) => (
        entry.isFile()
        && !entry.name.startsWith(".")
        && [".pdf", ".mp4"].includes(path.extname(entry.name).toLowerCase())
      ));
    const files = (await Promise.all(entries.map(async (entry) => {
      const extension = path.extname(entry.name).toLowerCase();
      const filePath = path.join(contentDir, entry.name);
      if (await isGitLfsPointer(filePath)) {
        console.warn(`Skipping ${entry.name}: Git LFS pointer present instead of file contents.`);
        return null;
      }
      return {
        name: entry.name,
        type: extension === ".pdf" ? "pdf" : "video",
        url: extension === ".pdf"
          ? `/api/course-content/${encodeURIComponent(entry.name)}`
          : `/api/course-video/${encodeURIComponent(entry.name)}`,
      };
    }))).filter(Boolean);
    res.set("Cache-Control", "private, no-store");
    res.json({ files });
  } catch (error) {
    console.error("Course content listing failed:", error);
    res.status(500).json({ error: "Course files are not available yet." });
  }
});

app.get("/api/course-content/:filename", async (req, res) => {
  if (!(await requirePaidAccess(req, res))) return;

  const filename = path.basename(req.params.filename);
  if (filename !== req.params.filename || path.extname(filename).toLowerCase() !== ".pdf") {
    return res.status(404).send("Course file not found.");
  }

  const filePath = path.join(contentDir, filename);
  try {
    const file = await fs.stat(filePath);
    if (!file.isFile() || await isGitLfsPointer(filePath)) {
      return res.status(404).send("Course PDF contents are not available in this deployment.");
    }

    res.set("Cache-Control", "private, no-store");
    res.download(filePath, filename, { cacheControl: false }, (error) => {
      if (error) {
        console.error("Course PDF download failed:", error);
        if (!res.headersSent) {
          res.status(error.statusCode || 500).send("Unable to download the course file.");
        }
      }
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      return res.status(404).send("Course file not found.");
    }
    console.error("Course PDF lookup failed:", error);
    res.status(500).send("Unable to access the course file.");
  }
});

app.get("/api/course-video/:filename", async (req, res) => {
  if (!(await requirePaidAccess(req, res))) return;

  const filename = path.basename(req.params.filename);
  if (filename !== req.params.filename || path.extname(filename).toLowerCase() !== ".mp4") {
    return res.status(404).send("Course video not found.");
  }

  const filePath = path.join(contentDir, filename);
  try {
    const file = await fs.stat(filePath);
    if (!file.isFile() || await isGitLfsPointer(filePath)) {
      return res.status(404).send("Course video contents are not available in this deployment.");
    }

    res.set({
      "Cache-Control": "private, no-store",
      "Content-Disposition": "inline",
      "Content-Type": "video/mp4",
    });
    res.sendFile(filePath, { acceptRanges: true, cacheControl: false }, (error) => {
      if (error) {
        console.error("Course video streaming failed:", error);
        if (!res.headersSent) {
          res.status(error.statusCode || 500).send("Unable to stream the course video.");
        }
      }
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      return res.status(404).send("Course video not found.");
    }
    console.error("Course video lookup failed:", error);
    res.status(500).send("Unable to access the course video.");
  }
});

app.post("/api/create-order", async (req, res) => {
  if (!hasRazorpayCredentials) {
    return res.status(503).json({ error: "Razorpay is not configured on the server." });
  }
  if (!supabase) {
    return res.status(503).json({ error: "Supabase is required to grant course access." });
  }

  try {
    const amountInr = Number(process.env.COURSE_PRICE_INR || 129);
    if (!Number.isFinite(amountInr) || amountInr <= 0) {
      return res.status(500).json({ error: "Course price is not configured." });
    }

    const order = await razorpay.orders.create({
      amount: Math.round(amountInr * 100),
      currency: "INR",
      receipt: `course_${Date.now()}`.slice(0, 40),
      notes: { product: "Human Nature Stories Studio course" },
    });

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      name: process.env.BUSINESS_NAME || "Human Nature Stories Studio",
      description: process.env.COURSE_NAME || "Human Nature Stories Studio course",
    });
  } catch (error) {
    console.error("Razorpay order creation failed:", error);
    res.status(500).json({ error: "Unable to start checkout right now." });
  }
});

app.post("/api/verify-payment", async (req, res) => {
  if (!hasRazorpayCredentials) {
    return res.status(503).json({ verified: false, error: "Razorpay is not configured on the server." });
  }
  if (!supabase) {
    return res.status(503).json({ verified: false, error: "Supabase is required to grant course access." });
  }

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ verified: false, error: "Incomplete payment response." });
  }

  const payload = `${razorpay_order_id}|${razorpay_payment_id}`;
  const expectedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(payload)
    .digest("hex");

  if (expectedSignature.length !== razorpay_signature.length) {
    return res.status(400).json({ verified: false, error: "Payment verification failed." });
  }

  const verified = crypto.timingSafeEqual(
    Buffer.from(expectedSignature),
    Buffer.from(razorpay_signature),
  );

  if (!verified) {
    return res.status(400).json({ verified: false, error: "Payment verification failed." });
  }

  const accessToken = crypto.randomUUID();
  const accessExpiresAt = Date.now() + 24 * 60 * 60 * 1000;

  const accessTokenHash = crypto.createHash("sha256").update(accessToken).digest("hex");
  try {
    const { error } = await supabase.from("course_purchases").upsert({
      razorpay_order_id,
      razorpay_payment_id,
      access_token_hash: accessTokenHash,
      access_expires_at: new Date(accessExpiresAt).toISOString(),
      status: "paid",
    }, { onConflict: "razorpay_payment_id" });
    if (error) {
      throw error;
    }
  } catch (error) {
    console.error("Supabase payment save failed:", error);
    return res.status(503).json({
      verified: true,
      error: "Payment was verified, but course access could not be saved. Please contact support.",
    });
  }

  const secureCookie = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `course_access=${accessToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${secureCookie}`,
  );
  res.set("Cache-Control", "no-store");
  res.json({ verified: true, paymentId: razorpay_payment_id, supabaseSaved: true });
});

app.listen(port, () => {
  console.log(`Human Nature Stories Studio is running at http://localhost:${port}`);
});

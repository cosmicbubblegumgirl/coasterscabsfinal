const express = require("express");
const cors = require("cors");
const fs = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");

const app = express();
const PORT = Number(process.env.PORT) || 8787;
const DATA_DIR = path.join(__dirname, "data");
const BOOKINGS_FILE = path.join(DATA_DIR, "bookings.json");
const WEBHOOK_LOG_FILE = path.join(DATA_DIR, "webhook-attempts.log");
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 6;
const WEBHOOK_RETRIES = Math.max(0, Number(process.env.BOOKING_WEBHOOK_RETRIES) || 2);
const WEBHOOK_TIMEOUT_MS = Math.max(1000, Number(process.env.BOOKING_WEBHOOK_TIMEOUT_MS) || 5000);
const bookingRateMap = new Map();

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function appendWebhookLog(entry) {
  const line = `${JSON.stringify(entry)}\n`;
  await fs.appendFile(WEBHOOK_LOG_FILE, line, "utf8");
}

function normalizePhone(input) {
  return String(input || "").replace(/\s+/g, "").trim();
}

function isValidLocalDateTime(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(value);
  return !Number.isNaN(date.getTime());
}

function validateBookingInput(payload) {
  const errors = [];
  if (!payload.name || payload.name.length < 2 || payload.name.length > 80) {
    errors.push("Name must be between 2 and 80 characters");
  }

  if (!/^\+?[0-9]{9,15}$/.test(payload.phone)) {
    errors.push("Phone number must contain 9 to 15 digits");
  }

  if (!payload.pickup || payload.pickup.length < 3 || payload.pickup.length > 180) {
    errors.push("Pickup must be between 3 and 180 characters");
  }

  if (!payload.dropoff || payload.dropoff.length < 3 || payload.dropoff.length > 180) {
    errors.push("Drop off must be between 3 and 180 characters");
  }

  if (!isValidLocalDateTime(payload.datetime)) {
    errors.push("Preferred date/time is invalid");
  }

  if (!Number.isInteger(payload.passengers) || payload.passengers < 1 || payload.passengers > 7) {
    errors.push("Passengers must be between 1 and 7");
  }

  if (payload.notes.length > 600) {
    errors.push("Notes cannot exceed 600 characters");
  }

  return errors;
}

function bookingRateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || "unknown";
  const events = bookingRateMap.get(key) || [];
  const recent = events.filter((time) => now - time < RATE_LIMIT_WINDOW_MS);

  if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterSec = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - recent[0])) / 1000);
    res.set("Retry-After", String(retryAfterSec));
    return res.status(429).json({ error: "Too many booking requests. Please try again later." });
  }

  recent.push(now);
  bookingRateMap.set(key, recent);
  return next();
}

async function ensureStorage() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(BOOKINGS_FILE);
  } catch {
    await fs.writeFile(BOOKINGS_FILE, "[]\n", "utf8");
  }

  try {
    await fs.access(WEBHOOK_LOG_FILE);
  } catch {
    await fs.writeFile(WEBHOOK_LOG_FILE, "", "utf8");
  }
}

async function readBookings() {
  const raw = await fs.readFile(BOOKINGS_FILE, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Bookings file is invalid");
  }

  return parsed;
}

async function saveBooking(booking) {
  const existing = await readBookings();
  existing.push(booking);
  await fs.writeFile(BOOKINGS_FILE, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
}

async function sendBookingWebhook(booking) {
  const webhookUrl = String(process.env.BOOKING_WEBHOOK_URL || "").trim();
  if (!webhookUrl) {
    return { sent: false, reason: "BOOKING_WEBHOOK_URL is not set" };
  }

  let lastError = "Webhook delivery failed";
  for (let attempt = 1; attempt <= WEBHOOK_RETRIES + 1; attempt += 1) {
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          event: "booking.created",
          booking
        }),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS)
      });

      if (!response.ok) {
        throw new Error(`Webhook failed with status ${response.status}`);
      }

      await appendWebhookLog({
        timestamp: new Date().toISOString(),
        bookingId: booking.id,
        attempt,
        success: true
      });

      return { sent: true, attempts: attempt };
    } catch (error) {
      lastError = error.message;
      await appendWebhookLog({
        timestamp: new Date().toISOString(),
        bookingId: booking.id,
        attempt,
        success: false,
        error: lastError
      });

      if (attempt <= WEBHOOK_RETRIES) {
        await wait(350 * attempt);
      }
    }
  }

  return {
    sent: false,
    reason: lastError,
    attempts: WEBHOOK_RETRIES + 1
  };
}

app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(express.static(__dirname));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/geocode", async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (!query) {
    return res.status(400).json({ error: "Missing q query parameter" });
  }

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("countrycodes", "za");
  url.searchParams.set("q", `${query}, KwaZulu-Natal, South Africa`);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "coasters-cabs-local-dev/1.0"
      }
    });

    if (!response.ok) {
      return res.status(502).json({ error: "Geocode provider unavailable" });
    }

    const payload = await response.json();
    const place = payload[0];
    if (!place) {
      return res.status(404).json({ error: "Address not found" });
    }

    return res.json({
      lat: Number(place.lat),
      lng: Number(place.lon),
      displayName: place.display_name
    });
  } catch (error) {
    return res.status(500).json({ error: "Failed to geocode address" });
  }
});

app.get("/api/route", async (req, res) => {
  const pickupLat = Number(req.query.pickupLat);
  const pickupLng = Number(req.query.pickupLng);
  const dropoffLat = Number(req.query.dropoffLat);
  const dropoffLng = Number(req.query.dropoffLng);

  if ([pickupLat, pickupLng, dropoffLat, dropoffLng].some((v) => Number.isNaN(v))) {
    return res.status(400).json({ error: "Invalid coordinates" });
  }

  const routeUrl = new URL(`https://router.project-osrm.org/route/v1/driving/${pickupLng},${pickupLat};${dropoffLng},${dropoffLat}`);
  routeUrl.searchParams.set("overview", "full");
  routeUrl.searchParams.set("geometries", "geojson");

  try {
    const response = await fetch(routeUrl);
    if (!response.ok) {
      return res.status(502).json({ error: "Route provider unavailable" });
    }

    const payload = await response.json();
    const route = payload.routes && payload.routes[0];
    if (!route) {
      return res.status(404).json({ error: "No route found" });
    }

    return res.json({
      distanceMeters: route.distance,
      durationSeconds: route.duration,
      geometry: route.geometry
    });
  } catch (error) {
    return res.status(500).json({ error: "Failed to calculate route" });
  }
});

app.post("/api/bookings", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const phone = normalizePhone(req.body?.phone);
  const pickup = String(req.body?.pickup || "").trim();
  const dropoff = String(req.body?.dropoff || "").trim();
  const datetime = String(req.body?.datetime || "").trim();
  const notes = String(req.body?.notes || "").trim();
  const passengers = Number(req.body?.passengers);

  const errors = validateBookingInput({
    name,
    phone,
    pickup,
    dropoff,
    datetime,
    passengers,
    notes
  });
  if (errors.length > 0) {
    return res.status(400).json({ error: "Validation failed", details: errors });
  }

  const booking = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    status: "new",
    name,
    phone,
    pickup,
    dropoff,
    datetime,
    passengers,
    notes,
    rideType: String(req.body?.rideType || "").trim(),
    estimate: {
      distanceKm: Number(req.body?.distanceKm) || null,
      durationMinutes: Number(req.body?.durationMinutes) || null,
      fareText: String(req.body?.fareText || "").trim()
    }
  };

  try {
    await saveBooking(booking);
  } catch (error) {
    return res.status(500).json({ error: "Could not save booking" });
  }

  const webhookResult = await sendBookingWebhook(booking);
  return res.status(201).json({
    ok: true,
    bookingId: booking.id,
    webhook: webhookResult
  });
});

app.get("/api/bookings", async (req, res) => {
  const statusFilter = String(req.query.status || "").trim().toLowerCase();
  const search = String(req.query.search || "").trim().toLowerCase();
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

  try {
    const bookings = await readBookings();
    const filtered = bookings
      .filter((booking) => (statusFilter ? String(booking.status || "").toLowerCase() === statusFilter : true))
      .filter((booking) => {
        if (!search) {
          return true;
        }

        const haystack = [
          booking.name,
          booking.phone,
          booking.pickup,
          booking.dropoff,
          booking.datetime,
          booking.id
        ].join(" ").toLowerCase();
        return haystack.includes(search);
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);

    return res.json({
      total: filtered.length,
      bookings: filtered
    });
  } catch (error) {
    return res.status(500).json({ error: "Could not load bookings" });
  }
});

ensureStorage().then(() => {
  app.listen(PORT, () => {
    console.log(`Coaster's Cabs backend API running on http://localhost:${PORT}`);
  });
}).catch((error) => {
  console.error("Failed to initialize booking storage", error);
  process.exit(1);
});

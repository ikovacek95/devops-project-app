const express = require("express");
const { Pool } = require("pg");
const { createClient } = require("redis");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");

    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }

    next();
});
app.use((req, _res, next) => {
    if (req.url.startsWith("/api/")) {
        req.url = req.url.replace("/api", "");
    } else if (req.url === "/api") {
        req.url = "/";
    }
    next();
});

const port = Number(process.env.API_PORT || 8080);

// Krajnji rok za uredno gasenje; nakon njega izlazimo s kodom 1 umjesto
// da cekamo SIGKILL od runtimea.
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS || 10000);

// Koliko cekamo IZMEDU proglasenja "not ready" i zatvaranja servera.
// U Kubernetesu uklanjanje poda iz Endpointa nije trenutacno - kube-proxy i
// Ingress trebaju koji trenutak da prestanu slati promet. Bez te odgode klijent
// moze dobiti 502 tijekom rolling updatea. Lokalno (compose) nema load balancera
// pa je zadana vrijednost 0, a u k8s ConfigMapu se postavlja na 5000 ms.
const SHUTDOWN_DRAIN_MS = Number(process.env.SHUTDOWN_DRAIN_MS || 0);

// Cim krene gasenje, /readyz vraca 503. U Kubernetesu to uklanja pod iz
// Endpointa Servicea prije nego prestane primati konekcije, pa se tijekom
// rolling updatea promet preusmjeri na zdrave replike bez ijednog 502/504.
let shuttingDown = false;

const events = [
    { id: "evt-1001", name: "DevSecOps Bootcamp", location: "Zagreb", availableTickets: 150 },
    { id: "evt-1002", name: "Cloud Native Day", location: "Split", availableTickets: 200 },
    { id: "evt-1003", name: "Security Engineering Meetup", location: "Rijeka", availableTickets: 90 }
];

const pgPool = new Pool({
    host: process.env.POSTGRES_HOST || "postgres",
    port: Number(process.env.POSTGRES_PORT || 5432),
    database: process.env.POSTGRES_DB || "ticketing",
    user: process.env.POSTGRES_USER || "ticketing_user",
    password: process.env.POSTGRES_PASSWORD || "change_me_local"
});

const redisClient = createClient({
    socket: {
        host: process.env.REDIS_HOST || "redis",
        port: Number(process.env.REDIS_PORT || 6379)
    }
});

const queueName = process.env.QUEUE_NAME || "ticket_orders";

async function connectRedis() {
    redisClient.on("error", (error) => {
        console.error("Redis error:", error.message);
    });

    if (!redisClient.isOpen) {
        await redisClient.connect();
    }
}

app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok", service: "api" });
});

app.get("/readyz", async (_req, res) => {
    // Tijekom gasenja se namjerno proglasavamo "not ready" kako bi nas
    // Service/load balancer prestao slati promet jos dok uredno zavrsavamo.
    if (shuttingDown) {
        return res.status(503).json({ status: "shutting-down" });
    }

    try {
        await pgPool.query("SELECT 1");
        await redisClient.ping();
        return res.status(200).json({ status: "ready" });
    } catch (error) {
        return res.status(503).json({ status: "not-ready", error: error.message });
    }
});

app.get("/events", (_req, res) => {
    res.status(200).json(events);
});

app.post("/tickets/purchase", async (req, res) => {
    const { eventId, customerEmail, quantity } = req.body;

    if (!eventId || !customerEmail || !quantity) {
        return res.status(400).json({ error: "eventId, customerEmail and quantity are required" });
    }

    const selectedEvent = events.find((event) => event.id === eventId);
    if (!selectedEvent) {
        return res.status(404).json({ error: "Event not found" });
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
        return res.status(400).json({ error: "quantity must be a positive integer" });
    }

    const order = {
        orderId: uuidv4(),
        eventId,
        customerEmail,
        quantity,
        status: "queued",
        createdAt: new Date().toISOString()
    };

    try {
        await redisClient.lPush(queueName, JSON.stringify(order));
        return res.status(202).json({ message: "Order queued", orderId: order.orderId });
    } catch (error) {
        return res.status(500).json({ error: "Unable to enqueue order", details: error.message });
    }
});

app.get("/tickets/orders", async (_req, res) => {
    try {
        const result = await pgPool.query(
            "SELECT order_id, event_id, customer_email, quantity, status, created_at FROM ticket_orders ORDER BY created_at DESC LIMIT 50"
        );
        return res.status(200).json(result.rows);
    } catch (error) {
        return res.status(500).json({ error: "Unable to read orders", details: error.message });
    }
});

let server = null;

connectRedis()
    .then(() => {
        // Referencu na server cuvamo kako bismo pri gasenju mogli pozvati
        // server.close() i pustiti da se zapoceti zahtjevi dovrse.
        server = app.listen(port, () => {
            console.log(`API listening on port ${port}`);
        });
    })
    .catch((error) => {
        console.error("Failed to start API:", error);
        process.exit(1);
    });

async function shutdown(signal) {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    console.log(`Primljen ${signal} - zapocinjem uredno gasenje API-ja...`);

    // Sigurnosni ventil ako se neki zahtjev ili veza zaglavi.
    const forceExit = setTimeout(() => {
        console.error("Uredno gasenje predugo traje - prisilni izlaz.");
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
        // 1) Pusti da load balancer primijeti da vise nismo ready (vidi
        //    SHUTDOWN_DRAIN_MS). Zahtjevi se za to vrijeme normalno posluzuju.
        if (SHUTDOWN_DRAIN_MS > 0) {
            console.log(`Drain faza: ${SHUTDOWN_DRAIN_MS} ms prije zatvaranja servera...`);
            await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_MS));
        }

        if (server) {
            // 2) Prestani primati NOVE konekcije i pricekaj da se zavrse zahtjevi
            //    koji su u tijeku. Node 19+ pritom sam zatvara neaktivne
            //    keep-alive konekcije, pa close() ne visi do keepAliveTimeouta.
            await new Promise((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            });
        }
        console.log("HTTP server zatvoren, zatvaram veze prema bazi i Redisu...");

        if (redisClient.isOpen) {
            await redisClient.quit();
        }
        await pgPool.end();

        clearTimeout(forceExit);
        console.log("API uredno zaustavljen.");
        process.exit(0);
    } catch (error) {
        console.error("Greska pri gasenju:", error.message);
        process.exit(1);
    }
}

for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
        shutdown(signal);
    });
}

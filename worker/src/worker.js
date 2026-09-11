const { Pool } = require("pg");
const { createClient } = require("redis");
require("dotenv").config();

const queueName = process.env.QUEUE_NAME || "ticket_orders";

// Koliko sekundi BRPOP blokira prije nego vrati null.
//
// KLJUCNO ZA GRACEFUL SHUTDOWN: ranije je ovdje bila vrijednost 0, sto u Redisu
// znaci "blokiraj zauvijek". Posljedica je bila da se `redisClient.quit()` u
// SIGTERM handleru nikad nije dovrsio (quit ceka da zavrse komande u tijeku),
// pa je runtime nakon 10 s posezao za SIGKILL-om.
//
// S konacnim timeoutom petlja se budi svake sekunde i moze provjeriti zastavicu
// `shuttingDown`. Kad BRPOP istekne, Redis GARANTIRANO nije uklonio nijedan
// element iz liste, pa se tim putem ne moze izgubiti nijedna narudzba.
const BRPOP_TIMEOUT_SECONDS = 1;

// Krajnji rok za uredno gasenje. Ako se zaglavi, izlazimo s kodom 1 kako
// kontejner ne bi visio do SIGKILL-a.
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS || 10000);

// Zastavica koja zaustavlja dohvacanje NOVIH poruka iz queuea.
let shuttingDown = false;

// Promise glavne petlje - shutdown ga ceka kako bi poruka koja je trenutno
// u obradi bila dovrsena (upisana u PostgreSQL) prije izlaska iz procesa.
let workerLoopPromise = null;

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

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processOrder(rawPayload) {
    const order = JSON.parse(rawPayload);
    await pgPool.query(
        `INSERT INTO ticket_orders (order_id, event_id, customer_email, quantity, status)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (order_id) DO NOTHING`,
        [order.orderId, order.eventId, order.customerEmail, order.quantity, "processed"]
    );
}

async function workerLoop() {
    while (!shuttingDown) {
        try {
            const result = await redisClient.brPop(queueName, BRPOP_TIMEOUT_SECONDS);

            // null = BRPOP je istekao bez poruke. Nista nije uzeto iz queuea,
            // pa je ovo sigurna tocka za provjeru zastavice i izlazak iz petlje.
            if (!result?.element) {
                continue;
            }

            // Od ovog trenutka poruka VISE NIJE u Redisu. Obrada se zato dovrsava
            // do kraja (await) prije nego petlja ponovno provjeri `shuttingDown`.
            // Zahvaljujuci tome SIGTERM ne moze prekinuti upis u bazu na pola.
            await processOrder(result.element);
            console.log("Order processed");
        } catch (error) {
            if (shuttingDown) {
                break;
            }
            console.error("Worker loop error:", error.message);
            await sleep(2000);
        }
    }
}

async function startWorker() {
    redisClient.on("error", (error) => {
        // Tijekom gasenja je prekid veze ocekivan - ne zatrpavamo log.
        if (shuttingDown) {
            return;
        }
        console.error("Redis error:", error.message);
    });

    await redisClient.connect();
    await pgPool.query("SELECT 1");

    console.log("Worker started and waiting for jobs...");

    workerLoopPromise = workerLoop();
    await workerLoopPromise;
}

async function shutdown(signal) {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    console.log(`Primljen ${signal} - zapocinjem uredno gasenje workera...`);

    // Sigurnosni ventil: ako se gasenje zaglavi, ne cekamo SIGKILL.
    const forceExit = setTimeout(() => {
        console.error("Uredno gasenje predugo traje - prisilni izlaz.");
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
        // Cekamo da petlja dovrsi poruku koja je eventualno u obradi.
        // Najdulje traje BRPOP_TIMEOUT_SECONDS + trajanje jednog INSERT-a.
        if (workerLoopPromise) {
            await workerLoopPromise;
        }
        console.log("Obrada zavrsena, zatvaram veze...");

        if (redisClient.isOpen) {
            await redisClient.quit();
        }
        await pgPool.end();

        clearTimeout(forceExit);
        console.log("Worker uredno zaustavljen.");
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

startWorker().catch((error) => {
    console.error("Worker fatal error:", error);
    process.exit(1);
});

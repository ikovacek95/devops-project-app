const express = require("express");
const path = require("path");
require("dotenv").config();

const app = express();
const port = Number(process.env.FRONTEND_PORT || 3000);

// Krajnji rok za uredno gasenje; nakon njega izlazimo s kodom 1 umjesto
// da cekamo SIGKILL od runtimea.
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS || 10000);

// Odgoda izmedu proglasenja "not ready" i zatvaranja servera, da load balancer
// stigne prestati slati promet (detaljnije obrazlozenje u api/src/server.js).
const SHUTDOWN_DRAIN_MS = Number(process.env.SHUTDOWN_DRAIN_MS || 0);

let shuttingDown = false;

app.use(express.static(path.join(__dirname, "public")));

app.get("/config", (_req, res) => {
    res.status(200).json({
        apiBaseUrl: process.env.API_BASE_URL || "http://localhost:8080"
    });
});

app.get("/healthz", (_req, res) => {
    // Tijekom gasenja vracamo 503 kako bi nas Kubernetes Service uklonio iz
    // Endpointa prije nego prestanemo primati konekcije. Frontend nema zaseban
    // /readyz, pa isti endpoint sluzi i kao readiness provjera.
    if (shuttingDown) {
        return res.status(503).json({ status: "shutting-down", service: "frontend" });
    }
    return res.status(200).json({ status: "ok", service: "frontend" });
});

// Referencu na server cuvamo kako bismo pri gasenju mogli pozvati server.close()
// i pustiti da se zapoceti zahtjevi dovrse.
const server = app.listen(port, () => {
    console.log(`Frontend listening on port ${port}`);
});

async function shutdown(signal) {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    console.log(`Primljen ${signal} - zapocinjem uredno gasenje frontenda...`);

    // Sigurnosni ventil ako se neka konekcija zaglavi.
    const forceExit = setTimeout(() => {
        console.error("Uredno gasenje predugo traje - prisilni izlaz.");
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
        // 1) Pusti da load balancer primijeti da vise nismo ready.
        if (SHUTDOWN_DRAIN_MS > 0) {
            console.log(`Drain faza: ${SHUTDOWN_DRAIN_MS} ms prije zatvaranja servera...`);
            await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_MS));
        }

        // 2) Prestani primati NOVE konekcije i pricekaj da se zavrse zahtjevi
        //    koji su u tijeku (npr. dohvat staticke datoteke). Node 19+ pritom
        //    sam zatvara neaktivne keep-alive konekcije preglednika, pa close()
        //    ne visi do isteka keepAliveTimeouta.
        await new Promise((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
        });

        clearTimeout(forceExit);
        console.log("Frontend uredno zaustavljen.");
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

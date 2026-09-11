# Lokalno okruženje (1. dio projekta) — Podman Compose na CentOS Stream 9

Ovaj dokument opisuje kako podići cijelu aplikaciju **Secure Event Ticketing Platform**
lokalno, u rootless Podmanu, te kako dokazati da sve radi.

---

## 1. Preduvjeti

### 1.1 Operativni sustav i paketi

Ciljna platforma je **CentOS Stream 9**. Instalacija potrebnih alata:

```bash
# Podman + pomoćni alati
sudo dnf install -y podman podman-plugins

# podman-compose (dolazi iz EPEL repozitorija)
sudo dnf install -y epel-release
sudo dnf install -y podman-compose

# Alternativa ako paket nije dostupan (instalacija u korisnički prostor):
#   python3 -m pip install --user podman-compose
```

Provjera verzija (potreban je `podman-compose` **1.0.6 ili noviji** zbog podrške za
`depends_on: condition: service_healthy`):

```bash
podman --version
podman-compose --version
```

### 1.2 Rootless Podman

Sve se pokreće **bez roota**. Provjera da je rootless način ispravno postavljen:

```bash
podman info --format '{{.Host.Security.Rootless}}'   # očekuje se: true
id -u                                                # ne smije biti 0

# Da kontejneri nastave raditi i nakon odjave korisnika:
sudo loginctl enable-linger "$USER"
```

Ako `podman info` javlja grešku oko `subuid`/`subgid`:

```bash
grep "$USER" /etc/subuid /etc/subgid
# Ako nema zapisa:
sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 "$USER"
podman system migrate
```

### 1.3 Firewalld — otvaranje portova 3000 i 8080

```bash
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --permanent --add-port=8080/tcp
sudo firewall-cmd --reload

# Provjera:
sudo firewall-cmd --list-ports
```

> Baza (5432) i Redis (6379) **namjerno nisu** izloženi na host — dostupni su
> isključivo unutar Compose mreže `ticketing_net`.

### 1.4 SELinux — obavezna `:Z` oznaka

CentOS Stream 9 po defaultu ima SELinux u `enforcing` modu:

```bash
getenforce   # Enforcing
```

Svaki **bind-mount s hosta** u `compose.yaml` / `compose.dev.yaml` mora imati sufiks
`:Z` (privatni relabel za jedan kontejner) ili `:z` (dijeljeni relabel):

```yaml
- ./infra/postgres/init.sql:/docker-entrypoint-initdb.d/init.sql:ro,Z
- ./api/src:/app/src:Z
```

Bez te oznake kontejner ne može čitati montiranu datoteku i javlja
`Permission denied` (vidi scenarij 7 u [`runbook.md`](./runbook.md)).

> **Ne isključivati SELinux** (`setenforce 0`) kao "rješenje" — to je uklanjanje
> sigurnosne kontrole, a ne popravak.

---

## 2. Priprema konfiguracije

```bash
git clone https://github.com/ikovacek95/devops-project-app.git
cd devops-project-app

# .env se NE commita (nalazi se u .gitignore)
cp .env.example .env

# Postaviti vlastitu, jaku lozinku umjesto placeholdera change_me_local:
sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=')/" .env

grep POSTGRES_PASSWORD .env
```

---

## 3. Pokretanje (produkcijski profil)

```bash
# Build svih slika + pokretanje 5 servisa
podman-compose up -d --build

# Status
podman-compose ps
podman ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

Očekivano stanje: `ticketing-postgres`, `ticketing-redis`, `ticketing-api`,
`ticketing-worker` i `ticketing-frontend` u statusu `Up ... (healthy)`.

Redoslijed podizanja kontrolira `depends_on` s `condition: service_healthy`:

```
postgres (healthy) ─┐
                    ├─> api (healthy) ─> frontend
redis   (healthy) ─┬┘
                   └─> worker
```

Praćenje logova:

```bash
podman-compose logs -f api
podman-compose logs -f worker
```

---

## 4. Razvojni profil (hot-reload)

```bash
podman-compose -f compose.yaml -f compose.dev.yaml up -d --build
```

Razlike u odnosu na produkcijski profil:

| Element        | `compose.yaml`        | `+ compose.dev.yaml`             |
|----------------|-----------------------|----------------------------------|
| Build stage    | `runtime`             | `dev` (uključuje `nodemon`)      |
| `NODE_ENV`     | `production`          | `development`                    |
| Izvorni kod    | kopiran u sliku       | bind-mount `./<servis>/src:Z`    |
| Pokretanje     | `node src/server.js`  | `npx nodemon --legacy-watch ...` |
| `read_only`    | `true`                | `false` (nodemon treba zapis)    |

Provjera hot-reloada:

```bash
# U jednom terminalu:
podman-compose -f compose.yaml -f compose.dev.yaml logs -f api

# U drugom terminalu promijeni npr. ispis u api/src/server.js i spremi -
# nodemon mora automatski restartati proces ("[nodemon] restarting due to changes...").
```

> `--legacy-watch` uključuje polling; standardni `inotify` često ne radi kroz
> bind-mount u rootless Podmanu.

---

## 5. Validacija — svi endpointi

### 5.1 API health i readiness

```bash
curl -s http://localhost:8080/healthz | jq .
# {"status":"ok","service":"api"}

curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/readyz
# 200

curl -s http://localhost:8080/readyz | jq .
# {"status":"ready"}   <- znači da su i PostgreSQL i Redis dostupni
```

### 5.2 Lista evenata

```bash
curl -s http://localhost:8080/events | jq .
# [{"id":"evt-1001","name":"DevSecOps Bootcamp", ...}, ...]
```

### 5.3 Kupnja karte (upis u Redis queue)

```bash
curl -s -X POST http://localhost:8080/tickets/purchase \
  -H "Content-Type: application/json" \
  -d '{"eventId":"evt-1001","customerEmail":"student@algebra.hr","quantity":2}' | jq .
# {"message":"Order queued","orderId":"<uuid>"}   (HTTP 202)
```

Negativni testovi (provjera validacije ulaza):

```bash
# Nedostaje polje -> 400
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8080/tickets/purchase \
  -H "Content-Type: application/json" -d '{"eventId":"evt-1001"}'
# 400

# Nepostojeći event -> 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8080/tickets/purchase \
  -H "Content-Type: application/json" \
  -d '{"eventId":"evt-9999","customerEmail":"a@b.hr","quantity":1}'
# 404
```

### 5.4 Obrađene narudžbe (worker -> PostgreSQL)

```bash
sleep 2
curl -s http://localhost:8080/tickets/orders | jq .
# [{"order_id":"<uuid>","event_id":"evt-1001","customer_email":"student@algebra.hr",
#   "quantity":2,"status":"processed","created_at":"..."}]
```

Ako je `status` = `processed`, dokazan je cijeli lanac:
`API -> Redis queue -> worker -> PostgreSQL -> API`.

Dodatna provjera izravno u bazi:

```bash
podman exec -it ticketing-postgres \
  psql -U ticketing_user -d ticketing -c 'SELECT order_id, status FROM ticket_orders;'
```

Provjera da je queue ispražnjen:

```bash
podman exec -it ticketing-redis redis-cli LLEN ticket_orders
# (integer) 0
```

### 5.5 Frontend

```bash
curl -s http://localhost:3000/healthz | jq .
# {"status":"ok","service":"frontend"}

curl -s http://localhost:3000/config | jq .
# {"apiBaseUrl":"http://localhost:8080"}
```

U pregledniku otvoriti `http://localhost:3000` — padajući izbornik mora biti popunjen
evenatima, a klik na **Purchase** mora vratiti `orderId`.

### 5.6 Provjera ojačanja kontejnera

```bash
# Aplikacijski kontejneri rade kao UID 10001, NE kao root:
podman exec ticketing-api id
# uid=10001(app) gid=10001(app)

podman exec ticketing-frontend id
podman exec ticketing-worker id

# Root filesystem je read-only:
podman exec ticketing-api sh -c 'touch /test 2>&1 || echo "OK: read-only rootfs"'

# Healthcheck iz Containerfilea:
podman inspect --format '{{.State.Health.Status}}' ticketing-api
# healthy
```

---

## 6. Dokaz perzistencije podataka

Cilj: pokazati da podaci **prežive uništavanje kontejnera** jer se nalaze u
imenovanom volumenu `ticketing_pgdata`.

```bash
# 1) Kreiraj narudžbu i zapamti ID
ORDER_ID=$(curl -s -X POST http://localhost:8080/tickets/purchase \
  -H "Content-Type: application/json" \
  -d '{"eventId":"evt-1002","customerEmail":"perzistencija@algebra.hr","quantity":3}' \
  | jq -r .orderId)
echo "Kreirana narudžba: $ORDER_ID"

# 2) Pričekaj obradu i potvrdi da je u bazi
sleep 3
curl -s http://localhost:8080/tickets/orders | jq --arg id "$ORDER_ID" '.[] | select(.order_id==$id)'

# 3) Provjeri da volume postoji
podman volume ls | grep ticketing_pgdata
podman volume inspect ticketing_pgdata --format '{{.Mountpoint}}'

# 4) UNIŠTI sve kontejnere (BEZ -v, volumeni ostaju!)
podman-compose down
podman ps -a | grep ticketing || echo "Nema kontejnera - svi su uklonjeni."
podman volume ls | grep ticketing_pgdata   # volume i dalje postoji

# 5) Ponovno pokreni
podman-compose up -d

# 6) DOKAZ: ista narudžba je i dalje u bazi
sleep 10
curl -s http://localhost:8080/tickets/orders | jq --arg id "$ORDER_ID" '.[] | select(.order_id==$id)'
# Ispisuje isti zapis => podaci su perzistentni.
```

Kontraprimjer (namjerno brisanje podataka):

```bash
podman-compose down -v     # -v briše i volumene!
podman volume ls | grep ticketing_pgdata || echo "Volume obrisan - podaci su izgubljeni."
podman-compose up -d       # baza se inicijalizira iz init.sql, tablica je prazna
```

---

## 7. Zaustavljanje

```bash
# Zaustavi kontejnere, ZADRŽI podatke
podman-compose down

# Zaustavi i OBRIŠI podatke (potpuni reset okruženja)
podman-compose down -v

# Čišćenje neiskorištenih slika i slojeva
podman image prune -f
podman system prune -f
```

### 7.1 Provjera urednog gašenja (graceful shutdown)

Zaustavljanje mora proći **bez** `SIGKILL` upozorenja. Ako se pojavi ispis poput

```
WARN[0010] StopSignal SIGTERM failed to stop container ticketing-worker in 10 seconds, resorting to SIGKILL
```

servis ne obrađuje `SIGTERM` i narudžba koja je u obradi može se izgubiti —
vidi scenarij 8 u [`runbook.md`](./runbook.md).

Očekivano ponašanje:

```bash
# Gašenje traje 1-2 s po servisu, bez upozorenja
time podman-compose down

# Izlazni kod mora biti 0 (uredan izlaz), a NE 137 (= 128 + 9, SIGKILL)
podman-compose up -d
podman stop ticketing-worker
podman inspect ticketing-worker --format '{{.State.ExitCode}}'    # 0

# U logu se vidi uredan tijek
podman logs --tail=5 ticketing-worker
#   Primljen SIGTERM - zapocinjem uredno gasenje workera...
#   Obrada zavrsena, zatvaram veze...
#   Worker uredno zaustavljen.
```

Worker u `compose.yaml` ima `stop_grace_period: 30s` jer pri gašenju dovršava
narudžbu koja je već uzeta iz Redisa, a još nije upisana u PostgreSQL.

Varijable koje upravljaju gašenjem (vidi `.env.example`):

| Varijabla | Lokalno | U k3s-u | Značenje |
|-----------|---------|---------|----------|
| `SHUTDOWN_DRAIN_MS` | `0` | `5000` | Koliko servis još poslužuje promet nakon SIGTERM-a, da ga load balancer stigne maknuti iz rotacije |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | `15000` | Krajnji rok prije prisilnog izlaza |

Lokalno nema load balancera pa je drain 0 (trenutno gašenje); u Kubernetesu je
5 s kako tijekom rolling updatea ne bi bilo 502 odgovora.

---

## 8. Ručno skeniranje slika (lokalno)

```bash
# Trivy kroz kontejner (nije potrebna instalacija na hostu)
podman run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$HOME/.cache/trivy:/root/.cache/trivy:Z" \
  docker.io/aquasec/trivy:latest image --severity HIGH,CRITICAL localhost/ticketing-api:local
```

Detalji i predložak izvještaja: [`security/image-scan-report.md`](./security/image-scan-report.md).

---

## 9. Ako nešto ne radi

Kompletan popis incidentnih scenarija s dijagnostikom i korektivnim mjerama nalazi se u
[`runbook.md`](./runbook.md). Najbrže početne provjere:

```bash
podman-compose ps                       # tko nije healthy?
podman-compose logs --tail=50 api       # zadnjih 50 redaka logova
podman inspect ticketing-api --format '{{json .State.Health}}' | jq .
sudo ausearch -m avc -ts recent         # SELinux odbijanja (AVC)
```

# Runbook — dijagnostika i oporavak

Operativni priručnik za **Secure Event Ticketing Platform**.
Svaki scenarij ima jednaku strukturu:
**simptom → dijagnostika → uzrok → korektivna mjera → validacija**.

Okruženja: `k3s` (Kubernetes) i `podman-compose` (lokalno).

---

## Brzi trijaž (uvijek prvo ovo)

```bash
# --- Kubernetes ---
kubectl -n ticketing get pods -o wide
kubectl -n ticketing get events --sort-by=.lastTimestamp | tail -30
kubectl -n ticketing describe pod <ime-poda> | sed -n '/Events:/,$p'
kubectl -n ticketing logs <ime-poda> --tail=100
kubectl -n ticketing logs <ime-poda> --previous --tail=100   # log prije zadnjeg pada

# --- Compose ---
podman-compose ps
podman-compose logs --tail=100 <servis>
podman inspect <kontejner> --format '{{json .State}}' | jq .
```

Tablica najčešćih statusa:

| Status poda | Najvjerojatniji uzrok | Scenarij |
|---|---|---|
| `ImagePullBackOff` / `ErrImagePull` | Krivi tag ili nema pristupa registryju | [1](#scenarij-1) |
| `Running` ali `0/1 READY` | Readiness probe pada (ovisnost nedostupna) | [2](#scenarij-2), [4](#scenarij-4), [5](#scenarij-5) |
| `CrashLoopBackOff` | Aplikacija se ruši pri pokretanju | [2](#scenarij-2), [4](#scenarij-4) |
| `OOMKilled` (u `Last State`) | Memorijski limit premalen | [6](#scenarij-6) |
| `Pending` | Nema resursa ili PVC nije Bound | [3](#scenarij-3) |
| `Permission denied` u logu (Compose) | SELinux bez `:Z` oznake | [7](#scenarij-7) |

---

<a id="scenarij-1"></a>
## Scenarij 1 — Loš tag slike → `ImagePullBackOff`

### Simptom
Nakon `kubectl set image` ili prve primjene manifesta novi pod ostaje u statusu
`ImagePullBackOff`/`ErrImagePull` i nikad ne postaje `Ready`.
`kubectl rollout status` nakon nekog vremena javlja
`error: deployment "api" exceeded its progress deadline`.

### Dijagnostika

```bash
kubectl -n ticketing get pods -l app.kubernetes.io/name=api
# api-7d9c8b6f5-abcde   0/1   ImagePullBackOff   0   2m

kubectl -n ticketing describe pod <ime-poda> | sed -n '/Events:/,$p'
# Failed to pull image "ghcr.io/ikovacek95/ticketing-api:ne-postoji":
#   ... manifest unknown            <- krivi tag
#   ... unauthorized / denied       <- privatni paket bez imagePullSecreta

# Koji je tag zapravo tražen?
kubectl -n ticketing get deployment api \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'

# Postoji li tag u registryju?
podman manifest inspect ghcr.io/ikovacek95/ticketing-api:<git-sha> >/dev/null \
  && echo "TAG POSTOJI" || echo "TAG NE POSTOJI"

# Provjera imagePullSecreta
kubectl -n ticketing get sa ticketing-sa -o jsonpath='{.imagePullSecrets}{"\n"}'
```

### Uzrok
1. Upisan je nepostojeći ili pogrešno prepisan tag (npr. skraćeni SHA umjesto punog), **ili**
2. GHCR paket je privatan, a klaster nema `imagePullSecret`, **ili**
3. CI još nije objavio sliku (pipeline pao na Trivy gateu).

### Korektivna mjera

```bash
# A) Najbrži oporavak - povratak na prethodnu, ispravnu reviziju
kubectl -n ticketing rollout undo deployment/api
kubectl -n ticketing rollout status deployment/api --timeout=180s

# B) Postaviti ispravan (puni 40-znakovni) SHA
kubectl -n ticketing set image deployment/api \
  api=ghcr.io/ikovacek95/ticketing-api:<ispravan-git-sha>

# C) Privatan paket -> dodati vjerodajnice
kubectl create secret docker-registry ghcr-cred -n ticketing \
  --docker-server=ghcr.io --docker-username=ikovacek95 --docker-password='<PAT>'
kubectl -n ticketing patch serviceaccount ticketing-sa \
  -p '{"imagePullSecrets":[{"name":"ghcr-cred"}]}'
kubectl -n ticketing rollout restart deployment/api
```

> **Zašto usluga nije pala:** `maxUnavailable: 0` znači da Kubernetes gasi stari pod
> tek kad je novi `Ready`. Stari podovi cijelo vrijeme poslužuju promet.

### Validacija

```bash
kubectl -n ticketing get pods -l app.kubernetes.io/name=api   # 2/2 Running
kubectl -n ticketing get deployment api -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
curl -s -o /dev/null -w '%{http_code}\n' http://ticketing.local/api/healthz   # 200
```

### Prevencija
Tag uvijek kopirati iz izlaza CI pipelinea (`github.sha`); nikad ga ne prepisivati ručno.

---

<a id="scenarij-2"></a>
## Scenarij 2 — Neispravan Secret → readiness 503

### Simptom
API podovi su `Running`, ali `0/1 READY`. `curl http://ticketing.local/api/readyz`
vraća **503**, a Traefik na `/api/*` vraća `503 Service Unavailable` jer u Servicu
nema nijednog spremnog Endpointa. `/healthz` i dalje vraća 200.

### Dijagnostika

```bash
kubectl -n ticketing get pods -l app.kubernetes.io/name=api
# api-...   0/1   Running   0   3m

kubectl -n ticketing describe pod <ime-poda> | grep -A5 -i readiness
# Warning  Unhealthy  ...  Readiness probe failed: HTTP probe failed with statuscode: 503

kubectl -n ticketing logs deploy/api --tail=50
# Redis error / password authentication failed for user "ticketing_user"

# Detaljan razlog izravno iz aplikacije:
kubectl -n ticketing exec deploy/api -- wget -qO- http://127.0.0.1:8080/readyz
# {"status":"not-ready","error":"password authentication failed for user \"ticketing_user\""}

# Service nema spremnih endpointa:
kubectl -n ticketing get endpoints api
# api   <none>

# Usporedba lozinke u Secretu i one kojom je baza inicijalizirana:
kubectl -n ticketing get secret ticketing-secret -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d; echo
kubectl -n ticketing get secret ticketing-secret -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d | wc -c

# Postoji li uopće ključ POSTGRES_PASSWORD?
kubectl -n ticketing get secret ticketing-secret -o jsonpath='{.data}' | jq 'keys'
```

### Uzrok
Najčešće: pokrenut je `kubectl apply -f k8s/`, čime je **predložak**
`02-secret.example.yaml` prepisao stvarni Secret placeholderom
`REPLACE_ME_PRIJE_PRIMJENE`. Ostale varijante: krivo ime ključa, `--from-literal`
s razmakom/novim redom, ili Secret kreiran **nakon** što je PostgreSQL već
inicijalizirao bazu (lozinka u bazi se tada više ne mijenja automatski).

### Korektivna mjera

```bash
# 1) Vrati ispravan Secret
kubectl create secret generic ticketing-secret -n ticketing \
  --from-literal=POSTGRES_PASSWORD='<stvarna-lozinka>' \
  --dry-run=client -o yaml | kubectl apply -f -

# 2) Uskladi lozinku U BAZI (ako je baza inicijalizirana s drugom lozinkom)
kubectl -n ticketing exec -it statefulset/postgres -- \
  psql -U ticketing_user -d ticketing \
  -c "ALTER USER ticketing_user WITH PASSWORD '<stvarna-lozinka>';"

# 3) Podovi moraju pročitati novi Secret (envFrom se NE osvježava sam)
kubectl -n ticketing rollout restart deployment/api deployment/worker
kubectl -n ticketing rollout status deployment/api --timeout=180s

# Krajnja opcija (GUBI PODATKE) - ponovna inicijalizacija baze:
#   kubectl -n ticketing delete statefulset postgres
#   kubectl -n ticketing delete pvc pgdata-postgres-0
#   kubectl apply -f k8s/04-postgres.yaml
```

### Validacija

```bash
kubectl -n ticketing get pods -l app.kubernetes.io/name=api    # 1/1 READY
kubectl -n ticketing get endpoints api                          # 2 IP adrese
curl -s http://ticketing.local/api/readyz | jq .                # {"status":"ready"}
curl -s -o /dev/null -w '%{http_code}\n' http://ticketing.local/api/tickets/orders  # 200
```

### Prevencija
Manifeste primjenjivati naredbom koja preskače predloške:
`ls k8s/*.yaml | grep -v '\.example\.yaml$' | xargs -n1 kubectl apply -f`.

---

<a id="scenarij-3"></a>
## Scenarij 3 — Pad PostgreSQL poda → provjera perzistencije PVC-a

### Simptom
Pod `postgres-0` je nestao, u `CrashLoopBackOff`-u ili `Pending`. API vraća 503,
a worker u logu ponavlja `Worker loop error: ... ECONNREFUSED`.
Ključno pitanje: **jesu li podaci izgubljeni?**

### Dijagnostika

```bash
kubectl -n ticketing get pods -l app.kubernetes.io/name=postgres
kubectl -n ticketing describe pod postgres-0 | sed -n '/Events:/,$p'
kubectl -n ticketing logs postgres-0 --previous --tail=100

# STANJE TRAJNOG DISKA - najvažnija provjera
kubectl -n ticketing get pvc
# NAME                STATUS   VOLUME        CAPACITY   STORAGECLASS
# pgdata-postgres-0   Bound    pvc-xxxxxxx   2Gi        local-path

kubectl -n ticketing describe pvc pgdata-postgres-0
kubectl get pv | grep ticketing

# Gdje su podaci fizički na k3s čvoru?
kubectl get pv -o jsonpath='{.items[?(@.spec.storageClassName=="local-path")].spec.hostPath.path}{"\n"}'
sudo ls -la /var/lib/rancher/k3s/storage/

# Ima li čvor mjesta na disku?
df -h /var/lib/rancher
kubectl describe node | grep -A5 -i "disk\|pressure"
```

### Uzrok
- Pod je ubijen (OOM, `kubectl delete pod`, restart čvora) — **podaci su sigurni**, PVC je odvojen od životnog ciklusa poda.
- PVC je `Pending`: nema `local-path` provisionera ili je disk pun — podaci nisu izgubljeni, ali se pod ne može pokrenuti.
- PVC je obrisan (`kubectl delete pvc`) — **podaci su nepovratno izgubljeni**.

### Korektivna mjera

```bash
# A) Pod se ne diže - forsiraj ponovno kreiranje (StatefulSet spaja ISTI PVC)
kubectl -n ticketing delete pod postgres-0
kubectl -n ticketing rollout status statefulset/postgres --timeout=300s

# B) PVC Pending - provjeri provisionera
kubectl -n kube-system get pods -l app=local-path-provisioner
kubectl -n kube-system logs -l app=local-path-provisioner --tail=50
kubectl get storageclass    # local-path mora biti (default)

# C) Disk pun - oslobodi prostor na čvoru
sudo journalctl --vacuum-time=3d
sudo k3s crictl rmi --prune

# D) Nakon oporavka baze restartaj potrošače da obnove connection pool
kubectl -n ticketing rollout restart deployment/api deployment/worker
```

### Validacija

```bash
kubectl -n ticketing get pods -l app.kubernetes.io/name=postgres   # 1/1 Running
kubectl -n ticketing get pvc pgdata-postgres-0                     # Bound

# DOKAZ PERZISTENCIJE - podaci prije pada moraju i dalje postojati
kubectl -n ticketing exec statefulset/postgres -- \
  psql -U ticketing_user -d ticketing -c 'SELECT count(*) FROM ticket_orders;'

kubectl -n ticketing exec statefulset/postgres -- \
  psql -U ticketing_user -d ticketing \
  -c 'SELECT order_id, status, created_at FROM ticket_orders ORDER BY created_at DESC LIMIT 5;'

curl -s http://ticketing.local/api/readyz | jq .          # {"status":"ready"}
curl -s http://ticketing.local/api/tickets/orders | jq 'length'
```

**Ekvivalent u Compose okruženju:**

```bash
podman rm -f ticketing-postgres          # uništi kontejner
podman volume ls | grep ticketing_pgdata # volume i dalje postoji
podman-compose up -d postgres
sleep 10
curl -s http://localhost:8080/tickets/orders | jq 'length'   # isti broj zapisa
```

### Prevencija
Redovita sigurnosna kopija:
`kubectl -n ticketing exec statefulset/postgres -- pg_dump -U ticketing_user ticketing > backup.sql`

---

<a id="scenarij-4"></a>
## Scenarij 4 — Redis nedostupan → gomilanje poruka u queueu

### Simptom
`POST /tickets/purchase` vraća **500** (`Unable to enqueue order`) ili narudžbe
prolaze s **202**, ali se **nikad ne pojave** u `GET /tickets/orders`.
API je `0/1 READY` jer `/readyz` pada na `redisClient.ping()`.
U logu workera: `Worker loop error: Socket closed unexpectedly`.

### Dijagnostika

```bash
kubectl -n ticketing get pods -l app.kubernetes.io/name=redis
kubectl -n ticketing logs deploy/redis --tail=50
kubectl -n ticketing get endpoints redis

# Je li Redis dostupan iz API poda?
kubectl -n ticketing exec deploy/api -- \
  sh -c 'timeout 5 nc -z redis 6379 && echo "REDIS OK" || echo "REDIS NEDOSTUPAN"'

# DUBINA QUEUEA - koliko je poruka zapelo?
kubectl -n ticketing exec deploy/redis -- redis-cli LLEN ticket_orders
kubectl -n ticketing exec deploy/redis -- redis-cli LRANGE ticket_orders 0 4

# Radi li worker uopće?
kubectl -n ticketing get pods -l app.kubernetes.io/name=worker
kubectl -n ticketing logs deploy/worker --tail=100
kubectl -n ticketing exec deploy/worker -- pgrep -af "src/worker.js"

# Je li Redis dosegnuo memorijski limit?
kubectl -n ticketing exec deploy/redis -- redis-cli INFO memory | grep -E 'used_memory_human|maxmemory'
kubectl top pod -n ticketing -l app.kubernetes.io/name=redis 2>/dev/null
```

### Uzrok
- Redis pod je pao/restartan — API ne može zapisati u queue (`500`).
- Redis radi, ali je **worker** pao ili je zaglavio → poruke ulaze (`202`), nitko ih ne konzumira → `LLEN` raste.
- Worker radi, ali ne može pisati u PostgreSQL → `processOrder` baca iznimku i ulazi u petlju ponavljanja.
- Redis je bez perzistencije (`emptyDir`, `--save ""`), pa restart poda **briše cijeli queue**.

### Korektivna mjera

```bash
# A) Redis ne radi
kubectl -n ticketing rollout restart deployment/redis
kubectl -n ticketing rollout status deployment/redis --timeout=120s

# B) Queue raste jer worker ne konzumira
kubectl -n ticketing rollout restart deployment/worker
kubectl -n ticketing rollout status deployment/worker --timeout=120s

# C) Backlog se prebrzo ne prazni - privremeno povećaj broj konzumenata
kubectl -n ticketing scale deployment/worker --replicas=3
# (brPop je atomarna operacija, pa više workera sigurno dijeli isti queue)

# D) Nakon pražnjenja vrati na jednu repliku
kubectl -n ticketing scale deployment/worker --replicas=1

# E) Ako je pravi uzrok baza (worker ne može pisati) - prvo riješi scenarij 2 ili 3
```

### Validacija

```bash
# Queue se prazni
watch -n2 'kubectl -n ticketing exec deploy/redis -- redis-cli LLEN ticket_orders'
# vrijednost pada prema 0

kubectl -n ticketing exec deploy/redis -- redis-cli ping           # PONG
curl -s http://ticketing.local/api/readyz | jq .                    # {"status":"ready"}

# Kraj-do-kraja test
OID=$(curl -s -X POST http://ticketing.local/api/tickets/purchase \
  -H "Content-Type: application/json" \
  -d '{"eventId":"evt-1003","customerEmail":"test@algebra.hr","quantity":1}' | jq -r .orderId)
sleep 3
curl -s http://ticketing.local/api/tickets/orders | jq --arg id "$OID" '.[] | select(.order_id==$id)'
# status: "processed"
```

### Prevencija
Nadzirati `LLEN ticket_orders`; trajni rast je rani pokazatelj da worker ne radi.
Za produkciju: Redis s PVC-om i AOF perzistencijom umjesto `emptyDir`.

---

<a id="scenarij-5"></a>
## Scenarij 5 — Prestroga NetworkPolicy → timeout

### Simptom
Podovi su `Running`, logovi su čisti, ali `/readyz` puca u timeout, a
`kubectl exec ... nc -z postgres 5432` visi do isteka vremena.
Nakon dodavanja nove NetworkPolicy ili preimenovanja labela promet iznenada prestaje.

### Dijagnostika

```bash
kubectl -n ticketing get networkpolicy
kubectl -n ticketing describe networkpolicy default-deny-ingress
kubectl -n ticketing describe networkpolicy allow-postgres-from-api-worker

# Koje labele pod STVARNO ima?
kubectl -n ticketing get pods --show-labels
kubectl -n ticketing get pod <api-pod> -o jsonpath='{.metadata.labels}' | jq .

# Test konektivnosti po slojevima
kubectl -n ticketing exec deploy/api -- sh -c 'timeout 5 nc -z postgres 5432; echo "postgres: $?"'
kubectl -n ticketing exec deploy/api -- sh -c 'timeout 5 nc -z redis 6379;    echo "redis:    $?"'
kubectl -n ticketing exec deploy/frontend -- sh -c 'timeout 5 nc -z api 8080; echo "api:      $?"'
# 0 = prolazi, 124 = timeout (blokirano politikom)

# Radi li DNS? (egress nije ograničen, pa DNS mora raditi)
kubectl -n ticketing exec deploy/api -- nslookup postgres.ticketing.svc.cluster.local

# Ima li Traefik pristup? (dolazi iz namespacea kube-system)
kubectl -n kube-system get ns kube-system --show-labels | grep kubernetes.io/metadata.name
kubectl -n kube-system logs deploy/traefik --tail=50 | grep -i "timeout\|refused"

# Je li NetworkPolicy controller uopće aktivan?
sudo journalctl -u k3s | grep -i "network policy" | tail -5
```

### Uzrok
`default-deny-ingress` blokira **sav** ulazni promet; propušta se samo ono što
eksplicitno dopuštaju ostale politike. Promet pada kad:
- labele poda ne odgovaraju `podSelector`/`from.podSelector` u politici (npr. promijenjen `app.kubernetes.io/name`),
- nedostaje pravilo za novi izvor prometa,
- namespace `kube-system` nema oznaku `kubernetes.io/metadata.name` (Traefik tada ne prolazi),
- port u pravilu ne odgovara stvarnom `containerPort`.

### Korektivna mjera

```bash
# 1) DIJAGNOSTIČKI TEST (privremeno!) - ukloni default-deny i potvrdi da je uzrok u politici
kubectl -n ticketing delete networkpolicy default-deny-ingress
kubectl -n ticketing exec deploy/api -- sh -c 'timeout 5 nc -z postgres 5432; echo $?'
# 2) ODMAH ga vrati - namespace ne smije ostati bez segmentacije
kubectl apply -f k8s/10-networkpolicy.yaml

# 3) Uskladi labele s politikom (ispravan trajni popravak)
kubectl -n ticketing get pods --show-labels
# Labele u k8s/*.yaml i selektore u k8s/10-networkpolicy.yaml svesti na iste vrijednosti,
# zatim ponovno primijeniti:
kubectl apply -f k8s/06-api.yaml -f k8s/10-networkpolicy.yaml

# 4) Ako Traefik ne prolazi - provjeri/dodaj oznaku namespacea
kubectl label namespace kube-system kubernetes.io/metadata.name=kube-system --overwrite
```

> **Ne rješavati brisanjem NetworkPolicyja.** Ispravan popravak je precizno pravilo
> koje dopušta točno potreban promet (izvor + port).

### Validacija

```bash
# Dopušteni tokovi MORAJU raditi
kubectl -n ticketing exec deploy/api      -- sh -c 'timeout 5 nc -z postgres 5432 && echo "OK api->postgres"'
kubectl -n ticketing exec deploy/worker   -- sh -c 'timeout 5 nc -z redis 6379    && echo "OK worker->redis"'
kubectl -n ticketing exec deploy/frontend -- sh -c 'timeout 5 nc -z api 8080      && echo "OK frontend->api"'

# Zabranjeni tokovi MORAJU pasti u timeout
kubectl -n ticketing exec deploy/frontend -- \
  sh -c 'timeout 5 nc -z postgres 5432 && echo "PROBLEM: dopusteno" || echo "OK: blokirano"'

curl -s http://ticketing.local/api/readyz | jq .    # {"status":"ready"}
curl -s -o /dev/null -w '%{http_code}\n' http://ticketing.local/   # 200
```

### Prevencija
Uz svaku promjenu labela obavezno provjeriti `k8s/10-networkpolicy.yaml`.
Labela `app.kubernetes.io/name` je ugovor između Deploymenta, Servicea i NetworkPolicyja.

---

<a id="scenarij-6"></a>
## Scenarij 6 — Premali memorijski limit → `OOMKilled`

### Simptom
Pod se ciklički restarta, `RESTARTS` brzo raste, status prelazi u `CrashLoopBackOff`.
U aplikacijskom logu **nema** poruke o grešci — proces je ubijen izvana.

### Dijagnostika

```bash
kubectl -n ticketing get pods
# api-...   0/1   CrashLoopBackOff   7   6m

# POTVRDA da je uzrok OOM
kubectl -n ticketing describe pod <ime-poda> | grep -A6 "Last State"
# Last State:     Terminated
#   Reason:       OOMKilled
#   Exit Code:    137

kubectl -n ticketing get pod <ime-poda> \
  -o jsonpath='{.status.containerStatuses[0].lastState.terminated.reason}{"\n"}'
# OOMKilled

# Trenutni limiti
kubectl -n ticketing get deployment api \
  -o jsonpath='{.spec.template.spec.containers[0].resources}{"\n"}' | jq .

# Stvarna potrošnja (metrics-server dolazi uz k3s)
kubectl top pods -n ticketing
kubectl top pod -n ticketing -l app.kubernetes.io/name=api --containers

# Događaji na razini čvora
kubectl -n ticketing get events --field-selector reason=OOMKilling
dmesg -T | grep -i "killed process" | tail -5
```

### Uzrok
`resources.limits.memory` je niži od stvarne potrebe procesa. Kad cgroup limit bude
prekoračen, kernel OOM killer ubija proces s izlaznim kodom **137**. Node.js je
posebno osjetljiv jer veličinu heapa procjenjuje prema **memoriji čvora**, a ne
prema cgroup limitu kontejnera.

### Korektivna mjera

```bash
# A) Brzo podizanje limita (privremeno)
kubectl -n ticketing set resources deployment/api \
  --requests=cpu=100m,memory=192Mi --limits=cpu=500m,memory=512Mi
kubectl -n ticketing rollout status deployment/api --timeout=180s

# B) Trajno: izmijeniti k8s/06-api.yaml i commitati promjenu
#      resources:
#        requests: { cpu: 100m, memory: 192Mi }
#        limits:   { cpu: 500m, memory: 512Mi }
kubectl apply -f k8s/06-api.yaml

# C) Uskladiti Node.js heap s limitom kontejnera (dodati u ConfigMap ticketing-config):
#      NODE_OPTIONS: "--max-old-space-size=384"    # ~75% od limita 512Mi
kubectl -n ticketing set env deployment/api NODE_OPTIONS="--max-old-space-size=384"
```

Preporučeno pravilo: `limit ≈ 1.5–2 × uobičajena potrošnja`,
`requests ≈ uobičajena potrošnja`, a `--max-old-space-size ≈ 75 % limita`.

### Validacija

```bash
kubectl -n ticketing get pods -l app.kubernetes.io/name=api
# 1/1 Running, RESTARTS 0 i ostaje 0

kubectl -n ticketing describe pod <ime-poda> | grep -c OOMKilled   # 0

# Potrošnja stabilno ispod limita
kubectl top pod -n ticketing -l app.kubernetes.io/name=api

# Test pod opterećenjem
for i in $(seq 1 200); do
  curl -s -o /dev/null -X POST http://ticketing.local/api/tickets/purchase \
    -H "Content-Type: application/json" \
    -d '{"eventId":"evt-1001","customerEmail":"load@algebra.hr","quantity":1}'
done
kubectl -n ticketing get pods -l app.kubernetes.io/name=api   # RESTARTS i dalje 0
```

### Prevencija
Prije postavljanja limita izmjeriti potrošnju (`kubectl top`) pod realnim opterećenjem;
ne prepisivati vrijednosti iz drugih projekata.

---

<a id="scenarij-7"></a>
## Scenarij 7 — SELinux bez `:Z` oznake → `Permission denied` (Compose)

### Simptom
`podman-compose up -d` prolazi, ali kontejner `ticketing-postgres` odmah pada.
U logu:

```
/usr/local/bin/docker-entrypoint.sh: /docker-entrypoint-initdb.d/init.sql: Permission denied
```

U dev profilu isti se problem javlja kod bind-mountanog koda:
`Error: Cannot find module '/app/src/server.js'`.
Tablica `ticket_orders` ne postoji, pa `GET /tickets/orders` vraća 500.

### Dijagnostika

```bash
getenforce                      # Enforcing
podman-compose logs postgres | tail -20

# KLJUČNA PROVJERA - AVC odbijanja u audit logu
sudo ausearch -m avc -ts recent
# type=AVC ... denied { read } ... scontext=system_u:system_r:container_t:s0:c123,c456
#                                  tcontext=unconfined_u:object_r:user_home_t:s0

sudo journalctl -t setroubleshoot --since "10 min ago"

# SELinux kontekst montirane datoteke
ls -Z infra/postgres/init.sql
# unconfined_u:object_r:user_home_t:s0    <- POGREŠNO
# Ispravno je: ...:container_file_t:s0

# Ima li mount u compose datoteci `:Z` oznaku?
grep -n ':Z' compose.yaml compose.dev.yaml

# Kako je Podman stvarno montirao datoteku?
podman inspect ticketing-postgres --format '{{json .Mounts}}' | jq .
```

### Uzrok
Na CentOS Stream 9 SELinux je u `enforcing` modu. Procesi u kontejneru rade u
domeni `container_t` i smiju čitati samo datoteke označene tipom `container_file_t`.
Datoteke u korisničkom direktoriju imaju tip `user_home_t`, pa je pristup odbijen.
Oznaka `:Z` govori Podmanu da pri montiranju **prelabelira** datoteku u
`container_file_t` (privatno, samo za taj kontejner); `:z` radi isto, ali dijeljeno
između više kontejnera.

### Korektivna mjera

```bash
# A) ISPRAVNO RJEŠENJE - dodati :Z na svaki bind-mount u compose datotekama
#    compose.yaml:
#      - ./infra/postgres/init.sql:/docker-entrypoint-initdb.d/init.sql:ro,Z
#    compose.dev.yaml:
#      - ./api/src:/app/src:Z

podman-compose down -v          # -v je nužan: init.sql se izvršava samo na PRAZNOJ bazi
podman-compose up -d --build

# B) Ručno prelabeliranje (ako se compose datoteka ne smije mijenjati)
sudo semanage fcontext -a -t container_file_t "$(pwd)/infra/postgres(/.*)?"
sudo restorecon -Rv infra/postgres/
ls -Z infra/postgres/init.sql   # sada container_file_t

# C) Provjera nakon promjene
grep -c ':Z' compose.yaml compose.dev.yaml
```

> **NIKAKO `setenforce 0`.** Time se ne popravlja uzrok, nego se isključuje
> sigurnosni mehanizam operativnog sustava. Isto vrijedi za `--privileged`
> i `--security-opt label=disable`.

### Validacija

```bash
podman-compose ps
# ticketing-postgres   Up (healthy)

podman-compose logs postgres | grep -i "database system is ready to accept connections"

# Tablica je stvarno kreirana iz init.sql
podman exec ticketing-postgres psql -U ticketing_user -d ticketing -c '\dt'
#  public | ticket_orders | table | ticketing_user

podman exec ticketing-postgres psql -U ticketing_user -d ticketing \
  -c 'SELECT count(*) FROM ticket_orders;'

# Nema novih AVC odbijanja
sudo ausearch -m avc -ts recent | grep -c container_t || echo "OK: nema AVC odbijanja"

# Kraj-do-kraja
curl -s -X POST http://localhost:8080/tickets/purchase \
  -H "Content-Type: application/json" \
  -d '{"eventId":"evt-1001","customerEmail":"selinux@algebra.hr","quantity":1}' | jq .
sleep 3
curl -s http://localhost:8080/tickets/orders | jq 'length'
```

### Prevencija
Svaki novi bind-mount u `compose.yaml`/`compose.dev.yaml` **mora** imati `:Z` ili `:z`.
Imenovani volumeni (npr. `pgdata`) ne trebaju oznaku — Podman ih sam ispravno označava.

---

## Dodatak A — Kontrolna lista za nove incidente

1. Reproducira li se problem? Zabilježi točnu naredbu i izlaz.
2. Kada je počeo? `kubectl -n ticketing get events --sort-by=.lastTimestamp`
3. Koja se promjena dogodila prije? `kubectl -n ticketing rollout history deployment/<ime>`
4. Je li problem u aplikaciji (log), platformi (events) ili mreži (`nc`, `nslookup`)?
5. Najbrža stabilizacija: `kubectl -n ticketing rollout undo deployment/<ime>`
6. Tek nakon stabilizacije tražiti korijenski uzrok.
7. Dopuniti ovaj runbook novim scenarijem.

## Dodatak B — Najkorisnije naredbe

```bash
# Kubernetes
kubectl -n ticketing get pods -o wide --show-labels
kubectl -n ticketing describe pod <pod> | sed -n '/Events:/,$p'
kubectl -n ticketing logs <pod> --previous --tail=200
kubectl -n ticketing exec -it deploy/api -- sh
kubectl -n ticketing port-forward svc/api 8080:8080
kubectl -n ticketing rollout undo deployment/<ime>
kubectl top pods -n ticketing

# Podman / Compose
podman-compose ps
podman-compose logs -f <servis>
podman inspect <kontejner> --format '{{json .State.Health}}' | jq .
podman exec -it <kontejner> sh
podman volume inspect ticketing_pgdata

# CentOS / SELinux / firewalld
getenforce
sudo ausearch -m avc -ts recent
sudo firewall-cmd --list-all
sudo journalctl -u k3s -f
```

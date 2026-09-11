# Produkcijski deployment (2. dio projekta) — k3s na CentOS Stream 9

Ovaj dokument opisuje instalaciju k3s klastera, primjenu manifesta iz `k8s/`,
validaciju te demonstraciju **rolling updatea** i **rollbacka**.

---

## 1. Instalacija k3s

### 1.1 Priprema sustava

```bash
sudo dnf update -y
sudo dnf install -y curl iptables container-selinux

# Na CentOS/RHEL 9 NetworkManager zna preuzeti CNI sučelja - isključiti:
sudo systemctl disable --now nm-cloud-setup.service nm-cloud-setup.timer 2>/dev/null || true

# SELinux ostaje u enforcing modu - k3s instalater sam dohvaća k3s-selinux politiku.
getenforce
```

### 1.2 Firewalld pravila

```bash
# Kubernetes API server
sudo firewall-cmd --permanent --add-port=6443/tcp

# Interni promet klastera mora biti dopušten bez ograničenja:
#   10.42.0.0/16 = CIDR podova (flannel)
#   10.43.0.0/16 = CIDR servisa (ClusterIP)
sudo firewall-cmd --permanent --zone=trusted --add-source=10.42.0.0/16
sudo firewall-cmd --permanent --zone=trusted --add-source=10.43.0.0/16

# Traefik Ingress (HTTP/HTTPS)
sudo firewall-cmd --permanent --add-service=http     # 80/tcp
sudo firewall-cmd --permanent --add-service=https    # 443/tcp

sudo firewall-cmd --reload

# Provjera:
sudo firewall-cmd --list-all
sudo firewall-cmd --list-all --zone=trusted
```

> Ako se preskoči `trusted` zona za 10.42.0.0/16 i 10.43.0.0/16, podovi ne mogu
> međusobno komunicirati ni razriješiti DNS (CoreDNS), a `readyz` trajno vraća 503.

### 1.3 Instalacija

```bash
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--write-kubeconfig-mode 644" sh -

sudo systemctl status k3s --no-pager
```

k3s automatski isporučuje: **Traefik** (Ingress controller), **CoreDNS**,
**local-path** StorageClass i **kube-router** NetworkPolicy controller —
sve što ovi manifesti trebaju.

### 1.4 kubeconfig

```bash
mkdir -p ~/.kube
sudo install -o "$USER" -g "$USER" -m 600 /etc/rancher/k3s/k3s.yaml ~/.kube/config
export KUBECONFIG="$HOME/.kube/config"
echo 'export KUBECONFIG=$HOME/.kube/config' >> ~/.bashrc

# Provjera:
kubectl get nodes -o wide
kubectl get storageclass          # local-path (default)
kubectl -n kube-system get pods   # traefik, coredns, local-path-provisioner, metrics-server
```

---

## 2. Dostupnost slika iz GHCR-a

Manifesti povlače slike s `ghcr.io/ikovacek95/ticketing-*`.

**Opcija A (preporučeno) — paket je javan:**
GitHub → repozitorij → *Packages* → paket → *Package settings* → *Change visibility* → **Public**.
Tada nije potrebna nikakva autentikacija.

**Opcija B — privatan paket (imagePullSecret):**

```bash
kubectl create secret docker-registry ghcr-cred \
  --namespace ticketing \
  --docker-server=ghcr.io \
  --docker-username=ikovacek95 \
  --docker-password='<GITHUB_PAT_S_read:packages>'

# Secret se veže na ServiceAccount koji koriste svi podovi:
kubectl -n ticketing patch serviceaccount ticketing-sa \
  -p '{"imagePullSecrets":[{"name":"ghcr-cred"}]}'
```

> Namespace mora postojati prije ovih naredbi — vidi korak 3.1.

---

## 3. Primjena manifesta

### 3.1 Namespace i Secret PRIJE ostalog

> **KRITIČNO:** PostgreSQL koristi `POSTGRES_PASSWORD` **samo pri prvoj inicijalizaciji**
> baze. Ako se StatefulSet pokrene s placeholder lozinkom, kasnija izmjena Secreta
> **neće** promijeniti lozinku u bazi i API će trajno vraćati 503.
> Zato se stvarni Secret kreira **prije** primjene ostalih manifesta.

```bash
# 1) Namespace
kubectl apply -f k8s/00-namespace.yaml

# 2) Stvarni Secret - imperativno, NIKAD iz gita
kubectl create secret generic ticketing-secret \
  --namespace ticketing \
  --from-literal=POSTGRES_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=')"

# Provjera (bez ispisa same lozinke):
kubectl -n ticketing get secret ticketing-secret \
  -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d | wc -c
```

Datoteka `k8s/02-secret.example.yaml` je **samo predložak s placeholderom** i
namjerno se **ne primjenjuje**.

### 3.2 Ostali manifesti

```bash
# Preporučeno: preskače sve *.example.yaml predloške
ls k8s/*.yaml | grep -v '\.example\.yaml$' | xargs -n1 kubectl apply -f
```

Ako se ipak koristi `kubectl apply -f k8s/`, predložak Secreta **prepisat će**
stvarni Secret placeholderom (vidi scenarij 2 u [`runbook.md`](./runbook.md)).
U tom slučaju odmah nakon primjene treba vratiti ispravnu vrijednost:

```bash
kubectl apply -f k8s/
kubectl create secret generic ticketing-secret -n ticketing \
  --from-literal=POSTGRES_PASSWORD='<stvarna-lozinka>' \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n ticketing rollout restart deployment/api deployment/worker
```

### 3.3 Praćenje podizanja

```bash
kubectl -n ticketing get pods -w

kubectl -n ticketing rollout status statefulset/postgres --timeout=300s
kubectl -n ticketing rollout status deployment/redis    --timeout=180s
kubectl -n ticketing rollout status deployment/api      --timeout=180s
kubectl -n ticketing rollout status deployment/worker   --timeout=180s
kubectl -n ticketing rollout status deployment/frontend --timeout=180s
```

Očekivani ispis:

```
NAME                        READY   STATUS    RESTARTS   AGE
api-xxxxxxxxxx-xxxxx        1/1     Running   0          1m
api-xxxxxxxxxx-yyyyy        1/1     Running   0          1m
frontend-xxxxxxxxxx-xxxxx   1/1     Running   0          1m
frontend-xxxxxxxxxx-yyyyy   1/1     Running   0          1m
postgres-0                  1/1     Running   0          2m
redis-xxxxxxxxxx-xxxxx      1/1     Running   0          2m
worker-xxxxxxxxxx-xxxxx     1/1     Running   0          1m
```

---

## 4. DNS unos za `ticketing.local`

Ingress sluša na hostu `ticketing.local`, pa taj naziv treba razriješiti u IP
adresu k3s čvora — **na svakom stroju s kojeg se pristupa** (poslužitelj i/ili
klijentsko računalo).

```bash
NODE_IP=$(kubectl get node -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')
echo "$NODE_IP"

echo "$NODE_IP  ticketing.local" | sudo tee -a /etc/hosts

# Provjera:
getent hosts ticketing.local
```

Na Windows klijentu isti se zapis dodaje u
`C:\Windows\System32\drivers\etc\hosts` (uređivač pokrenut kao Administrator).

---

## 5. Validacija

### 5.1 Osnovni objekti

```bash
kubectl -n ticketing get all
kubectl -n ticketing get configmap,secret,ingress,networkpolicy,sa,role,rolebinding
kubectl -n ticketing get pvc,pv
# pgdata-postgres-0   Bound   pvc-....   2Gi   RWO   local-path
```

### 5.2 Aplikacijski endpointi kroz Ingress

```bash
curl -s http://ticketing.local/api/healthz | jq .
# {"status":"ok","service":"api"}

curl -s -o /dev/null -w '%{http_code}\n' http://ticketing.local/api/readyz
# 200

curl -s http://ticketing.local/api/events | jq .

curl -s -X POST http://ticketing.local/api/tickets/purchase \
  -H "Content-Type: application/json" \
  -d '{"eventId":"evt-1001","customerEmail":"student@algebra.hr","quantity":2}' | jq .
# {"message":"Order queued","orderId":"<uuid>"}

sleep 3
curl -s http://ticketing.local/api/tickets/orders | jq .
# status: "processed"  => worker je odradio posao

curl -s http://ticketing.local/healthz | jq .
# {"status":"ok","service":"frontend"}
```

U pregledniku: `http://ticketing.local`.

### 5.3 Provjera sigurnosnih kontrola

```bash
# Podovi rade kao non-root:
kubectl -n ticketing exec deploy/api -- id
# uid=10001 gid=10001

# Read-only root filesystem:
kubectl -n ticketing exec deploy/api -- sh -c 'touch /x 2>&1 || echo "OK: read-only"'

# ServiceAccount token NIJE montiran:
kubectl -n ticketing exec deploy/api -- ls /var/run/secrets/kubernetes.io/ 2>&1 \
  || echo "OK: token nije montiran"

# NetworkPolicy je aktivna - pristup Postgresu iz frontenda mora pasti u timeout:
kubectl -n ticketing exec deploy/frontend -- \
  sh -c 'timeout 5 nc -z postgres 5432 && echo "PROBLEM: dopusteno" || echo "OK: blokirano"'

# Pristup Postgresu iz API-ja mora raditi:
kubectl -n ticketing exec deploy/api -- \
  sh -c 'timeout 5 nc -z postgres 5432 && echo "OK: dopusteno"'
```

### 5.4 Perzistencija u Kubernetesu

```bash
kubectl -n ticketing exec statefulset/postgres -- \
  psql -U ticketing_user -d ticketing -c 'SELECT count(*) FROM ticket_orders;'

# Namjerno ubij pod baze - StatefulSet ga ponovno kreira i spaja na isti PVC
kubectl -n ticketing delete pod postgres-0
kubectl -n ticketing rollout status statefulset/postgres --timeout=300s

kubectl -n ticketing exec statefulset/postgres -- \
  psql -U ticketing_user -d ticketing -c 'SELECT count(*) FROM ticket_orders;'
# Isti broj zapisa => PVC je sačuvao podatke.
```

---

## 6. Rolling update

Cilj: zamijeniti sliku bez ijedne sekunde nedostupnosti. Strategija u `k8s/06-api.yaml`
je `maxSurge: 1, maxUnavailable: 0` — Kubernetes prvo digne novi pod i tek kad je
**Ready** ugasi stari.

```bash
# Trenutno stanje
kubectl -n ticketing get deployment api -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
kubectl -n ticketing rollout history deployment/api

# 1) Postavi nepromjenjivi tag (commit SHA iz CI pipelinea)
GIT_SHA=<puni-40-znakovni-sha-iz-GitHub-Actions>

kubectl -n ticketing set image deployment/api \
  api=ghcr.io/ikovacek95/ticketing-api:${GIT_SHA}

# 2) Zabilježi razlog promjene (vidljivo u rollout history)
kubectl -n ticketing annotate deployment/api \
  kubernetes.io/change-cause="Nadogradnja na ${GIT_SHA} nakon Trivy gatea" --overwrite

# 3) Prati nadogradnju
kubectl -n ticketing rollout status deployment/api --timeout=180s
# deployment "api" successfully rolled out
```

Dokaz da nije bilo prekida — u drugom terminalu tijekom nadogradnje:

```bash
while true; do
  printf '%s %s\n' "$(date +%T)" "$(curl -s -o /dev/null -w '%{http_code}' http://ticketing.local/api/healthz)"
  sleep 1
done
# Svi odgovori moraju biti 200.
```

> **Zašto ovo stvarno radi bez prekida.** Osim `maxUnavailable: 0`, nužan je i
> graceful shutdown u aplikaciji. Pod koji dobije `SIGTERM` odmah počinje vraćati
> 503 na `/readyz` (Kubernetes ga miče iz Endpointa Servicea), zatim još
> `SHUTDOWN_DRAIN_MS` (5 s, `k8s/01-configmap.yaml`) normalno poslužuje promet
> dok Traefik i kube-proxy ne osvježe rute, pa tek onda zatvara server i
> dovršava zahtjeve u tijeku.
>
> Bez te drain faze pod zatvori socket u istom trenutku kad mu load balancer
> pošalje zahtjev → klijent dobije 502. Detalji i dijagnostika: scenarij 8 u
> [`runbook.md`](./runbook.md).

Provjera da se podovi gase **uredno**, a ne preko SIGKILL-a:

```bash
# Izlazni kod prethodne instance mora biti 0, a ne 137 (= 128 + 9)
kubectl -n ticketing get pod <stari-pod> \
  -o jsonpath='{.status.containerStatuses[0].lastState.terminated.exitCode}{"\n"}'

# U logu se vidi uredan tijek gasenja
kubectl -n ticketing logs deploy/api --tail=10
#   Primljen SIGTERM - zapocinjem uredno gasenje API-ja...
#   Drain faza: 5000 ms prije zatvaranja servera...
#   HTTP server zatvoren, zatvaram veze prema bazi i Redisu...
#   API uredno zaustavljen.
```

Provjera stanja i povijesti:

```bash
kubectl -n ticketing get pods -l app.kubernetes.io/name=api
kubectl -n ticketing rollout history deployment/api
# REVISION  CHANGE-CAUSE
# 1         <none>
# 2         Nadogradnja na <sha> nakon Trivy gatea
```

---

## 7. Rollback

```bash
# Povratak na prethodnu reviziju
kubectl -n ticketing rollout undo deployment/api
kubectl -n ticketing rollout status deployment/api --timeout=180s

# Povratak na točno određenu reviziju
kubectl -n ticketing rollout history deployment/api
kubectl -n ticketing rollout history deployment/api --revision=2
kubectl -n ticketing rollout undo deployment/api --to-revision=1

# Potvrda da je slika vraćena
kubectl -n ticketing get deployment api \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'

# Aplikacija i dalje odgovara
curl -s http://ticketing.local/api/healthz | jq .
```

Simulacija neuspjele nadogradnje (nepostojeći tag) i oporavak:

```bash
kubectl -n ticketing set image deployment/api api=ghcr.io/ikovacek95/ticketing-api:ne-postoji
kubectl -n ticketing rollout status deployment/api --timeout=60s
# error: deployment "api" exceeded its progress deadline

kubectl -n ticketing get pods -l app.kubernetes.io/name=api
# novi pod: ImagePullBackOff, ali STARI podovi i dalje rade (maxUnavailable: 0)

curl -s -o /dev/null -w '%{http_code}\n' http://ticketing.local/api/healthz   # i dalje 200

kubectl -n ticketing rollout undo deployment/api
kubectl -n ticketing rollout status deployment/api --timeout=180s
```

> Ovo je ujedno scenarij 1 u [`runbook.md`](./runbook.md).

---

## 8. Uklanjanje

```bash
# Aplikacija (PVC ostaje - StatefulSet ga ne briše automatski)
kubectl delete namespace ticketing

# Provjera zaostalih PV-ova
kubectl get pv

# Potpuna deinstalacija k3s
/usr/local/bin/k3s-uninstall.sh
```

---

## 9. Brza dijagnostika

```bash
kubectl -n ticketing get events --sort-by=.lastTimestamp | tail -30
kubectl -n ticketing describe pod <ime-poda>
kubectl -n ticketing logs deploy/api --tail=100
kubectl -n ticketing logs deploy/worker --tail=100 -f
kubectl -n kube-system logs deploy/traefik --tail=50
```

Detaljni incidentni scenariji: [`runbook.md`](./runbook.md).

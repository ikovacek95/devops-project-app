# Sigurnosno izvješće — skeniranje slika, ovisnosti i konfiguracije

| Stavka | Vrijednost |
|---|---|
| Projekt | Secure Event Ticketing Platform |
| Repozitorij | `ikovacek95/devops-project-app` |
| Registry | `ghcr.io/ikovacek95/ticketing-{api,frontend,worker}` |
| Alati | Trivy (image / fs / config), `npm audit`, hadolint, gitleaks |
| Datum skeniranja (CI) | 2026-09-08 (automatizirano u CI pipelineu), Trivy `0.65.0` |
| Datum skeniranja (ručno) | 2026-09-12 (CentOS Stream 9), Trivy `0.74.0` |
| Bazna slika | `docker.io/library/node:20.20-alpine3.22` (Alpine 3.22.4) |
| Autor | Ivor Kovaček |

> **Kako koristiti ovaj dokument:** sva poglavlja popunjena su **stvarnim** rezultatima
> skeniranja. Poglavlje 2 sadrži nalaze iz CI pipelinea, a poglavlje 3 **neovisnu ručnu
> verifikaciju** provedenu na CentOS Stream 9 poslužitelju. Poglavlje 8 je obvezujuća
> politika koja vrijedi bez obzira na nalaze.

---

## 1. Naredbe za skeniranje

### 1.1 Skeniranje slika (`trivy image`)

```bash
# --- Instalacija Trivyja na CentOS Stream 9 (službeni repozitorij) ---
#
# VAŽNO: na čistom sustavu `dnf` NE uvozi automatski Aqua Security GPG ključ, pa
# instalacija pada s "GPG check FAILED". Ključ se uvozi ručno PRIJE instalacije:
sudo rpm --import https://get.trivy.dev/rpm/public.key
sudo dnf -y install trivy

# NIKAKO ne koristiti `--nogpgcheck` kao "rješenje" - time bi se zaobišla provjera
# potpisa paketa, tj. upravo ona kontrola integriteta lanca opskrbe (supply chain)
# koju ovim alatom želimo osigurati.

trivy --version
# Version: 0.74.0

# Lokalno izgrađene slike (Podman)
for SVC in api frontend worker; do
  echo "===== ${SVC} ====="
  trivy image \
    --scanners vuln \
    --severity HIGH,CRITICAL \
    --ignore-unfixed \
    --format table \
    "localhost/ticketing-${SVC}:local"
done

# Objavljene slike iz GHCR-a (isti gate kao u CI-ju)
trivy image --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 \
  ghcr.io/ikovacek95/ticketing-api:<git-sha>

# Strojno čitljiv izvještaj za arhivu
trivy image --format json --output trivy-api.json ghcr.io/ikovacek95/ticketing-api:<git-sha>

# SBOM (popis komponenti) - koristan dokaz za reviziju
trivy image --format cyclonedx --output sbom-api.json ghcr.io/ikovacek95/ticketing-api:<git-sha>
```

### 1.2 Skeniranje izvornog koda i ovisnosti (`trivy fs`)

```bash
# Ranjivosti ovisnosti + tajne u repozitoriju
trivy fs --scanners vuln,secret --severity MEDIUM,HIGH,CRITICAL .

# Samo lockfileovi pojedinog servisa
trivy fs --scanners vuln ./api
trivy fs --scanners vuln ./frontend
trivy fs --scanners vuln ./worker

# npm audit kao dopuna (isti gate kao u CI-ju)
for SVC in api frontend worker; do (cd "$SVC" && npm ci --silent && npm audit --audit-level=high); done
```

### 1.3 Skeniranje konfiguracije (`trivy config`)

```bash
# Kubernetes manifesti
trivy config --severity HIGH,CRITICAL k8s/

# Containerfileovi i Compose datoteke
trivy config --severity HIGH,CRITICAL api/Containerfile
trivy config --severity HIGH,CRITICAL frontend/Containerfile
trivy config --severity HIGH,CRITICAL worker/Containerfile
trivy config --severity HIGH,CRITICAL compose.yaml

# Dodatno: hadolint i gitleaks (isti alati kao u CI-ju)
podman run --rm -i docker.io/hadolint/hadolint < api/Containerfile
podman run --rm -v "$PWD:/repo:Z" docker.io/zricethezav/gitleaks:latest detect --source /repo -v
```

---

## 2. Tablica nalaza — slike kontejnera

Ozbiljnost: 🔴 CRITICAL · 🟠 HIGH · 🟡 MEDIUM · ⚪ LOW

Nalazi su prikupljeni **automatski u CI pipelineu** (`trivy image --ignore-unfixed
--severity HIGH,CRITICAL`). Rezultati su identični za sva tri servisa jer dijele
istu baznu sliku i isti obrazac Containerfilea.

### 2.1 Nalazi u Node.js sloju — npm ugrađen u baznu sliku

> **Napomena o potpunosti:** Trivy je u ovom sloju prijavio **20 nalaza**
> (1 CRITICAL + 19 HIGH). Tablica niže popisuje 14 nalaza čitljivih u isječku CI
> loga; preostali su istog tipa i iz istog stabla ovisnosti. Dodatnih 5 nalaza
> identificirano je ručnim skeniranjem — vidi [§3.2](#32-prije--sirova-bazna-slika).

| # | Komponenta | CVE | Ozbiljnost | Instalirano | Ispravljeno u | Korektivna mjera | Ponovno skeniranje |
|---|-----------|-----|-----------|-------------|---------------|------------------|--------------------|
| 1 | `tar` | CVE-2026-59873 | 🔴 CRITICAL | 6.2.1 | 7.5.19 | Uklonjen npm iz `runtime` stagea | ✅ nema nalaza |
| 2 | `tar` | CVE-2026-23745 | 🟠 HIGH | 6.2.1 | 7.5.3 | Isto | ✅ nema nalaza |
| 3 | `tar` | CVE-2026-23950 | 🟠 HIGH | 6.2.1 | 7.5.4 | Isto | ✅ nema nalaza |
| 4 | `tar` | CVE-2026-24842 | 🟠 HIGH | 6.2.1 | 7.5.7 | Isto | ✅ nema nalaza |
| 5 | `tar` | CVE-2026-26960 | 🟠 HIGH | 6.2.1 | 7.5.8 | Isto | ✅ nema nalaza |
| 6 | `tar` | CVE-2026-29786 | 🟠 HIGH | 6.2.1 | 7.5.10 | Isto | ✅ nema nalaza |
| 7 | `tar` | CVE-2026-31802 | 🟠 HIGH | 6.2.1 | 7.5.11 | Isto | ✅ nema nalaza |
| 8 | `tar` | CVE-2026-59874 | 🟠 HIGH | 6.2.1 | 7.5.18 | Isto | ✅ nema nalaza |
| 9 | `tar` | CVE-2026-73566 | 🟠 HIGH | 6.2.1 | 7.5.21 | Isto | ✅ nema nalaza |
| 10 | `pacote` | CVE-2026-9496 | 🟠 HIGH | 18.0.6 | 21.5.1 | Isto | ✅ nema nalaza |
| 11 | `sigstore` | CVE-2026-48815 | 🟠 HIGH | 2.3.1 | 4.1.1 | Isto | ✅ nema nalaza |
| 12 | `minimatch` | CVE-2026-26996 | 🟠 HIGH | — | 10.2.1 | Isto | ✅ nema nalaza |
| 13 | `minimatch` | CVE-2026-27903 | 🟠 HIGH | — | 10.2.3 | Isto | ✅ nema nalaza |
| 14 | `minimatch` | CVE-2026-27904 | 🟠 HIGH | — | 10.2.3 | Isto | ✅ nema nalaza |

**Analiza:** nijedan od ovih paketa nije ovisnost aplikacije. Svi pripadaju stablu
ovisnosti **npm CLI-ja** u `/usr/local/lib/node_modules/npm`, koji dolazi ugrađen
u službenu Node sliku. Aplikacija se u produkciji pokreće s `node src/server.js`,
a ovisnosti se instaliraju u `deps` stageu i kopiraju kao gotov `node_modules` —
npm u finalnoj slici nema nikakvu funkciju.

**Mjera:** u `runtime` stageu uklanjaju se `npm`, `npx` i `yarn`. Time nestaje
cijela ova skupina nalaza, a ujedno se doslovno ispunjava načelo „u finalnoj slici
nema build alata".

### 2.2 Nalazi u OS sloju — Alpine paketi

| # | Komponenta | CVE | Ozbiljnost | Instalirano | Ispravljeno u | Korektivna mjera | Ponovno skeniranje |
|---|-----------|-----|-----------|-------------|---------------|------------------|--------------------|
| 15 | `libcrypto3` | CVE-2026-14456 | 🟠 HIGH | 3.5.6-r0 | 3.5.8-r0 | `apk --no-cache upgrade` u `runtime` stageu | ✅ nema nalaza |
| 16 | `libcrypto3` | CVE-2026-45447 | 🟠 HIGH | 3.5.6-r0 | 3.5.7-r0 | Isto | ✅ nema nalaza |
| 17 | `libssl3` | CVE-2026-14456 | 🟠 HIGH | 3.5.6-r0 | 3.5.8-r0 | Isto | ✅ nema nalaza |
| 18 | `libssl3` | CVE-2026-45447 | 🟠 HIGH | 3.5.6-r0 | 3.5.7-r0 | Isto | ✅ nema nalaza |

**Analiza:** ranjivosti OpenSSL-a naslijeđene su iz bazne slike. Sve imaju status
`fixed`, što znači da Alpine repozitorij već sadrži zakrpanu verziju — službena
Node slika naprosto još nije prepakirana s njom.

**Mjera:** `apk --no-cache upgrade` prije prelaska na non-root korisnika.

### 2.3 Sažetak po ozbiljnosti — PRIJE / POSLIJE

Tri uzastopna skeniranja iste slike (`ticketing-api`; `frontend` i `worker` identično):

| Faza | 🔴 CRITICAL | 🟠 HIGH | Ukupno | Status gatea |
|------|------------|--------|--------|--------------|
| **1. Početno stanje** (multi-stage, non-root, pinana bazna slika) | 1 | 23 | **24** | ❌ pada |
| **2. Nakon uklanjanja npm/npx/yarn iz runtimea** | 0 | 4 | **4** | ❌ pada |
| **3. Nakon `apk --no-cache upgrade`** | 0 | 0 | **0** | ✅ **prolazi** |

Završno stanje potvrđeno u CI-ju:

```
Report Summary
│ Target                                                                    │  Type  │ Vulnerabilities │
│ ghcr.io/ikovacek95/ticketing-api:8f4d3b17527911a12522e0663e2c737438f1e01f │ alpine │        0        │
```

Naredba za brzo prebrojavanje nalaza:

```bash
trivy image --format json ghcr.io/ikovacek95/ticketing-api:<git-sha> \
  | jq '[.Results[].Vulnerabilities // [] | .[].Severity] | group_by(.) | map({(.[0]): length}) | add'
```

> **Pouka:** quality gate je odradio točno ono zbog čega postoji — zaustavio je
> objavu slike s CRITICAL ranjivošću i prisilio korektivnu mjeru **prije** nego
> što je slika dospjela u registry. Nijedna ranjiva slika nije objavljena.

---

## 3. Neovisna ručna verifikacija na CentOS Stream 9

| Stavka | Vrijednost |
|---|---|
| Izvršio | Ivor Kovaček |
| Datum | 2026-09-12 |
| Platforma | CentOS Stream 9, rootless Podman, SELinux Enforcing |
| Verzija Trivyja | **0.74.0** (CI je koristio 0.65.0) |

Cilj ovog poglavlja je **neovisno provjeriti** nalaze iz poglavlja 2, i to alatom
novije verzije, na drugom stroju i izvan CI pipelinea.

### 3.1 Zašto je ova usporedba metodološki jaka

Usporedba „prije/poslije" napravljena je između **dva trajno dostupna artefakta**:

| | Artefakt | Uloga |
|---|---|---|
| **PRIJE** | `docker.io/library/node:20.20-alpine3.22` | sirova bazna slika, bez ijedne naše mjere |
| **POSLIJE** | `ghcr.io/ikovacek95/ticketing-api:ad884f4…` | finalna ojačana slika iz pipelinea |

Ključna prednost: **obje naredbe može ponoviti bilo tko, u bilo kojem trenutku, i
dobiti iste brojke.** Za razliku od CI logova, koji su prolazni (GitHub ih briše
nakon isteka retencije) i vezani uz jedan konkretan `run id`, ovdje su ulazi javno
dostupne slike s nepromjenjivim tagovima. Mjerenje je time **reproducibilno**, a ne
samo „vjerujte izvještaju".

> Skeniranje mjeri **učinak naših mjera**, a ne samo stanje finalne slike:
> razlika između ta dva artefakta je točno ono što su Containerfile mjere uklonile.

### 3.2 PRIJE — sirova bazna slika

```bash
trivy image --severity HIGH,CRITICAL --ignore-unfixed \
  docker.io/library/node:20.20-alpine3.22
```

**Alpine OS sloj — Total: 4 (HIGH: 4, CRITICAL: 0)**

| Library | CVE | Ozbiljnost | Status | Instalirano | Ispravljeno u | Naslov |
|---|---|---|---|---|---|---|
| `libcrypto3` | CVE-2026-14456 | 🟠 HIGH | fixed | 3.5.6-r0 | 3.5.8-r0 | openssl: Denial of Service via unbounded memory growth in QUIC server |
| `libcrypto3` | CVE-2026-45447 | 🟠 HIGH | fixed | 3.5.6-r0 | 3.5.7-r0 | openssl: Heap Use-After-Free in OpenSSL PKCS7_verify() |
| `libssl3` | CVE-2026-14456 | 🟠 HIGH | fixed | 3.5.6-r0 | 3.5.8-r0 | openssl: Denial of Service via unbounded memory growth in QUIC server |
| `libssl3` | CVE-2026-45447 | 🟠 HIGH | fixed | 3.5.6-r0 | 3.5.7-r0 | openssl: Heap Use-After-Free in OpenSSL PKCS7_verify() |

**Node.js sloj (`node-pkg`) — Total: 20 (HIGH: 19, CRITICAL: 1)**

Nalazi čitljivi u ispisu (dopunjuju tablicu iz [§2.1](#21-nalazi-u-nodejs-sloju--npm-ugrađen-u-baznu-sliku)):

| Komponenta | Verzija | CVE | Ozbiljnost | Ispravljeno u | Opis |
|---|---|---|---|---|---|
| `brace-expansion` | 2.0.1 | CVE-2026-13149 | 🟠 HIGH | 5.0.7, 1.1.16, 2.1.2 | DoS zbog eksponencijalne složenosti |
| `brace-expansion` | 2.0.1 | CVE-2026-14257 | 🟠 HIGH | 5.0.8, 3.0.3, 2.1.3, 1.1.17 | DoS kroz iscrpljivanje memorije u `expand()` |
| `brace-expansion` | 2.0.1 | CVE-2026-69152 | 🟠 HIGH | 1.1.18, 2.1.4, 3.0.6, 5.0.9 | DoS kroz neomeđena međupolja; zaobilazi mitigaciju CVE-2026-14257 |
| `cross-spawn` | 7.0.3 | CVE-2024-21538 | 🟠 HIGH | 7.0.5, 6.0.6 | Regular expression denial of service (ReDoS) |
| `glob` | 10.4.2 | CVE-2025-64756 | 🟠 HIGH | 11.1.0, 10.5.0 | Command Injection via Malicious Filenames |

**UKUPNO PRIJE: 24 nalaza = 23 HIGH + 1 CRITICAL** (4 u OS sloju + 20 u `node-pkg` sloju).

> ### ✅ Neovisna potvrda CI rezultata
>
> Ovaj ukupni zbroj **poklapa se u dlaku** s brojkama izmjerenima u CI pipelineu
> ([§2.3](#23-sažetak-po-ozbiljnosti--prije--poslije)): **1 CRITICAL + 23 HIGH = 24**,
> u omjeru 4 (OS) : 20 (`node-pkg`).
>
> Dvije nezavisne izvedbe — različiti strojevi, različite verzije Trivyja
> (0.65.0 u CI-ju vs. 0.74.0 lokalno), različiti trenuci u vremenu — daju
> **identičan rezultat**. To je jaka potvrda da nalazi nisu artefakt jednog
> okruženja ni slučajnog stanja baze ranjivosti.

**Napomena o različitim popisanim paketima.** Tablica u §2.1 (CI) navodi `tar`,
`pacote`, `sigstore` i `minimatch`, a tablica gore `brace-expansion`, `cross-spawn`
i `glob`. To **nije proturječje**: oba su popisa djelomična (14 odnosno 5 od ukupno
20 nalaza, zajedno 19 od 20), jer svaki prikazuje retke čitljive u vlastitom ispisu.
Svi navedeni paketi pripadaju **istom stablu ovisnosti npm CLI-ja**, pa je i
zaključak identičan. Manje razlike u popisu očekivane su i zbog toga što je baza
ranjivosti između verzija 0.65.0 i 0.74.0 dopunjena.

### 3.3 POSLIJE — objavljena ojačana slika

```bash
trivy image --severity HIGH,CRITICAL --ignore-unfixed \
  ghcr.io/ikovacek95/ticketing-api:ad884f4fbd79f6b4ed9c424182f997229a48563b
```

**Rezultat: 0 ranjivosti.** Detektirani OS: `alpine 3.22.4`. Sve stavke u
`Report Summary` tablici — uključujući sve `node-pkg` ciljeve — imaju vrijednost 0.

Legenda samog Trivyja: `'0': Clean (no security findings detected)`.

### 3.4 Veza nalaza s korektivnim mjerama

| Sloj | Nalaza PRIJE | Korektivna mjera | Nalaza POSLIJE |
|------|-------------|------------------|----------------|
| `node-pkg` (npm CLI) | **20** (19 HIGH + **1 CRITICAL**) | `rm -rf` npm / npx / yarn u `runtime` stageu | **0** |
| Alpine OS (`libcrypto3`, `libssl3`) | **4** (HIGH) | `apk --no-cache upgrade` u `runtime` stageu | **0** |
| **Ukupno** | **24** | | **0** |

Ručno skeniranje time potvrđuje i **uzročnu vezu**, ne samo krajnje stanje:

- uklanjanje `npm`/`npx`/`yarn` eliminira **cijeli** `node-pkg` sloj nalaza —
  uključujući jedini **CRITICAL** u cijelom projektu;
- `apk --no-cache upgrade` rješava sva 4 preostala OpenSSL nalaza u OS sloju.

### 3.5 `trivy fs` — ovisnosti i tajne u repozitoriju

```bash
trivy fs --scanners vuln,secret --severity HIGH,CRITICAL .
```

| Target | Type | Ranjivosti | Tajne |
|--------|------|-----------|-------|
| `api/package-lock.json` | npm | **0** | – |
| `frontend/package-lock.json` | npm | **0** | – |
| `worker/package-lock.json` | npm | **0** | – |

**U repozitoriju nije pronađena nijedna tajna.** To neovisno potvrđuje nalaz
`gitleaks` skeniranja iz [§7](#7-nalazi-gitleaks--tajne-u-repozitoriju): jedine
detekcije su placeholderi (`change_me_local`, `REPLACE_ME_PRIJE_PRIMJENE`).

Nula ranjivosti u lockfileovima na razini HIGH/CRITICAL slaže se i s rezultatom
`npm audit`-a iz [§5](#5-nalazi-npm-audit-stvarni-rezultat-gate---audit-levelhigh)
— preostali nalazi su isključivo MEDIUM.

### 3.6 `trivy config` — Kubernetes manifesti

```bash
trivy config --severity HIGH,CRITICAL k8s/
```

Pronađeno konfiguracijskih datoteka: **11**. Sve imaju **0 misconfiguracija**:

| Manifest | Misconfiguracija |
|----------|------------------|
| `00-namespace.yaml` | 0 |
| `01-configmap.yaml` | 0 |
| `02-secret.example.yaml` | 0 |
| `03-rbac.yaml` | 0 |
| `04-postgres.yaml` | 0 |
| `05-redis.yaml` | 0 |
| `06-api.yaml` | 0 |
| `07-worker.yaml` | 0 |
| `08-frontend.yaml` | 0 |
| `09-ingress.yaml` | 0 |
| `10-networkpolicy.yaml` | 0 |

Rezultat je identičan onome iz CI pipelinea ([§6](#6-nalazi-trivy-config--kubernetes-manifesti)).

### 3.7 Zapažanje za daljnje smanjenje napadne površine

U ispisu skeniranja **finalne** slike i dalje su vidljivi ciljevi:

```
usr/local/lib/node_modules/corepack/package.json
opt/yarn-v1.22.22/package.json
```

Dakle `corepack` i direktorij `yarn-v1.22.22` **nisu potpuno uklonjeni** iz bazne
slike. Trenutno **ne nose nijednu ranjivost** (oba imaju 0 nalaza), pa ne utječu na
quality gate, ali predstavljaju nepotreban kod u produkcijskoj slici.

Mogući sljedeći koraci:

| Opcija | Učinak | Trošak |
|--------|--------|--------|
| Dopuniti `rm -rf` s `corepack` i `/opt/yarn-v*` | Uklanja preostale ostatke upravitelja paketima | Trivijalan; jedan redak u Containerfileu |
| Prelazak na **distroless** baznu sliku (npr. `gcr.io/distroless/nodejs20`) | Nema shella, package managera ni OS alata → drastično manja napadna površina | Gubi se `wget` za `HEALTHCHECK` i `sh` za dijagnostiku; treba prilagoditi probe |

Preporuka: prva opcija odmah (nema rizika), druga kao zaseban zadatak jer mijenja
način rada healthchecka i debugiranja.

---

## 4. Primijenjene korektivne mjere na razini slike

Sljedeće mjere ugrađene su u `*/Containerfile` i **prije** su prvog skeniranja —
one su razlog zašto je broj nalaza već na početku vrlo nizak:

| Mjera | Implementacija | Efekt |
|-------|----------------|-------|
| Minimalna bazna slika | `node:20.20-alpine3.22` umjesto `node:20` (Debian) | Drastično manja površina napada (nema `apt`, `perl`, `openssl` alata…) |
| Pinana verzija bazne slike | `20.20-alpine3.22`, ne `latest` | Reproducibilan build; nadogradnja je svjesna, verzionirana odluka |
| **Uklanjanje npm/npx/yarn iz runtimea** | `rm -rf /usr/local/lib/node_modules/npm …` u `runtime` stageu | **Uklonilo 20 nalaza (1 CRITICAL + 19 HIGH)** — vidi §2.1 |
| **Sigurnosne zakrpe OS-a** | `apk --no-cache upgrade` u `runtime` stageu | **Uklonilo 4 HIGH nalaza** (OpenSSL) — vidi §2.2 |
| Multi-stage build | `deps` → `runtime` | U finalnoj slici nema npm cachea, build alata ni devDependencies |
| Bez dev-ovisnosti u produkciji | `npm ci --omit=dev` | `nodemon` i njegovo stablo ovisnosti nisu u produkcijskoj slici |
| Determinističke ovisnosti | `package-lock.json` + `npm ci` | Nema "drifta" verzija između builda i skeniranja |
| Bez izvršavanja install skripti | `npm ci --ignore-scripts` | Blokira supply-chain napad kroz `postinstall` skripte |
| Non-root korisnik | `adduser -S -u 10001` + `USER 10001` | Kompromitirani proces nema root ovlasti u kontejneru |
| Ispravno vlasništvo datoteka | `COPY --chown=app:app` | Aplikacija ne može mijenjati vlastiti kod |
| Healthcheck | `HEALTHCHECK` (wget / pgrep) | Orkestrator uklanja "zombi" kontejnere iz prometa |
| Minimalan build kontekst | `.dockerignore` | `.env`, `.git` i `node_modules` nikad ne ulaze u slojeve slike |

> **Napomena o kompromisu:** `apk upgrade` znači da slika više nije bit-for-bit
> reproducibilna kroz vrijeme, jer povlači najnovije zakrpe u trenutku builda.
> Ocijenjeno je da je isporuka poznatih HIGH ranjivosti veći rizik od gubitka te
> razine reproducibilnosti. Reproducibilnost **aplikacijskog** sloja ostaje potpuna
> jer je pinana kroz `package-lock.json` i `npm ci`.

Ojačanja na razini izvođenja (Compose i Kubernetes):

| Mjera | Compose | Kubernetes |
|-------|---------|------------|
| Non-root | slika `USER 10001` | `runAsNonRoot: true`, `runAsUser: 10001` |
| Bez eskalacije privilegija | `no-new-privileges:true` | `allowPrivilegeEscalation: false` |
| Bez Linux capabilitiesa | `cap_drop: [ALL]` | `capabilities.drop: [ALL]` |
| Read-only rootfs | `read_only: true` + `tmpfs /tmp` | `readOnlyRootFilesystem: true` + `emptyDir /tmp` |
| Seccomp | Podman default profil | `seccompProfile: RuntimeDefault` |
| Odvojene tajne | `.env` (u `.gitignore`) | `Secret` + `envFrom.secretRef` |
| Mrežna segmentacija | zasebna `ticketing_net`, baza nije izložena | `NetworkPolicy` default-deny + bijele liste |
| Ograničenje resursa | — | `requests` / `limits` (CPU, memorija) |
| Bez pristupa K8s API-ju | — | `automountServiceAccountToken: false` + minimalni RBAC |
| Pod Security Admission | — | namespace `enforce: restricted` |

---

## 5. Nalazi `npm audit` (stvarni rezultat, gate `--audit-level=high`)

Snimljeno nad lockfileovima u repozitoriju:

| Servis | 🔴 CRITICAL | 🟠 HIGH | 🟡 MEDIUM | ⚪ LOW | Rezultat gatea |
|--------|------------|--------|----------|-------|----------------|
| `api` | 0 | 0 | 3 | 0 | ✅ prolazi |
| `frontend` | 0 | 0 | 2 | 0 | ✅ prolazi |
| `worker` | 0 | 0 | 0 | 0 | ✅ prolazi |

Detalji preostalih MEDIUM nalaza i odluka o riziku:

| # | Paket | Advisory | Ozbiljnost | Zahvaćeni servisi | Odluka | Obrazloženje |
|---|-------|----------|-----------|-------------------|--------|--------------|
| 1 | `qs` (tranzitivno kroz `express@4`) | [GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx) — array-limit bypass | 🟡 MEDIUM | `api`, `frontend` | **Prihvaćen rizik** | `express@4.22.2` (posljednji 4.x) pina `qs@6.15.3`. Ispravak zahtijeva prelazak na `express@5`, što je semver-major promjena i mijenja ponašanje aplikacije. Gate je na razini HIGH pa ne blokira isporuku. |
| 2 | `qs` (tranzitivno kroz `express@4`) | [GHSA-4mjr-xmp4-gh2g](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g) — DoS preko `isBuffer` | 🟡 MEDIUM | `api`, `frontend` | **Prihvaćen rizik** | Isto kao gore. Ublažavanje: `limits` na memoriju/CPU u Kubernetesu i 2 replike API-ja ograničavaju učinak DoS-a. |
| 3 | `uuid@10` | [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) — nedostaje provjera granica buffera u `v3/v5/v6` | 🟡 MEDIUM | `api` | **Prihvaćen rizik** | Aplikacija koristi isključivo `uuid.v4()` **bez** `buf` argumenta, pa ranjivi kod nikad nije dosegnut. Ispravak traži `uuid@14` (semver-major). |

**Plan ponovne procjene:** pri sljedećoj nadogradnji Expressa na 5.x nalazi 1 i 2
otpadaju. Naredba za provjeru stanja:

```bash
for SVC in api frontend worker; do
  echo "== ${SVC} =="; (cd "$SVC" && npm audit --audit-level=high && echo "GATE: PASS")
done
```

---

## 6. Nalazi `trivy config` — Kubernetes manifesti

Skenirano automatski u CI pipelineu (`trivy config --severity HIGH,CRITICAL k8s/`),
Trivy `0.65.0`:

```
Report Summary
│         Target         │    Type    │ Misconfigurations │
│ 00-namespace.yaml      │ kubernetes │         0         │
│ 01-configmap.yaml      │ kubernetes │         0         │
│ 02-secret.example.yaml │ kubernetes │         0         │
│ 03-rbac.yaml           │ kubernetes │         0         │
│ 04-postgres.yaml       │ kubernetes │         0         │
│ 05-redis.yaml          │ kubernetes │         0         │
│ 06-api.yaml            │ kubernetes │         0         │
│ 07-worker.yaml         │ kubernetes │         0         │
│ 08-frontend.yaml       │ kubernetes │         0         │
│ 09-ingress.yaml        │ kubernetes │         0         │
│ 10-networkpolicy.yaml  │ kubernetes │         0         │
```

| # | Datoteka | Pravilo (ID) | Ozbiljnost | Opis | Odluka / korektivna mjera | Status |
|---|----------|--------------|-----------|------|---------------------------|--------|
| — | svi manifesti | — | — | **Nema nalaza na razini HIGH/CRITICAL** | Ojačanja su ugrađena od početka (vidi tablicu u §4) | ✅ čisto |

Nalazi niže ozbiljnosti (MEDIUM/LOW) ne blokiraju pipeline; prate se kroz SARIF
izvještaj u GitHub Security tabu.

Poznata odstupanja koja su **svjesna odluka**, a Trivy ih može prijaviti na nižim razinama:

| Nalaz | Objekt | Obrazloženje |
|-------|--------|--------------|
| `runAsUser` nije 10001 | `postgres` (UID 70), `redis` (UID 999) | Službene slike sadrže vlastite sistemske korisnike; prisilni UID 10001 spriječio bi inicijalizaciju baze. Svi ostali kontrolni mehanizmi (`runAsNonRoot`, `drop ALL`, `seccomp`, `readOnlyRootFilesystem`) su primijenjeni. |
| Korištenje taga `latest` | `api`, `worker`, `frontend` | Vrijedi **isključivo** za prvo podizanje u labosu. Prema politici iz poglavlja 8, produkcijski deployment koristi `<git-sha>` (`kubectl set image`). |
| Nema `NetworkPolicy` za egress | svi podovi | Egress je namjerno otvoren kako bi DNS i povlačenje slika radili bez dodatnih pravila; segmentacija je izvedena na ulaznoj strani. |

---

## 7. Nalazi `gitleaks` — tajne u repozitoriju

| # | Datoteka | Pravilo | Nalaz | Ocjena | Mjera |
|---|----------|---------|-------|--------|-------|
| 1 | `.env.example` | generic-password | `POSTGRES_PASSWORD=change_me_local` | Lažni pozitiv (placeholder) | Nema stvarne vrijednosti; `.env` je u `.gitignore` |
| 2 | `k8s/02-secret.example.yaml` | generic-password | `REPLACE_ME_PRIJE_PRIMJENE` | Lažni pozitiv (placeholder) | Stvarni Secret se kreira s `kubectl create secret` |
| 3 | `docs/security/image-scan-report.md` | `generic-api-key` | 40-znakovni git SHA u primjeru `ghcr.io/…/ticketing-api:<sha>` (entropija 3.96) | **Lažni pozitiv** — javni identifikator commita, nije tajna | Usko ciljan allowlist u `.gitleaks.toml` (regex vezan uz ime slike ovog projekta, bez izuzimanja cijele datoteke) |

### 7.1 Upravljanje lažnim pozitivima

Konfiguracija `.gitleaks.toml` zadržava **sva** ugrađena pravila
(`[extend] useDefault = true`) i dodaje samo usko ciljanu iznimku:

```toml
[allowlist]
regexTarget = "line"
regexes = [
  '''ghcr\.io/ikovacek95/ticketing-(api|frontend|worker):[0-9a-f]{7,40}''',
]
```

Namjerno se **ne** izuzimaju cijele datoteke ni direktoriji — da netko u istu
datoteku doda stvarnu tajnu, gitleaks bi je i dalje prijavio. Svaka iznimka mora
imati zapisano obrazloženje u tablici iznad.

Kontrole koje sprječavaju curenje tajni:

- `.gitignore` isključuje `.env`, `*.pem`, `*.key`, `kubeconfig` i `k8s/02-secret.yaml`
- `.dockerignore` isključuje `.env` iz build konteksta svake slike
- U repozitoriju **nema nijedne stvarne lozinke** — samo placeholderi
- `gitleaks` u CI-ju skenira **povijest commitova**, a ne samo radno stablo
  (`fetch-depth: 0`). Kod `push` i `pull_request` događaja skenira se raspon
  commitova koje promjena uvodi (`<base>^..<head>`); ručnim pokretanjem
  (`workflow_dispatch`) skenira se cijela povijest repozitorija.
- Tajne se u runtime ubacuju kroz `Secret` / `.env`, nikad kroz `ConfigMap` ni sliku

---

## 8. Politika taggiranja i objave slika

Ova politika je **obvezujuća** i implementirana je u `.github/workflows/ci.yml`.

### 8.1 Shema taggiranja

| Tag | Kada se stvara | Nepromjenjiv? | Dozvoljen u produkciji? | Namjena |
|-----|----------------|---------------|-------------------------|---------|
| `<git-sha>` (puni 40-znakovni SHA) | svaki uspješan build s `main` | **Da** | **Da — jedini preporučeni** | Jednoznačna sljedivost slike do točnog commita |
| `vMAJOR.MINOR.PATCH` (SemVer) | ručno, iz git taga izdanja | **Da** | Da | Službena izdanja i rollback na poznatu verziju |
| `latest` | svaki uspješan build s `main` | Ne | **NE** | Isključivo lokalni razvoj i demonstracije |
| `pr-<broj>` | build iz pull requesta | Ne | **NE** | Kratkotrajna provjera; ne objavljuje se u GHCR |

### 8.2 Zašto `latest` nikad ne ide u produkciju

1. **Nije nepromjenjiv** — isti tag pokazuje na različit sadržaj kroz vrijeme, pa dvije replike istog Deploymenta mogu vrtjeti različit kod.
2. **Onemogućuje rollback** — nema prethodne verzije na koju bi se `rollout undo` vratio jer sve revizije referenciraju isti tag.
3. **Ruši sljedivost** — iz oznake se ne može utvrditi koji je commit isporučen, što onemogućuje forenziku nakon incidenta.
4. **Zaobilazi skeniranje** — slika skenirana jučer nije nužno ista koja se povlači danas.

Ispravan postupak isporuke:

```bash
kubectl -n ticketing set image deployment/api \
  api=ghcr.io/ikovacek95/ticketing-api:1f4a9c7e2b8d5a3f6c0e9b1d7a4f8c2e5b3d6a90
kubectl -n ticketing rollout status deployment/api --timeout=180s
```

### 8.3 Pravila objave (quality gate)

Slika se objavljuje u `ghcr.io` **samo ako su ispunjeni SVI uvjeti**:

1. `npm ci` uspješan i `node --check` prolazi za sve `.js` datoteke
2. `npm audit --audit-level=high` bez HIGH/CRITICAL nalaza
3. `gitleaks` ne pronalazi tajne u rasponu commitova koje promjena uvodi
4. `hadolint` prolazi na sva tri Containerfilea (prag: `warning`)
5. **`trivy image --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1` prolazi**
6. Grana je `main` (ne pull request, ne feature grana)

Redoslijed u pipelineu je namjeran: **build → skeniranje → (gate) → push**.
Ranjiva slika nikad ne dolazi do registryja.

### 8.4 Postupanje s nalazima

| Ozbiljnost | Postoji ispravak | Postupak | Rok |
|-----------|------------------|----------|-----|
| 🔴 CRITICAL | da | Pipeline pada; obavezna nadogradnja bazne slike ili ovisnosti | odmah, blokira isporuku |
| 🟠 HIGH | da | Pipeline pada; nadogradnja ili dokumentirana iznimka uz odobrenje | odmah, blokira isporuku |
| 🔴/🟠 | ne (`unfixed`) | `--ignore-unfixed` propušta; nalaz se evidentira u ovom dokumentu i prati | ponovna procjena pri svakoj nadogradnji |
| 🟡 MEDIUM | bilo koji | Ne blokira; evidentira se u poglavlju 5/6 s obrazloženjem | sljedeći planirani ciklus nadogradnje |
| ⚪ LOW | bilo koji | Samo evidencija u SARIF izvještaju (Security tab) | po potrebi |

Vremenska iznimka (`--ignore-unfixed`, "prihvaćen rizik") mora imati: opis nalaza,
obrazloženje zašto nije iskoristiv, kompenzacijsku kontrolu i datum ponovne procjene.

### 8.5 Vidljivost i pristup registryju

- Paketi u GHCR-u su **javni** (`read` bez autentikacije) ili se pristupa preko `imagePullSecret`
- Push u GHCR koristi **`GITHUB_TOKEN`** s `packages: write` — nema dugotrajnih PAT-ova u tajnama
- Ovlasti workflowa su minimalne: `contents: read`, `packages: write`, `security-events: write`
- Svi nalazi (image + IaC) šalju se kao SARIF u **GitHub Security tab** radi trajne evidencije

---

## 9. Zaključak

| Kontrola | Status |
|----------|--------|
| Reproducibilan build (lockfile + `npm ci`) | ✅ |
| Minimalna, pinana bazna slika | ✅ |
| Runtime bez npm/npx/yarn | ✅ |
| Sigurnosne zakrpe OS paketa (`apk upgrade`) | ✅ |
| Non-root izvođenje (UID 10001) | ✅ |
| Read-only rootfs, bez capabilitiesa, bez eskalacije privilegija | ✅ |
| Tajne odvojene od koda i slike | ✅ |
| Skeniranje ovisnosti (`npm audit`, gate HIGH) | ✅ |
| Skeniranje tajni (`gitleaks`, povijest commitova) | ✅ |
| Skeniranje Containerfilea (`hadolint`) | ✅ |
| Skeniranje slika (`trivy image`, gate HIGH/CRITICAL) | ✅ |
| Skeniranje IaC-a (`trivy config k8s/`) | ✅ |
| Mrežna segmentacija (`NetworkPolicy` default-deny) | ✅ |
| RBAC s najmanjim privilegijama | ✅ |
| Politika taggiranja i objave | ✅ |
| **Neovisna ručna verifikacija nalaza** (Trivy 0.74.0, CentOS Stream 9) | ✅ |

**Završno stanje slika:** 🔴 0 CRITICAL, 🟠 0 HIGH (uz `--ignore-unfixed`).
Pipeline je zelen na sva tri servisa.

**Dvostruka potvrda.** Rezultati su izmjereni dvaput, neovisno:

| Izvor | Alat | PRIJE | POSLIJE |
|-------|------|-------|---------|
| CI pipeline (2026-09-08) | Trivy 0.65.0 | 24 (1 CRITICAL + 23 HIGH) | 0 |
| Ručno, CentOS Stream 9 (2026-09-12) | Trivy 0.74.0 | 24 (1 CRITICAL + 23 HIGH) | 0 |

Različiti strojevi, različite verzije alata i različiti trenuci — **identičan
rezultat**. Ručna je provjera k tome reproducibilna u bilo kojem trenutku jer
uspoređuje dvije trajno dostupne slike (vidi [§3.1](#31-zašto-je-ova-usporedba-metodološki-jaka)).

**Preostali rizici:**

| Rizik | Ozbiljnost | Ublažavanje |
|-------|-----------|-------------|
| `qs` (kroz `express@4`), `uuid@10` | 🟡 MEDIUM | Prihvaćen rizik, dokumentiran u §5; ne blokira gate na razini HIGH |
| Nove ranjivosti bez dostupnog ispravka | varira | `--ignore-unfixed` ih propušta; prate se kroz SARIF u Security tabu i procjenjuju pri svakoj nadogradnji |
| Ranjivosti objavljene nakon zadnjeg builda | varira | Ponovni build i skeniranje pri svakom pushu na `main`; preporuka je periodično ponovno izgraditi slike i bez promjene koda |
| Gubitak bit-for-bit reproducibilnosti OS sloja | ⚪ LOW | Svjestan kompromis (vidi §4); aplikacijski sloj ostaje pinan |
| Ostaci `corepack` i `/opt/yarn-v1.22.22` u finalnoj slici | ⚪ LOW | Trenutno **bez ijedne ranjivosti**; nepotreban kod u produkciji. Plan smanjenja napadne površine u [§3.7](#37-zapažanje-za-daljnje-smanjenje-napadne-površine) |

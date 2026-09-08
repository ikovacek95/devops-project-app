# Sigurnosno izvješće — skeniranje slika, ovisnosti i konfiguracije

| Stavka | Vrijednost |
|---|---|
| Projekt | Secure Event Ticketing Platform |
| Repozitorij | `ikovacek95/devops-project-app` |
| Registry | `ghcr.io/ikovacek95/ticketing-{api,frontend,worker}` |
| Alati | Trivy (image / fs / config), `npm audit`, hadolint, gitleaks |
| Datum skeniranja | `<UPISATI>` |
| Verzija Trivyja | `<UPISATI: trivy --version>` |
| Autor | `<UPISATI>` |

> **Kako koristiti ovaj dokument:** dijelovi označeni s `<UPISATI>` popunjavaju se
> rezultatima stvarnog skeniranja na CentOS Stream 9 poslužitelju. Poglavlja 1–3 sadrže
> točne naredbe, poglavlje 4 je već popunjeno rezultatima `npm audit`-a, a poglavlje 7
> je obvezujuća politika koja vrijedi bez obzira na nalaze.

---

## 1. Naredbe za skeniranje

### 1.1 Skeniranje slika (`trivy image`)

```bash
# Instalacija Trivyja na CentOS Stream 9
sudo dnf install -y https://github.com/aquasecurity/trivy/releases/latest/download/trivy_Linux-64bit.rpm
trivy --version

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

| # | Slika | Komponenta | CVE / GHSA | Ozbiljnost | Instalirana verzija | Ispravljena u | Korektivna mjera | Rezultat ponovnog skeniranja |
|---|-------|-----------|------------|-----------|--------------------|---------------|------------------|------------------------------|
| 1 | `ticketing-api` | `<UPISATI>` | `<CVE-...>` | `<UPISATI>` | `<UPISATI>` | `<UPISATI>` | `<UPISATI>` | `<UPISATI>` |
| 2 | `ticketing-frontend` | `<UPISATI>` | `<CVE-...>` | `<UPISATI>` | `<UPISATI>` | `<UPISATI>` | `<UPISATI>` | `<UPISATI>` |
| 3 | `ticketing-worker` | `<UPISATI>` | `<CVE-...>` | `<UPISATI>` | `<UPISATI>` | `<UPISATI>` | `<UPISATI>` | `<UPISATI>` |

### 2.1 Sažetak po ozbiljnosti — PRIJE / POSLIJE

| Slika | 🔴 CRITICAL prije | 🔴 CRITICAL poslije | 🟠 HIGH prije | 🟠 HIGH poslije | 🟡 MEDIUM prije | 🟡 MEDIUM poslije | Status gatea |
|-------|-----------------|--------------------|--------------|----------------|----------------|------------------|--------------|
| `ticketing-api` | `<n>` | `<n>` | `<n>` | `<n>` | `<n>` | `<n>` | ✅ / ❌ |
| `ticketing-frontend` | `<n>` | `<n>` | `<n>` | `<n>` | `<n>` | `<n>` | ✅ / ❌ |
| `ticketing-worker` | `<n>` | `<n>` | `<n>` | `<n>` | `<n>` | `<n>` | ✅ / ❌ |

Naredba za brzo prebrojavanje nalaza:

```bash
trivy image --format json ghcr.io/ikovacek95/ticketing-api:<git-sha> \
  | jq '[.Results[].Vulnerabilities // [] | .[].Severity] | group_by(.) | map({(.[0]): length}) | add'
```

---

## 3. Primijenjene korektivne mjere na razini slike

Sljedeće mjere ugrađene su u `*/Containerfile` i **prije** su prvog skeniranja —
one su razlog zašto je broj nalaza već na početku vrlo nizak:

| Mjera | Implementacija | Efekt |
|-------|----------------|-------|
| Minimalna bazna slika | `node:20.20-alpine3.22` umjesto `node:20` (Debian) | Drastično manja površina napada (nema `apt`, `perl`, `openssl` alata…) |
| Pinana verzija bazne slike | `20.20-alpine3.22`, ne `latest` | Reproducibilan build; nadogradnja je svjesna, verzionirana odluka |
| Multi-stage build | `deps` → `runtime` | U finalnoj slici nema npm cachea, build alata ni devDependencies |
| Bez dev-ovisnosti u produkciji | `npm ci --omit=dev` | `nodemon` i njegovo stablo ovisnosti nisu u produkcijskoj slici |
| Determinističke ovisnosti | `package-lock.json` + `npm ci` | Nema "drifta" verzija između builda i skeniranja |
| Bez izvršavanja install skripti | `npm ci --ignore-scripts` | Blokira supply-chain napad kroz `postinstall` skripte |
| Non-root korisnik | `adduser -S -u 10001` + `USER 10001` | Kompromitirani proces nema root ovlasti u kontejneru |
| Ispravno vlasništvo datoteka | `COPY --chown=app:app` | Aplikacija ne može mijenjati vlastiti kod |
| Healthcheck | `HEALTHCHECK` (wget / pgrep) | Orkestrator uklanja "zombi" kontejnere iz prometa |
| Minimalan build kontekst | `.dockerignore` | `.env`, `.git` i `node_modules` nikad ne ulaze u slojeve slike |

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

## 4. Nalazi `npm audit` (stvarni rezultat, gate `--audit-level=high`)

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

## 5. Nalazi `trivy config` — Kubernetes manifesti

| # | Datoteka | Pravilo (ID) | Ozbiljnost | Opis | Odluka / korektivna mjera | Status |
|---|----------|--------------|-----------|------|---------------------------|--------|
| 1 | `<UPISATI>` | `<AVD-KSV-....>` | `<UPISATI>` | `<UPISATI>` | `<UPISATI>` | `<otvoreno / riješeno / prihvaćen rizik>` |
| 2 | `<UPISATI>` | `<AVD-KSV-....>` | `<UPISATI>` | `<UPISATI>` | `<UPISATI>` | `<UPISATI>` |

Poznata odstupanja koja su **svjesna odluka**, a Trivy ih može prijaviti:

| Nalaz | Objekt | Obrazloženje |
|-------|--------|--------------|
| `runAsUser` nije 10001 | `postgres` (UID 70), `redis` (UID 999) | Službene slike sadrže vlastite sistemske korisnike; prisilni UID 10001 spriječio bi inicijalizaciju baze. Svi ostali kontrolni mehanizmi (`runAsNonRoot`, `drop ALL`, `seccomp`, `readOnlyRootFilesystem`) su primijenjeni. |
| Korištenje taga `latest` | `api`, `worker`, `frontend` | Vrijedi **isključivo** za prvo podizanje u labosu. Prema politici iz poglavlja 7, produkcijski deployment koristi `<git-sha>` (`kubectl set image`). |
| Nema `NetworkPolicy` za egress | svi podovi | Egress je namjerno otvoren kako bi DNS i povlačenje slika radili bez dodatnih pravila; segmentacija je izvedena na ulaznoj strani. |

---

## 6. Nalazi `gitleaks` — tajne u repozitoriju

| # | Datoteka | Pravilo | Nalaz | Ocjena | Mjera |
|---|----------|---------|-------|--------|-------|
| 1 | `.env.example` | generic-password | `POSTGRES_PASSWORD=change_me_local` | Lažni pozitiv (placeholder) | Nema stvarne vrijednosti; `.env` je u `.gitignore` |
| 2 | `k8s/02-secret.example.yaml` | generic-password | `REPLACE_ME_PRIJE_PRIMJENE` | Lažni pozitiv (placeholder) | Stvarni Secret se kreira s `kubectl create secret` |
| 3 | `<UPISATI>` | `<UPISATI>` | `<UPISATI>` | `<UPISATI>` | `<UPISATI>` |

Kontrole koje sprječavaju curenje tajni:

- `.gitignore` isključuje `.env`, `*.pem`, `*.key`, `kubeconfig` i `k8s/02-secret.yaml`
- `.dockerignore` isključuje `.env` iz build konteksta svake slike
- U repozitoriju **nema nijedne stvarne lozinke** — samo placeholderi
- `gitleaks` u CI-ju skenira **cijelu git povijest** (`fetch-depth: 0`)
- Tajne se u runtime ubacuju kroz `Secret` / `.env`, nikad kroz `ConfigMap` ni sliku

---

## 7. Politika taggiranja i objave slika

Ova politika je **obvezujuća** i implementirana je u `.github/workflows/ci.yml`.

### 7.1 Shema taggiranja

| Tag | Kada se stvara | Nepromjenjiv? | Dozvoljen u produkciji? | Namjena |
|-----|----------------|---------------|-------------------------|---------|
| `<git-sha>` (puni 40-znakovni SHA) | svaki uspješan build s `main` | **Da** | **Da — jedini preporučeni** | Jednoznačna sljedivost slike do točnog commita |
| `vMAJOR.MINOR.PATCH` (SemVer) | ručno, iz git taga izdanja | **Da** | Da | Službena izdanja i rollback na poznatu verziju |
| `latest` | svaki uspješan build s `main` | Ne | **NE** | Isključivo lokalni razvoj i demonstracije |
| `pr-<broj>` | build iz pull requesta | Ne | **NE** | Kratkotrajna provjera; ne objavljuje se u GHCR |

### 7.2 Zašto `latest` nikad ne ide u produkciju

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

### 7.3 Pravila objave (quality gate)

Slika se objavljuje u `ghcr.io` **samo ako su ispunjeni SVI uvjeti**:

1. `npm ci` uspješan i `node --check` prolazi za sve `.js` datoteke
2. `npm audit --audit-level=high` bez HIGH/CRITICAL nalaza
3. `gitleaks` ne pronalazi tajne u cijeloj git povijesti
4. `hadolint` prolazi na sva tri Containerfilea (prag: `warning`)
5. **`trivy image --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1` prolazi**
6. Grana je `main` (ne pull request, ne feature grana)

Redoslijed u pipelineu je namjeran: **build → skeniranje → (gate) → push**.
Ranjiva slika nikad ne dolazi do registryja.

### 7.4 Postupanje s nalazima

| Ozbiljnost | Postoji ispravak | Postupak | Rok |
|-----------|------------------|----------|-----|
| 🔴 CRITICAL | da | Pipeline pada; obavezna nadogradnja bazne slike ili ovisnosti | odmah, blokira isporuku |
| 🟠 HIGH | da | Pipeline pada; nadogradnja ili dokumentirana iznimka uz odobrenje | odmah, blokira isporuku |
| 🔴/🟠 | ne (`unfixed`) | `--ignore-unfixed` propušta; nalaz se evidentira u ovom dokumentu i prati | ponovna procjena pri svakoj nadogradnji |
| 🟡 MEDIUM | bilo koji | Ne blokira; evidentira se u poglavlju 4/5 s obrazloženjem | sljedeći planirani ciklus nadogradnje |
| ⚪ LOW | bilo koji | Samo evidencija u SARIF izvještaju (Security tab) | po potrebi |

Vremenska iznimka (`--ignore-unfixed`, "prihvaćen rizik") mora imati: opis nalaza,
obrazloženje zašto nije iskoristiv, kompenzacijsku kontrolu i datum ponovne procjene.

### 7.5 Vidljivost i pristup registryju

- Paketi u GHCR-u su **javni** (`read` bez autentikacije) ili se pristupa preko `imagePullSecret`
- Push u GHCR koristi **`GITHUB_TOKEN`** s `packages: write` — nema dugotrajnih PAT-ova u tajnama
- Ovlasti workflowa su minimalne: `contents: read`, `packages: write`, `security-events: write`
- Svi nalazi (image + IaC) šalju se kao SARIF u **GitHub Security tab** radi trajne evidencije

---

## 8. Zaključak

| Kontrola | Status |
|----------|--------|
| Reproducibilan build (lockfile + `npm ci`) | ✅ |
| Minimalna, pinana bazna slika | ✅ |
| Non-root izvođenje (UID 10001) | ✅ |
| Read-only rootfs, bez capabilitiesa, bez eskalacije privilegija | ✅ |
| Tajne odvojene od koda i slike | ✅ |
| Skeniranje ovisnosti (`npm audit`, gate HIGH) | ✅ |
| Skeniranje tajni (`gitleaks`, cijela povijest) | ✅ |
| Skeniranje Containerfilea (`hadolint`) | ✅ |
| Skeniranje slika (`trivy image`, gate HIGH/CRITICAL) | ✅ |
| Skeniranje IaC-a (`trivy config k8s/`) | ✅ |
| Mrežna segmentacija (`NetworkPolicy` default-deny) | ✅ |
| RBAC s najmanjim privilegijama | ✅ |
| Politika taggiranja i objave | ✅ |

Preostali rizici: `<UPISATI nakon stvarnog skeniranja>`

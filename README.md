# Employee Onboarding Platform

> A cloud-native, three-tier employee onboarding and candidate screening system built on Amazon EKS, deployed through a fully automated, security-gated CI/CD pipeline.

| | |
|---|---|
| **Frontend** | React 18 + Vite, served by nginx |
| **Backend** | Node.js + Express REST API |
| **Database** | Amazon RDS PostgreSQL 16 — Multi-AZ, encrypted |
| **Runtime** | Amazon EKS 1.31 — `us-east-1` |
| **Infrastructure** | Terraform (`terraform-aws-modules`) |
| **CI/CD** | GitHub Actions — OIDC-authenticated, no stored keys |
| **Secrets** | AWS Secrets Manager + External Secrets Operator |
| **Registry** | Amazon ECR — immutable tags, scan-on-push |
| **GitOps** | ArgoCD — manual sync, running alongside GitHub Actions CD |
| **Observability** | Prometheus + Grafana + CloudWatch exporter — admin-bootstrapped, outside CI/CD's reach |

---

## Table of Contents

- [Architecture](#architecture)
- [Application Design](#application-design)
- [Data Flow](#data-flow)
- [Networking](#networking)
- [Security](#security)
- [Observability](#observability)
- [CI/CD Pipeline](#cicd-pipeline)
- [GitOps — ArgoCD](#gitops--argocd)
- [Repository Structure](#repository-structure)
- [Deployment](#deployment)
- [Known Gaps](#known-gaps)

---

## Architecture

The platform follows a strict three-tier architecture. The browser never communicates directly with the backend — all traffic enters through a single internet-facing ALB, which routes to the frontend. The frontend proxies API calls to the backend, and only the backend holds a database connection.

```mermaid
flowchart TB
    User((Browser))

    subgraph AWS["AWS · us-east-1"]
        ALB["Internet-facing ALB\n(AWS Load Balancer Controller)"]

        subgraph EKS["EKS Cluster · onboarding namespace"]
            FE["frontend Deployment\nnginx · 2 replicas"]
            BE["backend Deployment\nExpress · 2 replicas"]
            ESO["External Secrets Operator"]
            K8SSEC[("db-credentials\nKubernetes Secret")]
        end

        subgraph MON["EKS Cluster · monitoring namespace"]
            Prom["Prometheus\n30s scrape interval"]
            Graf["Grafana\n/grafana"]
            CWE["CloudWatch Exporter"]
        end

        RDS[("RDS PostgreSQL 16\nMulti-AZ · Encrypted")]
        SM[("Secrets Manager\ndb-credentials · grafana-admin")]
        ECR[("ECR\nbackend + frontend images")]
        S3[("S3\ndocuments + assets")]
        CW[("Amazon CloudWatch\nRDS · ALB · EKS metrics")]
        KMS{{"KMS\ncustomer-managed key"}}
    end

    User -- HTTPS --> ALB
    ALB -- "path: /" --> FE
    ALB -- "path: /api" --> BE
    ALB -- "path: /grafana" --> Graf
    FE -- "proxy_pass /api" --> BE
    BE -- "TLS · port 5432" --> RDS
    BE -- "PutObject" --> S3
    ESO -- "GetSecretValue" --> SM
    ESO -- "sync" --> K8SSEC
    K8SSEC -.env vars.-> BE
    Prom -- "scrape :3000/metrics" --> BE
    Prom -- "scrape kubelet/cAdvisor" --> EKS
    Prom -- "scrape :9106/metrics" --> CWE
    CWE -- "GetMetricData (IRSA)" --> CW
    Graf -- "query" --> Prom
    SM -.KMS-encrypted.-> KMS
    RDS -.KMS-encrypted.-> KMS
    ECR -.KMS-encrypted.-> KMS
    S3 -.KMS-encrypted.-> KMS
    ECR -.image pull.-> FE
    ECR -.image pull.-> BE
```

| Component | File | Responsibility |
|---|---|---|
| **ALB Ingress** | `k8s/ingress.yaml` | Single internet-facing entry point; path-based routing to frontend, backend, and Grafana |
| **Frontend** | `frontend/` | React SPA compiled by Vite, served by nginx; proxies `/api/*` to backend |
| **Backend** | `backend/` | Stateless Express REST API; sole component with a database connection; exposes `/metrics` |
| **RDS PostgreSQL** | `terraform/main.tf` | System of record — `candidates` and `employees` tables; Multi-AZ, encrypted at rest |
| **External Secrets Operator** | `k8s/external-secrets.yaml` | Syncs DB credentials from Secrets Manager into a Kubernetes Secret every hour |
| **ECR** | `terraform/main.tf` | Immutable, KMS-encrypted image registry with scan-on-push for both services |
| **S3** | `terraform/main.tf` | Document and asset storage; versioned, KMS-encrypted, no public access |
| **KMS** | `terraform/security.tf` | Single customer-managed key with auto-rotation encrypting all data stores |
| **Prometheus** | `k8s/monitoring/prometheus/` | Scrapes EKS nodes, pods, backend app metrics, and CloudWatch exporter — 30s interval |
| **Grafana** | `k8s/monitoring/grafana/` | Dashboards at `/grafana`; datasource and dashboards auto-provisioned from ConfigMaps |
| **CloudWatch Exporter** | `k8s/monitoring/cloudwatch-exporter/` | Bridges RDS, ALB, and EKS CloudWatch metrics into Prometheus format via IRSA |

---

## Application Design

### Frontend — `frontend/`

- React 18 SPA built with Vite; two views — **Candidates** (hiring and screening) and **Employees** (onboarding tracking)
- All API calls use relative `/api/*` paths — the browser never holds a backend address
- Served by nginx on port 80; `nginx.conf` handles SPA fallback routing (`try_files $uri /index.html`) and reverse-proxies `/api` to `backend-svc.onboarding.svc.cluster.local`
- **Container:** multi-stage build — `node:20-alpine` compiles the Vite bundle, `nginx:1.27-alpine` serves it; runs as non-root UID 101, read-only root filesystem, all Linux capabilities dropped

### Backend — `backend/`

- Express REST API on port 3000; stateless — any replica can serve any request
- Exposes `/metrics` endpoint via `prom-client` — HTTP request counter, duration histogram, and default Node.js runtime metrics
- **Routes:**

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/candidates` | List all candidates, newest first |
| `POST` | `/api/candidates` | Add a new candidate |
| `PATCH` | `/api/candidates/:id/status` | Update candidate status (`pending` / `approved` / `rejected`) |
| `GET` | `/api/employees` | List all onboarded employees |
| `POST` | `/api/employees` | Add a new employee |
| `GET` | `/metrics` | Prometheus metrics scrape endpoint |

- Connects to PostgreSQL via `pg.Pool`; creates its own tables on boot (`CREATE TABLE IF NOT EXISTS`) — no separate migration step
- DB credentials injected as environment variables from the Kubernetes Secret managed by External Secrets Operator
- **Container:** multi-stage build — `node:20-alpine` installs production dependencies, `gcr.io/distroless/nodejs20-debian12` runs the app — no shell, no package manager, minimal attack surface

### Database — Amazon RDS PostgreSQL 16

- `db.t3.micro`, Multi-AZ standby in `us-east-1b`, private subnets only
- Storage encrypted with the project KMS key; IAM database authentication enabled; deletion protection on
- Custom parameter group: `log_statement = all`, `log_min_duration_statement = 1000ms`
- Enhanced monitoring (60s interval) and Performance Insights enabled, both KMS-encrypted
- Automated minor version upgrades enabled; tags copied to all snapshots

---

## Data Flow

### Page Load and API Call — End to End

```mermaid
sequenceDiagram
    participant U as Browser
    participant ALB as ALB
    participant FE as Frontend (nginx)
    participant BE as Backend (Express)
    participant DB as RDS PostgreSQL

    U->>ALB: GET /
    ALB->>FE: forward (path /)
    FE-->>U: React SPA (HTML + JS + CSS)

    U->>ALB: GET /api/candidates
    ALB->>FE: forward (path /api)
    FE->>BE: proxy_pass → backend-svc:80
    BE->>DB: SELECT * FROM candidates (TLS, port 5432)
    DB-->>BE: result rows
    BE-->>FE: 200 OK — JSON array
    FE-->>U: renders candidate table
```

### Secrets Flow — No Human Ever Holds the Password

```mermaid
sequenceDiagram
    participant TF as Terraform
    participant SM as Secrets Manager
    participant ESO as External Secrets Operator
    participant K8S as Kubernetes Secret
    participant BE as Backend Pod

    TF->>SM: create onboarding/db-credentials (KMS-encrypted)

    loop Every 1 hour
        ESO->>SM: GetSecretValue (IRSA — scoped to this secret only)
        SM-->>ESO: username / password / host / dbname
        ESO->>K8S: write db-credentials Secret
    end

    K8S-->>BE: injected as env vars at pod start
    note over BE: DB_USER, DB_PASS, DB_HOST, DB_NAME
```

### Observability Data Flow

```mermaid
sequenceDiagram
    participant BE as Backend Pod
    participant KUB as kubelet / cAdvisor
    participant Prom as Prometheus
    participant CWE as CloudWatch Exporter
    participant CW as Amazon CloudWatch
    participant Graf as Grafana
    participant U as Engineer

    loop Every 30s
        Prom->>BE: GET /metrics (HTTP request rate, latency, errors)
        Prom->>KUB: GET /metrics/cadvisor (CPU, memory, disk per container)
        Prom->>CWE: GET :9106/metrics
        CWE->>CW: GetMetricData (RDS, ALB, EKS via IRSA)
        CW-->>CWE: metric data points
        CWE-->>Prom: CloudWatch metrics in Prometheus format
    end

    U->>Graf: open dashboard
    Graf->>Prom: PromQL query
    Prom-->>Graf: time-series data
    Graf-->>U: rendered panels
```

### CI/CD Deployment Flow

```mermaid
sequenceDiagram
    participant Dev as Developer
    participant GH as GitHub
    participant CI as CI Workflow
    participant CD as CD Workflow
    participant ECR as Amazon ECR
    participant EKS as Amazon EKS

    Dev->>GH: git push → main
    GH->>CI: trigger CI workflow
    CI->>CI: npm audit (backend + frontend)
    CI->>CI: Checkov (Terraform + K8s)
    CI->>CI: Trivy image scan (CRITICAL/HIGH gate)
    CI->>CI: Gitleaks secret scan
    CI-->>GH: all checks pass

    GH->>CD: trigger CD workflow
    CD->>ECR: docker build + push (tagged with git SHA)
    CD->>ECR: wait for scan-on-push result
    ECR-->>CD: no CRITICAL findings
    CD->>EKS: kubectl set image (staging)
    CD->>CD: kubectl rollout status — wait 120s
    CD-->>GH: staging deploy complete

    note over CD,EKS: Manual approval required for production
    CD->>EKS: kubectl set image (production)
    CD->>CD: kubectl rollout status — wait 120s
```

---

## Networking

```mermaid
flowchart TB
    Internet((Internet)) --- IGW["Internet Gateway"]

    subgraph VPC["VPC · 10.0.0.0/16"]
        subgraph AZa["us-east-1a"]
            PubA["Public Subnet\n10.0.101.0/24"]
            PrivA["Private Subnet\n10.0.1.0/24\nEKS nodes · RDS primary"]
        end
        subgraph AZb["us-east-1b"]
            PubB["Public Subnet\n10.0.102.0/24"]
            PrivB["Private Subnet\n10.0.2.0/24\nEKS nodes · RDS standby"]
        end
        NAT["NAT Gateway\n(us-east-1a)"]
    end

    IGW --- PubA
    IGW --- PubB
    PubA -.-> ALB["ALB\n(internet-facing)"]
    PubB -.-> ALB
    PrivA -- egress --> NAT
    PrivB -- egress --> NAT
    NAT --- IGW
    ALB --> PrivA
    ALB --> PrivB
```

EKS worker nodes and the RDS instance live exclusively in the private subnets. There is no direct inbound route from the internet to any compute resource — the ALB is the sole ingress point, forwarding directly to pod IPs (`target-type: ip`).

### Security Groups

| Security Group | Inbound | Outbound |
|---|---|---|
| **RDS SG** | TCP 5432 from `10.0.0.0/16` (VPC only) | TCP 443 to `0.0.0.0/0` (AWS API calls) |
| **EKS Node SG** | Webhook ports (443, 4443, 6443, 8443, 9443, 10250) from cluster SG; DNS (53) and ephemeral ports (1025–65535) self-referencing | Default allow-all |

### Kubernetes NetworkPolicies — `k8s/network-policy.yaml`

| Policy | Selector | Effect |
|---|---|---|
| `backend-allow-frontend` | `app: backend` | Accepts ingress **only** from pods labeled `app: frontend` on port 3000 |
| `frontend-allow-ingress` | `app: frontend` | Accepts ingress only from `kube-system` namespace on port 80 |
| `backend-egress` | `app: backend` | Egress restricted to port 5432 (RDS), 443 (AWS APIs), 53/UDP (DNS) |

### ALB Ingress Routing

| Path | Namespace | Service | Target Port |
|---|---|---|---|
| `/api` | `onboarding` | `backend-svc:80` | backend pods `:3000` |
| `/` | `onboarding` | `frontend-svc:80` | frontend pods `:80` |
| `/grafana` | `monitoring` | `grafana:3000` | Grafana pods `:3000` |

```bash
# Get the live ALB addresses
kubectl get ingress onboarding-ingress -n onboarding
kubectl get ingress monitoring-ingress -n monitoring
```

---

## Security

Security is applied at every layer of the stack — from the developer's workstation to the running pod.

| Layer | Control |
|---|---|
| **AWS Credentials** | GitHub Actions authenticates via OIDC federation — no long-lived access keys stored anywhere |
| **IAM** | Least-privilege per workload: `github-actions-role` (ECR push + EKS describe), `external-secrets-role` (read one secret via IRSA), `cloudwatch-exporter-role` (read-only CloudWatch via IRSA), `rds-monitoring-role` (enhanced monitoring only) |
| **Secrets** | Never touch the pipeline or the image; synced directly from Secrets Manager into a Kubernetes Secret by External Secrets Operator every hour |
| **Container Runtime** | Both images run as non-root; backend uses distroless (no shell, no package manager); frontend uses nginx as UID 101; read-only root filesystem; all Linux capabilities dropped |
| **Network** | Default-deny Kubernetes NetworkPolicies scoped per tier; RDS accessible only from within the VPC |
| **Data at Rest** | RDS, S3, ECR, and Secrets Manager all encrypted with a single customer-managed KMS key (auto-rotation enabled) |
| **Data in Transit** | RDS enforces TLS-only connections via parameter group (`rds.force_ssl = 1`) |
| **Image Integrity** | ECR repositories use immutable tags — pushed images cannot be overwritten; scan-on-push enabled |
| **Availability** | RDS Multi-AZ standby; PodDisruptionBudgets (`minAvailable: 1`) on both Deployments; EKS node group spans two AZs |
| **CI Security Gates** | `npm audit`, Checkov (IaC), Trivy (container images), Gitleaks (secrets in git history) — any failure blocks the pipeline |

---

## Observability

Metrics live in a separate `monitoring` namespace, applied directly by a cluster admin rather than by CI/CD. This is a deliberate boundary — `github-actions-role` is scoped to the `onboarding` namespace only and cannot reach `monitoring` or any cluster-scoped resource. The role that deploys the app must not be able to grant itself cluster-wide access.

```mermaid
flowchart TB
    subgraph EKS["EKS Cluster"]
        subgraph ONB["onboarding namespace — CD-managed"]
            BEpods["backend pods\n/metrics"]
            FEpods["frontend pods"]
        end

        subgraph MON["monitoring namespace — admin-applied only"]
            Prom["Prometheus\n30s scrape interval"]
            CWE["cloudwatch-exporter\n:9106/metrics"]
            Graf["Grafana\nserved at /grafana"]
        end
    end

    CW[("Amazon CloudWatch\nRDS · ALB · EKS")]
    ALB2["ALB\n(monitoring-ingress)"]

    Prom -- "scrape :3000/metrics" --> BEpods
    Prom -- "scrape kubelet/cAdvisor" --> EKS
    Prom -- "scrape :9106/metrics" --> CWE
    CWE -- "GetMetricData (IRSA)" --> CW
    Graf -- "PromQL queries" --> Prom
    ALB2 -- "/grafana" --> Graf
```

### Grafana Dashboards

Three dashboards are auto-provisioned from ConfigMaps on startup — no manual setup required.

| Dashboard | Metrics Covered |
|---|---|
| **Platform — EKS Nodes & Pods** | Node CPU utilisation, node memory utilisation, pod restarts, pod CPU usage per container |
| **Application — Backend API** | HTTP request rate by route, 5xx error rate, p99 latency histogram, active DB connections |
| **CloudWatch — RDS & ALB** | RDS CPU, DB connections, free storage, read/write latency; ALB request count, 4xx/5xx errors, p99 response time, unhealthy host count |

### Prometheus Scrape Targets

| Job | Target | Metrics |
|---|---|---|
| `kubernetes-nodes` | kubelet HTTPS on each node | Node CPU, memory, disk, network |
| `kubernetes-cadvisor` | cAdvisor on each node | Per-container CPU, memory, filesystem |
| `kubernetes-pods` | Any pod with `prometheus.io/scrape: "true"` | Application-defined metrics |
| `onboarding-backend` | `backend-svc:80/metrics` | HTTP request count, duration histogram, Node.js runtime |
| `cloudwatch-exporter` | `cloudwatch-exporter:9106` | RDS, ALB, EKS metrics from CloudWatch |

### Grafana Access

| | |
|---|---|
| **URL** | `http://<monitoring-ingress-ADDRESS>/grafana` |
| **Username** | `admin` |
| **Password** | Retrieved from Secrets Manager — see bootstrap instructions below |

```bash
# Retrieve the Grafana admin password at any time
aws secretsmanager get-secret-value \
  --secret-id onboarding/grafana-admin \
  --query 'SecretString' --output text | jq -r '.password'
```

### Bootstrapping the Monitoring Stack

The monitoring stack is applied once by a cluster admin with cluster-admin credentials. It is never touched by CI/CD.

```bash
kubectl apply -f k8s/monitoring/namespace.yaml
bash k8s/monitoring/bootstrap-grafana-secret.sh   # pulls password from Secrets Manager
kubectl apply -f k8s/monitoring/prometheus/
kubectl apply -f k8s/monitoring/cloudwatch-exporter/
kubectl apply -f k8s/monitoring/grafana/
kubectl apply -f k8s/monitoring/ingress.yaml
```

---

## CI/CD Pipeline

Two independent GitHub Actions workflows. CI runs on every push and pull request. CD runs only on merge to `main` after CI passes, deploying first to staging then to production behind a manual approval gate.

```mermaid
flowchart LR
    subgraph CI["CI — every push / PR"]
        A["npm audit\nbackend + frontend"] --> Gate
        B["Checkov\nTerraform · hard gate\nK8s · advisory"] --> Gate
        C["Trivy\nCRITICAL / HIGH gate"] --> Gate
        G["Gitleaks\nfull history scan"] --> Gate
        Gate{{"all pass"}}
    end

    Gate -->|"merge to main"| Build["Build & push\nimages to ECR\n(tagged: git SHA)"]
    Build --> ScanGate{{"ECR scan\ngate"}}
    ScanGate --> Staging["Deploy to staging\nrolling update\nauto-rollback on failure"]
    Staging --> Approval(["Manual approval\nproduction environment"])
    Approval --> Production["Deploy to production\nrolling update\nauto-rollback on failure"]
```

### CI Gates

| Gate | Tool | Failure Behaviour |
|---|---|---|
| Dependency audit | `npm audit --audit-level=high` | Hard block |
| IaC scan | Checkov | Hard block (Terraform); advisory (K8s) |
| Image vulnerability scan | Trivy — CRITICAL/HIGH | Hard block |
| Secret detection | Gitleaks — full history | Hard block |

### CD Stages

| Stage | Environment | Trigger |
|---|---|---|
| Build & push | `staging` | Automatic on CI pass |
| ECR scan gate | — | Automatic — blocks on CRITICAL findings |
| Deploy to staging | `staging` | Automatic |
| Deploy to production | `production` | Manual approval required |

### GitHub Environments Setup

Create three environments in **Settings → Environments**: `ci`, `staging`, `production`.
Enable **Required reviewers** on `production`.

Add the following variables to `staging` and `production`:

| Variable | Value |
|---|---|
| `AWS_REGION` | `us-east-1` |
| `AWS_ROLE_ARN` | `arn:aws:iam::246312965731:role/github-actions-role` |
| `EKS_CLUSTER` | `onboarding-cluster` |
| `ECR_BACKEND` | `246312965731.dkr.ecr.us-east-1.amazonaws.com/onboarding-backend` |
| `ECR_FRONTEND` | `246312965731.dkr.ecr.us-east-1.amazonaws.com/onboarding-frontend` |

Add to `ci`:

| Variable | Value |
|---|---|
| `NODE_VERSION` | `20` |

---

## GitOps — ArgoCD

ArgoCD runs in-cluster **alongside** `cd.yml`, not in place of it. It watches `k8s/` in this repo and continuously diffs it against the live `onboarding` namespace, giving drift visibility — a second, independent signal that what's running actually matches what's committed — without taking over the deploy path CD already owns.

```mermaid
flowchart LR
    Git["k8s/ in this repo\n(main branch)"]
    Argo["ArgoCD Application\n'onboarding'\nnamespace: argocd"]
    Live["Live cluster state\nonboarding namespace"]
    CD["GitHub Actions CD\nkubectl apply / set image"]

    Git -- "watched path: k8s/\nnon-recursive" --> Argo
    Argo -- "diff" --> Live
    CD -- "applies directly" --> Live
    Argo -. "manual sync only —\nnever auto-applies" .-> Live
```

### Why sync is manual, not automated

Both ArgoCD and `cd.yml` would otherwise be managing the same `Deployment` objects. If ArgoCD's `syncPolicy.automated` were enabled, the two would fight: CD's `kubectl set image` bumps a Deployment to a new SHA-tagged image, and on its next reconcile ArgoCD would revert it back to whatever tag is committed in `k8s/backend.yaml` / `k8s/frontend.yaml` (currently `:latest`) — undoing every CD deploy. `argocd/application.yaml` deliberately omits `syncPolicy.automated` for this reason; sync is a manual, deliberate action (`argocd app sync onboarding`, or the equivalent `kubectl patch application` operation).

### Scope — same boundary CD respects

| Setting | Value | Why |
|---|---|---|
| `source.path` | `k8s` | Same directory CD applies |
| `source.directory.recurse` | `false` (default) | Matches `cd.yml`'s non-recursive `kubectl apply -f k8s/` — does **not** reach `k8s/bootstrap` (RBAC) or `k8s/monitoring`, for the same least-privilege reason CD doesn't: the deploying identity must never be able to grant itself more access |
| `Namespace/onboarding` sync scope | `argocd.argoproj.io/sync-options: Exclude=true` (in `k8s/external-secrets.yaml`) | `Namespace` is cluster-scoped. `github-actions-role`'s EKS access entry is deliberately scoped to namespace-level edit only and can never `patch` a cluster-scoped object — including a harmless bookkeeping-annotation update. The first time this Application synced, ArgoCD stamped the Namespace with a `tracking-id` annotation, which then made the *next* CD `kubectl apply` try (and fail, `403 Forbidden`) to patch that annotation away. Excluding the Namespace from ArgoCD's sync avoids the conflict entirely — it stays owned by CD's initial create and cluster admins only |

### Access

```bash
kubectl -n argocd port-forward svc/argocd-server 8080:443
# https://localhost:8080 — self-signed cert, expected

# Admin password (initial secret — rotate after first login)
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath='{.data.password}' | base64 -d
```

There is no public Ingress for ArgoCD — access is via port-forward only, consistent with the rest of the stack's no-unnecessary-exposure posture.

### Promoting to full GitOps (not done here)

`argocd/README.md` has the complete path: drop the `kubectl apply` / `kubectl set image` steps from `cd.yml`, have CI write the built image tag into git instead of setting it imperatively (`kustomize edit set image`, or ArgoCD Image Updater), and turn on `syncPolicy.automated`. Until then, ArgoCD is a diff/drift tool running in parallel with the pipeline that actually ships code.

---

## Repository Structure

```
.
├── .github/
│   └── workflows/
│       ├── ci.yml                    # Security gates — runs on every push and PR
│       └── cd.yml                    # Build, push, deploy — runs on merge to main
│
├── backend/
│   ├── Dockerfile                    # Multi-stage: node:20-alpine → distroless
│   ├── package.json
│   └── index.js                      # Express API + Prometheus metrics endpoint
│
├── frontend/
│   ├── Dockerfile                    # Multi-stage: node:20-alpine → nginx:1.27-alpine
│   ├── nginx.conf                    # SPA fallback + /api proxy to backend-svc
│   ├── vite.config.js
│   ├── package.json
│   └── src/
│       ├── main.jsx                  # React router entry point
│       └── pages/
│           ├── Candidates.jsx        # Hiring and screening view
│           └── Onboarding.jsx        # Employee onboarding view
│
├── k8s/
│   ├── external-secrets.yaml         # SecretStore + ExternalSecret (Secrets Manager → K8s)
│   ├── backend.yaml                  # Deployment + Service (Prometheus annotations included)
│   ├── frontend.yaml                 # Deployment + Service
│   ├── ingress.yaml                  # ALB Ingress — path-based routing
│   ├── network-policy.yaml           # Default-deny NetworkPolicies per tier
│   ├── pdb.yaml                      # PodDisruptionBudgets (minAvailable: 1)
│   │
│   └── monitoring/                   # Admin-applied only — outside CD's namespace scope
│       ├── namespace.yaml
│       ├── ingress.yaml              # Separate ALB, path-scoped to /grafana
│       ├── bootstrap-grafana-secret.sh
│       ├── prometheus/
│       │   ├── rbac.yaml             # ClusterRole for pod/node discovery
│       │   ├── configmap.yaml        # Scrape configs
│       │   └── deployment.yaml       # Deployment + Service
│       ├── grafana/
│       │   ├── configmap.yaml        # Datasource + dashboard provisioning
│       │   └── deployment.yaml       # Deployment + Service
│       └── cloudwatch-exporter/
│           ├── configmap.yaml        # CloudWatch metrics config (RDS, ALB, EKS)
│           └── deployment.yaml       # Deployment + Service + IRSA ServiceAccount
│
├── argocd/
│   ├── application.yaml              # ArgoCD Application — manual sync, alongside CD
│   └── README.md                     # Install steps + path to full GitOps
│
├── terraform/
│   ├── main.tf                       # VPC, EKS, ECR, S3, RDS, Secrets Manager
│   ├── security.tf                   # KMS, OIDC provider, IAM roles and policies
│   ├── monitoring.tf                 # CloudWatch exporter IRSA role, Grafana secret
│   ├── variables.tf
│   └── outputs.tf
│
└── .checkov.ini                      # IaC scan suppressions with documented reasons
```

---

## Deployment

### Prerequisites

- AWS CLI v2
- Terraform >= 1.5
- kubectl
- Docker Desktop
- Helm 3

### 1 — Provision Infrastructure

```bash
cd terraform
terraform init
terraform apply \
  -var="db_password=<YOUR_STRONG_PASSWORD>" \
  -var="grafana_password=<YOUR_GRAFANA_PASSWORD>"
```

Note the outputs — you will need `eks_cluster_name`, `ecr_backend_url`, and `ecr_frontend_url`.

### 2 — Configure kubectl

```bash
aws eks update-kubeconfig --region us-east-1 --name onboarding-cluster
kubectl get nodes  # verify connectivity
```

### 3 — Install Cluster Add-ons

```bash
# AWS Load Balancer Controller — the serviceAccount annotation is required:
# without it the pod silently falls back to the node IAM role (which has no
# ELB permissions), and the Ingress never provisions a real ALB.
helm repo add eks https://aws.github.io/eks-charts && helm repo update
helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName=onboarding-cluster \
  --set region=us-east-1 \
  --set vpcId=<VPC_ID_FROM_TERRAFORM_STATE> \
  --set serviceAccount.create=true \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=arn:aws:iam::246312965731:role/aws-load-balancer-controller-role

# External Secrets Operator
helm repo add external-secrets https://charts.external-secrets.io && helm repo update
helm install external-secrets external-secrets/external-secrets \
  -n external-secrets --create-namespace
```

### 4 — Build and Push Docker Images

```bash
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin \
    246312965731.dkr.ecr.us-east-1.amazonaws.com

# Backend
cd backend
docker build -t onboarding-backend .
docker tag onboarding-backend:latest \
  246312965731.dkr.ecr.us-east-1.amazonaws.com/onboarding-backend:latest
docker push 246312965731.dkr.ecr.us-east-1.amazonaws.com/onboarding-backend:latest

# Frontend
cd ../frontend
docker build -t onboarding-frontend .
docker tag onboarding-frontend:latest \
  246312965731.dkr.ecr.us-east-1.amazonaws.com/onboarding-frontend:latest
docker push 246312965731.dkr.ecr.us-east-1.amazonaws.com/onboarding-frontend:latest
```

### 5 — Deploy Application to Kubernetes

```bash
kubectl apply -f k8s/external-secrets.yaml
kubectl apply -f k8s/backend.yaml
kubectl apply -f k8s/frontend.yaml
kubectl apply -f k8s/ingress.yaml
kubectl apply -f k8s/network-policy.yaml
kubectl apply -f k8s/pdb.yaml
```

### 6 — Bootstrap Monitoring Stack

This is applied once by a cluster admin. CI/CD never touches the `monitoring` namespace.

```bash
kubectl apply -f k8s/monitoring/namespace.yaml
bash k8s/monitoring/bootstrap-grafana-secret.sh
kubectl apply -f k8s/monitoring/prometheus/
kubectl apply -f k8s/monitoring/cloudwatch-exporter/
kubectl apply -f k8s/monitoring/grafana/
kubectl apply -f k8s/monitoring/ingress.yaml
```

### 7 — Get Application and Grafana URLs

```bash
kubectl get ingress onboarding-ingress -n onboarding
kubectl get ingress monitoring-ingress -n monitoring
```

- Open the `onboarding-ingress` ADDRESS in your browser for the application
- Open `http://<monitoring-ingress ADDRESS>/grafana` for Grafana

> After the initial setup, all subsequent application deployments are fully automated — push to `main` and the CI/CD pipeline handles the rest. The monitoring stack is not touched by CD and only changes when re-applied manually.

### 8 — Install ArgoCD (optional, admin-applied)

Like the monitoring stack, this is a cluster-admin step — not something CD's namespace-scoped role should be able to do.

```bash
kubectl create namespace argocd
kubectl apply -n argocd --server-side --force-conflicts \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
# --server-side avoids a "Too long" error from kubectl apply's
# last-applied-configuration annotation on the applicationsets CRD

kubectl apply -f argocd/application.yaml
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath='{.data.password}' | base64 -d   # admin password
```

See [GitOps — ArgoCD](#gitops--argocd) for why sync is manual and what it does and doesn't manage.

> **Node capacity:** `t3.small` nodes cap out at 11 pods each (an ENI IP limit, not CPU/memory). ArgoCD alone adds ~7 pods; combined with the app, DaemonSets, the LB Controller, and External Secrets Operator, 2 nodes leave no headroom for a rolling-update surge pod — the next CD deploy will fail scheduling with `FailedScheduling: Too many pods`. The node group's `desired_size` is `3` for this reason; if you skip installing ArgoCD, 2 nodes is enough.

---

## Known Gaps

Documented intentionally rather than silently omitted.

| Gap | Reason | Resolution Path |
|---|---|---|
| **Secrets Manager rotation Lambda** | Requires a custom Lambda function wired to RDS; `CKV2_AWS_57` skipped in `.checkov.ini` | Implement a rotation Lambda using the `aws_secretsmanager_secret_rotation` resource |
| **Single NAT Gateway** | Cost trade-off for a non-production workload; a production deployment should use one NAT Gateway per AZ for full fault isolation | Add `one_nat_gateway_per_az = true` in the VPC module |
| **S3 cross-region replication** | Not required for this use case; `CKV_AWS_144` skipped in `.checkov.ini` | Add replication configuration if disaster recovery requirements demand it |
| **Prometheus persistent storage** | Uses `emptyDir` — metrics are lost on pod restart; acceptable for a dev/staging setup | Replace with a `PersistentVolumeClaim` backed by `gp3` EBS for production |
| **Grafana persistent storage** | Uses `emptyDir` — any manually created dashboards are lost on pod restart | Replace with a `PersistentVolumeClaim`; all provisioned dashboards survive as they are in ConfigMaps |
| **ArgoCD is not the deploy mechanism** | Manual sync only, running alongside `cd.yml` rather than replacing it — see [GitOps — ArgoCD](#gitops--argocd) for why | Drop `kubectl apply`/`set image` from `cd.yml`, move image-tag updates into git, enable `syncPolicy.automated` |

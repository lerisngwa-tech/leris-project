# Employee Onboarding Platform

A cloud-native, three-tier employee onboarding and candidate-screening system, built on Amazon EKS and shipped through a fully automated, security-gated CI/CD pipeline. Full technical reference lives in [README.md](README.md) — this document is the project story: what it does, how it's built, and what it took to get it — and keep it — running.

## What it does

Two workflows for an HR team: **screen candidates** (add a candidate, track them through `pending → approved/rejected`) and **track onboarding** (record new employees, their department, and start date). A React SPA talks to a REST API, which is the only thing in the system allowed to touch the database.

## Stack

| | |
|---|---|
| Frontend | React 18 + Vite, served by nginx |
| Backend | Node.js + Express REST API |
| Database | Amazon RDS PostgreSQL 16 — Multi-AZ, encrypted |
| Runtime | Amazon EKS 1.31 |
| Infrastructure | Terraform |
| CI/CD | GitHub Actions, OIDC-authenticated |
| Secrets | AWS Secrets Manager + External Secrets Operator |
| Observability | Prometheus + Grafana + CloudWatch exporter |

## Architecture decisions worth calling out

**Strict tiering.** The browser never talks to the backend directly — everything enters through one ALB, and the frontend proxies `/api/*` server-side. Only the backend holds a database connection. This isn't just organization; it's the boundary the network policies and security groups are drawn around.

**No standing AWS credentials, anywhere.** GitHub Actions authenticates via OIDC and exchanges a short-lived token for AWS access on every run — there is no access key sitting in a repo secret to leak. The same pattern (IAM Roles for Service Accounts) is how pods get AWS permissions: External Secrets Operator can read exactly one secret, the CloudWatch exporter can only call two read-only CloudWatch APIs.

**A least-privilege boundary the deploy pipeline can't cross.** `github-actions-role` is scoped, via an EKS access entry, to the `onboarding` namespace only. It cannot touch the `monitoring` namespace, cluster-scoped resources, or its own RBAC bindings — deliberately. The role that ships application code must never be able to grant itself more access. That's why the monitoring stack (Prometheus/Grafana/CloudWatch exporter) and the RBAC bootstrap files live in paths CD's `kubectl apply` intentionally doesn't reach, and are applied once by a cluster admin instead.

**Defense in depth, not one control.** Six independent layers — OIDC auth, scoped IAM, secrets that never enter the pipeline, non-root read-only containers, default-deny network policies, and KMS encryption everywhere — none of which depend on each other holding.

## Getting it live

The pipeline existed on paper but had never gone green, and nothing had ever reached the cluster. Eight blockers, found and fixed in the order they were hit:

1. **IaC scan never ran** — the Checkov config was written as plain INI; the scanner needs YAML.
2. **AWS rejected every deploy** — GitHub's OIDC tokens carry numeric org/repo IDs on this repo; the IAM trust policy was still matching on name.
3. **CI could reach AWS but not the cluster** — authenticating to AWS isn't the same as having Kubernetes RBAC; the deploy role had no grant.
4. **The app had never actually been deployed** — the pipeline only ever updated existing Deployments, never created them.
5. **Kubernetes refused to start either container** — both images defaulted to root; the cluster's pod security policy rejects that outright.
6. **The backend couldn't reach the database** — RDS requires TLS; the backend was connecting in plaintext.
7. **The frontend was reachable only sometimes** — the node security group's port range didn't include the frontend's port, so cross-node traffic dropped.
8. **No path in from the internet** — the AWS Load Balancer Controller had no IAM permissions of its own; it was silently borrowing the node role, which can't create a load balancer.

## Staying live

Five more surfaced after launch — configuration left half-finished, and one real race condition:

1. **Admin passwords were still template placeholders** — both the RDS master password and the Grafana admin password in Secrets Manager held their literal `<YOUR_PASSWORD>` text, never overwritten.
2. **Secret sync was silently broken** — External Secrets Operator had `secretsmanager:GetSecretValue` but not `kms:Decrypt` on the encrypting key; every sync had been failing with `AccessDeniedException`.
3. **A Terraform replace raced a live image push** — adding KMS encryption to the ECR repos forced Terraform to destroy and recreate them, landing nine seconds after a build finished pushing an image and wiping the registry clean.
4. **CD's blast radius briefly widened** — making the manifest apply recursive (to reach new monitoring manifests) also reopened access to RBAC objects the deploy role is deliberately forbidden from touching. Reverted to the narrower apply.
5. **The backend's health check had never passed** — the ALB's default check hits `GET /`; the app only ever defined `/api/*` and `/metrics`. Every check 404'd, and the target group had been "unhealthy" since day one, serving traffic only because ALB fails open when every target is down.

## What this demonstrates

Provisioning infrastructure is the easy part — this project is mostly about the gap between *deployed* and *actually working*, and the discipline of tracing a symptom (a 404, a stale secret, an empty registry) back to its real root cause instead of the first plausible one. Concretely: IAM/OIDC trust policies and IRSA scoping, Kubernetes RBAC boundaries and why they should be adversarial to the pipeline that deploys through them, container hardening (distroless, non-root, read-only, dropped capabilities), TLS/KMS encryption end-to-end, CI/CD security gating (audit, IaC scan, image scan, secret scan), and an observability stack wired to the actual failure modes above rather than added as an afterthought.

---

Full technical detail — diagrams, every manifest, every IAM policy, deployment steps — is in [README.md](README.md).

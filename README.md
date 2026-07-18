# Employee Onboarding App

3-tier app: React frontend → Node/Express backend → RDS PostgreSQL  
Infrastructure: AWS EKS (us-east-1, multi-AZ) + ALB Ingress + Secrets Manager + S3

## Prerequisites
- AWS CLI, Terraform, kubectl, Docker, Helm

---

## 1. Deploy Infrastructure

```bash
cd terraform
terraform init
terraform apply -var="db_password=<YOUR_PASSWORD>"
```

Note the outputs: `eks_cluster_name`, `ecr_backend_url`, `ecr_frontend_url`

---

## 2. Configure kubectl

```bash
aws eks update-kubeconfig --region us-east-1 --name onboarding-cluster
```

---

## 3. Install ALB Ingress Controller

```bash
helm repo add eks https://aws.github.io/eks-charts
helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName=onboarding-cluster \
  --set serviceAccount.create=true
```

---

## 4. Install External Secrets Operator

```bash
helm repo add external-secrets https://charts.external-secrets.io
helm install external-secrets external-secrets/external-secrets -n external-secrets --create-namespace
```

Create IAM role for External Secrets with SecretsManager read access,  
then replace `<ACCOUNT_ID>` in `k8s/external-secrets.yaml`.

---

## 5. Build & Push Docker Images

```bash
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 246312965731.dkr.ecr.us-east-1.amazonaws.com

# Backend
cd backend
docker build -t onboarding-backend .
docker tag onboarding-backend:latest <ECR_BACKEND_URL>:latest
docker push <ECR_BACKEND_URL>:latest

# Frontend
cd ../frontend
docker build -t onboarding-frontend .
docker tag onboarding-frontend:latest <ECR_FRONTEND_URL>:latest
docker push <ECR_FRONTEND_URL>:latest
```

Replace `<ACCOUNT_ID>` in `k8s/backend.yaml` and `k8s/frontend.yaml` with your AWS account ID.

---

## 6. Deploy to Kubernetes

```bash
kubectl apply -f k8s/external-secrets.yaml
kubectl apply -f k8s/backend.yaml
kubectl apply -f k8s/frontend.yaml
kubectl apply -f k8s/ingress.yaml
```

---

## 7. Get the ALB URL

```bash
kubectl get ingress -n onboarding
```

Open the ADDRESS in your browser.

---

## Architecture

```
Internet → ALB Ingress
              ├── /api  → backend-svc (Node.js) → RDS PostgreSQL
              └── /     → frontend-svc (React/Nginx)

Secrets: AWS Secrets Manager → External Secrets Operator → K8s Secret → backend pods
Storage: S3 bucket for documents/assets
```

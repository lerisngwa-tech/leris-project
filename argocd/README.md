# ArgoCD (added alongside the existing CD pipeline)

This is config-as-code only — ArgoCD is not yet installed in the cluster.
Installing it, like the RBAC bootstrap in `k8s/bootstrap/`, is a cluster-admin
step done out-of-band from CD, not something `github-actions-role` should be
able to do (it would otherwise let the deploy pipeline install a controller
with cluster-wide write access — well outside its intended `onboarding`
namespace scope).

## 1. Install ArgoCD (cluster admin, one time)

```bash
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
kubectl -n argocd rollout status deploy/argocd-server --timeout=180s
```

Get the initial admin password:

```bash
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d
```

Access the UI (port-forward, since no Ingress is defined for it here):

```bash
kubectl -n argocd port-forward svc/argocd-server 8080:443
```

## 2. Register this app

```bash
kubectl apply -f argocd/application.yaml
```

This creates the `onboarding` Application, pointed at `k8s/` in this repo,
with **manual sync** — see the comments in `application.yaml` for why (it
coexists with `cd.yml`'s `kubectl apply`/`kubectl set image`, and automated
sync would fight it for ownership of the same Deployments).

Use it for drift visibility today: `argocd app diff onboarding` or the UI
shows anything that's changed in-cluster vs. what's committed. Sync manually
(`argocd app sync onboarding`) when you want ArgoCD to reconcile.

## 3. Promoting to full GitOps (later, not done here)

To make ArgoCD the actual deploy mechanism instead of `kubectl apply`:

1. Remove the `kubectl apply` / `kubectl set image` / `kubectl rollout status`
   steps from `cd.yml`'s `deploy-staging` and `deploy-production` jobs.
2. Have CI write the built image tag into git instead of setting it
   imperatively — e.g. `kustomize edit set image` committed back to the repo,
   or run ArgoCD Image Updater. ArgoCD only ever applies what's in git; a
   `kubectl set image` from the old pipeline would just get reverted on the
   next sync.
3. Add `syncPolicy.automated: { prune: true, selfHeal: true }` to
   `application.yaml`.
4. Decide how staging vs. production map to ArgoCD — e.g. two Applications
   pointing at two Kustomize overlays, rather than the single `k8s/` path
   both environments currently share.

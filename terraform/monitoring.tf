# ── IAM role for CloudWatch exporter (IRSA) ──────────────────────────────────
data "aws_iam_policy_document" "cloudwatch_exporter_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [module.eks.oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${module.eks.oidc_provider}:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "${module.eks.oidc_provider}:sub"
      values   = ["system:serviceaccount:monitoring:cloudwatch-exporter"]
    }
  }
}

resource "aws_iam_role" "cloudwatch_exporter" {
  name               = "cloudwatch-exporter-role"
  assume_role_policy = data.aws_iam_policy_document.cloudwatch_exporter_assume.json
}

resource "aws_iam_role_policy" "cloudwatch_exporter" {
  name = "cloudwatch-exporter-policy"
  role = aws_iam_role.cloudwatch_exporter.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "cloudwatch:GetMetricStatistics",
        "cloudwatch:ListMetrics",
        "cloudwatch:GetMetricData",
        "tag:GetResources"
      ]
      Resource = "*"
    }]
  })
}

# ── Grafana admin password in Secrets Manager ─────────────────────────────────
resource "aws_secretsmanager_secret" "grafana" {
  name       = "${var.project}/grafana-admin"
  kms_key_id = aws_kms_key.main.arn
}

resource "aws_secretsmanager_secret_version" "grafana" {
  secret_id     = aws_secretsmanager_secret.grafana.id
  secret_string = jsonencode({ password = var.grafana_password })
}

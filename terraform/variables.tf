variable "region" {
  default = "us-east-1"
}

variable "project" {
  default = "onboarding"
}

variable "db_username" {
  default = "dbadmin"
}

variable "db_password" {
  description = "RDS master password"
  sensitive   = true
}

# Generated once and kept in Terraform state (keep state local or in a locked-down backend; see docs/security.md).

# OpenMetadata admin password: replaces the public default admin/admin at bootstrap.
resource "random_password" "om_admin" {
  length           = 24
  min_upper        = 2
  min_lower        = 2
  min_numeric      = 2
  min_special      = 2
  override_special = "!@#%^*-_"
}

# Basic auth for the web app (/team) in front of the brain API.
resource "random_password" "web" {
  length  = 20
  special = false
}

# One gateway key per agent: stored in that agent's Foundry connections and given to the gateway on the VM.
resource "random_password" "agent_key" {
  for_each = toset(var.agents)
  length   = 48
  special  = false
}

# OpenMetadata signs its JWTs with this key instead of the key shipped in the public image.
resource "tls_private_key" "om_jwt" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "random_uuid" "om_jwt_kid" {}

# Fernet key for secrets OpenMetadata stores encrypted (instead of the public default).
resource "random_bytes" "om_fernet" {
  length = 32
}

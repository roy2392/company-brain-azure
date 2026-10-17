variable "subscription_id" {
  description = "Azure subscription that hosts everything (VM, Foundry)."
  type        = string
}

variable "location" {
  description = "Azure region. Must offer the Foundry model below (GlobalStandard)."
  type        = string
  default     = "swedencentral"
}

variable "name_prefix" {
  description = "Prefix for every resource name; a random suffix keeps names unique."
  type        = string
  default     = "wisteria"
}

variable "vm_size" {
  description = "One VM runs the whole stack (OpenMetadata + Elasticsearch + Postgres + Fuseki, Atlas Local, agent-memory, Ollama, the brain). 32 GB RAM is comfortable."
  type        = string
  default     = "Standard_D8s_v5"
}

variable "admin_username" {
  description = "Linux admin user on the VM."
  type        = string
  default     = "brain"
}

variable "ssh_public_key" {
  description = "SSH public key (contents) for the admin user."
  type        = string
}

variable "ssh_allowed_cidrs" {
  description = "Source CIDRs allowed to SSH (22) when enable_ssh is true. Keep it to your own egress IP."
  type        = list(string)
  default     = []
}

variable "enable_ssh" {
  description = "Open SSH (22) from ssh_allowed_cidrs. Off by default: managed tenants may remove such rules; use infra/azure/push.sh (Run Command)."
  type        = bool
  default     = false
}

variable "model_name" {
  description = "Foundry model deployment used by every agent."
  type        = string
  default     = "gpt-5.4"
}

variable "model_version" {
  type    = string
  default = "2026-03-05"
}

variable "model_capacity" {
  description = "GlobalStandard capacity in thousands of tokens per minute."
  type        = number
  default     = 250
}

variable "agents" {
  description = "Wisteria role agents (must match packages/brain/src/agents/roster.ts)."
  type        = list(string)
  default     = ["support_lead", "account_manager", "revops_analyst", "product_lead"]
}

variable "web_username" {
  description = "Basic-auth user for the web app (/team) in front of the brain."
  type        = string
  default     = "wisteria"
}

# ---- MongoDB Atlas (optional, see atlas.tf): values in atlas.auto.tfvars, git-ignored

variable "atlas_org_id" {
  description = "Atlas organization id. Empty: no Atlas cluster, agent-memory stays on Atlas Local."
  type        = string
  default     = ""
}

variable "atlas_client_id" {
  description = "Atlas service account client id (role: Organization Project Creator)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "atlas_client_secret" {
  type      = string
  default   = ""
  sensitive = true
}

variable "atlas_region" {
  description = "Atlas region on Azure (next to the VM)."
  type        = string
  default     = "SWEDEN_CENTRAL"
}

variable "atlas_instance_size" {
  description = "M10 is the smallest tier that runs MongoDB 8.1+ ($rankFusion, needed by agent-memory)."
  type        = string
  default     = "M10"
}

variable "atlas_billing" {
  description = "Who bills the Atlas cluster: \"atlas\" (a payment method in Atlas) or \"azure\" (Azure Marketplace, atlas_billing.tf)."
  type        = string
  default     = "atlas"
}

variable "atlas_billing_location" {
  description = "Azure region of the MongoDB.Atlas/organizations resource (the service's own list; the cluster region is atlas_region)."
  type        = string
  default     = "germanywestcentral"
}

variable "atlas_org_name" {
  description = "Name of the Atlas organization atlas_org_id points at (needed to link it to Azure billing)."
  type        = string
  default     = ""
}

variable "atlas_owner" {
  description = "Owner recorded on the Azure Native Atlas resource."
  type        = object({ first_name = string, last_name = string, email = string })
  default     = { first_name = "", last_name = "", email = "" }
}

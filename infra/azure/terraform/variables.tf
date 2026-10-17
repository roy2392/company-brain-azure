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
  description = "Source CIDRs allowed to SSH (22). Keep it to your own egress IP."
  type        = list(string)
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
  default     = 100
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

resource "random_string" "suffix" {
  length  = 5
  upper   = false
  special = false
}

locals {
  name      = "${var.name_prefix}-${random_string.suffix.result}"
  dns_label = "${var.name_prefix}-brain-${random_string.suffix.result}"
  fqdn      = "${local.dns_label}.${var.location}.cloudapp.azure.com"
  tags = {
    project = "wisteria-company-brain"
    purpose = "OpenMetadata + MongoDB Atlas + Microsoft Foundry agents showcase"
  }
}

resource "azurerm_resource_group" "rg" {
  name     = "rg-${local.name}"
  location = var.location
  tags     = local.tags
}

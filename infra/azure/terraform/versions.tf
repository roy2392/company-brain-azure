terraform {
  required_version = ">= 1.9"
  required_providers {
    azurerm      = { source = "hashicorp/azurerm", version = "~> 4.30" }
    azapi        = { source = "Azure/azapi", version = "~> 2.4" }
    random       = { source = "hashicorp/random", version = "~> 3.6" }
    tls          = { source = "hashicorp/tls", version = "~> 4.0" }
    mongodbatlas = { source = "mongodb/mongodbatlas", version = "~> 2.0" }
  }
}

provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
}

provider "azapi" {
  subscription_id = var.subscription_id
}

# Atlas service account (atlas.auto.tfvars); unset, no Atlas resource is planned
provider "mongodbatlas" {
  client_id     = var.atlas_client_id != "" ? var.atlas_client_id : null
  client_secret = var.atlas_client_secret != "" ? var.atlas_client_secret : null
}
